import { useEffect, useMemo, useState } from 'react';
import { AutomationGitSyncClient } from '../../../../../../../../packages/contracts/src/automation-git-sync-client';
import { AutomationApiError } from '../../../../../../../../packages/contracts/src/automation-client';
import { automationGitConfigSchema, type AutomationGitConfig, type AutomationGitStatus } from '../../../../../../../../packages/contracts/src/automation-git-sync';
import { useAgentText } from '../../i18n';
import styles from './studio-transfer.module.css';

export function StudioGitSync({ workspaceId, projectId, actorId, membershipVersion, canWrite, onBack, onDirtyChange }: { workspaceId: string; projectId: string; actorId: string; membershipVersion?: number; canWrite: boolean; onBack?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const t = useAgentText(), client = useMemo(() => new AutomationGitSyncClient(workspaceId), [workspaceId]);
  const [status, setStatus] = useState<AutomationGitStatus | null>(null), [config, setConfig] = useState<AutomationGitConfig>({ projectId, enabled: false, repository: '', branch: 'main', path: 'automations', authorName: 'PM Automations', authorEmail: '', intervalSeconds: 0, encryptionEnabled: false });
  const [token, setToken] = useState(''), [key, setKey] = useState(''), [clearToken, setClearToken] = useState(false), [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [dirty, setDirty] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const storageKey = `pm-automation-git:${actorId}:${workspaceId}:${projectId}`;
  useEffect(() => {
    let active = true; setStatus(null); setDirty(false); setError(''); setToken(''); setKey(''); setClearToken(false); setClearKey(false);
    try { setPending(localStorage.getItem(storageKey)); setStorageError(false); } catch { setPending(null); setStorageError(true); setError('Browser storage is unavailable; mutations require a durable request identity.'); }
    client.status(projectId).then(value => { if (active) { setStatus(value); setConfig(value.config ?? { projectId, enabled: false, repository: '', branch: 'main', path: 'automations', authorName: 'PM Automations', authorEmail: '', intervalSeconds: 0, encryptionEnabled: false }); } }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [client, projectId, storageKey, membershipVersion]);
  useEffect(() => { onDirtyChange?.(dirty || !!pending || busy || storageError); }, [dirty, pending, busy, storageError, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { if (!status?.operation || !['pending', 'running', 'outcome_unknown'].includes(status.operation.status)) return; let active = true; const timer = setInterval(() => { client.status(projectId).then(value => { if (active) setStatus(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }); }, 4000); return () => { active = false; clearInterval(timer); }; }, [client, projectId, status?.operation?.id, status?.operation?.status]);
  function change(patch: Partial<AutomationGitConfig>) { setConfig(value => ({ ...value, ...patch })); setDirty(true); setNotice(''); }
  function remember(requestId: string): boolean {
    try { localStorage.setItem(storageKey, requestId); if (localStorage.getItem(storageKey) !== requestId) throw new Error(); setPending(requestId); setStorageError(false); return true; }
    catch { setStorageError(true); setError(t('无法持久保存请求 ID，未提交任何变更。', 'Request identity could not be persisted. No mutation was submitted.')); return false; }
  }
  function forget(): boolean {
    try { localStorage.removeItem(storageKey); if (localStorage.getItem(storageKey) !== null) throw new Error(); setPending(null); setStorageError(false); return true; }
    catch { setStorageError(true); setError(t('结果已核对，但浏览器无法清理原请求 ID。请保留原 ID，不要重复提交。', 'Outcome reconciled, but the browser could not clear the original identity. Keep the original ID; do not submit another mutation.')); return false; }
  }
  function secrets() { return { ...(clearToken ? { token: null } : token ? { token } : {}), ...(clearKey ? { encryptionKey: null } : key ? { encryptionKey: key } : {}) }; }
  function validated(): AutomationGitConfig | null { const result = automationGitConfigSchema.safeParse(config); if (!result.success) { setError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')); return null; } return result.data; }
  async function check() { const value = validated(); if (!value) return; setBusy(true); setError(''); setNotice(''); try { const result = await client.check({ config: value, ...secrets() }); setNotice(`${t('远端读取成功。此检查不验证推送权限或加密 key。', 'Remote is readable. This does not verify push permission or the encryption key.')} ${result.remoteCommit ?? t('分支尚不存在', 'Branch does not exist yet')}`); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  async function save(syncAfter: boolean) {
    const value = validated(); if (!value || !status || pending) return; setBusy(true); setError(''); setNotice(''); const requestId = crypto.randomUUID(); if (!remember(requestId)) { setBusy(false); return; }
    try {
      const saved = await client.save({ requestId, expectedRevision: status.revision, config: value, ...secrets() }); setStatus(saved); setConfig(saved.config ?? value); setDirty(false); setToken(''); setKey(''); setClearToken(false); setClearKey(false); if (!forget()) return;
      if (syncAfter) { const syncId = crypto.randomUUID(); if (!remember(syncId)) return; await client.sync(syncId, projectId, saved.revision); if (!forget()) return; }
      setStatus(await client.status(projectId)); setNotice(syncAfter ? t('同步已受理；请查看运行状态，不代表推送完成。', 'Synchronization accepted; watch its status. Acceptance is not completion.') : t('配置已保存。', 'Configuration saved.'));
    } catch (reason) { if (reason instanceof AutomationApiError && reason.status < 500 && reason.status !== 408 && !['idempotency_conflict', 'invalid_response'].includes(reason.code)) forget(); setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function sync(reconcileOnly = false) {
    if (!status || pending) return; setBusy(true); setError(''); const requestId = crypto.randomUUID(); if (!remember(requestId)) { setBusy(false); return; }
    try { await (reconcileOnly ? client.reconcile(requestId, projectId, status.revision) : client.sync(requestId, projectId, status.revision)); if (!forget()) return; setStatus(await client.status(projectId)); setNotice(t('请求已受理，结果以状态为准。', 'Request accepted; status is authoritative.')); }
    catch (reason) { if (reason instanceof AutomationApiError && reason.status < 500 && reason.status !== 408 && !['idempotency_conflict', 'invalid_response'].includes(reason.code)) forget(); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function recover() {
    if (!pending) return; setBusy(true); setError('');
    try {
      const receipt = await client.receipt(pending); if (!forget()) return;
      const latest = await client.status(projectId); setStatus(latest); if (latest.config && !dirty) setConfig(latest.config); setToken(''); setKey('');
      if (receipt.status === 'rejected') setError(receipt.error?.message ?? t('原请求被拒绝。', 'The original request was rejected.'));
      else setNotice(t('已核对原请求。请检查当前状态。', 'Original request reconciled. Review the current status.'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function refreshStatus() {
    setBusy(true); setError('');
    try { setStatus(await client.status(projectId)); setNotice(t('已刷新服务端版本，您的输入保留。比较后可采用服务端配置或明确保存自己的版本。', 'Server revision refreshed; your inputs are preserved. Compare saved settings before choosing the server version or explicitly saving yours.')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  const active = status?.operation && ['pending', 'running', 'outcome_unknown'].includes(status.operation.status), credentialRecovery = status?.operation?.status === 'outcome_unknown';
  const locked = !canWrite || busy || !!pending || !!active, secretLocked = !canWrite || busy || !!pending || !!active && !credentialRecovery;
  const secretChanged = !!token || !!key || clearToken || clearKey;
  return <section className={styles.page}>
    <header className={styles.header}><div>{onBack && <button type="button" onClick={onBack}>{t('返回', 'Back')}</button>}<h1>Git Sync</h1><p className={styles.muted}>{t('同步 PM 自动化定义到独立 Git 仓库，导入始终为草稿。', 'Synchronize PM definitions using a dedicated Git repository. Imports always remain drafts.')}</p></div><span className={styles.pill}>{status?.operation?.status ?? (status?.config?.enabled ? t('已启用', 'Enabled') : t('未启用', 'Disabled'))}</span></header>
    {!status && !error && <p role="status">{t('加载配置…', 'Loading configuration…')}</p>}
    {status && <><section className={styles.card}><h2>{t('同步状态', 'Synchronization status')}</h2><dl className={styles.facts}><dt>{t('上次 Commit', 'Last commit')}</dt><dd><code>{status.lastCommit ?? '—'}</code></dd><dt>{t('上次同步', 'Last synchronized')}</dt><dd>{status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : '—'}</dd><dt>{t('本地待同步定义', 'Local dirty definitions')}</dt><dd>{status.dirtyCount}</dd><dt>{t('凭据 / 加密', 'Credentials / encryption')}</dt><dd>{status.tokenSet ? t('Token 已设置', 'Token stored') : t('无 Token', 'No token')} · {status.config?.encryptionEnabled ? t('已加密', 'Encrypted') : t('未加密', 'Unencrypted')}</dd></dl><p className={styles.muted}>{t('待同步数只反映 PM 本地变化，不代表未读取远端的变化。读取检查不验证 push 权限。', 'Dirty count covers local PM changes only, not unread remote changes. Read checks do not verify push permission.')}</p>{status.operation?.error && <p role="alert" className={styles.error}>{status.operation.error}</p>}{status.operation?.commit && <p><code>{status.operation.commit}</code></p>}<div className={styles.actions}><button type="button" disabled={locked || dirty || !status.config || !status.capability.available} onClick={() => void sync()}>{t('立即同步', 'Sync now')}</button>{status.operation?.status === 'outcome_unknown' && <button type="button" disabled={busy || !!pending || !canWrite} onClick={() => void sync(true)}>{t('核对未知结果（不重推）', 'Reconcile unknown result (no re-push)')}</button>}</div></section>
    {!status.capability.available && <p className={styles.error} role="status">{status.capability.reason}</p>}
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void refreshStatus()}>{t('刷新状态（保留输入）', 'Refresh status (keep inputs)')}</button></div>
    {status.config && <details className={styles.card}><summary>{t('比较服务端已保存配置', 'Compare server-saved configuration')} · r{status.revision}</summary><pre className={styles.preview}>{JSON.stringify(status.config, null, 2)}</pre><button type="button" disabled={secretLocked} onClick={() => { setConfig(status.config!); setToken(''); setKey(''); setClearToken(false); setClearKey(false); setDirty(false); setStorageError(false); setError(''); }}>{t('采用服务端配置，放弃当前输入', 'Use saved settings and discard current inputs')}</button></details>}
    <form className={styles.card} onSubmit={event => { event.preventDefault(); void save(false); }}>
      <h2>{t('配置', 'Configuration')}</h2>
      <fieldset disabled={locked}>
        <label className={styles.toggle}><input type="checkbox" checked={config.enabled} onChange={event => change({ enabled: event.target.checked })} />{t('启用周期同步', 'Enable periodic synchronization')}</label>
        <div className={styles.grid}>
          <label>{t('仓库 URL', 'Repository URL')}<input required value={config.repository} onChange={event => change({ repository: event.target.value })} placeholder="https://github.com/team/automations.git" /></label>
          <label>{t('分支', 'Branch')}<input required value={config.branch} onChange={event => change({ branch: event.target.value })} /></label>
          <label>{t('定义目录', 'Definitions directory')}<input required value={config.path} onChange={event => change({ path: event.target.value })} /></label>
          <label>{t('周期（秒，0 为仅手动）', 'Interval (seconds, 0 for manual only)')}<input type="number" min={0} max={86400} value={config.intervalSeconds} onChange={event => change({ intervalSeconds: Number(event.target.value) })} /></label>
          <label>{t('提交作者', 'Commit author')}<input required value={config.authorName} onChange={event => change({ authorName: event.target.value })} /></label>
          <label>{t('作者邮箱', 'Author email')}<input required type="email" value={config.authorEmail} onChange={event => change({ authorEmail: event.target.value })} /></label>
        </div>
      </fieldset>
      <fieldset disabled={secretLocked}>
        <h3>{t('私有凭据', 'Private credentials')}</h3>
        <p className={styles.muted}>{t('空白保留原值；输入替换；勾选清除会立即忘记输入。服务端不回显秘密。', 'Blank preserves the stored value; typing replaces it. Clear discards typed input. Secrets are never returned by the server.')}</p>
        {credentialRecovery && <p className={styles.muted}>{t('结果未知时仅允许替换/清除私有凭据以恢复核对；仓库配置不可更改，不会再次推送。', 'While an outcome is unknown, only private credentials may be replaced/cleared to recover reconciliation. Repository settings remain frozen and no second push is attempted.')}</p>}
        {!status.capability.secretsAvailable && <p className={styles.error}>{t('部署缺少 PM_AUTOMATION_GIT_MASTER_KEY，不能保存 Token / 加密 key。公开仓库非加密同步仍可配置。', 'PM_AUTOMATION_GIT_MASTER_KEY is unavailable; token/key storage is unavailable. Public unencrypted synchronization can still be configured.')}</p>}
        <div className={styles.grid}>
          <label>Token<input type="password" autoComplete="new-password" value={token} disabled={clearToken || !status.capability.secretsAvailable} placeholder={status.tokenSet ? t('已设置，留空保留', 'Stored; blank preserves') : t('未设置', 'Not set')} onChange={event => { setToken(event.target.value); setDirty(true); }} /></label>
          <label>{t('加密 key', 'Encryption key')}<input type="password" autoComplete="new-password" value={key} disabled={clearKey || !status.capability.secretsAvailable} placeholder={status.encryptionKeySet ? t('已设置，留空保留', 'Stored; blank preserves') : t('未设置', 'Not set')} onChange={event => { setKey(event.target.value); setDirty(true); }} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={clearToken} onChange={event => { setClearToken(event.target.checked); setToken(''); setDirty(true); }} />{t('清除 Token', 'Clear token')}</label>
          <label className={styles.toggle}><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setKey(''); setDirty(true); }} />{t('清除加密 key', 'Clear encryption key')}</label>
        </div>
      </fieldset>
      <fieldset disabled={locked}><label className={styles.toggle}><input type="checkbox" checked={config.encryptionEnabled} onChange={event => change({ encryptionEnabled: event.target.checked })} />{t('加密 Git 中的定义（AES-256-GCM）', 'Encrypt definitions in Git (AES-256-GCM)')}</label></fieldset>
      <p className={styles.muted}>{t('更换 key 后必须能解密当前远端文件，否则同步会明确失败。停用加密需保留原 key 完成迁移后再清除。远端删除不会自动删除 PM 定义；双边修改会冲突。', 'A replacement key must decrypt current remote files. Keep the existing key until an encryption-disable migration finishes, then clear it. Remote deletion never deletes PM definitions. Concurrent local/remote edits conflict.')}</p>
      <div className={styles.actions}>
        <button type="button" disabled={secretLocked || !status.capability.available} onClick={() => void check()}>{t('检查读取', 'Check read access')}</button>
        <button type="submit" disabled={secretLocked || !dirty || credentialRecovery && !secretChanged}>{t('保存', 'Save')}</button>
        <button type="button" disabled={locked || !dirty || !status.capability.available} onClick={() => void save(true)}>{t('保存并同步', 'Save and sync')}</button>
      </div>
    </form></>}
    {pending && <section className={styles.card}><p>{t('保存/同步结果未知，请先核对原请求，不能重复提交。', 'Save/sync outcome is unknown. Reconcile the original request before another mutation.')} <code>{pending}</code></p><button type="button" disabled={busy} onClick={() => void recover()}>{t('核对原请求', 'Reconcile original request')}</button></section>}{error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
  </section>;
}
