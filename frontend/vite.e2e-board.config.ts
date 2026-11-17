// Builds the browser-test page for the native board (e2e/sim/board). Same plugins/aliases as the app; output goes to a temp dir, never into the repo.
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import { fileURLToPath } from "url"
const dirname = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: path.resolve(dirname, "../e2e/sim/board"),
  base: "./",
  plugins: [react(), tailwindcss()],
  // the entry lives outside frontend/, so react must be resolved from frontend/node_modules
  resolve: { alias: [{ find: "@", replacement: path.resolve(dirname, "./src") }, { find: /^(react-dom|react)(\/.*)?$/, replacement: path.resolve(dirname, "node_modules") + "/$1$2" }] },
  server: { fs: { allow: [path.resolve(dirname, "..")] } },
  build: { outDir: process.env.SQ_E2E_BOARD_OUT || "/tmp/sq-e2e-build/board", emptyOutDir: true, chunkSizeWarningLimit: 6000 },
})
