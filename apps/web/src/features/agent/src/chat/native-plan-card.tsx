import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-provider";
import { Check, Copy, Download, Play, Save } from "lucide-react";
import type { GenerationOutputStatus, NativeOutputItem } from "@agent-workspace/contracts/output";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { Markdown } from "./markdown";
import { useChatActions } from "./chat-actions";
import { implementPlan } from "./thread-actions";
import { isGenerationActive } from "./output-presenter";
import { planFilename, planMarkdown } from "./plan-presenter";

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable: () => Promise<{ write: (contents: string) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> }>;
};

export function NativePlanCard({ item, generationId, generationStatus }: { item: NativeOutputItem; generationId: string; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const actions = useChatActions();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"save" | "implement">();
  const [createdThread, setCreatedThread] = useState<string>();
  const idempotency = useRef<string | undefined>(undefined);
  const markdown = planMarkdown(item);
  const filename = planFilename(item);
  const long = markdown.length > 900 || markdown.split("\n").length > 20;
  const implementReason = !actions ? t("当前视图没有可用的会话导航。", "Session navigation is unavailable in this view.")
    : generationStatus !== "completed" ? t("只能在计划回复完整成功结束后实施。", "Implementation requires a fully completed plan turn.")
    : item.status !== "completed" || !!item.error || !item.text?.trim() ? t("计划没有完整、可执行的权威文本。", "The plan has no complete authoritative text available for implementation.")
    : undefined;
  const canImplement = !implementReason;
  const savePicker = typeof window === "undefined" ? undefined : (window as SavePickerWindow).showSaveFilePicker;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true); setError(undefined);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const save = async () => {
    if (!savePicker || pending) return;
    setPending("save"); setError(undefined); setNotice(undefined);
    try {
      const file = await savePicker.call(window, { suggestedName: filename, types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
      const writable = await file.createWritable();
      try { await writable.write(markdown); await writable.close(); }
      catch (cause) { await writable.abort().catch(() => undefined); throw cause; }
      setNotice(t("计划已保存至你选择的本地文件。", "Plan saved to the local file you selected."));
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(undefined); }
  };
  const implement = async () => {
    if (!canImplement || pending) return;
    setPending("implement"); setError(undefined); setNotice(undefined);
    try {
      let target = createdThread;
      if (!target) {
        idempotency.current ??= crypto.randomUUID();
        const result = await implementPlan(generationId, item.id, idempotency.current);
        target = result.threadId; setCreatedThread(target);
      }
      await actions!.navigateSession(target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(undefined); }
  };
  return <div className="native-plan-card">
    <div className="native-plan-content" data-collapsed={long && !expanded || undefined}>
      {markdown ? <Markdown content={markdown} locale={locale === "en" ? "en" : "zh-CN"} streaming={item.streaming === true && isGenerationActive(generationStatus)} /> : <p>{t("Provider 尚未提供计划内容。", "The Provider has not supplied plan content.")}</p>}
      {item.steps?.length && item.text?.trim() ? <ol className="native-plan-steps">{item.steps.map(step => <li key={step.id} data-status={step.status}><span>{step.status === "completed" ? "✓" : step.status === "running" ? "●" : step.status === "cancelled" ? "−" : "○"}</span> {step.text}</li>)}</ol> : null}
    </div>
    {long && <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t("收起计划", "Collapse plan") : t("展开完整计划", "Expand full plan")}</Button>}
    <div className="native-plan-actions">
      <Button type="button" variant="ghost" size="sm" disabled={!markdown} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? t("已复制", "Copied") : t("复制", "Copy")}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={!markdown} onClick={download}><Download aria-hidden="true" />{t("下载 Markdown", "Download Markdown")}</Button>
      {savePicker && <Button type="button" variant="ghost" size="sm" disabled={!markdown || !!pending} onClick={() => void save()}><Save aria-hidden="true" />{pending === "save" ? t("保存中…", "Saving…") : t("另存为本地文件", "Save local file as…")}</Button>}
      <Button type="button" variant="outline" size="sm" disabled={!canImplement || !!pending} title={implementReason} onClick={() => void implement()}><Play aria-hidden="true" />{pending === "implement" ? t("正在打开…", "Opening…") : createdThread ? t("打开实施会话", "Open implementation session") : t("在新会话中实施", "Implement in new session")}</Button>
    </div>
    {!savePicker && <p className="native-summary-note">{t("此浏览器不支持文件选择器；可下载 Markdown 后保存。", "This browser does not support a save picker; use Download Markdown to save a file.")}</p>}
    <p className="native-summary-note">{t("实施会显式创建并发送新的 Agent 会话，不会完成 PM 任务。", "Implement explicitly creates and sends a new Agent session; it does not complete a PM task.")}</p>
    {implementReason && <p className="native-summary-note">{implementReason}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="native-error">{error}</p>}
  </div>;
}
