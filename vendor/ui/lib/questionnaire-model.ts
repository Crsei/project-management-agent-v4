export type QuestionnaireOption = {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export type QuestionnaireQuestion = {
  id: string
  title: string
  description?: string
  required?: boolean
  disabled?: boolean
  allowSkip?: boolean
} & (
  | { type: "text"; placeholder?: string }
  | {
      type: "single" | "multiple"
      options: readonly QuestionnaireOption[]
      allowCustom?: boolean
      customLabel?: string
      customPlaceholder?: string
      minSelections?: number
      maxSelections?: number
    }
)

export type QuestionnaireAnswer =
  | { type: "text"; text: string }
  | { type: "choice"; selected: string[]; customText?: string }
  | { type: "skipped" }

export type QuestionnaireAnswers = Record<string, QuestionnaireAnswer>

export type QuestionOutcome = "editing" | "pending" | "confirmed" | "failed" | "unknown"

export type AgentQuestionRequest = {
  id: string
  revision: string
  title: string
  questions: readonly QuestionnaireQuestion[]
  answers: QuestionnaireAnswers
  outcome: QuestionOutcome
  activeId?: string
  error?: string
}

/** Validation problems reported to callers as i18n keys, never as rendered copy. */
export type QuestionnaireIssue =
  | { code: "required" }
  | { code: "min"; min: number }
  | { code: "max"; max: number }
  | { code: "option"; value: string }
  | { code: "custom" }
  | { code: "single" }
  | { code: "shape" }

/**
 * Required questions are only skippable when the source allows it explicitly;
 * optional questions are skippable by default.
 */
export function canSkipQuestion(question: QuestionnaireQuestion): boolean {
  return question.allowSkip ?? !question.required
}

function isMalformedAnswer(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer,
): boolean {
  if (question.type === "text") return answer.type !== "text" && answer.type !== "skipped"
  if (answer.type === "skipped") return false
  if (answer.type !== "choice") return true
  if (!Array.isArray(answer.selected)) return true
  if (answer.selected.some((value) => typeof value !== "string")) return true
  return answer.customText !== undefined && typeof answer.customText !== "string"
}

/**
 * Single source of truth for answer validity. Unknown or disabled option values,
 * foreign answer shapes and out-of-range selections never pass; answers are read
 * only, so callers keep every stored value when validation fails.
 */
export function validateQuestionnaireQuestion(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer | undefined,
): QuestionnaireIssue | undefined {
  if (question.disabled) return undefined
  if (answer && answer.type !== "skipped" && isMalformedAnswer(question, answer))
    return { code: "shape" }

  if (answer && answer.type === "skipped")
    return canSkipQuestion(question) ? undefined : { code: "required" }

  if (!answer) {
    if (!question.required) return undefined
    if (question.type === "multiple") {
      const min = question.minSelections
      if (min !== undefined && min > 0) return { code: "min", min }
    }
    return { code: "required" }
  }

  if (question.type === "text") {
    if (answer.type !== "text") return { code: "shape" }
    return answer.text.trim().length > 0 || !question.required
      ? undefined
      : { code: "required" }
  }
  if (answer.type !== "choice") return { code: "shape" }
  const { selected, customText } = answer
  const custom = customText?.trim() ?? ""
  const enabled = question.options
    .filter((option) => !option.disabled)
    .map((option) => option.value)
  const unknown = selected.find((value) => !enabled.includes(value))
  if (unknown !== undefined) return { code: "option", value: unknown }
  if (custom && !question.allowCustom) return { code: "custom" }

  if (question.type === "single") {
    if (selected.length > 1) return { code: "single" }
    if (selected.length === 0 && !custom && question.required)
      return { code: "required" }
    return undefined
  }

  const count = selected.length
  if (
    question.maxSelections !== undefined &&
    count > question.maxSelections
  )
    return { code: "max", max: question.maxSelections }
  const min = question.minSelections
  if (count > 0 && min !== undefined && count < min) return { code: "min", min }
  if (count === 0 && !custom && question.required)
    return min !== undefined && min > 0 ? { code: "min", min } : { code: "required" }
  return undefined
}

/** First invalid question, including optional questions with non-empty invalid answers. */
export function findQuestionnaireIssue(
  questions: readonly QuestionnaireQuestion[],
  answers: QuestionnaireAnswers,
):
  | { index: number; question: QuestionnaireQuestion; issue: QuestionnaireIssue }
  | undefined {
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const issue = validateQuestionnaireQuestion(question, answers[question.id])
    if (issue) return { index, question, issue }
  }
  return undefined
}

export type QuestionnaireAnswerSummary =
  | { kind: "none" }
  | { kind: "skipped" }
  | { kind: "unavailable" }
  | { kind: "text"; text: string }
  | { kind: "choice"; labels: string[]; customText?: string }

/** Read-only answer rendering data; unknown values stay visible instead of being dropped. */
export function summarizeQuestionnaireAnswer(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer | undefined,
): QuestionnaireAnswerSummary {
  if (!answer) return { kind: "none" }
  if (answer.type === "skipped") return { kind: "skipped" }
  if (question.type === "text")
    return answer.type === "text"
      ? { kind: "text", text: answer.text }
      : { kind: "unavailable" }
  if (answer.type !== "choice" || !Array.isArray(answer.selected))
    return { kind: "unavailable" }
  const labels = answer.selected.map(
    (value) =>
      question.options.find((option) => option.value === value)?.label ?? value,
  )
  const customText =
    typeof answer.customText === "string" && answer.customText.trim()
      ? answer.customText.trim()
      : undefined
  if (labels.length === 0 && !customText) return { kind: "none" }
  return { kind: "choice", labels, customText }
}
