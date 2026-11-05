import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, CommandOutcomeUnknown, type Command, type CommandReceipt, type Entity } from '@contracts';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePmCommand, usePmEntities, usePmService } from '../pm-service';
import { allowed, entitySchema, makeCommand, useDraftState, useText } from '../pm-ui';
import { PmCommandError, PmServiceError, pmErrorMessage } from '../pm-errors';
import { asString, fileProjectWritable } from './model';
import styles from './project-files.module.css';
import { RadixSelect } from "@/components/ui/radix-select"

export type FileLifecycleAction = { mode: 'rename' | 'hide' | 'restore' | 'copy'; artifact: Entity; version: Entity };
const savedAttemptSchema = z.strictObject({
  commandId: z.uuid(), commandType: z.enum(['RenameArtifact', 'HideArtifact', 'RestoreArtifact', 'CopyArtifactVersion']),
  targetId: z.uuid(), projectId: z.string(), expectedVersions: z.record(z.string(), z.number().int().positive()), payload: z.record(z.string(), z.unknown()),
});
function restoreAttempt(key: string): Command | null {
  try { const raw = sessionStorage.getItem(key); return raw ? savedAttemptSchema.parse(JSON.parse(raw)) as Command : null; }
  catch { return null; } // The IndexedDB journal still blocks writes for an unreadable local intent.
}

/** Local persistence contains only operation metadata, never bytes or external URLs. */
export function FileLifecycleOperations({ action, project, locale, onClose }: { action: FileLifecycleAction | null; project: Entity; locale: string; onClose: () => void }) {
  const service = usePmService();
  const command = usePmCommand();
  const t = useText();
  const navigate = useNavigate();
  const scope = `file-lifecycle:${project.id}`;
  const key = `pm-${scope}:${service.actor?.id ?? ''}:${service.workspace?.id ?? ''}`;
  const [attempt, setAttempt] = useDraftState<Command | null>(scope, 'attempt', () => restoreAttempt(key));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const handled = useRef<string | null>(null);
  const [settling, setSettling] = useState(false);

  function clearAttempt(id: string) {
    try { sessionStorage.removeItem(key); } catch { /* A stale intent can only re-query this original receipt. */ }
    setAttempt(previous => previous?.commandId === id ? null : previous);
  }
  function acceptReceipt(receipt: CommandReceipt) {
    if (!attempt || receipt.commandId !== attempt.commandId || handled.current === receipt.commandId) return;
    handled.current = receipt.commandId;
    clearAttempt(receipt.commandId);
    if (receipt.status !== 'committed') { setRecoveryError(t('原命令已拒绝；未重新执行。', 'The original command was rejected; it was not repeated.')); return; }
    if (attempt.commandType === 'CopyArtifactVersion') {
      const result = z.object({ artifact: entitySchema, artifactVersion: entitySchema }).parse(receipt.result);
      navigate(`/pm/${service.workspace!.id}/projects/${result.artifact.projectId}?tab=files&file=${result.artifactVersion.id}`);
    }
    onClose();
  }
  useEffect(() => {
    if (command.receipt && command.unknownCommand?.commandId !== command.receipt.commandId) acceptReceipt(command.receipt);
  }, [command.receipt, command.unknownCommand, attempt]);

  async function reconcile() {
    if (!attempt || !service.workspace) return;
    setSettling(true); setRecoveryError(null);
    try {
      const receipt = command.unknownCommand?.commandId === attempt.commandId ? await command.reconcile() : await service.client.getCommandReceipt(service.workspace.id, attempt.commandId);
      if (receipt) acceptReceipt(receipt);
      else setRecoveryError(t('原结果暂不可查询；403或404都不证明未提交。保留原命令编号并继续核对，不要换编号重做。', 'The original result is temporarily inaccessible. Neither 403 nor 404 proves it was not committed. Retain its command ID and continue reconciliation; do not repeat under a new ID.'));
    } catch (error) {
      setRecoveryError(error instanceof ApiError && [403, 404].includes(error.status)
        ? t('原结果暂不可查询；这不代表未提交。保留原命令编号，恢复合法权限后继续核对，禁止新编号复制。', 'The original result is temporarily inaccessible; this does not mean it was not committed. Retain its command ID and reconcile after legitimate access is restored. Do not copy under a new ID.')
        : pmErrorMessage(error, locale === 'en' ? 'en' : 'zh'));
    } finally { setSettling(false); }
  }
  async function execute(request: Command) {
    // Failure to preserve recovery intent must precede any write request.
    try { sessionStorage.setItem(key, JSON.stringify(savedAttemptSchema.parse(request))); }
    catch { throw new PmServiceError('recovery_storage_unavailable'); }
    handled.current = null;
    setAttempt(request);
    try {
      const receipt = await command.execute(request);
      if (receipt.status !== 'committed') throw new PmServiceError(receipt.error.code);
      handled.current = request.commandId;
      clearAttempt(request.commandId);
      if (request.commandType === 'CopyArtifactVersion') {
        const result = z.object({ artifact: entitySchema, artifactVersion: entitySchema }).parse(receipt.result);
        navigate(`/pm/${service.workspace!.id}/projects/${result.artifact.projectId}?tab=files&file=${result.artifactVersion.id}`);
      }
      onClose();
    } catch (error) {
      if (!(error instanceof CommandOutcomeUnknown)) clearAttempt(request.commandId);
      throw error;
    }
  }
  const recovery = attempt ? <section className={styles.errorPanel} aria-label={t('文件原请求恢复', 'Original file request recovery')}>
    <p>{t('正在等待或核对原文件命令。不要重建请求或重新复制。', 'Await or reconcile the original file command. Do not recreate the request or repeat the copy.')}</p>
    <code className={styles.digest}>{attempt.commandId}</code>
    {recoveryError && <p role="alert">{recoveryError}</p>}
    <Button size="sm" variant="outline" disabled={command.pending || settling} onClick={() => { void reconcile(); }}>{t('核对原命令', 'Check original command')}</Button>
  </section> : null;
  return <>{recovery}{recoveryError && <p role="alert" className={styles.warning}>{recoveryError}</p>}{action && <LifecycleDialog key={`${action.mode}:${action.artifact.id}:${action.version.id}`} action={action} project={project} locale={locale} onClose={onClose} execute={execute} suspended={!!attempt} />}</>;
}

function LifecycleDialog({ action, project, locale, onClose, execute, suspended }: { action: FileLifecycleAction; project: Entity; locale: string; onClose: () => void; execute: (command: Command) => Promise<void>; suspended: boolean }) {
  const service = usePmService();
  const command = usePmCommand();
  const projects = usePmEntities('project');
  const t = useText();
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [base, setBase] = useState(action.artifact);
  const [title, setTitle] = useState(asString(action.artifact.data.title));
  const [kind, setKind] = useState(asString(action.artifact.data.kind));
  const [destination, setDestination] = useState<Entity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Entity | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => {
    const receipt = command.receipt;
    if (!requestId || receipt?.commandId !== requestId || receipt.status !== 'rejected') return;
    setError(['object_archived', 'invalid_state'].includes(receipt.error.code) ? t('目标项目已归档或关闭；请先恢复／重开项目，或为复制明确选择另一个可写目标。', 'The target project is archived or closed. Restore or reopen it first, or explicitly select another writable copy destination.') : pmErrorMessage(new ApiError(receipt.httpStatus, { error: receipt.error }), locale === 'en' ? 'en' : 'zh'));
    if (['version_conflict', 'artifact_hidden', 'object_archived', 'invalid_state'].includes(receipt.error.code)) {
      setConflict(true);
      void readCurrent().catch(() => undefined);
    }
  }, [command.receipt, requestId]);
  const copy = action.mode === 'copy';
  const labels = {
    rename: t('修改显示名', 'Rename display title'), hide: t('隐藏文件', 'Hide file'),
    restore: t('恢复原文件', 'Restore original file'), copy: t('复制所选版本', 'Copy selected version'),
  };
  const targets = (projects.data ?? []).filter(candidate => fileProjectWritable(candidate) && allowed(service.workspace, 'domain.read', candidate.id) && allowed(service.workspace, 'delivery.write', candidate.id));
  const canWrite = service.capabilities?.business.enabled === true && (copy ? !!destination && fileProjectWritable(destination) && allowed(service.workspace, 'delivery.write', destination.id) && service.capabilities.storage.enabled : fileProjectWritable(project) && allowed(service.workspace, 'delivery.write', project.id) && (action.mode !== 'rename' || base.data.hiddenAt === null));
  const locked = command.pending || !!command.unknownCommand || busy;
  async function readCurrent() {
    if (!service.workspace) throw new PmServiceError('session_changed');
    const fresh = await service.client.getEntity(service.workspace.id, base.id);
    setCurrent(fresh);
    return fresh;
  }
  async function rebase() {
    setBusy(true); setError(null);
    try {
      const fresh = await readCurrent();
      const target = copy && destination ? await service.client.getEntity(service.workspace!.id, destination.id) : null;
      setBase(fresh);
      if (copy) setDestination(target);
      setConflict(false);
    } catch (error) { setError(pmErrorMessage(error, locale === 'en' ? 'en' : 'zh')); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!canWrite || locked || conflict) return;
    setBusy(true); setError(null);
    try {
      const titleValue = z.string().trim().min(1).max(20_000).parse(title);
      const request = copy
        ? makeCommand('CopyArtifactVersion', { targetTitle: titleValue, targetKind: z.string().trim().min(1).max(100).parse(kind) }, action.version, destination!.id, [base, destination!])
        : action.mode === 'rename' ? makeCommand('RenameArtifact', { title: titleValue }, base, project.id)
        : action.mode === 'hide' ? makeCommand('HideArtifact', {}, base, project.id)
        : makeCommand('RestoreArtifact', {}, base, project.id);
      setRequestId(request.commandId);
      await execute(request);
    } catch (error) {
      setError(error instanceof z.ZodError ? t('显示名必填，最多20,000字符；类型最多100字符。', 'Title is required (up to 20,000 characters); kind is limited to 100 characters.') : error instanceof PmCommandError && ['object_archived', 'invalid_state'].includes(error.code) ? t('目标项目已归档或关闭；请先恢复／重开项目，或为复制明确选择另一个可写目标。', 'The target project is archived or closed. Restore or reopen it first, or explicitly select another writable copy destination.') : pmErrorMessage(error, locale === 'en' ? 'en' : 'zh'));
      if (error instanceof PmCommandError && ['version_conflict', 'artifact_hidden', 'object_archived', 'invalid_state'].includes(error.code)) {
        setConflict(true);
        void readCurrent().catch(() => undefined);
      }
    } finally { setBusy(false); }
  }
  return <Dialog open={!suspended} onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <DialogContent className={styles.uploadDialog} finalFocus={opener}>
      <DialogTitle>{labels[action.mode]}</DialogTitle>
      <DialogDescription>{copy ? t('创建独立的新成果，只复制当前明确选定版本的字节，不复制证据、审核或历史。', 'Create an independent artifact from this exact selected version, without copying evidence, reviews or history.') : t('只修改成果元数据，不改写任何历史版本、原文件名或证据。', 'Only artifact metadata changes. Historical versions, original filenames and evidence remain unchanged.')}</DialogDescription>
      <form className={styles.dialogBody} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p className={styles.hint}>{t('原文件名', 'Original filename')}: {asString(action.version.data.fileName)} · <code>{action.version.id}</code></p>
        {(copy || action.mode === 'rename') && <label className={styles.field}><span>{t('显示名', 'Display title')}</span><Input value={title} maxLength={20_000} required disabled={locked} onChange={event => setTitle(event.target.value)} /></label>}
        {copy && <>
          <label className={styles.field}><span>{t('目标项目', 'Target project')}</span><RadixSelect className={styles.formSelect} value={destination?.id ?? ''} disabled={locked} required onChange={event => { setDestination(targets.find(candidate => candidate.id === event.target.value) ?? null); }}><option value="">{t('选择可写项目', 'Choose a writable project')}</option>{targets.map(candidate => <option key={candidate.id} value={candidate.id}>{asString(candidate.data.name)} · {candidate.id}</option>)}</RadixSelect></label>
          <label className={styles.field}><span>{t('成果类型', 'Artifact kind')}</span><Input value={kind} maxLength={100} required disabled={locked} onChange={event => setKind(event.target.value)} /></label>
          <p className={styles.warning}>{t('目标项目读者将获得该版本内容。', 'Readers of the target project will gain access to this version’s contents.')} {destination && `${asString(destination.data.name)} (${destination.id})`}</p>
          {projects.error && <p role="alert">{projects.error.message}</p>}
        </>}
        {action.mode === 'hide' && <p className={styles.warning}>{t('仅从默认文件列表隐藏，不撤销下载权限；历史 Evidence、提交、审核和版本链接仍可访问，不会物理删除文件。', 'Hide from the default file list only. Download access is not revoked; historical evidence, submissions, reviews and version links remain accessible. No file is physically deleted.')}</p>}
        {action.mode === 'restore' && <p className={styles.hint}>{t('恢复同一 Artifact ID 和原版本链：', 'Restore the same artifact ID and version history: ')}<code>{base.id}</code></p>}
        {conflict && <div role="alert" className={styles.warning}><p>{t('基线已变化；输入已保留。', 'The baseline changed; your input is retained.')} {current && `${t('当前显示名', 'Current title')}: ${asString(current.data.title)} · v${current.version}`}</p><Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void rebase(); }}>{t('核对并采用当前基线（保留输入）', 'Review and adopt current baseline (retain input)')}</Button></div>}
        {!canWrite && <p className={styles.warning}>{action.mode === 'rename' && base.data.hiddenAt !== null ? t('成果已隐藏，请先恢复原成果再修改显示名；输入仍保留。', 'This artifact is hidden. Restore the original artifact before renaming it; your input is retained.') : t('需要当前可写项目与交付权限；复制另需可用的真实存储。已归档或关闭的目标项目必须先恢复／重开。', 'A writable project and delivery permission are required; copying also requires real storage. Restore or reopen an archived or closed target project first.')}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.formActions}><DialogClose render={<Button variant="outline" disabled={locked} />}>{t('取消', 'Cancel')}</DialogClose><Button type="submit" disabled={!canWrite || locked || conflict}>{labels[action.mode]}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
