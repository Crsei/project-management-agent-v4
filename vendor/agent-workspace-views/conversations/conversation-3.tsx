"use client"
import { useId, useRef, useSyncExternalStore } from "react"
import { FileText, Folder } from "lucide-react"
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from "./ui"
import { Markdown } from "./markdown"
import type { ComposerHost } from "../composer-workspace-view"
import {
  ThreadActivity,
  ThreadMessage,
  ThreadPanel,
  ThreadView,
} from "./shared"
import { campaignDirections } from "./conversation-3-fixtures"
import type { Conversation3Controller } from "./conversation-3-controller"
import styles from "./conversation-3.module.css"
const subscribeHydration = () => () => {}
const clientHydrated = () => true
const serverHydrated = () => false
export function Conversation3View({
  controller,
  host,
}: {
  controller: Conversation3Controller
  host: ComposerHost
}) {
  const { copy, label, state, update } = controller
  const question = useRef<HTMLDivElement>(null)
  const id = useId()
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  )
  const answer = state.answers.direction
  const selected = answer?.type === "choice" ? (answer.selected[0] ?? "") : ""
  const custom = answer?.type === "choice" ? (answer.customText ?? "") : ""
  function select(value: string) {
    update({
      answers: {
        direction: { type: "choice", selected: [value], customText: "" },
      },
      error: undefined,
    })
  }
  function reopen() {
    update({ phase: "editing" })
    requestAnimationFrame(() => {
      const target = custom.trim()
        ? question.current?.querySelector<HTMLElement>('input[type="text"]')
        : (question.current?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"]',
          ) ?? question.current?.querySelector<HTMLElement>('[role="radio"]'))
      target?.focus()
    })
  }
  return (
    <ThreadView
      page="conversation-3"
      controller={controller}
      host={host}
      inputOptions={{ showContextReferences: true }}
      afterInput={
        controller.selectedId === "conversation-3" && (
          <div className="flex gap-4 text-xs text-text-secondary">
            <span className="flex items-center gap-2">
              <Folder size={14} />
              {label("发布工作区", "Launch workspace")}
            </span>
            <span className="flex items-center gap-2">
              <FileText size={14} />
              {label("宣传简报", "Campaign brief")}
            </span>
          </div>
        )
      }
      renderMessage={(message) => {
        const isAnswer = message.id === "conversation-3-answer"
        return (
          <ThreadMessage
            message={message}
            controller={controller}
            author={isAnswer ? "EasyuseUI AI" : undefined}
            agentRole={
              isAnswer ? label("宣传 Agent", "Campaign agent") : undefined
            }
            activity={
              isAnswer && (
                <>
                  <Markdown
                    locale={controller.locale}
                    content={label(
                      "我审阅了模板集合、近期客户需求与表现最好的上线宣传信息。产品能够支持三种有说服力的叙事。",
                      "I reviewed the collection, recent customer requests and the strongest-performing launch messages. The product can credibly support three different narratives.",
                    )}
                  />
                  <ThreadActivity
                    title={label("工作耗时", "Worked for")}
                    elapsed="2m 46s"
                    defaultOpen={false}
                  >
                    <p>
                      {label(
                        "已比较交付速度、界面质量与团队协作三个定位。固定本地摘要，未执行真实调研。",
                        "Compared implementation speed, UI quality and team collaboration. Fixed local summary; no real research was executed.",
                      )}
                    </p>
                  </ThreadActivity>
                </>
              )
            }
          >
            {isAnswer && (
              <div
                data-conversation-question
                ref={question}
                onKeyDown={(event) => {
                  if (
                    state.phase !== "editing" ||
                    !hydrated ||
                    !controller.active ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.target instanceof HTMLInputElement ||
                    event.target instanceof HTMLTextAreaElement
                  )
                    return
                  const index = ["1", "2", "3"].indexOf(event.key)
                  if (index >= 0) {
                    event.preventDefault()
                    select(campaignDirections[index].value)
                    question.current
                      ?.querySelectorAll<HTMLElement>('[role="radio"]')
                      [index]?.focus()
                  }
                }}
              >
                <ThreadPanel
                  title={label("选择一个方向", "Choose a direction")}
                >
                  {state.phase === "editing" ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        controller.submit(state.answers)
                      }}
                    >
                      <p className="mb-3">
                        {label(
                          "选择宣传角度，或填写自己的回答。仅保存在本地。",
                          "Select a campaign angle or write another response. Saved locally only.",
                        )}
                      </p>
                      <RadioGroup
                        value={selected}
                        onValueChange={(value) => select(value)}
                        aria-label={label("宣传定位", "Campaign positioning")}
                        disabled={!hydrated || !controller.active}
                        className={styles.options}
                      >
                        {campaignDirections.map((item, index) => (
                          <Label
                            htmlFor={`${id}-${item.value}`}
                            key={item.value}
                            className={styles.option}
                            data-selected={selected === item.value}
                            data-disabled={!hydrated || !controller.active}
                          >
                            <RadioGroupItem
                              id={`${id}-${item.value}`}
                              value={item.value}
                              aria-labelledby={`${id}-${item.value}-label`}
                              aria-describedby={`${id}-${item.value}-description`}
                              aria-keyshortcuts={String(index + 1)}
                            />
                            <span className={styles.optionText}>
                              <strong id={`${id}-${item.value}-label`}>
                                {copy(item.label)}
                              </strong>
                              <span id={`${id}-${item.value}-description`}>
                                {copy(item.description)}
                              </span>
                            </span>
                            <kbd aria-hidden="true">{index + 1}</kbd>
                          </Label>
                        ))}
                      </RadioGroup>
                      <Field data-invalid={!!state.error} className="mt-3">
                        <FieldLabel htmlFor={id} className={styles.customLabel}>
                          {label(
                            "或填写自己的回答",
                            "Or write your own response",
                          )}
                        </FieldLabel>
                        <Input
                          type="text"
                          id={id}
                          value={custom}
                          disabled={!hydrated || !controller.active}
                          placeholder={label(
                            "填写其他方向…",
                            "Write another direction…",
                          )}
                          aria-invalid={!!state.error}
                          aria-describedby={
                            state.error ? `${id}-error` : undefined
                          }
                          onChange={(event) =>
                            update({
                              answers: {
                                direction: {
                                  type: "choice",
                                  selected: [],
                                  customText: event.target.value,
                                },
                              },
                              error: undefined,
                            })
                          }
                        />
                        {state.error && (
                          <FieldError id={`${id}-error`}>
                            {copy(state.error)}
                          </FieldError>
                        )}
                      </Field>
                      <div className={styles.actions}>
                        <Button
                          variant="ghost"
                          type="button"
                          disabled={!hydrated || !controller.active}
                          onClick={() => {
                            update({ phase: "dismissed", error: undefined })
                            controller.focusComposer()
                          }}
                        >
                          {label("略过", "Dismiss")}
                        </Button>
                        <Button
                          type="submit"
                          disabled={
                            !hydrated ||
                            !controller.active ||
                            (!selected && !custom.trim())
                          }
                        >
                          {label("提交方向", "Submit direction")}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="space-y-3">
                      <p role="status">
                        {state.phase === "submitted"
                          ? label(
                              "本地回答已记录：",
                              "Local answer recorded: ",
                            ) + (state.result ? copy(state.result) : "")
                          : label(
                              "已略过提问，回答草稿已保留。",
                              "Question dismissed; your answer draft is preserved.",
                            )}
                      </p>
                      <Button
                        variant="outline"
                        disabled={!hydrated || !controller.active}
                        onClick={reopen}
                      >
                        {label("重新编辑回答", "Edit answer again")}
                      </Button>
                    </div>
                  )}
                </ThreadPanel>
              </div>
            )}
          </ThreadMessage>
        )
      }}
    />
  )
}
