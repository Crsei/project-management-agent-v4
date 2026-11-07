import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type ProxyOptions } from "vite"
import { openHandsProvenancePlugin } from "../../vendor/openhands-extensions/scripts/web-build.mjs"

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig(({ command, mode, isPreview }) => {
  const env = { ...loadEnv(mode, workspaceRoot, ""), ...process.env }
  const port = Number(env.PM_WEB_PORT ?? 4326)
  const setting = env.PM_ENABLE_LAB
  if (setting !== undefined && setting !== "true" && setting !== "false") {
    throw new Error("PM_ENABLE_LAB must be true or false")
  }
  const labEnabled = setting === "true" || (command === "serve" && !isPreview && setting !== "false")
  const isStorybook = process.env.STORYBOOK === "true"
  const agentTarget = new URL(env.AGENT_WORKSPACE_API_URL ?? `http://127.0.0.1:${env.AGENT_WORKSPACE_API_PORT ?? 4325}`)
  if (!['http:', 'https:'].includes(agentTarget.protocol) || agentTarget.username || agentTarget.password) {
    throw new Error("AGENT_WORKSPACE_API_URL must be an HTTP(S) server URL without credentials.")
  }
  const pmProxy: ProxyOptions = {
    target: env.PM_API_URL ?? "http://127.0.0.1:4194",
    changeOrigin: false,
    // Only the frontend's own Origin may be translated to the PM API origin.
    bypass(request, response) {
      const origin = request.headers.origin
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
        if (response) {
          response.statusCode = 403
          response.end(JSON.stringify({ error: { code: "origin_forbidden" } }))
        } else request.destroy()
        return false
      }
      if (origin) request.headers.origin = env.PM_API_ORIGIN ?? origin
    },
  }
  const agentProxy: ProxyOptions = {
    target: agentTarget.href,
    changeOrigin: false,
    rewriteWsOrigin: false,
    ws: true,
    xfwd: false,
    timeout: 0,
    proxyTimeout: 0,
    rewrite: path => path.replace(/^\/agent(?=\/api(?:\/|\?|$))/, ""),
  }
  const proxy = { "^/agent/api(?:/|\\?|$)": agentProxy, "/api": pmProxy, "/health": pmProxy, "/openapi.json": pmProxy }
  const hmrPort = env.VITE_HMR_CLIENT_PORT ? Number(env.VITE_HMR_CLIENT_PORT) : undefined
  return {
    envDir: workspaceRoot,
    define: { "import.meta.env.PM_LAB_ENABLED": JSON.stringify(labEnabled) },
    plugins: [react(), tailwindcss(), ...(isStorybook ? [] : [openHandsProvenancePlugin()])],
    resolve: {
      alias: [
        { find: /^@pm\/ui$/, replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)) },
        { find: /^@pm\/ui\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/ui/src/$1", import.meta.url)) },
        ...Object.entries({
          "@agent": fileURLToPath(new URL("./src/features/agent", import.meta.url)),
          "@pm/openhands-extensions": fileURLToPath(new URL("../../vendor/openhands-extensions/src/web/index.tsx", import.meta.url)),
          "@pm/openhands-source": fileURLToPath(new URL("../../vendor/openhands-extensions/src", import.meta.url)),
          "@pm/cc-switch-source": fileURLToPath(new URL("../../vendor/cc-switch/src", import.meta.url)),
          "@openhands/extensions/integrations": fileURLToPath(new URL("../../vendor/openhands-extensions/extensions/integrations/index.js", import.meta.url)),
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
        }).map(([find, replacement]) => ({ find, replacement })),
      ],
      dedupe: ["react", "react-dom", "react-router", "react-router-dom", "@assistant-ui/react", "@tanstack/react-query", "i18next", "react-i18next"],
    },
    worker: { format: "es" },
    cacheDir: env.VITE_CACHE_DIR ?? "node_modules/.vite",
    optimizeDeps: { include: ["remark-gfm"] },
    server: { host: "127.0.0.1", port, strictPort: true, proxy, hmr: hmrPort ? { clientPort: hmrPort } : undefined, watch: { usePolling: env.CHOKIDAR_USEPOLLING === "true" } },
    preview: { host: "127.0.0.1", port, strictPort: true, proxy },
    // Open tabs can still lazy-load their existing hashed chunks after a deployment.
    build: { outDir: "dist", emptyOutDir: false },
  }
})
