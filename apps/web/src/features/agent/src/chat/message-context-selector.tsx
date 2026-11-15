import { useEffect, useRef, useState } from "react";
import { LinkIcon } from "lucide-react";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Button } from "@agent/components/ui/button";
import { TooltipIconButton } from "@agent/components/assistant-ui/elements/tooltip-icon-button";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { useMessageContextDraft } from "./message-context";

/** Lists actual server sessions; the head and local environment are resolved on selection. */
export function MessageContextSelector() {
  const t = useAgentText();
  const draft = useMessageContextDraft();
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<RemoteThread[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const target = useRef(draft.targetKey); target.current = draft.targetKey;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setThreads(undefined); setError(undefined);
    void workspaceClient.json<{ threads: RemoteThread[] }>("/api/chat/threads", { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setThreads(result.threads); }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [open, draft.targetKey]);
  const select = async (thread?: RemoteThread) => {
    const key = draft.targetKey; setPending(true); setError(undefined);
    try {
      if (thread) {
        const history = await workspaceClient.json<{ headId: string | null }>(`/api/chat/threads/${encodeURIComponent(thread.remoteId)}/history?limit=1`);
        if (!history.headId) throw new Error(t("此会话还没有可引用的消息。", "This session has no message to reference."));
        await draft.add({ contextId: crypto.randomUUID(), kind: "thread", source: { type: "thread", threadId: thread.remoteId, headMessageId: history.headId } });
      } else await draft.add({ contextId: crypto.randomUUID(), kind: "environment", source: { type: "environment", hostId: "local" } });
      if (target.current === key) setOpen(false);
    } catch (cause) { if (target.current === key) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (target.current === key) setPending(false); }
  };
  return <><TooltipIconButton type="button" disabled={!draft.available} tooltip={t("引用会话或本机环境", "Reference session or local environment")} aria-label={t("引用会话或本机环境", "Reference session or local environment")} onClick={() => setOpen(true)} className="size-7 rounded-full"><LinkIcon className="size-4" /></TooltipIconButton>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t("添加消息上下文", "Add message context")}</DialogTitle></DialogHeader>
      <p className="text-xs text-muted-foreground">{t("引用先核验再加入草稿，不发送消息；会话历史与当前本机环境保持不同来源。", "References are checked before adding to the draft. Nothing is sent; session history and the current local environment remain separate sources.")}</p>
      <Button type="button" variant="outline" disabled={pending || !draft.available} onClick={() => void select()}>{t("当前 Local 执行环境", "Current Local execution environment")}</Button>
      <div className="max-h-80 space-y-1 overflow-auto">{threads === undefined ? <p role="status">{t("读取会话…", "Loading sessions…")}</p> : threads.length ? threads.map(thread => <Button key={thread.remoteId} type="button" variant="ghost" className="w-full justify-start truncate" disabled={pending || !draft.available} onClick={() => void select(thread)}>{thread.title || thread.remoteId}</Button>) : <p>{t("没有可引用的会话。", "No sessions to reference.")}</p>}</div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </DialogContent></Dialog>
  </>;
}
