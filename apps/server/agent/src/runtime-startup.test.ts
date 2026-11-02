import { execFileSync } from "node:child_process";
import os from "node:os";
import test from "node:test";

const startupStages = ["migration", "providers", "chat", "connector-recovery", "execution", "automation", "studio", "workflows"] as const;

function runRuntimeScenario(scenario: string): void {
  // An isolated process enables Node's module seam without changing the suite's loader.
  // The real runtime owns ordering and races; dependencies expose controlled barriers.
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { setImmediate as nextTurn } from "node:timers/promises";
    const root = ${JSON.stringify(new URL("./", import.meta.url).href)};
    const startupStages = ${JSON.stringify(startupStages)};
    const starts = [];
    const events = [];
    const lateWork = [];
    const startBarriers = new Map();
    const stopBarriers = new Map();
    const startFailures = new Map();
    const stopFailures = new Map();
    const barrier = () => ({ entered: Promise.withResolvers(), release: Promise.withResolvers() });
    let fenced = false;
    const start = name => {
      starts.push(name);
      if (fenced) lateWork.push(name);
      if (startFailures.has(name)) throw startFailures.get(name);
      const held = startBarriers.get(name);
      if (held) { held.entered.resolve(); return held.release.promise; }
    };
    const stop = async name => {
      events.push("stop:" + name);
      const held = stopBarriers.get(name);
      if (held) { held.entered.resolve(); await held.release.promise; }
      events.push("stopped:" + name);
      if (stopFailures.has(name)) throw stopFailures.get(name);
    };
    const replace = (file, namedExports) => mock.module(new URL(file, root).href, { namedExports });
    replace("durable/chat-runtime.ts", { startChatRuntime: () => start("chat"), stopChatRuntime: () => stop("chat") });
    replace("durable/engine.ts", { startExecution: () => start("execution"), stopExecution: () => stop("execution") });
    replace("automation/index.ts", { startAutomation: () => start("automation"), stopAutomation: () => stop("automation") });
    replace("automation-execution/connectors.ts", { recoverAutomationGenerationConnectors: () => start("connector-recovery") });
    replace("automation-execution/index.ts", { startAutomationExecutionRuntime: () => start("studio"), stopAutomationExecutionRuntime: () => stop("studio") });
    replace("task-workflows/runner.ts", { startTaskWorkflows: () => start("workflows"), stopTaskWorkflows: () => stop("workflows") });
    replace("durable/store.ts", { getDatabase: () => ({}), closeStore: () => events.push("close:store") });
    replace("providers/instances.ts", { migrateProviderStartupState: () => start("migration") });
    replace("providers/t3code/production.ts", { providerApplicationOptions: {} });
    replace("providers/t3code/application.ts", {
      startPmProviderApplication: () => start("providers"), stopPmProviderApplication: () => stop("providers"),
      stopPmProviderMaintenance: () => { fenced = true; return stop("maintenance"); },
    });
    // Static import would load the runtime before its lifecycle dependencies are mocked.
    const { startRuntime, stopRuntime } = await import(new URL("runtime.ts", root).href);
    const assertBefore = (earlier, later) => {
      assert.notEqual(events.indexOf(earlier), -1, earlier + " must occur");
      assert.ok(events.indexOf(earlier) < events.indexOf(later), earlier + " must precede " + later);
    };
    const assertDrained = () => {
      const components = ["maintenance", "workflows", "automation", "studio", "execution", "chat", "providers"];
      assert.deepEqual(events.filter(event => event.startsWith("stop:")).map(event => event.slice(5)).sort(), [...components].sort());
      assertBefore("stop:maintenance", "stop:workflows");
      for (const name of ["automation", "studio", "execution", "chat"]) assertBefore("stopped:workflows", "stop:" + name);
      for (const name of ["execution", "chat"]) assertBefore("stopped:studio", "stop:" + name);
      for (const name of components.filter(name => name !== "providers")) assertBefore("stopped:" + name, "stop:providers");
      assertBefore("stopped:providers", "close:store");
      assert.equal(events.filter(event => event === "close:store").length, 1);
      assert.equal(events.at(-1), "close:store");
    };
    ${scenario}
  `;
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script], {
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
}

for (const held of startupStages.filter(stage => stage !== "workflows")) {
  test(`shutdown during ${held} startup prevents later workers from admitting work`, () => {
    runRuntimeScenario(`
      const held = ${JSON.stringify(held)};
      const startup = barrier();
      startBarriers.set(held, startup);
      const starting = startRuntime();
      await startup.entered.promise;
      const stopping = stopRuntime();
      assert.equal(fenced, true);
      assert.deepEqual(events, ["stop:maintenance", "stopped:maintenance"], "workers must not drain before startup settles");
      startup.release.resolve();
      await Promise.all([starting, stopping]);
      assert.deepEqual(starts, startupStages.slice(0, startupStages.indexOf(held) + 1));
      assert.deepEqual(lateWork, [], "shutdown must not admit work in a later startup stage");
      assertDrained();
    `);
  });
}

test("combined runtime drains workflow and automation producers before workers, providers, and store", () => {
  runRuntimeScenario(`
    await startRuntime();
    assert.deepEqual(starts, startupStages);
    for (const name of ["maintenance", "workflows", "automation", "studio", "execution", "chat", "providers"]) stopBarriers.set(name, barrier());
    const stopping = stopRuntime();
    assert.equal(fenced, true);
    assert.equal(stopRuntime(), stopping, "concurrent shutdown shares the drain");
    await stopBarriers.get("workflows").entered.promise;
    assert.equal(events.includes("stop:automation"), false);
    assert.equal(events.includes("stop:studio"), false);
    stopBarriers.get("workflows").release.resolve();
    await Promise.all(["automation", "studio"].map(name => stopBarriers.get(name).entered.promise));
    stopBarriers.get("automation").release.resolve();
    await nextTurn();
    assert.equal(events.includes("stop:execution"), false);
    assert.equal(events.includes("stop:chat"), false);
    stopBarriers.get("studio").release.resolve();
    await Promise.all(["execution", "chat"].map(name => stopBarriers.get(name).entered.promise));
    stopBarriers.get("execution").release.resolve();
    await nextTurn();
    assert.equal(events.includes("stop:providers"), false);
    stopBarriers.get("chat").release.resolve();
    await nextTurn();
    assert.equal(events.includes("stop:providers"), false, "maintenance must drain before providers close");
    assert.equal(events.includes("close:store"), false);
    stopBarriers.get("maintenance").release.resolve();
    await stopBarriers.get("providers").entered.promise;
    assert.equal(events.includes("close:store"), false, "the store stays open while providers drain");
    stopBarriers.get("providers").release.resolve();
    await stopping;
    assertDrained();
  `);
});

for (const failedStartup of [null, "connector-recovery", "studio", "workflows"] as const) {
  test(`${failedStartup ? `${failedStartup} startup failure` : "runtime shutdown"} aggregates failures without skipping cleanup`, () => {
    runRuntimeScenario(`
      const failedStartup = ${JSON.stringify(failedStartup)};
      const startupFailure = new Error("startup failed");
      const cleanupOrder = failedStartup
        ? ["workflows", "studio", "automation", "execution", "chat", "maintenance", "providers"]
        : ["workflows", "automation", "studio", "execution", "chat", "maintenance", "providers"];
      for (const name of cleanupOrder) stopFailures.set(name, new Error(name + " cleanup failed"));
      if (failedStartup) startFailures.set(failedStartup, startupFailure);
      else await startRuntime();
      await assert.rejects(failedStartup ? startRuntime() : stopRuntime(), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [
          ...(failedStartup ? [startupFailure] : []),
          ...cleanupOrder.map(name => stopFailures.get(name)),
        ]);
        return true;
      });
      assert.deepEqual(starts, failedStartup ? startupStages.slice(0, startupStages.indexOf(failedStartup) + 1) : startupStages);
      assertDrained();
    `);
  });
}

test("startup failure preserves its original error when every component drains successfully", () => {
  runRuntimeScenario(`
    const failure = new Error("workflow startup failed");
    startFailures.set("workflows", failure);
    await assert.rejects(startRuntime(), error => error === failure);
    assertDrained();
  `);
});
