import { useState } from "react"
import { Info, X } from "lucide-react"
import { missingFeatures, useServerState } from "@/lib/capabilities"

const KEY = "socratiq.serverNoticeDismissed"

/** One slim line under the header when the server (or its database) is behind the app. Dismissible for the browser session. */
export function ServerNotice({ role }: { role: "student" | "teacher" }) {
  const s = useServerState()
  const notice = missingFeatures(s, role)
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(KEY) === "1" } catch { return false } })
  if (!notice || hidden) return null
  return (
    <div role="status" className="flex items-start gap-2 border-b border-[#ecdcae] bg-[#fff6dc] px-4 py-2 text-[13px] leading-snug text-[#5b4a12] sm:px-6 lg:px-7">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1"><b className="font-semibold">{notice.text}</b> {notice.fix}</p>
      <button type="button" aria-label="Hide this notice" className="rounded-full p-0.5 hover:bg-black/5"
        onClick={() => { setHidden(true); try { sessionStorage.setItem(KEY, "1") } catch { /* private mode */ } }}>
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
