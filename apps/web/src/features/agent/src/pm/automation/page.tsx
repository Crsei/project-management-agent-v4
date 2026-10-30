import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, CalendarClock, Check, ChevronRight, CirclePause, FileClock, LockKeyhole, Play, Plus, RefreshCw, Search, Trash2, Workflow, Zap } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Input } from "@agent/components/ui/input";
import { AutomationClient } from "../../../../../../../../packages/contracts/src/automation-client";
import { automationCapabilitiesSchema, automationPreviewSchema, type AutomationConfig, type AutomationRule } from "../../../../../../../../packages/contracts/src/automation";
import type { Entity, EntityPage, Workspace } from "../../../../../../../../packages/contracts/src/client";
import { pmJson, PmApiError } from "../state";
import { readAllRules, readAutomation } from "./data";
import { createAutomationJournal, emptyConfig, isDirty, type PendingRequest, type RuleDraft } from "./journal";
import { useAutomationActions } from "./actions";
import { useAutomationLeaveProtection } from "./leave-protection";
import { useAutomationQuery } from "./query";
import { RuleEditor } from "./editor";
import { AutomationHistory } from "./history";
import { automationDateTime } from "./format";
import { useAgentText } from "../../i18n";
import styles from "./automation.module.css";
import "./theme.css";

type Confirmation = { kind: "remove" | "run"; rule: AutomationRule } | { kind: "status"; rule: AutomationRule; status: "enabled" } | { kind: "reset" | "rebase"; rule: AutomationRule | null };

async function readProjects(workspaceId: string, signal: AbortSignal): Promise<Entity[]> {
  const items = new Map<string, Entity>();
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    signal.throwIfAborted();
    const query = new URLSearchParams({ kind: "project", limit: "100" });
    if (after) query.set("after", after);
    const page = await pmJson<EntityPage>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?${query.toString()}`, { signal });
    for (const item of page.items) items.set(item.id, item);
    after = page.nextCursor ?? undefined;
    if (after && seen.has(after)) throw new Error("invalid_pagination_cursor");
    if (after) seen.add(after);
  } while (after);
  return [...items.values()];
}

type AutomationPageProps = { workspace: Workspace; actorId: string; root: string; onExit: () => void; onRecheckAccess: () => void; onLeaveGuardChange?: (guard: (() => boolean) | null) => void };

/** PM-owned automation rules and run history, hosted inside the Agent Chat shell. */
export function AutomationPage({ workspace, actorId, root, onExit, onRecheckAccess, onLeaveGuardChange }: AutomationPageProps) {
  const t = useAgentText();
  const [api] = useState(() => new AutomationClient(workspace.id));
  const [journal] = useState(() => createAutomationJournal(actorId, workspace.id, workspace.version, true));
  const snapshot = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot);
  const [dataVersion, setDataVersion] = useState(0);
  const [accessLost, setAccessLost] = useState(false);
  const accessLostRef = useRef(false);
  const [view, setView] = useState<"rules" | "history">("rules");
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [historyRuleId, setHistoryRuleId] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [savedNavigationOpen, setSavedNavigationOpen] = useState(() => window.matchMedia("(min-width: 761px)").matches);
  const pageRef = useRef<HTMLDivElement>(null);
  const compactNavigation = useRef<boolean | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [initialConfig] = useState(emptyConfig);

  const revoke = useCallback(() => {
    if (accessLostRef.current) return;
    accessLostRef.current = true;
    journal.revoke();
    setConfirmation(null);
    setAccessLost(true);
  }, [journal]);

  const capabilities = useAutomationQuery(`capabilities:${dataVersion}`, signal => readAutomation(async () => automationCapabilitiesSchema.parse(await api.capabilities({ signal })), revoke), !accessLost);
  const rules = useAutomationQuery(`rules:${dataVersion}`, signal => readAutomation(() => readAllRules(api, signal), revoke), !accessLost);
  const projects = useAutomationQuery(`projects:${dataVersion}`, signal => readProjects(workspace.id, signal).catch((error: unknown) => {
    if (error instanceof PmApiError && [401, 403, 404].includes(error.status)) revoke();
    throw error;
  }), !accessLost);
  const allRules = rules.data ?? [];
  const allProjects = projects.data ?? [];
  const availableProjects = allProjects.filter(item => !item.data.archivedAt && !["completed", "cancelled"].includes(typeof item.data.status === "string" ? item.data.status : ""));
  const editorId = selectedRuleId ?? "new";
  const selectedRule = allRules.find(rule => rule.id === editorId) ?? null;
  const draft: RuleDraft | null = editorId === "new"
    ? snapshot.drafts.new ?? { config: initialConfig, baseline: initialConfig, expectedRevision: null }
    : selectedRule ? snapshot.drafts[selectedRule.id] ?? { config: selectedRule.config, baseline: selectedRule.config, expectedRevision: selectedRule.revision } : null;
  const ready = !accessLost && !!capabilities.data && !!rules.data && !!projects.data && !capabilities.error && !rules.error && !projects.error;
  const reportReady = capabilities.data?.actions.some(action => action.id === "report" && action.available) === true;
  const allowed = (capability: string, projectId?: string | null) => workspace.capabilities.includes(capability) && (workspace.projectIds === null || (!!projectId && workspace.projectIds.includes(projectId)));
  const manageableFor = (projectId: string) => ready && capabilities.data?.canWrite === true && allowed("planning.edit", projectId);
  const writableFor = (projectId: string) => manageableFor(projectId) && availableProjects.some(item => item.id === projectId);

  const actions = useAutomationActions(api, journal, result => {
    setConfirmation(null);
    setDataVersion(value => value + 1);
    if (result.run) { setView("history"); setRunId(result.run.id); setHistoryRuleId(result.run.ruleId); }
    else if (result.kind === "create" && result.rule) { setSelectedRuleId(result.rule.id); setView("rules"); setRunId(null); }
    else if (result.kind === "remove" && selectedRuleId === result.ruleId) setSelectedRuleId(null);
  }, revoke, () => !accessLostRef.current);

  const locked = actions.busy || rules.loading || !!snapshot.pending || snapshot.storageError;
  const hasDrafts = Object.values(snapshot.drafts).some(isDirty);
  const needsLeaveConfirmation = hasDrafts || !!snapshot.pending || snapshot.storageError;
  const leaveMessage = t("有未保存草稿或待核对请求，确定离开？", "You have unsaved drafts or an unverified request. Leave anyway?");
  useAutomationLeaveProtection(needsLeaveConfirmation, leaveMessage);
  const leaveState = useRef({ active: needsLeaveConfirmation, message: leaveMessage });
  leaveState.current = { active: needsLeaveConfirmation, message: leaveMessage };
  useEffect(() => {
    onLeaveGuardChange?.(() => !leaveState.current.active || window.confirm(leaveState.current.message));
    return () => onLeaveGuardChange?.(null);
  }, [onLeaveGuardChange]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const syncNavigation = () => {
      const compact = page.clientWidth <= 760;
      if (compactNavigation.current === compact) return;
      compactNavigation.current = compact;
      setSavedNavigationOpen(!compact);
    };
    syncNavigation();
    const observer = new ResizeObserver(syncNavigation);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  function openRule(id: string) {
    setConfirmation(null);
    if (compactNavigation.current) setSavedNavigationOpen(false);
    setSelectedRuleId(id === "new" ? null : id);
    setView("rules");
    setRunId(null);
  }
  function openHistory(rule = historyRuleId, run: string | null = null) {
    setHistoryRuleId(rule);
    setRunId(run);
    setView("history");
  }
  function refresh() { capabilities.refetch(); rules.refetch(); projects.refetch(); }
  function confirm() {
    if (!confirmation || locked) return;
    if (confirmation.kind === "reset") {
      const id = confirmation.rule?.id ?? "new";
      journal.removeDraft(id); setConfirmation(null); return;
    }
    if (confirmation.kind === "rebase") {
      if (draft && confirmation.rule) journal.setDraft(confirmation.rule.id, { ...draft, baseline: confirmation.rule.config, expectedRevision: confirmation.rule.revision });
      setConfirmation(null); return;
    }
    const rule = confirmation.rule;
    if (!rule) return;
    if (!(confirmation.kind === "remove" ? manageableFor(rule.config.projectId) : writableFor(rule.config.projectId))) return;
    const input: Omit<PendingRequest, "requestId" | "startedAt"> = { kind: confirmation.kind, ruleId: rule.id, expectedRevision: rule.revision, config: null, status: confirmation.kind === "status" ? confirmation.status : null };
    setConfirmation(null);
    void actions.execute(input);
  }
  const filtered = allRules.filter(rule => `${rule.config.name} ${rule.config.description} ${rule.config.projectId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const changedDraft = (rule: AutomationRule) => !!snapshot.drafts[rule.id] && isDirty(snapshot.drafts[rule.id]!);
  const enableReady = !!selectedRule && reportReady && (selectedRule.config.trigger.kind !== "daily" || capabilities.data?.scheduler.ready === true);
  function saveDraft(config: AutomationConfig) {
    if (locked || !draft || !writableFor(config.projectId)) return;
    if (selectedRule) {
      if (draft.expectedRevision === null || draft.expectedRevision !== selectedRule.revision || !writableFor(selectedRule.config.projectId)) return;
      void actions.execute({ kind: "update", ruleId: selectedRule.id, expectedRevision: draft.expectedRevision, config, status: null });
    } else if (editorId === "new") void actions.execute({ kind: "create", ruleId: null, expectedRevision: null, config, status: null });
  }
  function pauseRule(rule: AutomationRule) {
    if (locked || !manageableFor(rule.config.projectId)) return;
    void actions.execute({ kind: "status", ruleId: rule.id, expectedRevision: rule.revision, config: null, status: "paused" });
  }
  const savedRuleActions = selectedRule && <>
    <Button type="button" variant="ghost" size="sm" aria-label={t("查看规则历史", "View rule history")} onClick={() => openHistory(selectedRule.id)}><FileClock size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId)} aria-label={t("删除规则", "Delete rule")} onClick={() => setConfirmation({ kind: "remove", rule: selectedRule })}><Trash2 size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId) || (selectedRule.status !== "enabled" && (!writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !enableReady))} title={selectedRule.status !== "enabled" && !enableReady ? t("报告或后台调度未就绪。", "Reports or the background scheduler are not ready.") : changedDraft(selectedRule) && selectedRule.status !== "enabled" ? t("请先保存或放弃修改。", "Save or discard your changes first.") : undefined} onClick={() => selectedRule.status === "enabled" ? pauseRule(selectedRule) : setConfirmation({ kind: "status", rule: selectedRule, status: "enabled" })}>
      {selectedRule.status === "enabled" ? <CirclePause size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}{selectedRule.status === "enabled" ? t("暂停", "Pause") : t("启用", "Enable")}
    </Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !reportReady} title={changedDraft(selectedRule) ? t("请先保存或放弃修改。", "Save or discard your changes first.") : undefined} onClick={() => setConfirmation({ kind: "run", rule: selectedRule })}><Play size={14} aria-hidden="true" />{t("运行", "Run")}</Button>
  </>;

  return <div ref={pageRef} className={`pm-automation ${styles.page} ${view === "history" ? styles.historyPage : ""}`}>
    {view === "rules" && <aside className={styles.navigation} aria-label={t("自动化导航", "Automation navigation")}>
      <div className={styles.navigationHeading}><span>{t("自动化", "Automation")}</span><Button variant="ghost" size="sm" aria-label={t("新建规则", "New rule")} disabled={!ready || locked || !availableProjects.some(item => writableFor(item.id))} onClick={() => openRule("new")}><Plus size={16} aria-hidden="true" /></Button></div>
      <nav className={styles.viewNavigation} aria-label={t("自动化视图", "Automation views")}>
        <button type="button" className={styles.activeNavigation} aria-current="page" onClick={() => { setView("rules"); setRunId(null); }}><Workflow size={15} aria-hidden="true" /><span>{t("自动化", "Automation")}</span></button>
        <button type="button" onClick={() => openHistory()}><FileClock size={15} aria-hidden="true" /><span>{t("运行历史", "Run history")}</span></button>
      </nav>
      <details className={styles.savedNavigation} open={savedNavigationOpen} onToggle={event => setSavedNavigationOpen(event.currentTarget.open)}>
        <summary>{t("已保存规则", "Saved rules")}</summary>
        {ready && <>
          {!!allRules.length && <label className={styles.search}><Search size={14} aria-hidden="true" /><Input aria-label={t("搜索规则", "Search rules")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索规则", "Search rules")} /></label>}
          <ul className={styles.savedRules}>{filtered.map(rule => <li key={rule.id}><button type="button" className={editorId === rule.id ? styles.activeNavigation : ""} aria-current={editorId === rule.id ? "page" : undefined} title={rule.config.name} onClick={() => openRule(rule.id)}>{rule.config.trigger.kind === "daily" ? <CalendarClock size={15} aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />}<span>{rule.config.name}</span>{changedDraft(rule) && <small>{t("草稿", "Draft")}</small>}</button></li>)}</ul>
          {!filtered.length && <p className={styles.navigationEmpty}>{allRules.length ? t("没有匹配规则", "No matching rules") : t("暂无规则", "No rules yet")}</p>}
          {!!snapshot.drafts.new && isDirty(snapshot.drafts.new) && <button type="button" className={styles.unsavedNavigation} onClick={() => openRule("new")}><Plus size={15} aria-hidden="true" />{t("未保存草稿", "Unsaved draft")}</button>}
        </>}
      </details>
      <span className={styles.privateLabel}><LockKeyhole size={12} aria-hidden="true" />{t("仅本人可见", "Visible only to you")}</span>
    </aside>}
    <section className={styles.content} aria-label={view === "history" ? t("运行历史", "Run history") : t("规则编辑", "Rule editing")}>
      <header className={styles.contentHeader}>
        <nav className={styles.breadcrumb} aria-label={t("当前位置", "Breadcrumb")}>
          <Button variant="ghost" size="sm" onClick={onExit}><ArrowLeft size={14} aria-hidden="true" />{t("对话", "Chat")}</Button>
          {view === "history" ? <button type="button" aria-label={t("返回自动化", "Back to automation")} onClick={() => { setView("rules"); setRunId(null); }}>{t("自动化", "Automation")}</button> : <span>{t("自动化", "Automation")}</span>}
          <ChevronRight size={12} aria-hidden="true" />
          <span aria-current="page">{view === "history" ? t("运行历史", "Run history") : selectedRule?.config.name || (editorId === "new" ? t("新建规则", "New rule") : t("规则不可用", "Rule unavailable"))}</span>
        </nav>
        {view === "rules" && <Button variant="ghost" size="sm" aria-label={t("刷新自动化", "Refresh automation")} disabled={capabilities.loading || rules.loading || projects.loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" /></Button>}
      </header>
      <div className={view === "history" ? styles.historyContent : styles.editorContent}>
        {ready && capabilities.data?.canWrite === false && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />{t("只读模式", "Read-only mode")}</p>}
        {snapshot.storageError && <section className={styles.warning} role="alert"><p>{t("恢复存储不可用，写入已暂停。原请求仍保留。", "Recovery storage is unavailable; writes are paused. The original request is kept.")}</p><Button variant="outline" size="sm" onClick={() => journal.retryStorage()}>{t("重试恢复", "Retry recovery")}</Button></section>}
        {snapshot.pending && !accessLost && <section className={styles.warning} aria-live="polite"><strong>{actions.busy ? t("正在提交或核对…", "Submitting or verifying…") : t("原请求待核对", "Original request awaiting verification")}</strong><p>{t("只查询原收据，不会重复保存或运行。", "Only the original receipt is queried; nothing is saved or run again.")}</p><code className={styles.breakAll}>{snapshot.pending.requestId}</code><Button variant="outline" size="sm" disabled={actions.busy} onClick={() => { void actions.reconcile(); }}>{t("查询原收据", "Check original receipt")}</Button></section>}
        {!accessLost && actions.error && <p role="alert" className={styles.errorBlock}>{actions.error}</p>}
        {!accessLost && actions.notice && <p role="status" className={styles.successNotice}><Check size={15} aria-hidden="true" />{actions.notice}</p>}
        {accessLost ? <section className={styles.empty} role="alert"><LockKeyhole size={24} aria-hidden="true" /><h1>{t("来源或授权已不可用", "Source or authorization is no longer available")}</h1><p>{t("私有数据与草稿已清空，原请求 ID 保留。", "Private data and drafts were cleared; the original request ID is kept.")}</p><Button variant="outline" onClick={() => { onRecheckAccess(); accessLostRef.current = false; setAccessLost(false); setDataVersion(value => value + 1); }}>{t("重新读取授权", "Recheck authorization")}</Button></section> : <>
          {(capabilities.loading || rules.loading || projects.loading) && <p className={styles.loading} role="status">{t("正在读取自动化…", "Loading automation…")}</p>}
          {(capabilities.error || rules.error || projects.error) && <section className={styles.errorBlock} role="alert"><p>{t("读取失败，写入已暂停，草稿版本未变。", "Loading failed; writes are paused and draft revisions are unchanged.")}</p><Button variant="outline" size="sm" onClick={refresh}>{t("重试", "Retry")}</Button></section>}
          {ready && view === "history" && <AutomationHistory api={api} rules={allRules} root={root} ruleId={historyRuleId} runId={runId} reloadKey={dataVersion} onFilter={openHistory} onSelect={id => openHistory(historyRuleId, id)} onRule={openRule} onAccessFailure={revoke} />}
          {ready && view === "rules" && (draft ? <>
            <RuleEditor
              key={editorId}
              draft={draft}
              rule={selectedRule}
              projects={allProjects.filter(item => !item.data.archivedAt)}
              capabilities={capabilities.data}
              writable={writableFor(draft.config.projectId) && (!selectedRule || writableFor(selectedRule.config.projectId))}
              readable={allowed("domain.read", draft.config.projectId)}
              locked={locked}
              root={root}
              actions={savedRuleActions}
              onClose={() => { if (isDirty(draft)) setConfirmation({ kind: "reset", rule: selectedRule }); else { setSelectedRuleId(null); setRunId(null); } }}
              onChange={next => journal.setDraft(editorId, next)}
              onSave={saveDraft}
              onReset={() => setConfirmation({ kind: "reset", rule: selectedRule })}
              onRebase={() => setConfirmation({ kind: "rebase", rule: selectedRule })}
              test={(config, signal) => readAutomation(async () => automationPreviewSchema.parse(await api.test(config, { signal })), revoke)}
            />
            {selectedRule && <dl className={styles.ruleTiming}><div><dt>{t("上次运行", "Last run")}</dt><dd>{selectedRule.lastRunAt ? <time dateTime={selectedRule.lastRunAt}>{automationDateTime(selectedRule.lastRunAt)}</time> : t("尚未运行", "Not run yet")}</dd></div><div><dt>{t("下次检查", "Next check")}</dt><dd>{selectedRule.nextDueAt ? <time dateTime={selectedRule.nextDueAt}>{automationDateTime(selectedRule.nextDueAt)}</time> : selectedRule.config.trigger.kind === "manual" ? t("仅手动", "Manual only") : t("未安排", "Not scheduled")}</dd></div></dl>}
          </> : <section className={styles.empty}><LockKeyhole size={24} aria-hidden="true" /><h1>{t("规则不存在或不可访问", "Rule does not exist or is not accessible")}</h1><p>{!!snapshot.drafts[editorId] && isDirty(snapshot.drafts[editorId]!) ? t("未保存草稿已保留，当前不能保存。", "The unsaved draft is kept but cannot be saved right now.") : t("未切换到其他规则。", "No other rule was selected.")}</p><Button variant="outline" onClick={() => openHistory(editorId)}>{t("查看原规则历史", "View original rule history")}</Button></section>)}
        </>}
      </div>
    </section>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !locked) setConfirmation(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={styles.confirmTitle}>{confirmation?.kind === "remove" ? t("删除规则？", "Delete rule?") : confirmation?.kind === "run" ? t("运行一次？", "Run once?") : confirmation?.kind === "status" ? t("启用规则？", "Enable rule?") : confirmation?.kind === "reset" ? t("放弃未保存修改？", "Discard unsaved changes?") : t("采用当前版本？", "Adopt current version?")}</DialogTitle>
          <DialogDescription className={styles.confirmDescription}>{confirmation?.kind === "remove" ? t("停止调度并删除规则，运行历史保留。", "Scheduling stops and the rule is deleted; run history is kept.") : confirmation?.kind === "run" ? t("按已保存配置生成只读报告，计入运行预算。", "Generates a read-only report from the saved configuration and counts toward the run budget.") : confirmation?.kind === "status" ? t("启用不会立即运行。每日规则将在下次到期时检查。", "Enabling does not run immediately. Daily rules check at the next due time.") : confirmation?.kind === "reset" ? t("未保存修改将被丢弃。", "Unsaved changes will be discarded.") : t("保留草稿内容，采用当前版本后仍按新版本保存。", "Draft content is kept; saving afterwards uses the new revision.")}</DialogDescription>
        </DialogHeader>
        {confirmation?.rule && <div className={styles.confirmScope}><strong>{confirmation.rule.config.name}</strong><span>{confirmation.rule.config.projectId} / v{confirmation.rule.revision}</span></div>}
        <DialogFooter className={styles.confirmActions}><Button variant="outline" disabled={locked} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</Button><Button variant={confirmation?.kind === "remove" ? "destructive" : "default"} disabled={locked} onClick={confirm}>{confirmation?.kind === "remove" ? t("删除规则", "Delete rule") : confirmation?.kind === "run" ? t("运行一次", "Run once") : confirmation?.kind === "status" ? t("启用", "Enable") : t("确认", "Confirm")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
