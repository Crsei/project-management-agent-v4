import type { Copy, Draft } from "../../model"
import { commands, contexts, type ShortcutItem } from "./fixtures.ts"

export type Trigger = { kind: "command" | "context"; query: string; start: number; end: number }

/** Only the token containing the caret participates; completed prefixes remain text. */
export function findTrigger(text: string, caret = text.length): Trigger | null {
  const prefix = text.slice(0, caret)
  const match = /(?:^|\s)([/@])([^\s/@]*)$/.exec(prefix)
  if (!match) return null
  const start = prefix.length - match[2].length - 1
  return { kind: match[1] === "/" ? "command" : "context", query: match[2], start, end: caret }
}

export function filterSuggestions(trigger: Trigger | null, locale: "zh-CN" | "en", extraContexts: ShortcutItem[] = []): ShortcutItem[] {
  if (!trigger) return []
  const query = trigger.query.toLocaleLowerCase(locale)
  return (trigger.kind === "command" ? commands : [...contexts, ...extraContexts]).filter((item) => `${item.id} ${item.title[locale]} ${item.title.en}`.toLocaleLowerCase(locale).includes(query))
}

export function acceptSuggestion(draft: Draft, trigger: Trigger, item: ShortcutItem): { draft: Draft; caret: number } {
  const replacement = trigger.kind === "command" ? `/${item.id} ` : ""
  const text = draft.text.slice(0, trigger.start) + replacement + draft.text.slice(trigger.end)
  return {
    draft: { ...draft, text, contextIds: trigger.kind === "context" && !draft.contextIds.includes(item.id) ? [...draft.contextIds, item.id] : draft.contextIds },
    caret: trigger.start + replacement.length,
  }
}

export function canSubmit(draft: Draft, blocked: boolean): boolean {
  const text = draft.text.trim()
  return !blocked && text.length > 0 && text !== "/" && text !== "@" && text !== "!"
}

export function createLocalResponse(draft: Draft): Copy {
  if (draft.text.startsWith("!")) {
    const command = draft.text.slice(1).trim()
    return {
      "zh-CN": `Shell 请求已保留在本地记录：${command}\n\n当前页面没有连接 Shell 或 PTY；没有执行命令。草稿与上下文可继续修改。`,
      en: `Shell request recorded locally: ${command}\n\nThis page is not connected to a shell or PTY; the command was not executed. Drafts and context remain editable.`,
    }
  }
  const command = commands.find((item) => draft.text.startsWith(`/${item.id}`))
  return {
    "zh-CN": `${command ? `${command.title["zh-CN"]}：` : "本地任务草稿："}已将输入和 ${draft.contextIds.length} 个上下文引用加入会话记录。\n\n这是本地 fixture 回复，没有运行工作流、委派 Agent 或调用模型服务。`,
    en: `${command ? `${command.title.en}: ` : "Local task draft: "}the input and ${draft.contextIds.length} context references were added to the conversation.\n\nThis is a local fixture response. No workflow, delegated agent, or model service was run.`,
  }
}
