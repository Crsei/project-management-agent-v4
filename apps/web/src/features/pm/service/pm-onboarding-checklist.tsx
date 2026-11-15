import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useOnboarding } from './pm-onboarding-state';
import { useOnboardingAiStatus } from './pm-onboarding-ai';
import { usePersonalDashboard, usePmService } from './pm-service';
import { allowed, useText } from './pm-ui';
import styles from './pm-onboarding.module.css';

export function OnboardingChecklist() {
  const { actor, workspace, capabilities } = usePmService();
  const onboarding = useOnboarding();
  const visible = !onboarding.error && !!onboarding.data && !onboarding.data.checklistDismissed;
  const personal = usePersonalDashboard(visible);
  const ai = useOnboardingAiStatus(visible);
  const t = useText();
  if (actor && workspace && onboarding.error) return <section className={styles.checklist} role="alert"><p>{t('无法读取开始使用清单。', 'Unable to read the getting started checklist.')}</p><Button variant="outline" size="sm" onClick={() => { void onboarding.refetch(); }}>{t('重试', 'Retry')}</Button></section>;
  if (!actor || !workspace || !visible || !onboarding.data) return null;
  const state = onboarding.data;
  const root = `/pm/${encodeURIComponent(workspace.id)}`;
  const profile = !personal.error && personal.data?.profile.userId === actor.id ? personal.data.profile : undefined;
  const profileStatus = `${state.profile === 'skipped' ? t('已跳过；', 'Skipped; ') : ''}${profile ? t(`当前资料：${profile.name}`, `Current profile: ${profile.name}`) : t('资料状态未知', 'Profile status unknown')}`;
  const aiStatus = `${state.ai === 'skipped' ? t('已跳过；', 'Skipped; ') : ''}${ai.status === 'loading' ? t('正在读取', 'Loading') : ai.status !== 'available' ? t('状态未知或无访问权限', 'Unknown or access unavailable') : ai.configured ? t('已检测到配置', 'Configuration detected') : t('未检测到配置', 'No configuration detected')}`;
  return <section className={styles.checklist} aria-label={t('开始使用清单', 'Getting started checklist')}>
    <div className={styles.checklistHeader}><div><h2>{t('开始使用', 'Get started')}</h2><p>{t('随时继续设置；确认不代表服务已配置或验收。', 'Continue setup any time; acknowledgements do not prove configuration or readiness.')}</p></div><Button variant="outline" size="sm" disabled={onboarding.busy} onClick={() => { void onboarding.update('dismiss-checklist'); }}>{t('关闭清单', 'Dismiss checklist')}</Button></div>
    <ul><li><Link to={`${root}/onboarding`}>{t('个人资料', 'Profile')}</Link><span>{profileStatus}</span></li><li><Link to="/pm?pick=1">{t('工作区', 'Workspace')}</Link><span>{workspace.name}</span></li><li><Link to={`${root}/onboarding`}>{t('AI 配置', 'AI setup')}</Link><span>{aiStatus}</span></li>{allowed(workspace, 'access.manage') && capabilities?.business.enabled === true && <li><Link to={`${root}/members?tab=members&panel=invitations`}>{t('成员与邀请', 'Members & invitations')}</Link><span>{t('管理成员', 'Manage members')}</span></li>}</ul>
    {onboarding.actionError && <p role="alert">{onboarding.actionError}</p>}
  </section>;
}
