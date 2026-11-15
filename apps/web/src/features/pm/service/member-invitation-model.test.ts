import assert from "node:assert/strict"
import test from "node:test"
import { capabilityChanges, prepareInvitationBatch } from "./member-invitation-model.ts"

test("multi-address invitations normalize and deduplicate before assigning one stable command per recipient", () => {
  let sequence = 0
  const batch = prepareInvitationBatch({ emails: " First@example.test;second@example.test\nfirst@example.test ", role: "guest", projectIds: ["PRJ-001"], teamIds: ["team-a"] }, () => `command-${++sequence}`)
  assert.deepEqual(batch.map(attempt => [attempt.email, attempt.command.commandId, attempt.status]), [["first@example.test", "command-1", "ready"], ["second@example.test", "command-2", "ready"]])
  assert.equal(sequence, 2)
  assert.deepEqual(batch[0]!.command.payload, { email: "first@example.test", role: "guest", projectIds: ["PRJ-001"], teamIds: ["team-a"] })
  assert.equal(batch[0]!.command.commandType, "CreateMemberInvitation")
})

test("batch snapshots do not change when draft projects or teams change", () => {
  const projectIds = ["PRJ-001"]
  const teamIds = ["team-a"]
  const batch = prepareInvitationBatch({ emails: "one@example.test two@example.test", role: "member", projectIds, teamIds }, () => "original")
  projectIds.push("PRJ-002"); teamIds.length = 0
  assert.deepEqual(batch[0]!.command.payload.projectIds, ["PRJ-001"])
  assert.deepEqual(batch[1]!.command.payload.teamIds, ["team-a"])
  assert.notEqual(batch[0]!.command.payload.teamIds, batch[1]!.command.payload.teamIds)
})

test("invalid or oversized batches allocate no command identity and send no partial valid prefix", () => {
  for (const emails of ["", "valid@example.test invalid", Array.from({ length: 101 }, (_, index) => `member${index}@example.test`).join("\n")]) {
    let calls = 0
    assert.throws(() => prepareInvitationBatch({ emails, role: "guest", projectIds: null, teamIds: [] }, () => { calls++; return "never" }))
    assert.equal(calls, 0)
  }
})

test("capability preview shows removals as well as additions and preserves custom grant comparison", () => {
  assert.deepEqual(capabilityChanges(["domain.read", "delivery.review", "workitem.complete"], ["domain.read", "directory.read", "access.manage"]), { added: ["directory.read", "access.manage"], removed: ["delivery.review", "workitem.complete"], retained: ["domain.read"] })
  assert.deepEqual(capabilityChanges([], ["domain.read"]), { added: ["domain.read"], removed: [], retained: [] })
})
