import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AutomationSchedule, PullRequestWatch } from "@agent-workspace/contracts/automation";

test("automation CRUD routes validate input and persist schedules/watches through SQLite reopen without executing models", async () => {
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-automation-routes-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
  // Exercise the module-loading boundary after isolating server storage/credential environment.
  const { automationRoutes, stopAutomation } = await import("./index.ts");
  const { closeStore } = await import("../durable/store.ts");
  const request = (url: string, method = "GET", body?: unknown) =>
    automationRoutes.request(`http://localhost${url}`, {
      method,
      headers: { host: "localhost", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const template = {
      threadId: "route-thread",
      name: "Captured",
      kind: "agent",
      input: "Inspect",
      context: "",
      temperature: 0.4,
      steps: [
        { id: "step", name: "Step", model: "not-a-real-model", system: "", instruction: "Inspect" },
      ],
    };
    const scheduleInput = {
      name: "Daily",
      enabled: true,
      timing: { type: "fixed_time", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      missedPolicy: "skip",
      request: template,
    };
    assert.equal(
      (
        await request("/automation/schedules", "POST", {
          ...scheduleInput,
          timing: { type: "interval", minutes: 0 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await automationRoutes.request("http://localhost/automation/schedules", {
          method: "POST",
          body: "not-json",
        })
      ).status,
      400,
    );
    const created = await request("/automation/schedules", "POST", scheduleInput);
    assert.equal(created.status, 201);
    const { schedule } = (await created.json()) as { schedule: AutomationSchedule };
    assert.ok(schedule.nextRunAt);
    assert.ok(schedule.timeZone);
    assert.equal(schedule.lastDispatch, undefined);
    const pausedResponse = await request(`/automation/schedules/${schedule.id}`, "PUT", {
      ...scheduleInput,
      enabled: false,
    });
    assert.equal(pausedResponse.status, 200);
    const { schedule: paused } = (await pausedResponse.json()) as { schedule: AutomationSchedule };
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    assert.equal(paused.revision, schedule.revision + 1);
    const watchInput = {
      name: "Review",
      owner: "owner",
      repo: "repo",
      number: 1,
      enabled: false,
      pollIntervalSeconds: 60,
      request: template,
    };
    const createdWatch = await request("/automation/watches", "POST", watchInput);
    assert.equal(createdWatch.status, 201);
    const { watch } = (await createdWatch.json()) as { watch: PullRequestWatch };
    assert.equal(watch.status, "paused");
    assert.equal((await request(`/automation/watches/${watch.id}/check`, "POST")).status, 200);
    assert.equal(
      (await request(`/automation/schedules/${schedule.id}/run`, "POST", { idempotencyKey: "" }))
        .status,
      400,
    );
    assert.equal(
      (await request("/automation/recovery/does-not-exist", "PUT", { enabled: true })).status,
      404,
    );
    assert.equal(
      (await request("/automation/recovery/does-not-exist", "PUT", { enabled: "yes" })).status,
      400,
    );
    closeStore();
    const schedules = (await (await request("/automation/schedules")).json()) as {
      schedules: AutomationSchedule[];
      timeZone: string;
    };
    const watches = (await (await request("/automation/watches")).json()) as {
      watches: PullRequestWatch[];
    };
    assert.equal(schedules.schedules.length, 1);
    assert.equal(schedules.schedules[0].enabled, false);
    assert.equal(schedules.schedules[0].request.input, template.input);
    assert.equal(watches.watches[0].id, watch.id);
    assert.deepEqual(await (await request("/automation/dispatches")).json(), { dispatches: [] });
    assert.deepEqual(await (await request("/automation/recovery")).json(), { recoveries: [] });
    assert.equal((await request(`/automation/schedules/${schedule.id}`, "DELETE")).status, 204);
    assert.equal((await request(`/automation/watches/${watch.id}`, "DELETE")).status, 204);
    assert.equal((await request(`/automation/watches/${watch.id}`, "DELETE")).status, 404);
  } finally {
    await stopAutomation();
    closeStore();
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
