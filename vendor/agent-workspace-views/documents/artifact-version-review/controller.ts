import {
  artifactVersions,
  initialMessages,
  artifactFile,
  type ArtifactVersion,
} from "./fixtures.ts"
import type { Copy } from "../../model.ts"

export type ReviewMessage = { id: string; role: "user" | "agent"; text: Copy }
export type ReviewState = {
  versions: ArtifactVersion[]
  selected: number
  from: number
  tab: "preview" | "compare"
  changesOnly: boolean
  activeChange: number
  open: boolean
  draft: string
  messages: ReviewMessage[]
  data: "loading" | "empty" | "error" | "ready"
  readonly: boolean
  conversationWidth: number | null
}
export type ArtifactChange = {
  id: string
  title: Copy
  before?: Copy
  after?: Copy
  kind: "changed" | "added" | "removed" | "unchanged"
}
export function createReviewState(scenario: string): ReviewState {
  return {
    versions:
      scenario === "empty" || scenario === "loading"
        ? []
        : artifactVersions(scenario === "long-content"),
    selected: 3,
    from: 2,
    tab: "compare",
    changesOnly: true,
    activeChange: -1,
    open: true,
    draft: "",
    messages:
      scenario === "empty" || scenario === "loading" ? [] : initialMessages,
    data:
      scenario === "loading"
        ? "loading"
        : scenario === "empty"
          ? "empty"
          : scenario === "refresh-error"
            ? "error"
            : "ready",
    readonly: scenario === "readonly",
    conversationWidth: null,
  }
}
export function getVersion(state: ReviewState, id: number) {
  return state.versions.find((version) => version.id === id)
}
export function compareVersions(
  before: ArtifactVersion,
  after: ArtifactVersion,
): ArtifactChange[] {
  const blocks = (version: ArtifactVersion) => [
    {
      id: "title",
      title: { "zh-CN": "标题", en: "Title" },
      body: version.title,
    },
    {
      id: "subtitle",
      title: { "zh-CN": "副标题", en: "Subtitle" },
      body: version.subtitle,
    },
    ...version.sections,
  ]
  const old = blocks(before),
    next = blocks(after)
  const ids = [
    ...new Set([
      ...old.map((block) => block.id),
      ...next.map((block) => block.id),
    ]),
  ]
  return ids.map((id) => {
    const a = old.find((block) => block.id === id),
      b = next.find((block) => block.id === id)
    return {
      id,
      title: (b ?? a)!.title,
      before: a?.body,
      after: b?.body,
      kind: !a
        ? "added"
        : !b
          ? "removed"
          : a.body.en === b.body.en && a.body["zh-CN"] === b.body["zh-CN"]
            ? "unchanged"
            : "changed",
    }
  })
}
export function selectVersion(state: ReviewState, id: number): ReviewState {
  if (!getVersion(state, id)) return state
  const latest = state.versions.at(-1)
  const from =
    id !== latest?.id
      ? (latest?.id ?? id)
      : (state.versions.filter((version) => version.id !== id).at(-1)?.id ?? id)
  return { ...state, selected: id, from, activeChange: -1 }
}
export function loadVersions(
  state: ReviewState,
  scenario: string,
): ReviewState {
  return {
    ...state,
    versions: state.versions.length
      ? state.versions
      : artifactVersions(scenario === "long-content"),
    messages: state.messages.length ? state.messages : initialMessages,
    data: "ready",
  }
}
export function restoreVersion(state: ReviewState, id: number): ReviewState {
  const version = getVersion(state, id),
    latest = state.versions.at(-1)
  if (state.readonly || !version || !latest || version.id === latest.id)
    return state
  const restored: ArtifactVersion = {
    ...version,
    id: latest.id + 1,
    restoredFrom: version.id,
    reason: { "zh-CN": `从 v${id} 恢复`, en: `Restored from v${id}` },
  }
  return {
    ...state,
    versions: [...state.versions, restored],
    selected: restored.id,
    from: latest.id,
    tab: "preview",
    activeChange: -1,
    messages: [
      ...state.messages,
      {
        id: `restore-${restored.id}`,
        role: "agent",
        text: {
          "zh-CN": `已在本次会话中将 v${id} 的内容恢复为新版本 v${restored.id}。之前的所有版本均已保留。`,
          en: `Restored the content of v${id} as new version v${restored.id} in this session. All previous versions are preserved.`,
        },
      },
    ],
  }
}
export function askAboutVersions(
  state: ReviewState,
  question: string,
  locale: "en" | "zh-CN",
  intent: "explain" | "impact" | "question" = "question",
): ReviewState {
  const text = question.trim(),
    before = getVersion(state, state.from),
    after = getVersion(state, state.selected)
  if (!text || !before || !after || state.data === "loading") return state
  const changes = compareVersions(before, after).filter(
    (change) => change.kind !== "unchanged",
  )
  const removed = changes.filter((change) => change.kind === "removed")
  const summary = changes.length
    ? changes.map((change) => `${change.title.en} (${change.kind})`).join(", ")
    : "no content changes"
  const summaryZh = changes.length
    ? changes
        .map(
          (change) =>
            `${change.title["zh-CN"]}（${change.kind === "removed" ? "删除" : change.kind === "added" ? "新增" : "修改"}）`,
        )
        .join("、")
    : "没有内容变化"
  const impact =
    intent === "impact" || /restore|recover|bring back|恢复|回退/i.test(text)
  const latest = state.versions.at(-1)!
  const restoreTarget = after.id === latest.id ? before : after
  const restoredSections = compareVersions(latest, restoreTarget).filter(
    (change) => change.kind === "added",
  )
  const answer: Copy = impact
    ? {
        en: `Restoring v${restoreTarget.id} would bring back its full document, including ${restoredSections.length ? restoredSections.map((change) => change.title.en).join(", ") : "its earlier wording"}. It would create v${latest.id + 1} without deleting v${latest.id}. Select the saved version, review its preview, and use Restore as v${latest.id + 1} to confirm; asking this question does not restore anything.`,
        "zh-CN": `恢复 v${restoreTarget.id} 会带回该版本的完整文档，包括${restoredSections.length ? restoredSections.map((change) => change.title["zh-CN"]).join("、") : "之前的表述"}。恢复会建立 v${latest.id + 1}，不删除 v${latest.id}。请选择已保存版本、审阅预览，再选择“恢复为 v${latest.id + 1}”并确认；提问本身不会恢复内容。`,
      }
    : {
        en: `Comparing v${before.id} → v${after.id}: ${changes.length} changes — ${summary}. ${removed.length ? "The removed safeguard should be reviewed before sharing. " : "Review the changed sections before sharing. "}This answer is based only on the saved versions in this session, not a live model.`,
        "zh-CN": `比较 v${before.id} → v${after.id}：${changes.length} 处变化——${summaryZh}。${removed.length ? "分享前应审阅删除的保护措施。" : "分享前请审阅修改的章节。"}此回答仅基于本次会话中保存的版本，不使用实时模型。`,
      }
  const id = state.messages.length
  return {
    ...state,
    draft: "",
    messages: [
      ...state.messages,
      {
        id: `question-${id}`,
        role: "user",
        text: { en: locale === "en" ? text : question, "zh-CN": text },
      },
      { id: `answer-${id}`, role: "agent", text: answer },
    ],
  }
}
export function versionMarkdown(
  version: ArtifactVersion,
  locale: "en" | "zh-CN",
) {
  return `# ${version.title[locale]}\n\n${version.subtitle[locale]}\n\n${version.sections.map((section) => `## ${section.title[locale]}\n\n${section.body[locale]}`).join("\n\n")}\n\n<!-- ${artifactFile} · Version ${version.id} -->\n`
}
export type DiffWord = { text: string; changed: boolean }
/** Section-local LCS: matching words remain readable; no code-diff model is invented. */
export function wordDifference(
  before: string,
  after: string,
): { before: DiffWord[]; after: DiffWord[] } {
  const split = (text: string) => text.match(/\S+\s*/g) ?? []
  const a = split(before),
    b = split(after)
  if (a.length > 512 || b.length > 512)
    return {
      before: [{ text: before, changed: before !== after }],
      after: [{ text: after, changed: before !== after }],
    }
  const table = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i].trim() === b[j].trim()
          ? 1 + table[i + 1][j + 1]
          : Math.max(table[i + 1][j], table[i][j + 1])
  const left = a.map((text) => ({ text, changed: true })),
    right = b.map((text) => ({ text, changed: true }))
  let i = 0,
    j = 0
  while (i < a.length && j < b.length) {
    if (a[i].trim() === b[j].trim()) {
      left[i].changed = false
      right[j].changed = false
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return { before: left, after: right }
}
