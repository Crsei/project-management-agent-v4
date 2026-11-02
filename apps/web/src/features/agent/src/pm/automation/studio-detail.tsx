import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, Bug, ChevronLeft, ChevronRight, Download, ExternalLink, FileCode, Play, RefreshCw, Settings, X } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import type { StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { studioExecutionSchema, type StudioConfig, type StudioDefinition, type StudioExecution, type StudioExecutionEvent } from "../../../../../../../../packages/contracts/src/automation-studio";
import { isPmAutomationTemplateId } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { automationDateTime } from "./format";
import { useAutomationQuery } from "./query";
import { csvCell, downloadStudioFile, executionDuration, readEveryStudioPage, studioExecutionNeedsRefresh, studioStatusLabel, studioTriggerLabel } from "./studio-view";
import type { StudioCommand } from "./studio-actions";
import { StudioPmResults, type StudioPmReviewContext } from "./studio-pm-results";
import styles from "./studio.module.css";

function Section({ title, icon, children, actions }: { title: string; icon?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className={styles.section}><header className={styles.sectionHeader}>{icon}<h2>{title}</h2><div className={styles.sectionActions}>{actions}</div></header><div className={styles.sectionBody}>{children}</div></section>;
}
export function StudioConfiguration({ config }: { config: StudioConfig }) {
  const t = useAgentText();
  return <dl className={styles.metadata}>
    <div><dt>{t("项目", "Project")}</dt><dd>{config.projectId}</dd></div>
    <div><dt>{t("触发器", "Trigger")}</dt><dd>{studioTriggerLabel(config.trigger, t)}</dd></div>
    <div><dt>{t("动作", "Action")}</dt><dd>{config.action.kind === "prompt" ? t("Agent Prompt", "Agent prompt") : config.action.kind === "script" ? t("隔离 Python 脚本", "Isolated Python script") : t("原生模板", "Native template")}</dd></div>
    {config.action.kind !== "script" && <><div><dt>{t("Provider", "Provider")}</dt><dd>{config.action.providerInstanceId ?? t("不需要（确定性模板）", "Not required (deterministic template)")}</dd></div><div><dt>{t("模型", "Model")}</dt><dd>{config.action.model ?? t("不需要（确定性模板）", "Not required (deterministic template)")}</dd></div></>}
    <div><dt>{t("超时", "Timeout")}</dt><dd>{config.action.timeoutSeconds}s</dd></div>
    <div><dt>{t("每日上限", "Daily limit")}</dt><dd>{config.dailyLimit}</dd></div>
    <div><dt>{t("冷却", "Cooldown")}</dt><dd>{config.cooldownMinutes} min</dd></div>
    <div><dt>{t("仓库", "Repositories")}</dt><dd>{config.action.repositories.length ? config.action.repositories.map(repo => `${repo.id}${repo.ref ? ` @ ${repo.ref}` : ""}`).join(", ") : t("无", "None")}</dd></div>
    <div><dt>{t("插件", "Plugins")}</dt><dd>{config.action.plugins.length ? config.action.plugins.map(plugin => `${plugin.id}${plugin.version ? ` @ ${plugin.version}` : ""}`).join(", ") : t("无", "None")}</dd></div>
    {config.templateId && <div><dt>{t("模板来源", "Template source")}</dt><dd>{config.templateId}</dd></div>}
    {config.templateVersion && <div><dt>{t("模板版本", "Template version")}</dt><dd>{config.templateVersion}</dd></div>}
    {config.action.kind === "template" && <><div><dt>{t("原生处理器", "Native handler")}</dt><dd>{config.action.templateId}</dd></div><div><dt>{t("模板参数", "Template arguments")}</dt><dd><pre className={styles.code}>{JSON.stringify(config.action.arguments, null, 2)}</pre></dd></div></>}
    {config.trigger.kind === "event" && <div><dt>{t("事件过滤器", "Event filter")}</dt><dd><pre className={styles.code}>{JSON.stringify(config.trigger.filter, null, 2)}</pre></dd></div>}
  </dl>;
}

function StudioActionSource({ action }: { action: StudioConfig["action"] }) {
  const t = useAgentText();
  if (action.kind === "prompt") return <pre className={styles.prose}>{action.prompt}</pre>;
  if (action.kind === "template") return <div className={styles.stack}>
    <code>{action.templateId}</code>
    <p className={styles.muted}>{t("使用当前项目授权的原生处理器，不执行来源 Python 代码。", "Uses the native handler authorized for this project; source Python is not executed.")}</p>
    <pre className={styles.code}>{JSON.stringify(action.arguments, null, 2)}</pre>
  </div>;
  return <div className={styles.stack}>
    <p><code>{action.entrypoint}</code></p>
    {action.bundleRef && <p className={styles.muted}>{t("来源引用：", "Source reference: ")}{action.bundleRef}</p>}
    <pre className={styles.code}>{action.content || (action.files.length ? t("入口源码在下方文件包中。", "Entrypoint source is in the files below.") : t("未存储源码。", "No source code stored."))}</pre>
    {action.setup && <details><summary>{t("环境准备", "Environment setup")}</summary><pre className={styles.code}>{action.setup}</pre></details>}
    {action.files.map(file => <details key={file.path}><summary><code>{file.path}</code></summary><pre className={styles.code}>{file.content}</pre></details>)}
  </div>;
}

export function StudioDetail({ definition, definitionId, projectId, api, pmContext, reloadKey, runId, cursor, onCursor, onRunSelect, onBack, onEdit, onExport, onCommand, onDebug, onOpenThread, writable, locked, onAccessFailure }: {
  definition: StudioDefinition | null; definitionId: string; projectId?: string; api: StudioClient; pmContext: StudioPmReviewContext; reloadKey: number; runId: string | null; cursor?: string; onCursor: (cursor?: string) => void; onRunSelect: (id: string | null) => void; onBack: () => void; onEdit: () => void; onExport: (format: "bundle" | "source") => void; onCommand: (command: StudioCommand) => void; onDebug?: (config: StudioConfig, execution?: StudioExecution) => void; onOpenThread?: (id: string) => void; writable: boolean; locked: boolean; onAccessFailure: (cause: unknown) => void;
}) {
  const t = useAgentText();
  return <div className={styles.stack}>
    <button className={styles.backLink} type="button" onClick={onBack}><ArrowLeft size={14} />{t("返回 Dashboard", "Back to dashboard")}</button>
    {definition ? <>
      <header className={styles.heading}><div><div className={styles.eyebrow}>{t("执行自动化", "Execution automation")} · v{definition.revision}</div><h1>{definition.config.name}</h1><p>{definition.config.description}</p></div>
        <div className={styles.headerActions}><span className={styles.badge} data-status={definition.status}>{studioStatusLabel(definition.status, t)}</span><Button variant="outline" size="sm" disabled={!writable || locked} onClick={() => onCommand({ kind: "status", id: definition.id, expectedRevision: definition.revision, status: definition.status === "enabled" ? "paused" : "enabled" })}>{definition.status === "enabled" ? t("暂停", "Turn off") : t("启用", "Turn on")}</Button><Button size="sm" disabled={!writable || locked || definition.status === "draft"} onClick={() => onCommand({ kind: "run", id: definition.id, expectedRevision: definition.revision })}><Play size={14} />{t("立即运行", "Run now")}</Button>
          <details className={styles.menu}><summary aria-label={t("更多操作", "More actions")}>•••</summary><div className={styles.menuPanel}><button type="button" disabled={!writable || locked} onClick={onEdit}>{t("编辑", "Edit")}</button><button type="button" onClick={() => onExport("bundle")}>{t("导出完整定义", "Export complete definition")}</button><button type="button" onClick={() => onExport("source")}>{t("导出来源兼容 JSON", "Export source-compatible JSON")}</button><button type="button" disabled={!onDebug} onClick={() => onDebug?.(definition.config)}>{t("在 Chat 中调试", "Debug in Chat")}</button><button type="button" className={styles.dangerText} disabled={!writable || locked} onClick={() => onCommand({ kind: "remove", id: definition.id, expectedRevision: definition.revision })}>{t("删除", "Delete")}</button></div></details></div>
      </header>
      <div className={styles.pills}>{definition.config.tags.map(tag => <span className={styles.badge} key={tag}>#{tag}</span>)}<Button variant="ghost" size="sm" disabled={!writable || locked} onClick={onEdit}>{t("编辑标签", "Edit tags")}</Button></div>
      {definition.status !== "enabled" && <p className={styles.notice}>{definition.status === "draft" ? t("持久化草稿：不会自动触发。试运行请进入编辑器；启用不会立即运行。", "Persistent draft: no automatic dispatch. Use the editor for a test run; enabling does not run immediately.") : t("已暂停新调度。已开始的运行不会因此取消。", "New scheduling is paused. Runs already started are not cancelled.")}</p>}
      <Section title={definition.config.action.kind === "prompt" ? t("Prompt", "Prompt") : definition.config.action.kind === "script" ? t("脚本与文件", "Script and files") : t("原生模板参数", "Native template arguments")} icon={<FileCode size={16} />}>
        <StudioActionSource action={definition.config.action} />
      </Section>
      <Section title={t("配置", "Configuration")} icon={<Settings size={16} />}><StudioConfiguration config={definition.config} /></Section>
      <Section title={t("活动", "Activity")} icon={<Activity size={16} />}><dl className={styles.metadata}><div><dt>{t("创建", "Created")}</dt><dd>{automationDateTime(definition.createdAt)}</dd></div><div><dt>{t("更新", "Updated")}</dt><dd>{automationDateTime(definition.updatedAt)}</dd></div><div><dt>{t("上次运行", "Last run")}</dt><dd>{definition.lastRunAt ? automationDateTime(definition.lastRunAt) : t("尚未运行", "Not run yet")}</dd></div><div><dt>{t("下次触发", "Next due")}</dt><dd>{definition.nextDueAt ? automationDateTime(definition.nextDueAt) : "—"}</dd></div></dl></Section>
    </> : <div className={styles.notice}><h1>{t("定义已删除或不可访问", "Definition deleted or unavailable")}</h1><p>{t("下方仍按当前授权读取不可变运行历史，不创建替代定义。", "Immutable execution history below remains subject to current authorization. No replacement definition is created.")}</p></div>}
    <StudioActivity api={api} pmContext={pmContext} definitionId={definitionId} projectId={projectId} reloadKey={reloadKey} runId={runId} cursor={cursor} onCursor={onCursor} onRunSelect={onRunSelect} onCommand={onCommand} onDebug={onDebug} onOpenThread={onOpenThread} writable={writable} locked={locked} onAccessFailure={onAccessFailure} />
  </div>;
}

export function StudioActivity({ api, pmContext, definitionId, projectId, reloadKey, runId, cursor, onCursor, onRunSelect, onDefinition, onCommand, onDebug, onOpenThread, writable, locked, onAccessFailure }: {
  api: StudioClient; pmContext: StudioPmReviewContext; definitionId?: string; projectId?: string; reloadKey: number; runId: string | null; cursor?: string; onCursor: (cursor?: string) => void; onRunSelect: (id: string | null) => void; onDefinition?: (execution: StudioExecution) => void; onCommand: (command: StudioCommand) => void; onDebug?: (config: StudioConfig, execution?: StudioExecution) => void; onOpenThread?: (id: string) => void; writable: boolean; locked: boolean; onAccessFailure: (cause: unknown) => void;
}) {
  const t = useAgentText();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [logsRun, setLogsRun] = useState<StudioExecution | null>(null);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState("");
  const alive = useRef(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; exportController.current?.abort(); }; }, []);
  const history = useAutomationQuery(`studio-history:${definitionId ?? "all"}:${projectId ?? "workspace"}:${cursor ?? ""}:${reloadKey}`, async signal => {
    try { const page = await api.executions(definitionId, cursor, { signal }); return { ...page, items: page.items.map(item => studioExecutionSchema.parse(item)).filter(item => !projectId || item.configSnapshot.projectId === projectId) }; }
    catch (cause) { onAccessFailure(cause); throw cause; }
  }, true, page => page.items.some(studioExecutionNeedsRefresh));
  const linked = useAutomationQuery(`studio-linked:${definitionId ?? "all"}:${projectId ?? "workspace"}:${runId ?? ""}:${reloadKey}`, async signal => {
    try { const run = studioExecutionSchema.parse(await api.execution(runId!, { signal })); if (definitionId && run.definitionId !== definitionId) throw new Error("execution_definition_mismatch"); if (projectId && run.configSnapshot.projectId !== projectId) throw new Error("execution_project_mismatch"); return run; }
    catch (cause) { onAccessFailure(cause); throw cause; }
  }, !!runId, studioExecutionNeedsRefresh);
  const runs = history.error ? [] : [...history.data?.items ?? []];
  if (linked.data && !linked.error && !runs.some(item => item.id === linked.data!.id)) runs.unshift(linked.data);
  async function exportHistory(format: "json" | "csv") {
    if (exporting) return;
    setExporting(true); setExportError("");
    const controller = new AbortController(); exportController.current = controller;
    try {
      const all = (await readEveryStudioPage(cursor => api.executions(definitionId, cursor, { signal: controller.signal }))).filter(run => !projectId || run.configSnapshot.projectId === projectId);
      const records: (StudioExecution & { events: StudioExecutionEvent[] })[] = [];
      for (const run of all) records.push({ ...run, events: await readEveryStudioPage(cursor => api.logs(run.id, cursor, { signal: controller.signal })) });
      if (!alive.current) return;
      const headers = ["id", "definitionId", "definitionRevision", "requestId", "externalExecutionId", "configSnapshot", "trigger", "status", "createdAt", "startedAt", "finishedAt", "threadId", "summary", "error", "events"] as const;
      const content = format === "json" ? JSON.stringify({ kind: "pm-automation-execution-history", exportedAt: new Date().toISOString(), definitionId: definitionId ?? null, projectId: projectId ?? null, executions: records }, null, 2) : [headers.join(","), ...records.map(run => headers.map(key => csvCell(run[key])).join(","))].join("\r\n");
      downloadStudioFile(content, `automation-${definitionId ?? "all"}-history.${format}`, format === "csv" ? "text/csv;charset=utf-8" : "application/json");
    } catch (cause) { if (alive.current) { onAccessFailure(cause); setExportError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (alive.current) setExporting(false); }
  }
  async function query(run: StudioExecution) {
    if (querying) return;
    setQuerying(true); setQueryError("");
    try { await api.query(run.id); if (alive.current) { history.refetch(); linked.refetch(); } }
    catch (cause) { if (alive.current) { onAccessFailure(cause); setQueryError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (alive.current) setQuerying(false); }
  }
  return <Section title={t("运行记录", "Activity log")} icon={<Activity size={16} />} actions={<><Button variant="ghost" size="sm" disabled={history.loading} aria-label={t("刷新记录", "Refresh history")} onClick={() => { history.refetch(); linked.refetch(); }}><RefreshCw size={14} /></Button><Button variant="ghost" size="sm" disabled={exporting} onClick={() => void exportHistory("json")}>JSON</Button><Button variant="ghost" size="sm" disabled={exporting} onClick={() => void exportHistory("csv")}>CSV</Button></>}>
    <p className={styles.muted}>{t("每页为后端授权记录。JSON/CSV 导出遍历全部记录与日志页；包含已删除定义的历史。", "Pages contain authorized records. JSON/CSV exports traverse all record and log pages, including history of deleted definitions.")}</p>
    {exporting && <p role="status">{t("正在读取全部历史和日志…", "Reading all history and logs…")}</p>}{(exportError || queryError) && <p role="alert" className={styles.error}>{exportError || queryError}</p>}
    {history.loading && <p role="status">{t("加载运行记录…", "Loading executions…")}</p>}
    {!!history.error && <div className={styles.error} role="alert"><p>{t("无法读取运行历史", "Could not load execution history")}</p><Button variant="outline" size="sm" onClick={history.refetch}>{t("重试", "Retry")}</Button></div>}
    {!!linked.error && <p className={styles.error} role="alert">{t("链接记录不存在、无权或读取失败。", "The linked execution is missing, forbidden, or failed to load.")}</p>}
    {!history.loading && history.data && !history.error && !runs.length && <div className={styles.empty}><Activity size={22} /><h3>{cursor || history.data.nextCursor ? t("本页没有当前范围的运行记录", "No executions in this scope on this page") : t("暂无运行记录", "No runs yet")}</h3><p>{t("保存或只读验证不会产生运行记录。", "Saving and read-only validation do not produce executions.")}</p></div>}
    <ul className={styles.executionList}>{runs.map(run => {
      const expanded = runId === run.id; const duration = executionDuration(run);
      return <li key={run.id} data-highlighted={expanded} className={styles.execution}>
        <button type="button" className={styles.executionToggle} aria-expanded={expanded} onClick={() => onRunSelect(expanded ? null : run.id)}><span className={styles.statusDot} data-status={run.status} /><span className={styles.executionTitle}><strong>{run.configSnapshot.name}</strong><small>{automationDateTime(run.startedAt ?? run.createdAt)} · v{run.definitionRevision} · {run.trigger}</small></span><span className={styles.badge} data-status={run.status}>{studioStatusLabel(run.status, t)}</span><small>{duration === null ? "—" : `${(duration / 1000).toFixed(1)}s`}</small></button>
        {expanded && <div className={styles.executionDetail}><p className={styles.prose}>{run.summary || t("尚无摘要", "No summary yet")}</p>{run.error && <pre className={styles.error}>{run.error}</pre>}
          <dl className={styles.metadata}><div><dt>{t("运行 ID", "Execution ID")}</dt><dd><code>{run.id}</code></dd></div><div><dt>{t("原请求", "Original request")}</dt><dd><code>{run.requestId}</code></dd></div><div><dt>{t("外部执行 ID", "External execution ID")}</dt><dd><code>{run.externalExecutionId ?? "—"}</code></dd></div><div><dt>{t("结束", "Finished")}</dt><dd>{run.finishedAt ? automationDateTime(run.finishedAt) : "—"}</dd></div></dl>
          {run.configSnapshot.action.kind === "template" && isPmAutomationTemplateId(run.configSnapshot.action.templateId) && <StudioPmResults key={run.id} run={run} api={api} context={pmContext} locked={locked} onAccessFailure={onAccessFailure} />}
          {onDefinition && <Button className={styles.backLink} variant="ghost" size="sm" onClick={() => onDefinition(run)}>{t("查看定义与历史", "View definition and history")} · {run.definitionId} / v{run.definitionRevision}</Button>}
          {run.status === "outcome_unknown" && <p className={styles.notice}>{t("运行结果未知，不代表失败。核对原执行，禁止重新派发代替核对。", "Unknown does not mean failed. Reconcile the original execution rather than redispatching.")}</p>}
          <div className={styles.headerActions}><Button variant="outline" size="sm" onClick={() => setLogsRun(run)}><FileCode size={14} />{t("查看日志", "View logs")}</Button>{run.threadId ? <Button variant="outline" size="sm" disabled={!onOpenThread} onClick={() => onOpenThread?.(run.threadId!)}><ExternalLink size={14} />{t("打开会话", "Open conversation")}</Button> : <span className={styles.muted}>{t("无会话", "No conversation")}</span>}<Button variant="outline" size="sm" disabled={!onDebug} onClick={() => onDebug?.(run.configSnapshot, run)}><Bug size={14} />{t("调试", "Debug")}</Button>{["queued", "running", "outcome_unknown", "cancel_requested"].includes(run.status) && <><Button variant="outline" size="sm" disabled={querying} onClick={() => void query(run)}><RefreshCw size={14} />{t("核对原执行", "Reconcile original run")}</Button><Button variant="outline" size="sm" disabled={locked || !writable || run.status === "cancel_requested"} onClick={() => onCommand({ kind: "cancel", id: run.id })}><X size={14} />{t("请求取消", "Request cancellation")}</Button></>}</div>
          <details><summary>{t("不可变运行配置", "Immutable execution configuration")}</summary><div className={styles.stack}><StudioConfiguration config={run.configSnapshot} /><StudioActionSource action={run.configSnapshot.action} /></div></details>
        </div>}
      </li>;
    })}</ul>
    <nav className={styles.pagination} aria-label={t("运行历史分页", "Execution pagination")}><Button variant="outline" size="sm" disabled={!cursor || history.loading} onClick={() => onCursor(undefined)}><ChevronLeft size={14} />{t("第一页", "First page")}</Button><span>{t(`本页 ${history.data?.items.length ?? "—"} 条`, `${history.data?.items.length ?? "—"} on this page`)}</span><Button variant="outline" size="sm" disabled={!history.data?.nextCursor || history.loading || history.data.nextCursor === cursor} onClick={() => onCursor(history.data?.nextCursor ?? undefined)}>{t("下一页", "Next")}<ChevronRight size={14} /></Button></nav>
    {logsRun && <StudioLogs key={logsRun.id} api={api} run={runs.find(run => run.id === logsRun.id) ?? logsRun} onClose={() => setLogsRun(null)} onAccessFailure={onAccessFailure} />}
  </Section>;
}

function StudioLogs({ api, run, onClose, onAccessFailure }: { api: StudioClient; run: StudioExecution; onClose: () => void; onAccessFailure: (cause: unknown) => void }) {
  const t = useAgentText(); const [cursor, setCursor] = useState<string>(); const [exporting, setExporting] = useState(false); const [error, setError] = useState("");
  const alive = useRef(false); const downloadController = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; downloadController.current?.abort(); }; }, []);
  const logs = useAutomationQuery(`studio-logs:${run.id}:${run.status}:${cursor ?? ""}`, async signal => { try { return await api.logs(run.id, cursor, { signal }); } catch (cause) { onAccessFailure(cause); throw cause; } }, true, () => studioExecutionNeedsRefresh(run));
  async function download() {
    if (exporting) return;
    setExporting(true); setError("");
    const controller = new AbortController(); downloadController.current = controller;
    try {
      const events = await readEveryStudioPage(cursor => api.logs(run.id, cursor, { signal: controller.signal }));
      if (alive.current) downloadStudioFile(events.map(event => `${event.at} [${event.stream ?? event.kind}] ${event.message}`).join("\n"), `automation-${run.id}.log`, "text/plain;charset=utf-8");
    } catch (cause) { if (alive.current) { onAccessFailure(cause); setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (alive.current) setExporting(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={styles.logsDialog}><DialogHeader><DialogTitle>{t("运行日志", "Execution logs")}</DialogTitle><DialogDescription>{run.id} · {t("元数据与 stdout/stderr 分开存储；没有日志不表示运行成功。", "Metadata and stdout/stderr are separate; absent logs do not imply success.")}</DialogDescription></DialogHeader><div className={styles.headerActions}><Button variant="outline" size="sm" disabled={logs.loading} onClick={logs.refetch}><RefreshCw size={14} />{t("刷新", "Refresh")}</Button><Button variant="outline" size="sm" disabled={exporting} onClick={() => void download()}><Download size={14} />{t("下载全部日志", "Download all logs")}</Button></div>{logs.loading && <p role="status">{t("读取日志…", "Loading logs…")}</p>}{(!!logs.error || !!error) && <p role="alert" className={styles.error}>{error || t("日志读取失败", "Failed to read logs")}</p>}<pre className={styles.logText}>{logs.data?.items.map(event => `${event.at} [${event.stream ?? event.kind}] ${event.message}`).join("\n") || t("本页没有日志", "No logs on this page")}</pre><nav className={styles.pagination}><Button variant="outline" size="sm" disabled={!cursor || logs.loading} onClick={() => setCursor(undefined)}>{t("第一页", "First page")}</Button><Button variant="outline" size="sm" disabled={!logs.data?.nextCursor || logs.loading || logs.data.nextCursor === cursor} onClick={() => setCursor(logs.data?.nextCursor ?? undefined)}>{t("下一页", "Next page")}</Button></nav></DialogContent></Dialog>;
}
