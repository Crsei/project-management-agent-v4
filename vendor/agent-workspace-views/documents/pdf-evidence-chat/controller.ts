import {
  initialQuestion,
  passages,
  reportPages,
  type AnswerKind,
  type Copy,
} from "./fixtures.ts"
const orderedPassages = reportPages.flatMap((page) =>
  page.passageIds.map((id) => passages.find((passage) => passage.id === id)!),
)

export type EvidenceMessage = {
  id: string
  role: "user" | "agent"
  text?: string | Copy
  answer?: AnswerKind
}
export type EvidenceState = {
  page: number
  pageInput: string
  selectedId: string | null
  selectionRevision: number
  readerOpen: boolean
  readerFraction: number
  zoom: "fit" | "75" | "100" | "125" | "150"
  draft: string
  draftSelection: { start: number; end: number }
  messages: EvidenceMessage[]
  searchOpen: boolean
  search: string
  searchIndex: number
  outlineOpen: boolean
  sourcesOpen: string | null
  positions: Record<number, { top: number; left: number }>
  chatPosition: number
  dataState: "ready" | "empty" | "loading" | "refresh-error"
  readonly: boolean
  nextMessage: number
}
export type EvidenceAction =
  | { type: "draft"; value: string }
  | { type: "draft-selection"; start: number; end: number }
  | { type: "select"; id: string }
  | { type: "page"; page: number }
  | { type: "page-input"; value: string }
  | { type: "reader"; open: boolean }
  | { type: "resize"; fraction: number }
  | { type: "zoom"; zoom: EvidenceState["zoom"] }
  | { type: "search-toggle" }
  | { type: "search"; value: string; locale: "zh-CN" | "en" }
  | { type: "search-step"; delta: number; locale: "zh-CN" | "en" }
  | { type: "outline"; open: boolean }
  | { type: "sources"; messageId: string | null }
  | { type: "clear-highlight" }
  | { type: "reader-position"; top: number; left: number }
  | { type: "chat-position"; top: number }
  | { type: "load" }
  | { type: "send"; text?: string }

export function createEvidenceState(scenario: string): EvidenceState {
  const messages: EvidenceMessage[] =
    scenario === "empty" || scenario === "loading"
      ? []
      : [
          { id: "question-0", role: "user", text: initialQuestion },
          { id: "answer-0", role: "agent", answer: "handoffs" },
        ]
  if (scenario === "long-content") {
    for (let index = 1; index <= 10; index++) {
      const limitations = index % 2 === 1
      messages.push(
        {
          id: `question-${index}`,
          role: "user",
          text: limitations
            ? {
                "zh-CN": "这些发现有哪些局限？",
                en: "What are the limitations of these findings?",
              }
            : {
                "zh-CN": "我们应该怎样开展试点？",
                en: "How should we run the pilot?",
              },
        },
        {
          id: `answer-${index}`,
          role: "agent",
          answer: limitations ? "limitations" : "pilot",
        },
      )
    }
  }
  return {
    page: 2,
    pageInput: "2",
    selectedId: "setup",
    readerOpen: true,
    readerFraction: 0.6,
    zoom: "fit",
    draft: "",
    draftSelection: { start: 0, end: 0 },
    messages,
    searchOpen: false,
    search: "",
    searchIndex: 0,
    outlineOpen: false,
    sourcesOpen: null,
    positions: {},
    chatPosition: 0,
    selectionRevision: 0,
    dataState:
      scenario === "empty"
        ? "empty"
        : scenario === "loading"
          ? "loading"
          : scenario === "refresh-error"
            ? "refresh-error"
            : "ready",
    readonly: scenario === "readonly",
    nextMessage: scenario === "long-content" ? 11 : 1,
  }
}

/** Search operates on the same accessible passage text rendered in the reader. */
export function searchEvidence(query: string, locale: "zh-CN" | "en") {
  const normalized = query.trim().toLocaleLowerCase(locale)
  if (!normalized) return []
  return orderedPassages.filter((passage) =>
    `${passage.title[locale]} ${passage.text[locale]}`
      .toLocaleLowerCase(locale)
      .includes(normalized),
  )
}

export function reduceEvidence(
  state: EvidenceState,
  action: EvidenceAction,
): EvidenceState {
  switch (action.type) {
    case "draft":
      return { ...state, draft: action.value }
    case "draft-selection":
      return {
        ...state,
        draftSelection: { start: action.start, end: action.end },
      }
    case "select": {
      const passage = passages.find((candidate) => candidate.id === action.id)
      if (
        !passage ||
        state.dataState === "loading" ||
        state.dataState === "empty"
      )
        return state
      return {
        ...state,
        page: passage.page,
        pageInput: String(passage.page),
        selectedId: passage.id,
        selectionRevision: state.selectionRevision + 1,
        readerOpen: true,
        outlineOpen: false,
        sourcesOpen: null,
      }
    }
    case "page": {
      if (
        !Number.isInteger(action.page) ||
        !reportPages.some((page) => page.number === action.page)
      )
        return state
      return {
        ...state,
        page: action.page,
        pageInput: String(action.page),
        selectedId: null,
        outlineOpen: false,
      }
    }
    case "page-input":
      return { ...state, pageInput: action.value }
    case "reader":
      return {
        ...state,
        readerOpen: action.open,
        outlineOpen: false,
        sourcesOpen: null,
      }
    case "resize":
      return Number.isFinite(action.fraction)
        ? {
            ...state,
            readerFraction: Math.min(0.76, Math.max(0.32, action.fraction)),
          }
        : state
    case "zoom":
      return { ...state, zoom: action.zoom }
    case "search-toggle":
      return { ...state, searchOpen: !state.searchOpen, outlineOpen: false }
    case "search": {
      const matches = searchEvidence(action.value, action.locale)
      const first = matches[0]
      return {
        ...state,
        search: action.value,
        searchIndex: 0,
        ...(first
          ? {
              page: first.page,
              pageInput: String(first.page),
              selectedId: first.id,
              selectionRevision: state.selectionRevision + 1,
            }
          : {}),
      }
    }
    case "search-step": {
      const matches = searchEvidence(state.search, action.locale)
      if (!matches.length) return state
      const index =
        (((state.searchIndex + action.delta) % matches.length) +
          matches.length) %
        matches.length
      const passage = matches[index]
      return {
        ...state,
        searchIndex: index,
        page: passage.page,
        pageInput: String(passage.page),
        selectedId: passage.id,
        selectionRevision: state.selectionRevision + 1,
      }
    }
    case "outline":
      return { ...state, outlineOpen: action.open }
    case "sources":
      return { ...state, sourcesOpen: action.messageId }
    case "clear-highlight":
      return { ...state, selectedId: null }
    case "reader-position":
      return {
        ...state,
        positions: {
          ...state.positions,
          [state.page]: { top: action.top, left: action.left },
        },
      }
    case "chat-position":
      return { ...state, chatPosition: action.top }
    case "load":
      return { ...state, dataState: "ready" }
    case "send": {
      const text = (action.text ?? state.draft).trim()
      if (
        !text ||
        state.readonly ||
        state.dataState === "loading" ||
        state.dataState === "empty"
      )
        return state
      const lower = text.toLowerCase()
      const answer: AnswerKind =
        /limitation|sample|confidence|局限|样本|限制/.test(lower)
          ? "limitations"
          : /pilot|plan|checklist|试点|计划|清单/.test(lower)
            ? "pilot"
            : /handoff|first|setup|invite|import|team|首次|阻碍|配置|邀请|导入|团队/.test(
                  lower,
                )
              ? "handoffs"
              : "scope"
      return {
        ...state,
        draft: "",
        draftSelection: { start: 0, end: 0 },
        nextMessage: state.nextMessage + 1,
        messages: [
          ...state.messages,
          { id: `question-${state.nextMessage}`, role: "user", text },
          { id: `answer-${state.nextMessage}`, role: "agent", answer },
        ],
      }
    }
  }
}

/** Generates the actual downloadable three-page English fixture, without external media or services. */
export function researchPdf(): string {
  const objects: string[] = []
  objects.push("<< /Type /Catalog /Pages 2 0 R >>")
  objects.push("<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>")
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const escape = (value: string) =>
    value.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1")
  for (const page of reportPages) {
    const lines = [page.title.en, page.subtitle.en, ""]
    for (const id of page.passageIds) {
      const passage = passages.find((candidate) => candidate.id === id)!
      lines.push(passage.title.en)
      let line = ""
      for (const word of passage.text.en.split(" ")) {
        if (`${line} ${word}`.length > 88) {
          lines.push(line)
          line = word
        } else line += `${line ? " " : ""}${word}`
      }
      if (line) lines.push(line)
      lines.push("")
    }
    lines.push(`First-week research - page ${page.number} of 3 - Local fixture`)
    const stream =
      "BT\n/F1 11 Tf\n15 TL\n54 738 Td\n" +
      lines
        .map((line, index) => `${index ? "T*\n" : ""}(${escape(line)}) Tj`)
        .join("\n") +
      "\nET"
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let output = "%PDF-1.4\n"
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(output.length)
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = output.length
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return output
}
