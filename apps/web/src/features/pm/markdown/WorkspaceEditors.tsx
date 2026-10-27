import React, { useEffect, useMemo, useState } from 'react';
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

function errorMessage(error: unknown): string { return error instanceof ApiError && error.message ? error.message : error instanceof Error ? error.message : String(error); }
function assertEditorWriteAvailable(session: CoreSession, command: CommandState) {
  session.creationDrafts.refresh();
  if (command.pending || command.unknownCommand || hasUncertainCreationDrafts(session.creationDrafts.getSnapshot()) || hasUncertainProjectTaskDraft(session.drafts.getSnapshot())) throw new Error('Resolve the original pending or unknown write before saving. / 请先核对原待定或结果未知的写入。');
}


export function ConfigurationEditor({ configuration, revision, diagnostics, onSaved, onError }: { configuration: ProtocolConfiguration; revision: string; diagnostics: Diagnostic[]; onSaved: () => void; onError: (error: unknown) => void }) {
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
  async function save() { if (!candidate.config) return; setBusy(true); setNotice(''); setError(''); try { assertEditorWriteAvailable(session, command); const result = await api.saveConfiguration(candidate.config, baseRevision); setBaseRevision(result.revision); setIssues(result.diagnostics); setNotice('Configuration saved. Existing source drafts were retained.'); onSaved(); } catch (error) { setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error); } finally { setBusy(false); } }
  return <div className="modal-form"><p>Configure workflow states, categories, allowed transitions and typed x-* fields. Saving validates every current file and uses the revision you opened. To rename existing states or fields, use a migration instead.</p><p className="mono">Configuration revision: {baseRevision}</p>{revision !== baseRevision && <div className="inline-error">Configuration changed externally. Your editor is retained; saving will require resolving the conflict.</div>}<label>Protocol configuration YAML<textarea aria-label="Protocol configuration YAML" data-testid="configuration-editor" className="protocol-editor" value={text} onChange={event => setText(event.target.value)} spellCheck={false} /></label>{error && <div className="inline-error" role="alert">{error}</div>}<Diagnostics diagnostics={[...candidate.diagnostics, ...issues]} />{notice && <p role="status">{notice}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm('Discard configuration edits and load the latest snapshot?')) { setText(stringifyYaml(configuration)); setBaseRevision(revision); setIssues(diagnostics); setNotice(''); } }}>Reload current configuration</button><button className="primary-button" data-testid="save-configuration" disabled={busy || !candidate.config} onClick={() => void save()}>Save configuration</button></div><details><summary>Default workflow and custom-field format</summary><pre>{stringifyYaml(defaultConfiguration)}</pre><p>Custom field types: text, number, boolean, date, select, multi_select, reference. Each field declares name (x-*), label, entities, type, and optional required/default/options/target/min/max.</p></details></div>;
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
  return <form className="modal-form" onSubmit={event => void save(event)}><p>Full declarative query: entity, project, layout, group_by, filter, where (all/any/not), order_by, order and columns. Group writes change the selected scalar field. Manual order retains hidden IDs.</p><label>Load saved view<select aria-label="Load view for editing" value={base?.id || ''} onChange={event => { const view = views.find(item => item.id === event.target.value); setBase(view); setId(view?.id || ''); setName(view?.name || ''); if (view) { const { id: _id, name: _name, revision: _revision, ...definition } = view; setText(stringifyYaml(definition)); } setIssues([]); }}><option value="">New view</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label><label>View query YAML<textarea aria-label="View query YAML" data-testid="view-query-editor" className="protocol-editor" value={text} onChange={event => setText(event.target.value)} spellCheck={false} /></label><div className="form-grid"><label>View name<input name="name" required aria-label="View name" value={name} onChange={event => setName(event.target.value)} /></label><label>View ID<input name="id" required pattern="[a-z0-9][a-z0-9-]*" aria-label="View ID" value={id} onChange={event => { setId(event.target.value); if (base?.id !== event.target.value) setBase(undefined); }} /></label></div><p className="muted">Load an existing view before updating it so its exact revision is reviewed. Current revision: {base?.revision || 'new view'}.</p>{error && <div className="inline-error" role="alert">{error}</div>}<Diagnostics diagnostics={[...candidate.diagnostics, ...issues]} /><div className="modal-actions"><button type="button" className="secondary-button" data-testid="apply-view-query" disabled={!candidate.config || busy} onClick={() => candidate.config && onUse(candidate.config)}>Use query without saving</button><button className="primary-button" type="submit" data-testid="save-view-query" disabled={!candidate.config || busy || disabled}>Save view</button></div><details><summary>Query example</summary><pre>{`entity: work_item\nlayout: table\ngroup_by: status\nwhere:\n  all:\n    - field: title\n      op: contains\n      value: launch\n    - not:\n        field: priority\n        op: eq\n        value: low\norder_by:\n  - field: due\n    direction: asc\ncolumns: [status, priority, due]\n`}</pre></details></form>;
}

export function MigrationEditor({ onChanged, onError }: { onChanged: () => void; onError: (error: unknown) => void }) {
  const session = useCoreSession();
  const command = usePmCommand();
  const { api } = session;
  const [text, setText] = useState('kind: normalize-v1\n');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [history, setHistory] = useState<MigrationSummary[]>([]);
  const [issues, setIssues] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [restore, setRestore] = useState<MigrationSummary | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void api.migrations().then(setHistory).catch(error => { setIssues(diagnosticsOf(error)); onError(error); }); }, [api, onError]);
  async function preview() { setBusy(true); setPlan(null); setRestore(null); setConfirmation(''); setIssues([]); setNotice(''); setError(''); try { const result = await api.previewMigration(parseYaml(text) as MigrationRequest); setPlan(result); setHistory(await api.migrations()); } catch (error) { setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error); } finally { setBusy(false); } }
  async function execute(action: 'apply' | 'restore') { const selected = action === 'apply' ? plan : restore; if (!selected || confirmation !== selected.id) return; setBusy(true); setIssues([]); setError(''); try { assertEditorWriteAvailable(session, command); const result = await (action === 'apply' ? api.applyMigration(selected.id, selected.revision) : api.restoreMigration(selected.id, selected.revision)); setNotice(`${result.id}: ${result.status}. Local source drafts were retained; inspect conflicts before saving.`); setPlan(null); setRestore(null); setConfirmation(''); setHistory(await api.migrations()); onChanged(); } catch (error) { setError(errorMessage(error)); setIssues(error instanceof ApiError ? error.diagnostics : diagnosticsOf(error)); onError(error); } finally { setBusy(false); } }
  const selected = restore || plan;
  return <div className="modal-form">{error && <div className="inline-error" role="alert">{error}</div>}<p>Preview is read-only. Apply changes files and configuration only after explicit confirmation. Backups are retained; restore refuses to overwrite newer edits. Unknown future protocol sources are never downgraded.</p><label>Migration request YAML<textarea aria-label="Migration request YAML" data-testid="migration-request" className="protocol-editor" value={text} disabled={busy} onChange={event => { setText(event.target.value); setPlan(null); setConfirmation(''); }} spellCheck={false} /></label><button className="secondary-button" data-testid="preview-migration" disabled={busy} onClick={() => void preview()}>Preview migration</button><details><summary>Transform request format</summary><pre>{`kind: transform\n# config: candidate pm/config/v1 configuration (optional)\nchanges:\n  - id: TASK-101\n    set: {status: in_progress}\n    rename: {x-old: x-new}\n    unset: [x-obsolete]\n`}</pre></details><Diagnostics diagnostics={issues} />{notice && <p role="status">{notice}</p>}{plan && <section data-testid="migration-preview"><h3>Preview {plan.id}</h3><p className="mono">Revision: {plan.revision}</p><Diagnostics diagnostics={plan.diagnostics} />{!plan.files.length && <p>No file changes.</p>}{plan.files.map(file => <details key={file.path} open><summary>{file.path}</summary><div className="conflict-columns"><label>Before<textarea aria-label={`Before ${file.path}`} value={file.before ?? '(absent)'} readOnly /></label><label>After<textarea aria-label={`After ${file.path}`} value={file.after ?? '(absent)'} readOnly /></label></div></details>)}</section>}<h3>Migration history and backups</h3>{history.map(item => <div className="migration-history" key={item.id}><span>{item.id} · {item.kind} · {item.status} · {item.files} files</span><button className="secondary-button" aria-label={`Restore migration ${item.id}`} disabled={busy || item.status !== 'applied'} onClick={() => { setRestore(item); setPlan(null); setConfirmation(''); }}>Restore backup…</button></div>)}{selected && <section className="migration-confirmation"><p>{restore ? 'Restore original files and configuration from' : 'Apply the exact reviewed preview'} {selected.id}. Revision: <span className="mono">{selected.revision}</span></p><label>Type migration ID to confirm<input aria-label="Confirm migration ID" data-testid="migration-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button className="primary-button" data-testid={restore ? 'restore-migration' : 'apply-migration'} disabled={busy || confirmation !== selected.id || (!restore && (!plan?.files.length || plan.diagnostics.some(issue => issue.severity === 'error')))} onClick={() => void execute(restore ? 'restore' : 'apply')}>{restore ? 'Confirm restore backup' : 'Apply reviewed migration'}</button></section>}</div>;
}
