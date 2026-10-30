import { useEffect, useState } from "react";
import { ChevronRight, ShieldCheck, ShieldOff } from "lucide-react";

import { pmToolCapabilitiesSchema, type PmToolCapabilities } from "@agent-workspace/contracts/pm-capabilities";

import { workspaceClient } from "../network";
import styles from "./pm-capabilities-strip.module.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: PmToolCapabilities }
  | { status: "error"; message: string };

/**
 * Compact read-only summary of the PM tools the Agent may call for the current
 * scope. Every number comes from the Agent proxy, which forwards to PM; when the
 * fetch fails nothing is claimed beyond the failure itself.
 */
export function PmCapabilitiesStrip({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ workspaceId });
    if (projectId) query.set("projectId", projectId);
    setState({ status: "loading" });
    void workspaceClient.json<unknown>(`/api/pm-capabilities?${query.toString()}`, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        const parsed = pmToolCapabilitiesSchema.safeParse(body);
        setState(parsed.success
          ? { status: "ready", data: parsed.data }
          : { status: "error", message: "PM 能力响应格式无法识别。" });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: cause instanceof Error && cause.message.trim() ? cause.message : "PM 能力服务不可用。",
        });
      });
    return () => controller.abort();
  }, [attempt, projectId, workspaceId]);

  const tools = state.status === "ready" ? state.data.tools : [];
  const allowedTools = tools.filter((tool) => tool.allowed);
  const writeAllowed = allowedTools.filter((tool) => tool.write).length;
  const summary = state.status === "loading"
    ? "PM 工具 · 正在读取…"
    : state.status === "error"
      ? "PM 工具 · 读取失败"
      : tools.length === 0
        ? "PM 工具 0 · 无可用能力"
        : `PM 工具 ${tools.length} · 可用 ${allowedTools.length} · 写入 ${writeAllowed}`;

  return (
    <details className={styles.strip}>
      <summary className={styles.summary}>
        {state.status === "ready" ? (
          <ShieldCheck className={styles.icon} aria-hidden="true" />
        ) : state.status === "error" ? (
          <ShieldOff className={styles.icon} aria-hidden="true" />
        ) : null}
        <span className={styles.summaryText}>{summary}</span>
        <ChevronRight className={styles.chevron} aria-hidden="true" />
      </summary>
      <div className={styles.panel}>
        {state.status === "loading" ? (
          <p role="status" className={styles.note}>正在读取 PM 能力…</p>
        ) : state.status === "error" ? (
          <div className={styles.error}>
            <p role="alert">PM 能力不可用：{state.message}</p>
            <button type="button" className={styles.retry} onClick={() => setAttempt((value) => value + 1)}>
              重新读取
            </button>
          </div>
        ) : (
          <>
            <p className={styles.scope}>
              {state.data.scope.kind === "workspace"
                ? "范围：整个工作区"
                : `范围：${state.data.scope.projectIds.length} 个项目`}
              {` · 允许 ${allowedTools.length} · 拒绝 ${tools.length - allowedTools.length}`}
            </p>
            {tools.length === 0 ? (
              <p className={styles.note}>PM 未返回任何工具，Agent 不声称具备 PM 能力。</p>
            ) : (
              <ul className={styles.list}>
                {tools.map((tool) => (
                  <li key={tool.name} className={styles.tool} data-allowed={tool.allowed}>
                    <span className={styles.toolName}>
                      <code>{tool.name}</code>
                      {tool.write ? <span className={styles.write}>写</span> : null}
                    </span>
                    <span className={styles.toolState}>{tool.allowed ? "允许" : "拒绝"}</span>
                    {tool.description ? <span className={styles.toolDescription}>{tool.description}</span> : null}
                    {!tool.allowed && tool.denyReason ? <span className={styles.denyReason}>{tool.denyReason}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </details>
  );
}
