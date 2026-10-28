"use client"
import { useState } from "react"
import { MessageCircleQuestion } from "lucide-react"
import styles from "./question-tool.module.css"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import {
  summarizeQuestionnaireAnswer,
  type AgentQuestionRequest,
  type QuestionnaireAnswerSummary,
  type QuestionnaireAnswers,
} from "../../lib/questionnaire-model"
import { Button } from "../ui/button"
import { Questionnaire } from "./questionnaire"

/** Local receipt and query feedback reset when identity or outcome changes. */
function requestKey(request: AgentQuestionRequest) {
  return `${request.id}:${request.revision}:${request.outcome}`
}

type QuestionEditProps = {
  request: AgentQuestionRequest
  /** Source-driven lock: pending requests keep the draft without resubmitting. */
  busy?: boolean
  onAnswersChange?: (answers: QuestionnaireAnswers) => void
  onSubmit?: (answers: QuestionnaireAnswers) => void | Promise<void>
  onActiveIdChange?: (id: string) => void
  error?: string
  className?: string
}

/**
 * Shared edit UI. The request stays caller-owned; settling a submit never
 * confirms it. Until the source changes outcome or revision the same
 * (id, revision) request stays locked with an unconfirmed receipt instead of
 * silently re-enabling submission. A missing onAnswersChange renders
 * review-only input instead of a no-op handler.
 */
function QuestionEdit({
  request,
  busy,
  onAnswersChange,
  onSubmit,
  onActiveIdChange,
  error,
  className,
}: QuestionEditProps) {
  const { t } = useI18n()
  const [submitting, setSubmitting] = useState(false)
  const [awaitingReceipt, setAwaitingReceipt] = useState(false)
  const submit = async (answers: QuestionnaireAnswers) => {
    if (!onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(answers)
    } catch {
      // The rejection is not swallowed: the receipt below reports it.
    } finally {
      setSubmitting(false)
      setAwaitingReceipt(true)
    }
  }
  return (
    <>
      <Questionnaire
        className={className}
        questions={request.questions}
        value={request.answers}
        activeId={request.activeId}
        onValueChange={onAnswersChange}
        onActiveIdChange={onActiveIdChange}
        busy={busy || submitting || awaitingReceipt}
        error={error}
        onSubmit={onSubmit ? submit : undefined}
      />
      {awaitingReceipt && !busy && (
        <p role="status" className={styles.feedback}>
          {t("toolCall.outcomeUnknown")}
        </p>
      )}
    </>
  )
}

type QuestionSummaryProps = {
  request: AgentQuestionRequest
  /** Only source-confirmed answers may claim the confirmed heading. */
  heading?: string
  onReconcile?: () => void | Promise<void>
  onEdit?: () => void
}

function QuestionSummary({
  request,
  heading,
  onReconcile,
  onEdit,
}: QuestionSummaryProps) {
  const { t } = useI18n()
  const [reconcileFailed, setReconcileFailed] = useState(false)
  const reconcile = () => {
    if (!onReconcile) return
    try {
      const result = onReconcile()
      // A failed query stays unknown and is reported instead of replayed.
      if (result) void result.catch(() => setReconcileFailed(true))
    } catch {
      setReconcileFailed(true)
    }
  }
  const summaryText = (summary: QuestionnaireAnswerSummary) => {
    switch (summary.kind) {
      case "skipped":
        return t("agentElements.skipped")
      case "none":
        return t("agentElements.noAnswer")
      case "unavailable":
        return t("agentElements.invalidAnswer")
      case "text":
        return summary.text || t("agentElements.noAnswer")
      default:
        return [
          ...summary.labels,
          ...(summary.customText ? [summary.customText] : []),
        ].join(", ")
    }
  }
  return (
    <div className={cn(styles.body, styles.summary)}>
      {request.error && (
        <p role="alert" className={styles.error}>
          {request.error}
        </p>
      )}
      {heading && <p className={styles.summaryTitle}>{heading}</p>}
      <dl className={styles.answers}>
        {request.questions.map((question) => (
          <div key={question.id} className={styles.answer}>
            <dt className={styles.question}>{question.title}</dt>
            <dd className={styles.answerText}>
              {summaryText(
                summarizeQuestionnaireAnswer(
                  question,
                  request.answers[question.id],
                ),
              )}
            </dd>
          </div>
        ))}
      </dl>
      {(onReconcile || onEdit || reconcileFailed) && (
        <div className={styles.actions}>
          {request.outcome === "unknown" && onReconcile && (
            <Button type="button" variant="secondary" onClick={reconcile}>
              {t("agentElements.reconcileAnswer")}
            </Button>
          )}
          {(request.outcome === "confirmed" || request.outcome === "failed") &&
            onEdit && (
              <Button type="button" variant="outline" onClick={onEdit}>
                {t("agentElements.editAnswers")}
              </Button>
            )}
          {reconcileFailed && (
            <p role="alert" className={styles.error}>
              {t("common.valueRequestFailedTheOutcomeIsUnknownQuery", {
                value0: t("agentElements.reconcileAnswer"),
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Editing and pending keep the form; failed reopens it only without an edit action. */
function showsQuestionForm(
  request: AgentQuestionRequest,
  hasEditAction: boolean,
) {
  if (request.outcome === "editing" || request.outcome === "pending")
    return true
  if (request.outcome === "failed") return !hasEditAction
  return false
}

export type QuestionPromptProps = {
  request: AgentQuestionRequest
  onAnswersChange?: (answers: QuestionnaireAnswers) => void
  onSubmit?: (answers: QuestionnaireAnswers) => void | Promise<void>
  onActiveIdChange?: (id: string) => void
  className?: string
}

/**
 * Edit UI for composer or message slots. It follows the request outcome:
 * pending stays locked, confirmed and unknown render the read-only summary,
 * and a missing onAnswersChange yields review-only input instead of a
 * no-op handler.
 */
export function QuestionPrompt({
  request,
  onAnswersChange,
  onSubmit,
  onActiveIdChange,
  className,
}: QuestionPromptProps) {
  const { t } = useI18n()
  return (
    <section className={cn(styles.prompt, className)}>
      <h4 className={styles.title}>
        {request.title || t("agentElements.question")}
      </h4>
      {showsQuestionForm(request, false) ? (
        <QuestionEdit
          key={requestKey(request)}
          request={request}
          busy={request.outcome === "pending"}
          onAnswersChange={onAnswersChange}
          onSubmit={onSubmit}
          onActiveIdChange={onActiveIdChange}
          error={request.error}
          className={styles.body}
        />
      ) : (
        <QuestionSummary
          key={requestKey(request)}
          request={request}
          heading={
            request.outcome === "confirmed"
              ? t("agentElements.answerSummary")
              : undefined
          }
        />
      )}
    </section>
  )
}

export type QuestionToolProps = {
  request: AgentQuestionRequest
  onAnswersChange?: (answers: QuestionnaireAnswers) => void
  onSubmit?: (answers: QuestionnaireAnswers) => void | Promise<void>
  onActiveIdChange?: (id: string) => void
  onReconcile?: () => void | Promise<void>
  onEdit?: () => void
}

/**
 * Question tool driven by one source request: editing keeps the draft
 * editable, pending locks the form without resubmitting, confirmed shows the
 * source-owned summary, failed preserves the answers, unknown only offers
 * reconciliation. With an explicit onEdit the failed request stays read-only
 * until the caller reopens it; without one the draft remains editable in place.
 */
export function QuestionTool({
  request,
  onAnswersChange,
  onSubmit,
  onActiveIdChange,
  onReconcile,
  onEdit,
}: QuestionToolProps) {
  const { t } = useI18n()
  const statusText =
    request.outcome === "pending"
      ? t("agentElements.answerPending")
      : request.outcome === "unknown"
        ? t("agentElements.answerUnknown")
        : request.outcome === "failed"
          ? t("agentElements.answerFailed")
          : undefined
  return (
    <section
      className={styles.tool}
      data-question-tool=""
      data-question-id={request.id}
      data-question-outcome={request.outcome}
    >
      <div className={styles.header}>
        <MessageCircleQuestion size={16} aria-hidden="true" />
        <h4 className={styles.title}>{request.title}</h4>
        {statusText && (
          <span
            className={styles.status}
            data-question-status={request.outcome}
            role="status"
          >
            {statusText}
          </span>
        )}
      </div>
      {showsQuestionForm(request, !!onEdit) ? (
        <QuestionEdit
          key={requestKey(request)}
          request={request}
          busy={request.outcome === "pending"}
          onAnswersChange={onAnswersChange}
          onSubmit={onSubmit}
          onActiveIdChange={onActiveIdChange}
          error={request.error}
          className={styles.body}
        />
      ) : (
        <QuestionSummary
          key={requestKey(request)}
          request={request}
          heading={
            request.outcome === "confirmed"
              ? t("agentElements.answerSummary")
              : undefined
          }
          onReconcile={onReconcile}
          onEdit={onEdit}
        />
      )}
    </section>
  )
}
