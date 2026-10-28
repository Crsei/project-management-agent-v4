import { libraryDocuments, type LibraryDocument, type Localized } from "./fixtures.ts"

export type LibraryFilter = "all" | "read" | "unread" | "starred"
export type ReaderPanel = "notes" | "highlights"
export type LibraryNote = { id: string; text: string; documentId: string }
export type LibraryAnswer = {
  id: string
  documentId: string
  sourcePage: number
  question: string | Localized
  kind: "answer" | "explanation" | "document-change"
  sectionIndex: number | null
  paragraphIndex: number
  found: boolean
}
export type KnowledgeState = {
  documents: LibraryDocument[]
  selectedId: string | null
  query: string
  filter: LibraryFilter
  panel: ReaderPanel
  starred: string[]
  highlighted: string[]
  notes: LibraryNote[]
  noteDrafts: Record<string, string>
  questionDrafts: Record<string, string>
  answers: LibraryAnswer[]
  citationId: string | null
  dataState: "ready" | "loading" | "refresh-error"
  readonly: boolean
  sequence: number
}

export function createKnowledgeState(scenario: string): KnowledgeState {
  const documents = scenario === "empty" ? [] : libraryDocuments.map((document) => ({
    ...document,
    sections: scenario === "long-content"
      ? [...document.sections, ...Array.from({ length: 12 }, (_, index) => ({
          title: { "zh-CN": `附录 ${index + 1}：审计与记录`, en: `Appendix ${index + 1}: Audit and records` },
          paragraphs: [document.sections[index % document.sections.length].paragraphs[0]],
          keywords: [],
        }))]
      : document.sections,
  }))
  return {
    documents,
    selectedId: documents[0]?.id ?? null,
    query: "",
    filter: "all",
    panel: "notes",
    starred: documents.filter((document) => document.starred).map((document) => document.id),
    highlighted: [],
    notes: [],
    noteDrafts: {},
    questionDrafts: {},
    answers: [],
    citationId: null,
    dataState: scenario === "loading" ? "loading" : scenario === "refresh-error" ? "refresh-error" : "ready",
    readonly: scenario === "readonly",
    sequence: 0,
  }
}

export function libraryCounts(state: KnowledgeState) {
  return {
    all: state.documents.length,
    read: state.documents.filter((document) => document.page === document.pages).length,
    unread: state.documents.filter((document) => document.page < document.pages).length,
    starred: state.documents.filter((document) => state.starred.includes(document.id)).length,
  }
}

export function filterLibrary(state: KnowledgeState) {
  const query = state.query.trim().toLocaleLowerCase()
  return state.documents.filter((document) => {
    if (state.filter === "read" && document.page < document.pages) return false
    if (state.filter === "unread" && document.page === document.pages) return false
    if (state.filter === "starred" && !state.starred.includes(document.id)) return false
    const searchText = [...Object.values(document.title), ...Object.values(document.source), ...Object.values(document.author)].join(" ").toLocaleLowerCase()
    return !query || searchText.includes(query)
  })
}

export function selectDocument(state: KnowledgeState, id: string): KnowledgeState {
  const selected = state.documents.find((document) => document.id === id)
  if (!selected || (state.selectedId === id && selected.page === selected.pages)) return state
  const changed = state.selectedId !== id
  return {
    ...state,
    selectedId: id,
    documents: state.documents.map((document) => document.id === id ? { ...document, page: document.pages, minutes: 0 } : document),
    citationId: null,
    sequence: state.sequence + Number(changed),
    answers: changed ? [...state.answers, {
      id: `library-message-${state.sequence + 1}`,
      documentId: id,
      sourcePage: selected.pages,
      question: "",
      kind: "document-change",
      paragraphIndex: 0,
      sectionIndex: null,
      found: true,
    }] : state.answers,
  }
}

export function toggleDocumentStar(state: KnowledgeState, id: string): KnowledgeState {
  if (state.readonly || !state.documents.some((document) => document.id === id)) return state
  return { ...state, starred: state.starred.includes(id) ? state.starred.filter((value) => value !== id) : [...state.starred, id] }
}

export function togglePassageHighlight(state: KnowledgeState): KnowledgeState {
  if (state.readonly || !state.selectedId) return state
  const id = state.selectedId
  return { ...state, highlighted: state.highlighted.includes(id) ? state.highlighted.filter((value) => value !== id) : [...state.highlighted, id], panel: "highlights" }
}

export function addDocumentNote(state: KnowledgeState): KnowledgeState {
  const id = state.selectedId
  const text = id ? state.noteDrafts[id]?.trim() : ""
  if (state.readonly || !id || !text) return state
  return {
    ...state,
    sequence: state.sequence + 1,
    notes: [...state.notes, { id: `library-note-${state.sequence + 1}`, documentId: id, text }],
    noteDrafts: { ...state.noteDrafts, [id]: "" },
    panel: "notes",
  }
}

export function removeDocumentNote(state: KnowledgeState, id: string): KnowledgeState {
  if (state.readonly) return state
  return { ...state, notes: state.notes.filter((note) => note.id !== id) }
}

export function answerDocumentQuestion(state: KnowledgeState, question: string | Localized, explain = false): KnowledgeState {
  const document = state.documents.find((item) => item.id === state.selectedId)
  const text = typeof question === "string" ? question.trim() : question.en
  if (!document || !text || state.dataState === "loading") return state
  const normalized = text.toLocaleLowerCase()
  const matchingIndex = document.sections.findIndex((section) => section.keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase())))
  const passageMatch = document.keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase()))
  const terms = Array.from(normalized.matchAll(/[\p{L}\p{N}]{3,}/gu), ([term]) => term.length >= 4 ? term.replace(/(?:ies|y|s)$/u, "") : term)
  const paragraphIndex = matchingIndex < 0 ? 0 : document.sections[matchingIndex].paragraphs
    .map((paragraph, index) => ({ index, score: terms.reduce((score, term) => score + Number(Object.values(paragraph).some((value) => value.toLocaleLowerCase().includes(term))), 0) }))
    .sort((a, b) => b.score - a.score)[0].index
  return {
    ...state,
    sequence: state.sequence + 1,
    questionDrafts: { ...state.questionDrafts, [document.id]: "" },
    answers: [...state.answers, {
      id: `library-message-${state.sequence + 1}`,
      documentId: document.id,
      sourcePage: document.page,
      question,
      kind: explain ? "explanation" : "answer",
      sectionIndex: explain || passageMatch ? null : matchingIndex < 0 ? null : matchingIndex,
      paragraphIndex,
      found: explain || passageMatch || matchingIndex >= 0,
    }],
  }
}

export function answerQuote(answer: LibraryAnswer, document: LibraryDocument): Localized {
  return answer.sectionIndex === null ? document.passage : document.sections[answer.sectionIndex].paragraphs[answer.paragraphIndex]
}

export function documentCitation(document: LibraryDocument, locale: "zh-CN" | "en") {
  return `${document.author[locale]}. (${document.month[locale]}). ${document.title[locale]}. ${document.source[locale]}, ${locale === "en" ? "p." : "第"} ${document.page}${locale === "en" ? "" : " 页"}.`
}

export function recoverLibrary(state: KnowledgeState): KnowledgeState {
  return { ...state, dataState: "ready" }
}
