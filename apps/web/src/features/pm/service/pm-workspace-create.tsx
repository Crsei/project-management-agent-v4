import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { WorkspaceCreationResult } from '@contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspaceStore } from '@/providers/app-providers';
import { withCreationLock } from '../markdown/creation-store';
import { usePmService } from './pm-service';
import { useText } from './pm-ui';
import { decodeWorkspaceCreationDraft, prepareWorkspaceCreation, runWorkspaceCreation, workspaceCreationStorageKey, type WorkspaceCreationDraft } from './workspace-creation-model';

export function PmWorkspaceCreate() {
  const service = usePmService();
  const t = useText();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const startPage = useWorkspaceStore(state => state.startPage);
  const uid = useId();
  const formId = `${uid}-form`;
  const actorId = service.actor?.id;
  const storageKey = actorId ? workspaceCreationStorageKey(window.location.origin, actorId) : '';
  const initializationPending = (service.workspaceInitializations?.length ?? 0) > 0;
  const createRequested = searchParams.get('create') === '1';
  const [open, setOpen] = useState(createRequested);
  const [draft, setDraft] = useState<WorkspaceCreationDraft | null>(null);
  const [name, setName] = useState('');
  const [includeSample, setIncludeSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageFailed, setStorageFailed] = useState(false);
  const [outcome, setOutcome] = useState<WorkspaceCreationResult | null>(null);
  const sending = useRef(false);
  const active = useRef(true);
  const current = useRef(service);
  current.current = service;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (createRequested) setOpen(true); }, [createRequested]);
  useEffect(() => {
    if (!actorId) return;
    const read = () => {
      try {
        const saved = decodeWorkspaceCreationDraft(localStorage.getItem(storageKey));
        setDraft(saved);
        if (saved) {
          setName(saved.name);
          setIncludeSample(saved.includeSample);
          setOpen(true);
        }
        setStorageFailed(false);
      } catch {
        setStorageFailed(true);
      }
    };
    read();
    const changed = (event: StorageEvent) => { if (event.key === storageKey) read(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [actorId, storageKey]);

  if (!service.actor) return null;

  const submissionBlocked = busy || storageFailed || service.loading || initializationPending;
  const changeOpen = (next: boolean) => {
    if (!next && busy) return;
    setOpen(next);
    if (!next && createRequested) navigate('/pm?pick=1', { replace: true });
  };

  async function act(mode: 'create' | 'check' | 'recover') {
    if (sending.current || !service.actor || storageFailed) return;
    if (mode === 'create' && (service.loading || initializationPending)) return;
    const capturedActorId = service.actor.id;
    const epoch = service.actorEpoch;
    const isCurrent = () => active.current && current.current.actor?.id === capturedActorId && current.current.actorEpoch === epoch;
    sending.current = true; setBusy(true); setError('');
    try {
      await withCreationLock(storageKey, async () => {
        if (!isCurrent()) return;
        let original = decodeWorkspaceCreationDraft(localStorage.getItem(storageKey));
        if (mode === 'create') {
          original = prepareWorkspaceCreation(localStorage, storageKey, { key: crypto.randomUUID(), name, includeSample });
          setDraft(original); setName(original.name); setIncludeSample(original.includeSample);
          if (original.name !== name.trim() || original.includeSample !== includeSample) throw new Error(t('已保留另一个原创建请求，请先核对。', 'Another original creation request is retained. Reconcile it first.'));
        }
        if (!original) throw new Error(t('原创建记录不可用，未发送请求。', 'The original creation record is unavailable; no request was sent.'));
        const settled = await runWorkspaceCreation(service.client, mode, original, capturedActorId, isCurrent);
        if (!isCurrent()) return;
        setOutcome(settled);
        if (settled.status === 'ready') {
          await service.refresh();
          if (!isCurrent()) return;
          localStorage.removeItem(storageKey);
          setDraft(null);
          setOpen(false);
          navigate(`/pm/${encodeURIComponent(settled.workspaceId)}/${startPage}`);
        }
      });
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; if (active.current) setBusy(false); }
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button variant="outline" className="h-auto min-h-[68px] w-full justify-start gap-3 rounded-xl border-dashed px-4 text-left" />}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-surface text-muted-foreground" aria-hidden="true">
        <Plus className="size-4" strokeWidth={1.75} />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-sm font-medium">{draft ? t('继续创建工作区', 'Resume workspace creation') : t('新建工作区', 'New workspace')}</span>
        <span className="text-[13px] font-normal leading-5 text-muted-foreground">{draft ? t('核对或恢复原创建请求', 'Reconcile or resume the original request') : t('创建一个独立的协作空间', 'Create a separate collaboration space')}</span>
      </span>
    </DialogTrigger>
    <DialogContent className="max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{t('创建工作区', 'Create workspace')}</DialogTitle>
        <DialogDescription>{t('创建独立空间，用于管理项目、成员和 Agent 会话。', 'Create an independent space for projects, members, and Agent sessions.')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pt-4">
        {draft ? <div className="space-y-2">
          <p className="text-sm leading-6 text-muted-foreground">{t('原创建请求已保存；结果未知时不能换键重建。', 'The original creation request is saved. An unknown outcome never permits a replacement key.')}</p>
          <p className="break-all rounded-control border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">{draft.key}</p>
          <p className="text-[13px] leading-5 text-muted-foreground">{draft.name} · {draft.includeSample ? t('包含 Nova 示例项目', 'With Nova sample') : t('不包含示例项目', 'Without sample')}</p>
        </div> : <>
          <form id={formId} className="space-y-5" onSubmit={event => { event.preventDefault(); void act('create'); }}>
            <div className="grid gap-1.5">
              <label htmlFor={`${uid}-name`} className="text-sm font-medium">{t('工作区名称', 'Workspace name')}</label>
              <Input id={`${uid}-name`} className="h-10" required maxLength={200} value={name} disabled={submissionBlocked} autoFocus placeholder={t('例如：产品团队', 'e.g. Product team')} onChange={event => setName(event.target.value)} />
            </div>
            <label className="flex cursor-pointer items-start gap-3">
              <Checkbox className="mt-0.5" checked={includeSample} disabled={submissionBlocked} onCheckedChange={setIncludeSample} />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{t('创建示例项目', 'Create a sample project')}</span>
                <span className="text-[13px] leading-5 text-muted-foreground">{t('添加一个 Nova 示例项目，帮助快速体验 Dovspace。', 'Add a Nova sample project to explore Dovspace quickly.')}</span>
              </span>
            </label>
          </form>
          {initializationPending && <p role="status" className="text-[13px] leading-5 text-muted-foreground">{t('请先恢复已记录的工作区初始化，再开始新的创建请求。', 'Resume the recorded workspace initialization before starting another creation request.')}</p>}
        </>}
        {busy && <p role="status" className="text-[13px] leading-5 text-muted-foreground">{t('正在处理原工作区请求，请勿重复创建。初始化示例项目可能需要一些时间；确认完成后会进入工作区。', 'Processing the original workspace request; do not create a duplicate. Sample initialization may take some time. The workspace opens once completion is confirmed.')}</p>}
        {outcome?.status === 'not_found' && <p role="status" className="text-[13px] leading-5 text-muted-foreground">{t('暂未找到原请求；这不证明请求未到达。保留原键，可显式恢复同一请求。', 'No original record is confirmed yet; that does not prove the request never arrived. Keep its key and explicitly resume the same request.')}</p>}
        {outcome?.status === 'pending' && <p role="status" className="text-[13px] leading-5 text-muted-foreground">{t('工作区身份已建立，示例初始化尚未完成；请恢复原创建，不要新建替代工作区。', 'Workspace identity exists, but sample initialization is incomplete. Resume it instead of creating a replacement.')}</p>}
        {outcome?.status === 'ready' && <Link className="text-sm text-primary underline-offset-2 hover:underline" to={`/pm/${encodeURIComponent(outcome.workspaceId)}/${startPage}`}>{t('打开已创建工作区', 'Open created workspace')}</Link>}
        {storageFailed && <p role="alert" className="text-[13px] leading-5 text-destructive">{t('浏览器恢复存储不可用或记录损坏，未发送新请求。请恢复存储，不要清除未知创建记录。', 'Browser recovery storage is unavailable or corrupt. No new request was sent. Restore storage without clearing unknown creation records.')}</p>}
        {error && <p role="alert" className="break-words text-[13px] leading-5 text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {draft ? <>
          <Button variant="ghost" disabled={busy} onClick={() => changeOpen(false)}>{t('关闭', 'Close')}</Button>
          <Button variant="outline" disabled={busy || storageFailed} onClick={() => { void act('check'); }}>{t('核对原请求', 'Check original')}</Button>
          <Button disabled={busy || storageFailed} loading={busy} onClick={() => { void act('recover'); }}>{t('恢复原创建', 'Resume creation')}</Button>
        </> : <>
          <Button variant="ghost" disabled={busy} onClick={() => changeOpen(false)}>{t('取消', 'Cancel')}</Button>
          <Button type="submit" form={formId} loading={busy} disabled={submissionBlocked || !name.trim()}>{t('创建工作区', 'Create workspace')}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
