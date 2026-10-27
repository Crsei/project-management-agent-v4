import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n-provider';
import { useText } from './pm-ui';
import { usePmService } from './pm-service';
import { PmAuthPageShell, PmLoginPage } from './pm-auth-page';
import { SettingsPassword, SettingsSessions, SecurityActionStatus } from './settings/settings-security';
import { useAccountSecurity } from './settings/use-account-security';
import { parseAccountRecoveryMarker, serializeAccountRecoveryMarker, type AccountRecoveryMarker } from './account-recovery-marker';
import type { PasswordResetAction, RecoveryInspection } from '../../../../../../packages/contracts/src/account-recovery-schemas.ts';

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
    {!service.actor ? <PmLoginPage/> : <section className="w-full min-w-0 space-y-6">
      <h1 className="text-2xl font-semibold">{t('本人账号安全','Account security')}</h1>
      <p className="break-all text-sm">{service.actor.email} · {t('不需要工作区成员资格','No workspace membership required')}</p>
      <nav className="flex flex-wrap gap-3"><Button variant="outline" onClick={()=>setTab('password')}>{t('密码与恢复邮箱','Password & recovery email')}</Button><Button variant="outline" onClick={()=>setTab('sessions')}>{t('会话管理','Sessions')}</Button><Link to="/pm" className="self-center text-sm underline">{t('返回工作区选择','Workspace chooser')}</Link></nav>
      {tab==='password' ? <SettingsPassword key={`${service.actor.id}:${service.actorEpoch}:password`} mode="service"/> : <SettingsSessions key={`${service.actor.id}:${service.actorEpoch}:sessions`} mode="service"/>}
    </section>}
  </PmAuthPageShell>;
}
function Verification({token,blocked}:{token:string;blocked:RefObject<boolean>}) {
  const security=useAccountSecurity(),t=useText();
  const submittedToken=useRef<string|null>(null);
  return <section className="space-y-5">
    <p className="text-sm">{t('当前登录必须属于发起登记的同一账号；不要求同一浏览器。候选邮件持有权不能代替本人会话。','Sign in to the same account that began verification. Another browser is allowed; possession of this email does not replace account authentication.')}</p>
    <SecurityActionStatus security={security}/>
    {!token && <p role="alert">{t('缺少令牌。请重新打开原验证邮件；链接仅保留在本页内存，刷新不会自动重发。','Token missing. Reopen the original verification email. The token stays only in page memory; refreshing never resends mail.')}</p>}
    <Button disabled={!token || !security.data || security.loading || security.busy || !!security.pending || security.storageError || security.outcome?.kind==='recovery_email_confirm' && security.outcome.status==='committed' && submittedToken.current===token} onClick={()=>{submittedToken.current=token;blocked.current=true;void security.confirmEmail(token).finally(()=>{blocked.current=false;});}}>{t('确认此恢复邮箱','Confirm this recovery email')}</Button>
    <Link to="/pm/account/security" className="block text-sm underline">{t('返回账号安全','Account security')}</Link>
  </section>;
}
export function VerifyRecoveryEmailPage() {
  const service=usePmService(),t=useText(),busy=useRef(false);
  const [token]=useFragmentToken(busy);
  return <PmAuthPageShell split={false}><section className="w-full min-w-0 space-y-5">
    <h1 className="text-2xl font-semibold">{t('验证恢复邮箱','Verify recovery email')}</h1>
    {service.actor ? <Verification key={`${service.actor.id}:${service.actorEpoch}`} token={token} blocked={busy}/> : <><p>{t('请在本页登录，验证链接仅暂存内存，不会写入登录跳转地址。刷新后从原邮件重开。','Sign in on this page. The link remains only in memory, never in a sign-in return URL. Reopen the original email after refreshing.')}</p><PmLoginPage/></>}
  </section></PmAuthPageShell>;
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
  return <PmAuthPageShell split={false}><section className="w-full min-w-0 space-y-5">
    <h1 className="text-2xl font-semibold">{t('通过可信邮箱找回密码','Recover your password')}</h1>
    <p className="text-sm text-muted-foreground">{t('仅已登记并独立验证的恢复邮箱有效；登录名或历史邀请不是验证证明。没有可信邮箱且无法登录时，请联系实例运维；本服务没有人工绕过接口。','Only independently verified recovery emails are eligible. A sign-in email or historical invitation is not proof. If you cannot sign in and have no recovery email, contact instance operations; no bypass endpoint exists.')}</p>
    {(request.failed || reset.failed) && <p role="alert">{t('恢复记录损坏或存储不可用，已禁止新写入。请恢复存储权限后重新加载，不要清除尚未核对的原记录。','Recovery storage is corrupt or unavailable. New writes are blocked. Restore access and reload; do not erase an unreconciled marker.')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
    {request.marker?.kind==='recovery_request' && <div className="space-y-3 rounded border p-3"><p>{t('原匿名申请待核对；不会再发信。','Original request needs reconciliation; no resend.')}</p><Button disabled={busy} onClick={()=>{const marker=request.ref.current;if(marker?.kind!=='recovery_request')return;void run(async()=>{const found=await client.lookupRequest(marker.requestId);const result=found.request ? found : await client.recoverRequest(marker.requestId);if(!result.request || result.request.requestId!==marker.requestId)throw new Error('Unknown request');if(request.save(null))setMessage(result.request.status==='accepted' ? t('原申请已处理；不表示账号存在或邮件送达。','Original request accepted; this proves neither account existence nor delivery.') : t('原申请已围栏取消，可显式重新填写。','Original request fenced and cancelled; you may explicitly enter a new request.'));});}}>{t('核对或围栏原申请','Reconcile or fence original request')}</Button></div>}
    {reset.marker?.kind==='password_reset' && <div className="space-y-3 rounded border p-3"><p>{t('原重置结果未知。密码已清空；请重开同一封邮件再核对。新邮件不能清除旧结果。','Reset outcome unknown. Password cleared. Reopen the same email to reconcile; a different email cannot clear this marker.')}</p><Button disabled={busy || !token} onClick={()=>{const marker=reset.ref.current;if(marker?.kind!=='password_reset')return;void run(async()=>{const found=await client.lookupAction(marker.actionId,token);const result=found.action ? found : await client.recoverAction(marker.actionId,token);if(!result.action)throw new Error('Unknown action');await settle(result.action,marker.actionId);});}}>{t('核对或围栏原重置','Reconcile or fence original reset')}</Button></div>}
    {outcome && <p role="status">{outcome.status==='committed' ? t('密码已重置，全部旧会话已撤销。请普通登录。','Password reset; all previous sessions revoked. Sign in normally.') : outcome.status==='cancelled' ? t('原重置已取消并围栏，现在可显式重填新密码。','Original reset fenced and cancelled; explicitly enter a new password.') : t(`重置被拒绝：${outcome.errorCode}。密码没有改变。`,`Reset rejected: ${outcome.errorCode}. Password unchanged.`)}</p>}
    {token && !reset.marker && outcome?.status!=='committed' ? <form onSubmit={submitReset} className="space-y-3">
      <Button type="button" variant="outline" disabled={busy} onClick={()=>{void run(async()=>{setInspection(await client.inspect(token));});}}>{t('重新检查链接','Inspect link again')}</Button>
      {inspection && <p className="text-sm">{t('链接到期：','Link expires: ')}{new Date(inspection.expiresAt).toLocaleString()}</p>}
      <label className="grid gap-2 text-sm"><span>{t('新密码（12–256字符）','New password (12–256 characters)')}</span><Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={password} disabled={blocked || !inspection} onChange={event=>setPassword(event.target.value)}/></label>
      <label className="grid gap-2 text-sm"><span>{t('确认新密码','Confirm new password')}</span><Input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={confirmation} disabled={blocked || !inspection} onChange={event=>setConfirmation(event.target.value)}/></label>
      <Button type="submit" disabled={blocked || !inspection || password!==confirmation || !password}>{t('重置密码并撤销全部会话','Reset password and revoke all sessions')}</Button>
    </form> : !reset.marker && outcome?.status!=='committed' && <form onSubmit={submitRequest} className="space-y-3">
      {enabled!==true && <p role="status">{enabled===false ? t('实例未配置邮件找回。普通登录不受影响。','Recovery issuance is not configured. Normal sign-in remains available.') : t('能力状态未知，不能发起邮件。','Capability status unknown; mail requests are blocked.')}</p>}
      <label className="grid gap-2 text-sm"><span>{t('已验证的恢复邮箱（不是任意登录邮箱）','Verified recovery email (not any sign-in email)')}</span><Input type="email" required maxLength={254} autoComplete="email" value={email} disabled={blocked || !!request.marker || !enabled} onChange={event=>setEmail(event.target.value)}/></label>
      <Button type="submit" disabled={blocked || !!request.marker || !enabled}>{t('申请一次找回邮件','Request one recovery email')}</Button>
    </form>}
    {!token && reset.marker && <p>{t('缺少原令牌。请打开原邮件链接，不能从服务器重新取出。','Original token missing. Reopen its email; the server cannot return it.')}</p>}
    <Link to="/pm" className="block text-sm underline">{t('普通登录','Normal sign-in')}</Link><Link to="/pm/account/security" className="block text-sm underline">{t('本人账号安全','Account security')}</Link>
  </section></PmAuthPageShell>;
}
