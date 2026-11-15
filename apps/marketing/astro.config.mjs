import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  // Keep extensionless static notices such as /LICENSE reachable in preview.
  trailingSlash: "ignore",
  vite: {
    envDir: process.env.DOVSPACE_ISOLATED_CHECKS === "1" ? false : undefined,
  },
  server: {
    host: "127.0.0.1",
    port: 4330,
  },
});
