export type Copy = { "zh-CN": string; en: string }
export type Bounds = { x: number; y: number; width: number; height: number }
export type Note = { id: string; kind: "review" | "user" | "draft"; text: Copy }
export type Region = {
  id: string
  number: number
  title: Copy
  resolved: boolean
  bounds: Bounds
  notes: Note[]
  draft: string
}
export type ReviewImage = {
  id: string
  name: Copy
  src: string
  width: number
  height: number
  regions: Region[]
}
export const regionFixtures: Region[] = [
  {
    id: "region-1",
    number: 1,
    title: { "zh-CN": "让订单状态可操作", en: "Make order status actionable" },
    resolved: false,
    bounds: { x: 3, y: 1, width: 56, height: 12 },
    draft: "",
    notes: [
      {
        id: "note-1",
        kind: "review",
        text: {
          "zh-CN": "保持记录本身为主。助手应解释异常，而不是替代订单详情。",
          en: "Keep the record itself primary. The assistant should explain the exception, not replace the order details.",
        },
      },
    ],
  },
  {
    id: "region-2",
    number: 2,
    title: {
      "zh-CN": "让商品明细易于浏览",
      en: "Keep line items easy to scan",
    },
    resolved: false,
    bounds: { x: 3, y: 69, width: 66, height: 28 },
    notes: [],
    draft: "",
  },
  {
    id: "region-3",
    number: 3,
    title: {
      "zh-CN": "让客户上下文保持就近",
      en: "Keep customer context close",
    },
    resolved: true,
    bounds: { x: 74, y: 57, width: 24, height: 29 },
    notes: [],
    draft: "",
  },
]
export const regionSuggestions: Copy[] = [
  {
    "zh-CN":
      "把订单状态与下一步操作放在同一区域；保留异常说明和完整的订单记录。",
    en: "Keep the order status and its next action together, while preserving the exception explanation and the full order record.",
  },
  {
    "zh-CN": "将数量、单价、税额与小计对齐，保证长商品名称不会挤掉金额。",
    en: "Align quantity, rate, tax, and subtotal. Ensure long product names do not displace the amounts.",
  },
  {
    "zh-CN": "让客户身份与联系方式保持就近，并明确区分联系操作和订单操作。",
    en: "Keep customer identity and contact details nearby, and distinguish contact actions from order actions.",
  },
]
