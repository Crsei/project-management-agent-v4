import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBeforeUnload, useBlocker, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { DovspaceLoading } from '@/components/dovspace-brand';
import { useWorkspaceStore } from '@/providers/app-providers';
import { usePmService } from './pm-service';
import { ServiceGuard, useAction, useText } from './pm-ui';
import { SettingsProfile } from './settings/settings-profile';
import { OnboardingAi } from './pm-onboarding-ai';
import { useOnboarding } from './pm-onboarding-state';
import styles from './pm-onboarding.module.css';

type Step = 'profile' | 'ai' | 'finish';

export function PmOnboarding() {
  return <ServiceGuard><Guide /></ServiceGuard>;
}

function Guide() {
  const { actor, actorEpoch, workspace } = usePmService();
  const onboarding = useOnboarding();
  const command = useAction();
  const navigate = useNavigate();
  const startPage = useWorkspaceStore(state => state.startPage);
  const t = useText();
  const [step, setStep] = useState<Step | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const installing = useRef(false);
  const onInstallBusyChange = useCallback((busy: boolean) => {
    installing.current = busy;
    setInstallBusy(busy);
  }, []);
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }: {
    currentLocation: { pathname: string; search: string; hash: string };
    nextLocation: { pathname: string; search: string; hash: string };
  }) => installing.current && (currentLocation.pathname !== nextLocation.pathname
    || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash), []));
  useEffect(() => { if (blocker.state === 'blocked') blocker.reset(); }, [blocker]);
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (!installing.current) return;
    event.preventDefault();
    event.returnValue = '';
  }, []), { capture: true });
  useEffect(() => { setStep(null); }, [actor?.id, actorEpoch, workspace?.id]);
  const state = onboarding.data;
  const active = step ?? (!state || state.profile === 'pending' ? 'profile' : state.ai === 'pending' ? 'ai' : 'finish');
  if (!actor || !workspace) return null;
  const root = `/pm/${encodeURIComponent(workspace.id)}`;
  const selected = state?.workspaceId === workspace.id;
  const canVisitAi = !!state && state.profile !== 'pending';
  const canVisitFinish = canVisitAi && state?.ai !== 'pending';
  async function advance(action: 'review-profile' | 'skip-profile' | 'review-ai' | 'skip-ai' | 'finish', next?: Step) {
    if (command.locked || installing.current) return;
    if ((action === 'skip-profile' && state?.profile === 'reviewed') || (action === 'skip-ai' && state?.ai === 'reviewed')) {
      if (next) setStep(next);
      return;
    }
    const result = await onboarding.update(action);
    if (!result) return;
    if (action === 'finish') navigate(`${root}/${startPage}`, { replace: true });
    else if (next) setStep(next);
  }
  return <main className={styles.page}>
    <div className={styles.shell}>
      <aside className={styles.rail} aria-label={t('引导进度', 'Guide progress')}>
        <p className={styles.eyebrow}>{t('开始使用', 'GET STARTED')}</p>
        <h1>{t('打造你的工作空间', 'Make this workspace yours')}</h1>
        <p>{t('按照自己的节奏完成设置，进度会自动保存。', 'Set things up at your own pace. Your progress is saved.')}</p>
        <ol>{([{ id: 'profile', label: t('个人资料', 'Your profile'), enabled: true }, { id: 'ai', label: t('AI 配置', 'AI setup'), enabled: canVisitAi }, { id: 'finish', label: t('准备就绪', 'Ready to go'), enabled: canVisitFinish }] as const).map((item, index) => <li key={item.id}><button type="button" disabled={!item.enabled || onboarding.busy || command.locked || installBusy} aria-current={active === item.id ? 'step' : undefined} onClick={() => { if (!installing.current) setStep(item.id); }}><span>{index + 1}</span>{item.label}</button></li>)}</ol>
        <Link to={`${root}/${startPage}`} aria-disabled={installBusy || undefined} tabIndex={installBusy ? -1 : undefined} onClick={event => { if (installing.current) event.preventDefault(); }}>{t('返回工作区', 'Back to workspace')}</Link>
        {installBusy && <p role="status">{t('正在安装并核对 Skills，请等待操作完成后切换步骤或离开。', 'Skills are being installed and reconciled. Wait before changing steps or leaving.')}</p>}
      </aside>
      <section className={styles.content}>
        {onboarding.isPending || (!state && onboarding.isFetching) ? <DovspaceLoading message={t('正在读取进度…', 'Loading your progress…')} /> : onboarding.error ? <div role="alert"><p>{t('无法读取引导进度。', 'Unable to read guide progress.')}</p><Button variant="outline" onClick={() => { void onboarding.refetch(); }}>{t('重试', 'Retry')}</Button></div> : !selected ? <div><h2>{t('使用此工作区？', 'Use this workspace?')}</h2><p>{t('确认将当前工作区用于引导。', 'Confirm this workspace for your guide.')}</p><Button disabled={onboarding.busy} onClick={() => { void onboarding.update('select-workspace', workspace.id); }}>{t('确认工作区', 'Confirm workspace')}</Button> <Link to="/pm?pick=1">{t('选择其他工作区', 'Choose another workspace')}</Link></div> : <>
          {active === 'profile' && <><p className={styles.eyebrow}>{t('第一步', 'STEP 1')}</p><h2>{t('如何介绍你自己？', 'How would you like to introduce yourself?')}</h2><p>{t('编辑并保存你的个人资料，或稍后再来。', 'Edit and save your profile, or come back later.')}</p><SettingsProfile mode="service" />{command.locked && <p role="status">{t('请先核对尚未确认的原操作。', 'Reconcile the original pending action before continuing.')}</p>}<div className={styles.actions}><Button variant="outline" disabled={onboarding.busy || command.locked} onClick={() => { void advance('skip-profile', 'ai'); }}>{t('暂时跳过', 'Skip for now')}</Button><Button disabled={onboarding.busy || command.locked} onClick={() => { void advance('review-profile', 'ai'); }}>{t('已查看，继续', 'Reviewed, continue')}</Button></div></>}
          {active === 'ai' && <><p className={styles.eyebrow}>{t('第二步', 'STEP 2')}</p><h2>{t('准备好使用 AI 了吗？', 'Ready to use AI?')}</h2><OnboardingAi key={`${actor.id}:${actorEpoch}:${workspace.id}`} busy={onboarding.busy || command.locked} onInstallBusyChange={onInstallBusyChange} returnTo={`${root}/onboarding`} onContinue={configured => { void advance(configured ? 'review-ai' : 'skip-ai', 'finish'); }} /><div className={styles.actions}><Button variant="outline" disabled={onboarding.busy || command.locked || installBusy} onClick={() => { if (!installing.current) setStep('profile'); }}>{t('上一步', 'Previous')}</Button></div></>}
          {active === 'finish' && <><p className={styles.eyebrow}>{t('最后一步', 'FINAL STEP')}</p><h2>{t('准备开始了吗？', 'Ready to get started?')}</h2><p>{t('你可以随时从账号菜单重新打开引导。跳过的设置可稍后完成。', 'You can reopen this guide from the account menu and complete skipped settings later.')}</p><div className={styles.actions}><Button variant="outline" disabled={onboarding.busy} onClick={() => setStep('ai')}>{t('上一步', 'Previous')}</Button><Button disabled={onboarding.busy} onClick={() => { void advance('finish'); }}>{t('进入工作区', 'Enter workspace')}</Button></div></>}
        </>}
        {onboarding.actionError && <p role="alert" className={styles.error}>{onboarding.actionError}</p>}
      </section>
    </div>
  </main>;
}
