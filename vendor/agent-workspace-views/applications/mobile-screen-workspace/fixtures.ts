export type MobileCopy = { "zh-CN": string; en: string }
export type MobileMessage = {
  id: string
  role: "assistant" | "user"
  text: MobileCopy
}

export const openingMessages: readonly MobileMessage[] = [
  {
    id: "opening-1",
    role: "assistant",
    text: {
      "zh-CN": "我已查看发布说明。需要为团队整理一份简短的交接计划吗？",
      en: "I reviewed the launch notes. Want a short handoff plan for the team?",
    },
  },
  {
    id: "opening-2",
    role: "user",
    text: {
      "zh-CN": "好的。请归纳为三个清晰的步骤。",
      en: "Yes. Keep it to three clear steps.",
    },
  },
  {
    id: "opening-3",
    role: "assistant",
    text: {
      "zh-CN":
        "从发布清单开始，为每个未完成事项指定负责人，然后在发布前分享最终状态更新。",
      en: "Start with the release checklist, name an owner for each open item, then share a final status update before launch.",
    },
  },
]

export const starterPrompts = [
  { id: "update", text: { "zh-CN": "起草团队更新", en: "Draft team update" } },
  { id: "risks", text: { "zh-CN": "查找未解决风险", en: "Find open risks" } },
] as const

/** Local scripted preview: no model or external execution is requested. */
export function previewReply(
  text: string,
  model: "Focus" | "Fast",
): MobileCopy {
  const risks = /risk|风险/i.test(text)
  const update = /update|更新/i.test(text)
  if (risks)
    return {
      "zh-CN":
        "示例风险检查：确认未完成事项的负责人，复核发布清单，并为尚未确认的检查保留明确状态。",
      en: "Example risk check: confirm owners for open items, review the release checklist, and keep unconfirmed checks explicitly pending.",
    }
  if (update)
    return {
      "zh-CN":
        "示例团队更新：负责人已列入交接清单；请逐项确认未完成检查，并在发布前共享最终状态。",
      en: "Example team update: owners are listed in the handoff checklist; confirm each open check and share the final status before launch.",
    }
  return model === "Fast"
    ? {
        "zh-CN": "示例简版：确认负责人、复核剩余检查、发布团队更新。",
        en: "Example short version: confirm owners, review remaining checks, and post the team update.",
      }
    : {
        "zh-CN":
          "示例回复：确认负责人，完成剩余检查，然后发布更新。可以继续细化其中任何一步。",
        en: "Example response: confirm the owner, close the remaining checks, and post the launch update. You can refine any step.",
      }
}
