import { Hono } from "hono";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDiagnostics, AgentStorage } from "@agent-workspace/contracts/diagnostics";
import type { ProviderDriver } from "@agent-workspace/contracts/provider";
import { dataDirectory, workspaceRoot } from "../paths.ts";

const storeKey = Symbol.for("agent-workspace.durable-store");
type ExistingStore = { database: DatabaseSync; directory: string; token: string };
const DRIVERS: ProviderDriver[] = ["codex", "claude", "cursor", "grok", "fx", "opencode", "antigravity", "muse", "pi", "omp", "acpRegistry"];
const FAILURE_CLASSES = ["usage_limit", "authentication", "cancelled", "unsupported", "provider_error", "interrupted"] as const;
function safeTimestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function readJson(filename: string): unknown {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error("Unsupported configuration file.");
  return JSON.parse(readFileSync(filename, "utf8"));
}

function knownVersion(): string | null {
  try {
    const version = record(readJson(path.join(workspaceRoot, "apps/server/agent/package.json")))?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)
      ? version : null;
  } catch { return null; }
}

/** Never opens/initializes a store, probes a provider, reads credentials, or returns errors verbatim. */
export function collectAgentDiagnostics(): AgentDiagnostics {
  const version = knownVersion();
  const report: AgentDiagnostics = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    service: { http: "responding", durableStore: "unavailable", ownsStore: false,
      integrity: "not-checked", threads: null, histories: null, messages: null },
    runtime: { applicationVersion: version, versionSource: version ? "package.json" : "unknown",
      nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    providers: { configuration: "unknown", total: 0, native: 0, inactive: 0, observations: [] },
    recentFailures: { available: false, items: [] },
    privacy: { reportContains: "allowlisted-status-only", providerExecutionVerified: false,
      excludes: ["凭据、Cookie、环境变量及其值", "消息、提示词、终端与原始日志", "Provider 名称、ID、URL、目录与错误原文", "项目文件与业务数据"] },
  };
  const state = (globalThis as typeof globalThis & { [storeKey]?: ExistingStore })[storeKey];
  if (state && path.resolve(state.directory) === dataDirectory()) {
    try {
      const owner = state.database.prepare("SELECT pid, token FROM worker_owner WHERE singleton = 1").get();
      const lock = record(readJson(path.join(state.directory, "workspace.lock")));
      report.service.ownsStore = owner?.pid === process.pid && owner.token === state.token
        && lock?.pid === process.pid && lock.token === state.token;
      // A bounded read-only check of this actual connection, not a readiness assertion about Providers.
      const checked = state.database.prepare("PRAGMA quick_check(1)").get();
      report.service.integrity = checked && Object.values(checked)[0] === "ok" ? "ok" : "failed";
      report.service.durableStore = report.service.ownsStore && report.service.integrity === "ok" ? "ok" : "unavailable";
      const counts = state.database.prepare(`SELECT
        SUM(CASE WHEN namespace = 'chat:threads' THEN 1 ELSE 0 END) AS threads,
        SUM(CASE WHEN namespace = 'chat:history' THEN 1 ELSE 0 END) AS histories,
        SUM(CASE WHEN namespace = 'chat:history' AND json_valid(value)
          THEN COALESCE(json_array_length(value, '$.messages'), 0) ELSE 0 END) AS messages
        FROM records`).get();
      report.service.threads = Number(counts?.threads ?? 0);
      report.service.histories = Number(counts?.histories ?? 0);
      report.service.messages = Number(counts?.messages ?? 0);
      const failures = state.database.prepare(`WITH observations AS (
        SELECT namespace,
          CASE WHEN json_valid(value) THEN json_extract(value, '$.status') END AS status,
          CASE WHEN json_valid(value) THEN json_extract(value, '$.errorClass') END AS error_class,
          CASE WHEN json_valid(value) THEN json_extract(value, '$.endedAt') END AS ended_at
        FROM records WHERE namespace IN ('chat:generations', 'durable:runs')
      ) SELECT namespace, status, error_class, ended_at FROM observations
        WHERE status IN ('failed', 'interrupted') ORDER BY ended_at DESC LIMIT 10`).all();
      report.recentFailures.items = failures.map((failure) => ({
        source: failure.namespace === "chat:generations" ? "chat" : "execution",
        status: failure.status === "interrupted" ? "interrupted" : "failed",
        errorClass: FAILURE_CLASSES.includes(failure.error_class as typeof FAILURE_CLASSES[number])
          ? failure.error_class as typeof FAILURE_CLASSES[number] : "unknown",
        endedAt: safeTimestamp(failure.ended_at),
      }));
      report.recentFailures.available = true;
    } catch {
      report.service.durableStore = "unavailable";
    }
  }
  try {
    const file = record(readJson(path.join(dataDirectory(), "provider-instances.json")));
    if (file?.version !== 1 || !Array.isArray(file.instances)) throw new Error("Invalid configuration.");
    for (const value of file.instances) {
      const instance = record(value);
      if (!instance || typeof instance.driver !== "string") throw new Error("Invalid driver.");
      report.providers.total++;
      if (!DRIVERS.includes(instance.driver as ProviderDriver)) {
        report.providers.inactive++;
        continue;
      }
      const driver = instance.driver as ProviderDriver;
      const enabled = instance.enabled !== false;
      const observations = record(instance.observations);
      const test = record(observations?.lastConnectionTest);
      const current = enabled && observations?.instanceRevision === instance.revision
        && test?.instanceRevision === instance.revision;
      const timestamp = current ? safeTimestamp(test?.checkedAt) : null;
      const installation = record(observations?.installation);
      report.providers.observations.push({
        index: report.providers.total, driver, enabled,
        authentication: current && timestamp && test?.authentication === "authenticated" ? "authenticated"
          : current && timestamp && test?.authentication === "unauthenticated" ? "unauthenticated"
          : enabled && observations?.instanceRevision === instance.revision && installation?.status === "not-installed" ? "not-installed" : "unknown",
        connection: current && timestamp && typeof test?.ok === "boolean" ? test.ok ? "ok" : "failed" : "unknown",
        checkedAt: timestamp,
      });
      report.providers.native++;
    }
    report.providers.configuration = "ok";
  } catch {
    report.providers = { configuration: "unavailable", total: 0, native: 0, inactive: 0, observations: [] };
  }
  return report;
}

export function collectAgentStorage(): AgentStorage {
  const directory = dataDirectory();
  const entries: AgentStorage["entries"] = [
    { kind: "database", path: path.join(directory, "workspace.sqlite"), owner: "Agent service", status: "missing", bytes: null,
      sensitive: true, backupPolicy: "离线 SQLite 一致快照；包含会话、消息、生成日志、默认设置和工作区资源。WAL 由快照合并，不单独复制。" },
    { kind: "provider-config", path: path.join(directory, "provider-instances.json"), owner: "Agent service", status: "missing", bytes: null,
      sensitive: true, backupPolicy: "包含原生 Agent 实例、模型、私有配置与环境覆盖；离线备份必须显式选择 include/exclude 凭据策略。exclude 清除秘密和端点覆盖并禁用实例，需明确重新配置和启用。" },
    { kind: "provider-credentials", path: path.join(directory, "providers.json"), owner: "Agent service", status: "missing", bytes: null,
      sensitive: true, backupPolicy: "已停用的旧 API 凭据仅 --secrets include 纳入私有离线备份；不会在 Provider 迁移或 HTTP 中读取、导出或删除。" },
    { kind: "provider-homes", path: path.join(directory, "provider-homes"), owner: "Provider CLI", status: "missing", bytes: null,
      sensitive: true, backupPolicy: "含原生 Agent 登录与历史；仅 include 纳入数据目录内部专属 home，外部或全局 home 不自动读取。exclude 恢复需明确重新配置、登录和启用。" },
    { kind: "maintenance-lock", path: path.join(directory, "workspace.lock"), owner: "Agent service", status: "missing", bytes: null,
      sensitive: false, backupPolicy: "只检查 PID 和独占所有权，不备份、不终止进程。" },
  ];
  try {
    const config = record(readJson(path.join(directory, "provider-instances.json")));
    if (config?.version === 1 && Array.isArray(config.instances)) {
      for (const value of config.instances) {
        const instance = record(value);
        if (!instance || !DRIVERS.includes(instance.driver as ProviderDriver) || typeof instance.instanceId !== "string"
          || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(instance.instanceId)) continue;
        const config = record(instance.config);
        const homes = [path.join(directory, "provider-homes", instance.instanceId), instance.cliHome, config?.homePath, config?.shadowHomePath];
        for (const value of homes) {
          if (typeof value !== "string" || !path.isAbsolute(value) || entries.some((entry) => entry.path === value)) continue;
          const home = path.resolve(value);
          const relative = path.relative(path.join(directory, "provider-homes"), home);
          const internal = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
          entries.push({ kind: "provider-homes", path: home, owner: "Provider CLI",
            status: "missing", bytes: null, sensitive: true,
            backupPolicy: internal
              ? "实际配置的专属 Agent home；include 私有离线备份纳入，exclude 不读取内容并在新目标建立空 home，需显式重新登录和启用。"
              : "实际配置位于专属 provider-homes 范围外；从不隐式读取。include 仅保留路径引用，不收集内容或在恢复时创建该目录；exclude 清除此覆盖，需显式重新配置、登录和启用。" });
        }
      }
    }
  } catch { /* Invalid config contents are never returned, and no defaults are initialized. */ }
  for (const entry of entries) {
    try {
      const info = lstatSync(entry.path);
      entry.status = info.isSymbolicLink() || !(info.isFile() || info.isDirectory()) ? "unavailable" : "present";
      entry.bytes = info.isFile() ? info.size : null;
    } catch (error) {
      entry.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
    }
  }
  return { dataDirectory: directory, entries,
    exclusions: ["PM PostgreSQL、Markdown、附件与项目源文件：由既有 PM 备份负责，本工具不读取或修改。",
      "服务 .env.agent、浏览器偏好及 Cookie：不自动备份，恢复环境须单独配置和重新登录。",
      "全局或数据目录外的 CLI home：永不隐式导入；include 仅保留路径引用，不收集内容，恢复时不创建这些目录。",
      "诊断下载只含状态白名单，不是备份，也不包含上述实际路径。"],
    maintenance: { offlineOnly: true, httpBackupAvailable: false, restoreRequiresEmptyTarget: true,
      commands: ["pnpm agent:backup create --source <Agent数据目录> --bundle <新私有备份目录> --secrets exclude --stopped",
        "pnpm agent:backup restore --bundle <备份目录> --target <独立空目录> --stopped",
        "pnpm agent:backup verify --bundle <备份目录> --target <已恢复目录> --stopped"] } };
}

export const diagnosticsRoutes = new Hono()
  .get("/settings/diagnostics", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(collectAgentDiagnostics());
  })
  .get("/settings/diagnostics/report", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", 'attachment; filename="agent-diagnostics.json"');
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(collectAgentDiagnostics());
  })
  .get("/settings/storage", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(collectAgentStorage());
  });
