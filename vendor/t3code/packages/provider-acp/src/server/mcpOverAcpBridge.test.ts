import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeAcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";

const servers = [{ name: "pm_tools", transport: "stdio" as const, command: process.execPath,
  args: [fileURLToPath(new URL("./mcpOverAcpBridge.test-peer.ts", import.meta.url))] }];
const initialize = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "acp-native-fixture", version: "1" } };

describe("generation-owned MCP-over-ACP stdio bridge", () => {
  it.effect("connects the actual PM-bound stdio process and invokes a typed native tool, without t3 HTTP authorization", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({ servers, cwd: process.cwd(), environment: { PATH: process.env.PATH },
        assertCurrent: Effect.void, allocateConnectionId: Effect.succeed("native-connection") });
      yield* Effect.addFinalizer(() => bridge.dispose);
      const { connectionId } = yield* bridge.connect({ serverId: "pm_tools" });
      expect(yield* bridge.message({ connectionId, method: "initialize", params: initialize })).toMatchObject({ serverInfo: { name: "pm-transport-fixture" } });
      yield* bridge.notification({ connectionId, method: "notifications/initialized" });
      expect(yield* bridge.message({ connectionId, method: "tools/list" })).toMatchObject({ tools: [{ name: "fixture_add" }] });
      expect(yield* bridge.message({ connectionId, method: "tools/call", params: { name: "fixture_add", arguments: { a: 19, b: 23 } } }))
        .toEqual({ content: [{ type: "text", text: "42" }] });
      yield* bridge.disconnect({ connectionId });
      expect(yield* bridge.message({ connectionId, method: "tools/list" }).pipe(Effect.flip)).toMatchObject({ _tag: "AcpMcpOverAcpError" });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects foreign server admission and revoked generations before another native request", () =>
    Effect.gen(function* () {
      let current = true;
      const bridge = yield* makeAcpMcpOverAcpBridge({ servers, cwd: process.cwd(), environment: {},
        assertCurrent: Effect.suspend(() => current ? Effect.void : Effect.fail(new Error("Generation revoked"))),
        allocateConnectionId: Effect.succeed("revocable-connection") });
      yield* Effect.addFinalizer(() => bridge.dispose);
      expect(yield* bridge.connect({ serverId: "t3-code" }).pipe(Effect.flip)).toMatchObject({ _tag: "AcpMcpOverAcpError" });
      const { connectionId } = yield* bridge.connect({ serverId: "pm_tools" });
      current = false;
      expect(yield* bridge.message({ connectionId, method: "initialize", params: initialize }).pipe(Effect.flip))
        .toMatchObject({ message: "Generation revoked" });
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an outstanding native MCP request and releases its owned process on disposal", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({ servers, cwd: process.cwd(), environment: {},
        assertCurrent: Effect.void, allocateConnectionId: Effect.succeed("cancelled-connection") });
      yield* Effect.addFinalizer(() => bridge.dispose);
      const { connectionId } = yield* bridge.connect({ serverId: "pm_tools" });
      yield* bridge.message({ connectionId, method: "initialize", params: initialize });
      yield* bridge.notification({ connectionId, method: "notifications/initialized" });
      const request = yield* bridge.message({ connectionId, method: "tools/call", params: { name: "fixture_wait" } }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(request);
      yield* bridge.disconnect({ connectionId });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects oversized MCP messages rather than sending them to the native host", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({ servers, cwd: process.cwd(), environment: {},
        assertCurrent: Effect.void, allocateConnectionId: Effect.succeed("bounded-connection") });
      yield* Effect.addFinalizer(() => bridge.dispose);
      const { connectionId } = yield* bridge.connect({ serverId: "pm_tools" });
      const failure = yield* bridge.message({ connectionId, method: "tools/call", params: { payload: "x".repeat(8 * 1024 * 1024) } }).pipe(Effect.flip);
      expect(failure.message).toContain("exceeds 8 MiB");
    }).pipe(Effect.scoped),
  );
});
