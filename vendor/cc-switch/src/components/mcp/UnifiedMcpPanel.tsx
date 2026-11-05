import { webPlatform } from "../../web/bridge";
import React, { useMemo, useRef, useState } from "react";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useMcpConnectivity } from "../../hooks/useMcpConnectivity";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Download,
  MoreHorizontal,
  Pencil,
  Plus,
  Server,
} from "lucide-react";
import { toast } from "../../lib/toast";
import { Button } from "../ui/button";
import { HelpTip } from "../ui/help-tip";
import { Notice, NoticeSlot } from "../ui/notice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { HoverTip } from "../ui/hover-tip";
import { AppPageHeader } from "../shell/AppPageHeader";
import { APP_DISPLAY_NAME } from "../shell/AppGlyph";
import { useIsMutating } from "@tanstack/react-query";
import {
  MCP_UPSERT_MUTATION_KEY,
  useAllMcpServers,
  useBulkToggleMcpApp,
  useDeleteMcpServer,
  useMcpManagement,
  useResyncMcpToApps,
  useToggleMcpApp,
} from "../../hooks/useMcp";
import type { McpServer } from "../../types";
import type { McpAppSyncOutcome } from "../../lib/api/mcp";
import { MCP_APP_IDS, isMcpAppId, type McpAppId } from "../../config/appConfig";
import { mcpPresets } from "../../config/mcpPresets";
import { settingsApi } from "../../web/api";
import { copyText } from "../../lib/clipboard";
import {
  extractErrorMessage,
  translateMcpBackendError,
} from "../../utils/errorUtils";
import { cn } from "../../lib/utils";
import McpFormModal from "./McpFormModal";
import {
  MatrixCell,
  MatrixColumnHeader,
  MatrixColumnHighlight,
  MatrixSearch,
  NeutralBadge,
  ompDiscoveryColumnNote,
  resolveBulkScope,
  showUndoToast,
} from "./AppMatrix";
import { V7ConfirmDialog } from "./formBits";
import { useVisibleAppIds } from "./useVisibleAppIds";

function getMcpSearchText(id: string, server: McpServer): string {
  const spec = server.server ?? {};
  const values: unknown[] = [
    id,
    server.id,
    server.name,
    server.description,
    ...(Array.isArray(server.tags) ? server.tags : []),
    spec.type,
    spec.command,
    ...(Array.isArray(spec.args) ? spec.args : []),
    spec.cwd,
    spec.url,
    server.homepage,
    server.docs,
    server.source,
  ];

  // Keep this an explicit allow-list. In particular, env and headers may
  // contain credentials and must never become part of the searchable text.
  return values
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}


/** 先写配置文件、成功后才入库的应用：写失败时开关没变，重试要逐行重写 */
const WRITE_THEN_SAVE_APPS: ReadonlySet<McpAppId> = new Set([
  "mcode",
  "kimi",
  "dsh",
  "pi",
  "agy",
  "omp",
]);

/** 写入失败：记下想要的状态，「重试」按这个值再写一次 */
interface WriteFailure {
  desired: boolean;
  error: string;
}

const failKey = (id: string, app: McpAppId) => `${id}\u0000${app}`;

interface UnifiedMcpPanelProps {
  onInteractionBlockedChange?: (blocked: boolean) => void;
  onImport?: () => void;
}


/**
 * MCP 全局页（v7）：页头 + 应用矩阵 + 添加 / 编辑抽屉。
 * 以这里为准写进勾选的应用；不支持的应用（Claude Desktop、OpenClaw）没有列。
 */
const UnifiedMcpPanel: React.FC<UnifiedMcpPanelProps> = ({
  onInteractionBlockedChange,
  onImport,
}) => {
  const { t } = useTranslation();
  const appIds = useVisibleAppIds(MCP_APP_IDS);
  const [drawer, setDrawer] = useState<
    { mode: "add" } | { mode: "edit"; id: string } | null
  >(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<McpAppId | "all">("all");
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [fails, setFails] = useState<Record<string, WriteFailure>>({});
  /** 整个应用重新同步失败（「重新同步到各应用」或通知条「重试」），不对应某一行 */
  const [appFails, setAppFails] = useState<Partial<Record<McpAppId, string>>>(
    {},
  );
  const [writePending, setWritePending] = useState(false);
  const writeLockRef = useRef(false);

  const {
    data: serversMap,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = useAllMcpServers();
  const connectivity = useMcpConnectivity(isError ? undefined : serversMap);
  const toggleAppMutation = useToggleMcpApp();
  const bulkToggleAppMutation = useBulkToggleMcpApp();
  const deleteServerMutation = useDeleteMcpServer();
  const { data: management, error: managementLoadError, refetch: refetchManagement } = useMcpManagement();
  const resyncMutation = useResyncMcpToApps();

  const mutationPending =
    toggleAppMutation.isPending ||
    bulkToggleAppMutation.isPending ||
    deleteServerMutation.isPending ||
    resyncMutation.isPending;
  const dialogOpen =
    drawer !== null || deleteId !== null;
  const interactionBlocked = writePending || mutationPending || dialogOpen;
  // 外观上的禁用晚 300ms 才出现：点一个格子写得很快时不让整页按钮闪一下变灰。
  // 写入本身仍由写锁（writeLockRef / interactionBlocked）拦着。
  const controlsDisabled = useDelayedFlag(interactionBlocked);

  // 编辑页自己的保存不在 mutationPending 里，按 mutation key 单独看
  const editorSaving =
    useIsMutating({ mutationKey: MCP_UPSERT_MUTATION_KEY }) > 0;
  // 报给外壳的导航锁不算编辑页：编辑页只盖住内容区，离开页面就关掉它（同供应商编辑页）；
  // 写入进行中（含编辑页自己的保存）仍锁
  const navigationBlocked =
    writePending ||
    mutationPending ||
    editorSaving ||
    deleteId !== null ||
    connectivity.checking;
  React.useEffect(() => {
    onInteractionBlockedChange?.(navigationBlocked);
  }, [navigationBlocked, onInteractionBlockedChange]);

  React.useEffect(
    () => () => onInteractionBlockedChange?.(false),
    [onInteractionBlockedChange],
  );

  const beginWrite = (allowOpenDialog = false) => {
    if (
      writeLockRef.current ||
      mutationPending ||
      (!allowOpenDialog && dialogOpen)
    ) {
      return false;
    }
    writeLockRef.current = true;
    setWritePending(true);
    return true;
  };

  const endWrite = () => {
    writeLockRef.current = false;
    setWritePending(false);
  };

  const serverEntries = useMemo((): Array<[string, McpServer]> => {
    if (!serversMap) return [];
    return Object.entries(serversMap);
  }, [serversMap]);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredServerEntries = useMemo(() => {
    return serverEntries.filter(([id, server]) => {
      if (normalizedSearchQuery && !getMcpSearchText(id, server).includes(normalizedSearchQuery)) return false;
      if (agentFilter !== "all" && !server.apps[agentFilter]) return false;
      if (!abnormalOnly) return true;
      const rows = Object.values(management?.agentConfigurations[id] ?? {});
      return rows.some(row => !row.compatibility.supported || ["pending", "error", "unavailable"].includes(row.sync.state)) ||
        Object.keys(fails).some(key => key.startsWith(`${id}\u0000`)) ||
        connectivity.states[id] === "disconnected";
    });
  }, [normalizedSearchQuery, serverEntries, agentFilter, abnormalOnly, management, fails, connectivity.states]);

  const scope = resolveBulkScope(
    serverEntries,
    filteredServerEntries,
    normalizedSearchQuery || agentFilter !== "all" || abnormalOnly ? "search" : null,
  );

  const noun = t("mcpPage.noun");

  // ─── 写入与失败记录 ────────────────────────────────────────────────
  const recordResult = (
    id: string,
    app: McpAppId,
    desired: boolean,
    error?: unknown,
  ) => {
    setFails((prev) => {
      const next = { ...prev };
      const key = failKey(id, app);
      if (error === undefined) delete next[key];
      else {
        const detail = extractErrorMessage(error);
        next[key] = {
          desired,
          error: translateMcpBackendError(detail, t) || detail,
        };
      }
      return next;
    });
  };

  const writeOne = async (id: string, app: McpAppId, enabled: boolean) => {
    if (!beginWrite()) return;
    try {
      await toggleAppMutation.mutateAsync({ serverId: id, app, enabled });
      recordResult(id, app, enabled);
    } catch (error) {
      recordResult(id, app, enabled, error);
    } finally {
      endWrite();
    }
  };

  /** 依次写一组（服务器, 应用）；返回成功写入的那些 */
  const writeMany = async (
    pairs: Array<{ id: string; app: McpAppId }>,
    enabled: boolean,
  ) => {
    const byApp = new Map<McpAppId, string[]>();
    let failed = 0;
    for (const pair of pairs) {
      const row = management?.agentConfigurations[pair.id]?.[pair.app];
      if (!management?.boundApps.includes(pair.app) || !row || (enabled && !row.compatibility.supported)) {
        failed += 1;
        recordResult(pair.id, pair.app, enabled, new Error(!row ? t("MCP_PM$TARGET_UNBOUND") : row.compatibility.reason ? t(`MCP_PM$REASON_${row.compatibility.reason}`, { defaultValue: row.compatibility.reason }) : t("MCP_PM$NO_SUPPORTED_CONFIG")));
        continue;
      }
      byApp.set(pair.app, [...(byApp.get(pair.app) ?? []), pair.id]);
    }
    const succeeded: Array<{ id: string; app: McpAppId }> = [];
    for (const [app, ids] of byApp) {
      try {
        const result = await bulkToggleAppMutation.mutateAsync({
          serverIds: ids,
          app,
          enabled,
        });
        for (const id of result.succeeded) {
          recordResult(id, app, enabled);
          succeeded.push({ id, app });
        }
        for (const failure of result.failed) {
          failed += 1;
          recordResult(failure.item, app, enabled, failure.error);
        }
      } catch (error) {
        failed += ids.length;
        for (const id of ids) recordResult(id, app, enabled, error);
      }
    }
    return { succeeded, failed };
  };

  const handleCellClick = (id: string, server: McpServer, app: McpAppId) => {
    const failure = fails[failKey(id, app)];
    if (failure) {
      void writeOne(id, app, failure.desired);
      return;
    }
    void writeOne(id, app, !server.apps[app]);
  };

  /**
   * 记下重新同步的逐应用结果。成功的应用清掉它的失败记录——数据库里的开关已经写进去了；
   * MiniMax Code 例外：它写失败时开关没有入库，重新同步补不上，行上的失败要留着按想要的值重试。
   */
  const applyResyncOutcomes = (outcomes: McpAppSyncOutcome[]) => {
    const okApps = new Set<McpAppId>();
    const failedApps: Partial<Record<McpAppId, string>> = {};
    for (const outcome of outcomes) {
      if (!isMcpAppId(outcome.app)) continue;
      if (outcome.ok) okApps.add(outcome.app);
      else failedApps[outcome.app] = outcome.error || t("common.error");
    }
    setAppFails((prev) => {
      const next = { ...prev, ...failedApps };
      for (const app of okApps) delete next[app];
      return next;
    });
    setFails((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const app = key.split("\u0000")[1] as McpAppId;
        if (okApps.has(app) && !WRITE_THEN_SAVE_APPS.has(app)) delete next[key];
      }
      return next;
    });
    return outcomes.filter((outcome) => !outcome.ok);
  };

  const rowFailsFor = (app: McpAppId) =>
    Object.entries(fails).filter(([key]) => key.endsWith(`\u0000${app}`));

  const retryApp = async (app: McpAppId) => {
    if (!beginWrite()) return;
    try {
      const entries = rowFailsFor(app);
      let ok = true;
      if (WRITE_THEN_SAVE_APPS.has(app) && entries.length > 0) {
        // MiniMax Code / Pi 写失败时开关没入库：按每行想要的值再写一次
        for (const [key, failure] of entries) {
          const id = key.split("\u0000")[0];
          const { failed } = await writeMany([{ id, app }], failure.desired);
          if (failed) ok = false;
        }
      } else {
        // 其余应用的开关已经入库：按这里的开关把这个应用整个重写一遍
        try {
          const outcomes = await resyncMutation.mutateAsync([app]);
          ok = applyResyncOutcomes(outcomes).length === 0;
        } catch (error) {
          ok = false;
          setAppFails((prev) => ({
            ...prev,
            [app]: extractErrorMessage(error) || String(error),
          }));
        }
      }
      if (ok) {
        toast.success(
          t("mcpPage.toast.written", { app: APP_DISPLAY_NAME[app] }),
          { closeButton: true },
        );
      }
    } finally {
      endWrite();
    }
  };

  const handleResyncAll = async () => {
    if (!beginWrite()) return;
    try {
      const outcomes = await resyncMutation.mutateAsync(undefined);
      const failed = applyResyncOutcomes(outcomes);
      if (failed.length === 0) {
        toast.success(t("mcpPage.toast.resynced", { count: outcomes.length }), {
          closeButton: true,
        });
      } else {
        toast.warning(
          t("mcpPage.toast.resyncPartial", {
            count: failed.length,
            apps: failed
              .map((outcome) =>
                isMcpAppId(outcome.app)
                  ? APP_DISPLAY_NAME[outcome.app]
                  : outcome.app,
              )
              .join(t("mcpPage.listSeparator")),
          }),
          { closeButton: true },
        );
      }
    } catch (error) {
      toast.error(t("common.error"), {
        description: extractErrorMessage(error) || String(error),
      });
    } finally {
      endWrite();
    }
  };

  const handleBulk = async (app: McpAppId, enabled: boolean) => {
    if (!beginWrite()) return;
    try {
      const targets = scope.rows
        .filter(([, server]) => Boolean(server.apps[app]) !== enabled)
        .map(([id]) => ({ id, app }));
      if (targets.length === 0) return;
      const { succeeded, failed } = await writeMany(targets, enabled);
      const appName = APP_DISPLAY_NAME[app];
      let text = enabled
        ? t("appMatrix.toast.enabled", {
            app: appName,
            count: succeeded.length,
            noun,
          })
        : t("appMatrix.toast.disabled", {
            app: appName,
            count: succeeded.length,
            noun,
          });
      if (failed) text += t("appMatrix.toast.partialFail", { count: failed });
      showUndoToast(
        text,
        t("appMatrix.undo"),
        succeeded.length
          ? () => {
              void (async () => {
                if (!beginWrite()) return;
                try {
                  const result = await writeMany(succeeded, !enabled);
                  if (result.failed) {
                    toast[result.succeeded.length ? "warning" : "error"](
                      t("common.bulkToggleFailed", { count: result.failed }),
                      { closeButton: true },
                    );
                  } else {
                    toast.success(t("appMatrix.toast.undone"), {
                      closeButton: true,
                    });
                  }
                } finally {
                  endWrite();
                }
              })();
            }
          : undefined,
        failed ? (succeeded.length ? "warning" : "error") : "success",
      );
    } finally {
      endWrite();
    }
  };

  const handleRowAll = async (id: string, server: McpServer, on: boolean) => {
    if (!beginWrite()) return;
    try {
      const targets = appIds
        .filter((app) => Boolean(server.apps[app]) !== on)
        .map((app) => ({ id, app }));
      if (targets.length === 0) return;
      const { failed } = await writeMany(targets, on);
      if (!failed) {
        toast.success(
          on
            ? t("mcpPage.toast.rowAllOn", { id, count: appIds.length })
            : t("mcpPage.toast.rowAllOff", { id }),
          { closeButton: true },
        );
      }
    } finally {
      endWrite();
    }
  };

  // ─── 其他操作 ───────────────────────────────────────────────────────
  const openAdd = () => {
    if (writeLockRef.current || interactionBlocked) return;
    setDrawer({ mode: "add" });
  };

  const openEdit = (id: string) => {
    if (writeLockRef.current || interactionBlocked) return;
    setDrawer({ mode: "edit", id });
  };

  const handleImport = () => {
    if (!writeLockRef.current && !interactionBlocked) onImport?.();
  };

  const copyJson = async (servers: Record<string, McpServer>, text: string) => {
    const mcpServers = Object.fromEntries(
      Object.entries(servers).map(([id, server]) => [id, server.server]),
    );
    try {
      await copyText(JSON.stringify({ mcpServers }, null, 2));
      toast.success(text, { closeButton: true });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const openDocs = async (server: McpServer, id: string) => {
    const preset = mcpPresets.find((item) => item.id === id);
    const url =
      server.docs || preset?.docs || server.homepage || preset?.homepage;
    if (!url) return;
    try {
      await settingsApi.openExternal(url);
    } catch {
      // ignore
    }
  };

  const confirmDelete = async () => {
    if (!deleteId || !beginWrite(true)) return;
    const id = deleteId;
    try {
      await deleteServerMutation.mutateAsync(id);
      setDeleteId(null);
      setDrawer(null);
      setFails((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(
            ([key]) => !key.startsWith(`${id}\u0000`),
          ),
        ),
      );
      toast.success(t("mcpPage.toast.deleted", { id }), { closeButton: true });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  // ─── 派生显示 ───────────────────────────────────────────────────────
  /** 有写入失败的应用 → 通知条里显示的错误（整个应用的失败优先） */
  const failedApps = useMemo(() => {
    const map = new Map<McpAppId, string>();
    for (const [key, failure] of Object.entries(fails)) {
      const app = key.split("\u0000")[1] as McpAppId;
      if (!serversMap?.[key.split("\u0000")[0]]) continue;
      if (!map.has(app)) map.set(app, failure.error);
    }
    for (const app of MCP_APP_IDS) {
      const error = appFails[app];
      if (error !== undefined) map.set(app, error);
    }
    return map;
  }, [fails, appFails, serversMap]);

  const enabledNames = (server: McpServer) =>
    MCP_APP_IDS.filter((app) => server.apps[app]).map(
      (app) => APP_DISPLAY_NAME[app],
    );

  const deleteTarget = deleteId ? serversMap?.[deleteId] : undefined;
  const deleteApps = deleteTarget ? enabledNames(deleteTarget) : [];
  const listSeparator = t("mcpPage.listSeparator");

  const hasServers = serverEntries.length > 0;
  const showList = !isLoading && !isError && hasServers;

  return (
    <>
      <AppPageHeader
        icon={<Server className="h-5 w-5" strokeWidth={1.5} />}
        title="MCP"
        titleExtra={
          <HelpTip title={t("mcpPage.helpTitle")}>{t("mcpPage.help")}</HelpTip>
        }
        actions={
          <>
            <Button
              type="button"
              variant="quiet"
              size="regular"
              disabled={!connectivity.canCheck || connectivity.checking}
              onClick={connectivity.checkAll}
            >
              <Activity className="h-4 w-4" strokeWidth={2} />
              {t("mcpPage.checkConnectivity")}
            </Button>
            {connectivity.checking && <Button type="button" variant="quiet" size="regular" onClick={connectivity.cancelAll}>{t("common.cancel")}</Button>}
            <Button
              type="button"
              variant="quiet"
              size="regular"
              disabled={controlsDisabled || !onImport || webPlatform().context.apps.length === 0}
              onClick={() => void handleImport()}
            >
              <Download className="h-4 w-4" strokeWidth={2} />
              {t("MCP_PM$PREVIEW_IMPORT")}
            </Button>
            <Button
              type="button"
              variant="solid"
              size="regular"
              disabled={controlsDisabled}
              onClick={openAdd}
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t("mcpPage.add")}
            </Button>
            <DropdownMenu>
              <HoverTip content={t("common.more")}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon-compact"
                    className="h-8 w-8"
                    aria-label={t("mcpPage.moreActions")}
                  >
                    <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                </DropdownMenuTrigger>
              </HoverTip>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                <DropdownMenuItem
                  disabled={controlsDisabled || webPlatform().context.apps.length === 0}
                  onSelect={() => void handleResyncAll()}
                >
                  {t("mcpPage.resync")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasServers}
                  onSelect={() =>
                    void copyJson(
                      serversMap ?? {},
                      t("mcpPage.toast.copiedAll", {
                        count: serverEntries.length,
                      }),
                    )
                  }
                >
                  {t("mcpPage.copyAll")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div id="main-content" className="flex min-h-0 flex-1 flex-col">
        {connectivity.errors.map((error, index) => <p key={`${index}:${error}`} role="alert" className="px-6 py-2 text-caption text-danger-text">{t("MCP_PM$PROBE_ERROR", { error })}</p>)}
        {managementLoadError && <p role="alert" className="px-6 py-2 text-caption text-danger-text">{t("MCP_PM$MANAGEMENT_SNAPSHOT", { error: extractErrorMessage(managementLoadError) })} <button type="button" className="underline" disabled={writePending || mutationPending} onClick={() => void refetchManagement()}>{t("MCP_PM$RETRY_READ")}</button></p>}
        <p className="px-6 py-2 text-caption text-fg-2">{t("MCP_PM$MATRIX_HELP")}</p>
        {showList && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 py-3">
            <MatrixSearch
              className="w-[320px] min-w-[180px] shrink"
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder={t("mcpPage.searchPlaceholder")}
              ariaLabel={t("mcp.unifiedPanel.searchAriaLabel")}
              status={
                normalizedSearchQuery
                  ? t("appMatrix.found", {
                      count: filteredServerEntries.length,
                    })
                  : ""
              }
            />
            <select aria-label={t("MCP_PM$FILTER_AGENT")} value={agentFilter} onChange={event => setAgentFilter(event.target.value as McpAppId | "all")} className="rounded-control border border-border bg-surface px-2 py-1 text-caption">
              <option value="all">{t("MCP_PM$ALL_AGENTS")}</option>
              {appIds.map(app => <option key={app} value={app}>{APP_DISPLAY_NAME[app]}</option>)}
            </select>
            <label className="flex items-center gap-1 text-caption"><input type="checkbox" checked={abnormalOnly} onChange={event => setAbnormalOnly(event.target.checked)} />{t("MCP_PM$ATTENTION")}</label>
            <span className="shrink-0 whitespace-nowrap text-caption tabular-nums text-fg-2">
              {normalizedSearchQuery || agentFilter !== "all" || abnormalOnly
                ? t("mcpPage.countFiltered", {
                    shown: filteredServerEntries.length,
                    count: serverEntries.length,
                  })
                : t("mcpPage.count", { count: serverEntries.length })}
            </span>
            <span className="ms-auto min-w-0 truncate text-caption text-fg-2">
              {t("mcpPage.overwriteNote")}
            </span>
          </div>
        )}

        <NoticeSlot className={cn(failedApps.size > 0 && "px-6 pb-3")}>
          {Array.from(failedApps.entries()).map(([app, error]) => (
            <Notice
              key={app}
              tone="warning"
              title={t("mcpPage.failNoticeTitle", {
                app: APP_DISPLAY_NAME[app],
              })}
              actions={
                <Button
                  type="button"
                  variant="neutral"
                  size="compact"
                  disabled={controlsDisabled}
                  onClick={() => void retryApp(app)}
                >
                  {t("common.retry")}
                </Button>
              }
            >
              {t("mcpPage.failNoticeBody", { error })}
            </Notice>
          ))}
        </NoticeSlot>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-5">
          {isLoading ? (
            <div className="py-12 text-center text-body text-fg-2">
              {t("mcp.loading")}
            </div>
          ) : isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-10 pb-12 text-center">
              <h2 className="m-0 text-section">{t("mcpPage.loadFailed")}</h2>
              <code className="max-w-[520px] rounded-[8px] bg-subtle px-3 py-2 text-left font-mono text-caption text-fg-2 [overflow-wrap:anywhere]">
                {extractErrorMessage(loadError) || String(loadError)}
              </code>
              <p className="m-0 text-body text-fg-2">
                {t("mcpPage.noFilesChanged")}
              </p>
              <Button
                type="button"
                variant="neutral"
                size="regular"
                className="mt-1"
                onClick={() => void refetch()}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : !hasServers ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 pb-12 text-center">
              <h2 className="m-0 text-section">{t("mcpPage.emptyTitle")}</h2>
              <div className="flex items-center gap-0.5">
                <p className="m-0 text-body text-fg-2">
                  {t("mcpPage.emptyBody")}
                </p>
                <HelpTip title={t("mcpPage.importHelpTitle")} align="end">
                  {t("mcpPage.importHelp")}
                </HelpTip>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="neutral"
                  size="regular"
                  disabled={controlsDisabled || !onImport || webPlatform().context.apps.length === 0}
                  onClick={() => void handleImport()}
                >
                  <Download className="h-3.5 w-3.5" strokeWidth={2} />
                  {t("MCP_PM$PREVIEW_IMPORT")}
                </Button>
                <Button
                  type="button"
                  variant="neutral"
                  size="regular"
                  disabled={controlsDisabled}
                  onClick={openAdd}
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  {t("mcpPage.add")}
                </Button>
              </div>
            </div>
          ) : (
            <div
              data-testid="mcp-matrix"
              className="min-h-0 overflow-auto scroll-stable rounded-panel border border-border bg-surface"
            >
              <MatrixColumnHighlight>
                <div className="min-w-[560px]">
                  <div className="sticky top-0 z-10 flex h-11 items-center border-b border-border bg-subtle pe-2 ps-4">
                    <span className="min-w-0 flex-1 text-caption font-semibold text-fg-2">
                      {t("mcpPage.columnName")}
                    </span>
                    <div className="flex shrink-0">
                      {appIds.map((app) => {
                        const enabledCount = serverEntries.filter(
                          ([, server]) => server.apps[app],
                        ).length;
                        const scopeEnabled = scope.rows.filter(
                          ([, server]) => server.apps[app],
                        ).length;
                        const scopeFailed = scope.rows.filter(
                          ([id]) => fails[failKey(id, app)],
                        ).length;
                        return (
                          <MatrixColumnHeader
                            key={app}
                            app={app}
                            enabledCount={enabledCount}
                            totalCount={serverEntries.length}
                            scopeTotal={scope.rows.length}
                            scopeEnabled={scopeEnabled}
                            scopeFailed={scopeFailed}
                            scopeKind={scope.kind}
                            noun={noun}
                            disabled={controlsDisabled}
                            {...ompDiscoveryColumnNote(app, t)}
                            onEnableRest={() => void handleBulk(app, true)}
                            onDisableAll={() => void handleBulk(app, false)}
                          />
                        );
                      })}
                    </div>
                    <span aria-hidden="true" className="w-16 shrink-0" />
                  </div>

                  {filteredServerEntries.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
                      <span className="text-body text-fg-2">
                        {t("mcpPage.noMatch", { query: searchQuery.trim() })}
                      </span>
                      <Button
                        type="button"
                        variant="neutral"
                        size="regular"
                        onClick={() => setSearchQuery("")}
                      >
                        {t("mcpPage.clearSearch")}
                      </Button>
                    </div>
                  ) : (
                    <ul
                      aria-label={t("mcpPage.listLabel")}
                      className="m-0 list-none p-0"
                    >
                      {filteredServerEntries.map(([id, server], index) => {
                        const enabled = webPlatform().context.kind !== "project" &&
                          MCP_APP_IDS.some((app) => server.apps[app]);
                        const connection = enabled
                          ? (connectivity.states[id] ?? "unchecked")
                          : "disabled";
                        const rowFailedApps = appIds.filter(
                          (app) => fails[failKey(id, app)],
                        );
                        const summary = `${server.server.type === "sse" ? "SSE" : server.server.type === "stdio" || typeof server.server.command === "string" ? "STDIO" : "HTTP"} · ${enabledNames(server).join(listSeparator) || t("MCP_PM$UNASSIGNED")}`;
                        const failedNames = rowFailedApps
                          .map((app) => APP_DISPLAY_NAME[app])
                          .join(listSeparator);
                        const hasDocs = Boolean(
                          server.docs ||
                            server.homepage ||
                            mcpPresets.find((item) => item.id === id)?.docs,
                        );
                        const displayName = server.name?.trim() || id;
                        const hasCustomName = Boolean(
                          server.name?.trim() && server.name.trim() !== id,
                        );
                        return (
                          <li
                            key={id}
                            onClick={() => openEdit(id)}
                            className={cn(
                              "flex h-14 cursor-pointer items-center pe-2 ps-4 transition-colors duration-150 hover:bg-subtle",
                              index > 0 && "border-t border-border",
                            )}
                          >
                            <div className="flex min-w-0 flex-1 flex-col pe-3">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span
                                  role="img"
                                  aria-label={t("MCP_PM$PROBE_LABEL", { state: t(`MCP_PM$PROBE_${enabled ? connection : "unavailable"}`) })}
                                  title={t("MCP_PM$PROBE_LABEL", { state: t(`MCP_PM$PROBE_${enabled ? connection : "unavailable"}`) })}
                                  className={cn(
                                    "h-2 w-2 shrink-0 rounded-full",
                                    connection === "connected"
                                      ? "bg-success"
                                      : connection === "disconnected"
                                        ? "bg-danger"
                                        : connection === "checking"
                                          ? "animate-pulse bg-fg-3"
                                          : "bg-fg-3",
                                  )}
                                />
                                <span
                                  title={displayName}
                                  className="min-w-0 truncate text-body font-medium"
                                >
                                  {displayName}
                                </span>
                                {hasCustomName && (
                                  <span
                                    title={id}
                                    className="min-w-0 shrink truncate font-mono text-caption text-fg-3"
                                  >
                                    {id}
                                  </span>
                                )}
                                {!enabled && (
                                  <NeutralBadge>
                                    {t("mcpPage.notEnabled")}
                                  </NeutralBadge>
                                )}
                              </div>
                              <div className="flex min-w-0 items-center text-caption text-fg-2">
                                <span
                                  title={summary}
                                  className="min-w-0 truncate font-mono"
                                >
                                  {summary}
                                </span>
                                {rowFailedApps.length > 0 && (
                                  <span className="ms-2.5 shrink-0 whitespace-nowrap text-warning-text">
                                    {t("mcpPage.rowFail", {
                                      apps: failedNames,
                                    })}
                                    {" · "}
                                    <button
                                      type="button"
                                      className="font-medium underline underline-offset-[3px]"
                                      aria-label={t("mcpPage.rowRetryAria", {
                                        id,
                                        apps: failedNames,
                                      })}
                                      disabled={controlsDisabled}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        const app = rowFailedApps[0];
                                        void writeOne(
                                          id,
                                          app,
                                          fails[failKey(id, app)].desired,
                                        );
                                      }}
                                    >
                                      {t("common.retry")}
                                    </button>
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0">
                              {appIds.map((app) => {
                                const failure = fails[failKey(id, app)];
                                const on = Boolean(server.apps[app]);
                                const configuration = management?.agentConfigurations[id]?.[app];
                                const reason = configuration?.compatibility.reason ?? configuration?.sync.reason;
                                const stateDescription = !management ? t("MCP_PM$SNAPSHOT_UNAVAILABLE")
                                  : !management.boundApps.includes(app) ? t("MCP_PM$TARGET_UNBOUND")
                                  : reason ? t(`MCP_PM$REASON_${reason}`, { defaultValue: reason })
                                  : configuration ? t(`MCP_PM$SYNC_${configuration.sync.state}`)
                                  : t("MCP_PM$STATE_UNAVAILABLE");
                                const state = failure
                                  ? "fail"
                                  : on
                                    ? "on"
                                    : "off";
                                return (
                                  <MatrixCell
                                    key={app}
                                    app={app}
                                    state={state}
                                    disabled={controlsDisabled || !management?.boundApps.includes(app) || !management.agentConfigurations[id]?.[app] || (!on && !management.agentConfigurations[id]?.[app]?.compatibility.supported)}
                                    label={`${t(`appMatrix.cell.${state}`, {
                                      name: id,
                                      app: APP_DISPLAY_NAME[app],
                                    })} · ${stateDescription}`}
                                    onClick={() =>
                                      handleCellClick(id, server, app)
                                    }
                                  />
                                );
                              })}
                            </div>
                            <div
                              className="flex w-16 shrink-0 justify-end gap-1"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <HoverTip content={t("common.edit")}>
                                <Button
                                  type="button"
                                  variant="quiet"
                                  size="icon-compact"
                                  aria-label={t("mcpPage.editAria", { id })}
                                  disabled={controlsDisabled}
                                  onClick={() => openEdit(id)}
                                >
                                  <Pencil
                                    className="h-[15px] w-[15px]"
                                    strokeWidth={1.5}
                                  />
                                </Button>
                              </HoverTip>
                              <DropdownMenu>
                                <HoverTip content={t("common.more")}>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="quiet"
                                      size="icon-compact"
                                      aria-label={t("mcpPage.rowMoreAria", {
                                        id,
                                      })}
                                      disabled={controlsDisabled}
                                    >
                                      <MoreHorizontal
                                        className="h-[15px] w-[15px]"
                                        strokeWidth={1.5}
                                      />
                                    </Button>
                                  </DropdownMenuTrigger>
                                </HoverTip>
                                <DropdownMenuContent
                                  align="end"
                                  className="min-w-[200px]"
                                >
                                  {(enabled || webPlatform().context.kind === "project") && (
                                    <DropdownMenuItem
                                      disabled={connection === "checking" || !enabled}
                                      onSelect={() =>
                                        connectivity.checkServer(id)
                                      }
                                    >
                                      {t("mcpPage.testConnection")}
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      void copyJson(
                                        { [id]: server },
                                        t("mcpPage.toast.copiedOne", { id }),
                                      )
                                    }
                                  >
                                    {t("mcpPage.copyJson")}
                                  </DropdownMenuItem>
                                  {hasDocs && (
                                    <DropdownMenuItem
                                      onSelect={() => void openDocs(server, id)}
                                    >
                                      {t("mcpPage.openDocs")}
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem
                                    disabled={controlsDisabled || webPlatform().context.apps.length === 0}
                                    onSelect={() =>
                                      void handleRowAll(id, server, true)
                                    }
                                  >
                                    {t("mcpPage.enableEverywhere")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={controlsDisabled || webPlatform().context.apps.length === 0}
                                    onSelect={() =>
                                      void handleRowAll(id, server, false)
                                    }
                                  >
                                    {t("mcpPage.disableEverywhere")}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-danger-text focus:text-danger-text"
                                    onSelect={() => setDeleteId(id)}
                                  >
                                    {t("mcpPage.deleteEllipsis")}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </MatrixColumnHighlight>
            </div>
          )}
        </div>
      </div>

      {drawer && (
        <McpFormModal
          key={drawer.mode === "edit" ? `edit:${drawer.id}` : "add"}
          editingId={drawer.mode === "edit" ? drawer.id : undefined}
          initialData={
            drawer.mode === "edit" ? serversMap?.[drawer.id] : undefined
          }
          existingServers={serversMap ?? {}}
          visibleAppIds={appIds}
          allowedTransports={webPlatform().context.kind === "project" ? ["http"] : undefined}
          onSave={() => setDrawer(null)}
          onClose={() => setDrawer(null)}
        />
      )}

      <V7ConfirmDialog
        open={deleteId !== null}
        title={t("mcpPage.deleteTitle", {
          id: deleteTarget?.name?.trim() || deleteId || "",
        })}
        body={
          deleteApps.length
            ? t("mcpPage.deleteBodyApps", {
                apps: deleteApps.join(listSeparator),
              })
            : t("mcpPage.deleteBody")
        }
        confirmLabel={t("common.delete")}
        pending={writePending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteId(null)}
      />

    </>
  );
};

UnifiedMcpPanel.displayName = "UnifiedMcpPanel";

export default UnifiedMcpPanel;
