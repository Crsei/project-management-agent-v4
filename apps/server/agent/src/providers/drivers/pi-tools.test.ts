import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { workspaceRoot } from "../../paths.ts";

test("Pi extension discovers registry schemas and dispatches the original tool arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-pm-extension-"));
  const typebox = path.join(root, "node_modules", "@sinclair", "typebox");
  await mkdir(typebox, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(typebox, "package.json"), JSON.stringify({ name: "@sinclair/typebox", type: "module", exports: "./index.js" }));
  await writeFile(path.join(typebox, "index.js"), `export const Type = new Proxy({}, { get: (_target, name) => (...args) => ({ kind: name, args }) });`);
  const extension = path.join(root, "pi-tools.ts");
  await copyFile(path.join(workspaceRoot, "packages/pm-cli/pi-tools.ts"), extension);
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/tools/list") return res.end(JSON.stringify({ tools: [{ name: "pm_read", description: "Read PM", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }] }));
    let body = ""; for await (const chunk of req) body += String(chunk);
    const call = JSON.parse(body) as Record<string, unknown>;
    calls.push(call);
    res.end(JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000001", name: call.name, status: "succeeded" }));
  });
  const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const old = process.env.AGENT_PM_TOOL_BRIDGE;
  process.env.AGENT_PM_TOOL_BRIDGE = `http://127.0.0.1:${address.port}`;
  try {
    const tools: Array<{ name: string; parameters: { kind: string }; execute(id: string, args: unknown): Promise<{ content: Array<{ text: string }> }> }> = [];
    // Pi's loader supplies TypeBox; this fixture supplies the same builder boundary without a provider account.
    const module = await import(pathToFileURL(extension).href);
    await module.default({ registerTool: (tool: typeof tools[number]) => tools.push(tool) });
    assert.equal(tools.length, 1); assert.equal(tools[0]?.name, "pm_read");
    assert.equal(tools[0]?.parameters.kind, "Object");
    const result = await tools[0]!.execute("native-call", { id: "PRJ-001" });
    assert.deepEqual(calls[0]?.arguments, { id: "PRJ-001" });
    assert.equal(calls[0]?.name, "pm_read"); assert.equal(calls[0]?.requestId, "native-call");
    assert.equal(calls[0]?.transportId, "pi-native");
    assert.equal(JSON.parse(result.content[0]!.text).status, "succeeded");
  } finally {
    if (old === undefined) delete process.env.AGENT_PM_TOOL_BRIDGE; else process.env.AGENT_PM_TOOL_BRIDGE = old;
    server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close((error) => error ? closed.reject(error) : closed.resolve()); await closed.promise;
    await rm(root, { recursive: true, force: true });
  }
});
