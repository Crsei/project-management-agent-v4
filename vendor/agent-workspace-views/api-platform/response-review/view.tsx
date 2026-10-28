"use client"
import { useEffect, useId, useLayoutEffect, useRef } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Avatar } from "@easyuse-ui/ui/components/ui/avatar"
import { NativeSelect } from "@easyuse-ui/ui/components/ui/native-select"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Field } from "@easyuse-ui/ui/components/ui/field"
import { DataRegion } from "@easyuse-ui/ui/components/ui/data-region"
import { MessageContent } from "@easyuse-ui/ui/components/blocks/message-content"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import { apScenarios, type ApScenario } from "../model"
import type { RemainingPageProps } from "../../showcase/model"
import { useApCache, useApState } from "../state"
import {
  createReviewState,
  reviewCount,
  reviewLocked,
  selectReview,
  moveReview,
  skipReview,
  updateReviewDraft,
  toggleReviewSource,
  beginReviewSave,
  beginReviewQuery,
  settleReviewOperation,
  type Accuracy,
  type Resolution,
  type SaveMode,
} from "./controller"
import { reviewDataset } from "./fixtures"
import styles from "./response-review.module.css"

export const pageScenarios = apScenarios

/** Both API Platform hosts share the same view and scenario-scoped state. */
export function RemainingPageView({ scenario, active }: RemainingPageProps) {
  return (
    <ResponseReviewView scenario={scenario as ApScenario} active={active} />
  )
}

export function ResponseReviewView({
  scenario,
  active = true,
}: {
  scenario: ApScenario
  active?: boolean
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const copy = (english: string, chinese: string) => (en ? english : chinese)
  const [state, setState] = useApState("response-review", () =>
    createReviewState(scenario),
  )
  const cache = useApCache()
  const screen = useRef<HTMLElement>(null)
  const sourcePanel = useRef<HTMLDivElement>(null)
  const id = useId()
  const record = state.records.find(
    (item) => item.reviewId === state.selectedId,
  )
  const draft = record ? state.drafts[record.reviewId] : null
  const index = state.records.findIndex(
    (item) => item.reviewId === state.selectedId,
  )
  const count = reviewCount(state)
  const locked = reviewLocked(state)
  const disabled = !state.canWrite || locked
  const pending = state.operation?.status === "pending"
  const unknown = state.operation?.status === "unknown"
  const accuracyOptions: [Accuracy, string][] = [
    ["accurate", copy("Accurate", "准确")],
    ["partly", copy("Partly accurate", "部分准确")],
    ["incorrect", copy("Incorrect", "不正确")],
  ]
  const resolutionOptions: [Resolution, string][] = [
    ["resolved", copy("Resolved", "已解决")],
    ["partially", copy("Partially", "部分解决")],
    ["unresolved", copy("Unresolved", "未解决")],
  ]
  useLayoutEffect(() => {
    if (screen.current)
      screen.current.scrollTop = Number(
        cache?.get("review-reading-position") ?? 0,
      )
  }, [cache])
  useEffect(() => {
    if (!active || state.operation?.status !== "pending") return
    const operationId = state.operation.operationId
    const timer = setTimeout(
      () => setState((before) => settleReviewOperation(before, operationId)),
      450,
    )
    return () => clearTimeout(timer)
  }, [
    active,
    state.operation?.status,
    state.operation?.operationId,
    state.operation?.intent,
    setState,
  ])
  const locateSource = () => {
    setState((before) => toggleReviewSource(before, true))
    requestAnimationFrame(() => {
      sourcePanel.current?.focus({ preventScroll: true })
      sourcePanel.current?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      })
    })
  }
  const save = () => {
    const next = beginReviewSave(state)
    setState(next)
    if (Object.keys(next.errors).length)
      requestAnimationFrame(() => {
        const target = next.errors.accuracy
          ? id + "-accuracy"
          : next.errors.resolution
            ? id + "-resolution"
            : id + "-correction"
        document.getElementById(target)?.focus()
      })
  }
  const message = !state.canWrite
    ? copy(
        "Read-only workspace. Reviews cannot be changed or saved.",
        "此工作区只读，无法修改或保存评审。",
      )
    : pending
      ? copy(
          "Waiting for the local fixture receipt. The queue and count have not changed.",
          "正在等待本地模拟回执，队列和计数尚未改变。",
        )
      : unknown
        ? copy(
            "Save result unknown. Your response and draft are retained. Check the original operation before continuing.",
            "保存结果未知。响应与草稿已保留，请先查询原操作再继续。",
          )
        : state.notice === "rejected"
          ? copy(
              "Save rejected. Nothing was added to the dataset; your draft is retained. You can edit and submit again.",
              "保存被拒绝，数据集未增加记录；草稿已保留，可修改后重新提交。",
            )
          : state.notice === "complete"
            ? copy(
                "All responses reviewed. Saved annotations remain editable.",
                "所有响应已评审，已保存的标注仍可修改。",
              )
            : state.notice === "saved"
              ? copy(
                  "Review saved to the local dataset. Moved to the next unreviewed response.",
                  "评审已保存到本地数据集，已前进到下一条待审响应。",
                )
              : state.notice === "skipped"
                ? copy(
                    "Skipped without saving. Your draft is retained and the reviewed count is unchanged.",
                    "已跳过而未保存，草稿保留，已评审计数不变。",
                  )
                : copy(
                    "Your review stays editable after saving.",
                    "保存后仍可修改你的评审。",
                  )
  return (
    <main
      ref={screen}
      className={styles.screen}
      data-ap-page="response-review"
      data-ap-scroll
      onScroll={(event) =>
        cache?.set("review-reading-position", event.currentTarget.scrollTop)
      }
    >
      <header className={styles.queueHeader} data-review-header>
        <div>
          <a className={styles.breadcrumb} href="/showcase/evaluations">
            {copy("Evaluations", "评测")}
            <span>/</span>
            {copy("Review queues", "评审队列")}
          </a>
          <h1>
            {copy("Support answer quality", "支持答复质量")}{" "}
            <span className={styles.queueBadge}>
              {copy("Manual review", "人工评审")}
            </span>
          </h1>
          <p>
            {copy(
              "Review answers against workspace knowledge before adding them to the support dataset.",
              "根据工作区知识审核答复，再将其添加到支持数据集。",
            )}
          </p>
        </div>
        <div className={styles.progress} data-review-progress>
          <span>
            <strong>{count}</strong>
            {en
              ? " of " + state.records.length + " reviewed"
              : " / " + state.records.length + " 条已评审"}
          </span>
          <div
            role="progressbar"
            aria-label={copy("Reviewed responses", "已评审响应")}
            aria-valuemin={0}
            aria-valuemax={state.records.length || 1}
            aria-valuenow={count}
          >
            <span
              style={{
                width: state.records.length
                  ? (count / state.records.length) * 100 + "%"
                  : "0%",
              }}
            />
          </div>
        </div>
      </header>
      <DataRegion
        state={
          !state.loaded
            ? "loading"
            : !state.records.length
              ? "empty"
              : state.refreshError
                ? "error"
                : "success"
        }
        hasContent={state.loaded && !!state.records.length}
        loadingLabel={copy("Loading review queue", "正在加载评审队列")}
        rowHeight={160}
        emptyTitle={copy("No responses to review", "没有待评审响应")}
        emptyDescription={copy(
          "This queue has no pending responses. Return to evaluations to select another queue.",
          "此队列没有待审响应。返回评测选择其他队列。 ",
        )}
        emptyAction={
          <a className={styles.breadcrumb} href="/showcase/evaluations">
            {copy("Return to evaluations", "返回评测")}
          </a>
        }
        error={{
          category: "network",
          message: copy(
            "Could not refresh the review queue",
            "无法刷新评审队列",
          ),
          reason: copy(
            "The last fixture snapshot and all reviewer drafts are preserved.",
            "上次模拟快照和所有评审草稿均已保留。",
          ),
        }}
        updatedAt="2026-09-18 10:45 UTC"
        onRetry={() =>
          setState((before) => ({ ...before, refreshError: false }))
        }
      >
        {record && draft && (
          <>
            <nav
              className={styles.toolbar}
              aria-label={copy("Response navigation", "响应导航")}
              data-review-toolbar
            >
              <div className={styles.caseSelector}>
                <span className={styles.label}>{copy("Response", "响应")}</span>
                <NativeSelect
                  className={styles.responseSelect}
                  aria-label={copy("Select response", "选择响应")}
                  value={record.reviewId}
                  disabled={locked}
                  onChange={(event) =>
                    setState((before) =>
                      selectReview(before, event.target.value),
                    )
                  }
                >
                  {state.records.map((item) => (
                    <option key={item.reviewId} value={item.reviewId}>
                      {item.reviewId} ·{" "}
                      {state.saved[item.reviewId]
                        ? copy("Reviewed", "已评审")
                        : copy("To review", "待评审")}
                    </option>
                  ))}
                </NativeSelect>
                <span className={styles.toolbarTopic}>
                  {record.topic[locale]}
                </span>
              </div>
              <div className={styles.paging}>
                <span>
                  {index + 1} / {state.records.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={styles.pagingButton}
                  aria-label={copy("Previous response", "上一条响应")}
                  disabled={index === 0 || locked}
                  onClick={() => setState((before) => moveReview(before, -1))}
                >
                  <ArrowLeft aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={styles.pagingButton}
                  aria-label={copy("Next response", "下一条响应")}
                  disabled={index === state.records.length - 1 || locked}
                  onClick={() => setState((before) => moveReview(before, 1))}
                >
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
            </nav>
            <div className={styles.workspace} data-review-workspace>
              <section
                className={styles.evidence}
                aria-label={copy(
                  "Conversation and source evidence",
                  "会话与来源证据",
                )}
                data-review-evidence
              >
                <div className={styles.conversationHeading}>
                  <div>
                    <span className={styles.label}>
                      {copy("Conversation", "会话")}
                    </span>
                    <h2>{record.title[locale]}</h2>
                  </div>
                  <span className={styles.channel}>
                    {copy("Web chat", "网页聊天")}
                  </span>
                </div>
                <div className={styles.customer}>
                  <Avatar
                    name={record.customerName}
                    size={32}
                    className={styles.avatar}
                  />
                  <div>
                    <strong>{record.customerName}</strong>
                    <p>{record.company}</p>
                  </div>
                  <time>{record.time}</time>
                </div>
                <div className={styles.messages}>
                  {record.messages.map((item, messageIndex) => (
                    <article
                      key={messageIndex}
                      className={
                        messageIndex === 1 ? styles.answer : styles.message
                      }
                      data-review-message={messageIndex}
                    >
                      {messageIndex === 1 ? (
                        <div className={styles.answerHeading}>
                          <strong>
                            {copy("Support assistant", "支持助手")}
                          </strong>
                          <span>{copy("Answer under review", "待审答复")}</span>
                        </div>
                      ) : (
                        <span className={styles.speaker}>{item.speaker}</span>
                      )}
                      <MessageContent
                        content={item.content[locale]}
                        className={styles.messageBody}
                      />
                      {messageIndex === 1 && (
                        <Button
                          variant="ghost"
                          className={styles.citation}
                          aria-label={record.source.title[locale] + " 1"}
                          onClick={locateSource}
                          aria-controls={id + "-source"}
                        >
                          <FileText aria-hidden="true" />
                          {record.source.title[locale]}
                          <span>1</span>
                        </Button>
                      )}
                    </article>
                  ))}
                </div>
                <section className={styles.source}>
                  <Button
                    variant="ghost"
                    className={styles.sourceToggle}
                    aria-expanded={draft.sourceOpen}
                    aria-controls={id + "-source"}
                    onClick={() => setState(toggleReviewSource)}
                  >
                    <span>
                      {copy("Source evidence", "来源证据")}{" "}
                      <span className={styles.sourceCount}>1</span>
                    </span>
                    {draft.sourceOpen ? (
                      <ChevronUp aria-hidden="true" />
                    ) : (
                      <ChevronDown aria-hidden="true" />
                    )}
                  </Button>
                  <div
                    id={id + "-source"}
                    ref={sourcePanel}
                    tabIndex={-1}
                    hidden={!draft.sourceOpen}
                    className={styles.sourceBody}
                    data-review-source={record.source.sourceId}
                  >
                    <div className={styles.sourceTitle}>
                      <FileText aria-hidden="true" />
                      <div>
                        <h3>{record.source.title[locale]}</h3>
                        <p>{record.source.path[locale]}</p>
                      </div>
                    </div>
                    {!record.source.available && (
                      <p role="status" className={styles.missing}>
                        {copy("Source version unavailable", "来源版本不可用")}
                      </p>
                    )}
                    <blockquote>{record.source.quote[locale]}</blockquote>
                    <div className={styles.sourceFooter}>
                      <span>{copy("Knowledge base", "知识库")}</span>
                      <span>
                        {copy("Updated", "更新于")}{" "}
                        {new Intl.DateTimeFormat(locale, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          timeZone: "UTC",
                        }).format(
                          new Date(record.source.updatedAt + "T00:00:00Z"),
                        )}
                      </span>
                    </div>
                  </div>
                </section>
              </section>
              <aside
                className={styles.review}
                aria-label={copy("Review response", "评审响应")}
                aria-busy={pending}
                data-review-panel
              >
                <div className={styles.reviewHeading}>
                  <h2>{copy("Your review", "你的评审")}</h2>
                  <span>
                    {state.saved[record.reviewId]
                      ? copy("Submitted", "已提交")
                      : copy("Not submitted", "未提交")}
                  </span>
                </div>
                <div className={styles.reviewContent}>
                  <div className={styles.reason}>
                    <strong>{record.reasonTitle[locale]}</strong>
                    <p>{record.reason[locale]}</p>
                  </div>
                  <fieldset
                    className={styles.field}
                    disabled={disabled}
                    aria-describedby={
                      state.errors.accuracy ? id + "-accuracy-error" : undefined
                    }
                  >
                    <legend>
                      {copy("Is the answer accurate?", "答复准确吗？")}
                    </legend>
                    <p className={styles.fieldDescription}>
                      {copy(
                        "Compare factual claims with the source.",
                        "将事实陈述与来源进行比较。",
                      )}
                    </p>
                    <div className={styles.options}>
                      {accuracyOptions.map(([value, label], optionIndex) => (
                        <Button
                          key={value}
                          id={optionIndex === 0 ? id + "-accuracy" : undefined}
                          variant="secondary"
                          className={styles.verdict}
                          aria-pressed={draft.accuracy === value}
                          onClick={() =>
                            setState((before) =>
                              updateReviewDraft(before, {
                                accuracy:
                                  draft.accuracy === value ? null : value,
                              }),
                            )
                          }
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    {state.errors.accuracy && (
                      <p id={id + "-accuracy-error"} className={styles.error}>
                        {copy(
                          "Choose an accuracy rating.",
                          "请选择准确性判定。",
                        )}
                      </p>
                    )}
                  </fieldset>
                  <fieldset
                    className={styles.field}
                    disabled={disabled}
                    aria-describedby={
                      state.errors.resolution
                        ? id + "-resolution-error"
                        : undefined
                    }
                  >
                    <legend>
                      {copy("Did it resolve the request?", "是否解决了请求？")}
                    </legend>
                    <div className={styles.options}>
                      {resolutionOptions.map(([value, label], optionIndex) => (
                        <Button
                          key={value}
                          id={
                            optionIndex === 0 ? id + "-resolution" : undefined
                          }
                          variant="secondary"
                          className={styles.verdict}
                          aria-pressed={draft.resolution === value}
                          onClick={() =>
                            setState((before) =>
                              updateReviewDraft(before, {
                                resolution:
                                  draft.resolution === value ? null : value,
                              }),
                            )
                          }
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    {state.errors.resolution && (
                      <p id={id + "-resolution-error"} className={styles.error}>
                        {copy(
                          "Choose a resolution rating.",
                          "请选择解决情况。",
                        )}
                      </p>
                    )}
                  </fieldset>
                  {draft.accuracy && draft.accuracy !== "accurate" && (
                    <Field
                      id={id + "-correction"}
                      className={styles.field}
                      label={copy("Corrected answer", "修正答复")}
                      error={
                        state.errors.correction
                          ? copy(
                              "Write a corrected answer before saving.",
                              "保存前请填写修正答复。",
                            )
                          : undefined
                      }
                    >
                      {(props) => (
                        <>
                          <p
                            id={id + "-correction-description"}
                            className={styles.fieldDescription}
                          >
                            {copy(
                              "This becomes the expected answer in the dataset.",
                              "此内容将成为数据集的预期答复。",
                            )}
                          </p>
                          <Textarea
                            {...props}
                            aria-describedby={[
                              props["aria-describedby"],
                              id + "-correction-description",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            className={styles.correction}
                            placeholder={copy(
                              "Write the answer the assistant should have given…",
                              "填写助手应当给出的答复…",
                            )}
                            value={draft.correction}
                            disabled={disabled}
                            onChange={(event) =>
                              setState((before) =>
                                updateReviewDraft(before, {
                                  correction: event.target.value,
                                }),
                              )
                            }
                            onBlur={(event) =>
                              setState((before) =>
                                updateReviewDraft(before, {
                                  correctionSelection: [
                                    event.target.selectionStart,
                                    event.target.selectionEnd,
                                  ],
                                }),
                              )
                            }
                            onFocus={(event) =>
                              event.target.setSelectionRange(
                                ...draft.correctionSelection,
                              )
                            }
                          />
                          {record.suggestedCorrection &&
                            record.source.available && (
                              <Button
                                variant="ghost"
                                className={styles.useCorrection}
                                disabled={disabled}
                                onClick={() =>
                                  setState((before) =>
                                    updateReviewDraft(before, {
                                      correction:
                                        record.suggestedCorrection![locale],
                                    }),
                                  )
                                }
                              >
                                {copy(
                                  "Use source-based correction",
                                  "使用基于来源的修正",
                                )}
                              </Button>
                            )}
                        </>
                      )}
                    </Field>
                  )}
                  <Field
                    id={id + "-notes"}
                    className={styles.field}
                    label={
                      <>
                        {copy("Reviewer notes", "评审备注")}{" "}
                        <span className={styles.optional}>
                          {copy("Optional", "可选")}
                        </span>
                      </>
                    }
                  >
                    {(props) => (
                      <Textarea
                        {...props}
                        className={styles.notes}
                        placeholder={copy(
                          "What should we improve?",
                          "我们应该改进什么？",
                        )}
                        value={draft.notes}
                        disabled={disabled}
                        onChange={(event) =>
                          setState((before) =>
                            updateReviewDraft(before, {
                              notes: event.target.value,
                            }),
                          )
                        }
                        onBlur={(event) =>
                          setState((before) =>
                            updateReviewDraft(before, {
                              notesSelection: [
                                event.target.selectionStart,
                                event.target.selectionEnd,
                              ],
                            }),
                          )
                        }
                        onFocus={(event) =>
                          event.target.setSelectionRange(
                            ...draft.notesSelection,
                          )
                        }
                      />
                    )}
                  </Field>
                  <div className={styles.destination}>
                    <span className={styles.label}>
                      {copy("Save to dataset", "保存到数据集")}
                    </span>
                    <strong>{reviewDataset.label[locale]}</strong>
                    <p>
                      {copy(
                        "Includes the response, source, and your annotations.",
                        "包含响应、来源和你的标注。",
                      )}
                    </p>
                  </div>
                </div>
                <footer className={styles.reviewFooter}>
                  <p role="status" data-review-status>
                    {message}
                  </p>
                  {unknown && (
                    <Button
                      variant="secondary"
                      className={styles.query}
                      onClick={() => setState(beginReviewQuery)}
                    >
                      {copy("Check save result", "查询保存结果")}
                    </Button>
                  )}
                  <div className={styles.footerActions}>
                    <Button
                      variant="ghost"
                      disabled={locked}
                      onClick={() => setState(skipReview)}
                    >
                      {copy("Skip for now", "暂时跳过")}
                    </Button>
                    <Button
                      loading={pending}
                      disabled={!state.canWrite || unknown}
                      onClick={save}
                    >
                      {copy("Save and next", "保存并前进")}
                      <Check aria-hidden="true" />
                    </Button>
                  </div>
                </footer>
              </aside>
            </div>
          </>
        )}
      </DataRegion>
      {!state.loaded && (
        <Button
          variant="secondary"
          onClick={() => setState((before) => ({ ...before, loaded: true }))}
        >
          {copy("Load fixture queue", "加载模拟队列")}
        </Button>
      )}
      <details className={styles.fixtureControls}>
        <summary>{copy("Local fixture controls", "本地模拟控件")}</summary>
        <p>
          {copy(
            "No service writes. Dataset ds_support_review v1; four independent review examples. Save outcomes are fixed below and apply only after a local receipt.",
            "不写入服务。数据集ds_support_review v1，包含四条独立评审样例。以下保存结果仅在收到本地回执后生效。",
          )}
        </p>
        <Field label={copy("Save outcome", "保存结果")}>
          {(props) => (
            <NativeSelect
              {...props}
              value={state.mode}
              disabled={locked || !state.canWrite}
              onChange={(event) =>
                setState((before) => ({
                  ...before,
                  mode: event.target.value as SaveMode,
                }))
              }
            >
              <option value="confirmed">{copy("Confirmed", "已确认")}</option>
              <option value="rejected">{copy("Rejected", "被拒绝")}</option>
              <option value="unknown-confirmed">
                {copy("Unknown · query confirms", "未知 · 查询确认")}
              </option>
              <option value="unknown-rejected">
                {copy("Unknown · query rejects", "未知 · 查询拒绝")}
              </option>
              <option value="unknown-unresolved">
                {copy("Unknown · still unresolved", "未知 · 仍待核对")}
              </option>
            </NativeSelect>
          )}
        </Field>
        {state.operation && (
          <>
            <p>
              {copy("Operation", "操作")}{" "}
              <code>{state.operation.operationId}</code> ·{" "}
              {state.operation.status}
            </p>
            <pre data-review-payload>
              {JSON.stringify(state.operation.payload, null, 2)}
            </pre>
          </>
        )}
      </details>
    </main>
  )
}
