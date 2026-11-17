import { useContext, useEffect, useRef } from "react"
import { QueryClientContext } from "@tanstack/react-query"
import * as supabaseModule from "./supabase"
import type { RealtimeChannel } from "@supabase/supabase-js"

export interface RealtimeSubscriptionOpts {
  table: string
  schema?: string
  filter?: string
  event?: "INSERT" | "UPDATE" | "DELETE" | "*"
  onPayload?: (payload: unknown) => void
  invalidateKeys?: unknown[][]
  enabled?: boolean
}

/**
 * Subscribes to Supabase Realtime postgres_changes on an authoritative table.
 * Automatically invalidates specified React Query keys or invokes onPayload.
 * Gracefully no-ops when Supabase is not configured or in tests.
 */
export function useRealtimeSubscription({
  table,
  schema = "public",
  filter,
  event = "*",
  onPayload,
  invalidateKeys,
  enabled = true,
}: RealtimeSubscriptionOpts): void {
  // Unconditional context read (a hook must never sit inside try/catch). `null` when there is no provider, e.g. in isolated tests.
  const qc = useContext(QueryClientContext) ?? null

  // Callbacks and keys are passed inline by callers, so their identity changes on EVERY render. They are read through a ref so they never
  // restart the subscription; only the subscription's real identity (table/schema/filter/event/enabled/client) does.
  const latest = useRef({ onPayload, invalidateKeys })
  latest.current = { onPayload, invalidateKeys }

  useEffect(() => {
    let isConfigured = false
    let client: any = null
    try {
      isConfigured = Boolean((supabaseModule as any).isConfigured)
      client = (supabaseModule as any).supabase
    } catch {
      isConfigured = false
      client = null
    }
    if (!enabled || !isConfigured || !client || typeof window === "undefined") {
      return
    }

    const channelName = `realtime:${table}:${filter ?? "all"}:${Date.now()}`
    let channel: RealtimeChannel | null = null

    try {
      channel = client
        .channel(channelName)
        .on(
          "postgres_changes" as any,
          {
            event,
            schema,
            table,
            ...(filter ? { filter } : {}),
          },
          (payload: unknown) => {
            const { onPayload: cb, invalidateKeys: keys } = latest.current
            if (cb) {
              cb(payload)
            }
            if (qc && keys && keys.length > 0) {
              for (const key of keys) {
                void qc.invalidateQueries({ queryKey: key as any })
              }
            }
          }
        )
        .subscribe((status: string) => {
          if (status === "SUBSCRIBED") {
            // Subscription active or re-established: trigger a fresh database fetch
            // to ensure no events were missed during network disconnections or offline periods
            const keys = latest.current.invalidateKeys
            if (qc && keys && keys.length > 0) {
              for (const key of keys) {
                void qc.invalidateQueries({ queryKey: key as any })
              }
            }
          } else if (status === "CHANNEL_ERROR") {
            console.warn(`[Supabase Realtime] Channel error on ${channelName}`)
          } else if (status === "TIMED_OUT") {
            console.warn(`[Supabase Realtime] Subscription timed out on ${channelName}`)
          }
        })
    } catch (err) {
      console.warn(`[Supabase Realtime] Failed to subscribe to ${channelName}:`, err)
    }

    return () => {
      if (channel && client) {
        try {
          void client.removeChannel(channel)
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }, [enabled, table, schema, filter, event, qc])
}

/**
 * Hook to sync student Whiteboard and Attempt changes across devices or for teacher observation.
 */
export function useWhiteboardRealtimeSync(assignmentId?: string, enabled = true): void {
  useRealtimeSubscription({
    table: "attempts",
    filter: assignmentId ? `assignment_id=eq.${assignmentId}` : undefined,
    invalidateKeys: [
      ["student", "whiteboard", assignmentId],
      ["teacher", "review", assignmentId],
    ],
    enabled: enabled && !!assignmentId,
  })
}

/**
 * Hook to sync file processing status changes (QUEUED -> PROCESSING -> COMPLETED).
 */
export function useMaterialRealtimeSync(materialId?: string, enabled = true): void {
  useRealtimeSubscription({
    table: "materials",
    filter: materialId ? `id=eq.${materialId}` : undefined,
    invalidateKeys: [
      ["teacher", "material", materialId],
      ["student", "material", materialId],
    ],
    enabled: enabled && !!materialId,
  })
}
