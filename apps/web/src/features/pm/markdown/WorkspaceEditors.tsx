import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultConfiguration, diagnosticsOf, parseConfiguration, type Diagnostic, type ProtocolConfiguration, type SavedView, type ViewConfig } from '@pm-schema';
import { validateView } from '@pm-schema/query';
import { ApiError, type MigrationPlan, type MigrationRequest, type MigrationSummary } from './api.ts';
import { useCoreSession, type CoreSession } from './session';
import { hasUncertainCreationDrafts } from './creation-model';
import { usePmCommand } from '../service/pm-service';
import type { CommandState } from '../service/pm-command-store';
import { Diagnostics } from './Diagnostics.tsx';
import { hasUncertainProjectTaskDraft } from '../service/project-task-editing-model';
import { RadixSelect } from "@/components/ui/radix-select"

function errorMessage(error: unknown): string { return error instanceof ApiError && error.message ? error.message : error instanceof Error ? error.message : String(error); }
function assertEditorWriteAvailable(session: CoreSession, command: CommandState) {
  session.creationDrafts.refresh();
  if (command.pending || command.unknownCommand || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || hasUncertainProjectTaskDraft(session.drafts.getSnapshot())) throw new Error('Resolve the original pending or unknown write before saving. / 请先核对原待定或结果未知的写入。');
}


export function ConfigurationEditor({ configuration, revision, diagnostics, onSaved, onError, en, disabled }: { configuration: ProtocolConfiguration; revision: string; diagnostics: Diagnostic[]; onSaved: () => void; onError: (error: unknown) => void; en: boolean; disabled: boolean }) {
  const session = useCoreSession();
  const command = usePmCommand();
  const { api } = session;
  const [text, setText] = useState(() => stringifyYaml(configuration));
  const [baseRevision, setBaseRevision] = useState(revision);
  const [issues, setIssues] = useState<Diagnostic[]>(diagnostics);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const candidate = useMemo(() => { try { return { config: parseConfiguration(parseYaml(text)), diagnostics: [] }; } catch (error) { return { diagnostics: diagnosticsOf(error) }; } }, [text]);
  async function save() {
    if (disabled || busy || !session.isCurrent() || !candidate.config) return;
    setBusy(true); setNotice(''); setError('');
    try {
      assertEditorWriteAvailable(session, command);
      const result = await api.saveConfiguration(candidate.config, baseRevision);
      if (!session.isCurrent()) return;
      setBaseRevision(result.revision); setIssues(result.diagnostics);
      setNotice(en ? 'Configuration saved. Existing source drafts were retained.' : '配置已保存，已有源码草稿仍予以保留。');
      onSaved();
    } catch (error) {
      setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error);
    } finally { setBusy(false); }
  }
  return <div className="modal-form">
    <p>{en ? 'Configure workflow states, categories, allowed transitions and typed x-* fields. Saving validates every current file and uses the revision you opened. To rename existing states or fields, use a migration instead.' : '配置工作流状态、类别、允许的转换及带类型的 x-* 字段。保存会验证当前全部文件，并使用打开时的版本；重命名已有状态或字段请使用协议迁移。'}</p>
    <p className="mono">{en ? 'Configuration revision' : '配置版本'}: {baseRevision}</p>
    {revision !== baseRevision && <div className="inline-error">{en ? 'Configuration changed externally. Your editor is retained; saving will require resolving the conflict.' : '配置已被外部修改，当前编辑内容仍保留；保存前须处理版本冲突。'}</div>}
    <label>{en ? 'Protocol configuration YAML' : '协议配置 YAML'}<textarea aria-label={en ? 'Protocol configuration YAML' : '协议配置 YAML'} data-testid="configuration-editor" className="protocol-editor" value={text} readOnly={disabled || busy} onChange={event => setText(event.target.value)} spellCheck={false} /></label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <Diagnostics diagnostics={[...candidate.diagnostics, ...issues]} />
    {notice && <p role="status">{notice}</p>}
    <div className="modal-actions">
      <button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(en ? 'Discard configuration edits and load the latest snapshot?' : '放弃配置编辑并载入最新快照？')) { setText(stringifyYaml(configuration)); setBaseRevision(revision); setIssues(diagnostics); setNotice(''); } }}>{en ? 'Reload current configuration' : '重新载入当前配置'}</button>
      <button className="primary-button" data-testid="save-configuration" disabled={disabled || busy || !candidate.config} onClick={() => void save()}>{en ? 'Save configuration' : '保存配置'}</button>
    </div>
    <details><summary>{en ? 'Default workflow and custom-field format' : '默认工作流与自定义字段格式'}</summary><pre>{stringifyYaml(defaultConfiguration)}</pre><p>{en ? 'Custom field types: text, number, boolean, date, select, multi_select, reference. Each field declares name (x-*), label, entities, type, and optional required/default/options/target/min/max.' : '自定义字段类型：text、number、boolean、date、select、multi_select、reference。每个字段声明 name（x-*）、label、entities、type，并可配置 required/default/options/target/min/max。'}</p></details>
  </div>;
}

export function ViewEditor({ config, configuration, views, active, onUse, onSaved, onError, disabled }: { config: ViewConfig; configuration: ProtocolConfiguration; views: SavedView[]; active?: SavedView; onUse: (config: ViewConfig) => void; onSaved: (view: SavedView) => void; onError: (error: unknown) => void; disabled: boolean }) {
  const session = useCoreSession();
  const command = usePmCommand();
  const { api } = session;
  const [text, setText] = useState(() => stringifyYaml(config));
  const [id, setId] = useState(active?.id || '');
  const [name, setName] = useState(active?.name || '');
  const [base, setBase] = useState(active);
  const [issues, setIssues] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidate = useMemo(() => { try { return { config: validateView(parseYaml(text), configuration), diagnostics: [] }; } catch (error) { return { diagnostics: diagnosticsOf(error) }; } }, [text, configuration]);
  async function save(event: React.FormEvent) { event.preventDefault(); if (!candidate.config) return; setBusy(true); setError(''); try { assertEditorWriteAvailable(session, command); const view = await api.saveView(id, { ...candidate.config, name, ...(base?.id === id ? { revision: base.revision } : {}) }); setBase(view); onSaved(view); } catch (error) { setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error); } finally { setBusy(false); } }
  return <form className="modal-form" onSubmit={event => void save(event)}><p>Full declarative query: entity, project, layout, group_by, filter, where (all/any/not), order_by, order and columns. Group writes change the selected scalar field. Manual order retains hidden IDs.</p><label>Load saved view<RadixSelect aria-label="Load view for editing" value={base?.id || ''} onChange={event => { const view = views.find(item => item.id === event.target.value); setBase(view); setId(view?.id || ''); setName(view?.name || ''); if (view) { const { id: _id, name: _name, revision: _revision, ...definition } = view; setText(stringifyYaml(definition)); } setIssues([]); }}><option value="">New view</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</RadixSelect></label><label>View query YAML<textarea aria-label="View query YAML" data-testid="view-query-editor" className="protocol-editor" value={text} onChange={event => setText(event.target.value)} spellCheck={false} /></label><div className="form-grid"><label>View name<input name="name" required aria-label="View name" value={name} onChange={event => setName(event.target.value)} /></label><label>View ID<input name="id" required pattern="[a-z0-9][a-z0-9-]*" aria-label="View ID" value={id} onChange={event => { setId(event.target.value); if (base?.id !== event.target.value) setBase(undefined); }} /></label></div><p className="muted">Load an existing view before updating it so its exact revision is reviewed. Current revision: {base?.revision || 'new view'}.</p>{error && <div className="inline-error" role="alert">{error}</div>}<Diagnostics diagnostics={[...candidate.diagnostics, ...issues]} /><div className="modal-actions"><button type="button" className="secondary-button" data-testid="apply-view-query" disabled={!candidate.config || busy} onClick={() => candidate.config && onUse(candidate.config)}>Use query without saving</button><button className="primary-button" type="submit" data-testid="save-view-query" disabled={!candidate.config || busy || disabled}>Save view</button></div><details><summary>Query example</summary><pre>{`entity: work_item\nlayout: table\ngroup_by: status\nwhere:\n  all:\n    - field: title\n      op: contains\n      value: launch\n    - not:\n        field: priority\n        op: eq\n        value: low\norder_by:\n  - field: due\n    direction: asc\ncolumns: [status, priority, due]\n`}</pre></details></form>;
}

export function MigrationEditor({ onChanged, onError, en, active, authorized, disabled }: { onChanged: () => void; onError: (error: unknown) => void; en: boolean; active: boolean; authorized: boolean; disabled: boolean }) {
  const session = useCoreSession();
  const command = usePmCommand();
  const { api } = session;
  const [text, setText] = useState('kind: normalize-v1\n');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [issues, setIssues] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [restore, setRestore] = useState<MigrationSummary | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const client = useQueryClient();
  const historyAccessFailure = useRef<number | null>(null);
  const history = useQuery({
    queryKey: [...session.queryKey, 'migrations'],
    queryFn: () => api.migrations(),
    enabled: active && authorized,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (history.isSuccess) historyAccessFailure.current = null;
    const failure = history.error;
    if (!session.isCurrent() || !(failure instanceof ApiError) || ![401, 403].includes(failure.status)) return;
    if (failure.status === 403 && (!active || !authorized)) return;
    // Membership refresh also invalidates private reads. Report each access
    // failure once until success; otherwise a scoped 403 recursively refreshes.
    if (historyAccessFailure.current === failure.status) return;
    historyAccessFailure.current = failure.status;
    onError(failure);
  }, [active, authorized, history.isSuccess, history.error, onError, session]);
  async function preview() {
    if (disabled || busy || !session.isCurrent()) return;
    setBusy(true); setPlan(null); setRestore(null); setConfirmation(''); setIssues([]); setNotice(''); setError('');
    try {
      assertEditorWriteAvailable(session, command);
      const result = await api.previewMigration(parseYaml(text) as MigrationRequest);
      if (!session.isCurrent()) return;
      setPlan(result);
      await client.invalidateQueries({ queryKey: [...session.queryKey, 'migrations'], exact: true });
    } catch (error) {
      setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error);
    } finally { setBusy(false); }
  }
  async function execute(action: 'apply' | 'restore') {
    const selected = action === 'apply' ? plan : restore;
    if (disabled || busy || !session.isCurrent() || !selected || confirmation !== selected.id) return;
    setBusy(true); setIssues([]); setError('');
    try {
      assertEditorWriteAvailable(session, command);
      const result = await (action === 'apply' ? api.applyMigration(selected.id, selected.revision) : api.restoreMigration(selected.id, selected.revision));
      if (!session.isCurrent()) return;
      setNotice(en ? `${result.id}: ${result.status}. Local source drafts were retained; inspect conflicts before saving.` : `${result.id}: ${result.status}。本地源码草稿仍保留，保存前请检查冲突。`);
      setPlan(null); setRestore(null); setConfirmation('');
      onChanged();
      await client.invalidateQueries({ queryKey: [...session.queryKey, 'migrations'], exact: true });
    } catch (error) {
      setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error);
    } finally { setBusy(false); }
  }
  const selected = restore || plan;
  return <div className="modal-form">
    {error && <div className="inline-error" role="alert">{error}</div>}
    <p>{en ? 'Preview does not change business source files or configuration, but it persists a migration plan and protocol restore materials on the server. Apply changes files and configuration only after explicit confirmation. Restore refuses to overwrite newer edits; unknown future protocol sources are never downgraded.' : '预览不会修改业务源文件或配置，但会在服务端持久保存迁移计划及协议恢复材料。仅在明确确认后应用文件与配置修改；恢复拒绝覆盖更新的编辑，也不会降级未知的未来协议源码。'}</p>
    <p className="muted">{en ? 'These materials restore only this protocol migration, not PostgreSQL, attachments, Agent data or the full system. For a complete recovery set and verification, see the repository deployment guide' : '这些材料仅用于本次协议迁移恢复，不涵盖 PostgreSQL、附件、Agent 数据或全系统。完整恢复集与核验请参阅仓库部署手册'} <code>deploy/README.md</code> {en ? '→ “备份与恢复验证”.' : '→「备份与恢复验证」。'}</p>
    <label>{en ? 'Migration request YAML' : '迁移请求 YAML'}<textarea aria-label={en ? 'Migration request YAML' : '迁移请求 YAML'} data-testid="migration-request" className="protocol-editor" value={text} readOnly={disabled || busy} onChange={event => { setText(event.target.value); setPlan(null); setRestore(null); setConfirmation(''); }} spellCheck={false} /></label>
    <button className="secondary-button" data-testid="preview-migration" disabled={disabled || busy} onClick={() => void preview()}>{en ? 'Preview migration (save plan)' : '预览迁移（保存计划）'}</button>
    <details><summary>{en ? 'Transform request format' : '转换请求格式'}</summary><pre>{`kind: transform\n# config: candidate pm/config/v1 configuration (optional)\nchanges:\n  - id: TASK-101\n    set: {status: in_progress}\n    rename: {x-old: x-new}\n    unset: [x-obsolete]\n`}</pre></details>
    <Diagnostics diagnostics={issues} />
    {notice && <p role="status">{notice}</p>}
    {authorized && plan && <section data-testid="migration-preview">
      <h3>{en ? 'Preview' : '预览'} {plan.id}</h3><p className="mono">{en ? 'Revision' : '版本'}: {plan.revision}</p>
      <Diagnostics diagnostics={plan.diagnostics} />
      {!plan.files.length && <p>{en ? 'No file changes.' : '无文件变更。'}</p>}
      {plan.files.map(file => <details key={file.path} open><summary>{file.path}</summary><div className="conflict-columns"><label>{en ? 'Before' : '修改前'}<textarea aria-label={`${en ? 'Before' : '修改前'} ${file.path}`} value={file.before ?? (en ? '(absent)' : '（不存在）')} readOnly spellCheck={false} /></label><label>{en ? 'After' : '修改后'}<textarea aria-label={`${en ? 'After' : '修改后'} ${file.path}`} value={file.after ?? (en ? '(absent)' : '（不存在）')} readOnly spellCheck={false} /></label></div></details>)}
    </section>}
    <h3>{en ? 'Protocol migration history and restore materials' : '协议迁移历史与恢复材料'}</h3>
    {authorized && <>
      {history.isFetching && <p role="status">{en ? 'Reading migration history…' : '正在读取迁移历史…'}</p>}
      {history.isError && <div className="inline-error" role="alert">{en ? 'Migration history could not be read. This is not an empty history.' : '无法读取迁移历史，这不代表历史为空。'} {errorMessage(history.error)} <button className="secondary-button" disabled={history.isFetching || busy} onClick={() => void history.refetch()}>{en ? 'Retry history' : '重试读取历史'}</button></div>}
      {history.isSuccess && !history.data.length && <p>{en ? 'No protocol migration history.' : '暂无协议迁移历史。'}</p>}
      {history.data?.map(item => <div className="migration-history" key={item.id}><span>{item.id} · {item.kind} · {item.status} · {item.files} {en ? 'files' : '个文件'}</span><button className="secondary-button" aria-label={`${en ? 'Restore migration' : '恢复协议迁移'} ${item.id}`} disabled={disabled || busy || item.status !== 'applied'} onClick={() => { setRestore(item); setPlan(null); setConfirmation(''); }}>{en ? 'Restore this migration…' : '恢复此次迁移…'}</button></div>)}
    </>}
    {authorized && selected && <section className="migration-confirmation">
      <p>{restore ? (en ? 'Restore original files and configuration from' : '从以下迁移恢复原始文件与配置：') : (en ? 'Apply the exact reviewed preview' : '应用已审阅的精确迁移预览：')} {selected.id}. {en ? 'Revision' : '版本'}: <span className="mono">{selected.revision}</span></p>
      <label>{en ? 'Type migration ID to confirm' : '输入迁移 ID 以确认'}<input aria-label={en ? 'Confirm migration ID' : '确认迁移 ID'} data-testid="migration-confirmation" value={confirmation} disabled={disabled || busy} onChange={event => setConfirmation(event.target.value)} spellCheck={false} /></label>
      <button className="primary-button" data-testid={restore ? 'restore-migration' : 'apply-migration'} disabled={disabled || busy || confirmation !== selected.id || (!restore && (!plan?.files.length || plan.diagnostics.some(issue => issue.severity === 'error')))} onClick={() => void execute(restore ? 'restore' : 'apply')}>{restore ? (en ? 'Confirm protocol restore' : '确认协议恢复') : (en ? 'Apply reviewed migration' : '应用已审阅迁移')}</button>
    </section>}
  </div>;
}
