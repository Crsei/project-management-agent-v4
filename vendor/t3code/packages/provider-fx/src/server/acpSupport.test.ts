import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { fxPermissionDisposition, withFxSessionMode } from "./acpSupport.ts";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });
});

it.effect("forces the first advertised FX mode through typed ACP v2 and avoids later redundant writes", () =>
  Effect.scoped(Effect.gen(function* () {
    const runtime = withFxSessionMode(yield* AcpSessionRuntime.AcpSessionRuntime);
    yield* runtime.start();
    const state = () => runtime.request("pm-test/mode-state", {});
    assert.deepEqual(yield* state(), { enforcedMode: "auto", writeCount: 0 });
    yield* runtime.setMode("ask");
    assert.deepEqual(yield* state(), { enforcedMode: "ask", writeCount: 1 });
    yield* runtime.setMode("ask");
    assert.deepEqual(yield* state(), { enforcedMode: "ask", writeCount: 1 });
    yield* runtime.setMode("auto");
    assert.deepEqual(yield* state(), { enforcedMode: "auto", writeCount: 2 });
  })).pipe(Effect.provide(
    AcpSessionRuntime.layer({
      cwd: process.cwd(),
      clientInfo: { name: "pm-mode-regression", version: "1" },
      spawn: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./testing/config-mode-peer.ts", import.meta.url))],
        cwd: process.cwd(),
      },
    }).pipe(Layer.provide(NodeServices.layer)),
  )),
);
