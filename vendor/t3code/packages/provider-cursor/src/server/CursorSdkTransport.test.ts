import { assert, describe, it } from "@effect/vitest";
import { serialize, deserialize } from "node:v8";
import { cursorWorkerReply, cursorWorkerRequest, cursorRunResult, cursorNativeMetadata } from "./CursorSdkTransport.ts";

describe("Cursor original SDK transport boundary", () => {
  it("preserves native binary output through advanced IPC serialization", () => {
    const bytes = new Uint8Array([0xf0, 0x9f, 0x99, 0x82, 0x0a]);
    const incoming = deserialize(serialize({ type: "delta", sequence: 1,
      update: { type: "shell-output-delta", event: { data: bytes } } }));
    const frame = cursorWorkerReply.parse(incoming);
    assert.equal(frame.type, "delta");
    if (frame.type !== "delta" || frame.update.type !== "shell-output-delta") assert.fail("Expected native shell output");
    assert.instanceOf(frame.update.event.data, Uint8Array);
    const data = frame.update.event.data;
    if (!(data instanceof Uint8Array)) assert.fail("Expected preserved native bytes");
    assert.deepEqual(Array.from(data), Array.from(bytes));
  });
  it("does not turn a transport acknowledgement or missing usage into native completion", () => {
    assert.isFalse(cursorRunResult.safeParse({ id: "run", status: "running" }).success);
    assert.isFalse(cursorRunResult.safeParse({ id: "run", status: "finished", result: 0 }).success);
    const partial: { id: string; status: "finished"; usage: { inputTokens: number } } = {
      id: "run", status: "finished", usage: { inputTokens: 7 },
    };
    const decoded = cursorRunResult.parse(partial);
    assert.equal(decoded.usage?.inputTokens, 7);
    assert.notProperty(decoded.usage, "outputTokens");
    assert.notProperty(cursorRunResult.parse({ id: "run", status: "finished" }), "usage");
  });
  it("rejects cloud identity and malformed private operation envelopes", () => {
    assert.isFalse(cursorNativeMetadata.safeParse({ agentId: "agent", runtime: "cloud", cwd: "/workspace", homeDirectory: "/home", runs: [] }).success);
    assert.isFalse(cursorWorkerRequest.safeParse({ id: 1, operation: "open", input: { operation: "resume", agentId: "agent" }, stateRoot: "/private" }).success);
    assert.isFalse(cursorWorkerReply.safeParse({ type: "authorize", sequence: 1 }).success);
    assert.isTrue(cursorWorkerReply.safeParse({ type: "failure", id: 1, error: { name: "AuthenticationError", status: 401 } }).success);
  });
});
