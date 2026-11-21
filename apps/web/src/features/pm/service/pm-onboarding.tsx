import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBeforeUnload, useBlocker, useNavigate } from 'react-router';
import { ArrowLeft, Building2, Check, CircleCheck, Compass, Rocket, Sparkles, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DovspaceLoading } from '@/components/dovspace-brand';
import { GuidedTour, type GuidedTourStep } from '@/components/guided-tour';
import { useWorkspaceStore } from '@/providers/app-providers';
import { usePmService } from './pm-service';
import { ServiceGuard, useAction, useText } from './pm-ui';
import { SettingsProfile } from './settings/settings-profile';
import { OnboardingAi, useOnboardingAiStatus } from './pm-onboarding-ai';
import { useOnboarding } from './pm-onboarding-state';
import styles from './pm-onboarding.module.css';

type Step = 'profile' | 'ai' | 'finish';

const tourTarget = (name: string) => () => document.querySelector(`[data-tour="${name}"]`);

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
  const [tourOpen, setTourOpen] = useState(false);
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
  useEffect(() => { setStep(null); setTourOpen(false); }, [actor?.id, actorEpoch, workspace?.id]);
  const state = onboarding.data;
  const active = step ?? (!state || state.profile === 'pending' ? 'profile' : state.ai === 'pending' ? 'ai' : 'finish');
  // Provider facts are read-only and only needed once the profile step is
  // acknowledged. The tour and the AI step share this one read.
  const ai = useOnboardingAiStatus(!!state && state.profile !== 'pending');
  if (!actor || !workspace) return null;
  const root = `/pm/${encodeURIComponent(workspace.id)}`;
  const selected = state?.workspaceId === workspace.id;
  const canVisitAi = !!state && state.profile !== 'pending';
  const canVisitFinish = canVisitAi && state?.ai !== 'pending';
  const profileDone = !!state && state.profile !== 'pending';
  const aiDone = !!state && state.ai !== 'pending';
  const finishDone = !!state?.completedAt;
  const wizard = [
    { id: 'profile' as const, label: t('个人资料', 'Your profile'), icon: UserRound, enabled: true, done: profileDone },
    { id: 'ai' as const, label: t('AI 配置', 'AI setup'), icon: Sparkles, enabled: canVisitAi, done: aiDone },
    { id: 'finish' as const, label: t('准备就绪', 'Ready to go'), icon: Rocket, enabled: canVisitFinish, done: finishDone },
  ];
  async function advance(action: 'review-profile' | 'skip-profile' | 'review-ai' | 'skip-ai' | 'finish', next?: Step): Promise<boolean> {
    if (command.locked || installing.current) return false;
    if ((action === 'skip-profile' && state?.profile === 'reviewed') || (action === 'skip-ai' && state?.ai === 'reviewed')) {
      if (next) setStep(next);
      return true;
    }
    if (action === 'finish' && state?.completedAt) {
      navigate(`${root}/${startPage}`, { replace: true });
      return true;
    }
    const result = await onboarding.update(action);
    if (!result) return false;
    if (action === 'finish') navigate(`${root}/${startPage}`, { replace: true });
    else if (next) setStep(next);
    return true;
  }
  const tourSteps: GuidedTourStep[] = [
    {
      id: 'intro',
      title: t('用气泡走一遍设置', 'A guided pass through setup'),
      body: <p>{t('我会高亮下一步要看的区域和要点的按钮。页面仍可正常操作；按 Esc 或右上角关闭，随时退出。', 'I will highlight the next area and the control to use. The page stays usable; press Esc or close this bubble to stop at any time.')}</p>,
    },
    {
      id: 'stepper',
      target: tourTarget('onboarding-stepper'),
      placement: 'bottom',
      title: t('三步完成准备', 'Three steps'),
      body: <p>{t('个人资料 → AI 配置 → 准备就绪。已完成的步骤会出现勾选，点击任意已解锁步骤可以返回。', 'Profile → AI setup → Ready. Completed steps get a check, and any unlocked step can be reopened.')}</p>,
    },
    {
      id: 'workspace',
      target: tourTarget('onboarding-workspace'),
      placement: 'bottom',
      title: t('使用此工作区', 'Use this workspace'),
      body: <p>{selected ? t('引导已绑定到当前工作区。需要换一个工作区时，点击右侧「切换工作区」。', 'The guide is bound to this workspace. Use “Switch workspace” to change it.') : t('先确认把引导绑定到当前工作区；已填写的内容和进度会保存在你的账号下。', 'Bind the guide to this workspace. Entered details and progress are saved to your account.')}</p>,
      ...(selected ? {} : {
        nextLabel: t('使用此工作区', 'Use this workspace'),
        next: async () => !!(await onboarding.update('select-workspace', workspace.id)),
      }),
    },
    {
      id: 'profile',
      target: tourTarget('onboarding-profile'),
      placement: 'right',
      prepare: () => setStep('profile'),
      title: t('个人资料', 'Your profile'),
      body: <p>{t('姓名、岗位、电话、头像和时区都在这里。保存资料会写入账号；只查看不修改也可以继续。', 'Set your name, title, phone, avatar and time zone here. Saving writes to your account; reviewing without edits is fine too.')}</p>,
    },
    {
      id: 'profile-actions',
      target: tourTarget('onboarding-profile-actions'),
      placement: 'top',
      title: t('确认或跳过', 'Continue or skip'),
      body: <p>{t('「已查看，继续」只确认步骤，不会改资料；「暂时跳过」可以稍后再回来。两个选择都会解锁 AI 配置。', '“Reviewed, continue” only acknowledges the step; “Skip for now” can be revisited later. Either choice unlocks AI setup.')}</p>,
      ...(state?.profile === 'pending' ? {
        nextLabel: t('已查看，继续', 'Reviewed, continue'),
        next: async () => advance('review-profile', 'ai'),
        secondary: {
          label: t('暂时跳过', 'Skip for now'),
          onClick: () => advance('skip-profile', 'ai'),
        },
      } : {}),
    },
    {
      id: 'ai',
      target: tourTarget('onboarding-ai'),
      placement: 'right',
      prepare: () => { if (canVisitAi) setStep('ai'); },
      title: t('AI 配置（可选）', 'AI setup (optional)'),
      body: <p>{t('这里只读核对现有 Provider 的状态，不会自动登录或发送消息。项目、任务和文档不依赖 AI。', 'This only reads existing provider status; it never signs in or sends messages. Projects, tasks and documents do not require AI.')}</p>,
    },
    {
      id: 'ai-actions',
      target: tourTarget('onboarding-ai-actions'),
      placement: 'top',
      title: ai.configured ? t('继续使用已就绪的 AI', 'Continue with ready AI') : t('也可以稍后再配置', 'You can set this up later'),
      body: <p>{ai.status === 'loading' ? t('正在核对配置状态；完成后即可选择继续或稍后配置。', 'Checking configuration; then choose continue or set it up later.') : ai.configured ? t('已读取到启用且原生就绪的 Provider。继续只会确认步骤，不会发起模型调用。', 'An enabled, natively ready provider was detected. Continuing only acknowledges the step; no model call is made.') : t('当前没有读取到启用且就绪的 Provider。稍后配置不会影响项目、任务和文档。', 'No enabled, ready provider is currently detected. Setting this up later does not affect projects, tasks or documents.')}</p>,
      ...(state?.ai === 'pending' ? {
        nextLabel: ai.status === 'loading' ? t('正在核对…', 'Checking…') : ai.configured ? t('继续', 'Continue') : t('稍后配置 AI', 'Set up AI later'),
        nextDisabled: ai.status === 'loading',
        next: async () => {
          if (ai.status === 'loading') return false;
          return advance(ai.configured ? 'review-ai' : 'skip-ai', 'finish');
        },
        ...(ai.configured ? {
          secondary: {
            label: t('稍后配置 AI', 'Set up AI later'),
            onClick: () => advance('skip-ai', 'finish'),
          },
        } : {}),
      } : {}),
    },
    {
      id: 'finish',
      target: tourTarget('onboarding-finish'),
      placement: 'top',
      prepare: () => { if (canVisitFinish) setStep('finish'); },
      title: t('准备就绪', 'Ready to go'),
      body: <p>{selected ? t('确认后会进入工作区。首页的“开始使用”清单仍可继续未完成项，账号菜单也能重新打开引导。', 'Finish enters the workspace. The “Get started” checklist on the home page still tracks anything left, and the account menu can reopen this guide.') : t('还需要先在上方确认“使用此工作区”，才能完成引导。', 'Confirm “Use this workspace” above before finishing the guide.')}</p>,
      nextLabel: t('进入工作区', 'Enter workspace'),
      next: async () => selected ? advance('finish') : false,
    },
  ];
  return <main className={styles.page}>
    <div className={styles.frame}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>{t('开始使用', 'GET STARTED')}</p>
          <h1>{t('打造你的工作空间', 'Make this workspace yours')}</h1>
          <p className={styles.lede}>{t('按顺序完成三步设置；进度会自动保存，随时可以离开。', 'Three steps, saved as you go. Leave and continue whenever you like.')}</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="outline" size="sm" disabled={!state || onboarding.busy || installBusy} onClick={() => setTourOpen(true)}>
            <Compass aria-hidden="true" />{t('信息气泡导览', 'Guided tips')}
          </Button>
          <Link className={styles.backLink} to={`${root}/${startPage}`} aria-disabled={installBusy || undefined} tabIndex={installBusy ? -1 : undefined} onClick={event => { if (installing.current) event.preventDefault(); }}>
            <ArrowLeft aria-hidden="true" />{t('返回工作区', 'Back to workspace')}
          </Link>
        </div>
      </header>

      <nav className={styles.stepper} aria-label={t('引导进度', 'Guide progress')} data-tour="onboarding-stepper">
        <ol>
          {wizard.map((item, index) => {
            const current = active === item.id;
            const Icon = item.icon;
            return <li key={item.id} className={styles.step} data-state={item.done ? 'done' : current ? 'current' : 'upcoming'}>
              <button
                type="button"
                disabled={!item.enabled || onboarding.busy || command.locked || installBusy}
                title={!item.enabled ? t('完成当前步骤后可进入', 'Finish the current step to continue') : undefined}
                aria-current={current ? 'step' : undefined}
                onClick={() => { if (!installing.current) setStep(item.id); }}
              >
                <span className={styles.stepIcon}>{item.done ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}</span>
                <span className={styles.stepText}>
                  <span className={styles.stepName}>{item.label}</span>
                  <span className={styles.stepMeta}>{item.done ? t('已完成', 'Done') : current ? t('当前步骤', 'Current') : item.enabled ? t('待完成', 'Next') : t('完成后解锁', 'Locked')}</span>
                </span>
              </button>
              {index < wizard.length - 1 && <span className={styles.connector} aria-hidden="true" />}
            </li>;
          })}
        </ol>
      </nav>

      {installBusy && <p className={styles.busyNote} role="status">{t('正在安装并核对 Skills，请等待操作完成后切换步骤或离开。', 'Skills are being installed and reconciled. Wait before changing steps or leaving.')}</p>}

      {state && <section className={styles.workspaceCard} data-selected={selected || undefined} data-tour="onboarding-workspace" aria-label={t('使用此工作区', 'Use this workspace')}>
        <span className={styles.workspaceIcon}><Building2 aria-hidden="true" /></span>
        <div className={styles.workspaceCopy}>
          <h2>{selected ? t('使用此工作区', 'Using this workspace') : t('使用此工作区？', 'Use this workspace?')}</h2>
          <p>{selected
            ? <>{t('引导、资料确认和 AI 配置都会关联到', 'Guide progress, profile acknowledgement and AI setup are tied to ')}<strong>{workspace.name}</strong>{t('。', '.')}</>
            : t('确认把当前引导绑定到这个工作区，或选择其他工作区。', 'Bind this guide to the current workspace, or choose another one.')}</p>
        </div>
        <div className={styles.workspaceActions}>
          {selected
            ? <span className={styles.workspaceState}><CircleCheck aria-hidden="true" />{t('已使用', 'In use')}</span>
            : <Button size="sm" disabled={onboarding.busy} onClick={() => { void onboarding.update('select-workspace', workspace.id); }}>{t('使用此工作区', 'Use this workspace')}</Button>}
          <Link to="/pm?pick=1">{selected ? t('切换工作区', 'Switch workspace') : t('选择其他工作区', 'Choose another workspace')}</Link>
        </div>
      </section>}

      <section className={styles.panel} aria-live="polite">
        {onboarding.isPending || (!state && onboarding.isFetching) ? <DovspaceLoading message={t('正在读取进度…', 'Loading your progress…')} /> : onboarding.error ? <div className={styles.errorPanel} role="alert"><div><h2>{t('无法读取引导进度', 'Unable to read guide progress')}</h2><p>{t('先重试读取，避免把失败当成空进度。', 'Retry the read before treating this as empty progress.')}</p></div><Button variant="outline" onClick={() => { void onboarding.refetch(); }}>{t('重试', 'Retry')}</Button></div> : !state ? null : <>
          {active === 'profile' && <div className={styles.stepBody} data-tour="onboarding-profile">
            <p className={styles.kicker}>{t('第一步', 'STEP 1')}</p>
            <h2>{t('如何介绍你自己？', 'How would you like to introduce yourself?')}</h2>
            <p className={styles.stepLead}>{t('这些信息会显示在成员列表和任务动态中。保存后才写入账号，也可以只查看。', 'This appears in member lists and task activity. Nothing is written until you save, and reviewing is enough to continue.')}</p>
            <div className={styles.profileStep}><SettingsProfile mode="service" variant="onboarding" /></div>
            {command.locked && <p className={styles.inlineNote} role="status">{t('请先核对尚未确认的原操作。', 'Reconcile the original pending action before continuing.')}</p>}
            <div className={styles.actions} data-tour="onboarding-profile-actions">
              <Button variant="outline" disabled={onboarding.busy || command.locked} onClick={() => { void advance('skip-profile', 'ai'); }}>{t('暂时跳过', 'Skip for now')}</Button>
              <Button disabled={onboarding.busy || command.locked} onClick={() => { void advance('review-profile', 'ai'); }}>{t('已查看，继续', 'Reviewed, continue')}</Button>
            </div>
          </div>}
          {active === 'ai' && <div className={styles.stepBody}>
            <p className={styles.kicker}>{t('第二步', 'STEP 2')}</p>
            <h2>{t('准备好使用 AI 了吗？', 'Ready to use AI?')}</h2>
            <p className={styles.stepLead}>{t('连接已有 Provider，或稍后再配置；这一步不会影响项目、任务和文档。', 'Connect an existing provider or set it up later. This step does not affect projects, tasks or documents.')}</p>
            <OnboardingAi ai={ai} key={`${actor.id}:${actorEpoch}:${workspace.id}`} busy={onboarding.busy || command.locked} onInstallBusyChange={onInstallBusyChange} returnTo={`${root}/onboarding`} onContinue={configured => { void advance(configured ? 'review-ai' : 'skip-ai', 'finish'); }} />
            <div className={styles.actions}>
              <Button variant="outline" disabled={onboarding.busy || command.locked || installBusy} onClick={() => { if (!installing.current) setStep('profile'); }}>{t('上一步', 'Previous')}</Button>
            </div>
          </div>}
          {active === 'finish' && <div className={styles.stepBody} data-tour="onboarding-finish">
            <p className={styles.kicker}>{t('最后一步', 'FINAL STEP')}</p>
            <h2>{finishDone ? t('引导已完成', 'Guide complete') : t('准备开始了吗？', 'Ready to get started?')}</h2>
            <p className={styles.stepLead}>{t('检查下面的摘要后进入工作区。跳过的设置可稍后完成，账号菜单可以重新打开引导。', 'Review the summary, then enter the workspace. Skipped settings can be finished later, and the account menu can reopen this guide.')}</p>
            <dl className={styles.summary}>
              <div><dt><UserRound aria-hidden="true" />{t('个人资料', 'Profile')}</dt><dd>{state.profile === 'reviewed' ? t('已查看', 'Reviewed') : t('已跳过', 'Skipped')}</dd></div>
              <div><dt><Sparkles aria-hidden="true" />{t('AI 配置', 'AI setup')}</dt><dd>{state.ai === 'reviewed' ? t('已确认', 'Reviewed') : t('稍后配置', 'Later')}</dd></div>
              <div><dt><Building2 aria-hidden="true" />{t('工作区', 'Workspace')}</dt><dd>{selected ? workspace.name : t('尚未确认', 'Not confirmed')}</dd></div>
            </dl>
            {!selected && <p className={styles.inlineNote}>{t('请先在上方选择“使用此工作区”，再进入工作区。', 'Use this workspace above before entering.')}</p>}
            <div className={styles.actions} data-tour="onboarding-finish-actions">
              <Button variant="outline" disabled={onboarding.busy} onClick={() => setStep('ai')}>{t('上一步', 'Previous')}</Button>
              <Button disabled={onboarding.busy || !selected} title={!selected ? t('请先确认使用此工作区', 'Use this workspace first') : undefined} onClick={() => { void advance('finish'); }}>{t('进入工作区', 'Enter workspace')}</Button>
            </div>
          </div>}
        </>}
        {onboarding.actionError && <p role="alert" className={styles.error}>{onboarding.actionError}</p>}
      </section>
    </div>
    {tourOpen && <GuidedTour
      open={tourOpen}
      steps={tourSteps}
      onClose={() => setTourOpen(false)}
      labels={{
        kicker: t('信息气泡导览', 'GUIDED TIPS'),
        back: t('上一步', 'Back'),
        next: t('下一步', 'Next'),
        done: t('完成', 'Done'),
        close: t('关闭导览', 'Close guide'),
      }}
    />}
  </main>;
}
