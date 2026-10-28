import { generateId } from "ai";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { MergePreview } from "@agent-workspace/contracts/durable";
import type {
  RunStatus,
  RunStepStatus,
  WorkspaceRun,
  WorkspaceRunStep,
} from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { errorMessage, timestamp } from "./api";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { usePanelDraft } from "./use-panel-draft";

const statusLabels: Record<RunStatus | RunStepStatus, string> = {
  queued: "排队中",
  pending: "未开始",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
function runText(run: WorkspaceRun) {
  return run.steps
    .filter((step) => step.output.trim())
    .map(
      (step) =>
        `## ${step.name || "未命名步骤"} · ${step.agentName || "未命名 Agent"}\n\n${step.output}`,
    )
    .join("\n\n");
}

function StepResult({
  step,
  index,
  save,
  quote,
}: {
  step: WorkspaceRunStep;
  index: number;
  save: (title: string, content: string) => void;
  quote: (text: string) => void;
}) {
  const hasText = Boolean(step.output.trim());
  return (
    <li className="live-panel-item space-y-2">
      <div className="live-panel-toolbar items-start">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-medium">
            {index + 1}. {step.name || "未命名步骤"}
          </h4>
          <p className="break-words text-xs text-muted-foreground">
            {step.agentName || "未命名 Agent"} · {step.providerInstanceId ?? "实例未记录"} ·{" "}
            {step.model}
          </p>
        </div>
        <span
          className={`live-panel-status shrink-0 ${step.status === "failed" ? "text-destructive" : ""}`}
        >
          {statusLabels[step.status]}
        </span>
      </div>
      <dl className="live-run-metadata">
        <dt>开始</dt>
        <dd>{timestamp(step.startedAt)}</dd>
        <dt>结束</dt>
        <dd>{timestamp(step.endedAt)}</dd>
        <dt>输入 / 输出令牌</dt>
        <dd>
          {step.inputTokens ?? "—"} / {step.outputTokens ?? "—"}
        </dd>
        {step.reusedFrom && (
          <>
            <dt>复用来源</dt>
            <dd className="break-all">{step.reusedFrom}</dd>
          </>
        )}
        {step.executionKind && (
          <>
            <dt>执行方式</dt>
            <dd>{step.executionKind === "agent" ? "原生 Agent" : step.executionKind === "cli" ? "本机 CLI（历史）" : "API（历史）"}</dd>
          </>
        )}
        {step.nativeSession && (
          <>
            <dt>原生会话</dt>
            <dd className="break-all font-mono">{JSON.stringify(step.nativeSession)}</dd>
          </>
        )}
      </dl>
      {step.sideEffects === "unknown" && (
        <p className="live-decision-note">
          此 CLI 步骤可能已修改文件或外部系统，副作用尚未确认；不能把未记录输出当成没有执行。
        </p>
      )}
      {step.status === "pending" && (
        <p className="live-panel-status">服务端尚未记录此步骤开始，不把等待状态显示为成功。</p>
      )}
      {step.status === "running" && !hasText && (
        <p className="live-panel-status">正在等待模型返回实际结果；关闭面板不会取消运行。</p>
      )}
      {step.error && (
        <p className="live-panel-error whitespace-pre-wrap" role="alert">
          {step.error}
        </p>
      )}
      {hasText ? (
        <Collapsible defaultOpen className="space-y-2">
          <CollapsibleTrigger className="live-run-disclosure">
            展开 / 收起步骤输出
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3">
            <pre className="live-panel-output font-sans">{step.output}</pre>
            <div className="live-panel-actions">
              <Button variant="outline" size="sm" onClick={() => quote(step.output)}>
                引用此步骤
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => save(step.name || "步骤结果", step.output)}
              >
                保存此步骤为文档
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : step.status !== "pending" && step.status !== "running" ? (
        <p className="live-panel-status">此步骤没有可用输出。</p>
      ) : null}
    </li>
  );
}

export function RunsPanel() {
  const {
    state,
    threadId,
    update,
    stopRun,
    continueRun,
    forkRun,
    fork,
    navigateToThread,
    mergePreview,
    mergeToParent,
    quote,
    setPanel,
    refreshRuns,
    pendingSubmission,
    retrySubmission,
    submitting,
    runConnectionError,
  } = useWorkspace();
  const [selectedId, setSelectedId] = usePanelDraft<string>(threadId, "selected-run");
  const [notice, setNotice] = useState<{ runId?: string; text: string; document?: boolean } | null>(
    null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmationRunId, setConfirmationRunId] = useState<string | null>(null);
  const [sideEffectsConfirmed, setSideEffectsConfirmed] = useState(false);
  const [forkBoundary, setForkBoundary] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const runs = [...state.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const text = selected ? runText(selected) : "";
  const completedPrefix: WorkspaceRunStep[] = [];
  if (selected)
    for (const step of selected.steps) {
      if (step.status !== "completed") break;
      completedPrefix.push(step);
    }
  const boundary = selected
    ? (forkBoundary[selected.id] ??
      (selected.status === "completed" ? completedPrefix.at(-1)?.id : ""))
    : undefined;

  async function perform(key: string, operation: () => Promise<void>) {
    if (pending) return;
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }
  async function continueSelected(run: WorkspaceRun, confirmed = false) {
    await perform(`continue:${run.id}`, async () => {
      try {
        const continuation = await continueRun(run.id, confirmed);
        setSelectedId(continuation.id);
        setConfirmationRunId(null);
        setSideEffectsConfirmed(false);
        setNotice({
          runId: continuation.id,
          text: "已创建新的续跑记录，原运行及已确认结果保持不变。",
        });
      } catch (cause) {
        if (
          cause instanceof WorkspaceClientError &&
          cause.code === "side_effect_confirmation_required"
        ) {
          setConfirmationRunId(run.id);
          setSideEffectsConfirmed(false);
        } else throw cause;
      }
    });
  }
  function saveDocument(title: string, content: string) {
    if (!selected || !content.trim()) return;
    update((current) => ({
      ...current,
      documents: [
        ...current.documents,
        {
          id: generateId(),
          title: `${title} · 运行结果`,
          content,
          included: false,
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    setNotice({
      runId: selected.id,
      text: "结果已加入本会话文档草稿，保存状态见面板上方；尚未纳入模型上下文。",
      document: true,
    });
  }
  function quoteOutput(content: string) {
    if (!selected || !content.trim()) return;
    quote(content);
    setNotice({ runId: selected.id, text: "结果已追加到聊天输入草稿，请检查后自行发送。" });
  }

  return (
    <div className="live-panel-section">
      {runConnectionError && (
        <p className="live-panel-error" role="alert">
          {runConnectionError}
        </p>
      )}
      {error && (
        <p className="live-panel-error" role="alert">
          {error}
        </p>
      )}
      {pendingSubmission && (
        <section className="live-decision-card">
          <h3 className="font-medium">上次提交尚未确认</h3>
          <p>
            任务「{pendingSubmission.name}
            」保留了原请求快照及提交身份。请先核对记录；安全重试会复用同一身份，不创建第二个相同请求。
          </p>
          <p className="break-all font-mono text-xs">{pendingSubmission.runId}</p>
          <div className="live-panel-actions">
            <Button
              disabled={Boolean(pending) || submitting}
              onClick={() => void perform("retry-submission", retrySubmission)}
            >
              {submitting ? "提交中…" : "以原身份重试提交"}
            </Button>
            <Button
              variant="outline"
              disabled={Boolean(pending)}
              onClick={() => void perform("refresh", refreshRuns)}
            >
              核对服务端运行
            </Button>
          </div>
        </section>
      )}
      {fork && (
        <section className="live-panel-item live-panel-section" aria-label="会话分支来源">
          <h3 className="font-medium">当前会话是 Fork 分支</h3>
          <dl className="live-run-metadata">
            <dt>父会话</dt>
            <dd className="break-all">{fork.parentThreadId}</dd>
            <dt>来源运行</dt>
            <dd className="break-all">{fork.sourceRunId}</dd>
            <dt>稳定步骤</dt>
            <dd className="break-all">{fork.sourceStepId}</dd>
            <dt>创建</dt>
            <dd>{timestamp(fork.createdAt)}</dd>
          </dl>
          <p className="live-panel-status">
            Fork 是独立对话分支，默认共享工作目录。Merge back 只回传上下文，不是 Git
            merge，也不会自动执行父会话。
          </p>
          <div className="live-panel-actions">
            <Button
              variant="outline"
              disabled={Boolean(pending)}
              onClick={() => void perform("parent", () => navigateToThread(fork.parentThreadId))}
            >
              返回父会话
            </Button>
            <Button
              disabled={Boolean(pending)}
              onClick={() =>
                void perform("merge-preview", async () => {
                  setPreview(await mergePreview());
                  setMergeConfirmed(false);
                })
              }
            >
              预览上下文回传
            </Button>
          </div>
        </section>
      )}
      {preview && (
        <section className="live-decision-card" aria-label="上下文回传预览">
          <div className="live-panel-toolbar">
            <h3 className="font-medium">Merge back 预览</h3>
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
              关闭预览
            </Button>
          </div>
          <p className="break-all text-xs">直接父会话：{preview.parentThreadId}</p>
          <pre className="live-panel-output font-sans">{preview.text}</pre>
          {preview.transferId ? (
            <p className="live-panel-status">
              上下文已经回传
              {preview.consumedAt
                ? `，于 ${timestamp(preview.consumedAt)} 被消费`
                : "，等待父会话下一次请求消费"}
              。重复确认不会重复追加。
            </p>
          ) : (
            <>
              <label className="live-automation-checkbox">
                <input
                  type="checkbox"
                  checked={mergeConfirmed}
                  onChange={(event) => setMergeConfirmed(event.target.checked)}
                />
                我确认将以上文本回传直接父会话；不合并代码、不自动发起运行。
              </label>
              <Button
                disabled={!mergeConfirmed || Boolean(pending)}
                onClick={() =>
                  void perform("merge-confirm", async () => {
                    await mergeToParent(preview);
                    setPreview(await mergePreview());
                    setNotice({ text: "上下文已回传；请回到父会话检查后自行发起下一次请求。" });
                  })
                }
              >
                确认回传一次
              </Button>
            </>
          )}
          <Button
            variant="outline"
            disabled={Boolean(pending)}
            onClick={() => void perform("parent", () => navigateToThread(preview.parentThreadId))}
          >
            打开父会话
          </Button>
        </section>
      )}
      <section className="live-panel-section">
        <div className="live-panel-toolbar">
          <h3 className="font-medium">本会话运行记录</h3>
          <div className="live-panel-actions">
            <span className="live-panel-status">{runs.length} 条</span>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(pending)}
              onClick={() => void perform("refresh", refreshRuns)}
            >
              刷新
            </Button>
          </div>
        </div>
        <p className="live-panel-status">
          服务端持久保存请求与结果，关闭页面只停止订阅。只有明确取消才请求停止执行；断线后自动补读持久事件。
        </p>
        {!runs.length ? (
          <div className="live-panel-empty space-y-3">
            <p>还没有运行记录。配置 Agent 或工作流并提交后，结果会出现在这里。</p>
            <div className="live-panel-actions">
              <Button variant="outline" onClick={() => setPanel("agents")}>
                配置 Agent
              </Button>
              <Button variant="outline" onClick={() => setPanel("workflows")}>
                配置工作流
              </Button>
            </div>
          </div>
        ) : (
          <div className="live-panel-list" aria-label="运行记录列表">
            {runs.map((run) => (
              <Button
                key={run.id}
                variant="ghost"
                className={`live-run-list-row ${selected?.id === run.id ? "live-run-list-row--selected" : ""}`}
                aria-pressed={selected?.id === run.id}
                onClick={() => {
                  setSelectedId(run.id);
                  setConfirmationRunId(null);
                  setError(null);
                }}
              >
                <span className="min-w-0">
                  <span className="block break-words">{run.name || "未命名运行"}</span>
                  <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                    {timestamp(run.startedAt)} · {run.kind === "workflow" ? "工作流" : "Agent"}
                    {run.continuationOf ? " · 续跑" : ""}
                    {run.imported ? " · 导入历史" : ""}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-xs ${run.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {statusLabels[run.status]}
                </span>
              </Button>
            ))}
          </div>
        )}
      </section>
      {selected && (
        <section className="live-panel-section" aria-label="选中的运行详情">
          <div className="live-panel-toolbar items-start">
            <h3 className="break-words font-medium">{selected.name || "未命名运行"}</h3>
            {(selected.status === "queued" || selected.status === "running") && (
              <Button
                variant="destructive"
                size="sm"
                disabled={Boolean(pending)}
                onClick={() =>
                  void perform(`cancel:${selected.id}`, async () => {
                    await stopRun(selected.id);
                    setNotice({
                      runId: selected.id,
                      text: "服务端已接收取消请求；以下状态来自服务端回执。",
                    });
                  })
                }
              >
                {pending === `cancel:${selected.id}` ? "请求取消中…" : "取消运行"}
              </Button>
            )}
          </div>
          <dl className="live-run-metadata">
            <dt>状态</dt>
            <dd role="status">{statusLabels[selected.status]}</dd>
            <dt>开始 / 提交</dt>
            <dd>{timestamp(selected.startedAt)}</dd>
            <dt>结束</dt>
            <dd>{timestamp(selected.endedAt)}</dd>
            <dt>运行标识</dt>
            <dd className="break-all font-mono">{selected.id}</dd>
            {selected.errorClass && (
              <>
                <dt>错误类别</dt>
                <dd>{selected.errorClass}</dd>
              </>
            )}
            {selected.resetAt && (
              <>
                <dt>额度 reset</dt>
                <dd>{timestamp(selected.resetAt)}</dd>
              </>
            )}
            {selected.continuationOf && (
              <>
                <dt>续跑来源</dt>
                <dd>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto max-w-full break-all whitespace-normal p-0 text-left"
                    onClick={() => setSelectedId(selected.continuationOf!)}
                  >
                    {selected.continuationOf}
                  </Button>
                </dd>
              </>
            )}
          </dl>
          {selected.status === "queued" && (
            <p className="live-panel-status">
              已持久入队，等待同会话前序运行完成。关闭页面不会移除队列。
            </p>
          )}
          {selected.status === "interrupted" && (
            <p className="live-decision-note">
              服务中断后已保留确认输出。未知 CLI
              副作用必须核对，续跑会创建新记录，不会把原运行伪装为成功。
            </p>
          )}
          {selected.status === "cancelled" && (
            <p className="live-panel-status">
              已取消。取消前已确认结果保留，外部已产生的副作用和费用不能撤销。
            </p>
          )}
          {selected.error && (
            <p className="live-panel-error whitespace-pre-wrap" role="alert">
              {selected.error}
            </p>
          )}
          {selected.errorClass === "usage_limit" && (
            <Button variant="outline" onClick={() => setPanel("automation")}>
              设置额度恢复授权
            </Button>
          )}
          {(["failed", "interrupted", "cancelled"] as RunStatus[]).includes(selected.status) && (
            <div className="live-panel-section">
              <div className="live-panel-actions">
                <Button
                  disabled={Boolean(pending) || selected.imported}
                  onClick={() => void continueSelected(selected)}
                >
                  创建续跑
                </Button>
                <span className="live-panel-status">只复用服务端已确认步骤输出。</span>
              </div>
              {selected.imported && (
                <p className="live-panel-status">
                  旧导入记录没有完整执行请求，不能重放或续跑。请创建新的任务。
                </p>
              )}
            </div>
          )}
          {confirmationRunId === selected.id && (
            <section className="live-decision-card" aria-label="CLI 副作用确认">
              <h4 className="font-medium">续跑需要明确确认</h4>
              <p>
                未完成的 CLI
                步骤可能已经修改文件、提交代码或调用外部系统。重放可能重复这些副作用；请先在文件 /
                Git / 终端检查。
              </p>
              <label className="live-automation-checkbox">
                <input
                  type="checkbox"
                  checked={sideEffectsConfirmed}
                  onChange={(event) => setSideEffectsConfirmed(event.target.checked)}
                />
                我已核对未知副作用，并接受续跑可能重复执行未确认步骤。
              </label>
              <div className="live-panel-actions">
                <Button
                  disabled={!sideEffectsConfirmed || Boolean(pending)}
                  onClick={() => void continueSelected(selected, true)}
                >
                  确认风险并创建续跑
                </Button>
                <Button variant="outline" onClick={() => setConfirmationRunId(null)}>
                  暂不续跑
                </Button>
              </div>
            </section>
          )}
          {runs.some((run) => run.continuationOf === selected.id) && (
            <div className="live-panel-section">
              <h4 className="text-sm font-medium">后续运行</h4>
              {runs
                .filter((run) => run.continuationOf === selected.id)
                .map((run) => (
                  <Button
                    key={run.id}
                    variant="outline"
                    className="h-auto justify-start whitespace-normal text-left"
                    onClick={() => setSelectedId(run.id)}
                  >
                    {run.name} · {statusLabels[run.status]} · {run.id}
                  </Button>
                ))}
            </div>
          )}
          {selected.status !== "running" && selected.status !== "queued" && !selected.imported && (
            <section className="live-panel-item live-panel-section">
              <h4 className="text-sm font-medium">从执行快照 Fork</h4>
              <label className="live-panel-field">
                <span>选择上下文边界</span>
                <select
                  className="live-panel-select"
                  value={boundary ?? ""}
                  onChange={(event) =>
                    setForkBoundary({ ...forkBoundary, [selected.id]: event.target.value })
                  }
                >
                  {selected.status !== "completed" && (
                    <option value="">
                      结束快照（含未完成状态及部分输出，仅 portable context）
                    </option>
                  )}
                  {completedPrefix.map((step, index) => (
                    <option key={step.id} value={step.id}>
                      {index + 1}. {step.name}（已完成边界）
                    </option>
                  ))}
                </select>
              </label>
              <p className="live-panel-status">
                复制会话资源与有限历史；失败结果不视为成功。原运行不变，默认共享工作目录，不会在创建分支时自动调用
                Provider。
              </p>
              <Button
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() =>
                  void perform(`fork:${selected.id}`, () =>
                    forkRun(selected.id, boundary || undefined),
                  )
                }
              >
                创建分支并打开
              </Button>
            </section>
          )}
          <Collapsible key={`${selected.id}-input`} className="space-y-2">
            <CollapsibleTrigger className="live-run-disclosure">
              展开 / 收起原始任务
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="live-panel-output font-sans">{selected.input}</pre>
            </CollapsibleContent>
          </Collapsible>
          <p className="live-panel-status">
            时间与令牌数只显示真实记录；“—”表示尚未记录，不代表零。
          </p>
          <ol className="live-panel-list space-y-3" aria-label="运行步骤">
            {selected.steps.map((step, index) => (
              <StepResult
                key={`${selected.id}-${step.id}`}
                step={step}
                index={index}
                save={saveDocument}
                quote={quoteOutput}
              />
            ))}
          </ol>
          {text && (
            <div className="space-y-2 border-t border-border pt-3">
              {selected.status !== "completed" && (
                <p className="live-panel-status">以下为可用的部分结果，不代表整个任务完成。</p>
              )}
              <div className="live-panel-actions">
                <Button variant="outline" onClick={() => quoteOutput(text)}>
                  引用全部可用结果
                </Button>
                <Button onClick={() => saveDocument(selected.name || "运行", text)}>
                  保存可用结果为文档
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
      {notice && (!notice.runId || notice.runId === selected?.id) && (
        <div className="space-y-2">
          <p className="live-panel-status" role="status">
            {notice.text}
          </p>
          {notice.document && (
            <Button variant="outline" size="sm" onClick={() => setPanel("documents")}>
              查看文档
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
