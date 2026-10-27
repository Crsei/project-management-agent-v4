import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n-provider';
import { usePmCommand, usePmService } from './pm-service';

/** Resume storage work, then read the original real PM receipt; never synthesize one. */
export function LocalProjectCommandRecovery({ commandId }: { commandId: string }) {
  const service = usePmService();
  const command = usePmCommand();
  const en = useI18n().locale === 'en';
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const latest = useRef(service);
  latest.current = service;
  const canRecover = !!service.workspace && service.workspace.projectIds === null && service.workspace.capabilities.includes('access.manage') && service.workspace.capabilities.includes('planning.edit');
  async function recover() {
    if (running.current || !canRecover || !service.workspace || command.unknownCommand?.commandId !== commandId || command.unknownCommand.commandType !== 'CreateProject') return;
    running.current = true; setBusy(true); setMessage('');
    const actorId = service.actor?.id;
    const epoch = service.actorEpoch;
    try {
      const result = await service.client.localProjects.recover(service.workspace.id, commandId);
      if (!active.current || latest.current.actor?.id !== actorId || latest.current.actorEpoch !== epoch) return;
      if (result.status !== 'ready') setMessage(result.status === 'pending' ? `${en ? 'Original storage initialization remains pending' : '原存储初始化仍待核对'}: ${result.reason}` : en ? 'No ready local initialization is confirmed. The original PM command and key remain retained.' : '尚无已就绪的本地初始化事实；原 PM 命令与请求键继续保留。');
      await command.reconcile();
    } catch (cause) { if (active.current && latest.current.actor?.id === actorId && latest.current.actorEpoch === epoch) setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (active.current) setBusy(false); }
  }
  return <div className="space-y-2">
    <p>{en ? 'Local project initialization has its own recoverable steps. Resume only the original command ID; its PM receipt remains the command outcome authority.' : '本地项目初始化有独立可恢复步骤。这里只恢复原 commandId；命令结果仍以原 PM 命令收据为准。'}</p>
    <Button variant="outline" disabled={!canRecover || busy || command.pending} onClick={() => { void recover(); }}>{busy ? en ? 'Recovering original project initialization…' : '正在恢复原项目初始化…' : en ? 'Recover original project storage, then check PM receipt' : '恢复原项目存储并核对 PM 收据'}</Button>
    {!canRecover && <p>{en ? 'Unrestricted storage management and planning-edit permissions are required; the original command is retained.' : '恢复需要工作区全局存储管理与计划编辑权限；原命令已保留。'}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
