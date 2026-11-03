import { useId, useMemo, useState } from "react"
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical } from "lucide-react"
import type { Entity } from "@contracts"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-provider"
import { itemDates, itemStatus, itemTitle, statusLabel, workItemStatuses } from "./service-collection-shared"
import styles from "./service-collections.module.css"
import { RadixSelect } from "@/components/ui/radix-select"

type BoardProps = {
  items: Entity[]
  onOpen: (item: Entity) => void
  onMove: (item: Entity, state: string) => void
  canMove: (item: Entity, state: string) => boolean
  pending?: boolean
}

function BoardCard({ item, states, onOpen, onMove, canMove, pending, selected, onSelect }: Omit<BoardProps, "items"> & {
  item: Entity; states: string[]; selected: boolean; onSelect: () => void
}) {
  const { locale } = useI18n()
  const en = locale === "en"
  const id = useId()
  const status = itemStatus(item)
  // Completion/submission are never generic board mutations (INV-04).
  const destinations = states.filter((state) => state !== status && state !== "done" && state !== "in_review" && canMove(item, state))
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id, data: { item }, disabled: pending || destinations.length === 0,
  })
  const dates = itemDates(item)
  return <article ref={setNodeRef} className={styles.card} data-selected={selected || undefined} style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.45 : 1 }} onFocus={onSelect}>
    <div className={styles.cardHeading}>
      <Button size="icon-sm" variant="ghost" {...attributes} {...listeners} disabled={pending || !destinations.length} aria-label={en ? `Move ${itemTitle(item)}` : `移动 ${itemTitle(item)}`} className={styles.dragHandle}><GripVertical size={16} aria-hidden="true" /></Button>
      <button type="button" className={styles.itemLink} onClick={() => { onSelect(); onOpen(item) }}>{itemTitle(item)}</button>
    </div>
    <p className={styles.hint}>{dates.start ?? "—"} → {dates.due ?? "—"}</p>
    <label htmlFor={id} className={styles.hint}>{en ? "Move to" : "移至"}</label>
    <RadixSelect id={id} value="" disabled={pending || !destinations.length} onChange={(event) => {
      const state = event.target.value
      if (destinations.includes(state) && !pending) onMove(item, state)
    }}>
      <option value="">{destinations.length ? (en ? "Choose state…" : "选择状态…") : (en ? "No available moves" : "无可用状态变更")}</option>
      {destinations.map((state) => <option key={state} value={state}>{statusLabel(state, locale)}</option>)}
    </RadixSelect>
  </article>
}

function BoardColumn({ state, items, activeItem, selectedId, onSelect, ...props }: BoardProps & {
  state: string; activeItem: Entity | undefined; selectedId: string; onSelect: (id: string) => void; states: string[]
}) {
  const { locale } = useI18n()
  const allowed = Boolean(activeItem && !props.pending && state !== "done" && state !== "in_review" && itemStatus(activeItem) !== state && props.canMove(activeItem, state))
  const { setNodeRef, isOver } = useDroppable({ id: `state:${state}`, data: { state }, disabled: !allowed })
  return <section ref={setNodeRef} className={styles.boardColumn} data-over={isOver && allowed || undefined} aria-label={statusLabel(state, locale)}>
    <h3 className={styles.columnHeading}>{statusLabel(state, locale)} <span className={styles.hint}>{items.length}</span></h3>
    <div className={styles.cardList}>{items.map((item) => <BoardCard key={item.id} item={item} {...props} selected={item.id === selectedId} onSelect={() => onSelect(item.id)} />)}</div>
    {!items.length && <p className={styles.emptyColumn}>{locale === "en" ? "No work items" : "暂无工作项"}</p>}
  </section>
}

export function ServiceBoard({ items, onOpen, onMove, canMove, pending = false }: BoardProps) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState("")
  const [notice, setNotice] = useState("")
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor))
  const states = useMemo(() => [...new Set<string>([...workItemStatuses, ...items.map(itemStatus)])], [items])
  const grouped = useMemo(() => {
    const groups = new Map(states.map((state) => [state, [] as Entity[]]))
    for (const item of items) groups.get(itemStatus(item))!.push(item)
    return groups
  }, [items, states])
  const activeItem = items.find((item) => item.id === activeId)
  function requestMove(item: Entity, state: string) {
    if (pending || state === "done" || state === "in_review" || state === itemStatus(item) || !canMove(item, state)) return
    onMove(item, state)
    setNotice(en ? "Move requested. Waiting for the authoritative server state." : "已请求移动，等待服务端权威状态。")
  }
  function finishDrag(event: DragEndEvent) {
    setActiveId(null)
    const item = items.find((entry) => entry.id === event.active.id)
    const state = event.over?.data.current?.state
    if (item && typeof state === "string") requestMove(item, state)
  }
  return <div className={styles.root} aria-busy={pending}>
    <p className={styles.hint}>{en ? "Drag a handle, or use Move to. Keyboard: Space to pick up, arrows to move, Space to drop, Escape to cancel. Submission and completion require the delivery workflow in details." : "拖动手柄或使用“移至”。键盘：空格拾取，方向键移动，空格放下，Esc 取消。提交审核及完成须在详情中完成交付流程。"}</p>
    {!items.length && <p className={styles.empty}>{en ? "No work items in this collection." : "此集合中暂无工作项。"}</p>}
    <DndContext sensors={sensors} onDragStart={({ active }) => { setActiveId(String(active.id)); setSelectedId(String(active.id)) }} onDragCancel={() => setActiveId(null)} onDragEnd={finishDrag} accessibility={{
      screenReaderInstructions: { draggable: en ? "Press Space to pick up. Use arrow keys to move, Space to drop, Escape to cancel. The Move to select is an alternative." : "按空格拾取，方向键移动，空格放下，Esc 取消。也可使用移至下拉框。" },
      announcements: {
        onDragStart: ({ active }) => {
          const item = items.find((entry) => entry.id === active.id)
          return en ? `Picked up ${item ? itemTitle(item) : active.id}` : `已拾取 ${item ? itemTitle(item) : active.id}`
        },
        onDragOver: ({ over }) => over ? statusLabel(String(over.data.current?.state), locale) : (en ? "Not over an available destination" : "未位于可用目标上"),
        onDragEnd: () => en ? "Drag ended; server confirmation is required." : "拖动结束；变更须服务端确认。",
        onDragCancel: () => en ? "Move cancelled." : "已取消移动。",
      },
    }}>
      <div className={styles.board}>{states.map((state) => <BoardColumn key={state} state={state} states={states} items={grouped.get(state)!} onOpen={onOpen} onMove={requestMove} canMove={canMove} pending={pending} activeItem={activeItem} selectedId={selectedId} onSelect={setSelectedId} />)}</div>
    </DndContext>
    <p className={styles.hint} role="status">{pending ? (en ? "Saving…" : "正在保存…") : notice}</p>
  </div>
}
