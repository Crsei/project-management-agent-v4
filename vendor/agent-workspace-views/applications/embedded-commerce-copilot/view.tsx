"use client"

import { useId, useLayoutEffect, useRef } from "react"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@easyuse-ui/ui/components/ui/menu"
import {
  ArrowDownLeft,
  ArrowDownToLine,
  Box,
  Check,
  ChevronRight,
  ClipboardCheck,
  FileText,
  MapPin,
  Monitor,
  ShieldCheck,
  Truck,
  Undo2,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Checkbox } from "@easyuse-ui/ui/components/ui/checkbox"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@easyuse-ui/ui/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@easyuse-ui/ui/components/ui/sheet"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@easyuse-ui/ui/components/ui/tooltip"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import type { Copy } from "../../model"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import {
  RemainingPageStateProvider,
  useRemainingPageState,
} from "../../showcase/state"
import {
  commerceTransition,
  createCommerceState,
  exportCommerceOrder,
  reviewedCount,
  reviewFingerprint,
  type CommerceAction,
} from "./controller"
import { copy, policySections } from "./fixtures"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

function CommerceView({ scenario, active, host }: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const noteErrorId = useId()
  const replyErrorId = useId()
  const applyReasonId = useId()
  const text = (value: string | Copy) =>
    typeof value === "string" ? value : value[locale]
  const [state, setState] = useRemainingPageState(
    "embedded-commerce-copilot:" + scenario,
    () => createCommerceState(scenario),
  )
  const reader = useRef<HTMLDivElement>(null)
  const copilot = useRef<HTMLElement>(null)
  const evidence = useRef<HTMLElement>(null)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const replyInput = useRef<HTMLTextAreaElement>(null)
  const order = state.orders.find((row) => row.id === state.selectedId)
  const draft = state.drafts[state.selectedId]
  const dispatch = (action: CommerceAction) =>
    setState((previous) => commerceTransition(previous, action))
  const disabled = state.readonly || state.dataState !== "ready"
  const positions = state.scroll[state.selectedId]
  useLayoutEffect(() => {
    if (reader.current) reader.current.scrollTop = positions?.reader ?? 0
    if (copilot.current) copilot.current.scrollTop = positions?.copilot ?? 0
  }, [
    state.selectedId,
    positions?.reader,
    positions?.copilot,
    locale,
    host.resolvedTheme,
  ])
  const exportOrder = () => {
    const content = exportCommerceOrder(state)
    if (!content || !order) return
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = "sample-order-" + order.id + ".json"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    dispatch({
      type: "feedback",
      value: copy(
        "已导出当前本地订单与审阅草稿。",
        "Exported the current local order and review draft.",
      ),
    })
  }
  return (
    <section className={styles.page}
    data-commerce-copilot
    data-remaining-page="embedded-commerce-copilot"
    data-active={active} ><header className={styles.header}>
      <span>
        <ClipboardCheck aria-hidden="true" />
        {label("商务 / 订单工作区", "Commerce / Order workspace")}
      </span>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={label("切换主题", "Toggle theme")}
                  />
                }
              />
            }
          >
            <Monitor aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{label("切换主题", "Toggle theme")}</TooltipContent>
        </Tooltip>
        <MenuContent align="end">
          <MenuItem onClick={() => host.setTheme("light")}>
            {label("浅色", "Light")}
          </MenuItem>
          <MenuItem onClick={() => host.setTheme("dark")}>
            {label("深色", "Dark")}
          </MenuItem>
          <MenuItem onClick={() => host.setTheme("system")}>
            {label("跟随系统", "System")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </header>
    <div className={styles.orderBar}>
      <div
        role="group"
        aria-label={label("选择订单", "Select order")}
        className={styles.orderChoices}
      >
        {state.orders.map((row) => (
          <Button
            key={row.id}
            variant="ghost"
            className={styles.orderChoice}
            aria-pressed={row.id === state.selectedId}
            disabled={state.dataState === "loading"}
            onClick={() => dispatch({ type: "select", id: row.id })}
          >
            <strong>#{row.id}</strong>
            <span>{row.customer}</span>
          </Button>
        ))}
      </div>
      <span>
        {label("示例订单 · 仅本地更改", "Sample orders · local changes only")}
      </span>
    </div>
    {state.dataState === "loading" ? (
      <div className={styles.loading} aria-busy="true">
        <div>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton className={styles.skeleton} key={index} />
          ))}
        </div>
        <p>
          {label("示例订单尚未加载。", "Sample orders have not loaded yet.")}
        </p>
        <Button
          variant="secondary"
          onClick={() => dispatch({ type: "load" })}
        >
          {label("加载示例订单", "Load sample orders")}
        </Button>
      </div>
    ) : !order || !draft ? (
      <div className={styles.empty}>
        <Box aria-hidden="true" />
        <h1>{label("暂无示例订单", "No sample orders")}</h1>
        <p>
          {label(
            "加载本地示例以查看订单上下文与审阅建议。",
            "Load local samples to view order context and review suggestions.",
          )}
        </p>
        <Button onClick={() => dispatch({ type: "load" })}>
          {label("加载示例订单", "Load sample orders")}
        </Button>
      </div>
    ) : (
      <>
        {state.dataState === "refresh-error" && (
          <div role="alert" className={styles.dataNotice}>
            <span>
              {label(
                "示例刷新失败，保留上次记录与草稿。完成本地重新加载后可应用更改。",
                "Sample refresh failed. Previous records and drafts were retained. Reload local samples before applying changes.",
              )}
            </span>
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: "load" })}
            >
              {label("重试本地加载", "Retry local load")}
            </Button>
          </div>
        )}
        <div className={styles.workbench}>
          <div
            ref={reader}
            className={styles.reader}
            aria-label={label("订单详情阅读区", "Order detail reader")}
            onScroll={(event) =>
              dispatch({
                type: "scroll",
                pane: "reader",
                value: event.currentTarget.scrollTop,
              })
            }
          >
            <div className={styles.orderContent}>
              <header className={styles.orderHeader}>
                <p className={styles.breadcrumb}>
                  {label("订单", "Orders")}
                  <ChevronRight aria-hidden="true" />
                  {label("订单详情", "Order detail")}
                </p>
                <div className={styles.titleRow}>
                  <h1>
                    {label("订单", "Order")} #{order.id}
                  </h1>
                  <span className={styles.status} data-status={order.status}>
                    {order.status === "delayed"
                      ? label("延误", "Delayed")
                      : order.status === "address-check"
                        ? label("地址核验", "Address check")
                        : label("已送达", "Delivered")}
                  </span>
                  <span className={styles.priority}>
                    {order.priority === "high"
                      ? label("高优先级", "High priority")
                      : label("普通优先级", "Normal priority")}
                  </span>
                </div>
                <p className={styles.metadata}>
                  {label("下单于 ", "Placed ")}
                  {order.placed[locale]} ·{" "}
                  {label("线上商店 · 已付款", "Online store · Paid")}
                </p>
              </header>
              <section
                className={styles.exception}
                aria-label={label("订单异常", "Order exception")}
              >
                <span
                  className={styles.exceptionIcon}
                  data-status={order.status}
                >
                  <Truck aria-hidden="true" />
                </span>
                <div>
                  <h2>{order.exception[locale]}</h2>
                  <p>{order.exceptionDetail[locale]}</p>
                </div>
              </section>
              <section
                className={styles.items}
                aria-label={label("订单商品", "Order items")}
              >
                <div className={styles.sectionHeader}>
                  <h2>{label("商品", "Items")}</h2>
                  <span>
                    {order.items.reduce(
                      (total, item) => total + item.quantity,
                      0,
                    )}{" "}
                    {label("件", "units")}
                  </span>
                </div>
                <ul className={styles.itemList}>
                  {order.items.map((item) => (
                    <li key={item.id}>
                      <Item
                        className={styles.itemRow}
                        leading={
                          <span className={styles.itemIcon}>
                            <Box aria-hidden="true" />
                          </span>
                        }
                        title={item.title[locale]}
                        description={
                          item.variant[locale] +
                          " · " +
                          label("数量 ", "Qty ") +
                          item.quantity
                        }
                        trailing={
                          <span className={styles.price}>
                            ${item.price.toFixed(2)}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
                <div className={styles.total}>
                  <span>{label("已付总额", "Total paid")}</span>
                  <strong>
                    $
                    {order.items
                      .reduce((total, item) => total + item.price, 0)
                      .toFixed(2)}
                  </strong>
                </div>
              </section>
              <section
                className={styles.customer}
                aria-label={label("客户与配送", "Customer and delivery")}
              >
                <div>
                  <h2>{label("客户", "Customer")}</h2>
                  <div className={styles.customerIdentity}>
                    <span className={styles.avatar}>{order.initials}</span>
                    <div>
                      <p>{order.customer}</p>
                      <p className={styles.metadata}>{order.email}</p>
                    </div>
                  </div>
                </div>
                <div>
                  <h2>{label("收货目的地", "Delivery destination")}</h2>
                  <p className={styles.destination}>
                    <MapPin aria-hidden="true" />
                    {order.destination}
                  </p>
                  <p className={styles.metadata}>
                    {order.addressDetail[locale]}
                  </p>
                </div>
              </section>
              <section
                ref={evidence}
                tabIndex={-1}
                className={styles.timeline}
                aria-label={label("物流证据", "Shipment evidence")}
              >
                <div className={styles.sectionHeader}>
                  <h2>{label("物流时间线", "Shipment timeline")}</h2>
                  <span className={styles.source}>
                    {label("来源 S1", "Source S1")}
                  </span>
                </div>
                <ol>
                  {order.events.map((event, index) => (
                    <li key={index}>
                      <span className={styles.eventDot} aria-hidden="true" />
                      <div>
                        <h3>{event.title[locale]}</h3>
                        <p>{event.detail[locale]}</p>
                        <p className={styles.eventTime}>{event.at[locale]}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
              <section
                className={styles.notes}
                aria-label={label("订单内部备注", "Internal order notes")}
              >
                <div className={styles.notesHeader}>
                  <h2>
                    {label("内部备注", "Internal notes")}{" "}
                    <span>{order.notes.length}</span>
                  </h2>
                  <span>
                    {label("客户不可见", "Not visible to the customer")}
                  </span>
                </div>
                <ul>
                  {order.notes.map((note) => (
                    <li key={note.id}>
                      <strong>{note.author[locale]}</strong>
                      <p>{text(note.text)}</p>
                    </li>
                  ))}
                </ul>
              </section>
              {order.replyDraft !== null && (
                <section
                  className={styles.savedDraft}
                  aria-label={label("已保存的回复草稿", "Saved reply draft")}
                >
                  <div className={styles.notesHeader}>
                    <h2>{label("客户回复草稿", "Customer reply draft")}</h2>
                    <span>{label("未发送", "Not sent")}</span>
                  </div>
                  <p>{text(order.replyDraft)}</p>
                </section>
              )}
            </div>
          </div>
          <aside
            ref={copilot}
            className={styles.copilot}
            aria-label={label("嵌入式商务助手", "Embedded commerce copilot")}
            onScroll={(event) =>
              dispatch({
                type: "scroll",
                pane: "copilot",
                value: event.currentTarget.scrollTop,
              })
            }
          >
            <div className={styles.copilotHeader}>
              <h2>
                <ClipboardCheck aria-hidden="true" />
                {label("订单助手", "Order copilot")}
              </h2>
              <span>
                {label("基于示例的分析", "Grounded sample analysis")}
              </span>
            </div>
            <div className={styles.copilotBody}>
              <div className={styles.context}>
                <span className={styles.contextDot} aria-hidden="true" />
                <span>{label("当前上下文", "Working with")}</span>
                <strong>
                  {label("订单", "Order")} #{order.id}
                </strong>
                <span className={styles.revision}>rev {order.revision}</span>
              </div>
              <div className={styles.analysis}>
                <p>{order.analysis[locale]}</p>
                <p>{order.recommendation[locale]}</p>
                <div className={styles.citations}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (!evidence.current || !reader.current) return
                      reader.current.scrollTo({
                        top:
                          evidence.current.offsetTop -
                          reader.current.offsetTop -
                          20,
                      })
                      evidence.current.focus({ preventScroll: true })
                    }}
                  >
                    <ArrowDownLeft aria-hidden="true" />
                    {label("物流事件", "Shipment events")}
                    <span>S1</span>
                  </Button>
                  <Sheet>
                    <SheetTrigger
                      render={<Button variant="secondary" size="sm" />}
                    >
                      <FileText aria-hidden="true" />
                      {label("客服政策", "Support policy")}
                      <span>P1</span>
                    </SheetTrigger>
                    <SheetContent size={352}>
                      <SheetHeader>
                        <SheetTitle>
                          {label("客户更新政策", "Customer update policy")}
                        </SheetTitle>
                        <SheetDescription>
                          {label(
                            "来源 P1 · 编写的示例政策 · 适用于订单",
                            "Source P1 · Authored sample policy · Applies to order",
                          )}{" "}
                          #{order.id}
                        </SheetDescription>
                      </SheetHeader>
                      <SheetBody className={styles.policyBody}>
                        {policySections.map((section, index) => (
                          <section
                            className={
                              index === 3 ? styles.policyBoundary : undefined
                            }
                            key={section.title.en}
                          >
                            <h3>{section.title[locale]}</h3>
                            <p>{section.text[locale]}</p>
                          </section>
                        ))}
                      </SheetBody>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>
              <form
                className={styles.proposals}
                aria-label={label("审阅订单更改", "Review order changes")}
                onSubmit={(event) => {
                  event.preventDefault()
                  dispatch({ type: "apply" })
                  if (draft.included.note && !text(draft.note).trim())
                    noteInput.current?.focus()
                  else if (draft.included.reply && !text(draft.reply).trim())
                    replyInput.current?.focus()
                }}
              >
                <div className={styles.proposalHeader}>
                  <h3>{label("建议更改", "Proposed changes")}</h3>
                  <span>
                    {reviewedCount(draft)} {label("项已选择", "selected")}
                  </span>
                </div>
                <div className={styles.proposalFields}>
                  <div>
                    <label className={styles.fieldLabel}>
                      <Checkbox
                        aria-labelledby={applyReasonId + "-note-label"}
                        checked={draft.included.note}
                        disabled={disabled}
                        onCheckedChange={(value) =>
                          dispatch({ type: "include", field: "note", value })
                        }
                      />
                      <span id={applyReasonId + "-note-label"}>{label("添加内部备注", "Add internal note")}</span>
                    </label>
                    <Textarea
                      ref={noteInput}
                      className={styles.noteInput}
                      aria-label={label(
                        "建议的内部备注",
                        "Proposed internal note",
                      )}
                      value={text(draft.note)}
                      disabled={disabled}
                      aria-invalid={Boolean(state.errors.note)}
                      aria-describedby={
                        state.errors.note ? noteErrorId : undefined
                      }
                      onChange={(event) =>
                        dispatch({
                          type: "edit",
                          field: "note",
                          value: event.currentTarget.value,
                        })
                      }
                    />
                    {state.errors.note && (
                      <p
                        id={noteErrorId}
                        className={styles.fieldError}
                        role="alert"
                      >
                        {state.errors.note[locale]}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>
                      <Checkbox
                        aria-labelledby={applyReasonId + "-reply-label"}
                        aria-describedby={applyReasonId + "-reply-effect"}
                        checked={draft.included.reply}
                        disabled={disabled}
                        onCheckedChange={(value) =>
                          dispatch({ type: "include", field: "reply", value })
                        }
                      />
                      <span id={applyReasonId + "-reply-label"}>{label("保存回复草稿", "Save reply draft")}</span>
                      <span id={applyReasonId + "-reply-effect"}>{label("不会发送", "Does not send")}</span>
                    </label>
                    <Textarea
                      ref={replyInput}
                      className={styles.replyInput}
                      aria-label={label(
                        "建议的客户回复",
                        "Proposed customer reply",
                      )}
                      value={text(draft.reply)}
                      disabled={disabled}
                      aria-invalid={Boolean(state.errors.reply)}
                      aria-describedby={
                        state.errors.reply ? replyErrorId : undefined
                      }
                      onChange={(event) =>
                        dispatch({
                          type: "edit",
                          field: "reply",
                          value: event.currentTarget.value,
                        })
                      }
                    />
                    {state.errors.reply && (
                      <p
                        id={replyErrorId}
                        className={styles.fieldError}
                        role="alert"
                      >
                        {state.errors.reply[locale]}
                      </p>
                    )}
                  </div>
                  <div className={styles.priorityField}>
                    <label className={styles.fieldLabel}>
                      <Checkbox
                        aria-labelledby={applyReasonId + "-priority-label"}
                        checked={draft.included.priority}
                        disabled={disabled}
                        onCheckedChange={(value) =>
                          dispatch({
                            type: "include",
                            field: "priority",
                            value,
                          })
                        }
                      />
                      <span id={applyReasonId + "-priority-label"}>{label("设置优先级", "Set priority")}</span>
                    </label>
                    <Select
                      value={draft.priority}
                      disabled={disabled}
                      onValueChange={(value) => {
                        if (value === "normal" || value === "high")
                          dispatch({ type: "priority", value })
                      }}
                    >
                      <SelectTrigger
                        aria-label={label(
                          "建议的订单优先级",
                          "Proposed order priority",
                        )}
                      >
                        {draft.priority === "high"
                          ? label("高", "High")
                          : label("普通", "Normal")}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">
                          {label("普通", "Normal")}
                        </SelectItem>
                        <SelectItem value="high">
                          {label("高", "High")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className={styles.applyArea}>
                  <Button
                    type="submit"
                    className={styles.applyButton}
                    disabled={
                      disabled ||
                      reviewedCount(draft) === 0 ||
                      reviewFingerprint(draft) === draft.appliedFingerprint
                    }
                    aria-describedby={
                      disabled ||
                      !reviewedCount(draft) ||
                      reviewFingerprint(draft) === draft.appliedFingerprint
                        ? applyReasonId
                        : undefined
                    }
                  >
                    <Check aria-hidden="true" />
                    {label(
                      "应用 " + reviewedCount(draft) + " 项已审阅更改",
                      "Apply " + reviewedCount(draft) + " reviewed changes",
                    )}
                  </Button>
                </div>
              </form>
              <p
                id={applyReasonId}
                className={
                  disabled ||
                  !reviewedCount(draft) ||
                  reviewFingerprint(draft) === draft.appliedFingerprint
                    ? styles.disabledReason
                    : styles.srOnly
                }
              >
                {state.readonly
                  ? label(
                      "只读场景：可以查看与导出，不能编辑或应用更改。",
                      "Read-only scenario: view and export are available; edits and application are disabled.",
                    )
                  : state.dataState !== "ready"
                    ? label(
                        "重新加载本地记录后可应用更改。",
                        "Reload local records before applying changes.",
                      )
                    : !reviewedCount(draft)
                      ? label(
                          "请选择至少一项要审阅的更改。",
                          "Select at least one reviewed change.",
                        )
                      : label(
                          "当前已审阅的更改已应用。编辑草稿后可再次应用。",
                          "The current reviewed changes have already been applied. Edit the draft to apply new changes.",
                        )}
              </p>
              {state.feedback && (
                <div className={styles.feedback} role="status">
                  <p>{state.feedback[locale]}</p>
                </div>
              )}
              {state.undo[order.id] && (
                <Button
                  variant="secondary"
                  onClick={() => dispatch({ type: "undo" })}
                  disabled={disabled}
                >
                  <Undo2 aria-hidden="true" />
                  {label("撤销本地更改", "Undo local changes")}
                </Button>
              )}
              <div className={styles.boundary}>
                <ShieldCheck aria-hidden="true" />
                <p>
                  {label(
                    "应用前请审阅每个字段。更改只保存在当前浏览器会话中，不会修改外部系统中的订单、物流或消息。",
                    "Review every field before applying. Changes are stored in this browser session; no orders, shipments or messages are changed in an external system.",
                  )}
                </p>
              </div>
              <Button
                variant="secondary"
                className={styles.exportButton}
                onClick={exportOrder}
              >
                <ArrowDownToLine aria-hidden="true" />
                {label("导出此订单", "Export this order")}
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </aside>
        </div>
      </>
    )}</section>
  )
}

export function RemainingPageView(props: RemainingPageProps) {
  return (
    <RemainingPageStateProvider cache={props.cache}>
      <CommerceView key={props.scenario} {...props} />
    </RemainingPageStateProvider>
  )
}
