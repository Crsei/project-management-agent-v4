import { useEffect, useRef, useState } from "react"
import { AutomationApiError, type AutomationClient } from "../../../../../../packages/contracts/src/automation-client"
import { automationRuleSchema, automationRunSchema, type AutomationRule, type AutomationRun } from "../../../../../../packages/contracts/src/automation"
import { useText } from "../service/pm-ui"
import { isDirty, type AutomationJournal, type PendingRequest } from "./journal"

type Settled = { kind: PendingRequest["kind"]; rule: AutomationRule | null; run: AutomationRun | null; ruleId: string | null }
export function useAutomationActions(api: AutomationClient, journal: AutomationJournal, onSettled: (result: Settled) => void, onAccessFailure: () => void, isCurrentSession: () => boolean) {
  const t = useText()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const running = useRef(false)
  const alive = useRef(false)
  const settledRef = useRef(onSettled)
  const accessRef = useRef(onAccessFailure)
  const currentRef = useRef(isCurrentSession)
  settledRef.current = onSettled
  accessRef.current = onAccessFailure
  currentRef.current = isCurrentSession
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  function accept(pending: PendingRequest, value: unknown) {
    if (!alive.current || !currentRef.current()) return
    if (value && typeof value === "object" && "error" in value && "httpStatus" in value) {
      const rejected = value as { error?: { message?: unknown }; httpStatus?: unknown }
      if (typeof rejected.httpStatus !== "number" || typeof rejected.error?.message !== "string") throw new Error("invalid_receipt")
      journal.settle()
      setError(rejected.error.message)
      if ([401, 403, 404].includes(rejected.httpStatus)) accessRef.current()
      return
    }
    let rule: AutomationRule | null = null
    let run: AutomationRun | null = null
    if (pending.kind === "run") {
      run = automationRunSchema.parse(value)
      if (run.ruleId !== pending.ruleId) throw new Error("receipt_identity_mismatch")
    } else if (pending.kind === "remove") {
      if (!value || typeof value !== "object" || !("deleted" in value) || value.deleted !== true) throw new Error("invalid_receipt")
    } else {
      rule = automationRuleSchema.parse(value)
      if (pending.ruleId && rule.id !== pending.ruleId) throw new Error("receipt_identity_mismatch")
    }
    if (!journal.settle()) {
      setError(t("结果已读取，恢复存储不可写。原请求保留，请恢复后再次核对。", "Result read; recovery storage is not writable. Restore storage and recheck the retained request."))
      return
    }
    if (pending.kind === "create") journal.removeDraft("new")
    if (pending.kind === "remove" && pending.ruleId) journal.removeDraft(pending.ruleId)
    const currentDraft = rule ? journal.getSnapshot().drafts[rule.id] : undefined
    if (rule && (pending.kind === "create" || pending.kind === "update" || (pending.kind === "status" && (!currentDraft || !isDirty(currentDraft))))) {
      journal.setDraft(rule.id, { config: rule.config, baseline: rule.config, expectedRevision: rule.revision })
    }
    setNotice(pending.kind === "run" ? t("运行已记录。", "Run recorded.") : pending.kind === "remove" ? t("规则已删除，历史保留。", "Rule deleted. History retained.") : t("规则已保存。", "Rule saved."))
    settledRef.current({ kind: pending.kind, rule, run, ruleId: pending.ruleId })
  }
  async function readReceipt(pending: PendingRequest) {
    try {
      const receipt = await api.receipt(pending.requestId)
      if (!alive.current || !currentRef.current()) return
      if (receipt.requestId !== pending.requestId) throw new Error("receipt_identity_mismatch")
      accept(pending, receipt.result)
    } catch (cause) {
      if (!alive.current || !currentRef.current()) return
      if (cause instanceof AutomationApiError && [401, 403].includes(cause.status)) accessRef.current()
      setError(cause instanceof AutomationApiError && cause.status === 404
        ? t("尚无可访问的原收据，结果仍未知。原请求保留，不会重发。", "Original receipt unavailable; outcome unknown. The original request is retained and will not be replayed.")
        : t("原请求仍待核对，请稍后再查。", "Original request unresolved. Check again later."))
    }
  }
  async function reconcile() {
    const pending = journal.getSnapshot().pending
    if (!pending || running.current || !currentRef.current()) return
    running.current = true; setBusy(true); setError("")
    try { await readReceipt(pending) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function execute(input: Omit<PendingRequest, "requestId" | "startedAt">) {
    if (running.current || !currentRef.current() || journal.getSnapshot().pending || journal.getSnapshot().storageError) return
    const pending: PendingRequest = { ...input, requestId: crypto.randomUUID(), startedAt: new Date().toISOString() }
    if (!journal.freeze(pending)) return
    running.current = true; setBusy(true); setError(""); setNotice("")
    try {
      let value: unknown
      if (pending.kind === "create" && pending.config) value = await api.create(pending.requestId, pending.config)
      else if (pending.ruleId && pending.expectedRevision !== null) {
        if (pending.kind === "update" && pending.config) value = await api.update(pending.ruleId, pending.requestId, pending.expectedRevision, pending.config)
        else if (pending.kind === "status" && pending.status) value = await api.setStatus(pending.ruleId, pending.requestId, pending.expectedRevision, pending.status)
        else if (pending.kind === "remove") value = await api.remove(pending.ruleId, pending.requestId, pending.expectedRevision)
        else if (pending.kind === "run") value = await api.run(pending.ruleId, pending.requestId, pending.expectedRevision)
        else throw new Error("invalid_frozen_request")
      } else throw new Error("invalid_frozen_request")
      accept(pending, value)
    } catch (cause) {
      if (!alive.current || !currentRef.current()) return
      if (cause instanceof AutomationApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.code !== "idempotency_conflict") {
        journal.settle()
        setError(cause.message)
        if ([401, 403, 404].includes(cause.status)) accessRef.current()
      } else {
        setError(t("响应未确认，正在查询原收据，不会重发。", "Response unconfirmed. Checking the original receipt without replaying."))
        await readReceipt(pending)
      }
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile
  // Refresh recovery performs a GET only. The frozen request is never dispatched again.
  useEffect(() => { if (journal.getSnapshot().pending) void reconcileRef.current() }, [journal])
  return { busy, error, notice, execute, reconcile }
}
