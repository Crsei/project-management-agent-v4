import { useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { SquareIcon } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { getChatCancellationTarget } from "./transport";

/** Never abort the browser subscription before the durable server acknowledges. */
export function CancelGeneration() {
  const t = useAgentText();
  const localId = useAuiState((state) => state.threads.mainThreadId);
  const remoteId = useAuiState((state) => state.threads.threadItems.find((item) => item.id === state.threads.mainThreadId)?.remoteId);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ threadId: string; message: string }>();
  const cancel = async () => {
    if (!remoteId || inFlight.current) return;
    inFlight.current = true; setPending(true); setFailure(undefined);
    const target = getChatCancellationTarget(localId);
    try {
      await workspaceClient.json(`/api/chat/threads/${encodeURIComponent(remoteId)}/cancel`, { method: "POST", body: JSON.stringify(target) });
      const { generations } = await workspaceClient.json<{ generations: ChatGenerationView[] }>(`/api/chat/threads/${encodeURIComponent(remoteId)}/generations`);
      const current = generations.find((item) => target.generationId ? item.id === target.generationId : item.status === "queued" || item.status === "running");
      if (current && (current.status === "queued" || current.status === "running"))
        throw new Error(t("服务端尚未确认停止，回复仍可能继续；请核对后再请求停止。", "The server has not confirmed the stop yet; the reply may still continue. Verify before requesting a stop again."));
      // SSE carries the persisted terminal event and final partial text. Do not
      // invoke composer.cancel()/cancelRun(): those optimistically detach it.
    } catch (cause) {
      setFailure({ threadId: localId, message: cause instanceof Error ? cause.message : String(cause) });
    } finally { inFlight.current = false; setPending(false); }
  };
  return <>
    <Button type="button" variant="default" size="icon" className="aui-composer-cancel size-7 rounded-full" disabled={!remoteId || pending} aria-label={pending ? t("正在请求停止生成", "Requesting stop") : t("请求停止生成", "Request stop")} title={!remoteId ? t("等待会话保存后可停止", "Wait for the session to be saved before stopping") : pending ? t("等待服务端确认；输出订阅保持连接", "Waiting for server confirmation; the output subscription stays connected") : t("请求停止生成 · Ctrl / ⌘ + .", "Request stop · Ctrl / ⌘ + .")} onClick={() => void cancel()}><SquareIcon className="size-3.5 fill-current" /></Button>
    {failure?.threadId === localId && <p role="alert" className="pm-agent-cancel-error">{t("停止未确认：", "Stop unconfirmed: ")}{failure.message}</p>}
  </>;
}
