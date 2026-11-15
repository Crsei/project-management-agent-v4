/**
 * Annotation comment/attach interaction and local PNG decoding adapted from
 * t3code 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c (MIT):
 * desktop preview/PickPreload.ts, AnnotationKeyboard.ts; web lib/previewAnnotation.ts,
 * imageCompression.ts and components/preview/PreviewView.tsx. See LICENSE.t3code.
 * The host dialog keeps comment editing outside the untrusted guest document.
 */
import { useMemo, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import type { ChatContextInput } from "@agent-workspace/contracts/message-context";
import { useMessageContextDraft, type MessageContextDraft } from "../../chat/message-context";
import { useAgentText } from "../../i18n";
import type { PreviewCapture, PreviewPickedElement } from "./preview-bridge";

type BrowserContextInput = Extract<ChatContextInput, { kind: "element" | "preview-annotation" }>;
export type PendingPreviewAnnotation = {
  contextId: string;
  attachmentId: string;
  snapshot: PreviewCapture | PreviewPickedElement;
  draft: MessageContextDraft;
};

function decodeScreenshot(snapshot: PendingPreviewAnnotation["snapshot"]): File | null {
  if (!snapshot.dataUrl) return null;
  if (!snapshot.dataUrl.startsWith("data:image/png;base64,")) throw new Error("The preview did not return a PNG screenshot.");
  const binary = atob(snapshot.dataUrl.slice("data:image/png;base64,".length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (!bytes.length) throw new Error("The preview screenshot is empty.");
  return new File([bytes], "browser-screenshot.png", { type: "image/png" });
}

export function PreviewAnnotationDialog({ pending, onClose, onAttached }: {
  pending: PendingPreviewAnnotation;
  onClose: () => void;
  onAttached: (warning?: string) => void;
}) {
  const t = useAgentText();
  const currentDraft = useMessageContextDraft();
  const { snapshot, draft } = pending;
  const picked = "selector" in snapshot ? snapshot : null;
  const capture = useMemo(() => {
    try { return { file: decodeScreenshot(snapshot), error: null }; }
    catch (cause) { return { file: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [snapshot]);
  const captureError = capture.error ?? (picked?.screenshotFailed || !capture.file ? picked?.screenshotError ?? t("无法截取所选页面。", "Could not capture the selected page.") : null);
  const [comment, setComment] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(Boolean(capture.file));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailableReason = !draft.isCurrent()
    ? t("会话已切换，批注尚未加入。请返回原会话后重试，或明确取消。", "The session changed; the annotation has not been attached. Return to the original session or explicitly cancel.")
    : !currentDraft.available ? t("当前消息尚未就绪，批注尚未加入。", "The current message is not ready; the annotation has not been attached.") : null;

  const attach = async () => {
    if (busy) return;
    if (unavailableReason) { setError(unavailableReason); return; }
    setBusy(true);
    setError(null);
    const screenshot = includeScreenshot ? capture.file : null;
    const source: BrowserContextInput["source"] = {
      type: "browser", url: snapshot.url, title: snapshot.title,
      captureId: snapshot.captureId, capturedAt: snapshot.capturedAt,
      ...(picked ? { selector: picked.selector, tagName: picked.tagName, rect: picked.rect, devicePixelRatio: picked.devicePixelRatio } : {}),
      ...(screenshot ? { attachmentId: pending.attachmentId } : {}),
    };
    const common = {
      contextId: pending.contextId,
      text: picked?.text ?? "",
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    const input: BrowserContextInput = picked?.selector && !comment.trim()
      ? { ...common, kind: "element", source: { ...source, selector: picked.selector } }
      : { ...common, kind: "preview-annotation", source };
    try {
      // Resolve and retain the annotation first; an optional image must never erase it.
      await draft.add(input);
      if (screenshot) {
        try { await draft.addAttachment(screenshot, pending.attachmentId); }
        catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          onAttached(t(`批注已保留，但截图未加入附件：${reason}`, `The annotation was kept, but the screenshot was not attached: ${reason}`));
          return;
        }
      }
      onAttached(captureError ? t(`批注已保留，不含截图：${captureError}`, `The annotation was kept without a screenshot: ${captureError}`) : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="pm-agent-chat-dialog max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><MousePointerClick className="size-4" aria-hidden="true" />{t("页面批注", "Page annotation")}</DialogTitle>
        <DialogDescription>{t("将已捕获的页面快照加入当前消息；不会自动发送，也不会由服务器抓取页面。", "Attach this captured page snapshot to the message. Nothing is sent automatically or fetched by the server.")}</DialogDescription>
      </DialogHeader>
      <div className="min-w-0 space-y-2 text-sm">
        <strong className="block break-words">{snapshot.title || snapshot.url}</strong>
        <p className="break-all text-xs text-muted-foreground">{snapshot.url}</p>
        {picked && <><code className="block break-all text-xs">{picked.selector || picked.tagName}</code><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{picked.text || t("所选元素没有可见文本。", "The selected element has no visible text.")}</pre></>}
        {capture.file && <img className="max-h-64 w-full rounded-lg border border-border object-contain" src={snapshot.dataUrl ?? undefined} alt={t("已捕获的页面截图", "Captured page screenshot")} />}
        {captureError && <p role="alert" className="text-destructive">{t(`截图失败，仍可保留批注：${captureError}`, `Screenshot failed; you can still keep the annotation: ${captureError}`)}</p>}
      </div>
      <div className="flex items-start gap-2 rounded-xl border border-border bg-popover/95 p-2 text-popover-foreground shadow-sm">
        <textarea
          autoFocus dir="auto" rows={3} maxLength={4000} disabled={busy}
          aria-label={t("批注", "Annotation comment")}
          placeholder={t("描述希望修改的内容…", "Describe the change…")}
          className="min-h-8 max-h-40 min-w-0 flex-1 resize-y border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 font-sans text-sm leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0"
          value={comment} onChange={event => setComment(event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!event.metaKey && !event.ctrlKey && !event.altKey) void attach();
          }}
        />
      </div>
      {capture.file && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={includeScreenshot} onChange={event => setIncludeScreenshot(event.target.checked)} />{t("同时附上截图", "Include screenshot")}</label>}
      <p className="text-xs text-muted-foreground">{t("Enter 加入消息，Shift+Enter 换行。只保留真实页面字段，不推断组件或源码位置。", "Enter attaches; Shift+Enter adds a line. Only actual page fields are kept; component or source locations are not inferred.")}</p>
      {unavailableReason && <p role="alert" className="text-destructive">{unavailableReason}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("取消", "Cancel")}</Button>
        <Button type="button" disabled={busy || Boolean(unavailableReason)} onClick={() => void attach()}>{busy ? t("正在加入…", "Attaching…") : t("加入消息", "Attach")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
