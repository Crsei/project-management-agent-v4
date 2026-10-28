// Pi's mandatory supervised tool hook, ported from t3code/packages/provider-pi/src/server/mcpExtensionSource.ts:303-340 (MIT).
// No T3 MCP bridge is injected: this host has no T3 workbench/orchestration service.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PI_PERMISSION_READY = "Agent PM Pi permission guard active.";
const extensionSource = `export default function (pi) {
  const readOnlyTools = { read: true, grep: true, find: true, ls: true };
  pi.on("tool_call", async (event, ctx) => {
    const builtinSearch = event.toolName === "tool_search" && typeof pi.getAllTools === "function" && pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");
    if (builtinSearch || Object.hasOwn(readOnlyTools, event.toolName)) return;
    let summary;
    try { summary = JSON.stringify(event.input, null, 2).slice(0, 4000); }
    catch { summary = String(event.input).slice(0, 4000); }
    const approved = await ctx.ui.confirm("Allow " + event.toolName + "?", summary, { signal: ctx.signal });
    if (!approved) return { block: true, reason: event.toolName + " was declined in Agent PM." };
  });
  pi.on("session_start", (_event, ctx) => ctx.ui.notify(${JSON.stringify(PI_PERMISSION_READY)}, "info"));
}
`;

export async function materializePiPermissions(homeDirectory: string): Promise<string> {
  const directory = path.join(homeDirectory, ".cache", "agent-pm");
  const filename = path.join(directory, "pi-permissions.ts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous !== extensionSource) await writeFile(filename, extensionSource, { mode: 0o600 });
  return filename;
}
