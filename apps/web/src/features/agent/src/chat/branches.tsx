import { useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import type { MergePreview } from "@agent-workspace/contracts/durable";
import { useWorkspace } from "../workspace/provider";
import { workspaceClient } from "../network";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";
import { useAgentText, type AgentText } from "../i18n";
import { RadixSelect } from "@/components/ui/radix-select"

const statusLabels = (t: AgentText): Record<ChatGenerationView["status"], string> => ({
  queued: t("排队中", "Queued"),
  running: t("生成中", "Generating"),
  completed: t("已完成", "Completed"),
  failed: t("失败", "Failed"),
  cancelled: t("已取消", "Cancelled"),
  interrupted: t("已中断", "Interrupted"),
});
export function ChatBranchControls({ generations }: { generations: ChatGenerationView[] }) {
  const t = useAgentText();
  const { threadId, fork, flushResources, navigateToThread, mergePreview, mergeToParent } =
    useWorkspace();
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const forkKeys = useRef(new Map<string, string>());
  useEffect(() => {
    setSelected("");
    setError(undefined);
    setPreview(null);
    setConfirmed(false);
  }, [threadId]);
  const stable = generations.filter(
    (generation) =>
      generation.threadId === threadId &&
      generation.status !== "queued" &&
      generation.status !== "running",
  );
  const source = stable.find((generation) => generation.id === selected) ?? stable[0];
  async function perform(operation: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }
  if (!fork && stable.length === 0) return null;
  return (
    <details className="min-w-0 basis-full" aria-label={t("聊天分支与上下文回传", "Chat branches and context transfer")}>
      <summary className="min-h-8 cursor-pointer content-center text-foreground">
        {t("回复边界与分支", "Reply boundary and branches")}{fork ? t(" · 当前是 Fork 会话", " · Current session is a fork") : ""}
      </summary>
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        {source && (
          <>
            <label className="flex min-w-0 flex-wrap items-center gap-2">
              {t("聊天稳定边界", "Stable chat boundary")}
              <RadixSelect
                aria-label={t("选择聊天回复边界", "Select a chat reply boundary")}
                className="border-input bg-background max-w-full rounded-md border p-2 text-xs"
                value={source.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {stable.map((generation) => (
                  <option key={generation.id} value={generation.id}>
                    {new Date(generation.createdAt).toLocaleString()} ·{" "}
                    {statusLabels(t)[generation.status]} · {generation.id.slice(0, 8)}
                  </option>
                ))}
              </RadixSelect>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(async () => {
                  await flushResources();
                  let idempotencyKey = forkKeys.current.get(source.id);
                  if (!idempotencyKey) {
                    idempotencyKey = crypto.randomUUID();
                    forkKeys.current.set(source.id, idempotencyKey);
                  }
                  const { threadId: child } = await workspaceClient.json<{ threadId: string }>(
                    `/api/chat/generations/${encodeURIComponent(source.id)}/fork`,
                    {
                      method: "POST",
                      body: JSON.stringify({ idempotencyKey }),
                    },
                  );
                  await navigateToThread(child);
                  forkKeys.current.delete(source.id);
                })
              }
            >
              {t("从此回复创建分支", "Create branch from this reply")}
            </Button>
            <p className="basis-full">
              {t("仅复制该回复结束时的有限上下文与当前会话资源；未完成输出会明确标记。原记录不变，创建时不调用模型。默认共享工作目录。", "Copies only the limited context at the end of this reply plus the current session resources; incomplete output is marked explicitly. The original record is unchanged and no model is called on creation. The working directory is shared by default.")}
            </p>
          </>
        )}
        {fork && (
          <>
            <p className="basis-full break-all">
              {t("来源：", "Source: ")}{fork.parentThreadId} · {t("边界：", "Boundary: ")}{fork.sourceStepId}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void perform(() => navigateToThread(fork.parentThreadId))}
            >
              {t("返回父会话", "Return to parent session")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void perform(async () => {
                  setPreview(await mergePreview());
                  setConfirmed(false);
                })
              }
            >
              {t("预览上下文回传", "Preview context transfer")}
            </Button>
          </>
        )}
        {preview && (
          <section
            aria-label={t("聊天分支上下文回传预览", "Chat branch context transfer preview")}
            className="bg-muted min-w-0 basis-full space-y-2 rounded-md p-3"
          >
            <p>{t("只回传给直接父会话；不是 Git merge，不会自动执行父会话。", "Transfers only to the direct parent session; this is not a Git merge and never runs the parent session automatically.")}</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
              {preview.text}
            </pre>
            {preview.transferId ? (
              <p>
                {preview.consumedAt
                  ? t("已回传一次，已被父会话请求消费。", "Transferred once; already consumed by a parent request.")
                  : t("已回传一次，等待父会话下一次明确请求消费。", "Transferred once; waiting for the parent session's next explicit request to consume it.")}
              </p>
            ) : (
              <>
                <label className="flex min-h-8 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {t("确认将以上上下文回传一次", "Confirm transferring the above context once")}
                </label>
                <Button
                  size="sm"
                  disabled={pending || !confirmed}
                  onClick={() =>
                    void perform(async () => {
                      await mergeToParent(preview);
                      setPreview(await mergePreview());
                    })
                  }
                >
                  {t("确认回传", "Confirm transfer")}
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
              {t("关闭预览", "Close preview")}
            </Button>
          </section>
        )}
        {error && (
          <p role="alert" className="text-destructive basis-full break-words">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
