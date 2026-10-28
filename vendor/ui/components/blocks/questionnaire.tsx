"use client"
import { useEffect, useId, useRef, useState } from "react"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import {
  canSkipQuestion,
  findQuestionnaireIssue,
  validateQuestionnaireQuestion,
  type QuestionnaireAnswer,
  type QuestionnaireAnswers,
  type QuestionnaireQuestion,
} from "../../lib/questionnaire-model"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { RadioGroup, RadioGroupItem } from "../ui/radio-group"
import { Checkbox } from "../ui/checkbox"

export type QuestionnaireProps = {
  questions: readonly QuestionnaireQuestion[]
  value: QuestionnaireAnswers
  /** Missing handler or `readOnly` switches the control to review-only input. */
  onValueChange?: (answers: QuestionnaireAnswers) => void
  readOnly?: boolean
  activeId?: string
  defaultActiveId?: string
  onActiveIdChange?: (id: string) => void
  onSubmit?: (answers: QuestionnaireAnswers) => void
  busy?: boolean
  error?: string
  className?: string
}

export function Questionnaire({
  questions,
  value,
  onValueChange,
  readOnly,
  activeId,
  defaultActiveId,
  onActiveIdChange,
  onSubmit,
  busy = false,
  error,
  className,
}: QuestionnaireProps) {
  const { t } = useI18n()
  const generated = useId()
  const [localId, setLocalId] = useState(defaultActiveId ?? questions[0]?.id)
  const [attempted, setAttempted] = useState(false)
  const title = useRef<HTMLLegendElement>(null)
  const requestedFocus = useRef(false)
  const requested = activeId ?? localId
  const index = Math.max(
    0,
    questions.findIndex((q) => q.id === requested),
  )
  const question = questions[index]
  useEffect(() => {
    if (requestedFocus.current) {
      title.current?.focus()
      requestedFocus.current = false
    }
  }, [question?.id])
  if (!question) return <p role="status">{t("questionnaire.empty")}</p>
  // A missing onValueChange is review-only input, never a busy disguise.
  const editable = !!onValueChange && !readOnly
  const changeStep = (next: number) => {
    const q = questions[next]
    if (!q) return
    setAttempted(false)
    requestedFocus.current = true
    if (activeId === undefined) setLocalId(q.id)
    onActiveIdChange?.(q.id)
  }
  const setAnswer = (answer: QuestionnaireAnswer) => {
    if (!editable) return
    setAttempted(false)
    onValueChange?.({ ...value, [question.id]: answer })
  }
  const answer = value[question.id]
  const issue = validateQuestionnaireQuestion(question, answer)
  // Structural problems show immediately; missing or short answers wait for an attempt.
  const shown =
    (attempted ? issue : undefined) ??
    (issue && !["required", "min"].includes(issue.code) ? issue : undefined)
  const choiceAnswer = answer?.type === "choice" ? answer : undefined
  const choiceAnswerWith = (selected: string[], customText?: string) => ({
    type: "choice" as const,
    selected,
    ...(customText ? { customText } : {}),
  })
  const next = () => {
    const current = validateQuestionnaireQuestion(question, value[question.id])
    if (current) {
      setAttempted(true)
      return
    }
    changeStep(index + 1)
  }
  const descriptionId = question.description
    ? `${generated}-description`
    : undefined
  const bounds =
    question.type === "multiple"
      ? { min: question.minSelections, max: question.maxSelections }
      : undefined
  const rangeId =
    bounds && (bounds.min !== undefined || bounds.max !== undefined)
      ? `${generated}-range`
      : undefined
  let rangeText: string | undefined
  if (bounds && rangeId) {
    if (bounds.min !== undefined && bounds.max !== undefined)
      rangeText = t("agentElements.selectionRange", {
        min: bounds.min,
        max: bounds.max,
      })
    else if (bounds.min !== undefined)
      rangeText = t("agentElements.minimumSelections", { min: bounds.min })
    else if (bounds.max !== undefined)
      rangeText = t("agentElements.maximumSelections", { max: bounds.max })
  }
  const errorId = shown || error ? `${generated}-error` : undefined
  const described =
    [descriptionId, rangeId, errorId].filter(Boolean).join(" ") || undefined
  const locked = busy || question.disabled || !editable
  // Caller errors win; local issues only describe answer validity.
  let alertMessage = error
  if (!alertMessage && shown) {
    switch (shown.code) {
      case "required":
        alertMessage = t("questionnaire.required")
        break
      case "min":
        alertMessage = t("agentElements.minimumSelections", {
          min: shown.min,
        })
        break
      case "max":
        alertMessage = t("agentElements.maximumSelections", { max: shown.max })
        break
      default:
        alertMessage = t("agentElements.invalidAnswer")
    }
  }
  return (
    <form
      className={cn("grid max-w-lg gap-3", className)}
      aria-busy={busy || undefined}
      data-readonly={editable ? undefined : "true"}
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !editable || !onSubmit) return
        const invalid = findQuestionnaireIssue(questions, value)
        if (invalid) {
          changeStep(invalid.index)
          setAttempted(true)
          return
        }
        onSubmit({ ...value })
      }}
    >
      <p role="status" className="text-xs tabular-nums text-muted-foreground">
        {t("questionnaire.step", {
          current: index + 1,
          total: questions.length,
        })}
      </p>
      <fieldset disabled={locked} className="grid gap-2" key={question.id}>
        <legend
          ref={title}
          tabIndex={-1}
          id={`${generated}-title`}
          className="mb-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {question.title}
          {question.required && <span aria-hidden="true"> *</span>}
        </legend>
        {question.description && (
          <p id={descriptionId} className="text-[13px] text-muted-foreground">
            {question.description}
          </p>
        )}
        {question.type === "text" ? (
          <Textarea
            aria-labelledby={`${generated}-title`}
            aria-describedby={described}
            aria-invalid={alertMessage ? true : undefined}
            value={answer?.type === "text" ? answer.text : ""}
            onChange={(event) =>
              setAnswer({ type: "text", text: event.target.value })
            }
            placeholder={question.placeholder}
          />
        ) : question.type === "single" ? (
          <RadioGroup
            aria-labelledby={`${generated}-title`}
            aria-describedby={described}
            aria-invalid={alertMessage ? true : undefined}
            value={choiceAnswer?.selected[0] ?? null}
            onValueChange={(selected) =>
              setAnswer(
                choiceAnswerWith(
                  selected ? [selected] : [],
                  choiceAnswer?.customText,
                ),
              )
            }
            disabled={locked}
          >
            <>
              {question.options.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <RadioGroupItem
                    value={option.value}
                    disabled={option.disabled}
                  />
                  <span>
                    {option.label}
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </>
          </RadioGroup>
        ) : (
          <div
            role="group"
            aria-labelledby={`${generated}-title`}
            aria-describedby={described}
          >
            {question.options.map((option) => {
              const selected = choiceAnswer?.selected ?? []
              return (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <Checkbox
                    disabled={locked || option.disabled}
                    checked={selected.includes(option.value)}
                    onCheckedChange={(checked) =>
                      setAnswer(
                        choiceAnswerWith(
                          checked
                            ? [...selected, option.value]
                            : selected.filter((v) => v !== option.value),
                          choiceAnswer?.customText,
                        ),
                      )
                    }
                  />
                  <span>
                    {option.label}
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        {rangeId && rangeText && (
          <p id={rangeId} className="text-xs text-muted-foreground">
            {rangeText}
          </p>
        )}
        {question.type !== "text" && question.allowCustom && (
          <label
            className="grid gap-1 text-[13px]"
            htmlFor={`${generated}-custom`}
          >
            <span>
              {question.customLabel ?? t("agentElements.customAnswer")}
            </span>
            <Textarea
              id={`${generated}-custom`}
              aria-describedby={described}
              value={choiceAnswer?.customText ?? ""}
              onChange={(event) =>
                setAnswer(
                  choiceAnswerWith(
                    choiceAnswer?.selected ?? [],
                    event.target.value,
                  ),
                )
              }
              placeholder={
                question.customPlaceholder ??
                t("agentElements.customAnswerPlaceholder")
              }
            />
          </label>
        )}
        {alertMessage && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {alertMessage}
          </p>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          key="back"
          type="button"
          variant="secondary"
          disabled={busy || index === 0}
          onClick={() => changeStep(index - 1)}
        >
          {t("questionnaire.back")}
        </Button>
        {editable && canSkipQuestion(question) && index < questions.length - 1 && (
          <Button
            key="skip"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setAnswer({ type: "skipped" })
              changeStep(index + 1)
            }}
          >
            {t("questionnaire.skip")}
          </Button>
        )}
        {index < questions.length - 1 ? (
          <Button key="next" type="button" disabled={busy} onClick={next}>
            {t("questionnaire.next")}
          </Button>
        ) : (
          onSubmit &&
          editable && (
            <Button key="submit" type="submit" loading={busy}>
              {t("questionnaire.submit")}
            </Button>
          )
        )}
      </div>
    </form>
  )
}
