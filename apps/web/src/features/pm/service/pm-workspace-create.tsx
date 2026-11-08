import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import type { WorkspaceCreationResult } from '@contracts';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/providers/app-providers';
import { withCreationLock } from '../markdown/creation-store';
import { usePmService } from './pm-service';
import { useText } from './pm-ui';
import { decodeWorkspaceCreationDraft, prepareWorkspaceCreation, runWorkspaceCreation, type WorkspaceCreationDraft } from './workspace-creation-model';

export function PmWorkspaceCreate() {
  const service = usePmService();
  const t = useText();
  const navigate = useNavigate();
  const startPage = useWorkspaceStore(state => state.startPage);
  const uid = useId();
  const storageKey = `pm-workspace-creation:v1:${JSON.stringify([window.location.origin, service.actor?.id])}`;
  const initializationPending = (service.workspaceInitializations?.length ?? 0) > 0;
  const [draft, setDraft] = useState<WorkspaceCreationDraft | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [outcome, setOutcome] = useState<WorkspaceCreationResult | null>(null);
  const sending = useRef(false);
  const active = useRef(true);
  const current = useRef(service);
  current.current = service;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const read = () => {
      try { const saved = decodeWorkspaceCreationDraft(localStorage.getItem(storageKey)); setDraft(saved); if (saved) setName(saved.name); setStorageFailed(false); }
      catch { setStorageFailed(true); }
    };
    read();
    const changed = (event: StorageEvent) => { if (event.key === storageKey) read(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey]);

  async function act(mode: 'create' | 'check' | 'recover') {
    if (sending.current || !service.actor || storageFailed) return;
    if (mode === 'create' && (service.loading || initializationPending)) return;
    const actorId = service.actor.id;
    const epoch = service.actorEpoch;
    const isCurrent = () => active.current && current.current.actor?.id === actorId && current.current.actorEpoch === epoch;
    sending.current = true; setBusy(true); setError('');
    try {
      await withCreationLock(storageKey, async () => {
        if (!isCurrent()) return;
        let original = decodeWorkspaceCreationDraft(localStorage.getItem(storageKey));
        if (mode === 'create') {
          original = prepareWorkspaceCreation(localStorage, storageKey, { key: crypto.randomUUID(), name });
          setDraft(original); setName(original.name);
          if (original.name !== name.trim()) throw new Error(t('已保留另一个原创建请求，请先核对。', 'Another original creation request is retained. Reconcile it first.'));
        }
        if (!original) throw new Error(t('原创建记录不可用，未发送请求。', 'The original creation record is unavailable; no request was sent.'));
        const settled = await runWorkspaceCreation(service.client, mode, original, actorId, isCurrent);
        if (!isCurrent()) return;
        setOutcome(settled);
        if (settled.status === 'ready') {
          await service.refresh();
          if (!isCurrent()) return;
          localStorage.removeItem(storageKey);
          setDraft(null);
          navigate(`/pm/${encodeURIComponent(settled.workspaceId)}/${startPage}`);
        }
      });
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; if (active.current) setBusy(false); }
  }

  return <section id="create-workspace" className="space-y-3 rounded-lg border bg-surface p-4" aria-labelledby={`${uid}-heading`}>
    <h2 id={`${uid}-heading`} className="text-sm font-medium">{t('新建工作区', 'Create workspace')}</h2>
    <p className="text-xs leading-5 text-muted-foreground">{t('创建由你管理的独立工作区，并初始化可编辑的 Nova 示例项目。不会复制其他工作区的账号、权限、凭据或历史。', 'Create an independent workspace you manage, including an editable Nova sample project. Accounts, permissions, credentials and history from other workspaces are not copied.')}</p>
    {initializationPending && !draft && <p role="status" className="text-xs leading-5">{t('请先恢复上方已记录的工作区初始化，再开始新的创建请求。', 'Resume the recorded workspace initialization above before starting another creation request.')}</p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!draft) void act('create'); }}>
      <label htmlFor={`${uid}-name`} className="grid gap-1 text-sm">{t('工作区名称（必填）', 'Workspace name (required)')}<input id={`${uid}-name`} className="min-h-10 w-full rounded-control border bg-background px-3 text-foreground" required maxLength={200} value={name} disabled={busy || !!draft || storageFailed || service.loading || initializationPending} onChange={event => setName(event.target.value)} /></label>
      {!draft && <Button type="submit" disabled={busy || storageFailed || service.loading || initializationPending || !name.trim()} loading={busy}><Plus size={15} aria-hidden="true" />{t('创建工作区与 Nova 示例', 'Create workspace with Nova')}</Button>}
    </form>
    {busy && <p role="status" className="text-xs leading-5">{t('正在处理原工作区请求，请勿重复创建。Nova 初始化可能需要一些时间；确认完成后会进入工作区。', 'Processing the original workspace request; do not create a duplicate. Nova initialization may take some time. The workspace opens once completion is confirmed.')}</p>}
    {draft && <div className="space-y-2 text-xs leading-5" role="status"><p>{t('原创建请求已保存；结果未知时不能换键重建。', 'The original creation request is saved. An unknown outcome never permits a replacement key.')} <code>{draft.key}</code></p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || storageFailed} onClick={() => { void act('check'); }}>{t('核对原请求', 'Check original request')}</Button><Button variant="outline" size="sm" disabled={busy || storageFailed} onClick={() => { void act('recover'); }}>{t('恢复原创建', 'Resume original creation')}</Button></div></div>}
    {outcome?.status === 'not_found' && <p role="status" className="text-xs leading-5">{t('暂未找到原请求；这不证明请求未到达。保留原键，可显式恢复同一请求。', 'No original record is confirmed yet; that does not prove the request never arrived. Keep its key and explicitly resume the same request.')}</p>}
    {outcome?.status === 'pending' && <p role="status" className="text-xs leading-5">{t('工作区身份已建立，Nova 初始化尚未完成；请恢复原创建，不要新建替代工作区。', 'Workspace identity exists, but Nova initialization is incomplete. Resume it instead of creating a replacement.')}</p>}
    {outcome?.status === 'ready' && <Link className="text-sm underline" to={`/pm/${encodeURIComponent(outcome.workspaceId)}/${startPage}`}>{t('打开已创建工作区', 'Open created workspace')}</Link>}
    {storageFailed && <p role="alert" className="text-xs text-destructive">{t('浏览器恢复存储不可用或记录损坏，未发送新请求。请恢复存储，不要清除未知创建记录。', 'Browser recovery storage is unavailable or corrupt. No new request was sent. Restore storage without clearing unknown creation records.')}</p>}
    {error && <p role="alert" className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{error}</p>}
  </section>;
}
