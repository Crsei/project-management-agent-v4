import { RefreshCw } from "lucide-react";
import type { AgentStorage } from "@agent-workspace/contracts/diagnostics";
import { Button } from "@/components/ui/button";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { useServiceData } from "./use-service-data";
import "./service-data.css";

const names: Record<AgentStorage["entries"][number]["kind"], string> = {
  database: "Agent SQLite", "provider-config": "Provider 实例与模型配置",
  "provider-credentials": "历史凭据存储（停用）", "provider-homes": "专属原生 Agent 目录", "maintenance-lock": "独占维护锁",
};
const formatBytes = (bytes: number | null) => bytes === null ? "不递归统计目录" : `${bytes.toLocaleString()} 字节`;

export default function StoragePage() {
  const { data, loading, error, refresh } = useServiceData<AgentStorage>("/api/settings/storage");
  return <div className="service-data-page">
    <div className="service-data-actions"><Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />刷新存储位置</Button></div>
    {loading && <SettingsNotice kind="loading">正在读取本机数据路径与 Provider 配置中的独立目录位置；不读取秘密或原生登录文件，不遍历项目目录。</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => void refresh()}>{error}</SettingsNotice>}
    {data && <>
      {error && <SettingsNotice kind="info">以下位置来自旧快照，当前可用性尚未确认。</SettingsNotice>}
      <SettingsSection title="实际数据归属" scope="service" description="此页只读：不移动目录、不清理历史、不删除文件，也不改变 PM 的数据库或项目存储。">
        <dl className="service-data-facts"><div><dt>Agent 数据目录</dt><dd><code>{data.dataDirectory}</code></dd></div></dl>
        <ul className="service-data-list">{data.entries.map((entry) => <li key={`${entry.kind}:${entry.path}`}>
          <strong>{names[entry.kind]}</strong><code>{entry.path}</code>
          <span>{entry.owner} · {entry.status === "present" ? "存在" : entry.status === "missing" ? "尚不存在" : "不可用 / 非普通路径"} · {formatBytes(entry.bytes)}{entry.sensitive ? " · 私密数据" : ""}</span>
          <p>{entry.backupPolicy}</p>
        </li>)}</ul>
      </SettingsSection>
      <SettingsSection title="离线备份与隔离恢复" scope="service" description="浏览器不能下载秘密备份。须由本机操作者先核对并停止本副本 Agent 服务，再在终端显式执行；工具不会杀进程。">
        <SettingsNotice kind="info">备份目录 0700、文件 0600，两种策略都包含私密会话。不要将目录放入公开 Web 根、共享目录或提交版本库。</SettingsNotice>
        <ol className="service-data-bullets">
          <li>使用服务管理器核对 PID、启动身份与工作目录，只停止确属本副本的 Agent 服务。运行中 PID、未知 owner 或遗留锁都会拒绝，不能用 <code>--stopped</code> 绕过。</li>
          <li>创建全新私有备份目录，必须显式选择 <code>--secrets exclude</code> 或 <code>--secrets include</code>；不自动读取全局或外部原生 Agent 登录目录。</li>
          <li><code>exclude</code> 保留会话、消息、默认设置、实例身份、自定义模型及非秘密来源配置；排除历史凭据文件、原生登录目录、全部环境覆盖、配置密码与可能嵌入凭据的端点 / 路径 / 可执行文件 / 命令参数覆盖，并清除原生续聊和分支引用。恢复的原生实例默认停用，必须显式重新配置、登录并启用，不会静默回退到默认端点。</li>
          <li><code>include</code> 是含秘密的受限离线备份，包含私有原生配置与数据目录内的专属登录目录；配置指向外部或全局目录时拒绝，绝不隐式采集全局账号。</li>
          <li>恢复只允许另一个新建或已存在的空目录，不覆盖来源或非空目标。工具先在隔离 staging 恢复，校验文件摘要、SQLite 完整性及全部 durable records / events，再发布到空目标。</li>
          <li>验证不会启动 Provider、执行任务或访问项目目录。后续启动须显式指向恢复目录并重新核对环境和项目授权，不替换原服务数据。</li>
        </ol>
        <div className="service-data-commands">{data.maintenance.commands.map((command) => <pre key={command}><code>{command}</code></pre>)}</div>
      </SettingsSection>
      <SettingsSection title="未包含的数据与恢复责任" description="Agent 备份不是整个 PM 项目备份；原有 PM 备份流程保持不变。">
        <ul className="service-data-bullets">{data.exclusions.map((item) => <li key={item}>{item}</li>)}</ul>
      </SettingsSection>
    </>}
  </div>;
}
