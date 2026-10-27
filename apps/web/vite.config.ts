import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import type { ProxyOptions } from "vite"

const PORT = Number(process.env.PM_WEB_PORT ?? 3220)
const target = process.env.PM_API_URL ?? "http://127.0.0.1:4100"
const apiProxy: ProxyOptions = {
  target,
  changeOrigin: false,
  // Accept only the frontend's own Origin before forwarding to the backend's
  // configured origin. Never turn an arbitrary cross-origin request into trusted traffic.
  bypass(request, response) {
    const origin = request.headers.origin
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
      if (response) {
        response.statusCode = 403
        response.end(JSON.stringify({ error: { code: "origin_forbidden" } }))
      } else {
        request.destroy()
      }
      return false
    }
    if (origin) request.headers.origin = process.env.PM_API_ORIGIN ?? new URL(target).origin
  },
}
const proxy = { "/api": apiProxy, "/health": apiProxy, "/openapi.json": apiProxy }

export default defineConfig(({ command, isPreview }) => {
  const setting = process.env.PM_ENABLE_LAB
  if (setting !== undefined && setting !== "true" && setting !== "false") {
    throw new Error("PM_ENABLE_LAB must be true or false")
  }
  // Gate by the operation, not --mode or NODE_ENV: even a custom-mode build
  // must opt in. Preview cannot enable routes omitted from its built artifact.
  const labEnabled = setting === "true" || (command === "serve" && !isPreview && setting !== "false")
  return {
  define: { "import.meta.env.PM_LAB_ENABLED": JSON.stringify(labEnabled) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@contracts": fileURLToPath(new URL("../../packages/contracts/src/client.ts", import.meta.url)),
      "@pm-schema/relations": fileURLToPath(new URL("../../packages/pm-schema/relations.ts", import.meta.url)),
      "@pm-schema/query": fileURLToPath(new URL("../../packages/pm-schema/query.ts", import.meta.url)),
      "@pm-schema/graph": fileURLToPath(new URL("../../packages/pm-schema/graph.ts", import.meta.url)),
      "@pm-core/migrations": fileURLToPath(new URL("../../packages/pm-core/migrations.ts", import.meta.url)),
      "@pm-schema": fileURLToPath(new URL("../../packages/pm-schema/index.ts", import.meta.url)),
      "@pm-markdown": fileURLToPath(new URL("../../packages/pm-markdown/index.ts", import.meta.url)),
      "@pm-core": fileURLToPath(new URL("../../packages/pm-core/index.ts", import.meta.url)),
      "@pm-views": fileURLToPath(new URL("../../packages/pm-views/index.tsx", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: PORT, strictPort: true, proxy, watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === "true" } },
  preview: { host: "127.0.0.1", port: PORT, strictPort: true, proxy },
  build: { outDir: "dist", emptyOutDir: true },
  }
})
