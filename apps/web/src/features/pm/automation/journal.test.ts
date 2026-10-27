import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createAutomationJournal, emptyConfig, isDirty, type PendingRequest } from "./journal.ts"

function installBrowser(t: TestContext) {
  const values = new Map<string, string>()
  let failWrites = false
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://automation.test" } } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota_exceeded"); values.set(key, value) },
  } })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "sessionStorage")
  })
  return { values, failWrites: () => { failWrites = true } }
}
function pendingRequest(): PendingRequest {
  return { requestId: "7c86bccc-2cf4-4d7c-a302-096742fb0ce9", kind: "create", ruleId: null, expectedRevision: null, config: { ...emptyConfig(), name: "Original request", projectId: "PRJ-001" }, status: null, startedAt: "2026-10-26T00:00:00.000Z" }
}

test("frozen original request and stale draft survive refresh without becoming business records", t => {
  installBrowser(t)
  const journal = createAutomationJournal("actor-a", "workspace-a", 3)
  const baseline = { ...emptyConfig(), name: "Original", projectId: "PRJ-001" }
  const config = { ...baseline, name: "Unsaved revision" }
  assert.equal(journal.setDraft("rule-a", { config, baseline, expectedRevision: 2 }), true)
  const pending = pendingRequest()
  assert.equal(journal.freeze(pending), true)
  const restored = createAutomationJournal("actor-a", "workspace-a", 3).getSnapshot()
  assert.deepEqual(restored.pending, pending)
  assert.equal(restored.drafts["rule-a"]?.expectedRevision, 2)
  assert.equal(isDirty(restored.drafts["rule-a"]!), true)
  assert.equal(journal.freeze({ ...pending, requestId: "969ed859-b9a3-4585-ae5c-ef7296462727" }), false)
})

test("actor and workspace storage scopes do not cross", t => {
  installBrowser(t)
  const journal = createAutomationJournal("actor-a", "workspace-a", 1)
  journal.freeze(pendingRequest())
  assert.equal(createAutomationJournal("actor-b", "workspace-a", 1).getSnapshot().pending, null)
  assert.equal(createAutomationJournal("actor-a", "workspace-b", 1).getSnapshot().pending, null)
})

test("membership and epoch cutovers hide old draft payloads but retain original request identity", t => {
  installBrowser(t)
  const journal = createAutomationJournal("actor-a", "workspace-a", 1)
  const config = { ...emptyConfig(), projectId: "PRJ-001", name: "Private draft" }
  journal.setDraft("new", { config, baseline: emptyConfig(), expectedRevision: null })
  journal.freeze(pendingRequest())
  const membershipCutover = createAutomationJournal("actor-a", "workspace-a", 2).getSnapshot()
  assert.deepEqual(membershipCutover.drafts, {})
  assert.equal(membershipCutover.pending?.requestId, pendingRequest().requestId)
  assert.equal(membershipCutover.pending?.config, null)
  const epochCutover = createAutomationJournal("actor-a", "workspace-a", 1, false).getSnapshot()
  assert.deepEqual(epochCutover.drafts, {})
  assert.equal(epochCutover.pending?.config, null)
})

test("explicit revocation clears private contents in memory and persisted recovery", t => {
  installBrowser(t)
  const journal = createAutomationJournal("actor-a", "workspace-a", 1)
  const config = { ...emptyConfig(), projectId: "PRJ-001", name: "Private draft" }
  journal.setDraft("new", { config, baseline: emptyConfig(), expectedRevision: null })
  journal.freeze(pendingRequest())
  journal.revoke()
  assert.deepEqual(journal.getSnapshot().drafts, {})
  const restored = createAutomationJournal("actor-a", "workspace-a", 1).getSnapshot()
  assert.deepEqual(restored.drafts, {})
  assert.equal(restored.pending?.config, null)
  assert.equal(restored.pending?.requestId, pendingRequest().requestId)
})

test("storage failure cannot authorize a write or drop an unresolved request", t => {
  const storage = installBrowser(t)
  const journal = createAutomationJournal("actor-a", "workspace-a", 1)
  journal.freeze(pendingRequest())
  storage.failWrites()
  assert.equal(journal.settle(), false)
  assert.equal(journal.getSnapshot().pending?.requestId, pendingRequest().requestId)
  assert.equal(journal.getSnapshot().storageError, true)
  const other = createAutomationJournal("actor-a", "workspace-b", 1)
  assert.equal(other.freeze(pendingRequest()), false)
  assert.equal(other.getSnapshot().pending, null)
})

test("corrupt recovery is never erased to unblock replacement requests", t => {
  const storage = installBrowser(t)
  const key = "pm-automation:https://automation.test:actor-a:workspace-a"
  storage.values.set(key, '{"pending":{"requestId":"original-key-with-damaged-payload"}}')
  const journal = createAutomationJournal("actor-a", "workspace-a", 1)
  assert.equal(journal.getSnapshot().storageError, true)
  assert.equal(journal.retryStorage(), false)
  assert.equal(journal.freeze(pendingRequest()), false)
  assert.equal(storage.values.get(key), '{"pending":{"requestId":"original-key-with-damaged-payload"}}')
})
