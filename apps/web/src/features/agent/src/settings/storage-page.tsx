import { RefreshCw } from "lucide-react";
import type { AgentStorage } from "@agent-workspace/contracts/diagnostics";
import { Button } from "@agent/components/ui/button";
import { useI18n } from "@/lib/i18n-provider";
import { useAgentText, type AgentText } from "../i18n";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { useServiceData } from "./use-service-data";
import "./service-data.css";

const names = (t: AgentText): Record<AgentStorage["entries"][number]["kind"], string> => ({
  database: "Agent SQLite", "provider-config": t("Provider 实例与模型配置", "Provider instances & model configuration"),
  "provider-credentials": t("历史凭据存储（停用）", "Legacy credential store (disabled)"), "provider-homes": t("专属原生 Agent 目录", "Dedicated native Agent directories"), "maintenance-lock": t("独占维护锁", "Exclusive maintenance lock"),
});
const formatBytes = (t: AgentText, locale: string, bytes: number | null) => bytes === null ? t("不递归统计目录", "Directories not counted recursively") : t(`${bytes.toLocaleString(locale)} 字节`, `${bytes.toLocaleString(locale)} bytes`);

export default function StoragePage() {
  const t = useAgentText();
  const { locale } = useI18n();
  const { data, loading, error, refresh } = useServiceData<AgentStorage>("/api/settings/storage");
  const labels = names(t);
  return <div className="service-data-page">
    <div className="service-data-actions"><Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />{t("刷新存储位置", "Refresh storage locations")}</Button></div>
    {loading && <SettingsNotice kind="loading">{t("正在读取本机数据路径与 Provider 配置中的独立目录位置；不读取秘密或原生登录文件，不遍历项目目录。", "Loading local data paths and standalone directories from provider configuration; secrets and native login files are not read, and project directories are not traversed.")}</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => void refresh()}>{error}</SettingsNotice>}
    {data && <>
      {error && <SettingsNotice kind="info">{t("以下位置来自旧快照，当前可用性尚未确认。", "These locations come from an older snapshot; current availability is unconfirmed.")}</SettingsNotice>}
      <SettingsSection title={t("实际数据归属", "Actual data locations")} scope="service">
        <dl className="service-data-facts"><div><dt>{t("Agent 数据目录", "Agent data directory")}</dt><dd><code>{data.dataDirectory}</code></dd></div></dl>
        <ul className="service-data-list">{data.entries.map((entry) => <li key={`${entry.kind}:${entry.path}`}>
          <strong>{labels[entry.kind]}</strong><code>{entry.path}</code>
          <span>{entry.owner} · {entry.status === "present" ? t("存在", "Present") : entry.status === "missing" ? t("尚不存在", "Not yet present") : t("不可用 / 非普通路径", "Unavailable / not a regular path")} · {formatBytes(t, locale, entry.bytes)}{entry.sensitive ? ` · ${t("私密数据", "Private data")}` : ""}</span>
          <p>{entry.backupPolicy}</p>
        </li>)}</ul>
      </SettingsSection>
      <SettingsSection title={t("离线备份与隔离恢复", "Offline backup & isolated restore")} scope="service">
        <SettingsNotice kind="info">{t("备份目录 0700、文件 0600，两种策略都包含私密会话与 Agent 附件；可重建的 provider-cache 探测缓存均不纳入。不要将目录放入公开 Web 根、共享目录或提交版本库。", "Backup directories use 0700 and files use 0600; both strategies include private sessions and Agent attachments, but omit rebuildable provider-cache probes. Do not place the directory under a public web root, in shared folders, or in version control.")}</SettingsNotice>
        <ol className="service-data-bullets">
          <li>{t("使用服务管理器核对 PID、启动身份与工作目录，只停止确属本副本的 Agent 服务。运行中 PID、未知 owner 或遗留锁都会拒绝，不能用 ", "Use the service manager to verify the PID, launch identity, and working directory, and only stop the Agent service that belongs to this copy. A running PID, unknown owner, or leftover lock is refused; ")}<code>--stopped</code>{t(" 绕过。", " cannot bypass the check.")}</li>
          <li>{t("创建全新私有备份目录，必须显式选择 ", "Create a brand-new private backup directory and explicitly choose ")}<code>--secrets exclude</code>{t(" 或 ", " or ")}<code>--secrets include</code>{t("；不自动读取全局或外部原生 Agent 登录目录。", "; global or external native Agent login directories are never read automatically.")}</li>
          <li><code>exclude</code>{t(" 保留会话、消息、默认设置、实例身份、自定义模型及非秘密来源配置；排除历史凭据、provider-private 凭据/环境身份、原生登录目录、环境覆盖、配置密码及端点 / 路径 / 可执行文件 / 命令参数覆盖，并清除原生续聊和分支引用。恢复时原生实例必须明确停用；缺失禁用标志、启用值或旧 cliHome 覆盖均被拒绝。恢复后必须显式重新配置、登录并启用，不会静默回退到默认端点。", " keeps sessions, messages, defaults, instance identities, custom models, and non-secret source configuration; it excludes legacy credentials, provider-private credentials/environment identity, native login directories, environment and endpoint/path/executable/argument overrides, and clears native resume/fork references. Recovery requires explicitly disabled native instances and rejects missing or enabled flags and legacy cliHome overrides. Reconfigure, sign in, and explicitly enable restored instances; there is no silent endpoint fallback.")}</li>
          <li><code>include</code>{t(" 是含秘密的受限离线备份，包含私有原生配置、provider-private 凭据/环境身份及数据目录内的专属登录目录；外部或全局 Home 只保留路径引用，不收集其内容，恢复时也不创建该目录。", " is a restricted offline backup that includes private native configuration, provider-private credentials/environment identity, and dedicated login directories inside the data directory. External or global Home paths remain references only; their contents are not collected and recovery does not create those directories.")}</li>
          <li>{t("恢复只允许另一个新建或已存在的空目录，不覆盖来源或非空目标。工具先在隔离 staging 恢复，校验文件摘要、SQLite 完整性及全部 durable records / events，再发布到空目标。", "Restore only accepts another new or existing empty directory and never overwrites the source or a non-empty target. The tool first restores into isolated staging, verifies file digests, SQLite integrity, and all durable records / events, then publishes to the empty target.")}</li>
          <li>{t("验证不会启动 Provider、执行任务或访问项目目录。后续启动须显式指向恢复目录并重新核对环境和项目授权，不替换原服务数据。", "Verification does not start providers, run tasks, or access project directories. Subsequent launches must explicitly point at the restored directory and re-verify the environment and project authorization; original service data is not replaced.")}</li>
        </ol>
        <div className="service-data-commands">{data.maintenance.commands.map((command) => <pre key={command}><code>{command}</code></pre>)}</div>
      </SettingsSection>
      <SettingsSection title={t("未包含的数据与恢复责任", "Excluded data & restore responsibility")}>
        <ul className="service-data-bullets">{data.exclusions.map((item) => <li key={item}>{item}</li>)}</ul>
      </SettingsSection>
    </>}
  </div>;
}
