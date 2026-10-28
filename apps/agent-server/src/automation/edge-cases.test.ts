import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceRun } from "@agent-workspace/contracts/workspace";
import type { AutomationRunTemplate } from "@agent-workspace/contracts/automation";
import { AutomationService, type AutomationEngine, type AutomationStore } from "./service.ts";
import type { GitHubSnapshot } from "./github.ts";

function isolatedService() {
  const data = new Map<string, unknown>();
  const store: AutomationStore = {
    readRecord<T>(namespace: string, key: string): T | null {
      return structuredClone(data.get(`${namespace}:${key}`) ?? null) as T | null;
    },
    writeRecord(namespace, key, value) {
      data.set(`${namespace}:${key}`, structuredClone(value));
    },
    deleteRecord(namespace, key) {
      data.delete(`${namespace}:${key}`);
    },
    listRecords<T>(namespace: string): T[] {
      return [...data]
        .filter(([key]) => key.startsWith(`${namespace}:`))
        .map(([, value]) => structuredClone(value) as T);
    },
    transaction(fn) {
      return fn();
    },
  };
  const run: WorkspaceRun = {
    id: "quota",
    name: "Quota",
    threadId: "thread",
    kind: "agent",
    input: "Work",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    errorClass: "usage_limit",
    resetAt: "2026-01-01T00:01:00.000Z",
    providerInstanceId: "account",
    providerInstanceRevision: 1,
    steps: [],
  };
  const template: AutomationRunTemplate = {
    threadId: "thread",
    name: "Work",
    kind: "agent",
    input: "Work",
    context: "",
    temperature: 0,
    steps: [
      {
        id: "s",
        name: "Step",
        model: "m",
        system: "",
        instruction: "Work",
        providerInstanceId: "account",
      },
    ],
  };
  let submitted = 0;
  const engine: AutomationEngine = {
    async submitRun(request) {
      submitted += 1;
      return { ...run, id: request.runId, status: "queued" };
    },
    getRun(id) {
      return id === run.id ? run : null;
    },
    getRunRequest() {
      return { ...template, runId: run.id };
    },
    listRuns() {
      return [run];
    },
    async continueRun() {
      throw new Error("No continuation expected");
    },
  };
  return { store, engine, run, template, submitted: () => submitted };
}

test("provider changed before opt-in and unknown failure revision are both rejected", () => {
  const f = isolatedService();
  const service = new AutomationService({
    store: f.store,
    engine: f.engine,
    github: {
      async read() {
        throw new Error("No reads expected");
      },
    },
    providerIdentity: () => "account:2",
    now: () => Date.parse("2026-01-01T00:00:30.000Z"),
  });
  assert.throws(() => service.setRecovery(f.run.id, true), /Provider/);
  f.run.providerInstanceRevision = undefined;
  assert.throws(() => service.setRecovery(f.run.id, true), /版本未知/);
  assert.deepEqual(service.recoveries(), []);
});

test("stop invalidates an in-flight poll before any late snapshot can wake a run", async () => {
  const f = isolatedService();
  const { promise, resolve } = Promise.withResolvers<GitHubSnapshot>();
  const service = new AutomationService({
    store: f.store,
    engine: f.engine,
    github: { read: () => promise },
    providerIdentity: () => "account:1",
    now: () => Date.parse("2026-01-01T00:00:30.000Z"),
    id: () => "watch",
  });
  const watch = service.saveWatch({
    name: "Watch",
    owner: "owner",
    repo: "repo",
    number: 1,
    enabled: true,
    pollIntervalSeconds: 60,
    request: f.template,
  });
  const checking = service.checkWatch(watch.id);
  const stopping = service.stop();
  resolve({
    headSha: "head",
    state: "open",
    events: [
      { kind: "comment", key: "c1", signature: "new", actor: "human", text: "New feedback" },
    ],
  });
  await Promise.all([checking, stopping]);
  assert.equal(f.submitted(), 0);
  assert.equal(service.watches()[0].headSha, null);
  assert.equal(service.watches()[0].lastCheckedAt, null);
});
