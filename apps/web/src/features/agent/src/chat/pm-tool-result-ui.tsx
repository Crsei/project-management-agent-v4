import type { ReactNode } from "react";
import { useAgentText } from "../i18n";

/** Only known PM routes are linked. Resource IDs and external paths are not entity IDs. */
export function pmObjectHref(workspaceId: string | null, kind: string, id: string, projectId?: string | null) {
  if (!workspaceId) return undefined;
  const root = `/pm/${encodeURIComponent(workspaceId)}`;
  if (kind === "project") return `${root}/projects/${encodeURIComponent(id)}`;
  if (!["entity", "task", "work_item", "document", "cycle", "milestone", "module", "requirement", "release", "goal"].includes(kind)) return undefined;
  return `${root}${(kind === "task" || kind === "work_item") && projectId ? `/projects/${encodeURIComponent(projectId)}` : ""}/entities/${encodeURIComponent(id)}`;
}

export function PmObjectLink({ workspaceId, kind, id, projectId, children }: { workspaceId: string | null; kind: string; id: string; projectId?: string | null; children?: ReactNode }) {
  const href = pmObjectHref(workspaceId, kind, id, projectId);
  return href ? <a href={href}>{children ?? id}</a> : <span>{children ?? id}</span>;
}

// Deliberately excludes unknown, functions and arbitrary external payloads. Each family
// selects its schema-owned fields before reaching this bounded, text-only renderer.
export type PmDisplayData = string | number | boolean | null | undefined | readonly PmDisplayData[] | { readonly [key: string]: PmDisplayData };

function isDisplayList(value: PmDisplayData): value is readonly PmDisplayData[] { return Array.isArray(value); }

export function PmResultData({ value }: { value: PmDisplayData }) {
  const t = useAgentText();
  let remainingNodes = 300;
  let remainingText = 16000;
  let clipped = false;
  const render = (entry: PmDisplayData, depth: number): ReactNode => {
    if (--remainingNodes < 0 || depth > 8) { clipped = true; return <span>…</span>; }
    if (entry === undefined) return <span>{t("未提供", "Not provided")}</span>;
    if (entry === null) return <span><code>null</code> · {t("未设置／不可用，含义以原字段为准", "Unset / unavailable; retain the original field meaning")}</span>;
    if (typeof entry === "boolean") return <code>{entry ? "true" : "false"}</code>;
    if (typeof entry === "number") return <code>{entry}</code>;
    if (typeof entry === "string") {
      const limit = Math.min(4000, Math.max(0, remainingText));
      const text = entry.slice(0, limit);
      remainingText -= text.length;
      if (text.length !== entry.length) clipped = true;
      return <span className="whitespace-pre-wrap break-words">{entry === "" ? t("（空文本）", "(empty text)") : text}{text.length !== entry.length && "…"}</span>;
    }
    if (isDisplayList(entry)) {
      if (!entry.length) return <span>{t("（空列表）", "(empty list)")}</span>;
      const visible: ReactNode[] = [];
      for (let index = 0; index < entry.length && index < 20 && remainingNodes > 0; index++) visible.push(<li key={index}>{render(entry[index], depth + 1)}</li>);
      if (visible.length !== entry.length) clipped = true;
      return <ol>{visible}</ol>;
    }
    const visible: ReactNode[] = [];
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      if (visible.length >= 40 || remainingNodes <= 0) { clipped = true; break; }
      visible.push(<div key={key}><dt><code>{key}</code></dt><dd>{render(entry[key], depth + 1)}</dd></div>);
    }
    return visible.length ? <dl>{visible}</dl> : <span>{t("（空定义）", "(empty definition)")}</span>;
  };
  const body = render(value, 0);
  return <>{body}{clipped && <p role="status">{t("卡片展示已裁剪；这不是完整正文。请按原工具的游标／偏移继续读取并核对 revision。", "Card display clipped; this is not the full payload. Continue with the original tool cursor / offset and verify revisions.")}</p>}</>;
}

export function PmEmptyResult({ children }: { children?: ReactNode }) {
  const t = useAgentText();
  return <p role="status">{children ?? t("当前授权范围的这一页没有条目。", "This page contains no entries in the current authorized scope.")}</p>;
}

export function PmUnsupportedResult() {
  const t = useAgentText();
  return <p role="status">{t("此结果类型尚不可展示；不能据此推断业务成功或没有数据。", "This result type cannot be displayed; it does not establish business success or absence of data.")}</p>;
}

/** A compile-time exhaustiveness guard with a safe mixed-version runtime response. */
export function unsupportedPmResult(_result: never) { return <PmUnsupportedResult />; }
