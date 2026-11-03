import { useEffect, useRef, useState } from 'react';
import type { ProviderInstance, ProvidersResponse } from '@agent-workspace/contracts/provider';
import { workspaceClient } from '@agent/src/network';
import type { DeliveryAction, DeliveryScope, DeliveryTree, TaskCodeDelivery } from '../../../../../../packages/contracts/src/task-code-delivery';
import { usePmAgentPanel } from '../agent/agent-panel-context';
import './task-code-delivery.css';
import { RadixSelect } from "@/components/ui/radix-select"

type Inspection = { delivery: TaskCodeDelivery; tree: DeliveryTree | null; taskChanged: boolean };
type Props = DeliveryScope & { revision: string; disabled: boolean; en: boolean };
export function TaskCodeDeliveryPanel(props: Props) {
  const { workspaceId, projectId, taskId, revision, disabled, en } = props;
  const panel = usePmAgentPanel();
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [providers, setProviders] = useState<ProviderInstance[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [providerWarning, setProviderWarning] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const t = (english: string, chinese: string) => en ? english : chinese;
  const v = inspection?.delivery;
  const tree = inspection?.tree;
  const provider = providers.find(p => p.instanceId === providerId);
  const blocked = busy || disabled || !!v?.pending || inspection?.taskChanged === true;
  const canDevelop = !blocked && (!v || ['ready', 'developed', 'tested'].includes(v.step));
  const inspect = (id: string) => workspaceClient.json<Inspection>(`/api/task-deliveries/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
  const load = async () => {
    const response = await workspaceClient.json<{ items: TaskCodeDelivery[] }>(`/api/task-deliveries?${new URLSearchParams({ workspaceId, projectId, taskId })}`, { signal: AbortSignal.timeout(20000) });
    return response.items[0] ? inspect(response.items[0].id) : null;
  };
  useEffect(() => {
    if (!expanded) return;
    const epoch = ++generation.current;
    setBusy(true); setError('');
    setProviderWarning('正在读取 Provider，不影响分支准备。');
    void workspaceClient.json<ProvidersResponse>('/api/providers', { signal: AbortSignal.timeout(20000) }).then(catalog => {
      if (generation.current === epoch) { setProviders(catalog.providers); setProviderWarning(''); }
    }).catch(() => { if (generation.current === epoch) setProviderWarning('Provider 读取失败或超时，请重新展开面板重试；分支准备不受影响。'); });
    void load().then(value => {
      if (generation.current !== epoch) return;
      setInspection(value); setLoaded(true);
    }).catch(reason => { if (generation.current === epoch) setError(reason instanceof Error ? reason.message : 'Delivery unavailable'); }).finally(() => { if (generation.current === epoch) setBusy(false); });
    return () => { generation.current += 1; };
    // Scope changes remount this component; closing invalidates outstanding reads.
  }, [expanded]);
  const perform = async (action: DeliveryAction) => {
    if (!v || busy) return;
    const epoch = generation.current;
    setBusy(true); setError('');
    try {
      await workspaceClient.json(`/api/task-deliveries/${encodeURIComponent(v.id)}/actions`, { method: 'POST', body: JSON.stringify(action) });
      const next = await inspect(v.id);
      if (generation.current === epoch) setInspection(next);
    } catch (reason) { if (generation.current === epoch) setError(reason instanceof Error ? reason.message : 'Delivery unavailable'); }
    finally { if (generation.current === epoch) setBusy(false); }
  };
  const prepare = async () => {
    if (!window.confirm(t('Create an independent worktree from this remote base branch? This does not commit or push.', '从指定远端基准分支创建独立开发分支与工作目录？此操作不会提交或推送。'))) return;
    const epoch = generation.current;
    setBusy(true); setError('');
    try {
      const value = await workspaceClient.json<TaskCodeDelivery>('/api/task-deliveries', { method: 'POST', body: JSON.stringify({ workspaceId, projectId, taskId, taskRevision: revision, id: requestId.current, baseBranch }) });
      const next = value.git ? await inspect(value.id) : { delivery: value, tree: null, taskChanged: false };
      if (generation.current === epoch) setInspection(next);
    } catch (reason) {
      if (generation.current === epoch) setError(reason instanceof Error ? reason.message : 'Delivery unavailable');
      // The original id is retained; never mint a fresh key after an unknown response.
    } finally { if (generation.current === epoch) setBusy(false); }
  };
  const refresh = async () => {
    if (v) return perform({ action: 'refresh' });
    setBusy(true); setError('');
    try { setInspection(await load()); setLoaded(true); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Delivery unavailable'); } finally { setBusy(false); }
  };
  return <details className="task-code-delivery" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('Code delivery · GitHub', '代码交付 · GitHub')}</summary>
    {expanded && <div className="task-delivery-content">
      <p>{t('Task → branch → Agent & tests → Draft PR → CI / review evidence. No automatic merge, deployment or task completion.', '任务 → 独立分支 → Agent 开发与测试 → Draft PR → CI／评审证据。不自动合并、部署或完成任务。')}</p>
      <small>{t('Trusted local CLI execution, not a security sandbox. Chat storage is still provisional.', '这是受信任的本机 CLI 执行，不是安全沙箱。会话与持久化仍暂沿用 Agent Chat，尚未统一设计。')}</small>
      {busy && <p role="status">{t('Loading / reconciling delivery…', '正在读取或核对交付结果…')}</p>}
      {providerWarning && <small>{providerWarning}</small>}
      {(error || v?.error) && <p role="alert">{error || v?.error}</p>}
      {disabled && <p>{t('Save task changes and check project editing access before starting.', '请先保存任务草稿，并确认项目编辑权限后再启动。')}</p>}
      {inspection?.taskChanged && <p role="alert">{t('Task revision changed. Old delivery is read-only; reconcile the requirement before continuing.', '任务版本已变化：旧交付仅可核对，不可继续开发或发布。')}</p>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>{t('Refresh / reconcile', '刷新／核对结果')}</button>
      {!v && <><label>{t('Remote base branch', '远端基准分支')}<input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="main / master" disabled={busy} /></label><button type="button" disabled={!loaded || blocked || !baseBranch.trim()} onClick={() => void prepare()}>{t('Create development branch', '创建独立开发分支')}</button></>}
      {v && <>
        <dl><dt>{t('Stage', '阶段')}</dt><dd>{v.step}{v.pending ? ` · ${v.pending.action} ${t('unconfirmed', '待确认')}` : ''}</dd><dt>{t('Branch', '分支')}</dt><dd><code>{v.git?.branch ?? '—'}</code></dd><dt>{t('Working directory', '工作目录')}</dt><dd><code>{v.git?.directory ?? '—'}</code></dd><dt>HEAD</dt><dd><code>{tree?.head ?? v.head ?? '—'}</code></dd></dl>
        <label>Provider<RadixSelect value={providerId} disabled={!canDevelop} onChange={e => { setProviderId(e.target.value); setModel(''); }}><option value="">{t('Choose a configured Provider', '选择现有 Provider')}</option>{providers.map(p => <option key={p.instanceId} value={p.instanceId} disabled={!p.enabled || !p.configured || !p.nativeSessionReady}>{p.label}{!p.enabled || !p.configured || !p.nativeSessionReady ? ` · ${t('not ready', '未就绪')}` : ''}</option>)}</RadixSelect></label>
        <label>{t('Model', '模型')}<RadixSelect value={model} disabled={!canDevelop || !provider} onChange={e => setModel(e.target.value)}><option value="">{t('Choose a model', '选择模型')}</option>{provider?.models.map(m => <option key={m.id} value={m.id} disabled={!!m.disabledReason}>{m.label}</option>)}</RadixSelect></label>
        <button type="button" disabled={!canDevelop || !model || !provider?.nativeSessionReady} onClick={() => { if (window.confirm(t('Start the selected Provider? Codex may write/test only in this task worktree; network and out-of-scope permission requests remain denied. Commit, push and PR require separate confirmation.', '使用所选 Provider 开发？仅授权此任务 worktree 写入和测试；网络与越界权限请求仍拒绝，提交／推送／PR 仍需分别确认。'))) void perform({ action: 'develop', providerInstanceId: providerId, model, ...(provider?.driver === 'codex' ? { allowWorktreeWrite: true as const } : {}) }); }}>{t('Start Agent development', '启动 Agent 开发')}</button>
        {v.generationId && <button type="button" onClick={() => { panel.openPanel({ workspaceId, projectId, taskId, title: v.title }); panel.setThreadId(v.threadId); }}>{t('View Agent conversation', '查看 Agent 会话')}</button>}
        <p>{t('Generation', 'Agent 执行')}: {v.generationStatus ?? (v.generationId ? t('Refresh for current state', '请刷新查看状态') : '—')}</p>
        <label>{t('Validation command (explicit local execution; do not enter secrets)', '验证命令（显式本机执行，勿填写秘密）')}<input value={command} onChange={e => setCommand(e.target.value)} disabled={blocked} placeholder="pnpm test" /></label>
        <button type="button" disabled={blocked || !['developed', 'tested'].includes(v.step) || !command.trim()} onClick={() => { if (window.confirm(`${t('Execute in the delivery worktree (120 second limit)?', '在交付工作目录执行以下命令（上限 120 秒）？')}\n${command}`)) void perform({ action: 'test', command, confirm: true }); }}>{t('Run validation', '运行验证')}</button>
        {v.test && <p>{t('Validation', '验证')}: {v.test.passed ? t('Passed for recorded tree', '记录版本通过') : t('Failed or changed tree', '失败或执行期间内容变化')} · exit {v.test.exitCode ?? 'unknown'} · {v.test.at}{tree?.fingerprint !== v.test.fingerprint && v.step === 'tested' ? ` · ${t('STALE', '已过期')}` : ''}</p>}
        {tree && <details><summary>{t('Review exact changed files & diff', '审查待提交文件与差异')} ({tree.files.length})</summary><ul>{tree.files.map(file => <li key={file}><code>{file}</code></li>)}</ul><pre>{tree.diff || t('No tracked diff; inspect new files in the worktree.', '无已跟踪文件差异；新增文件请在工作目录审查。')}</pre></details>}
        <div className="task-delivery-actions">
          <button type="button" disabled={blocked || v.step !== 'tested' || !v.test?.passed || !tree?.files.length || tree.fingerprint !== v.test.fingerprint} onClick={() => { if (tree && window.confirm(`${t('Commit exactly these files?', '确认提交以下全部文件？')}\n${tree.files.join('\n')}`)) void perform({ action: 'commit', fingerprint: tree.fingerprint, confirm: true }); }}>{t('Confirm commit', '确认提交')}</button>
          <button type="button" disabled={blocked || v.step !== 'committed'} onClick={() => { if (v.head && window.confirm(`${t('Push this commit to', '确认推送此提交到')} ${v.git?.owner}/${v.git?.repo} · ${v.git?.branch}\n${v.head}`)) void perform({ action: 'push', head: v.head, confirm: true }); }}>{t('Confirm push', '确认推送')}</button>
          <button type="button" disabled={blocked || v.step !== 'pushed'} onClick={() => { if (v.head && window.confirm(t('Create a Draft PR for this delivery? It will not merge or complete the task.', '确认为本次交付创建 Draft PR？不会自动合并或完成任务。'))) void perform({ action: 'draft-pr', head: v.head, confirm: true }); }}>{t('Create Draft PR', '创建 Draft PR')}</button>
        </div>
        {v.pr && <p><a href={v.pr.url} target="_blank" rel="noreferrer">Draft PR #{v.pr.number}</a> · {t('Use Refresh to fetch CI and review evidence.', '点击刷新获取 CI 与评审结果。')}</p>}
        {v.feedback && <section aria-label={t('GitHub evidence', 'GitHub 证据')}><h4>GitHub · {v.feedback.state}</h4><p>{t('Snapshot', '快照')}: {v.feedback.observedAt} · <code>{v.feedback.head}</code></p>{v.feedback.head !== v.head && <p role="alert">{t('Remote HEAD changed; local validation does not cover this version.', '远端 HEAD 已变化，本地验证不覆盖当前版本。')}</p>}{!v.feedback.checks.length ? <p>{t('No CI checks found. This is not a pass.', '未发现 CI 检查，不代表通过。')}</p> : <ul>{v.feedback.checks.map((check, i) => <li key={`${check.name}-${i}`}>{check.name}: {check.status} / {check.conclusion ?? 'pending'}</li>)}</ul>}{!v.feedback.reviews.length ? <p>{t('No reviews yet.', '暂无评审。')}</p> : <ul>{v.feedback.reviews.map(review => <li key={review.id}>{review.author}: {review.state} · {review.commit === v.feedback!.head ? t('current HEAD', '当前 HEAD') : t('older HEAD', '旧版本')}<p>{review.body}</p></li>)}</ul>}</section>}
      </>}
    </div>}
  </details>;
}
