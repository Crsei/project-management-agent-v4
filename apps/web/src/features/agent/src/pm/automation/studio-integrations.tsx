import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@agent/components/ui/button';
import { Input } from '@agent/components/ui/input';
import { AutomationApiError } from '../../../../../../../../packages/contracts/src/automation-client';
import { createAutomationIntegrationsClient } from '../../../../../../../../packages/contracts/src/automation-integrations-client';
import { automationEventSaveSchema, automationIntegrationProviders, automationIntegrationSaveSchema, automationIntegrationSupportsMcp, type AutomationEventEndpoint, type AutomationEventReceipt, type AutomationIntegrationConnection, type AutomationIntegrationProvider } from '../../../../../../../../packages/contracts/src/automation-integrations';
import { StudioClient } from '../../../../../../../../packages/contracts/src/automation-studio-client';
import type { StudioDefinition } from '../../../../../../../../packages/contracts/src/automation-studio';
import { useAgentText } from '../../i18n';
import styles from './studio-integrations.module.css';

type Props = { workspaceId: string; projectId: string; actorId: string; membershipVersion?: number; canWrite: boolean; onDirtyChange?: (dirty: boolean) => void };
/** Credentials exist only in current form memory; browser recovery stores an original request UUID, never form values. */
export function StudioIntegrations({ workspaceId, projectId, actorId, canWrite, onDirtyChange }: Props) {
  const t = useAgentText(); const prefix = useId();
  const api = useMemo(() => createAutomationIntegrationsClient(), []);
  const studio = useMemo(() => new StudioClient(workspaceId), [workspaceId]);
  const journalKey = `pm.automation-integrations.v1:${actorId}:${workspaceId}:${projectId}`;
  const [connections, setConnections] = useState<AutomationIntegrationConnection[]>([]);
  const [endpoints, setEndpoints] = useState<AutomationEventEndpoint[]>([]);
  const [definitions, setDefinitions] = useState<StudioDefinition[]>([]);
  const [privateReady, setPrivateReady] = useState(false);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false); const [eventDirty, setEventDirty] = useState(false); const dirty = connectionDirty || eventDirty;
  const [message, setMessage] = useState(''); const [storageError, setStorageError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string>(() => crypto.randomUUID()); const [connectionRevision, setConnectionRevision] = useState(0);
  const [provider, setProvider] = useState<AutomationIntegrationProvider>('github'); const [label, setLabel] = useState(''); const [endpoint, setEndpoint] = useState('');
  const [readTools, setReadTools] = useState(''); const [writeTools, setWriteTools] = useState(''); const [writeConsent, setWriteConsent] = useState(false); const [privateHeaders, setPrivateHeaders] = useState('');
  const [nativeApiText, setNativeApiText] = useState('');
  const [nativeApiOnly, setNativeApiOnly] = useState(false);
  const [eventId, setEventId] = useState<string>(() => crypto.randomUUID()); const [eventRevision, setEventRevision] = useState(0);
  const [definitionId, setDefinitionId] = useState(''); const [eventSource, setEventSource] = useState(''); const [eventKey, setEventKey] = useState('');
  const [verification, setVerification] = useState<AutomationEventEndpoint['verification']>('hmac_sha256_hex'); const [payloadPointer, setPayloadPointer] = useState(''); const [secret, setSecret] = useState('');
  const [receipts, setReceipts] = useState<AutomationEventReceipt[]>([]); const [receiptEndpointId, setReceiptEndpointId] = useState(''); const [receiptCursor, setReceiptCursor] = useState<string | null>(null);
  const [operationId, setOperationId] = useState(''); const [operationResult, setOperationResult] = useState('');
  useEffect(() => {
    try { const saved = sessionStorage.getItem(journalKey); if (saved !== null && !/^[0-9a-f-]{36}$/i.test(saved)) throw new Error('invalid'); setPending(saved); setStorageError(''); }
    catch { setStorageError(t('无法读取原请求恢复标识；恢复存储前禁止修改。', 'Original request recovery storage is unavailable; writes are blocked until storage recovers.')); }
  }, [journalKey, t]);
  useEffect(() => { onDirtyChange?.(dirty || pending !== null || busy || Boolean(storageError)); return () => onDirtyChange?.(false); }, [dirty, pending, busy, storageError, onDirtyChange]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [registry, events] = await Promise.all([api.list(workspaceId, projectId), api.endpoints(workspaceId, projectId)]);
      const all: StudioDefinition[] = []; let cursor: string | undefined;
      do { const page = await studio.definitions(cursor); all.push(...page.items.filter(item => item.config.projectId === projectId && item.config.trigger.kind === 'event')); cursor = page.nextCursor ?? undefined; } while (cursor);
      setConnections(registry.connections); setPrivateReady(registry.privateStorageAvailable); setEndpoints(events.items); setDefinitions(all);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('读取失败。', 'Read failed.'));
      if (error instanceof AutomationApiError && [401, 403, 404].includes(error.status)) { setConnections([]); setEndpoints([]); setDefinitions([]); setPrivateHeaders(''); setSecret(''); }
    } finally { setLoading(false); }
  }, [api, workspaceId, projectId, studio, t]);
  useEffect(() => { void load(); }, [load]);
  const frozen = busy || pending !== null || Boolean(storageError); const writable = canWrite && !frozen && privateReady;
  function edit() { setMessage(''); }
  function persistPending(value: string | null) {
    try { if (value === null) sessionStorage.removeItem(journalKey); else sessionStorage.setItem(journalKey, value); setPending(value); setStorageError(''); return true; }
    catch { setStorageError(t('无法保存原请求标识；没有发出新修改。', 'Could not persist the original request identity; no new mutation was sent.')); return false; }
  }
  async function mutate<T>(operation: (requestId: string) => Promise<T>, settled?: (value: T) => void) {
    if (frozen || !canWrite) return;
    const requestId = crypto.randomUUID(); if (!persistPending(requestId)) return;
    setBusy(true); setMessage('');
    try { const value = await operation(requestId); settled?.(value); persistPending(null); setMessage(t('服务器已确认。', 'Confirmed by the server.')); await load(); }
    catch (error) {
      if (error instanceof AutomationApiError && error.status < 500 && ![401, 403, 404].includes(error.status)) persistPending(null);
      setMessage(error instanceof Error ? error.message : t('结果未知；先核对原请求。', 'Result unknown; reconcile the original request first.'));
    } finally { setBusy(false); }
  }
  async function reconcile() {
    if (!pending || busy) return; setBusy(true);
    try { const receipt = await api.receipt(workspaceId, pending); persistPending(null); setMessage(receipt.httpStatus === 200 ? t('原请求已确认；请从列表载入权威版本。', 'Original request confirmed; load the authoritative version from the list.') : JSON.stringify(receipt.result)); await load(); }
    catch (error) { setMessage((error instanceof Error ? error.message : '') + t(' 原键未核对，不能换键重试。', ' Original key remains unresolved; do not retry with another key.')); }
    finally { setBusy(false); }
  }
  function selectConnection(value?: AutomationIntegrationConnection) {
    if (connectionDirty && !window.confirm(t('放弃未保存的连接表单？秘密不会保存到浏览器。', 'Discard the unsaved connection form? Secrets are never stored in browser recovery.'))) return;
    setConnectionId(value?.id ?? crypto.randomUUID()); setConnectionRevision(value?.revision ?? 0); setProvider(value?.provider ?? 'github'); setLabel(value?.label ?? ''); setEndpoint(value?.endpoint ?? ''); setReadTools(value?.readTools.join(', ') ?? ''); setWriteTools(value?.writeTools.join(', ') ?? ''); setPrivateHeaders(''); setWriteConsent(false); setConnectionDirty(false);
    setNativeApiText(value?.nativeApi ? JSON.stringify(value.nativeApi, null, 2) : '');
    setNativeApiOnly(Boolean(value?.nativeApi && !automationIntegrationSupportsMcp(value)));
  }
  function selectEvent(value?: AutomationEventEndpoint) {
    if (eventDirty && !window.confirm(t('放弃未保存的事件表单？', 'Discard the unsaved event form?'))) return;
    setEventId(value?.id ?? crypto.randomUUID()); setEventRevision(value?.revision ?? 0); setDefinitionId(value?.definitionId ?? ''); setEventSource(value?.source ?? ''); setEventKey(value?.key ?? ''); setVerification(value?.verification ?? 'hmac_sha256_hex'); setPayloadPointer(value?.payloadPointer ?? ''); setSecret(''); setEventDirty(false);
  }
  async function saveConnection() {
    try {
      const writes = nativeApiOnly ? [] : writeTools.split(',').map(value => value.trim()).filter(Boolean);
      const nativeApi = nativeApiText.trim() ? JSON.parse(nativeApiText) as { allowWrites?: boolean } : undefined;
      if ((writes.length || nativeApi?.allowWrites) && !writeConsent) throw new Error(t('请明确授权列出的外部写工具/API；服务端仍要求 access.manage。', 'Explicitly authorize the listed external write tools/API; the server still requires access.manage.'));
      let headers: unknown;
      if (privateHeaders.trim()) { try { headers = JSON.parse(privateHeaders) as unknown; } catch { throw new Error(t('私有 Headers 必须是有效 JSON；内容不会回显。', 'Private headers must be valid JSON; their contents are not echoed.')); } }
      const input = automationIntegrationSaveSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: connectionRevision, config: { projectId, provider, label, endpoint, readTools: nativeApiOnly ? [] : readTools.split(',').map(value => value.trim()).filter(Boolean), writeTools: writes, ...(nativeApi ? { nativeApi } : {}) }, ...(privateHeaders.trim() ? { privateHeaders: headers } : {}) });
      await mutate(requestId => api.save(workspaceId, connectionId, { ...input, requestId }), value => { setConnectionRevision(value.revision); setPrivateHeaders(''); setConnectionDirty(false); });
    } catch (error) { setMessage(error instanceof Error ? error.message : t('配置无效。', 'Invalid configuration.')); }
  }
  async function saveEvent() {
    try {
      const input = automationEventSaveSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: eventRevision, config: { definitionId, projectId, source: eventSource, key: eventKey, verification, payloadPointer }, ...(secret ? { secret } : {}) });
      await mutate(requestId => api.saveEndpoint(workspaceId, eventId, { ...input, requestId }), value => { setEventRevision(value.revision); setSecret(''); setEventDirty(false); });
    } catch (error) { setMessage(error instanceof Error ? error.message : t('配置无效。', 'Invalid configuration.')); }
  }
  async function readEvents(id: string, append = false) {
    try { const page = await api.events(workspaceId, id, append ? receiptCursor ?? undefined : undefined); setReceipts(previous => append ? [...previous, ...page.items] : page.items); setReceiptEndpointId(id); setReceiptCursor(page.nextCursor); }
    catch (error) { setMessage(error instanceof Error ? error.message : t('读取失败。', 'Read failed.')); }
  }
  return <section className={styles.root} aria-label={t('自动化集成与事件', 'Automation integrations and events')}>
    <header><h1>{t('集成与 Webhook', 'Integrations and webhooks')}</h1><p>{t('连接仅限当前账号、工作区与项目。只保存用户提供的端点和秘密；不会导入全局账号或启动暂停的 MCP。', 'Connections are private to the current actor, workspace and project. Only explicit endpoints and secrets are stored; global accounts and paused MCP services are never imported or started.')}</p><Button variant="outline" disabled={busy} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button></header>
    {loading && <p role="status">{t('读取中…', 'Loading…')}</p>}
    {!loading && !privateReady && <p className={styles.warning}>{t('缺少 PM_AUTOMATION_INTEGRATIONS_KEY：无法安全保存私有配置。部署还需外部账号、授权的 MCP HTTPS 端点和可达的 Webhook 公共入口。', 'PM_AUTOMATION_INTEGRATIONS_KEY is missing: private configuration cannot be stored safely. External accounts, authorized MCP HTTPS endpoints and a reachable public webhook ingress are also deployment prerequisites.')}</p>}
    {message && <p role="status" className={styles.warning}>{message}</p>}
    {storageError && <p role="alert">{storageError} <Button onClick={() => { try { const saved = sessionStorage.getItem(journalKey); if (saved !== null && !/^[0-9a-f-]{36}$/i.test(saved)) throw new Error('invalid'); setPending(saved); setStorageError(''); } catch { setMessage(t('恢复存储仍不可用。', 'Recovery storage remains unavailable.')); } }}>{t('重读恢复存储', 'Reload recovery storage')}</Button></p>}
    {pending && <aside className={styles.warning}>{t('原请求待核对：', 'Original request awaiting reconciliation: ')}<code>{pending}</code><Button disabled={busy} onClick={() => void reconcile()}>{t('查询原收据', 'Query original receipt')}</Button></aside>}
    <section className={styles.form} aria-label={t('外部操作核对', 'External operation reconciliation')}>
      <h3>{t('按原操作 UUID 核对', 'Reconcile an original operation UUID')}</h3>
      <p>{t('这里只读取持久结果，不重新调用供应商。dispatching/outcome_unknown 都不表示失败或可安全重试；需核对供应商真实结果。', 'This reads durable results without calling the provider again. dispatching/outcome_unknown mean neither confirmed failure nor safe retry; reconcile the real provider outcome first.')}</p>
      <label htmlFor={`${prefix}-operation-id`}>{t('运行错误中的原 operation UUID', 'Original operation UUID from the execution error')}</label>
      <Input id={`${prefix}-operation-id`} value={operationId} onChange={event => { setOperationId(event.target.value); setOperationResult(''); }} />
      <Button variant="outline" disabled={busy || !/^[0-9a-f-]{36}$/i.test(operationId)} onClick={() => { void api.operation(workspaceId, operationId).then(value => setOperationResult(JSON.stringify(value, null, 2))).catch(error => setMessage(error instanceof Error ? error.message : t('读取失败。', 'Read failed.'))); }}>{t('查询原操作', 'Query original operation')}</Button>
      {operationResult && <textarea aria-label={t('原操作权威结果', 'Authoritative original operation result')} readOnly value={operationResult} />}
    </section>
    <h2>{t('已配置连接', 'Configured connections')}</h2>
    <p>{t('Verified 表示所选机制已通过真实检查：MCP 验证工具目录；原生 API 验证认证与登记仓库/项目的元数据。API-only 不代表 MCP 就绪，也不代表模板写入已验收。', 'Verified means actual checks passed for the selected mechanisms: MCP tool discovery, or authenticated native API metadata for registered repositories/projects. API-only never means MCP-ready or accepted template writes.')}</p>
    <div className={styles.list}>{connections.map(value => <article key={value.id}><strong>{value.label}</strong><span>{value.provider} · {value.status} · r{value.revision}</span><small>{value.endpoint}</small>{value.lastError && <small role="alert">{value.lastError}</small>}<div><Button variant="outline" disabled={frozen} onClick={() => selectConnection(value)}>{t('编辑', 'Edit')}</Button><Button variant="outline" disabled={!writable || value.status === 'revoked'} onClick={() => void mutate(requestId => api.verify(workspaceId, value.id, requestId, value.revision))}>{t('显式验证连接', 'Verify connection explicitly')}</Button><Button variant="outline" disabled={!canWrite || frozen || value.status === 'revoked'} onClick={() => { if (window.confirm(t('撤销连接并擦除秘密？已有定义版本将失效。', 'Revoke this connection and erase its secret? Existing definition references will become invalid.'))) void mutate(requestId => api.revoke(workspaceId, value.id, requestId, value.revision)); }}>{t('撤销', 'Revoke')}</Button></div></article>)}</div>
    {connections.map(value => <p key={`mechanisms:${value.id}`}><strong>{value.label}</strong> · MCP: {value.verification.mcp ? t('已验证', 'verified') : t('未验证/未配置', 'not verified/configured')} · Native API: {value.verification.nativeApi ? t('已验证', 'verified') : t('未验证/未配置', 'not verified/configured')}</p>)}
    <Button variant="outline" disabled={frozen} onClick={() => selectConnection()}>{t('新增连接', 'New connection')}</Button>
    <form className={styles.form} onChange={() => setConnectionDirty(true)} onSubmit={event => { event.preventDefault(); void saveConnection(); }}>
      <h3>{t('私有集成连接', 'Private integration connection')} · r{connectionRevision}</h3>
      <label htmlFor={`${prefix}-provider`}>{t('目录依赖', 'Catalog dependency')}</label><select id={`${prefix}-provider`} disabled={!writable} value={provider} onChange={event => { const next = event.target.value as AutomationIntegrationProvider; setProvider(next); setNativeApiOnly(false); if (next !== 'github' && next !== 'gitlab') setNativeApiText(''); edit(); }}>{automationIntegrationProviders.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>
      {(provider === 'github' || provider === 'gitlab') && <><label htmlFor={`${prefix}-mechanism`}>{t('连接机制', 'Connection mechanism')}</label><select id={`${prefix}-mechanism`} disabled={!writable} value={nativeApiOnly ? 'native-api-only' : 'mcp'} onChange={event => {
        const only = event.target.value === 'native-api-only'; setNativeApiOnly(only);
        if (only) {
          const root = provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com';
          let native: { baseUrl?: string } | undefined; try { native = nativeApiText.trim() ? JSON.parse(nativeApiText) as { baseUrl?: string } : undefined; } catch { native = undefined; }
          setEndpoint(native?.baseUrl ?? root); if (!nativeApiText.trim()) setNativeApiText(JSON.stringify({ baseUrl: root, repositories: [], allowWrites: false }, null, 2));
          setReadTools(''); setWriteTools('');
        }
        edit();
      }}><option value="mcp">{t('MCP（可同时配置原生 API）', 'MCP (native API optional)')}</option><option value="native-api-only">{t('仅原生 API（不需要 MCP 服务）', 'Native API only (no MCP service required)')}</option></select></>}
      <label htmlFor={`${prefix}-label`}>{t('名称', 'Name')}</label><Input id={`${prefix}-label`} value={label} disabled={!writable} onChange={event => { setLabel(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-endpoint`}>{nativeApiOnly ? t('批准的原生 API 根地址（与下方 baseUrl 相同）', 'Approved native API root (same as baseUrl below)') : t('现有 MCP Streamable HTTP HTTPS 端点', 'Existing MCP Streamable HTTP HTTPS endpoint')}</label><Input id={`${prefix}-endpoint`} type="url" value={endpoint} disabled={!writable} onChange={event => { setEndpoint(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-headers`}>{t('私有 Headers JSON（留空保留，{} 清空）', 'Private headers JSON (blank preserves, {} clears)')}</label><textarea id={`${prefix}-headers`} autoComplete="off" spellCheck={false} value={privateHeaders} disabled={!writable} placeholder={'{"Authorization":"Bearer <your token>"}'} onChange={event => { setPrivateHeaders(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-reads`}>{t('明确允许的 MCP 读取工具名（逗号分隔）', 'Explicit MCP read tool names (comma separated)')}</label><Input id={`${prefix}-reads`} value={readTools} disabled={!writable || nativeApiOnly} onChange={event => { setReadTools(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-writes`}>{t('明确允许的 MCP 外部写工具名（需 access.manage）', 'Explicit MCP external write tool names (requires access.manage)')}</label><Input id={`${prefix}-writes`} value={writeTools} disabled={!writable || nativeApiOnly} onChange={event => { setWriteTools(event.target.value); setWriteConsent(false); edit(); }} />
      {(provider === 'github' || provider === 'gitlab') && <><label htmlFor={`${prefix}-native-api`}>{t('原生模板 API 作用域 JSON（GitHub 固定 api.github.com；GitLab 主机与连接匹配）', 'Native template API scope JSON (GitHub fixed api.github.com; GitLab host must match connection)')}</label><textarea id={`${prefix}-native-api`} spellCheck={false} value={nativeApiText} disabled={!writable} placeholder={'{"baseUrl":"https://api.github.com","repositories":["owner/repository"],"allowWrites":false}'} onChange={event => { setNativeApiText(event.target.value); setWriteConsent(false); edit(); }} /><p>{t('原生 API 只使用此连接明确保存的 Authorization/PRIVATE-TOKEN，不读取来源中的环境秘密名称。仅列出的仓库/项目可访问；写入仍需显式授权。', 'Native APIs use only this connection’s explicit Authorization/PRIVATE-TOKEN; source environment secret names are never read. Only listed repositories/projects are accessible; writes still require explicit authorization.')}</p></>}
      {nativeApiOnly && <p>{t('此模式只使用用户提供的 API 认证；没有 MCP 连接/工具探测。请在作用域 JSON 中填写真实仓库/项目。审阅者的组织级负载计数另需明确 allowOwnerLoadSearch:true 和当前 access.manage，只返回计数。', 'This mode uses only explicit API credentials, with no MCP connection or tool discovery. Enter actual repositories/projects in scope JSON. Reviewer owner-wide load counts additionally require allowOwnerLoadSearch:true and current access.manage; only counts are returned.')}</p>}
      <label><input type="checkbox" checked={writeConsent} disabled={!writable} onChange={event => { setWriteConsent(event.target.checked); edit(); }} /> {t('我授权此项目中列出的外部写工具；未知结果先核对，不自动重试。', 'I authorize the listed external write tools for this project; unknown results must be reconciled, never automatically retried.')}</label>
      <Button type="submit" disabled={!writable}>{t('保存私有配置（不执行工具）', 'Save private configuration (does not execute tools)')}</Button>
    </form>
    <h2>{t('事件入口', 'Event endpoints')}</h2>
    <p>{t('每个认证事件原子写入永久去重记录和一个授权运行；来源/key 必须匹配已保存定义，过滤器取定义当前版本。', 'Each authenticated event atomically records permanent dedupe and one authorized execution. Source/key must match the saved definition; its current filter is applied.')}</p>
    <div className={styles.list}>{endpoints.map(value => <article key={value.id}><strong>{value.source} / {value.key}</strong><span>{value.status} · {value.verification} · r{value.revision}</span><code>{value.url}</code><div><Button variant="outline" disabled={frozen} onClick={() => selectEvent(value)}>{t('编辑', 'Edit')}</Button><Button variant="outline" onClick={() => void readEvents(value.id)}>{t('接收记录', 'Received events')}</Button><Button variant="outline" disabled={!canWrite || frozen || value.status === 'revoked'} onClick={() => { if (window.confirm(t('撤销此 Webhook 并擦除密钥？', 'Revoke this webhook and erase its key?'))) void mutate(requestId => api.revokeEndpoint(workspaceId, value.id, requestId, value.revision)); }}>{t('撤销', 'Revoke')}</Button></div></article>)}</div>
    <Button variant="outline" disabled={frozen} onClick={() => selectEvent()}>{t('新增 Webhook', 'New webhook')}</Button>
    <form className={styles.form} onChange={() => setEventDirty(true)} onSubmit={event => { event.preventDefault(); void saveEvent(); }}>
      <h3>{t('认证事件配置', 'Authenticated event configuration')} · r{eventRevision}</h3>
      <label htmlFor={`${prefix}-definition`}>{t('已保存的事件定义', 'Saved event definition')}</label><select id={`${prefix}-definition`} value={definitionId} disabled={!writable} onChange={event => { setDefinitionId(event.target.value); const trigger = definitions.find(value => value.id === event.target.value)?.config.trigger; if (trigger?.kind === 'event') { setEventSource(trigger.source); setEventKey(trigger.key); } edit(); }}><option value="">{t('选择事件定义', 'Choose an event definition')}</option>{definitions.map(value => <option key={value.id} value={value.id}>{value.config.name} · {value.status}</option>)}</select>
      <label htmlFor={`${prefix}-source`}>{t('来源', 'Source')}</label><Input id={`${prefix}-source`} value={eventSource} disabled={!writable} onChange={event => { setEventSource(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-key`}>{t('事件 key（不是秘密）', 'Event key (not a secret)')}</label><Input id={`${prefix}-key`} value={eventKey} disabled={!writable} onChange={event => { setEventKey(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-verification`}>{t('原始请求验证协议', 'Raw request verification protocol')}</label><select id={`${prefix}-verification`} value={verification} disabled={!writable} onChange={event => { setVerification(event.target.value as AutomationEventEndpoint['verification']); edit(); }}>{['key', 'hmac_sha256_hex', 'standard_webhooks', 'slack_v0'].map(value => <option key={value}>{value}</option>)}</select>
      <label htmlFor={`${prefix}-secret`}>{t('私有 key / 签名 secret（留空保留）', 'Private key / signing secret (blank preserves)')}</label><Input id={`${prefix}-secret`} type="password" autoComplete="new-password" value={secret} disabled={!writable} onChange={event => { setSecret(event.target.value); edit(); }} />
      <label htmlFor={`${prefix}-pointer`}>{t('Payload JSON pointer（空值表示整个对象）', 'Payload JSON pointer (blank selects the whole object)')}</label><Input id={`${prefix}-pointer`} value={payloadPointer} disabled={!writable} onChange={event => { setPayloadPointer(event.target.value); edit(); }} />
      <p>{t('key: x-automation-key + x-webhook-id。HMAC: 原始 body 的 SHA-256 hex，x-webhook-signature 或 x-hub-signature-256，事件 ID 为 x-webhook-id 或 x-github-delivery。Standard Webhooks: webhook-id/timestamp/signature。Slack: x-slack-request-timestamp/signature，body.event_id。时间签名窗口 5 分钟；事件 ID 与 body 摘要永久去重。', 'key: x-automation-key + x-webhook-id. HMAC: SHA-256 hex of the raw body in x-webhook-signature or x-hub-signature-256; x-webhook-id or x-github-delivery identifies the event. Standard Webhooks: webhook-id/timestamp/signature. Slack: x-slack-request-timestamp/signature with body.event_id. Signed timestamps have a 5-minute window; event IDs and body digests are permanently deduplicated.')}</p>
      <Button type="submit" disabled={!writable}>{t('保存入口（不触发运行）', 'Save endpoint (does not dispatch)')}</Button>
    </form>
    {receiptEndpointId && <section><h3>{t('持久接收记录', 'Durable received events')}</h3>{receipts.length === 0 && <p>{t('尚无接收记录。', 'No events received.')}</p>}{receipts.map(value => <article className={styles.receipt} key={value.eventId}><code>{value.eventId}</code><span>{value.status} · {value.receivedAt}</span><span>{value.executionId ? `Execution: ${value.executionId}` : value.reason}</span></article>)}{receiptCursor && <Button variant="outline" onClick={() => void readEvents(receiptEndpointId, true)}>{t('加载更多', 'Load more')}</Button>}</section>}
  </section>;
}
