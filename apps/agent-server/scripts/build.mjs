import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  absWorkingDir: packageRoot,
  entryPoints: {
    index: "src/index.ts",
    "agents/claude-history-worker": "src/agents/claude-history-worker.ts",
    "providers/drivers/cursor-sdk-worker": "src/providers/drivers/cursor-sdk-worker.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22.18",
  sourcemap: true,
});
