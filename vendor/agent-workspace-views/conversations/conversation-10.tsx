"use client"
import { BookOpen, Gauge } from "lucide-react"
import {
  Button,
  Progress,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui"
import { CitationList, CitationPreview, InlineCitation } from "./citations"
import {
  ThreadActivity,
  ThreadMessage,
  ThreadPanel,
  ThreadView,
} from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation10Controller } from "./conversation-10-controller"
import styles from "./conversation-9-12.module.css"
export function Conversation10View({
  controller: c,
  host,
}: {
  controller: Conversation10Controller
  host: ComposerHost
}) {
  const { label } = c
  return (
    <>
      <ThreadView
        page="conversation-10"
        controller={c}
        host={host}
        inputOptions={{
          tools: (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={c.sourcesOpen}
                onClick={() => c.setSourcesOpen((v) => !v)}
              >
                <BookOpen size={14} />
                {label("来源", "Sources")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={c.contextOpen}
                onClick={() => c.setContextOpen((v) => !v)}
              >
                <Gauge size={14} />
                14%
              </Button>
            </>
          ),
          placeholder: {
            "zh-CN": "添加研究上下文",
            en: "Add research context",
          },
        }}
        afterInput={
          <div
            className={styles.composerDetails}
            hidden={!c.sourcesOpen && !c.contextOpen}
            role="region"
            aria-label={label(
              "研究来源与上下文详情",
              "Research sources and context details",
            )}
            tabIndex={c.sourcesOpen || c.contextOpen ? 0 : -1}
          >
            {c.sourcesOpen && (
              <ThreadPanel title={label("3 个引用来源", "3 cited sources")}>
                <CitationList controller={c} />
              </ThreadPanel>
            )}
            {c.contextOpen && (
              <ThreadPanel
                title={label(
                  "固定上下文快照 · 非实时 Token 计算",
                  "Fixed context snapshot · not live token counting",
                )}
              >
                <p className={styles.meta}>
                  {c.usage.used.toLocaleString(c.locale)} /{" "}
                  {c.usage.limit.toLocaleString(c.locale)} · 14%
                </p>
                <Progress
                  value={c.usage.used}
                  max={c.usage.limit}
                  aria-label={label("上下文用量", "Context usage")}
                  aria-valuetext={`${c.usage.used.toLocaleString(c.locale)} / ${c.usage.limit.toLocaleString(c.locale)} · 14%`}
                />
              </ThreadPanel>
            )}
          </div>
        }
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={c}
            hideContent={message.id === "conversation-10-answer"}
            agentRole={
              message.role === "assistant"
                ? label("研究 Agent", "Research agent")
                : undefined
            }
            activity={
              message.id === "conversation-10-answer" ? (
                <ThreadActivity
                  title={label("推理用时 9 秒", "Reasoned for 9 seconds")}
                  defaultOpen={false}
                >
                  <p>
                    {label(
                      "比较可逆客户端反馈、权威服务确认与失败恢复边界。研究用时和来源为固定资料。",
                      "Compared reversible client feedback, authoritative confirmation, and recovery boundaries. Elapsed time and sources are fixed research notes.",
                    )}
                  </p>
                </ThreadActivity>
              ) : undefined
            }
          >
            {message.id === "conversation-10-answer" && (
              <div className={styles.research}>
                <h3>{label("建议", "Recommendation")}</h3>
                <p>{c.copy(message.text)}</p>
                <p>
                  {label(
                    "立即展示可逆的本地反馈——选择、排队与临时列表更改，同时保留回滚路径",
                    "Show reversible local feedback immediately—selection, queued status, and temporary list changes—while preserving a rollback path",
                  )}
                  <InlineCitation controller={c} sourceId="react" />
                  <InlineCitation controller={c} sourceId="query" />
                  {label(
                    "。让界面保持响应，而不宣称外部变更已完成。",
                    ". Keep the interface responsive without presenting an external mutation as finished.",
                  )}
                </p>
                <p>
                  {label(
                    "外部副作用保持待确认状态，直到服务器确认；为每个可重试变更附加幂等键",
                    "Keep external side effects pending until the server confirms them, and attach an idempotency key to every retryable mutation",
                  )}
                  <InlineCitation controller={c} sourceId="stripe" />
                  {label(
                    "。使重试可见、可审计，避免重复收费或重复工作流。",
                    ". Keep retries visible and auditable without duplicate charges or workflow runs.",
                  )}
                </p>
                <h3>{label("状态契约", "State contract")}</h3>
                <ul>
                  <li>
                    <strong>{label("排队", "Queued")}</strong>
                    {label(
                      "：界面已接受，但尚未发送。",
                      ": accepted by the interface but not sent.",
                    )}
                  </li>
                  <li>
                    <strong>{label("运行中", "Running")}</strong>
                    {label(
                      "：已提交，显示进度与安全取消边界。",
                      ": submitted with progress and a safe cancel boundary.",
                    )}
                  </li>
                  <li>
                    <strong>{label("成功", "Succeeded")}</strong>
                    {label(
                      "：权威服务已确认。",
                      ": confirmed by the authoritative service.",
                    )}
                  </li>
                  <li>
                    <strong>{label("需要关注", "Needs attention")}</strong>
                    {label(
                      "：失败，提供重试、回滚与审计详情。",
                      ": failed with retry, rollback, and audit details.",
                    )}
                  </li>
                </ul>
                <p>
                  {label(
                    "请求失败时恢复之前的客户端快照，或将乐观状态替换为明确错误",
                    "If the request fails, restore the previous client snapshot or replace optimistic state with an explicit error",
                  )}
                  <InlineCitation controller={c} sourceId="query" />
                  {label(
                    "。权威请求失败后绝不保留乐观成功标记。",
                    ". Never leave an optimistic success indicator after the authoritative request fails.",
                  )}
                </p>
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <BookOpen size={14} />
                      {label(
                        "已搜索 3 个网站 · 固定研究资料",
                        "Searched 3 websites · Fixed research notes",
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent forceMount>
                    <CitationList controller={c} variant="cards" limit={3} />
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      {c.sources.map((source) => (
                        <article
                          key={source.id}
                          className="min-w-0 text-xs leading-5 text-muted-foreground"
                        >
                          <strong>{new URL(source.url).hostname}</strong>
                          <p>
                            {source.available
                              ? c.copy(source.excerpt)
                              : label(
                                  "来源已失效；保留已有研究摘记，不把它当作最新来源。",
                                  "Source unavailable; existing notes are retained, not presented as current evidence.",
                                )}
                          </p>
                        </article>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </ThreadMessage>
        )}
      />
      <CitationPreview controller={c} />
    </>
  )
}
