import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Keep test registration on the same Vite+/Vitest instance as the vendor runner.
    dedupe: ["@effect/vitest", "vite-plus"],
  },
  test: {
    environment: "node",
    env: { VP_REMOTE_CACHE: "off", VP_REMOTE_CACHE_URL: "" },
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx", "apps/server/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.{git,cache,output,temp}/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout", "clearTimeout", "setInterval", "clearInterval",
        "setImmediate", "clearImmediate", "Date", "performance",
        "requestAnimationFrame", "cancelAnimationFrame",
        "requestIdleCallback", "cancelIdleCallback",
      ],
    },
    setupFiles: [
      fileURLToPath(new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url)),
      fileURLToPath(new URL("./packages/shared/src/testing/providerEnv.ts", import.meta.url)),
    ],
  },
});
