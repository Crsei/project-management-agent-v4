import type { Copy } from "../../model"

export const copy = (zh: string, en: string): Copy => ({ "zh-CN": zh, en })
export type CommerceItem = {
  id: string
  title: Copy
  variant: Copy
  quantity: number
  price: number
}
export type ShipmentEvent = { title: Copy; detail: Copy; at: Copy }
export type CommerceOrder = {
  id: string
  customer: string
  email: string
  initials: string
  destination: string
  placed: Copy
  status: "delayed" | "address-check" | "delivered"
  priority: "normal" | "high"
  exception: Copy
  exceptionDetail: Copy
  addressDetail: Copy
  items: CommerceItem[]
  events: ShipmentEvent[]
  notes: { id: string; author: Copy; text: string | Copy }[]
  replyDraft: string | Copy | null
  revision: number
  analysis: Copy
  recommendation: Copy
  reply: Copy
}

export function createOrders(): CommerceOrder[] {
  return [
    {
      id: "1048",
      customer: "Maya Chen",
      email: "maya.chen@example.com",
      initials: "MC",
      destination: "Portland, OR",
      placed: copy("2026 年 9 月 3 日", "September 3, 2026"),
      status: "delayed",
      priority: "normal",
      exception: copy("配送异常", "Delivery exception"),
      exceptionDetail: copy(
        "承运商报告分拣延误，尚未确认新的送达日期。",
        "Carrier reports a sorting delay. A revised delivery date has not been confirmed.",
      ),
      addressDetail: copy(
        "示例记录中的地址已核实",
        "Address verified in the sample record",
      ),
      items: [
        {
          id: "tote",
          title: copy("日常帆布托特包", "Everyday carry tote"),
          variant: copy("帆布 / 原色", "Canvas / Natural"),
          quantity: 1,
          price: 68,
        },
        {
          id: "notebook",
          title: copy("随行笔记本", "Field notebook"),
          variant: copy("A5 / 石板灰", "A5 / Slate"),
          quantity: 2,
          price: 24,
        },
      ],
      events: [
        {
          title: copy("配送异常", "Delivery exception"),
          detail: copy(
            "承运商报告分拣延误，尚未确认新的送达日期。",
            "Carrier reports a sorting delay. A revised delivery date has not been confirmed.",
          ),
          at: copy("9 月 7 日 · 09:12", "Sep 7 · 09:12"),
        },
        {
          title: copy("已离开发货中心", "Departed fulfillment center"),
          detail: copy(
            "两种商品装在同一包裹中。物流参考：DEMO-1048。",
            "Two items packed in one shipment. Tracking reference: DEMO-1048.",
          ),
          at: copy("9 月 5 日 · 16:40", "Sep 5 · 16:40"),
        },
        {
          title: copy("订单已确认", "Order confirmed"),
          detail: copy(
            "已收到付款。原预计送达日期：9 月 6 日。",
            "Payment received. Original estimated delivery: September 6.",
          ),
          at: copy("9 月 3 日 · 11:24", "Sep 3 · 11:24"),
        },
      ],
      notes: [
        {
          id: "initial-1048",
          author: copy("运营", "Operations"),
          text: copy(
            "客户希望在确认新的预计日期后收到更新。",
            "Customer requested an update when a revised estimate is available.",
          ),
        },
      ],
      replyDraft: null,
      revision: 0,
      analysis: copy(
        "此包裹已超过原预计送达时间，并发生承运商异常。尚未确认新的送达日期。",
        "The shipment missed its original estimate and has a carrier exception. There is no confirmed replacement delivery date.",
      ),
      recommendation: copy(
        "标记订单以便跟进，并准备说明延误的更新，不承诺送达日期。",
        "Flag the order for follow-up and prepare an update that acknowledges the delay without promising a delivery date.",
      ),
      reply: copy(
        "Maya 您好，您的订单 #1048 发生了承运商分拣延误。原预计送达日期已过，新的日期尚未确认。很抱歉造成延误，我们会在确认后提供新的预计日期。",
        "Hi Maya, your order #1048 has encountered a carrier sorting delay. The original delivery estimate has passed, and a revised date has not yet been confirmed. We’re sorry for the delay. We will share a new estimate once it is confirmed.",
      ),
    },
    {
      id: "1052",
      customer: "Alex Morgan",
      email: "alex.morgan@example.com",
      initials: "AM",
      destination: "Austin, TX",
      placed: copy("2026 年 9 月 5 日", "September 5, 2026"),
      status: "address-check",
      priority: "normal",
      exception: copy("地址需要确认", "Address needs confirmation"),
      exceptionDetail: copy(
        "收件地址缺少公寓或套房号，尚未购买运单。",
        "The shipping address is missing an apartment or suite number. No label has been purchased.",
      ),
      addressDetail: copy(
        "需要确认公寓或套房号",
        "Apartment or suite number needs confirmation",
      ),
      items: [
        {
          id: "organizer",
          title: copy("桌面收纳架", "Desk organizer"),
          variant: copy("胡桃木 / 大号", "Walnut / Large"),
          quantity: 1,
          price: 89,
        },
      ],
      events: [
        {
          title: copy("地址需要确认", "Address needs confirmation"),
          detail: copy(
            "收件地址缺少公寓或套房号，尚未购买运单。",
            "The shipping address is missing an apartment or suite number. No label has been purchased.",
          ),
          at: copy("9 月 7 日 · 08:05", "Sep 7 · 08:05"),
        },
        {
          title: copy("已收到付款", "Payment received"),
          detail: copy(
            "订单已打包，等待地址确认后再交给承运商。",
            "The order is packed and awaiting address confirmation before handoff.",
          ),
          at: copy("9 月 5 日 · 14:18", "Sep 5 · 14:18"),
        },
      ],
      notes: [
        {
          id: "initial-1052",
          author: copy("运营", "Operations"),
          text: copy(
            "在客户确认完整地址前暂缓发货。",
            "Hold shipment until the customer confirms the complete address.",
          ),
        },
      ],
      replyDraft: null,
      revision: 0,
      analysis: copy(
        "此订单已准备发货，但地址不完整。请客户确认比猜测缺失字段更安全。",
        "This order is ready to ship, but the address is incomplete. Asking the customer to confirm it is safer than guessing a missing field.",
      ),
      recommendation: copy(
        "准备地址确认回复并添加内部备注。暂不修改地址或购买运单。",
        "Prepare an address-confirmation reply and leave an internal note. Do not change the address or buy a label yet.",
      ),
      reply: copy(
        "Alex 您好，您的订单 #1052 已打包。发货前请确认完整的收件地址，包括公寓或套房号。目前尚未购买运单。",
        "Hi Alex, your order #1052 is packed and ready. Before we ship it, could you confirm the complete delivery address, including your apartment or suite number? We have not purchased a shipping label yet.",
      ),
    },
    {
      id: "1039",
      customer: "Sam Rivera",
      email: "sam.rivera@example.com",
      initials: "SR",
      destination: "Denver, CO",
      placed: copy("2026 年 9 月 1 日", "September 1, 2026"),
      status: "delivered",
      priority: "normal",
      exception: copy("已送达", "Delivered"),
      exceptionDetail: copy(
        "承运商标记包裹已送达前台。",
        "Carrier marked the shipment delivered at the front desk.",
      ),
      addressDetail: copy(
        "示例记录中的地址已核实",
        "Address verified in the sample record",
      ),
      items: [
        {
          id: "flask",
          title: copy("旅行水壶", "Travel flask"),
          variant: copy("750 毫升 / 森林绿", "750 ml / Forest"),
          quantity: 1,
          price: 42,
        },
        {
          id: "sleeve",
          title: copy("便携保护套", "Carry sleeve"),
          variant: copy("再生毛毡", "Recycled felt"),
          quantity: 1,
          price: 18,
        },
      ],
      events: [
        {
          title: copy("已送达", "Delivered"),
          detail: copy(
            "承运商标记包裹已送达前台。",
            "Carrier marked the shipment delivered at the front desk.",
          ),
          at: copy("9 月 6 日 · 13:26", "Sep 6 · 13:26"),
        },
        {
          title: copy("运输中", "In transit"),
          detail: copy(
            "承运商已收取包裹。物流参考：DEMO-1039。",
            "Package collected by the carrier. Tracking reference: DEMO-1039.",
          ),
          at: copy("9 月 3 日 · 10:11", "Sep 3 · 10:11"),
        },
      ],
      notes: [
        {
          id: "initial-1039",
          author: copy("运营", "Operations"),
          text: copy(
            "此订单没有待处理的客服请求。",
            "No support request is open for this order.",
          ),
        },
      ],
      replyDraft: null,
      revision: 0,
      analysis: copy(
        "承运商报告配送完成。此示例记录没有未解决的配送异常。",
        "The carrier reports a completed delivery. There is no open shipping exception in this sample record.",
      ),
      recommendation: copy(
        "保持普通优先级。跟进草稿可以引用送达扫描，但不能声称客户本人已收到包裹。",
        "Keep the order at normal priority. A follow-up draft can cite the delivery scan without claiming the customer personally received it.",
      ),
      reply: copy(
        "Sam 您好，承运商标记订单 #1039 已于 9 月 6 日送达前台。请先查看前台，如需要协助寻找包裹，请告知我们。",
        "Hi Sam, the carrier marked order #1039 delivered to the front desk on September 6. Please check there first and let us know if you need help locating the package.",
      ),
    },
  ]
}

export const policySections = [
  {
    title: copy("配送异常", "Shipping exceptions"),
    text: copy(
      "说明承运商延误，并标记订单以便跟进。承运商确认之前，不承诺新的送达日期。",
      "Acknowledge a carrier delay and flag the order for follow-up. Do not promise a replacement delivery date until the carrier has confirmed it.",
    ),
  },
  {
    title: copy("地址不完整", "Incomplete addresses"),
    text: copy(
      "请客户确认。不要推测公寓号，不要在确认前购买运单或放行包裹。",
      "Request confirmation from the customer. Do not infer an apartment number, purchase a label or release the shipment before confirmation.",
    ),
  },
  {
    title: copy("送达扫描", "Delivery scans"),
    text: copy(
      "准确描述承运商的扫描记录。送达扫描不能证明指定客户本人已收到包裹。",
      "Describe the carrier’s scan accurately. A delivery scan is not proof that the named customer personally received the package.",
    ),
  },
  {
    title: copy("人工审阅边界", "Human review boundary"),
    text: copy(
      "保存草稿不等于发送。本 Showcase 中的所有更改均为本地、可撤销。",
      "Saving a draft is not sending it. In this showcase, all changes are local and reversible.",
    ),
  },
]
