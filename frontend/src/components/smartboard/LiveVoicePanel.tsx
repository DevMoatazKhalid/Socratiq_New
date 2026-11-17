import React, { useEffect, useRef, useState, useCallback } from "react"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import { exportToBlob } from "@excalidraw/excalidraw"
import { Mic, MicOff, PhoneOff, Sparkles, Volume2, AlertCircle, Loader2 } from "lucide-react"
import { getLiveWebSocketUrl } from "@/lib/geminiSmartBoardService"
import { accessToken } from "@/lib/api"
import { MODEL_NAMES, whiteboardTools, SMARTBOARD_SYSTEM_INSTRUCTION } from "@/lib/smartboardConstants"
import { executeLiveTools } from "@/lib/smartboard/liveToolHandler"
import { sceneSignature } from "@/lib/smartboard/glue"

export interface LiveVoicePanelProps {
  api: ExcalidrawImperativeAPI | null
  assignmentId?: string
  courseId?: string
  onClose: () => void
}

type LiveState = "idle" | "connecting" | "listening" | "speaking" | "error"

/** What the user should be told when the server closes the session. `ok` = an expected end, not a failure. */
export function describeLiveClose(code: number, reason: string): { ok: boolean; message: string } {
  switch (reason) {
    case "idle_timeout": return { ok: true, message: "Session ended after a period of silence." }
    case "max_duration": return { ok: true, message: "Session ended: the 15-minute limit was reached." }
    case "provider_closed": return { ok: true, message: "The voice service ended the session." }
    case "client_closed": return { ok: true, message: "" }
    case "message_too_large": return { ok: false, message: "Session stopped: a message was too large." }
    case "provider_error":
    case "relay_error": return { ok: false, message: "The voice connection was interrupted." }
  }
  if (code === 1000) return { ok: true, message: "" }
  return { ok: false, message: reason || "Live voice session disconnected." }
}

const encodeAudio = (bytes: Uint8Array): string => {
  let binary = ""
  const len = bytes.byteLength
  for (let i = 0; i < len; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)) as any)
  }
  return btoa(binary)
}

const decodeAudio = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

const decodeAudioData = async (data: Uint8Array, ctx: AudioContext): Promise<AudioBuffer | null> => {
  try {
    const sampleCount = Math.floor(data.byteLength / 2)
    if (sampleCount === 0) return null
    const dataView = new DataView(data.buffer, data.byteOffset, sampleCount * 2)
    const buffer = ctx.createBuffer(1, sampleCount, 24000)
    const channelData = buffer.getChannelData(0)
    for (let i = 0; i < sampleCount; i++) {
      channelData[i] = dataView.getInt16(i * 2, true) / 32768.0
    }
    return buffer
  } catch (e) {
    console.error("[LiveVoice] Audio decode error", e)
    return null
  }
}

function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length
  const int16 = new Int16Array(l)
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return {
    data: encodeAudio(new Uint8Array(int16.buffer)),
    mimeType: "audio/pcm;rate=16000",
  }
}

export const LiveVoicePanel: React.FC<LiveVoicePanelProps> = ({ api, assignmentId, courseId, onClose }) => {
  const [state, setState] = useState<LiveState>("connecting")
  const [isMuted, setIsMuted] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [volumeLevel, setVolumeLevel] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  // Bumped by every cleanup/start. Any callback that outlives its session (late socket events, a pending microphone prompt) compares against it and backs off.
  const sessionRef = useRef(0)
  const inputContextRef = useRef<AudioContext | null>(null)
  const outputContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const nextStartTimeRef = useRef<number>(0)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const captureIntervalRef = useRef<number | undefined>(undefined)
  const isMutedRef = useRef(false)
  isMutedRef.current = isMuted
  const isCapturingRef = useRef(false)
  const lastCapturedSigRef = useRef<string | null>(null)
  const lastCaptureTimeRef = useRef<number>(0)
  const isSpeakingRef = useRef(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopActiveAudio = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop()
      } catch {}
    }
    activeSourcesRef.current = []
    if (outputContextRef.current) {
      nextStartTimeRef.current = outputContextRef.current.currentTime
    }
  }, [])

  const cleanup = useCallback(() => {
    sessionRef.current += 1
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = undefined
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    isSpeakingRef.current = false
    isCapturingRef.current = false
    lastCapturedSigRef.current = null
    lastCaptureTimeRef.current = 0
    stopActiveAudio()
    if (wsRef.current) {
      const old = wsRef.current
      old.onopen = old.onmessage = old.onerror = old.onclose = null        // a closing socket must not report into a newer session
      try {
        old.close()
      } catch {}
      wsRef.current = null
    }
    if (inputContextRef.current) {
      try {
        inputContextRef.current.close()
      } catch {}
      inputContextRef.current = null
    }
    if (outputContextRef.current) {
      try {
        outputContextRef.current.close()
      } catch {}
      outputContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setState("idle")
  }, [stopActiveAudio])

  const playPcmAudio = useCallback(async (base64Pcm: string) => {
    if (!outputContextRef.current) {
      outputContextRef.current = new AudioContext({ sampleRate: 24000 })
    }
    const ctx = outputContextRef.current
    if (ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {}
    }

    try {
      const bytes = decodeAudio(base64Pcm)
      const audioBuffer = await decodeAudioData(bytes, ctx)
      if (!audioBuffer) return

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)

      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current)
      source.start(startTime)
      nextStartTimeRef.current = startTime + audioBuffer.duration

      activeSourcesRef.current.push(source)
      setState("speaking")

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source)
        if (activeSourcesRef.current.length === 0) {
          setState("listening")
        }
      }
    } catch (e) {
      console.error("[LiveVoice] Playback error", e)
    }
  }, [])

  const startSession = useCallback(async () => {
    cleanup()
    const sid = sessionRef.current
    const stale = () => sid !== sessionRef.current
    setState("connecting")
    setErrorMessage(null)

    try {
      const wsUrl = getLiveWebSocketUrl()
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = async () => {
        let token: string | null = null
        try {
          if (typeof accessToken === "function") {
            token = await accessToken()
          }
        } catch {}
        if (stale() || ws.readyState !== WebSocket.OPEN) return

        const setupPayload = {
          token: token || undefined,
          assignment_id: assignmentId || undefined,
          course_id: courseId || undefined,
          setup: {
            model: `models/${MODEL_NAMES.LIVE}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Aoede",
                  },
                },
              },
            },
            systemInstruction: { parts: [{ text: SMARTBOARD_SYSTEM_INSTRUCTION }] },
            tools: [{ functionDeclarations: whiteboardTools }],
          },
        }

        ws.send(JSON.stringify(setupPayload))
      }

      ws.onmessage = async (event) => {
        let rawText = event.data
        if (event.data instanceof Blob) {
          rawText = await event.data.text()
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data)
        }
        if (stale()) return
        let data: any
        try {
          data = typeof rawText === "string" ? JSON.parse(rawText) : rawText
        } catch {
          return
        }
        if (!data) return

        // Setup complete -> start audio and video capture
        if (data.setupComplete || data.setup_complete) {
          setState("listening")
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            if (stale()) {                                     // the session was closed while the browser was asking for the microphone
              stream.getTracks().forEach((t) => t.stop())
              return
            }
            streamRef.current = stream
            const inputCtx = new AudioContext({ sampleRate: 16000 })
            inputContextRef.current = inputCtx
            const source = inputCtx.createMediaStreamSource(stream)
            const processor = inputCtx.createScriptProcessor(4096, 1, 1)
            source.connect(processor)
            const muteGain = inputCtx.createGain()
            muteGain.gain.value = 0
            processor.connect(muteGain)
            muteGain.connect(inputCtx.destination)

            processor.onaudioprocess = (e) => {
              if (isMutedRef.current) return
              const channel = e.inputBuffer.getChannelData(0)
              let sum = 0
              for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i]
              const rms = Math.sqrt(sum / channel.length)
              setVolumeLevel(Math.min(1, rms * 5))

              const pcm = createBlob(channel)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  realtimeInput: {
                    audio: {
                      data: pcm.data,
                      mimeType: pcm.mimeType,
                    },
                  },
                }))
              }
            }

            // Periodic board screenshot streaming every 2s using Excalidraw exportToBlob
            captureIntervalRef.current = window.setInterval(async () => {
              if (!api || ws.readyState !== WebSocket.OPEN) return
              if (isCapturingRef.current) return

              const now = Date.now()
              const elements = api.getSceneElements()
              if (elements.length === 0) return

              const currentSig = sceneSignature(elements)
              const timeSinceLastCapture = now - lastCaptureTimeRef.current

              // Skip duplicate captures if scene hasn't changed and 15s heartbeat has not elapsed
              if (currentSig === lastCapturedSigRef.current && timeSinceLastCapture < 15000) {
                return
              }

              isCapturingRef.current = true
              try {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...api.getAppState(),
                    exportBackground: true,
                    viewBackgroundColor: "#ffffff",
                  },
                  files: api.getFiles(),
                  mimeType: "image/jpeg",
                  quality: 0.6,
                  maxWidthOrHeight: 1280,
                })
                const reader = new FileReader()
                reader.onloadend = () => {
                  const dataUrl = reader.result as string
                  if (dataUrl && ws.readyState === WebSocket.OPEN) {
                    const cleanB64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl
                    ws.send(
                      JSON.stringify({
                        realtimeInput: {
                          video: {
                            data: cleanB64,
                            mimeType: "image/jpeg",
                          },
                        },
                      })
                    )
                    lastCapturedSigRef.current = currentSig
                    lastCaptureTimeRef.current = Date.now()
                  }
                }
                reader.readAsDataURL(blob)
              } catch (err) {
                console.warn("[LiveVoice] Screen capture error:", err)
              } finally {
                isCapturingRef.current = false
              }
            }, 2000)
          } catch (micErr: any) {
            if (stale()) return
            console.error("[LiveVoice] Microphone error:", micErr)
            const missing = micErr?.name === "NotFoundError" || micErr?.name === "OverconstrainedError"
            cleanup()                                          // no microphone = no session: close the provider connection instead of leaving it open
            setErrorMessage(missing ? "No microphone was found." : "Microphone access denied. Please allow microphone permissions.")
            setState("error")
          }
        }

        // Top-level tool call
        const toolCall = data.toolCall || data.tool_call
        if (toolCall && api) {
          const calls = toolCall.functionCalls || toolCall.function_calls || []
          if (calls.length > 0) {
            const responses = await executeLiveTools(calls, api, { assignmentId, courseId })
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  toolResponse: {
                    functionResponses: responses.map((r) => ({
                      id: r.id,
                      response: r.response,
                    })),
                  },
                })
              )
            }
          }
        }

        // Server content: audio streaming & barge-in
        const content = data.serverContent || data.server_content
        if (content) {
          if (content.interrupted) {
            // Barge-in: user spoke over the AI model
            stopActiveAudio()
            setState("listening")
          }

          const turn = content.modelTurn || content.model_turn
          if (turn && turn.parts) {
            for (const part of turn.parts) {
              if (part.inlineData || part.inline_data) {
                const inline = part.inlineData || part.inline_data
                await playPcmAudio(inline.data)
              }
              const call = part.functionCall || part.function_call
              if (call && api) {
                const calls = call.functionCalls || call.function_calls || [call]
                const responses = await executeLiveTools(calls, api, { assignmentId, courseId })
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      toolResponse: {
                        functionResponses: responses.map((r) => ({
                          id: r.id,
                          response: r.response,
                        })),
                      },
                    })
                  )
                }
              }
            }
          }
        }
      }

      ws.onerror = (e) => {
        if (stale()) return
        console.error("[LiveVoice] WebSocket error", e)
        setErrorMessage("Connection to live voice service failed.")
        setState("error")
      }

      ws.onclose = (e) => {
        if (stale()) return
        const end = describeLiveClose(e.code, e.reason)
        // release the microphone and audio contexts the moment the server ends the session, not only when the panel is closed
        cleanup()
        if (end.ok) {
          setErrorMessage(end.message || null)
          setState("idle")
        } else {
          setErrorMessage(end.message)
          setState("error")
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message || "Failed to start live voice.")
      setState("error")
    }
  }, [api, assignmentId, courseId, cleanup, playPcmAudio, stopActiveAudio])

  useEffect(() => {
    void startSession()
    return () => cleanup()
  }, [startSession, cleanup])

  return (
    <div
      role="region"
      aria-label="Live Voice Session"
      className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-white/95 px-4 py-2.5 shadow-xl backdrop-blur-md"
    >
      <div className="relative flex items-center justify-center">
        <span
          className={`size-3 rounded-full ${
            state === "listening"
              ? "bg-emerald-500 animate-pulse"
              : state === "speaking"
              ? "bg-teal-500 animate-ping"
              : state === "connecting"
              ? "bg-amber-400 animate-pulse"
              : "bg-red-500"
          }`}
        />
        {state === "speaking" && (
          <span className="absolute size-5 rounded-full bg-teal-400/30 animate-pulse" />
        )}
      </div>

      <div className="flex flex-col min-w-[120px]">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-ink,#0f172a)]">
          <Sparkles className="size-3.5 text-teal-600" />
          <span>SocratiQ Live Voice</span>
        </div>
        <span className="text-[11px] text-[var(--color-ink-muted,#64748b)]">
          {state === "connecting" && "Connecting to Gemini…"}
          {state === "listening" && (isMuted ? "Muted" : "Listening to you…")}
          {state === "speaking" && "Speaking…"}
          {state === "error" && "Disconnected"}
          {state === "idle" && "Session ended"}
        </span>
      </div>

      {/* Audio Visualizer Bar */}
      {state === "listening" && !isMuted && (
        <div className="flex h-4 items-center gap-0.5">
          {[0.2, 0.4, 0.7, 1.0, 0.6, 0.3].map((factor, i) => (
            <span
              key={i}
              className="w-1 rounded-full bg-emerald-500 transition-all duration-75"
              style={{
                height: `${Math.max(4, volumeLevel * 16 * factor)}px`,
              }}
            />
          ))}
        </div>
      )}

      {errorMessage && (
        <span className={`text-xs max-w-[200px] truncate ${state === "error" ? "text-red-600" : "text-slate-500"}`} title={errorMessage} role={state === "error" ? "alert" : "status"}>
          {errorMessage}
        </span>
      )}

      <div className="flex items-center gap-1.5 border-l border-[var(--color-line)] pl-3">
        <button
          type="button"
          onClick={() => setIsMuted((m) => !m)}
          disabled={state !== "listening" && state !== "speaking"}
          className={`rounded-lg p-1.5 text-xs transition-colors ${
            isMuted
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
          title={isMuted ? "Unmute microphone" : "Mute microphone"}
        >
          {isMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>

        {state === "error" && (
          <button
            type="button"
            onClick={() => void startSession()}
            className="rounded-lg bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 hover:bg-teal-100"
          >
            Retry
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            cleanup()
            onClose()
          }}
          className="rounded-lg bg-red-50 p-1.5 text-xs text-red-600 hover:bg-red-100 transition-colors"
          title="End Live Voice Call"
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    </div>
  )
}

export default LiveVoicePanel
