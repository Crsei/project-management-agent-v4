import {
  createBrief,
  text,
  regions,
  windows,
  sourceTypes,
  type DraftText,
} from "./fixtures.ts"
export type Brief = Omit<
  ReturnType<typeof createBrief>,
  "goal" | "audience" | "exclusions" | "questions" | "steps"
> & {
  goal: DraftText
  audience: DraftText
  exclusions: DraftText
  questions: { id: string; value: DraftText }[]
  steps: { id: string; value: DraftText }[]
}
export type BriefErrors = Record<
  string,
  "required" | "sources" | "questions" | "steps"
>
export type ResearchState = {
  brief: Brief
  canEdit: boolean
  data: "ready" | "loading" | "error"
  planOpen: boolean
  split: number
  briefScroll: number
  planScroll: number
  nextId: number
  errors: BriefErrors
  reviewed: boolean
  run: null | {
    status: "running" | "completed" | "cancelled"
    completed: number
    snapshot: Brief
  }
}
export function createResearchState(scenario: string): ResearchState {
  const brief: Brief = createBrief()
  if (scenario === "empty") {
    brief.goal = ""
    brief.audience = ""
    brief.questions = []
    brief.steps = []
    brief.exclusions = ""
    brief.sources = []
  }
  if (scenario === "long-content") {
    brief.goal = {
      "zh-CN":
        "在多个区域、不同规模和复杂权限要求的团队中，如何验证自助式入门流程能够持续改善首次价值，并识别在扩展试点前需要解决的例外？",
      en: "Across regions, team sizes, and complex permission requirements, how can we validate that self-serve onboarding sustainably improves first value and identify exceptions that must be resolved before expanding the pilot?",
    }
    brief.questions = [
      ...brief.questions,
      ...Array.from({ length: 9 }, (_, i) => ({
        id: "question-long-" + i,
        value: {
          "zh-CN":
            "比较第 " + (i + 1) + " 个用户群体的激活结果、支持成本和证据局限。",
          en:
            "Compare activation outcomes, support costs, and evidence limitations for cohort " +
            (i + 1) +
            ".",
        },
      })),
    ]
  }
  return {
    brief,
    canEdit: scenario !== "readonly",
    data:
      scenario === "loading"
        ? "loading"
        : scenario === "refresh-error"
          ? "error"
          : "ready",
    planOpen: true,
    split: 0.56,
    briefScroll: 0,
    planScroll: 0,
    nextId: 20,
    errors: {},
    reviewed: false,
    run: null,
  }
}
export function validateBrief(brief: Brief): BriefErrors {
  const errors: BriefErrors = {}
  const blank = (value: DraftText) => !text(value, "en").trim()
  if (blank(brief.goal)) errors.goal = "required"
  if (blank(brief.audience)) errors.audience = "required"
  if (!brief.questions.length) errors.questions = "questions"
  if (!brief.steps.length) errors.steps = "steps"
  brief.questions.forEach((row) => {
    if (blank(row.value)) errors[row.id] = "required"
  })
  brief.steps.forEach((row) => {
    if (blank(row.value)) errors[row.id] = "required"
  })
  if (!brief.sources.length) errors.sources = "sources"
  return errors
}
export type ResearchAction =
  | { type: "field"; field: "goal" | "audience" | "exclusions"; value: string }
  | { type: "scope"; field: "region" | "window"; value: string }
  | { type: "source"; id: string; checked: boolean }
  | { type: "row-edit"; kind: "questions" | "steps"; id: string; value: string }
  | { type: "row-add"; kind: "questions" | "steps" }
  | { type: "row-remove"; kind: "questions" | "steps"; id: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "review" }
  | { type: "start" }
  | { type: "advance" }
  | { type: "stop" }
  | { type: "back" }
  | { type: "recover" }
const edited = (state: ResearchState, brief: Brief): ResearchState => ({
  ...state,
  brief,
  errors: {},
  reviewed: false,
})
export function researchTransition(
  state: ResearchState,
  action: ResearchAction,
): ResearchState {
  if (action.type === "recover") return { ...state, data: "ready" }
  if (action.type === "back")
    return state.run?.status !== "running" ? { ...state, run: null } : state
  if (action.type === "advance") {
    if (state.run?.status !== "running" || !state.canEdit) return state
    const completed = state.run.completed + 1
    return {
      ...state,
      run: {
        ...state.run,
        completed,
        status:
          completed >= state.run.snapshot.steps.length
            ? "completed"
            : "running",
      },
    }
  }
  if (action.type === "stop")
    return state.run?.status === "running" && state.canEdit
      ? { ...state, run: { ...state.run, status: "cancelled" } }
      : state
  if (action.type === "review") {
    const errors = validateBrief(state.brief)
    return {
      ...state,
      planOpen: true,
      errors,
      reviewed: Object.keys(errors).length === 0,
    }
  }
  if (
    !state.canEdit ||
    state.data === "loading" ||
    state.run?.status === "running"
  )
    return state
  if (action.type === "start") {
    const errors = validateBrief(state.brief)
    return Object.keys(errors).length
      ? { ...state, errors, planOpen: true }
      : {
          ...state,
          errors: {},
          reviewed: true,
          planOpen: true,
          run: {
            status: "running",
            completed: 0,
            snapshot: structuredClone(state.brief),
          },
        }
  }
  const b = state.brief
  if (action.type === "field")
    return edited(state, { ...b, [action.field]: action.value })
  if (action.type === "scope") {
    const options = action.field === "region" ? regions : windows
    return options.some((o) => o.id === action.value)
      ? edited(state, { ...b, [action.field]: action.value })
      : state
  }
  if (action.type === "source") {
    if (!sourceTypes.some((s) => s.id === action.id)) return state
    const sources = action.checked
      ? [...new Set([...b.sources, action.id])]
      : b.sources.filter((id) => id !== action.id)
    return edited(state, { ...b, sources })
  }
  if (action.type === "row-add") {
    const kind = action.kind
    if (b[kind].length >= 20) return state
    return {
      ...edited(state, {
        ...b,
        [kind]: [
          ...b[kind],
          {
            id: (kind === "questions" ? "question-" : "step-") + state.nextId,
            value: "",
          },
        ],
      }),
      nextId: state.nextId + 1,
    }
  }
  if (action.type === "row-edit")
    return edited(state, {
      ...b,
      [action.kind]: b[action.kind].map((row) =>
        row.id === action.id ? { ...row, value: action.value } : row,
      ),
    })
  if (action.type === "row-remove")
    return edited(state, {
      ...b,
      [action.kind]: b[action.kind].filter((row) => row.id !== action.id),
    })
  if (action.type === "move") {
    const index = b.steps.findIndex((row) => row.id === action.id),
      target = index + action.direction
    if (index < 0 || target < 0 || target >= b.steps.length) return state
    const steps = [...b.steps]
    ;[steps[index], steps[target]] = [steps[target], steps[index]]
    return edited(state, { ...b, steps })
  }
  return state
}
export function exportBrief(state: ResearchState, locale: string): string {
  const brief = state.run?.snapshot ?? state.brief
  const t = (v: DraftText) => text(v, locale)
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  return [
    label("# 本地研究简报", "# Local research brief"),
    t(brief.goal),
    "",
    label("受众: ", "Audience: ") + t(brief.audience),
    label("范围: ", "Scope: ") +
      t(regions.find((r) => r.id === brief.region)!.label) +
      " · " +
      t(windows.find((w) => w.id === brief.window)!.label),
    label("允许来源: ", "Allowed sources: ") +
      sourceTypes
        .filter((s) => brief.sources.includes(s.id))
        .map((s) => t(s.label))
        .join(" · "),
    "",
    label("## 研究问题", "## Research questions"),
    ...brief.questions.map((r, i) => i + 1 + ". " + t(r.value)),
    "",
    label("## 研究计划", "## Research plan"),
    ...brief.steps.map((r, i) => i + 1 + ". " + t(r.value)),
    "",
    label("排除: ", "Exclude: ") + t(brief.exclusions),
    "",
    label(
      "仅本地演示；未检索或验证外部证据。",
      "Local demonstration only; no external evidence retrieved or verified.",
    ),
  ].join("\n")
}
