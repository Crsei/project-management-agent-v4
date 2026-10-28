import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

const workspaceRoot = path.resolve(appRoot, "../..");

// A remote dev proxy is a privileged gateway to the workspace API, not a public CDN.
const bindingPolicy = (env: Record<string, string | undefined>, isPreview: boolean): Plugin => ({
  name: "workspace-proxy-binding",
  configResolved(config) {
    if (config.command !== "serve") return;
    const host = isPreview ? config.preview.host : config.server.host;
    const local =
      host === undefined ||
      host === false ||
      (typeof host === "string" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host));
    if (
      !local &&
      (env.AGENT_WORKSPACE_ACCESS_TOKEN?.trim().length ?? 0) < 32 &&
      env.AGENT_WORKSPACE_LOOPBACK_PROXY !== "1"
    )
      throw new Error(
        "A non-loopback Web proxy requires AGENT_WORKSPACE_ACCESS_TOKEN (32+ characters).",
      );
  },
});

export default defineConfig(({ mode, isPreview = false }) => {
  // Env remains at the repository root. Only VITE_* is exposed to browser modules.
  const env = { ...loadEnv(mode, workspaceRoot, ""), ...process.env };
  const target = new URL(
    env.AGENT_WORKSPACE_API_URL ?? `http://127.0.0.1:${env.AGENT_WORKSPACE_API_PORT ?? 4323}`,
  );
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new Error("AGENT_WORKSPACE_API_URL must be an HTTP(S) server URL without credentials.");
  const apiProxy: ProxyOptions = {
    target: target.href,
    changeOrigin: false,
    // Preserve the browser's Host and Origin together; never forge same-origin credentials.
    rewriteWsOrigin: false,
    ws: true,
    xfwd: false,
    timeout: 0,
    proxyTimeout: 0,
    rewrite: (requestPath) => requestPath.replace(/^\/agent(?=\/api(?:\/|$))/, ""),
  };

  return {
    root: appRoot,
    base: "/agent/",
    envDir: workspaceRoot,
    plugins: [
      react(),
      tailwindcss(),
      bindingPolicy(env, isPreview),
      {
        name: "workspace-lab-policy",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "ui-lab.json",
            source: JSON.stringify({ enabled: env.VITE_ENABLE_UI_LAB === "1" }),
          });
        },
      },
    ],
    resolve: {
      alias: { "@": appRoot },
      dedupe: ["react", "react-dom", "@assistant-ui/react"],
    },
    worker: { format: "es" },
    // 容器内源码只读挂载：缓存目录由 VITE_CACHE_DIR 指到可写卷
    cacheDir: env.VITE_CACHE_DIR ?? "node_modules/.vite",
    optimizeDeps: {
      // remark-gfm 是 CJS 预打包友好度最差的依赖，官方 Vite 示例同样显式 include
      include: ["remark-gfm"],
    },
    server: {
      host: env.HOST ?? "127.0.0.1",
      port: Number(env.AGENT_WEB_PORT ?? 4324),
      strictPort: true,
      proxy: { "^/agent/api(?:/|$)": apiProxy },
    },
    preview: {
      host: env.HOST ?? "127.0.0.1",
      port: Number(env.AGENT_WEB_PORT ?? 4324),
      strictPort: true,
      proxy: { "^/agent/api(?:/|$)": apiProxy },
    },
    build: {
      outDir: "dist",
      // Preview serves this directory while existing tabs lazily load old hashes.
      // Remove historical assets only during an explicit offline cleanup.
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          // Keep vendor groups under the 500 KB warning without pulling
          // lazily-used modules into the initial chat bundle.
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("@assistant-ui/react-syntax-highlighter")) return;
            if (id.includes("@assistant-ui/ai-sdk")) return "vendor-assistant-ai";
            if (
              id.includes("@assistant-ui/core/dist/react/runtimes/cloud/") ||
              id.includes("assistant-cloud")
            )
              return "vendor-assistant-cloud";
            if (id.includes("@assistant-ui/react-markdown")) return "vendor-assistant-markdown";
            if (/node_modules\/@assistant-ui\/(store|tap)\//.test(id))
              return "vendor-assistant-store";
            if (/node_modules\/@assistant-ui\//.test(id)) return "vendor-assistant";
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
            if (/node_modules\/react-router(-dom)?\//.test(id)) return "vendor-router";
            // Base UI is intentionally not grouped: parts of it are only used by
            // lazy showcase pages, and grouping pulls those modules into the initial chat load.
            if (id.includes("@floating-ui/")) return "vendor-floating-ui";
            if (
              id.includes("@radix-ui/react-menu") ||
              id.includes("@radix-ui/react-select") ||
              id.includes("@radix-ui/react-radio-group") ||
              id.includes("@radix-ui/react-popper") ||
              id.includes("@radix-ui/react-dismissable-layer") ||
              id.includes("@radix-ui/react-focus-scope")
            )
              return "vendor-radix-layer";
            if (
              id.includes("react-syntax-highlighter/dist/esm/async-languages/prism") ||
              id.includes("react-syntax-highlighter/dist/esm/languages/prism/")
            )
              return "vendor-prism-languages";
            if (id.includes("/node_modules/.pnpm/cn@") || id.includes("/node_modules/cn/"))
              return "vendor-styles";
            if (id.includes("lucide-react")) return "vendor-icons";
            if (id.includes("tailwind-merge")) return "vendor-styles";
            if (/node_modules\/zod\//.test(id)) return "vendor-zod";
            if (
              /node_modules\/(remark|rehype|micromark|mdast|hast|unified|unist|react-markdown|remark-gfm)\//.test(
                id,
              )
            )
              return "vendor-markdown";
            if (/node_modules\/(ai|@ai-sdk)\//.test(id)) return "vendor-ai";
          },
        },
      },
    },
  };
});
