import { execFileSync } from "node:child_process";
import os from "node:os";
import test from "node:test";

for (const held of ["chat", "execution"] as const) {
  test(`shutdown during ${held} startup prevents later workers from admitting work`, () => {
    // An isolated process enables Node's module seam without changing the suite's loader.
    // The real runtime owns the start/stop race; worker dependencies expose controlled
    // startup barriers and record work admitted after the maintenance fence.
    const script = `
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      const root = ${JSON.stringify(new URL("./", import.meta.url).href)};
      const held = ${JSON.stringify(held)};
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const lateWork = [];
      let fenced = false;
      const start = async name => {
        if (fenced) lateWork.push(name);
        if (name === held) { entered.resolve(); await release.promise; }
      };
      const replace = (file, namedExports) => mock.module(new URL(file, root).href, { namedExports });
      replace("durable/chat-runtime.ts", { startChatRuntime: () => start("chat"), stopChatRuntime: async () => {} });
      replace("durable/engine.ts", { startExecution: () => start("execution"), stopExecution: async () => {} });
      replace("automation/index.ts", { startAutomation: () => start("automation"), stopAutomation: async () => {} });
      replace("durable/store.ts", { getDatabase: () => ({}), closeStore: () => {} });
      replace("providers/instances.ts", { migrateProviderStartupState: async () => {} });
      replace("providers/t3code/production.ts", { providerApplicationOptions: {} });
      replace("providers/t3code/application.ts", {
        startPmProviderApplication: async () => {}, stopPmProviderApplication: async () => {},
        stopPmProviderMaintenance: async () => { fenced = true; },
      });
      const { startRuntime, stopRuntime } = await import(new URL("runtime.ts", root).href);
      const starting = startRuntime();
      await entered.promise;
      const stopping = stopRuntime();
      assert.equal(fenced, true);
      release.resolve();
      await Promise.all([starting, stopping]);
      assert.deepEqual(lateWork, [], "shutdown must not admit work in a later startup stage");
    `;
    execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script], {
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"],
    });
  });
}
