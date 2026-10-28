"use client"

import { useMemo, type ReactNode } from "react"
import type {
  MessagePart,
  WorkbenchMessage,
  WorkbenchTool,
  ChangeSet,
  SessionSnapshot,
} from "../../lib/agent-workbench-model"
import type {
  AgentQuestionRequest,
  QuestionnaireAnswers,
} from "../../lib/questionnaire-model"
import { routeToolCall } from "../../lib/agent-tool-model"
import { useI18n } from "../../lib/i18n-provider"
import { redact } from "../../lib/redact"
import { Button } from "../ui/button"
import { RuntimeStatusBadge } from "../ui/runtime-status-badge"
import { MessageContent } from "./message-content"
import { ToolRenderer, type ToolRendererProps } from "./tool-renderer"
import { ToolGroup } from "./tool-group"
import { SubagentTool } from "./subagent-tool"
import { ThinkingTool } from "./thinking-tool"
import { AgentAttachments } from "./agent-attachments"
import { QuestionTool } from "./question-tool"
import styles from "./agent-message.module.css"

export type AgentMessageContentProps = {
  message: WorkbenchMessage
  tools: readonly WorkbenchTool[]
  questions?: readonly AgentQuestionRequest[]
  changes?: ChangeSet
  plan?: SessionSnapshot["plan"]
  renderers?: ToolRendererProps["renderers"]
  getToolProps?: (
    call: WorkbenchTool,
  ) => Omit<ToolRendererProps, "call" | "renderers" | "children">
  groupTools?: boolean
  activeQuestionId?: string
  questionInComposer?: boolean
  onQuestionAnswersChange?: (
    id: string,
    revision: string,
    answers: QuestionnaireAnswers,
  ) => void
  onQuestionSubmit?: (
    id: string,
    revision: string,
    answers: QuestionnaireAnswers,
  ) => void | Promise<void>
  onQuestionActiveIdChange?: (id: string, activeId: string) => void
  onQuestionReconcile?: (id: string, revision: string) => void | Promise<void>
  onOpenReference?: (part: MessagePart) => void
  onOpenChange?: (fileId: string) => void
  onOpenTool?: (callId: string) => void
  onOpenFile?: (attachmentId: string) => void
}

export function messageCopyText(message: WorkbenchMessage) {
  return message.parts
    .map((part) => ("text" in part ? part.text.slice(0, 32768) : part.label))
    .join("\n")
}

export function AgentMessageContent({
  message,
  tools,
  questions,
  changes,
  plan,
  renderers,
  getToolProps,
  groupTools = false,
  activeQuestionId,
  questionInComposer,
  onQuestionAnswersChange,
  onQuestionSubmit,
  onQuestionActiveIdChange,
  onQuestionReconcile,
  onOpenReference,
  onOpenChange,
  onOpenTool,
  onOpenFile,
}: AgentMessageContentProps) {
  const { t } = useI18n()
  const byId = useMemo(
    () => new Map(tools.map((tool) => [tool.id, tool])),
    [tools],
  )
  const referenced = new Set(
    message.parts.flatMap((part) =>
      part.kind === "tool" ? [part.referenceId] : [],
    ),
  )
  const isRootTool = (part: MessagePart) => {
    if (part.kind !== "tool") return false
    const call = byId.get(part.referenceId)
    return (
      call &&
      !(
        call.parentId &&
        referenced.has(call.parentId) &&
        byId.has(call.parentId)
      )
    )
  }
  const renderTool = (
    call: WorkbenchTool,
    parents: readonly string[] = [],
  ): ReactNode => {
    if (parents.includes(call.id))
      return <p role="alert">{t("agentElements.invalidHierarchy")}</p>
    const kind = routeToolCall(call)
    const content =
      kind === "subagent" ? (
        <SubagentTool
          call={call}
          tools={tools}
          renderTool={(child) => renderTool(child, [...parents, call.id])}
        />
      ) : kind === "thinking" ? (
        <ThinkingTool
          text={
            call.display?.kind === "thinking"
              ? call.display.text
              : redact(call.output)
          }
          status={call.status}
        />
      ) : undefined
    const changed =
      changes &&
      call.fileIds?.length &&
      call.changeRevision === changes.revision
        ? changes.files.filter((file) => call.fileIds!.includes(file.fileId))
        : []
    return (
      <div className={styles.tool} data-agent-tool-id={call.id}>
        <ToolRenderer
          call={call}
          renderers={renderers}
          {...getToolProps?.(call)}
        >
          {content}
        </ToolRenderer>
        {changed.length > 0 && (
          <div className={styles.references}>
            {changed.map((file) => {
              const label =
                redact(file.path) +
                (file.truncated
                  ? " · " + t("workbench.truncated")
                  : " +" +
                    file.lines.filter((line) => line.kind === "add").length +
                    " −" +
                    file.lines.filter((line) => line.kind === "remove").length)
              return onOpenChange ? (
                <Button
                  key={file.fileId}
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenChange(file.fileId)}
                >
                  {label}
                </Button>
              ) : (
                <span key={file.fileId}>{label}</span>
              )
            })}
          </div>
        )}
        {onOpenTool && (
          <Button size="sm" variant="ghost" onClick={() => onOpenTool(call.id)}>
            {t("resource.commands")}
          </Button>
        )}
      </div>
    )
  }
  const groups: MessagePart[][] = []
  for (const part of message.parts) {
    if (part.kind === "tool" && !isRootTool(part) && byId.has(part.referenceId))
      continue
    const previous = groups.at(-1)
    const media = part.kind === "image" || part.kind === "file"
    const previousMedia =
      previous && (previous[0].kind === "image" || previous[0].kind === "file")
    if (
      previous &&
      ((media && previousMedia) ||
        (groupTools && isRootTool(part) && isRootTool(previous[0])))
    )
      previous.push(part)
    else groups.push([part])
  }
  return (
    <div className={styles.parts}>
      {groups.map((parts) => {
        const first = parts[0]
        if (first.kind === "image" || first.kind === "file")
          return (
            <AgentAttachments
              key={first.partId}
              attachments={parts.flatMap((part) =>
                part.kind === "image" || part.kind === "file"
                  ? [part.attachment]
                  : [],
              )}
              onOpenFile={onOpenFile}
            />
          )
        if (first.kind === "tool" && parts.length > 1) {
          const calls = parts.flatMap((part) =>
            part.kind === "tool" && byId.has(part.referenceId)
              ? [byId.get(part.referenceId)!]
              : [],
          )
          return (
            <ToolGroup
              key={first.partId}
              tools={calls}
              renderTool={(call) => renderTool(call)}
              defaultExpanded={calls.some(
                (call) =>
                  call.error ||
                  call.status === "waiting" ||
                  call.outcome === "unknown",
              )}
            />
          )
        }
        return (
          <div key={first.partId} data-agent-part-kind={first.kind}>
            {first.kind === "text" ? (
              <MessageContent
                content={first.text}
                streaming={message.state === "streaming"}
              />
            ) : first.kind === "code" ? (
              <MessageContent
                content={
                  "```" + (first.language ?? "") + "\n" + first.text + "\n```"
                }
                streaming={message.state === "streaming"}
              />
            ) : first.kind === "error" ? (
              <div className={styles.error} role="alert">
                <strong>{first.title ?? t("agentElements.error")}</strong>
                <p>{first.text}</p>
              </div>
            ) : first.kind === "phase" ? (
              <div className={styles.phase}>
                {t(
                  first.phase === "action"
                    ? "workbench.phaseAction"
                    : first.phase === "output"
                      ? "workbench.phaseOutput"
                      : "workbench.phaseThinking",
                )}
              </div>
            ) : first.kind === "tool" ? (
              byId.has(first.referenceId) ? (
                renderTool(byId.get(first.referenceId)!)
              ) : (
                <p role="status">
                  {first.label} · {t("agentElements.unavailableReference")}
                </p>
              )
            ) : first.kind === "question" ? (
              (() => {
                const request = questions?.find(
                  (question) => question.id === first.referenceId,
                )
                if (!request)
                  return (
                    <p role="status">
                      {first.label} · {t("agentElements.unavailableReference")}
                    </p>
                  )
                if (
                  questionInComposer &&
                  request.id === activeQuestionId &&
                  request.outcome !== "confirmed"
                )
                  return (
                    <p role="status">
                      {request.title} · {t("agentElements.questionInComposer")}
                    </p>
                  )
                return (
                  <QuestionTool
                    request={request}
                    onAnswersChange={
                      onQuestionAnswersChange
                        ? (answers) =>
                            onQuestionAnswersChange(
                              request.id,
                              request.revision,
                              answers,
                            )
                        : undefined
                    }
                    onSubmit={
                      onQuestionSubmit
                        ? (answers) =>
                            onQuestionSubmit(
                              request.id,
                              request.revision,
                              answers,
                            )
                        : undefined
                    }
                    onActiveIdChange={
                      onQuestionActiveIdChange
                        ? (id) => onQuestionActiveIdChange(request.id, id)
                        : undefined
                    }
                    onReconcile={
                      onQuestionReconcile
                        ? () =>
                            onQuestionReconcile(request.id, request.revision)
                        : undefined
                    }
                  />
                )
              })()
            ) : first.kind === "plan" &&
              plan?.some((step) => step.id === first.referenceId) ? (
              <div className={styles.references}>
                {plan.map((step) => (
                  <span key={step.id}>
                    <RuntimeStatusBadge status={step.status} iconOnly />
                    {step.title}
                  </span>
                ))}
                {onOpenReference && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenReference(first)}
                  >
                    {first.label}
                  </Button>
                )}
              </div>
            ) : onOpenReference ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenReference(first)}
              >
                {first.label}
              </Button>
            ) : (
              <span>{"label" in first ? first.label : ""}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
