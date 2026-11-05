import assert from "node:assert/strict"
import test from "node:test"
import { parseSetupResponse, parseSetupStatus, setupEntryState, setupWorkspaceId } from "./pm-first-use-model.ts"

const prepared = { initialized: false, setupAllowed: true, registrationMode: "invite_only" } as const
const initialized = { initialized: true, setupAllowed: false, registrationMode: "invite_only" } as const
const firstWorkspace = "63d855c1-e5bb-4cda-b393-389fe4689a68"
const otherWorkspace = "f7b459ac-81f7-4f1e-9c73-c48daa404705"

test("only a prepared empty instance with a confirmed anonymous session permits setup", () => {
  assert.equal(setupEntryState(parseSetupStatus(prepared), "anonymous"), "ready")
  assert.equal(setupEntryState(parseSetupStatus({ ...prepared, setupAllowed: false }), "anonymous"), "unprepared")
  assert.equal(setupEntryState(prepared, "unknown"), "unknown")
  assert.equal(setupEntryState(prepared, "authenticated"), "unknown")
})

test("old or concurrently initialized instances always use normal sign-in", () => {
  for (const session of ["anonymous", "authenticated", "unknown"] as const) {
    assert.equal(setupEntryState(parseSetupStatus(initialized), session), "initialized")
  }
})

test("a failed or malformed status is never interpreted as an empty instance", () => {
  for (const value of [null, {}, { error: { code: "temporarily_unavailable" } }, { ...prepared, initialized: "false" }, { ...prepared, registrationMode: "public" }]) {
    assert.throws(() => parseSetupStatus(value))
  }
  assert.throws(() => parseSetupStatus({ ...initialized, setupAllowed: true }))
})

test("a received setup success cannot be undone by a contradictory status read", () => {
  assert.equal(setupEntryState(prepared, "anonymous", true), "unknown")
  assert.equal(setupEntryState({ ...prepared, setupAllowed: false }, "anonymous", true), "unknown")
  assert.equal(setupEntryState(initialized, "anonymous", true), "initialized")
})

test("setup response requires the real account and workspace identifiers", () => {
  const response = {
    actor: { id: "b689b18f-ebf0-4426-b8fa-53c34aaeb9ab", email: "owner@example.com", name: "Owner" },
    workspaceId: firstWorkspace,
    expiresAt: "2026-11-04T16:00:00.000Z",
  }
  assert.deepEqual(parseSetupResponse(response), response)
  assert.throws(() => parseSetupResponse({ ...response, actor: { id: response.actor.id } }))
  assert.throws(() => parseSetupResponse({ ...response, workspaceId: "default" }))
  assert.throws(() => parseSetupResponse({ ...response, setupToken: "unexpected secret" }))
})

test("confirmed setup enters only its currently authorized workspace", () => {
  assert.equal(setupWorkspaceId([{ id: otherWorkspace }, { id: firstWorkspace }], firstWorkspace), firstWorkspace)
  assert.equal(setupWorkspaceId([{ id: otherWorkspace }], firstWorkspace), null)
})

test("lost setup response may select one actual workspace but never an ambiguous directory", () => {
  assert.equal(setupWorkspaceId([{ id: firstWorkspace }], null), firstWorkspace)
  assert.equal(setupWorkspaceId([{ id: firstWorkspace }, { id: otherWorkspace }], null), null)
})

test("no workspace access remains a real empty state without a default workspace", () => {
  assert.equal(setupWorkspaceId([], null), null)
  assert.equal(setupWorkspaceId([], firstWorkspace), null)
})
