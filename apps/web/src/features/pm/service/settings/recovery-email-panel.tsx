import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useText } from '../pm-ui';
import { usePmService } from '../pm-service';
import type { AccountSecurityState } from './use-account-security';

export function RecoveryEmailPanel({security}:{security:AccountSecurityState}) {
  const t = useText(), id = useId(), service = usePmService();
  const [email,setEmail] = useState(''), [password,setPassword] = useState(''), [unbind,setUnbind] = useState(false);
  const state = security.data?.recoveryEmail;
  const enabled = service.capabilities?.accountRecovery.verification.enabled;
  const disabled = security.loading || security.busy || !!security.pending || security.storageError || !state;
  function submit(event:FormEvent) {
    event.preventDefault();
    if(disabled || !password || !enabled || state?.pending) return;
    const current = password; setPassword(''); void security.beginEmail(email,current);
  }
  return <section className="min-w-0 space-y-4 rounded-module border p-4 sm:p-5" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="font-semibold">{t('可信恢复邮箱','Verified recovery email')}</h2>
    <p className="text-sm text-muted-foreground">{t('恢复邮箱可以与登录邮箱不同；必须验证当前密码并打开新邮件确认。不修改登录名、不授予工作区权限。历史邮箱和邀请不会被视为已验证。','Your recovery email may differ from your sign-in email. Confirm your current password and the new email link. This does not change your sign-in name or workspace permissions. Historical addresses and invitations are not verification.')}</p>
    <p className="break-all text-sm">{state?.email ? `${t('已验证：','Verified: ')}${state.email}` : t('未登记可信恢复邮箱','No verified recovery email registered')}</p>
    {enabled !== true && <p role="status" className="text-sm">{enabled === false ? t('实例未配置恢复发信；不能创建验证或找回邮件。已有链接仍可按原期限使用。','Recovery mail issuance is not configured. Existing links retain their original validity.') : t('发行能力未知；请重读状态，不能假定已关闭或可发送。','Issuance capability is unknown. Reload; do not assume disabled or available.')}</p>}
    {state?.pending && <div className="space-y-3 rounded border p-3 text-sm">
      <p className="break-all">{t('候选（未验证）：','Pending (unverified): ')}{state.pending.candidateEmail}</p>
      <p>{t('到期：','Expires: ')}{new Date(state.pending.expiresAt).toLocaleString()}</p>
      <p>{t('实际邮件状态：','Actual delivery state: ')}{state.pending.delivery.status}{state.pending.delivery.failureCode ? ` · ${state.pending.delivery.failureCode}` : ''}</p>
      <p>{t('SMTP 接受不是收件箱送达；unknown 不会自动重发。取消候选保留旧绑定，但原链接立即失效；sending 租约结束前不能另签。','SMTP acceptance is not inbox delivery; unknown is never resent automatically. Cancelling preserves the previous verified address but invalidates this link. A sending lease must finish before another challenge.')}</p>
      <Button variant="outline" disabled={disabled || !password} onClick={() => {const current=password;setPassword('');void security.cancelEmail(current);}}>{t('验证当前密码并取消候选','Verify password and cancel pending email')}</Button>
    </div>}
    <form onSubmit={submit} className="space-y-3">
      {!state?.pending && <label className="grid gap-2 text-sm"><span>{t('候选恢复邮箱','Candidate recovery email')}</span><Input type="email" maxLength={254} required autoComplete="email" value={email} disabled={disabled || !enabled} onChange={event=>setEmail(event.target.value)} /></label>}
      <label className="grid gap-2 text-sm"><span>{t('当前密码（提交即清空）','Current password (cleared on submission)')}</span><Input type="password" maxLength={256} autoComplete="current-password" value={password} disabled={disabled} onChange={event=>setPassword(event.target.value)} /></label>
      {!state?.pending && <Button type="submit" disabled={disabled || !enabled || !password || !email}>{t('创建一次验证邮件','Queue one verification email')}</Button>}
    </form>
    <Link to="/pm/account/verify-recovery-email" className="text-sm text-primary hover:text-foreground">{t('验证链接说明 / 核对原验证','Verification link help / reconcile original verification')}</Link>
    {state?.email && <div className="space-y-3 border-t pt-3">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={unbind} disabled={disabled} onChange={event=>setUnbind(event.target.checked)} /><span>{t('我确认解绑后不能再通过此邮箱找回，且所有现有找回/验证链接失效；已有会话保持不变。','I understand unbinding removes email recovery and invalidates all existing recovery/verification links. Existing sessions stay unchanged.')}</span></label>
      <Button variant="destructive" disabled={disabled || !unbind || !password} onClick={()=>{const current=password;setPassword('');setUnbind(false);void security.unbindEmail(current);}}>{t('确认解绑可信恢复邮箱','Confirm unbinding recovery email')}</Button>
    </div>}
  </section>;
}
