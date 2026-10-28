import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MergePreview } from "@agent-workspace/contracts/durable";
import { useWorkspace } from "../workspace/provider";
import { workspaceClient } from "../network";
import type { ChatGenerationView } from "@agent-workspace/contracts/chat";

const statusLabels: Record<ChatGenerationView["status"], string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
export function ChatBranchControls({ generations }: { generations: ChatGenerationView[] }) {
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
    <details className="min-w-0 basis-full" aria-label="聊天分支与上下文回传">
      <summary className="min-h-8 cursor-pointer content-center text-foreground">
        回复边界与分支{fork ? " · 当前是 Fork 会话" : ""}
      </summary>
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        {source && (
          <>
            <label className="flex min-w-0 flex-wrap items-center gap-2">
              聊天稳定边界
              <select
                aria-label="选择聊天回复边界"
                className="border-input bg-background max-w-full rounded-md border p-2 text-xs"
                value={source.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {stable.map((generation) => (
                  <option key={generation.id} value={generation.id}>
                    {new Date(generation.createdAt).toLocaleString()} ·{" "}
                    {statusLabels[generation.status]} · {generation.id.slice(0, 8)}
                  </option>
                ))}
              </select>
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
              从此回复创建分支
            </Button>
            <p className="basis-full">
              仅复制该回复结束时的有限上下文与当前会话资源；未完成输出会明确标记。原记录不变，创建时不调用模型。默认共享工作目录。
            </p>
          </>
        )}
        {fork && (
          <>
            <p className="basis-full break-all">
              来源：{fork.parentThreadId} · 边界：{fork.sourceStepId}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void perform(() => navigateToThread(fork.parentThreadId))}
            >
              返回父会话
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
              预览上下文回传
            </Button>
          </>
        )}
        {preview && (
          <section
            aria-label="聊天分支上下文回传预览"
            className="bg-muted min-w-0 basis-full space-y-2 rounded-md p-3"
          >
            <p>只回传给直接父会话；不是 Git merge，不会自动执行父会话。</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
              {preview.text}
            </pre>
            {preview.transferId ? (
              <p>
                已回传一次
                {preview.consumedAt ? "，已被父会话请求消费" : "，等待父会话下一次明确请求消费"}。
              </p>
            ) : (
              <>
                <label className="flex min-h-8 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  确认将以上上下文回传一次
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
                  确认回传
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
              关闭预览
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
