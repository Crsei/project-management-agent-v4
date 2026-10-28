import type { Copy } from "../../model"
import { copy, createOrders, type CommerceOrder } from "./fixtures.ts"

export type ReviewField = "note" | "reply" | "priority"
export type ReviewDraft = {
  note: string | Copy
  reply: string | Copy
  priority: "normal" | "high"
  included: Record<ReviewField, boolean>
  appliedFingerprint: string | null
}
export type CommerceState = {
  scenario: string
  orders: CommerceOrder[]
  selectedId: string
  drafts: Record<string, ReviewDraft>
  dataState: "ready" | "empty" | "loading" | "refresh-error"
  readonly: boolean
  errors: Partial<Record<"note" | "reply", Copy>>
  feedback: Copy | null
  undo: Record<string, CommerceOrder>
  scroll: Partial<Record<string, { reader: number; copilot: number }>>
}
export function createReviewDraft(order: CommerceOrder): ReviewDraft {
  return {
    note: copy(
      order.analysis["zh-CN"] + " " + order.recommendation["zh-CN"],
      order.analysis.en + " " + order.recommendation.en,
    ),
    reply: order.reply,
    priority: order.status === "delayed" ? "high" : "normal",
    included: { note: true, reply: true, priority: order.status === "delayed" },
    appliedFingerprint: null,
  }
}
export function createCommerceState(scenario: string): CommerceState {
  const orders = scenario === "empty" ? [] : createOrders()
  if (scenario === "long-content") {
    orders[0].notes.push(
      ...Array.from({ length: 16 }, (_, index) => ({
        id: "history-" + index,
        author: copy("运营", "Operations"),
        text: copy(
          "跟进记录 " +
            (index + 1) +
            "：继续等待承运商确认，保留所有已知物流证据，不承诺新的送达日期。",
          "Follow-up record " +
            (index + 1) +
            ": Await carrier confirmation, retain all known shipping evidence, and do not promise a revised delivery date.",
        ),
      })),
    )
    orders[0].items[0].title = copy(
      "日常帆布托特包 · 自然原色限量款，含可拆卸内袋与加固手柄",
      "Everyday carry tote · Limited natural canvas edition with removable interior pouch and reinforced handles",
    )
  }
  return {
    scenario,
    orders,
    selectedId: orders[0]?.id ?? "",
    drafts: Object.fromEntries(
      orders.map((order) => [order.id, createReviewDraft(order)]),
    ),
    dataState:
      scenario === "loading"
        ? "loading"
        : scenario === "empty"
          ? "empty"
          : scenario === "refresh-error"
            ? "refresh-error"
            : "ready",
    readonly: scenario === "readonly",
    errors: {},
    feedback: null,
    undo: {},
    scroll: {},
  }
}
export const reviewedCount = (draft: ReviewDraft) =>
  Object.values(draft.included).filter(Boolean).length
export function reviewFingerprint(draft: ReviewDraft) {
  return JSON.stringify({
    included: draft.included,
    note: draft.included.note ? draft.note : null,
    reply: draft.included.reply ? draft.reply : null,
    priority: draft.included.priority ? draft.priority : null,
  })
}
const hasText = (value: string | Copy) =>
  typeof value === "string"
    ? Boolean(value.trim())
    : Boolean(value.en.trim() && value["zh-CN"].trim())
export function validateReview(draft: ReviewDraft): CommerceState["errors"] {
  const errors: CommerceState["errors"] = {}
  if (draft.included.note && !hasText(draft.note))
    errors.note = copy(
      "请输入内部备注，或取消勾选该项。",
      "Enter an internal note, or exclude this change.",
    )
  if (draft.included.reply && !hasText(draft.reply))
    errors.reply = copy(
      "请输入回复草稿，或取消勾选该项。",
      "Enter a reply draft, or exclude this change.",
    )
  return errors
}
export type CommerceAction =
  | { type: "select"; id: string }
  | { type: "edit"; field: "note" | "reply"; value: string }
  | { type: "include"; field: ReviewField; value: boolean }
  | { type: "priority"; value: "normal" | "high" }
  | { type: "apply" }
  | { type: "undo" }
  | { type: "load" }
  | { type: "scroll"; pane: "reader" | "copilot"; value: number }
  | { type: "feedback"; value: Copy }
export function commerceTransition(
  state: CommerceState,
  action: CommerceAction,
): CommerceState {
  if (action.type === "load") {
    if (state.dataState === "ready") return state
    if (state.orders.length)
      return { ...state, dataState: "ready", feedback: null }
    const loaded = createCommerceState("default")
    return {
      ...state,
      orders: loaded.orders,
      drafts: loaded.drafts,
      selectedId: loaded.selectedId,
      dataState: "ready",
      feedback: null,
    }
  }
  if (action.type === "select")
    return state.orders.some((order) => order.id === action.id)
      ? { ...state, selectedId: action.id, errors: {}, feedback: null }
      : state
  if (action.type === "scroll")
    return {
      ...state,
      scroll: {
        ...state.scroll,
        [state.selectedId]: {
          ...(state.scroll[state.selectedId] ?? { reader: 0, copilot: 0 }),
          [action.pane]: Math.max(0, action.value),
        },
      },
    }
  if (action.type === "feedback") return { ...state, feedback: action.value }
  if (state.readonly || state.dataState !== "ready") return state
  const draft = state.drafts[state.selectedId]
  const order = state.orders.find((order) => order.id === state.selectedId)
  if (!draft || !order) return state
  if (
    action.type === "edit" ||
    action.type === "include" ||
    action.type === "priority"
  ) {
    const next =
      action.type === "edit"
        ? { ...draft, [action.field]: action.value }
        : action.type === "include"
          ? {
              ...draft,
              included: { ...draft.included, [action.field]: action.value },
            }
          : { ...draft, priority: action.value }
    return {
      ...state,
      drafts: { ...state.drafts, [order.id]: next },
      errors: {},
      feedback: null,
    }
  }
  if (action.type === "undo") {
    const previous = state.undo[order.id]
    if (!previous) return state
    const undo = { ...state.undo }
    delete undo[order.id]
    return {
      ...state,
      orders: state.orders.map((row) => (row.id === order.id ? previous : row)),
      drafts: {
        ...state.drafts,
        [order.id]: { ...draft, appliedFingerprint: null },
      },
      undo,
      feedback: copy(
        "已撤销最近一次本地应用，草稿保留。",
        "Undid the latest local application. Review drafts were retained.",
      ),
    }
  }
  const errors = validateReview(draft)
  if (Object.keys(errors).length) return { ...state, errors, feedback: null }
  const fingerprint = reviewFingerprint(draft)
  if (!reviewedCount(draft) || fingerprint === draft.appliedFingerprint)
    return state
  const updated: CommerceOrder = {
    ...order,
    revision: order.revision + 1,
    notes: draft.included.note
      ? [
          ...order.notes,
          {
            id: "local-" + order.id + "-" + (order.revision + 1),
            author: copy("已审阅的 Copilot 备注", "Reviewed copilot note"),
            text: draft.note,
          },
        ]
      : order.notes,
    replyDraft: draft.included.reply ? draft.reply : order.replyDraft,
    priority: draft.included.priority ? draft.priority : order.priority,
  }
  return {
    ...state,
    orders: state.orders.map((row) => (row.id === order.id ? updated : row)),
    drafts: {
      ...state.drafts,
      [order.id]: { ...draft, appliedFingerprint: fingerprint },
    },
    undo: { ...state.undo, [order.id]: order },
    errors: {},
    feedback: copy(
      "已应用 " + reviewedCount(draft) + " 项本地更改。回复仍为草稿，未发送。",
      "Applied " +
        reviewedCount(draft) +
        " local changes. The reply remains a draft and was not sent.",
    ),
  }
}
export function exportCommerceOrder(state: CommerceState) {
  const order = state.orders.find((row) => row.id === state.selectedId)
  return order
    ? JSON.stringify(
        {
          source: "local-fixture",
          externalChanges: false,
          order: {
            ...order,
            analysis: undefined,
            recommendation: undefined,
            reply: undefined,
          },
          review: state.drafts[order.id],
        },
        null,
        2,
      )
    : null
}
