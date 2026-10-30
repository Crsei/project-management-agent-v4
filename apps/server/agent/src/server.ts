import "./environment.ts";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { app } from "./app.ts";
import { attachTerminalUpgrade } from "./inspector/terminal.ts";
import { startRuntime, stopRuntime } from "./runtime.ts";
import { assertNetworkBinding } from "./access.ts";
import { webDistDirectory } from "./paths.ts";

// Unknown API routes must never fall through to the SPA, including in API-only mode.
app.all("/api", (c) => c.json({ error: "API route not found." }, 404));
app.all("/api/*", (c) => c.json({ error: "API route not found." }, 404));
if (process.env.AGENT_WORKSPACE_API_ONLY === "0") {
  const webDist = webDistDirectory();
  let labEnabled: boolean;
  try {
    // The build owns this policy; a runtime flag must not expose a gated showcase.
    labEnabled =
      JSON.parse(readFileSync(path.join(webDist, "ui-lab.json"), "utf8")).enabled === true;
  } catch (cause) {
    throw new Error(
      `Web build unavailable at ${webDist}. Build the web app or configure AGENT_WORKSPACE_WEB_DIST.`,
      { cause },
    );
  }
  app.use("/showcase", async (c, next) => (labEnabled ? next() : c.notFound()));
  app.use("/showcase/*", async (c, next) => (labEnabled ? next() : c.notFound()));
  app.use("/*", serveStatic({ root: webDist }));
  app.get("*", serveStatic({ path: path.join(webDist, "index.html") }));
}

const port = Number(process.env.PORT ?? process.env.AGENT_WORKSPACE_API_PORT ?? 4325);
const host = process.env.HOST?.trim() || "127.0.0.1";
assertNetworkBinding(host);
await startRuntime();
// The public proxy strips /agent for APIs. Standalone/Desktop hosting accepts the
// same mount without changing Host/Origin or the existing access middleware.
const server = serve({ fetch: (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
    url.pathname = url.pathname.slice("/agent".length) || "/";
    return app.fetch(new Request(url, request));
  }
  return app.fetch(request);
}, port, hostname: host }, (info) => {
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  console.log(`agent-workspace listening on http://${address}:${info.port}`);
});
server.prependListener("upgrade", (request) => {
  if (request.url?.startsWith("/agent/api/")) request.url = request.url.slice("/agent".length);
});
attachTerminalUpgrade(server as Server);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  void stopRuntime().then(
    () => {
      server.close(() => process.exit(0));
      if ("closeAllConnections" in server) server.closeAllConnections();
    },
    (error: unknown) => {
      console.error("Workspace shutdown failed", error);
      process.exit(1);
    },
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
// Only a Node parent that opened an IPC channel can request this lifecycle action.
if (process.send) {
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "agent-workspace:shutdown"
    )
      shutdown();
  });
  process.on("disconnect", shutdown);
}
