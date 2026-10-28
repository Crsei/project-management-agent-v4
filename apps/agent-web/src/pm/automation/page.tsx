import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, CalendarClock, Check, ChevronRight, CirclePause, FileClock, LockKeyhole, Play, Plus, RefreshCw, Search, Trash2, Workflow, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AutomationClient } from "../../../../../packages/contracts/src/automation-client";
import { automationCapabilitiesSchema, automationPreviewSchema, type AutomationConfig, type AutomationRule } from "../../../../../packages/contracts/src/automation";
import type { Entity, EntityPage, Workspace } from "../../../../../packages/contracts/src/client";
import { pmJson, PmApiError } from "../state";
import { readAllRules, readAutomation } from "./data";
import { createAutomationJournal, emptyConfig, isDirty, type PendingRequest, type RuleDraft } from "./journal";
import { useAutomationActions } from "./actions";
import { useAutomationLeaveProtection } from "./leave-protection";
import { useAutomationQuery } from "./query";
import { RuleEditor } from "./editor";
import { AutomationHistory } from "./history";
import { automationDateTime } from "./format";
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

type AutomationPageProps = { workspace: Workspace; actorId: string; root: string; onExit: () => void; onRecheckAccess: () => void };

/** PM-owned automation rules and run history, hosted inside the Agent Chat shell. */
export function AutomationPage({ workspace, actorId, root, onExit, onRecheckAccess }: AutomationPageProps) {
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
  useAutomationLeaveProtection(hasDrafts || !!snapshot.pending || snapshot.storageError, "有未保存草稿或待核对请求，确定离开？");

  useEffect(() => {
    const media = window.matchMedia("(min-width: 761px)");
    const syncNavigation = () => setSavedNavigationOpen(media.matches);
    media.addEventListener("change", syncNavigation);
    return () => media.removeEventListener("change", syncNavigation);
  }, []);

  function openRule(id: string) {
    setConfirmation(null);
    if (!window.matchMedia("(min-width: 761px)").matches) setSavedNavigationOpen(false);
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
    <Button type="button" variant="ghost" size="sm" aria-label="查看规则历史" onClick={() => openHistory(selectedRule.id)}><FileClock size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId)} aria-label="删除规则" onClick={() => setConfirmation({ kind: "remove", rule: selectedRule })}><Trash2 size={14} aria-hidden="true" /></Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !manageableFor(selectedRule.config.projectId) || (selectedRule.status !== "enabled" && (!writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !enableReady))} title={selectedRule.status !== "enabled" && !enableReady ? "报告或后台调度未就绪。" : changedDraft(selectedRule) && selectedRule.status !== "enabled" ? "请先保存或放弃修改。" : undefined} onClick={() => selectedRule.status === "enabled" ? pauseRule(selectedRule) : setConfirmation({ kind: "status", rule: selectedRule, status: "enabled" })}>
      {selectedRule.status === "enabled" ? <CirclePause size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}{selectedRule.status === "enabled" ? "暂停" : "启用"}
    </Button>
    <Button type="button" variant="ghost" size="sm" disabled={locked || !writableFor(selectedRule.config.projectId) || changedDraft(selectedRule) || !reportReady} title={changedDraft(selectedRule) ? "请先保存或放弃修改。" : undefined} onClick={() => setConfirmation({ kind: "run", rule: selectedRule })}><Play size={14} aria-hidden="true" />运行</Button>
  </>;

  return <div className={`pm-automation ${styles.page} ${view === "history" ? styles.historyPage : ""}`}>
    {view === "rules" && <aside className={styles.navigation} aria-label="自动化导航">
      <div className={styles.navigationHeading}><span>自动化</span><Button variant="ghost" size="sm" aria-label="新建规则" disabled={!ready || locked || !availableProjects.some(item => writableFor(item.id))} onClick={() => openRule("new")}><Plus size={16} aria-hidden="true" /></Button></div>
      <nav className={styles.viewNavigation} aria-label="自动化视图">
        <button type="button" className={styles.activeNavigation} aria-current="page" onClick={() => { setView("rules"); setRunId(null); }}><Workflow size={15} aria-hidden="true" /><span>自动化</span></button>
        <button type="button" onClick={() => openHistory()}><FileClock size={15} aria-hidden="true" /><span>运行历史</span></button>
      </nav>
      <details className={styles.savedNavigation} open={savedNavigationOpen} onToggle={event => setSavedNavigationOpen(event.currentTarget.open)}>
        <summary>已保存规则</summary>
        {ready && <>
          {!!allRules.length && <label className={styles.search}><Search size={14} aria-hidden="true" /><Input aria-label="搜索规则" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索规则" /></label>}
          <ul className={styles.savedRules}>{filtered.map(rule => <li key={rule.id}><button type="button" className={editorId === rule.id ? styles.activeNavigation : ""} aria-current={editorId === rule.id ? "page" : undefined} title={rule.config.name} onClick={() => openRule(rule.id)}>{rule.config.trigger.kind === "daily" ? <CalendarClock size={15} aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />}<span>{rule.config.name}</span>{changedDraft(rule) && <small>草稿</small>}</button></li>)}</ul>
          {!filtered.length && <p className={styles.navigationEmpty}>{allRules.length ? "没有匹配规则" : "暂无规则"}</p>}
          {!!snapshot.drafts.new && isDirty(snapshot.drafts.new) && <button type="button" className={styles.unsavedNavigation} onClick={() => openRule("new")}><Plus size={15} aria-hidden="true" />未保存草稿</button>}
        </>}
      </details>
      <span className={styles.privateLabel}><LockKeyhole size={12} aria-hidden="true" />仅本人可见</span>
    </aside>}
    <section className={styles.content} aria-label={view === "history" ? "运行历史" : "规则编辑"}>
      <header className={styles.contentHeader}>
        <nav className={styles.breadcrumb} aria-label="当前位置">
          <Button variant="ghost" size="sm" onClick={onExit}><ArrowLeft size={14} aria-hidden="true" />对话</Button>
          {view === "history" ? <button type="button" aria-label="返回自动化" onClick={() => { setView("rules"); setRunId(null); }}>自动化</button> : <span>自动化</span>}
          <ChevronRight size={12} aria-hidden="true" />
          <span aria-current="page">{view === "history" ? "运行历史" : selectedRule?.config.name || (editorId === "new" ? "新建规则" : "规则不可用")}</span>
        </nav>
        {view === "rules" && <Button variant="ghost" size="sm" aria-label="刷新自动化" disabled={capabilities.loading || rules.loading || projects.loading} onClick={refresh}><RefreshCw size={14} aria-hidden="true" /></Button>}
      </header>
      <div className={view === "history" ? styles.historyContent : styles.editorContent}>
        {ready && capabilities.data?.canWrite === false && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />只读模式</p>}
        {snapshot.storageError && <section className={styles.warning} role="alert"><p>恢复存储不可用，写入已暂停。原请求仍保留。</p><Button variant="outline" size="sm" onClick={() => journal.retryStorage()}>重试恢复</Button></section>}
        {snapshot.pending && !accessLost && <section className={styles.warning} aria-live="polite"><strong>{actions.busy ? "正在提交或核对…" : "原请求待核对"}</strong><p>只查询原收据，不会重复保存或运行。</p><code className={styles.breakAll}>{snapshot.pending.requestId}</code><Button variant="outline" size="sm" disabled={actions.busy} onClick={() => { void actions.reconcile(); }}>查询原收据</Button></section>}
        {!accessLost && actions.error && <p role="alert" className={styles.errorBlock}>{actions.error}</p>}
        {!accessLost && actions.notice && <p role="status" className={styles.successNotice}><Check size={15} aria-hidden="true" />{actions.notice}</p>}
        {accessLost ? <section className={styles.empty} role="alert"><LockKeyhole size={24} aria-hidden="true" /><h1>来源或授权已不可用</h1><p>私有数据与草稿已清空，原请求 ID 保留。</p><Button variant="outline" onClick={() => { onRecheckAccess(); accessLostRef.current = false; setAccessLost(false); setDataVersion(value => value + 1); }}>重新读取授权</Button></section> : <>
          {(capabilities.loading || rules.loading || projects.loading) && <p className={styles.loading} role="status">正在读取自动化…</p>}
          {(capabilities.error || rules.error || projects.error) && <section className={styles.errorBlock} role="alert"><p>读取失败，写入已暂停，草稿版本未变。</p><Button variant="outline" size="sm" onClick={refresh}>重试</Button></section>}
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
            {selectedRule && <dl className={styles.ruleTiming}><div><dt>上次运行</dt><dd>{selectedRule.lastRunAt ? <time dateTime={selectedRule.lastRunAt}>{automationDateTime(selectedRule.lastRunAt)}</time> : "尚未运行"}</dd></div><div><dt>下次检查</dt><dd>{selectedRule.nextDueAt ? <time dateTime={selectedRule.nextDueAt}>{automationDateTime(selectedRule.nextDueAt)}</time> : selectedRule.config.trigger.kind === "manual" ? "仅手动" : "未安排"}</dd></div></dl>}
          </> : <section className={styles.empty}><LockKeyhole size={24} aria-hidden="true" /><h1>规则不存在或不可访问</h1><p>{!!snapshot.drafts[editorId] && isDirty(snapshot.drafts[editorId]!) ? "未保存草稿已保留，当前不能保存。" : "未切换到其他规则。"}</p><Button variant="outline" onClick={() => openHistory(editorId)}>查看原规则历史</Button></section>)}
        </>}
      </div>
    </section>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !locked) setConfirmation(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={styles.confirmTitle}>{confirmation?.kind === "remove" ? "删除规则？" : confirmation?.kind === "run" ? "运行一次？" : confirmation?.kind === "status" ? "启用规则？" : confirmation?.kind === "reset" ? "放弃未保存修改？" : "采用当前版本？"}</DialogTitle>
          <DialogDescription className={styles.confirmDescription}>{confirmation?.kind === "remove" ? "停止调度并删除规则，运行历史保留。" : confirmation?.kind === "run" ? "按已保存配置生成只读报告，计入运行预算。" : confirmation?.kind === "status" ? "启用不会立即运行。每日规则将在下次到期时检查。" : confirmation?.kind === "reset" ? "未保存修改将被丢弃。" : "保留草稿内容，采用当前版本后仍按新版本保存。"}</DialogDescription>
        </DialogHeader>
        {confirmation?.rule && <div className={styles.confirmScope}><strong>{confirmation.rule.config.name}</strong><span>{confirmation.rule.config.projectId} / v{confirmation.rule.revision}</span></div>}
        <DialogFooter className={styles.confirmActions}><Button variant="outline" disabled={locked} onClick={() => setConfirmation(null)}>取消</Button><Button variant={confirmation?.kind === "remove" ? "destructive" : "default"} disabled={locked} onClick={confirm}>{confirmation?.kind === "remove" ? "删除规则" : confirmation?.kind === "run" ? "运行一次" : confirmation?.kind === "status" ? "启用" : "确认"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
