import assert from "node:assert/strict";
import test from "node:test";
import { createSidebarVisitCoordinator } from "./sidebar-visit.ts";

test("panel and full Chat remount share an in-flight visit and the next visit reads the new revision", async () => {
  let revision = 4;
  const writes: number[] = [];
  const gate = Promise.withResolvers<void>();
  const visit = createSidebarVisitCoordinator(
    async () => ({ sidebar: { revision } }),
    async (_threadId, expected) => {
      writes.push(expected);
      if (writes.length === 1) await gate.promise;
      assert.equal(expected, revision);
      return { sidebar: { revision: ++revision } };
    },
  );
  const panel = visit("same-thread");
  const full = visit("same-thread");
  assert.equal(panel, full);
  gate.resolve();
  assert.equal((await panel).sidebar.revision, 5);
  assert.equal((await full).sidebar.revision, 5);
  assert.equal((await visit("same-thread")).sidebar.revision, 6);
  assert.deepEqual(writes, [4, 5]);
});

test("a genuine concurrent sidebar conflict remains visible and is not retried", async () => {
  let writes = 0;
  const conflict = new Error("sidebar_conflict");
  const visit = createSidebarVisitCoordinator(
    async () => ({ sidebar: { revision: 7 } }),
    async () => { writes++; throw conflict; },
  );
  await assert.rejects(visit("thread"), error => error === conflict);
  assert.equal(writes, 1);
});
