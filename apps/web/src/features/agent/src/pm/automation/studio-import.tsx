import { useEffect, useMemo, useRef, useState } from 'react';
import { AutomationTransferClient } from '../../../../../../../../packages/contracts/src/automation-transfer-client';
import { AutomationApiError } from '../../../../../../../../packages/contracts/src/automation-client';
import { AUTOMATION_TRANSFER_LIMITS, type AutomationTransferPreview, type AutomationTransferReceipt } from '../../../../../../../../packages/contracts/src/automation-transfer';
import { StudioClient } from '../../../../../../../../packages/contracts/src/automation-studio-client';
import type { StudioCapabilities, StudioDefinition } from '../../../../../../../../packages/contracts/src/automation-studio';
import { useAgentText } from '../../i18n';
import styles from './studio-transfer.module.css';

export async function downloadStudioDefinition(workspaceId: string, definitionId: string, format: 'bundle' | 'source' = 'bundle'): Promise<void> {
  const result = await new AutomationTransferClient(workspaceId).export(definitionId, format);
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.document, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function StudioImport({ workspaceId, projectId, actorId, membershipVersion, onClose, onImported, onDirtyChange }: { workspaceId: string; projectId: string; actorId: string; membershipVersion?: number; onClose: () => void; onImported: (definition: StudioDefinition) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const t = useAgentText(), client = useMemo(() => new AutomationTransferClient(workspaceId), [workspaceId]);
  const [document, setDocument] = useState<unknown>(), [filename, setFilename] = useState(''), [preview, setPreview] = useState<AutomationTransferPreview | null>(null);
  const [capabilities, setCapabilities] = useState<StudioCapabilities | null>(null), [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const storageKey = `pm-automation-import:${actorId}:${workspaceId}:${projectId}`;
  useEffect(() => {
    let active = true; dialog.current?.focus(); setDocument(undefined); setPreview(null); setProvider(''); setModel(''); setError('');
    try { setPending(localStorage.getItem(storageKey)); setStorageError(false); } catch { setPending(null); setStorageError(true); setError('Browser storage is unavailable; imports require a durable request identity.'); }
    new StudioClient(workspaceId).capabilities(projectId).then(value => { if (active) setCapabilities(value); }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [workspaceId, projectId, storageKey, membershipVersion]);
  useEffect(() => { onDirtyChange?.(document !== undefined || !!pending || busy || storageError); }, [document, pending, busy, storageError, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function forget(): boolean {
    try { localStorage.removeItem(storageKey); if (localStorage.getItem(storageKey) !== null) throw new Error(); setPending(null); setStorageError(false); return true; }
    catch { setStorageError(true); setError(t('结果已核对，但无法清理浏览器请求记录。请保留原请求 ID。', 'Outcome reconciled, but the browser request journal could not be cleared. Keep the original request ID.')); return false; }
  }
  function completed(receipt: AutomationTransferReceipt) {
    if (receipt.status === 'pending') { setError(t('导入结果仍待核对，不会创建第二份定义。', 'Import result is still pending. No second definition will be created.')); return; }
    if (!forget()) return;
    if (receipt.definition) onImported(receipt.definition); else setError(receipt.error?.message ?? t('导入被拒绝。', 'Import was rejected.'));
  }
  async function choose(file: File) {
    setError(''); setPreview(null); setDocument(undefined); setFilename(file.name);
    if (file.size > AUTOMATION_TRANSFER_LIMITS.jsonBytes) { setError(t('JSON 文件上限为 3 MiB。', 'JSON files are limited to 3 MiB.')); return; }
    try { setDocument(JSON.parse(await file.text())); } catch { setError(t('文件不是有效的 JSON。', 'The file is not valid JSON.')); }
  }
  async function validate() {
    setBusy(true); setError('');
    try { setPreview(await client.preview({ projectId, document, ...(provider ? { providerInstanceId: provider } : {}), ...(model ? { model } : {}) })); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function importDefinition() {
    if (!preview || pending) return; setBusy(true); setError('');
    const request = { requestId: crypto.randomUUID(), projectId, document, ...(provider ? { providerInstanceId: provider } : {}), ...(model ? { model } : {}) };
    try { localStorage.setItem(storageKey, request.requestId); if (localStorage.getItem(storageKey) !== request.requestId) throw new Error(); setStorageError(false); setPending(request.requestId); }
    catch { setStorageError(true); setError(t('无法持久保存请求 ID，未提交导入。', 'Request identity could not be persisted. Import was not submitted.')); setBusy(false); return; }
    try { completed(await client.import(request)); } catch (reason) {
      if (reason instanceof AutomationApiError && reason.status < 500 && reason.status !== 408 && !['idempotency_conflict', 'invalid_response'].includes(reason.code)) forget();
      setError(`${reason instanceof Error ? reason.message : String(reason)} ${t('未知结果请先核对原请求，不要重新导入。', 'For an unknown result, reconcile the original request before importing again.')}`);
    } finally { setBusy(false); }
  }
  async function reconcile() { if (!pending) return; setBusy(true); setError(''); try { const receipt = await client.receipt(pending); completed(receipt); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  const source = !!document && typeof document === 'object' && 'kind' in document && document.kind === 'automation';
  return <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={dialog} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="studio-import-title" tabIndex={-1} onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); if (event.key === 'Tab') { const nodes = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}>
    <header className={styles.header}><h2 id="studio-import-title">{t('导入自动化', 'Import automation')}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={t('关闭', 'Close')}>×</button></header>
    <p className={styles.muted}>{t('导入后仅保存草稿，不会启用或执行。', 'Imports are saved as drafts, never enabled or executed.')}</p>
    <p className={styles.muted}>{t('兼容 .automation.json 仅支持 Prompt、单仓库、单事件键。完整 .automation-bundle.json 保留全部 PM 字段和脚本文件。未知字段明确拒绝；不包含凭据。', 'Compatible .automation.json supports prompt, one repository and one event key. Complete .automation-bundle.json retains all PM fields and script files. Unknown fields are rejected; credentials are excluded.')}</p>
    <input ref={input} type="file" accept="application/json,.json" disabled={busy || !!pending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }} />
    <button type="button" className={styles.dropzone} disabled={busy || !!pending} onClick={() => input.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && !busy && !pending) void choose(file); }}>{filename || t('拖放 JSON 文件或选择文件', 'Drop a JSON file or choose a file')}</button>
    {source && <div className={styles.grid}><label>{t('本地 Provider', 'Local Provider')}<select value={provider} disabled={busy || !!pending} onChange={event => { setProvider(event.target.value); setModel(''); setPreview(null); }}><option value="">{t('明确选择', 'Select explicitly')}</option>{capabilities?.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{t('模型', 'Model')}<select value={model} disabled={busy || !!pending} onChange={event => { setModel(event.target.value); setPreview(null); }}><option value="">{t('来源模型（如存在）', 'Source model, if present')}</option>{capabilities?.providers.find(item => item.id === provider)?.models.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>}
    {preview && <section className={styles.card}><h3>{preview.config.name}</h3><dl className={styles.facts}><dt>{t('格式', 'Format')}</dt><dd>{preview.format}</dd><dt>{t('项目', 'Project')}</dt><dd>{preview.config.projectId}</dd><dt>{t('动作 / 触发', 'Action / trigger')}</dt><dd>{preview.config.action.kind} / {preview.config.trigger.kind}</dd></dl><pre className={styles.preview}>{preview.config.action.kind === 'prompt' ? preview.config.action.prompt : preview.config.action.kind === 'script' ? preview.config.action.entrypoint : JSON.stringify({ templateId: preview.config.action.templateId, arguments: preview.config.action.arguments }, null, 2)}</pre>{preview.warnings.map(warning => <p className={styles.muted} key={warning}>{warning}</p>)}{preview.validation.issues.map(issue => <p className={styles.error} key={`${issue.path}:${issue.code}`}>{issue.path}: {issue.message}</p>)}</section>}
    {error && <p className={styles.error} role="alert">{error}</p>}{pending && <p className={styles.muted}>{t('待核对请求', 'Pending request')}: <code>{pending}</code></p>}
    <footer className={styles.actions}><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>{pending ? <button type="button" disabled={busy} onClick={() => void reconcile()}>{t('核对原请求', 'Reconcile original request')}</button> : <><button type="button" disabled={busy || document === undefined} onClick={() => void validate()}>{t('验证并预览', 'Validate and preview')}</button><button type="button" disabled={busy || !preview} onClick={() => void importDefinition()}>{busy ? t('导入中…', 'Importing…') : t('导入为草稿', 'Import as draft')}</button></>}</footer>
  </div></div>;
}
