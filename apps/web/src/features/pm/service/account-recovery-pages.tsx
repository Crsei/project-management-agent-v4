import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { CircleAlert, CircleCheck, Info, KeyRound, MailCheck, MonitorSmartphone, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { useI18n } from '@/lib/i18n-provider';
import { useText } from './pm-ui';
import { usePmService } from './pm-service';
import { PmAuthPageShell, PmLoginPage } from './pm-auth-page';
import { SettingsPassword, SettingsSessions, SecurityActionStatus } from './settings/settings-security';
import { useAccountSecurity } from './settings/use-account-security';
import { parseAccountRecoveryMarker, serializeAccountRecoveryMarker, type AccountRecoveryMarker } from './account-recovery-marker';
import type { PasswordResetAction, RecoveryInspection } from '../../../../../../packages/contracts/src/account-recovery-schemas.ts';
import styles from './account-pages.module.css';

type NoticeTone = 'info' | 'warning' | 'error' | 'success';

function AccountPageHeader({icon,eyebrow,title,description}:{icon:ReactNode;eyebrow:string;title:string;description:string}) {
  return <header className={styles.pageHeader}>
    <span className={styles.symbol} aria-hidden="true">{icon}</span>
    <div className={styles.heading}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </div>
  </header>;
}

function StatusNotice({tone,title,children}:{tone:NoticeTone;title?:string;children:ReactNode}) {
  const Icon = tone==='error' ? CircleAlert : tone==='warning' ? TriangleAlert : tone==='success' ? CircleCheck : Info;
  return <div className={styles.notice} data-tone={tone} role={tone==='error' ? 'alert' : 'status'}>
    <Icon className={styles.noticeIcon} aria-hidden="true"/>
    <div className={styles.noticeBody}>
      {title && <p className={styles.noticeTitle}>{title}</p>}
      <div className={styles.noticeText}>{children}</div>
    </div>
  </div>;
}

function useFragmentToken(blocked: RefObject<boolean>) {
  // Pure initializer survives StrictMode's duplicate invocation. Clear URL before paint.
  const [token,setToken]=useState(()=>new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  useLayoutEffect(()=>{
    const consume=()=>{
      const next=new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
      window.history.replaceState(window.history.state,'',window.location.pathname);
      if(!blocked.current && next) setToken(next);
    };
    window.history.replaceState(window.history.state,'',window.location.pathname);
    window.addEventListener('hashchange',consume);
    return ()=>window.removeEventListener('hashchange',consume);
  },[blocked]);
  return [token,setToken] as const;
}
function useRecoveryMarker(key:string,kind:AccountRecoveryMarker['kind']) {
  const [initial]=useState(()=>{try{const marker=parseAccountRecoveryMarker(sessionStorage.getItem(key));if(marker && marker.kind!==kind)throw new Error('Recovery marker kind mismatch');return {marker,failed:false};}catch{return {marker:null,failed:true};}});
  const [marker,setMarker]=useState(initial.marker), [failed,setFailed]=useState(initial.failed);
  const ref=useRef(initial.marker);
  function save(next:AccountRecoveryMarker|null) {
    try {
      if(next) sessionStorage.setItem(key,serializeAccountRecoveryMarker(next)); else sessionStorage.removeItem(key);
      ref.current=next;setMarker(next);return true;
    }catch{setFailed(true);return false;}
  }
  return {marker,ref,failed,save};
}
export function AccountSecurityPage() {
  const service=usePmService(), t=useText();
  const [tab,setTab]=useState<'password'|'sessions'>('password');
  return <PmAuthPageShell split={false}>
    <div className={styles.page}>
      <AccountPageHeader
        icon={<ShieldCheck size={20}/>}
        eyebrow={t('账号','Account')}
        title={t('本人账号安全','Account security')}
        description={t('管理登录密码、可信恢复邮箱和本人会话。此入口不需要工作区成员资格。','Manage your sign-in password, trusted recovery email and personal sessions. No workspace membership is required.')}
      />
      {!service.actor ? <div className={styles.loginWrap}><PmLoginPage titleAs="h2"/></div> : <>
        <section className={styles.identity} aria-label={t('当前账号','Current account')}>
          <div className={styles.identityMain}>
            <Avatar name={service.actor.name || service.actor.email} size={36}/>
            <div className={styles.identityText}>
              <p className={styles.identityName}>{service.actor.name || service.actor.email}</p>
              <p className={styles.identityEmail}>{service.actor.email}</p>
            </div>
          </div>
          <div className={styles.identityMeta}>
            <Badge tone="neutral" size="sm">{t('不需要工作区成员资格','No workspace membership required')}</Badge>
          </div>
        </section>
        <Segmented
          value={tab}
          onValueChange={(value)=>setTab(value==='sessions' ? 'sessions' : 'password')}
          aria-label={t('账号安全分区','Account security sections')}
          className={styles.segmented}
        >
          <SegmentedItem value="password" className={styles.segmentedItem}><KeyRound size={16} aria-hidden="true"/>{t('密码与恢复邮箱','Password & recovery email')}</SegmentedItem>
          <SegmentedItem value="sessions" className={styles.segmentedItem}><MonitorSmartphone size={16} aria-hidden="true"/>{t('会话管理','Sessions')}</SegmentedItem>
        </Segmented>
        <section className={styles.panel}>
          {tab==='password' ? <SettingsPassword key={`${service.actor.id}:${service.actorEpoch}:password`} mode="service"/> : <SettingsSessions key={`${service.actor.id}:${service.actorEpoch}:sessions`} mode="service"/>}
        </section>
      </>}
      <nav className={styles.footerLinks} aria-label={t('相关入口','Related links')}>
        <Link className={styles.link} to="/pm">{t('返回工作区选择','Workspace chooser')}</Link>
        <Link className={styles.link} to="/pm/account/recovery">{t('通过可信邮箱找回密码','Recover password by email')}</Link>
      </nav>
    </div>
  </PmAuthPageShell>;
}
function Verification({token,blocked}:{token:string;blocked:RefObject<boolean>}) {
  const security=useAccountSecurity(),t=useText();
  const submittedToken=useRef<string|null>(null);
  const disabled=!token || !security.data || security.loading || security.busy || !!security.pending || security.storageError || security.outcome?.kind==='recovery_email_confirm' && security.outcome.status==='committed' && submittedToken.current===token;
  return <section className={styles.card} aria-labelledby="verify-recovery-email-title">
    <header className={styles.cardHeader}>
      <div className={styles.cardSymbol}><MailCheck size={16} aria-hidden="true"/></div>
      <div className={styles.cardHeading}>
        <h2 id="verify-recovery-email-title" className={styles.cardTitle}>{t('确认恢复邮箱','Confirm recovery email')}</h2>
        <p className={styles.cardDescription}>{t('当前登录必须属于发起登记的同一账号；不要求同一浏览器。候选邮件持有权不能代替本人会话。','Sign in to the same account that began verification. Another browser is allowed; possession of this email does not replace account authentication.')}</p>
      </div>
    </header>
    <div className={styles.cardBody}>
      <SecurityActionStatus security={security}/>
      {!token && <StatusNotice tone="warning">{t('缺少令牌。请重新打开原验证邮件；链接仅保留在本页内存，刷新不会自动重发。','Token missing. Reopen the original verification email. The token stays only in page memory; refreshing never resends mail.')}</StatusNotice>}
      <div className={styles.actions}>
        <Button loading={security.busy} disabled={disabled} onClick={()=>{submittedToken.current=token;blocked.current=true;void security.confirmEmail(token).finally(()=>{blocked.current=false;});}}>{t('确认此恢复邮箱','Confirm this recovery email')}</Button>
      </div>
    </div>
  </section>;
}
export function VerifyRecoveryEmailPage() {
  const service=usePmService(),t=useText(),busy=useRef(false);
  const [token]=useFragmentToken(busy);
  return <PmAuthPageShell split={false}>
    <div className={`${styles.page} ${styles.narrow}`}>
      <AccountPageHeader
        icon={<MailCheck size={20}/>}
        eyebrow={t('账号','Account')}
        title={t('验证恢复邮箱','Verify recovery email')}
        description={t('打开验证邮件中的链接，确认可信恢复邮箱。链接只保留在当前页面内存。','Open the link in the verification email to confirm a trusted recovery email. The link stays only in this page’s memory.')}
      />
      {service.actor ? <Verification key={`${service.actor.id}:${service.actorEpoch}`} token={token} blocked={busy}/> : <>
        <StatusNotice tone="info">{t('请在本页登录，验证链接仅暂存内存，不会写入登录跳转地址。刷新后从原邮件重开。','Sign in on this page. The link remains only in memory, never in a sign-in return URL. Reopen the original email after refreshing.')}</StatusNotice>
        <div className={styles.loginWrap}><PmLoginPage titleAs="h2"/></div>
      </>}
      <nav className={styles.footerLinks} aria-label={t('相关入口','Related links')}>
        <Link className={styles.link} to="/pm/account/security">{t('返回账号安全','Account security')}</Link>
        <Link className={styles.link} to="/pm">{t('普通登录','Normal sign-in')}</Link>
      </nav>
    </div>
  </PmAuthPageShell>;
}
export function PasswordRecoveryPage() {
  const service=usePmService(),busyRef=useRef(false);
  const {locale}=useI18n();
  const t=useCallback((zh:string,en:string)=>locale==='en' ? en : zh,[locale]);
  const [token,setToken]=useFragmentToken(busyRef);
  const [busy,setBusy]=useState(false),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
  const [inspection,setInspection]=useState<RecoveryInspection|null>(null),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[outcome,setOutcome]=useState<PasswordResetAction|null>(null);
  const request=useRecoveryMarker('pm.account-recovery.request.v1','recovery_request'),reset=useRecoveryMarker('pm.account-recovery.reset.v1','password_reset');
  const client=service.client.accountRecovery;
  const enabled=service.capabilities?.accountRecovery.request.enabled;
  useEffect(()=>{
    let current=true;setInspection(null);setPassword('');setConfirmation('');if(token)setOutcome(null);setError(null);
    if(token && !reset.ref.current) void client.inspect(token).then(value=>{if(current)setInspection(value);}).catch(()=>{if(current)setError(t('链接不可用或暂时无法核实。不会提交新密码；可重新读取。','The link is unavailable or cannot be inspected. No password was submitted; retry the read.'));});
    return ()=>{current=false;};
  },[client,token,t,reset.ref]);
  useEffect(()=>{setPassword('');setConfirmation('');},[service.actor?.id,service.actorEpoch]);
  async function run(operation:()=>Promise<void>) {
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await operation();}catch{setError(t('结果尚未确认。请核对原请求，不要重发邮件或密码。若令牌丢失，请重开原邮件。','Outcome not confirmed. Reconcile the original identity; never resend mail or passwords. Reopen the original email if the token is missing.'));}
    finally{busyRef.current=false;setBusy(false);}
  }
  async function settle(value:PasswordResetAction,id:string) {
    if(value.actionId!==id)throw new Error('Mismatched recovery identity');
    if(value.status==='committed') service.clearSessionAfterPasswordReset();
    if(!reset.save(null))return;
    setOutcome(value);setInspection(null);
    if(value.status==='committed') {
      setToken('');
      // Recheck real auth without a logout that could revoke a newer legitimate session.
      try{await service.refresh();}catch{/* A real 401 is expected; no replacement session is created. */}
    } else if(value.status==='cancelled') {
      try { setInspection(await client.inspect(token)); }
      catch { setError(t('原操作已确认取消，但链接已不可用或无法读取；不会提交新密码。','The original action is confirmed cancelled, but the link is unavailable or cannot be inspected. No new password is submitted.')); }
    }
  }
  function submitRequest(event:FormEvent) {
    event.preventDefault();if(busyRef.current || request.ref.current || request.failed || !enabled)return;
    const id=crypto.randomUUID();if(!request.save({kind:'recovery_request',requestId:id}))return;
    void run(async()=>{const result=await client.request({requestId:id,email});if(result.requestId!==id)throw new Error('Mismatched request');if(!request.save(null))return;setMessage(result.status==='accepted' ? t('若此地址已登记并符合条件，将收到邮件。有效令牌窗口内不会旋转或重发。请检查垃圾箱，等待窗口结束后再显式申请。','If this address is registered and eligible, an email will arrive. An active token is never rotated or resent. Check spam and wait for the validity window before explicitly requesting again.') : t('原申请已取消，迟到请求不会发信。','The original request is fenced and cancelled.'));});
  }
  function submitReset(event:FormEvent) {
    event.preventDefault();if(busyRef.current || reset.ref.current || reset.failed || !inspection || password!==confirmation || password.length<12)return;
    const id=crypto.randomUUID();if(!reset.save({kind:'password_reset',actionId:id}))return;
    const next=password;setPassword('');setConfirmation('');
    void run(async()=>settle(await client.complete(id,token,next),id));
  }
  const blocked=busy || request.failed || reset.failed;
  const committed=outcome?.status==='committed';
  const outcomeTone:NoticeTone = outcome?.status==='committed' ? 'success' : outcome?.status==='cancelled' ? 'warning' : 'error';
  return <main id="main-content" className={styles.recoveryShell} data-pm-route-page>
    <div className={`${styles.page} ${styles.recovery}`}>
      <header className={styles.recoveryHeader}>
        <h1 id="password-recovery-title" className={styles.title}>{t('忘记密码','Forgot Password')}</h1>
        {!token && !committed && <p className={styles.description}>{t('输入已登记并验证的恢复邮箱，','Enter your registered, verified recovery email and')}<br/>{t('我们将发送密码重置链接。','we will send you a link to reset your password.')}</p>}
      </header>
      <div className={styles.stack}>
        {(request.failed || reset.failed) && <StatusNotice tone="warning">{t('恢复记录损坏或存储不可用，已禁止新写入。请恢复存储权限后重新加载，不要清除尚未核对的原记录。','Recovery storage is corrupt or unavailable. New writes are blocked. Restore access and reload; do not erase an unreconciled marker.')}</StatusNotice>}
        {error && <StatusNotice tone="error">{error}</StatusNotice>}
        {message && <StatusNotice tone="info">{message}</StatusNotice>}
        {outcome && <StatusNotice tone={outcomeTone}>{committed ? t('密码已重置，全部旧会话已撤销。请普通登录。','Password reset; all previous sessions revoked. Sign in normally.') : outcome.status==='cancelled' ? t('原重置已取消并围栏，现在可显式重填新密码。','Original reset fenced and cancelled; explicitly enter a new password.') : t(`重置被拒绝：${outcome.errorCode}。密码没有改变。`,`Reset rejected: ${outcome.errorCode}. Password unchanged.`)}</StatusNotice>}
        {request.marker?.kind==='recovery_request' && <section className={`${styles.card} ${styles.cardAttention}`} aria-labelledby="recovery-request-marker-title">
          <header className={styles.cardHeader}>
            <div className={styles.cardSymbol}><TriangleAlert size={16} aria-hidden="true"/></div>
            <div className={styles.cardHeading}>
              <h2 id="recovery-request-marker-title" className={styles.cardTitle}>{t('核对原申请','Reconcile the original request')}</h2>
              <p className={styles.cardDescription}>{t('原匿名申请待核对；不会再发信。','Original request needs reconciliation; no resend.')}</p>
            </div>
          </header>
          <div className={styles.cardBody}>
            <div className={styles.actions}>
              <Button variant="outline" loading={busy} disabled={busy} onClick={()=>{const marker=request.ref.current;if(marker?.kind!=='recovery_request')return;void run(async()=>{const found=await client.lookupRequest(marker.requestId);const result=found.request ? found : await client.recoverRequest(marker.requestId);if(!result.request || result.request.requestId!==marker.requestId)throw new Error('Unknown request');if(request.save(null))setMessage(result.request.status==='accepted' ? t('原申请已处理；不表示账号存在或邮件送达。','Original request accepted; this proves neither account existence nor delivery.') : t('原申请已围栏取消，可显式重新填写。','Original request fenced and cancelled; you may explicitly enter a new request.'));});}}>{t('核对或围栏原申请','Reconcile or fence original request')}</Button>
            </div>
          </div>
        </section>}
        {reset.marker?.kind==='password_reset' && <section className={`${styles.card} ${styles.cardAttention}`} aria-labelledby="recovery-reset-marker-title">
          <header className={styles.cardHeader}>
            <div className={styles.cardSymbol}><TriangleAlert size={16} aria-hidden="true"/></div>
            <div className={styles.cardHeading}>
              <h2 id="recovery-reset-marker-title" className={styles.cardTitle}>{t('核对原重置','Reconcile the original reset')}</h2>
              <p className={styles.cardDescription}>{t('原重置结果未知。密码已清空；请重开同一封邮件再核对。新邮件不能清除旧结果。','Reset outcome unknown. Password cleared. Reopen the same email to reconcile; a different email cannot clear this marker.')}</p>
            </div>
          </header>
          <div className={styles.cardBody}>
            <div className={styles.actions}>
              <Button variant="outline" loading={busy} disabled={busy || !token} onClick={()=>{const marker=reset.ref.current;if(marker?.kind!=='password_reset')return;void run(async()=>{const found=await client.lookupAction(marker.actionId,token);const result=found.action ? found : await client.recoverAction(marker.actionId,token);if(!result.action)throw new Error('Unknown action');await settle(result.action,marker.actionId);});}}>{t('核对或围栏原重置','Reconcile or fence original reset')}</Button>
            </div>
          </div>
        </section>}
        {token && !reset.marker && !committed ? <section className={styles.card} aria-labelledby="recovery-reset-title">
          <header className={styles.cardHeader}>
            <div className={styles.cardSymbol}><KeyRound size={16} aria-hidden="true"/></div>
            <div className={styles.cardHeading}>
              <h2 id="recovery-reset-title" className={styles.cardTitle}>{t('设置新密码','Set a new password')}</h2>
              <p className={styles.cardDescription}>{t('链接只保留在当前页面内存。重置成功后，全部旧会话会被撤销。','The link stays only in this page’s memory. A successful reset revokes every previous session.')}</p>
            </div>
          </header>
          <div className={styles.cardBody}>
            <div className={styles.metaRow}>
              <Button type="button" variant="outline" disabled={busy} onClick={()=>{void run(async()=>{setInspection(await client.inspect(token));});}}>{t('重新检查链接','Inspect link again')}</Button>
              {inspection ? <p className={styles.meta}>{t('链接到期：','Link expires: ')}{new Date(inspection.expiresAt).toLocaleString(locale==='en' ? 'en-US' : 'zh-CN')}</p> : !error && !reset.marker && <p className={styles.meta} role="status">{t('正在核实链接…','Inspecting the link…')}</p>}
            </div>
            <form onSubmit={submitReset} className={styles.form}>
              <label className={styles.field}><span className={styles.fieldLabel}>{t('新密码（12–256字符）','New password (12–256 characters)')}</span><Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} disabled={blocked || !inspection} onChange={event=>setPassword(event.target.value)}/></label>
              <label className={styles.field}><span className={styles.fieldLabel}>{t('确认新密码','Confirm new password')}</span><Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={confirmation} disabled={blocked || !inspection} onChange={event=>setConfirmation(event.target.value)}/></label>
              <Button type="submit" className={styles.submit} loading={busy} disabled={blocked || !inspection || password!==confirmation || !password}>{t('重置密码并撤销全部会话','Reset password and revoke all sessions')}</Button>
            </form>
          </div>
        </section> : !reset.marker && !committed && <>
          <form onSubmit={submitRequest} className={styles.form} aria-labelledby="password-recovery-title">
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('邮箱','Email')}</span>
              <Input name="email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@example.com" value={email} disabled={blocked || !!request.marker || !enabled} onChange={event=>setEmail(event.target.value)}/>
            </label>
            <Button type="submit" className={styles.submit} loading={busy} disabled={blocked || !!request.marker || !enabled}>{t('继续','Continue')}</Button>
          </form>
          {enabled!==true && <p className={styles.recoveryStatus} role="status">{enabled===false ? t('邮件找回暂未开放。','Email recovery is currently unavailable.') : t('暂时无法确认邮件找回状态。','Email recovery availability could not be confirmed.')}</p>}
        </>}
        {!token && reset.marker && <StatusNotice tone="warning">{t('缺少原令牌。请打开原邮件链接，不能从服务器重新取出。','Original token missing. Reopen its email; the server cannot return it.')}</StatusNotice>}
      </div>
      {token || committed || reset.marker ? <nav className={styles.recoveryFooter} aria-label={t('相关入口','Related links')}>
        <Link className={styles.link} to="/pm">{t('返回登录','Back to sign in')}</Link>
      </nav> : <p className={styles.recoveryFooter}>
        {t('还没有账号？','Don’t have an account?')}{' '}
        <button type="button" className={styles.registerUnavailable} disabled>{t('注册（暂未开放）','Register (unavailable)')}</button>
      </p>}
    </div>
  </main>;
}
