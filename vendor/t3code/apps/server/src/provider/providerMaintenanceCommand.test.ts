import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/process";
import { runProviderMaintenanceCommandWithSpawner, splitOutputLines, toProgressLine } from "./providerMaintenanceCommand.ts";

it("extracted source command utility preserves bounded progress and chunk line handling", () => {
  assert.deepEqual(splitOutputLines("Down", "loading\r\n 5"), { lines: ["Downloading"], partialLine: " 5" });
  assert.equal(toProgressLine("\u001b[1m==>\u001b[0m  Pouring"), "==> Pouring");
  assert.equal(toProgressLine(" \t "), null);
  assert.equal(splitOutputLines("x".repeat(5000), "y").partialLine.length, 4096);
  assert.equal(toProgressLine("x".repeat(300))?.length, 200);
});
it("extracted source command utility returns the real exit status and bounds both streams", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* runProviderMaintenanceCommandWithSpawner({ spawner, command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(12000)); process.stderr.write('update rejected'); process.exitCode = 7;"] });
  }).pipe(Effect.provide(NodeServices.layer)));
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.length, 10000);
  assert.equal(result.stderr, "update rejected");
});
