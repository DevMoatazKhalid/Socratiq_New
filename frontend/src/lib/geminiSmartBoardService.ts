import { apiBase, accessToken } from "./api"

export const SMARTBOARD_API_BASE = `${apiBase()}/smartboard`

const getAuthHeaders = async (): Promise<Record<string, string>> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = await accessToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}


/** The Coach declined to draw something that would hand over the answer (HTTP 422, code "coach_redirect"). `message` is its Socratic reply. */
export class CoachRedirectError extends Error {
  constructor(message: string) { super(message); this.name = "CoachRedirectError" }
}
export interface GenerateContext {
  /** The assignment this board belongs to. The server applies that assignment's policy to the request, exactly as it does in the Chat. */
  assignmentId?: string | null
  /** Live Voice tools want the Coach's reply (so the model can decline in the same Socratic voice); other callers just see a failure. */
  throwOnRedirect?: boolean
}
const asBody = (b: Record<string, unknown>, ctx?: GenerateContext) => JSON.stringify(ctx?.assignmentId ? { ...b, assignment_id: ctx.assignmentId } : b)
const redirectOr = async (response: Response, ctx?: GenerateContext): Promise<void> => {
  if (response.status !== 422 || !ctx?.throwOnRedirect) return
  try {
    const j = await response.clone().json()
    if (j?.error?.code === "coach_redirect" && typeof j.error.message === "string") throw new CoachRedirectError(j.error.message)
  } catch (e) { if (e instanceof CoachRedirectError) throw e }
}

export const generateImageContent = async (prompt: string, size: "1K" | "2K" | "4K" = "1K", ctx?: GenerateContext): Promise<string | null> => {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${SMARTBOARD_API_BASE}/generate-image`, {
      method: 'POST',
      headers,
      body: asBody({ prompt, size }, ctx)
    });
    await redirectOr(response, ctx)
    if (!response.ok) { console.warn(`Image generation failed (HTTP ${response.status})`); return null; }
    const data = await response.json();
    return typeof data.imageUrl === "string" && data.imageUrl.startsWith("data:image/") ? data.imageUrl : null;
  } catch (error) {
    if (error instanceof CoachRedirectError) throw error
    console.error("Image generation failed:", error);
    return null;
  }
};

export const generateSimulationCode = async (prompt: string, ctx?: GenerateContext): Promise<string | null> => {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${SMARTBOARD_API_BASE}/generate-simulation`, {
      method: 'POST',
      headers,
      body: asBody({ prompt }, ctx)
    });
    await redirectOr(response, ctx)
    if (!response.ok) { console.warn(`Simulation generation failed (HTTP ${response.status})`); return null; }
    const data = await response.json();
    return typeof data.code === "string" && data.code.trim() ? data.code : null;
  } catch (error) {
    if (error instanceof CoachRedirectError) throw error
    console.error("Simulation generation failed:", error);
    return null;
  }
};

export const generateVectorDrawing = async (prompt: string, ctx?: GenerateContext): Promise<any[] | null> => {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${SMARTBOARD_API_BASE}/generate-vector`, {
      method: 'POST',
      headers,
      body: asBody({ prompt }, ctx)
    });
    await redirectOr(response, ctx)
    if (!response.ok) { console.warn(`Vector generation failed (HTTP ${response.status})`); return null; }   // an error must never look like "success with no shapes"
    const data = await response.json();
    return Array.isArray(data.elements) && data.elements.length > 0 ? data.elements : null;
  } catch (error) {
    if (error instanceof CoachRedirectError) throw error
    console.error("Vector generation failed:", error);
    return null;
  }
};

export interface ChatProxyOptions {
  assignmentId?: string
  courseId?: string
  board?: any
  selectedId?: string | null
  boardIntent?: string | null
}

export const sendChatProxy = async (
  messages: any[],
  screenshot: string | null,
  tools: any[],
  systemInstruction: string,
  options?: ChatProxyOptions
): Promise<any> => {
  try {
    const headers = await getAuthHeaders()
    const payload: Record<string, any> = {
      messages,
      screenshot,
      tools,
      systemInstruction,
    }
    if (options?.assignmentId) payload.assignment_id = options.assignmentId
    if (options?.courseId) payload.course_id = options.courseId
    if (options?.board) payload.board = options.board
    if (options?.selectedId) payload.selected_id = options.selectedId
    if (options?.boardIntent) payload.board_intent = options.boardIntent

    const response = await fetch(`${SMARTBOARD_API_BASE}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      return { error: data.detail || data.message || `Server error (${response.status})` };
    }
    return data;
  } catch (error: any) {
    console.error("Chat failed:", error);
    return { error: error?.message || "Connection failed" };
  }
};

export const getSmartBoardContext = async (
  assignmentId?: string,
  courseId?: string
): Promise<any> => {
  try {
    const headers = await getAuthHeaders()
    const params = new URLSearchParams()
    if (assignmentId) params.append("assignment_id", assignmentId)
    if (courseId) params.append("course_id", courseId)

    const response = await fetch(`${SMARTBOARD_API_BASE}/context?${params.toString()}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) return null
    return await response.json()
  } catch (e) {
    console.error("Failed to fetch smartboard context:", e)
    return null
  }
}

export const retrieveCourseMaterials = async (
  query: string,
  assignmentId?: string,
  courseId?: string,
  topK = 4
): Promise<any[]> => {
  try {
    const headers = await getAuthHeaders()
    const response = await fetch(`${SMARTBOARD_API_BASE}/retrieve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, assignment_id: assignmentId, course_id: courseId, top_k: topK })
    });
    if (!response.ok) return []
    const data = await response.json()
    return data.results || []
  } catch (e) {
    console.error("Failed to retrieve course materials:", e)
    return []
  }
}

export const getLiveWebSocketUrl = (): string => {
  const base = apiBase();
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (base.startsWith('http')) {
    return base.replace(/^http/, 'ws') + '/smartboard/live';
  }
  return `${wsProtocol}//${window.location.host}${base}/smartboard/live`;
};

