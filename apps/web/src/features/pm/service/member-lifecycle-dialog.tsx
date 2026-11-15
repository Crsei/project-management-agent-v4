import { useEffect, useRef, useState } from 'react';
import type { Member, MemberHandover } from '@contracts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { usePmCommand, usePmService, usePrivateQuery } from './pm-service';
import { allowed, CommandNotice, useText } from './pm-ui';
import { pmKeys } from './pm-data';
import { MemberPicker } from './people-components';
import { usePeopleCandidates } from './people-hooks';
import { useMemberHandovers, useMemberImpact } from './member-lifecycle-hooks';

export function MemberLifecycleDialog({ userId, open, onOpenChange, onCompleted }: {
  userId: string; open: boolean; onOpenChange(open: boolean): void; onCompleted?: () => void;
}) {
  const service = usePmService();
  const command = usePmCommand();
  const t = useText();
  const impact = useMemberImpact(userId, open);
  const handovers = useMemberHandovers(userId, open);
  const manager = allowed(service.workspace, 'access.manage');
  const candidates = usePeopleCandidates({ purpose: 'team', enabled: open && manager });
  // Immediate access revocation does not depend on Markdown or handover availability.
  const members = usePrivateQuery<Member[]>([...pmKeys.workspace(window.location.origin, service.actor?.id ?? 'anonymous', service.workspace?.id ?? 'none'), 'lifecycle-members'], 'access.manage', undefined,
    (client, workspaceId, signal) => client.listMembers(workspaceId, { signal }), open && manager);
  const member = members.data?.find(item => item.userId === userId);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmedRevoke, setConfirmedRevoke] = useState(false);
  const identity = `${service.actor?.id}:${service.actorEpoch}:${service.workspace?.id}:${service.workspace?.version}:${userId}:${open}`;
  const latest = useRef(identity); latest.current = identity;
  const running = useRef(false);
  useEffect(() => { setRecipientId(null); setSelected([]); setError(''); setConfirmedRevoke(false); setBusy(false); }, [identity]);
  useEffect(() => () => { latest.current = ''; }, []);
  const snapshot = impact.error || impact.isFetching ? undefined : impact.data;
  const operations = !handovers.error && !handovers.isFetching ? handovers.data?.items : undefined;
  const uncertain = operations?.some(operation => operation.status === 'unknown') ?? false;
  const locked = busy || command.pending || !!command.unknownCommand;
  const ready = !!service.workspace && !service.error && !service.loading;
  const recipientReady = candidates.complete && !candidates.isFetching && candidates.items.some(item => item.userId === recipientId);
  async function action(work: () => Promise<void>) {
    if (running.current || !ready) return;
    running.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (cause) { if (latest.current === identity) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (latest.current === identity) setBusy(false); }
  }
  async function prepare() {
    if (!snapshot?.canHandover || !recipientId || !recipientReady || recipientId === userId || !selected.length || uncertain || !operations || locked) return;
    await action(async () => {
      await command.execute({ commandId: crypto.randomUUID(), commandType: 'PrepareMemberHandover', targetId: userId,
        expectedVersions: { [userId]: snapshot.membershipVersion }, payload: { userId, recipientId,
          items: snapshot.duties.filter(duty => selected.includes(duty.id)).map(({ id, kind, version }) => ({ id, kind, version })) } });
      if (latest.current === identity) { setSelected([]); await handovers.refetch(); }
    });
  }
  async function resume(operation: MemberHandover, reconcile: boolean) {
    if (locked || !operations || !manager || !service.workspace) return;
    const workspaceId = service.workspace.id;
    await action(async () => {
      if (reconcile) await service.client.memberLifecycle.reconcile(workspaceId, operation.id);
      else await service.client.memberLifecycle.continue(workspaceId, operation.id, operation.version);
      if (latest.current === identity) { await Promise.all([handovers.refetch(), impact.refetch()]); onCompleted?.(); }
    });
  }
  async function depart(immediate: boolean) {
    const version = immediate ? member?.version : snapshot?.membershipVersion;
    if (locked || !version || immediate && (!manager || !confirmedRevoke || members.error || members.isFetching || member?.revokedAt) || !immediate && !snapshot?.canLeave) return;
    await action(async () => {
      const receipt = await command.execute({ commandId: crypto.randomUUID(), commandType: immediate ? 'RevokeWorkspaceMember' : 'LeaveWorkspace', targetId: userId,
        expectedVersions: { [userId]: version }, payload: { userId } });
      if (receipt.status === 'committed') { onCompleted?.(); onOpenChange(false); await service.refresh(); }
    });
  }
  return <Dialog open={open} onOpenChange={next => { if (!busy && !command.pending) onOpenChange(next); }}>
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="member-lifecycle-dialog">
      <DialogTitle>{t('离开、撤权与责任交接', 'Departure, access revocation and handover')}</DialogTitle>
      <DialogDescription>{t('正常离开必须核对全部未完成职责。立即撤权不等待交接，不完成任务，不删除历史，也不代表外部执行已终止。', 'Normal departure checks all outstanding duties. Immediate revocation does not wait for handover, complete tasks, delete history, or prove external executions have stopped.')}</DialogDescription>
      <CommandNotice />
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {impact.error && <p role="alert">{impact.error.message}</p>}
      {impact.isPending && <p role="status">{t('正在读取职责…', 'Reading responsibilities…')}</p>}
      <Button variant="outline" disabled={busy || impact.isFetching} onClick={() => { void impact.refetch(); if (manager) { void members.refetch(); void handovers.refetch(); } }}>{t('重新读取影响及原操作', 'Refresh impact and original operations')}</Button>
      {snapshot && <section className="space-y-3">
        {!snapshot.scopeComplete && <div role="alert"><p>{t('范围或来源不完整，不能确认正常离开。', 'Scope or sources are incomplete; normal departure cannot be confirmed.')}</p><ul>{snapshot.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
        <h3 className="font-medium">{t('开放职责（含子任务）', 'Open responsibilities (including subtasks)')} · {snapshot.duties.length}{!snapshot.scopeComplete ? t('（部分）', ' (partial)') : ''}</h3>
        <ul className="space-y-2">{snapshot.duties.map(duty => <li key={duty.id}><label className="flex items-start gap-2">
          <input type="checkbox" checked={selected.includes(duty.id)} disabled={locked || !snapshot.canHandover || !duty.transferable} onChange={event => setSelected(ids => event.target.checked ? [...ids, duty.id] : ids.filter(id => id !== duty.id))} />
          <span>{duty.title} <small className="text-muted-foreground">{duty.kind} · {duty.id}{duty.parentId ? ` · ${t('父项', 'Parent')} ${duty.parentId}` : ''} · v{duty.version}</small></span>
        </label></li>)}</ul>
        {snapshot.canHandover && <div className="space-y-2"><MemberPicker purpose="team" value={recipientId} onChange={setRecipientId} disabled={locked || uncertain || !operations} allowUnassigned={false} label={t('责任接收人（逐项目再次校验权限）', 'Recipient (project access is rechecked for every item)')} />
          {recipientId === userId && <p role="alert">{t('请选择另一位有效成员。', 'Choose another active member.')}</p>}
          <Button disabled={locked || !recipientId || !recipientReady || recipientId === userId || !selected.length || uncertain || !operations} onClick={() => void prepare()}>{t('保存所选责任交接计划', 'Save selected handover plan')}</Button></div>}
        <p className="text-sm text-muted-foreground">{t('以下仅是可读取的既有证据：审核与本人自动化执行各最近至多100条，不代表待审批或执行已安全终止。Agent 会话和其他外部执行覆盖未知，仍须在原执行入口核对。', 'These are readable existing records: up to 100 recent reviews and 100 of your own automation executions. They do not prove approvals or executions have safely terminated. Agent sessions and other external executions remain unknown; reconcile them at their original execution entry.')}</p>
        {snapshot.evidence.length > 0 && <ul>{snapshot.evidence.map(item => <li key={item.id}>{item.source} · {item.id} · {item.status}</li>)}</ul>}
        <Button disabled={locked || !snapshot.canLeave} onClick={() => void depart(false)}>{t('确认正常离开', 'Confirm normal departure')}</Button>
      </section>}
      {manager && <section className="space-y-3 border-t pt-3">
        <h3 className="font-medium">{t('原交接操作与逐项结果', 'Original handovers and per-item outcomes')}</h3>
        {handovers.error && <p role="alert">{handovers.error.message}</p>}
        {operations?.map(operation => <article key={operation.id} className="space-y-2 rounded border p-3"><p>{operation.id} · {operation.status}</p>
          <ul>{operation.items.map(item => <li key={item.command.commandId}>{item.duty.title} · {item.state}{item.receipt?.error ? ` · ${item.receipt.error.message}` : ''}</li>)}</ul>
          <Button variant="outline" disabled={locked} onClick={() => void resume(operation, true)}>{t('核对原命令，不重放', 'Reconcile original commands, without replay')}</Button>{' '}
          <Button disabled={locked || operation.status === 'unknown' || !operation.items.some(item => item.state === 'pending')} onClick={() => void resume(operation, false)}>{t('明确继续尚未执行项', 'Explicitly continue untouched items')}</Button>
          {operation.status === 'unknown' && <p role="status">{t('结果未知；不能换请求重做或声称完成。', 'Outcome unknown: do not replace the request or claim completion.')}</p>}
        </article>)}
        <h3 className="font-medium">{t('立即撤销工作区访问', 'Immediately revoke workspace access')}</h3>
        {members.error && <p role="alert">{members.error.message}</p>}
        <label className="flex gap-2"><input type="checkbox" checked={confirmedRevoke} onChange={event => setConfirmedRevoke(event.target.checked)} disabled={locked} />{t('我确认立即撤权；未交接职责与历史保留，外部执行仍需核对。最后一位管理员受到服务端保护。', 'Revoke access now; outstanding duties and history remain, and external executions still require reconciliation. The last administrator remains protected.')}</label>
        <Button variant="destructive" disabled={locked || !ready || !confirmedRevoke || !member || !!member.revokedAt || !!members.error || members.isFetching} onClick={() => void depart(true)}>{t('立即撤权，不等待交接', 'Revoke now, without waiting for handover')}</Button>
      </section>}
    </DialogContent>
  </Dialog>;
}
