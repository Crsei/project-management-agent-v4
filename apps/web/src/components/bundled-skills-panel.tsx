import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { BundledSkillsCatalog, InstallBundledSkillsResult, ProviderBundledSkillsState } from "@agent-workspace/contracts/bundled-skills";
import { Button } from "@/components/ui/button";
import {
  BundledSkillsError, bundledSkillProviderIdentity, bundledSkillProviderReady,
  installProviderBundledSkills, readBundledSkillProviders, readBundledSkillsCatalog, readProviderBundledSkills,
  type BundledSkillProvider,
} from "@/lib/bundled-skills";
import styles from "./bundled-skills-panel.module.css";

type Text = (zh: string, en: string) => string;
type Props = {
  t: Text;
  /** Discards pending UI observations when the owning PM account/session changes. */
  ownerKey: string;
  disabled?: boolean;
  preferredProviderId?: string;
  onBusyChange?: (busy: boolean) => void;
};
type TargetSnapshot = { identity: string; value?: ProviderBundledSkillsState; error?: string; loading: boolean };
type Outcome = { identity: string; providerId: string; skillIds: string[]; results?: InstallBundledSkillsResult["results"]; unknown?: string };
const installable = (status: string) => status === "not-installed" || status === "update-available";

/** A source inventory and explicit deployment surface, never a runtime-loaded catalog. */
export function BundledSkillsPanel(props: Props) {
  return <BundledSkillsPanelContent key={props.ownerKey} {...props} />;
}

function BundledSkillsPanelContent({ t, disabled = false, preferredProviderId, onBusyChange }: Props) {
  const selectId = useId();
  const headingId = useId();
  const [catalog, setCatalog] = useState<BundledSkillsCatalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [providers, setProviders] = useState<BundledSkillProvider[]>();
  const [providersError, setProvidersError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(preferredProviderId ?? "");
  const [target, setTarget] = useState<TargetSnapshot>();
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [actionError, setActionError] = useState<string>();
  const [needsRecheck, setNeedsRecheck] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const live = useRef(false);
  const pending = useRef(false);
  const inventorySequence = useRef(0);
  const targetSequence = useRef(0);
  const busyCallback = useRef(onBusyChange);
  const text = useRef(t);
  text.current = t;
  busyCallback.current = onBusyChange;
  const hostDisabled = useRef(disabled);
  hostDisabled.current = disabled;
  const provider = providers?.find(item => item.instanceId === selectedId);
  const identity = provider ? bundledSkillProviderIdentity(provider) : "";
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const currentTarget = target?.identity === identity ? target : undefined;
  const state = currentTarget?.value;
  const matchingVersion = !!state && !!catalog && state.bundleDigest === catalog.bundleDigest;
  const targetOutcome = outcome?.providerId === selectedId ? outcome : undefined;
  const locked = disabled || busy;

  const errorText = useCallback((cause: unknown) => cause instanceof BundledSkillsError && (cause.status === 401 || cause.status === 403)
    ? text.current("需要独立 Agent 访问验证；PM 登录不会授予此权限。请在 Provider 设置完成验证后重新读取。", "Independent Agent access verification is required; PM sign-in does not grant it. Verify access in provider settings, then read again.")
    : cause instanceof Error ? cause.message : String(cause), []);

  const loadInventory = useCallback(async () => {
    const sequence = ++inventorySequence.current;
    setLoading(true); setCatalogError(undefined); setProvidersError(undefined);
    const results = await Promise.allSettled([
      readBundledSkillsCatalog(AbortSignal.timeout(15_000)),
      readBundledSkillProviders(AbortSignal.timeout(15_000)),
    ]);
    if (!live.current || inventorySequence.current !== sequence) return;
    const [source, inventory] = results;
    if (source.status === "fulfilled") setCatalog(source.value);
    else { setCatalog(undefined); setCatalogError(errorText(source.reason)); }
    if (inventory.status === "fulfilled") setProviders(inventory.value);
    else { setProviders(undefined); setProvidersError(errorText(inventory.reason)); }
    setLoading(false);
  }, [errorText]);

  const loadTarget = useCallback(async () => {
    if (!identity) return;
    const sequence = ++targetSequence.current;
    setTarget({ identity, loading: true });
    try {
      const value = await readProviderBundledSkills(selectedId, AbortSignal.timeout(15_000));
      if (value.providerInstanceId !== selectedId) throw new Error(text.current("服务返回了其他 Provider 的状态；未采用。", "The service returned another provider's state; it was not applied."));
      if (live.current && currentIdentity.current === identity && targetSequence.current === sequence) {
        setTarget({ identity, value, loading: false });
        setNeedsRecheck(false);
      }
    } catch (cause) {
      if (live.current && currentIdentity.current === identity && targetSequence.current === sequence) setTarget({ identity, error: errorText(cause), loading: false });
    }
  }, [selectedId, identity, errorText]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false; ++inventorySequence.current; ++targetSequence.current;
      if (pending.current) busyCallback.current?.(false);
    };
  }, []);
  useEffect(() => { void loadInventory(); }, [loadInventory, refresh]);
  useEffect(() => {
    setSelectedSkills([]);
    if (!pending.current) void loadTarget();
  }, [loadTarget, refresh]);
  useEffect(() => {
    const changed = () => { if (!pending.current) setRefresh(value => value + 1); };
    window.addEventListener("agent-native-configuration-changed", changed);
    window.addEventListener("focus", changed);
    return () => { window.removeEventListener("agent-native-configuration-changed", changed); window.removeEventListener("focus", changed); };
  }, []);

  const chosen = matchingVersion ? state.skills.filter(skill => selectedSkills.includes(skill.id) && installable(skill.status)) : [];
  const canInstall = !locked && !loading && !catalogError && !providersError && !currentTarget?.loading && !currentTarget?.error
    && !!provider && bundledSkillProviderReady(provider) && matchingVersion && !!state.targetFingerprint && chosen.length > 0 && !needsRecheck;

  async function install() {
    if (!canInstall || !provider || !catalog || !state?.targetFingerprint || pending.current) return;
    const selectedProvider = provider;
    const selectedIdentity = identity;
    const skillIds = chosen.map(skill => skill.id);
    const targetFingerprint = state.targetFingerprint;
    pending.current = true; setBusy(true); busyCallback.current?.(true);
    setActionError(undefined); setOutcome(undefined);
    let sent = false;
    try {
      // Recheck the actual instance/account immediately before the explicit write.
      const freshProviders = await readBundledSkillProviders(AbortSignal.timeout(15_000));
      if (!live.current || currentIdentity.current !== selectedIdentity) return;
      if (hostDisabled.current) throw new Error(t("管理连接或访问状态已变化；未发送安装，请先核对当前状态。", "Management connectivity or access changed; installation was not sent. Review current state first."));
      const freshProvider = freshProviders.find(item => item.instanceId === selectedProvider.instanceId);
      setProviders(freshProviders);
      if (!freshProvider || bundledSkillProviderIdentity(freshProvider) !== selectedIdentity || !bundledSkillProviderReady(freshProvider)) {
        throw new Error(t("Provider 或账号状态已变化；未发送安装。请重新选择并核对目标。", "The provider or account changed; installation was not sent. Select and review the target again."));
      }
      sent = true;
      const result = await installProviderBundledSkills(selectedProvider.instanceId, { skillIds, bundleDigest: catalog.bundleDigest, targetFingerprint, confirmed: true });
      if (result.state.providerInstanceId !== selectedProvider.instanceId) throw new Error(t("安装响应的 Provider 不匹配；必须重新核对。", "The installation response targets a different provider; reconciliation is required."));
      if (live.current && currentIdentity.current === selectedIdentity) setOutcome({ identity: selectedIdentity, providerId: selectedProvider.instanceId, skillIds, results: result.results });
    } catch (cause) {
      if (live.current && currentIdentity.current === selectedIdentity) {
        if (sent) {
          setNeedsRecheck(true);
          if (cause instanceof BundledSkillsError && cause.status !== undefined && cause.status >= 400 && cause.status < 500) setActionError(errorText(cause));
          else setOutcome({ identity: selectedIdentity, providerId: selectedProvider.instanceId, skillIds, unknown: errorText(cause) });
        } else setActionError(errorText(cause));
      }
    } finally {
      // An accepted request, a partial response and a lost response all require a
      // fresh native observation. A request alone is never rendered as success.
      if (sent && live.current && currentIdentity.current === selectedIdentity) {
        await loadTarget();
        setSelectedSkills([]);
        window.dispatchEvent(new CustomEvent("agent-native-configuration-changed", { detail: { providerInstanceIds: [selectedProvider.instanceId] } }));
      }
      pending.current = false;
      if (live.current) { setBusy(false); busyCallback.current?.(false); }
    }
  }

  const statusLabels = {
    "not-installed": t("未安装", "Not installed"), installed: t("已安装 · 非加载证明", "Installed · not proof of loading"),
    "update-available": t("可更新", "Update available"), conflict: t("冲突 · 保留原内容", "Conflict · original content preserved"),
    unavailable: t("不可用", "Unavailable"),
  } satisfies Record<ProviderBundledSkillsState["skills"][number]["status"], string>;
  const resultLabels = {
    installed: t("已安装", "Installed"), updated: t("已更新", "Updated"), unchanged: t("内容未变", "Unchanged"),
    conflict: t("冲突 · 未覆盖", "Conflict · not overwritten"), unavailable: t("不可用", "Unavailable"), error: t("失败", "Error"),
  } satisfies Record<InstallBundledSkillsResult["results"][number]["status"], string>;
  const readyCount = providers?.filter(bundledSkillProviderReady).length ?? 0;

  return <section className={styles.panel} aria-labelledby={headingId} aria-busy={busy}>
    <div className={styles.heading}>
      <h2 id={headingId}>{t("Dovspace 官方内置 PM Skills", "Dovspace official bundled PM Skills")}</h2>
      <Button type="button" variant="outline" size="sm" disabled={locked || loading} onClick={() => setRefresh(value => value + 1)}>{t("刷新来源与安装状态", "Refresh sources and installation state")}</Button>
    </div>
    <p>{t("官方来源由内置清单、源路径和内容哈希确认，不凭 Skill 名称归属。下方是可安装资源，不是已运行或已加载目录。", "Official provenance comes from the bundled manifest, source path and content hash, not a skill name. This is an installable resource inventory, not a running or loaded catalog.")}</p>
    <p>{t("仅在明确点击后，为所选 Provider 安装所选 Skills；不为所有目标安装，不覆盖用户修改或无关同名内容。原生共享目录可能影响同目录的其他 Provider，具体范围以服务返回的警告为准。", "Only an explicit click installs the selected skills for the selected provider. No all-target installation or overwriting of user-edited or unrelated same-name content. A shared native directory may affect other providers using it; see the service warnings for the actual scope.")}</p>
    <p>{t("本机指 Agent 服务主机，不是浏览器电脑。安装不代表运行中会话已加载；是否需重载、重开会话及能否调用，请按 Provider 原生机制另行核对。此处不自动认证或发送模型请求。", "Local means the Agent service host, not the browser computer. Installation does not prove a running session loaded a skill. Check the provider's native reload/session and invocation behavior separately. This panel does not authenticate or send model requests.")}</p>
    {loading && <p role="status">{t("正在只读核对来源与 Provider…", "Reading sources and provider inventory…")}</p>}
    {catalogError && <p className={styles.error} role="alert">{catalogError}</p>}
    {providersError && <p className={styles.error} role="alert">{providersError}</p>}
    {catalog && <p className={styles.version}>{t("内容版本（Bundle SHA-256）", "Content version (bundle SHA-256)")}: <code>{catalog.bundleDigest}</code></p>}
    {!loading && providers && readyCount === 0 && <p role="status">{t("没有已连接且启用、配置完成、原生就绪的 Provider 可供安装。仍可查看内置来源；可稍后配置或跳过，不会写入任何目标。", "No connected provider is enabled, configured and native-ready for installation. Bundled sources remain visible; configure a provider later or skip. No target is written.")}</p>}
    <label className={styles.provider} htmlFor={selectId}>
      <span>{t("明确选择安装目标 Provider", "Explicitly select the installation provider")}</span>
      <select id={selectId} value={selectedId} disabled={locked || loading || !providers?.length} onChange={event => {
        if (pending.current || disabled) return;
        ++targetSequence.current;
        setSelectedId(event.target.value); setSelectedSkills([]); setTarget(undefined); setActionError(undefined);
      }}>
        <option value="">{t("选择一个 Provider（不会自动安装）", "Choose one provider (no automatic installation)")}</option>
        {selectedId && !provider && <option value={selectedId} disabled>{t("原目标已不可访问", "Original target is no longer accessible")}</option>}
        {providers?.map(item => <option key={item.instanceId} value={item.instanceId}>{item.label} · {item.driver} · {item.instanceId}{!bundledSkillProviderReady(item) ? ` · ${t("尚未就绪", "not ready")}` : ""}</option>)}
      </select>
    </label>
    {provider && !bundledSkillProviderReady(provider) && <p role="status">{!provider.enabled ? t("所选 Provider 未启用，不能安装。", "The selected provider is disabled; installation is blocked.") : !provider.configured ? t("所选 Provider 尚未配置完成，不能安装。", "The selected provider is not configured; installation is blocked.") : t("所选 Provider 未报告原生就绪，不能安装。配置存在不等于已连接。", "The selected provider does not report native readiness; installation is blocked. Configuration is not a connection.")}</p>}
    {currentTarget?.loading && <p role="status">{t("正在读取所选 Provider 的权威安装状态…", "Reading authoritative installation state for the selected provider…")}</p>}
    {currentTarget?.error && <p className={styles.error} role="alert">{currentTarget.error} {t("状态未知，禁止安装；请刷新读取。", "State is unknown; installation is blocked. Refresh to read again.")}</p>}
    {state && !matchingVersion && <p className={styles.error} role="alert">{t("内置版本发生变化；请刷新来源与目标，重新选择 Skills。", "The bundle version changed. Refresh sources and the target, then select skills again.")}</p>}
    {state && !state.targetFingerprint && state.skills.some(skill => skill.status !== "unavailable") && <p className={styles.error} role="alert">{t("未取得可核对的原生目标身份，禁止安装。请刷新后重新选择。", "No verifiable native target identity was returned. Installation is blocked; refresh and review again.")}</p>}
    {state?.warnings.map((warning, index) => <p className={styles.warning} role="note" key={`${index}:${warning}`}>{warning}</p>)}
    {catalog && <fieldset className={styles.skills} disabled={locked || !provider || !bundledSkillProviderReady(provider) || !matchingVersion || !!currentTarget?.loading || !!currentTarget?.error || loading}>
      <legend>{t("选择 Skills（仅未安装／可更新项可写入）", "Select skills (only missing/outdated entries can be written)")}</legend>
      {matchingVersion && <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedSkills(state.skills.filter(skill => installable(skill.status)).map(skill => skill.id))}>{t("选择可安装／更新项", "Select installable/update entries")}</Button>}
      <ul>{catalog.skills.map(skill => {
        const observation = matchingVersion ? state.skills.find(item => item.id === skill.id) : undefined;
        return <li key={skill.id}>
          <label className={styles.skillHeading}><input type="checkbox" checked={selectedSkills.includes(skill.id)} disabled={!observation || !installable(observation.status)} onChange={event => setSelectedSkills(value => event.target.checked ? [...value, skill.id] : value.filter(id => id !== skill.id))} /><strong>{skill.name}</strong><code>{skill.id}</code></label>
          <p>{skill.description}</p>
          <dl className={styles.source}><dt>{t("来源", "Source")}</dt><dd>{skill.sourceLabel} · {t("官方内置", "official bundled")}</dd><dt>{t("源路径", "Source path")}</dt><dd><code>{skill.sourcePath}</code></dd><dt>SHA-256</dt><dd><code>{skill.sha256}</code></dd></dl>
          <p className={styles.status} data-status={observation?.status}>{observation ? statusLabels[observation.status] : t("尚未核对目标安装状态", "Target installation state not checked")}</p>
          {observation?.reason && <p className={styles.warning}>{observation.reason}</p>}
        </li>;
      })}</ul>
    {matchingVersion && state.skills.length > 0 && state.skills.every(skill => skill.status === "unavailable") && <p role="status">{t("所选 Provider 没有兼容的本机 Skills 安装目标；原因见逐项状态与服务警告。可选择其他 Provider，或稍后配置。", "The selected provider has no compatible local skill-installation target. See per-skill reasons and service warnings. Choose another provider or configure one later.")}</p>}
    </fieldset>}
    {actionError && <p className={styles.error} role="alert">{actionError}</p>}
    {targetOutcome && <div className={styles.outcome} aria-live="polite">
      <h3>{t("最近一次明确安装的逐项结果", "Per-skill results of the last explicit installation")}</h3>
      <p><code>{targetOutcome.providerId}</code> · {targetOutcome.skillIds.join(", ")}</p>
      {targetOutcome.unknown && <p className={styles.error} role="alert">{t("原安装请求结果未知，未自动重试。", "The original installation outcome is unknown; it was not retried automatically.")} {targetOutcome.unknown} {needsRecheck || currentTarget?.error ? t("权威状态仍未核对成功，禁止新提交；请刷新。", "Authoritative state has not been reconciled; new submission is blocked. Refresh to read again.") : t("已重新读取上方原生安装状态；该状态不证明原请求全部成功，也不证明运行时已加载。", "Native installation state has been read again above. It does not prove the original request fully succeeded or that runtime loading occurred.")}</p>}
      {targetOutcome.identity !== identity && <p className={styles.warning}>{t("Provider／账号已变化；这些结果属于原目标，不套用于当前选择。", "The provider/account changed. These results belong to the original target, not the current selection.")}</p>}
      {targetOutcome.results && <ul>{targetOutcome.results.map(result => <li key={result.id}><code>{result.id}</code> · {resultLabels[result.status]}{result.error && <span className={styles.error}> · {result.error.code}: {result.error.message}</span>}</li>)}</ul>}
      <p>{t("以当前逐项安装状态为准；冲突、失败与不可用项不会被当作成功。安装与会话加载分开核对。", "Use the current per-skill installation state. Conflicts, errors and unavailable entries are not successes. Verify session loading separately.")}</p>
    </div>}
    <div className={styles.confirm}>
      <p>{t("安装确认", "Installation confirmation")}: {provider ? `${provider.label} · ${provider.instanceId}` : t("未选择 Provider", "No provider selected")}</p>
      <p>{t("所选 Skills", "Selected skills")}: {chosen.length ? chosen.map(skill => skill.id).join(", ") : t("未选择", "None selected")}</p>
      <Button type="button" disabled={!canInstall} onClick={() => { void install(); }}>{busy ? t("正在安装并核对结果…", "Installing and reconciling…") : t("为所选 Provider 安装／更新所选 Skills", "Install/update selected skills for this provider")}</Button>
    </div>
  </section>;
}
