import { describe, it, expect } from "vite-plus/test";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { makeOmpPermissionExtension, parseOmpGateCall, ompPermissionKind } from "./permissions.ts";

interface Context {
  agent: { kind: string };
  hasUI: boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean>; notify: (message: string, level: string) => void };
  sessionManager: { getSessionFile: () => string; getSessionId: () => string };
}
type Handler = (event: Record<string, unknown>, context: Context) => unknown;

describe("OMP immutable execution hook", () => {
  it("denies headless/subagent/autonomous/inactive execution and asks even for a read-looking tool", async () => {
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "omp-gate-test-"));
    try {
      const contextPath = Path.join(directory, "context.json");
      await Fs.writeFile(contextPath, JSON.stringify({ active: false }));
      const source = makeOmpPermissionExtension({ title: "test-gate", ready: "test-ready", contextPath });
      // Runtime-selected generated native extension: loading is the boundary under test.
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as { default: (api: { on: (name: string, handler: Handler) => void }) => void };
      const handlers = new Map<string, Handler>();
      module.default({ on: (name, handler) => { handlers.set(name, handler); } });
      const prompts: Array<{ title: string; message: string }> = [];
      const notifications: string[] = [];
      let answer = false;
      const context: Context = { agent: { kind: "main" }, hasUI: true,
        ui: { confirm: async (title, message) => { prompts.push({ title, message }); return answer; },
          notify: message => { notifications.push(message); } },
        sessionManager: { getSessionFile: () => "/native/session.jsonl", getSessionId: () => "native" } };
      const call = handlers.get("tool_call")!;
      const event = { toolName: "read", toolCallId: "read-1", input: { path: "file.ts" } };
      expect(await call(event, context)).toMatchObject({ block: true });
      expect(prompts).toHaveLength(0);
      await Fs.writeFile(contextPath, JSON.stringify({ active: true }));
      expect(await call(event, { ...context, hasUI: false })).toMatchObject({ block: true });
      expect(await call(event, { ...context, agent: { kind: "sub" } })).toMatchObject({ block: true });
      expect(await call({ ...event, toolName: "task" }, context)).toMatchObject({ block: true });
      expect(handlers.get("before_subagent_spawn")!({}, context)).toMatchObject({ block: true });
      expect(await call(event, context)).toMatchObject({ block: true });
      expect(prompts).toHaveLength(1);
      expect(parseOmpGateCall({ method: "confirm", title: prompts[0]!.title, message: prompts[0]!.message }, "test-gate"))
        .toMatchObject({ toolName: "read", toolCallId: "read-1", sessionId: "native" });
      answer = true;
      expect(await call(event, context)).toBeUndefined();
      // Native yolo/user allow never enter this extension's decision: each
      // call still reaches this awaitable host gate, including the next call.
      expect(prompts).toHaveLength(2);
      handlers.get("tool_approval_requested")!({ toolName: "pm_inspect", toolCallId: "pm-1", sessionId: "native", approvalMode: "always-ask" }, context);
      expect(notifications[0]).toMatch(/^test-gate:native-approval:/);
      expect(JSON.parse(notifications[0]!.slice("test-gate:native-approval:".length))).toMatchObject({
        toolName: "pm_inspect", toolCallId: "pm-1", sessionId: "native", sessionFile: "/native/session.jsonl" });
      expect(handlers.get("user_bash")!({}, context)).toMatchObject({ result: { exitCode: 1 } });
      expect(handlers.get("user_python")!({}, context)).toMatchObject({ result: { exitCode: 1 } });
    } finally { await Fs.rm(directory, { recursive: true, force: true }); }
  });

  it("rejects malformed/foreign approval markers and classifies permissions independently from questions", () => {
    expect(parseOmpGateCall({ method: "confirm", title: "gate", message: "not JSON" }, "gate")).toBeUndefined();
    expect(parseOmpGateCall({ method: "input", title: "gate", message: "{}" }, "gate")).toBeUndefined();
    expect(ompPermissionKind("read")).toBe("file-read");
    expect(ompPermissionKind("edit")).toBe("file-change");
    expect(ompPermissionKind("bash")).toBe("command");
    expect(ompPermissionKind("unknown_plugin_name")).toBe("permission");
  });
});
