import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react"
import { useParams, useSearchParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { CalendarClock, Check, ChevronRight, CirclePause, FileClock, LockKeyhole, Play, Plus, RefreshCw, Search, Trash2, Workflow, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { AutomationClient } from "../../../../../../packages/contracts/src/automation-client"
import { automationCapabilitiesSchema, automationPreviewSchema, type AutomationConfig, type AutomationRule } from "../../../../../../packages/contracts/src/automation"
import { usePmEntities, usePmService, usePrivateQuery } from "../service/pm-service"
import { allowed, string, useText } from "../service/pm-ui"
import { pmKeys } from "../service/pm-data"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { readAllRules, readAutomation } from "./data"
import { createAutomationJournal, emptyConfig, isDirty, type PendingRequest, type RuleDraft } from "./journal"
import { useAutomationActions } from "./use-automation-actions"
import { useLeaveProtection } from "./use-leave-protection"
import { RuleEditor } from "./rule-editor"
import { AutomationHistory } from "./history"
import styles from "./automation.module.css"
import theme from "./automation-theme.module.css"
import "./automation-colors.css"

type Confirmation = { kind: "remove" | "run"; rule: AutomationRule } | { kind: "status"; rule: AutomationRule; status: "enabled" } | { kind: "reset" | "rebase"; rule: AutomationRule | null }

/** The route owns no account/workspace store and never substitutes fixture data. */
export function AutomationsPage() {
  const service = usePmService()
  const t = useText()
  const identity = `${service.actor?.id}:${service.actorEpoch}:${service.workspace?.id}:${service.workspace?.version}`
  const latestIdentity = useRef(identity)
  latestIdentity.current = identity
  const previousAuthorizedIdentity = useRef<string | null>(null)
  const restoreDrafts = previousAuthorizedIdentity.current === null || previousAuthorizedIdentity.current === identity
  useEffect(() => { if (service.actor && service.workspace) previousAuthorizedIdentity.current = identity }, [identity, service.actor, service.workspace])
  if (service.loading) return <p role="status" className={`${theme.theme} ${styles.sessionNotice}`}>{t("正在读取会话…", "Reading session…")}</p>
  if (!service.actor || !service.workspace) return <section className={`${theme.theme} ${styles.sessionNotice}`} role="alert"><h1>{t("自动化暂不可访问", "Automations unavailable")}</h1><p>{t("请登录并选择工作区。", "Sign in and select a workspace.")}</p></section>
  if (!service.workspace.capabilities.includes("domain.read")) return <p className={`${theme.theme} ${styles.sessionNotice}`} role="alert">{t("没有项目读取权限。", "Project read access required.")}</p>
  return <AutomationWorkspace key={identity} identity={identity} latestIdentity={latestIdentity} restoreDrafts={restoreDrafts} />
}
function AutomationWorkspace({ identity, latestIdentity, restoreDrafts }: { identity: string; latestIdentity: MutableRefObject<string>; restoreDrafts: boolean }) {
  const service = usePmService()
  const { actor, workspace } = service
  const t = useText()
  const display = useDisplayDateTime()
  const queryClient = useQueryClient()
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const [params, setParams] = useSearchParams()
  const root = `/pm/${encodeURIComponent(workspaceSlug || workspace!.id)}`
  const ruleId = params.get("rule")
  const runId = params.get("run")
  const view = params.get("view") === "history" || runId ? "history" : "rules"
  const [api] = useState(() => new AutomationClient(workspace!.id))
  const [journal] = useState(() => createAutomationJournal(actor!.id, workspace!.id, workspace!.version, restoreDrafts))
  const snapshot = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot)
  const [initialConfig] = useState(emptyConfig)
  const [query, setQuery] = useState("")
  const [savedNavigationOpen, setSavedNavigationOpen] = useState(() => window.matchMedia("(min-width: 761px)").matches)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [accessLost, setAccessLost] = useState(false)
  const alive = useRef(false)
  const accessLostRef = useRef(false)
  const key = useMemo(() => [...pmKeys.workspace(window.location.origin, actor!.id, workspace!.id), "automations"], [actor, workspace])
  const revoke = useCallback(() => {
    if (!alive.current || accessLostRef.current) return
    accessLostRef.current = true
    journal.revoke()
    setConfirmation(null)
    setAccessLost(true)
    void queryClient.cancelQueries({ queryKey: key })
    queryClient.removeQueries({ queryKey: key })
    void service.refresh().catch(() => undefined)
  }, [journal, key, queryClient, service.refresh])
  const capabilities = usePrivateQuery([...key, "capabilities"], "domain.read", undefined, (_client, _workspace, signal) => readAutomation(async () => automationCapabilitiesSchema.parse(await api.capabilities({ signal })), revoke), !accessLost)
  const rules = usePrivateQuery([...key, "rules"], "domain.read", undefined, (_client, _workspace, signal) => readAutomation(() => readAllRules(api, signal), revoke), !accessLost)
  const projects = usePmEntities("project")
  const allRules = rules.data ?? []
  const allProjects = projects.data ?? []
  const availableProjects = allProjects.filter(item => !item.data.archivedAt && !["completed", "cancelled"].includes(string(item.data.status)))
  const editorId = ruleId ?? "new"
  const selectedRule = allRules.find(rule => rule.id === editorId) ?? null
  const draft: RuleDraft | null = editorId === "new" ? snapshot.drafts.new ?? { config: initialConfig, baseline: initialConfig, expectedRevision: null } : selectedRule ? snapshot.drafts[selectedRule.id] ?? { config: selectedRule.config, baseline: selectedRule.config, expectedRevision: selectedRule.revision } : null
  const ready = !accessLost && !!capabilities.data && !!rules.data && !!projects.data && !capabilities.error && !rules.error && !projects.error
  const reportReady = capabilities.data?.actions.some(action => action.id === "report" && action.available) === true
  const manageableFor = (projectId: string) => ready && capabilities.data?.canWrite === true && allowed(workspace, "planning.edit", projectId)
  const writableFor = (projectId: string) => manageableFor(projectId) && availableProjects.some(item => item.id === projectId)
  const actions = useAutomationActions(api, journal, result => {
    setConfirmation(null)
    void queryClient.invalidateQueries({ queryKey: key })
    const next = new URLSearchParams(params)
    if (result.run) { next.set("view", "history"); next.set("run", result.run.id); next.set("historyRule", result.run.ruleId) }
    else if (result.kind === "create" && result.rule) { next.set("rule", result.rule.id); next.delete("run"); next.delete("view") }
    else if (result.kind === "remove" && ruleId === result.ruleId) next.delete("rule")
    setParams(next, { replace: true })
  }, revoke, () => !accessLostRef.current && latestIdentity.current === identity)
  const locked = actions.busy || rules.isFetching || !!snapshot.pending || snapshot.storageError
  const hasDrafts = Object.values(snapshot.drafts).some(isDirty)
  useLeaveProtection(hasDrafts || !!snapshot.pending || snapshot.storageError, t("有未保存草稿或待核对请求，确定离开？", "Unsaved drafts or an unresolved request remain. Leave this page?"))
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; if (latestIdentity.current !== identity) journal.revoke() }
  }, [identity, journal, latestIdentity])
  useEffect(() => { if (projects.error && "status" in projects.error && [401, 403, 404].includes(Number(projects.error.status))) revoke() }, [projects.error, revoke])
  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)")
    const syncNavigation = () => setSavedNavigationOpen(media.matches)
    media.addEventListener("change", syncNavigation)
    return () => media.removeEventListener("change", syncNavigation)
  }, [])
  function navigate(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [name, value] of Object.entries(patch)) { if (value === null) next.delete(name); else next.set(name, value) }
    setParams(next)
  }
  function openRule(id: string) {
    setConfirmation(null)
    if (!window.matchMedia("(min-width: 761px)").matches) setSavedNavigationOpen(false)
    navigate({ rule: id, view: null, run: null })
  }
  function refresh() { void capabilities.refetch(); void rules.refetch(); void projects.refetch() }
  function confirm() {
    if (!confirmation || locked) return
    if (confirmation.kind === "reset") {
      const id = confirmation.rule?.id ?? "new"
      journal.removeDraft(id); setConfirmation(null); return
    }
    if (confirmation.kind === "rebase") {
      if (draft && confirmation.rule) journal.setDraft(confirmation.rule.id, { ...draft, baseline: confirmation.rule.config, expectedRevision: confirmation.rule.revision })
      setConfirmation(null); return
    }
    const rule = confirmation.rule
    if (!rule) return
    if (!(confirmation.kind === "remove" ? manageableFor(rule.config.projectId) : writableFor(rule.config.projectId))) return
    const input: Omit<PendingRequest, "requestId" | "startedAt"> = { kind: confirmation.kind, ruleId: rule.id, expectedRevision: rule.revision, config: null, status: confirmation.kind === "status" ? confirmation.status : null }
    setConfirmation(null)
    void actions.execute(input)
  }
  const filtered = allRules.filter(rule => `${rule.config.name} ${rule.config.description} ${rule.config.projectId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const changedDraft = (rule: AutomationRule) => !!snapshot.drafts[rule.id] && isDirty(snapshot.drafts[rule.id]!)
  const enableReady = !!selectedRule && reportReady && (selectedRule.config.trigger.kind !== "daily" || capabilities.data?.scheduler.ready === true)
  function saveDraft(config: AutomationConfig) {
    if (locked || !draft || !writableFor(config.projectId)) return
    if (selectedRule) {
      if (draft.expectedRevision === null || draft.expectedRevision !== selectedRule.revision || !writableFor(selectedRule.config.projectId)) return
      void actions.execute({ kind: "update", ruleId: selectedRule.id, expectedRevision: draft.expectedRevision, config, status: null })
    } else if (editorId === "new") void actions.execute({ kind: "create", ruleId: null, expectedRevision: null, config, status: null })
  }
  function pauseRule(rule: AutomationRule) {
    if (locked || !manageableFor(rule.config.projectId)) return
    void actions.execute({ kind: "status", ruleId: rule.id, expectedRevision: rule.revision, config: null, status: "paused" })
  }
  const savedRuleActions = selectedRule && <>
    <Button type="button" variant="ghost" size="sm" aria-label={t("查看规则历史", "View rule history")} onClick={() => navigate({ view: "history", historyRule: selectedRule.id, run: null })}><FileClock size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId)} aria-label={t("删除规则", "Delete rule")} onClick={() => setConfirmation({ kind: "remove", rule: selectedRule })}><Trash2 size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId) || (selectedRule.status !== "enabled" && (!writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !enableReady))} title={selectedRule.status !== "enabled" && !enableReady ? t("报告或后台调度未就绪。", "Reports or scheduler unavailable.") : changedDraft(selectedRule) && selectedRule.status !== "enabled" ? t("请先保存或放弃修改。", "Save or discard changes first.") : undefined} onClick={() => selectedRule.status === "enabled" ? pauseRule(selectedRule) : setConfirmation({ kind: "status", rule: selectedRule, status: "enabled" })}>
      {selectedRule.status === "enabled" ? <CirclePause size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}{selectedRule.status === "enabled" ? t("暂停", "Pause") : t("启用", "Enable")}
    </Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !reportReady} title={changedDraft(selectedRule) ? t("请先保存或放弃修改。", "Save or discard changes first.") : undefined} onClick={() => setConfirmation({ kind: "run", rule: selectedRule })}><Play size={14} aria-hidden="true" />{t("运行", "Run")}</Button>
  </>
  return <main data-pm-route-page className={`${theme.theme} ${styles.page} ${view === "history" ? styles.historyPage : ""}`}>
    {view === "rules" && <aside className={styles.navigation} aria-label={t("自动化导航", "Automation navigation")}>
      <div className={styles.navigationHeading}><span>{t("自动化", "Automations")}</span><Button variant="ghost" size="sm" aria-label={t("新建规则", "New rule")} disabled={!ready || locked || !availableProjects.some(item => writableFor(item.id))} onClick={() => openRule("new")}><Plus size={16} aria-hidden="true" /></Button></div>
      <nav className={styles.viewNavigation} aria-label={t("自动化视图", "Automation views")}>
        <button type="button" className={styles.activeNavigation} aria-current="page" onClick={() => navigate({ view: null, run: null })}><Workflow size={15} aria-hidden="true" /><span>{t("自动化", "Automations")}</span></button>
        <button type="button" onClick={() => navigate({ view: "history", run: null })}><FileClock size={15} aria-hidden="true" /><span>{t("运行历史", "Run history")}</span></button>
      </nav>
      <details className={styles.savedNavigation} open={savedNavigationOpen} onToggle={event => setSavedNavigationOpen(event.currentTarget.open)}>
        <summary>{t("已保存规则", "Saved automations")}</summary>
        {ready && <>
          {!!allRules.length && <label className={styles.search}><Search size={14} aria-hidden="true" /><Input aria-label={t("搜索规则", "Search rules")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索规则", "Search rules")} /></label>}
          <ul className={styles.savedRules}>{filtered.map(rule => <li key={rule.id}><button type="button" className={editorId === rule.id ? styles.activeNavigation : ""} aria-current={editorId === rule.id ? "page" : undefined} title={rule.config.name} onClick={() => openRule(rule.id)}>{rule.config.trigger.kind === "daily" ? <CalendarClock size={15} aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />}<span>{rule.config.name}</span>{changedDraft(rule) && <small>{t("草稿", "Draft")}</small>}</button></li>)}</ul>
          {!filtered.length && <p className={styles.navigationEmpty}>{allRules.length ? t("没有匹配规则", "No matching rules") : t("暂无规则", "No saved automations")}</p>}
          {!!snapshot.drafts.new && isDirty(snapshot.drafts.new) && <button type="button" className={styles.unsavedNavigation} onClick={() => openRule("new")}><Plus size={15} aria-hidden="true" />{t("未保存草稿", "Unsaved draft")}</button>}
        </>}
      </details>
      <span className={styles.privateLabel}><LockKeyhole size={12} aria-hidden="true" />{t("仅本人可见", "Private to you")}</span>
    </aside>}
    <section className={styles.content} aria-label={view === "history" ? t("运行历史", "Run history") : t("规则编辑", "Rule editor")}>
      <header className={styles.contentHeader}><nav className={styles.breadcrumb} aria-label={t("当前位置", "Breadcrumb")}>{view === "history" ? <button type="button" aria-label={t("返回自动化", "Back to automations")} onClick={() => navigate({ view: null, run: null })}>{t("自动化", "Automations")}</button> : <span>{t("自动化", "Automations")}</span>}<ChevronRight size={12} aria-hidden="true" /><span aria-current="page">{view === "history" ? t("运行历史", "Run history") : selectedRule?.config.name || (editorId === "new" ? t("新建规则", "New automation") : t("规则不可用", "Rule unavailable"))}</span></nav>{view === "rules" && <Button variant="ghost" size="sm" aria-label={t("刷新自动化", "Refresh automations")} disabled={capabilities.isFetching || rules.isFetching || projects.isFetching || accessLost} onClick={refresh}><RefreshCw size={14} aria-hidden="true" /></Button>}</header>
      <div className={view === "history" ? styles.historyContent : styles.editorContent}>
        {ready && capabilities.data?.canWrite === false && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />{t("只读模式", "Read-only mode")}</p>}
        {snapshot.storageError && <section className={styles.warning} role="alert"><p>{t("恢复存储不可用，写入已暂停。原请求仍保留。", "Recovery storage unavailable. Writes are paused; the original request is retained.")}</p><Button variant="outline" size="sm" onClick={() => journal.retryStorage()}>{t("重试恢复", "Retry recovery")}</Button></section>}
        {snapshot.pending && !accessLost && <section className={styles.warning} aria-live="polite"><strong>{actions.busy ? t("正在提交或核对…", "Submitting or reconciling…") : t("原请求待核对", "Original request unresolved")}</strong><p>{t("只查询原收据，不会重复保存或运行。", "Only the original receipt is checked. Saves and runs are not replayed.")}</p><code className={styles.breakAll}>{snapshot.pending.requestId}</code><Button variant="outline" size="sm" disabled={actions.busy} onClick={() => { void actions.reconcile() }}>{t("查询原收据", "Check original receipt")}</Button></section>}
        {!accessLost && actions.error && <p role="alert" className={styles.errorBlock}>{actions.error}</p>}
        {!accessLost && actions.notice && <p role="status" className={styles.successNotice}><Check size={15} aria-hidden="true" />{actions.notice}</p>}
        {accessLost ? <section className={styles.empty} role="alert"><LockKeyhole size={24} aria-hidden="true" /><h1>{t("来源或授权已不可用", "Source or access unavailable")}</h1><p>{t("私有数据与草稿已清空，原请求 ID 保留。", "Private data and drafts cleared. The original request ID is retained.")}</p><Button variant="outline" onClick={() => { void service.refresh().then(() => { if (alive.current) { accessLostRef.current = false; setAccessLost(false) } }).catch(() => undefined) }}>{t("重新读取授权", "Recheck access")}</Button></section> : <>
          {(capabilities.isPending || rules.isPending || projects.isPending) && <p className={styles.loading} role="status">{t("正在读取自动化…", "Loading automations…")}</p>}
          {(capabilities.error || rules.error || projects.error) && <section className={styles.errorBlock} role="alert"><p>{t("读取失败，写入已暂停，草稿版本未变。", "Loading failed. Writes are paused; draft revisions are unchanged.")}</p><Button variant="outline" size="sm" onClick={refresh}>{t("重试", "Retry")}</Button></section>}
          {ready && view === "history" && <AutomationHistory api={api} queryKey={key} rules={allRules} root={root} ruleId={params.get("historyRule") ?? ""} runId={runId} onFilter={id => navigate({ historyRule: id || null, run: null, view: "history" })} onSelect={id => navigate({ run: id, view: "history" })} onRule={openRule} onAccessFailure={revoke} />}
          {ready && view === "rules" && (draft ? <>
            <RuleEditor
              key={editorId}
              draft={draft}
              rule={selectedRule}
              projects={allProjects.filter(item => !item.data.archivedAt)}
              capabilities={capabilities.data}
              writable={writableFor(draft.config.projectId) && (!selectedRule || writableFor(selectedRule.config.projectId))}
              readable={allowed(workspace, "domain.read", draft.config.projectId)}
              locked={locked}
              root={root}
              actions={savedRuleActions}
              onClose={() => { if (isDirty(draft)) setConfirmation({ kind: "reset", rule: selectedRule }); else navigate({ rule: null }) }}
              onChange={next => journal.setDraft(editorId, next)}
              onSave={saveDraft}
              onReset={() => setConfirmation({ kind: "reset", rule: selectedRule })}
              onRebase={() => setConfirmation({ kind: "rebase", rule: selectedRule })}
              test={(config, signal) => readAutomation(async () => automationPreviewSchema.parse(await api.test(config, { signal })), revoke)}
            />
            {selectedRule && <dl className={styles.ruleTiming}><div><dt>{t("上次运行", "Last run")}</dt><dd>{selectedRule.lastRunAt ? <time dateTime={selectedRule.lastRunAt}>{display.date(selectedRule.lastRunAt)} {display.time(selectedRule.lastRunAt)}</time> : t("尚未运行", "Not run yet")}</dd></div><div><dt>{t("下次检查", "Next check")}</dt><dd>{selectedRule.nextDueAt ? <time dateTime={selectedRule.nextDueAt}>{display.date(selectedRule.nextDueAt)} {display.time(selectedRule.nextDueAt)}</time> : selectedRule.config.trigger.kind === "manual" ? t("仅手动", "Manual only") : t("未安排", "Not scheduled")}</dd></div></dl>}
          </> : <section className={styles.empty}><LockKeyhole size={24} aria-hidden="true" /><h1>{t("规则不存在或不可访问", "Rule missing or inaccessible")}</h1><p>{!!snapshot.drafts[editorId] && isDirty(snapshot.drafts[editorId]!) ? t("未保存草稿已保留，当前不能保存。", "Unsaved draft retained. Saving is unavailable.") : t("未切换到其他规则。", "No other rule was substituted.")}</p><Button variant="outline" onClick={() => navigate({ view: "history", historyRule: editorId, run: null })}>{t("查看原规则历史", "View original rule history")}</Button></section>)}
        </>}
      </div>
    </section>
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open && !locked) setConfirmation(null) }}>
      <AlertDialogContent className={theme.theme}>
        <AlertDialogTitle className={styles.confirmTitle}>{confirmation?.kind === "remove" ? t("删除规则？", "Delete rule?") : confirmation?.kind === "run" ? t("运行一次？", "Run once?") : confirmation?.kind === "status" ? t("启用规则？", "Enable rule?") : confirmation?.kind === "reset" ? t("放弃未保存修改？", "Discard unsaved changes?") : t("采用当前版本？", "Adopt current revision?")}</AlertDialogTitle>
        <AlertDialogDescription className={styles.confirmDescription}>{confirmation?.kind === "remove" ? t("停止调度并删除规则，运行历史保留。", "Delete the rule and stop scheduling. Run history is retained.") : confirmation?.kind === "run" ? t("按已保存配置生成只读报告，计入运行预算。", "Generate a read-only report from saved configuration. This counts toward the run budget.") : confirmation?.kind === "status" ? t("启用不会立即运行。每日规则将在下次到期时检查。", "Enabling does not run immediately. Daily rules are checked when next due.") : confirmation?.kind === "reset" ? t("未保存修改将被丢弃。", "Unsaved changes will be discarded.") : t("保留草稿内容，采用当前版本后仍需保存。", "Keep draft content with the current revision. Saving is still required.")}</AlertDialogDescription>
        {confirmation?.rule && <div className={styles.confirmScope}><strong>{confirmation.rule.config.name}</strong><span>{confirmation.rule.config.projectId} / v{confirmation.rule.revision}</span></div>}
        <div className={styles.confirmActions}><Button variant="outline" disabled={locked} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</Button><Button variant={confirmation?.kind === "remove" ? "destructive" : "default"} disabled={locked} onClick={confirm}>{confirmation?.kind === "remove" ? t("删除规则", "Delete rule") : confirmation?.kind === "run" ? t("运行一次", "Run once") : confirmation?.kind === "status" ? t("启用", "Enable") : t("确认", "Confirm")}</Button></div>
      </AlertDialogContent>
    </AlertDialog>
  </main>
}
