import assert from "node:assert/strict"
import test from "node:test"
import {
  clearResolvedNotices,
  dismissNotice,
  markAllNoticesRead,
  PM_NOTICE_LIMIT,
  resolveNotice,
  sortNotices,
  unreadNoticeCount,
  upsertNotice,
  type PmNotice,
} from "./pm-notice-center-model.ts"


test("upserting the same key keeps identity and read state", () => {
  const first = upsertNotice([], { key: "offline", severity: "warning", title: "Offline", detail: "last snapshot", source: "shell", sticky: true }, 10, "n1")
  const read = markAllNoticesRead(first, 11)
  const second = upsertNotice(read, { key: "offline", severity: "warning", title: "Offline", detail: "last snapshot", source: "shell", sticky: true }, 12, "n1")
  assert.equal(second.length, 1)
  assert.equal(second[0]?.id, "n1")
  assert.equal(second[0]?.createdAt, 10)
  assert.equal(second[0]?.updatedAt, 12)
  assert.equal(second[0]?.readAt, 11)
  assert.equal(unreadNoticeCount(second), 1)
})

test("a changed notice becomes unread and a resolved notice reopens", () => {
  const first = upsertNotice([], { key: "stream", severity: "warning", title: "Interrupted" }, 10, "n1")
  const read = markAllNoticesRead(first, 11)
  const changed = upsertNotice(read, { key: "stream", severity: "error", title: "Interrupted" }, 12, "n1")
  assert.equal(changed[0]?.readAt, null)
  assert.equal(changed[0]?.resolvedAt, null)
  const resolved = resolveNotice(changed, "stream", 13)
  assert.equal(resolved[0]?.resolvedAt, 13)
  assert.equal(unreadNoticeCount(resolved), 0)
  const reopened = upsertNotice(resolved, { key: "stream", severity: "warning", title: "Interrupted" }, 14, "n1")
  assert.equal(reopened[0]?.resolvedAt, null)
  assert.equal(reopened[0]?.readAt, null)
  assert.equal(reopened[0]?.createdAt, 10)
})

test("silent read status does not badge and transient status disappears on resolve", () => {
  const loading = upsertNotice([], { key: "reading", severity: "info", title: "Reading", silent: true, transient: true }, 10, "n1")
  assert.equal(unreadNoticeCount(loading), 0)
  assert.equal(resolveNotice(loading, "reading", 11).length, 0)
})

test("sticky unresolved notices cannot be dismissed; resolved ones can", () => {
  const first = upsertNotice([], { key: "offline", severity: "warning", title: "Offline", sticky: true }, 10, "n1")
  assert.equal(dismissNotice(first, "n1").length, 1)
  const resolved = resolveNotice(first, "offline", 11)
  assert.equal(dismissNotice(resolved, "n1").length, 0)
})

test("clear resolved keeps active problems", () => {
  const active = upsertNotice([], { key: "offline", severity: "warning", title: "Offline", sticky: true }, 10, "n1")
  const done = upsertNotice(active, { key: "saved", severity: "success", title: "Saved" }, 11, "n2")
  const resolved = resolveNotice(done, "saved", 12)
  const cleared = clearResolvedNotices(resolved)
  assert.deepEqual(cleared.map(notice => notice.key), ["offline"])
})

test("sort puts unresolved notices before resolved notices", () => {
  const activeOld = upsertNotice([], { key: "active", severity: "warning", title: "Active" }, 1, "n1")
  const resolvedNew = resolveNotice(upsertNotice(activeOld, { key: "done", severity: "success", title: "Done" }, 2, "n2"), "done", 3)
  assert.deepEqual(sortNotices(resolvedNew).map(notice => notice.key), ["active", "done"])
})

test("the cap removes the oldest resolved notices first", () => {
  let notices: PmNotice[] = []
  for (let index = 0; index < PM_NOTICE_LIMIT; index += 1) {
    notices = upsertNotice(notices, { key: `n-${index}`, severity: "success", title: String(index) }, index, `id-${index}`)
  }
  notices = resolveNotice(notices, "n-0", PM_NOTICE_LIMIT)
  notices = upsertNotice(notices, { key: "overflow", severity: "error", title: "overflow" }, PM_NOTICE_LIMIT + 1, "overflow")
  assert.equal(notices.length, PM_NOTICE_LIMIT)
  assert.equal(notices.some(notice => notice.key === "n-0"), false)
  assert.equal(notices.some(notice => notice.key === "overflow"), true)
})
