/** Test page: the REAL SmartBoardWorkspace (real Excalidraw, real layer, real autosave). Only the network is stubbed, by Playwright, outside the app. */
import { createRoot } from "react-dom/client"
import { SmartBoardWorkspace } from "@/components/smartboard/SmartBoardWorkspace"
import { fromServer } from "@/lib/whiteboard"
import "./e2e.css"

const cfg = (window as any).__init ?? {}
const saves: unknown[] = []
;(window as any).__t = { saves, asks: [] as unknown[] }
createRoot(document.getElementById("root")!).render(
  <div style={{ width: cfg.width ?? 1280, height: cfg.height ?? 800, position: "relative" }}>
    <SmartBoardWorkspace
      assignmentId="e2e" initial={fromServer(cfg.board)} readOnly={!!cfg.readOnly} busy={false}
      onAsk={(i, m) => (window as any).__t.asks.push([i, m])}
      onPersist={async (scene) => { saves.push(JSON.parse(JSON.stringify(scene))); return {} }}
    />
  </div>,
)
