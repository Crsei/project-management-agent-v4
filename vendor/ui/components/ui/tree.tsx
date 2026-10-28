"use client"
import { uiMessage } from "../../lib/i18n-core"
import { useUiFeedback } from "../../lib/i18n-provider"
import { useI18n } from "../../lib/i18n-provider"

import {
  useId,
  useMemo,
  useRef,
  useState,
  useEffect,
  type CSSProperties,
  type ReactNode,
} from "react"
import { ChevronRight, Folder, GripVertical } from "lucide-react"
import { Button } from "./button"
import { RuntimeStatusBadge } from "./runtime-status-badge"
import { DataRegion } from "./data-region"
import type { DataState } from "../../lib/runtime-status"
import { cn } from "../../lib/utils"
import styles from "./tree.module.css"

export type TreeNode = {
  id: string
  label: string
  icon?: ReactNode
  metadata?: string
  status?: string
  disabled?: boolean
  children?: TreeNode[]
  hasChildren?: boolean
  childrenState?: DataState
  childrenError?: string
}
export type TreeMove = {
  sourceId: string
  targetId: string
  position: "before" | "inside" | "after"
}
export type TreeProps = {
  nodes: TreeNode[]
  label: string
  selectedId?: string
  onSelect?: (node: TreeNode) => void
  onActivate?: (node: TreeNode) => void
  expandedIds?: string[]
  defaultExpandedIds?: string[]
  onExpandedChange?: (ids: string[]) => void
  onLoadChildren?: (node: TreeNode) => void
  onMove?: (move: TreeMove) => void
  canMove?: (move: TreeMove) => boolean
  className?: string
}
function flatten(
  nodes: TreeNode[],
  parentId?: string,
): { node: TreeNode; parentId?: string }[] {
  return nodes.flatMap((node) => [
    { node, parentId },
    ...flatten(node.children ?? [], node.id),
  ])
}
function isWithin(nodes: TreeNode[], sourceId: string, targetId: string) {
  const source = flatten(nodes).find(
    (entry) => entry.node.id === sourceId,
  )?.node
  return (
    sourceId === targetId ||
    flatten(source?.children ?? []).some((entry) => entry.node.id === targetId)
  )
}
/** Immutable adapter for local/controlled trees. The application owns persistence. */
export function moveTreeNode(nodes: TreeNode[], move: TreeMove): TreeNode[] {
  const all = flatten(nodes)
  const source = all.find((entry) => entry.node.id === move.sourceId)?.node
  const target = all.find((entry) => entry.node.id === move.targetId)?.node
  if (
    !source ||
    !target ||
    source.disabled ||
    target.disabled ||
    isWithin(nodes, source.id, target.id)
  )
    return nodes
  const remove = (list: TreeNode[]): TreeNode[] =>
    list
      .filter((node) => node.id !== source.id)
      .map((node) => ({
        ...node,
        ...(node.children && { children: remove(node.children) }),
      }))
  const insert = (list: TreeNode[]): TreeNode[] =>
    list.flatMap((node) => {
      if (node.id === target.id) {
        if (move.position === "inside")
          return [{ ...node, children: [...(node.children ?? []), source] }]
        return move.position === "before" ? [source, node] : [node, source]
      }
      return [
        { ...node, ...(node.children && { children: insert(node.children) }) },
      ]
    })
  return insert(remove(nodes))
}

export function Tree({
  nodes,
  label,
  selectedId,
  onSelect,
  onActivate,
  expandedIds,
  defaultExpandedIds = [],
  onExpandedChange,
  onLoadChildren,
  onMove,
  canMove,
  className,
}: TreeProps) {
  const { t } = useI18n()

  const id = useId()
  const root = useRef<HTMLUListElement>(null)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const [localExpanded, setLocalExpanded] = useState(defaultExpandedIds)
  const expanded = expandedIds ?? localExpanded
  const [focused, setFocused] = useState<string>()
  const [dragged, setDragged] = useState<string>()
  const [drop, setDrop] = useState<TreeMove>()
  const [targetId, setTargetId] = useState("")
  const [position, setPosition] = useState<TreeMove["position"]>("inside")
  const [announcement, setAnnouncement] = useUiFeedback("")
  const prefix = useRef({ text: "", time: 0 })
  const all = useMemo(() => flatten(nodes), [nodes])
  const visible: TreeNode[] = []
  function visit(list: TreeNode[]) {
    list.forEach((node) => {
      visible.push(node)
      if (expanded.includes(node.id)) visit(node.children ?? [])
    })
  }
  visit(nodes)
  let activeId = focused
  while (activeId && !visible.some((node) => node.id === activeId))
    activeId = all.find((entry) => entry.node.id === activeId)?.parentId
  activeId ??= visible[0]?.id

  useEffect(() => {
    if (
      focused &&
      activeId !== focused &&
      root.current?.contains(document.activeElement)
    )
      refs.current.get(activeId ?? "")?.focus()
  }, [activeId, focused])

  function focus(nodeId?: string) {
    if (nodeId) refs.current.get(nodeId)?.focus()
  }
  function toggle(node: TreeNode, open = !expanded.includes(node.id)) {
    if (node.disabled) return
    const next = open
      ? [...new Set([...expanded, node.id])]
      : expanded.filter((value) => value !== node.id)
    if (expandedIds === undefined) setLocalExpanded(next)
    onExpandedChange?.(next)
    if (!open && focused && isWithin(nodes, node.id, focused)) focus(node.id)
    if (open && node.hasChildren && !node.children?.length)
      onLoadChildren?.(node)
  }
  function valid(move: TreeMove) {
    return Boolean(
      onMove &&
      all.some(
        (entry) => entry.node.id === move.sourceId && !entry.node.disabled,
      ) &&
      all.some(
        (entry) => entry.node.id === move.targetId && !entry.node.disabled,
      ) &&
      !isWithin(nodes, move.sourceId, move.targetId) &&
      (canMove?.(move) ?? true),
    )
  }
  function requestMove(move: TreeMove) {
    if (!valid(move)) {
      setAnnouncement(uiMessage("tree.cannotMoveToItselfADescendantOrA"))
      return
    }
    onMove?.(move)
    setAnnouncement(
      uiMessage("tree.nodeMoveRequestedTheCallerConfirmsTheResult"),
    )
    setDragged(undefined)
    setDrop(undefined)
  }
  function render(list: TreeNode[], depth: number): ReactNode {
    return list.map((node, index) => {
      const branch = node.children !== undefined || node.hasChildren
      const open = expanded.includes(node.id)
      const childrenState =
        node.childrenState ?? (node.children?.length ? "success" : "empty")
      const move = drop?.targetId === node.id ? drop.position : undefined
      return (
        <li
          key={node.id}
          ref={(element) => {
            if (element) refs.current.set(node.id, element)
            else refs.current.delete(node.id)
          }}
          role="treeitem"
          aria-label={node.label}
          aria-level={depth + 1}
          aria-posinset={index + 1}
          aria-setsize={list.length}
          aria-expanded={branch ? open : undefined}
          aria-selected={onSelect ? selectedId === node.id : undefined}
          aria-disabled={node.disabled || undefined}
          tabIndex={activeId === node.id ? 0 : -1}
          className={styles.node}
          data-node-id={node.id}
          data-selected={selectedId === node.id}
          data-dragging={dragged === node.id}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocused(node.id)
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            const current = visible.findIndex((entry) => entry.id === node.id)
            if (event.key === "ArrowDown") focus(visible[current + 1]?.id)
            else if (event.key === "ArrowUp") focus(visible[current - 1]?.id)
            else if (event.key === "Home") focus(visible[0]?.id)
            else if (event.key === "End") focus(visible.at(-1)?.id)
            else if (event.key === "ArrowRight") {
              if (branch && !open) toggle(node, true)
              else if (open) focus(node.children?.[0]?.id)
            } else if (event.key === "ArrowLeft") {
              if (branch && open) toggle(node, false)
              else
                focus(all.find((entry) => entry.node.id === node.id)?.parentId)
            } else if (event.key === "Enter") {
              if (!node.disabled) (onActivate ?? onSelect)?.(node)
            } else if (event.key === " ") {
              if (!node.disabled) onSelect?.(node)
            } else if (event.key === "Escape") {
              setDragged(undefined)
              setDrop(undefined)
              setAnnouncement(uiMessage("tree.moveCancelled"))
            } else if (
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              const now = Date.now()
              prefix.current = {
                text:
                  now - prefix.current.time < 700
                    ? prefix.current.text + event.key.toLowerCase()
                    : event.key.toLowerCase(),
                time: now,
              }
              const ordered = [
                ...visible.slice(current + 1),
                ...visible.slice(0, current + 1),
              ]
              focus(
                ordered.find((entry) =>
                  entry.label.toLowerCase().startsWith(prefix.current.text),
                )?.id,
              )
            } else return
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <div
            className={styles.row}
            style={{ "--depth": depth } as CSSProperties}
            data-drop={move}
            data-disabled={Boolean(node.disabled)}
            draggable={Boolean(onMove && !node.disabled)}
            onClick={() => {
              focus(node.id)
              if (!node.disabled) onSelect?.(node)
            }}
            onDragStart={(event) => {
              event.stopPropagation()
              if (!onMove || node.disabled) {
                event.preventDefault()
                return
              }
              event.dataTransfer.setData("text/plain", node.id)
              event.dataTransfer.effectAllowed = "move"
              setDragged(node.id)
            }}
            onDragOver={(event) => {
              if (!dragged) return
              const bounds = event.currentTarget.getBoundingClientRect()
              const y = (event.clientY - bounds.top) / bounds.height
              const candidate: TreeMove = {
                sourceId: dragged,
                targetId: node.id,
                position: y < 0.25 ? "before" : y > 0.75 ? "after" : "inside",
              }
              if (valid(candidate)) {
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                setDrop(candidate)
              } else setDrop(undefined)
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setDrop(undefined)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (drop && drop.targetId === node.id) requestMove(drop)
            }}
            onDragEnd={() => {
              setDragged(undefined)
              setDrop(undefined)
            }}
          >
            {branch ? (
              <button
                type="button"
                tabIndex={-1}
                className={styles.chevron}
                aria-label={`${open ? t("common.collapse") : t("common.expand")} ${node.label}`}
                aria-expanded={open}
                aria-controls={`${id}-${node.id}-children`}
                disabled={node.disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  focus(node.id)
                  toggle(node)
                }}
              >
                <ChevronRight size={12} data-open={open} />
              </button>
            ) : (
              <span className={styles.leaf} />
            )}
            <span className={styles.icon}>
              {node.icon ?? <Folder size={16} />}
            </span>
            <span className={styles.title}>{node.label}</span>
            {node.metadata && (
              <span className={styles.metadata}>{node.metadata}</span>
            )}
            {node.status && (
              <span className={styles.status}>
                <RuntimeStatusBadge status={node.status} />
              </span>
            )}
            {onMove && !node.disabled && (
              <GripVertical
                size={16}
                className={styles.grip}
                aria-hidden="true"
              />
            )}
          </div>
          {branch && open && (
            <ul
              role="group"
              id={`${id}-${node.id}-children`}
              className={styles.group}
            >
              {render(node.children ?? [], depth + 1)}
              {childrenState !== "success" && (
                <li role="none" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
                  <DataRegion
                    state={childrenState}
                    hasContent={Boolean(node.children?.length)}
                    rowHeight={32}
                    emptyTitle={t("tree.noChildren")}
                    emptyDescription={t("tree.thisNodeHasNoChildrenYet")}
                    partialDescription={t("tree.someChildrenHaveNotLoadedYet")}
                    error={{
                      category: "request",
                      message: t("tree.couldNotLoadChildren"),
                      reason:
                        node.childrenError ?? t("tree.theCauseIsUnconfirmed"),
                    }}
                    onRetry={
                      onLoadChildren ? () => onLoadChildren(node) : undefined
                    }
                    onLoadMore={
                      onLoadChildren ? () => onLoadChildren(node) : undefined
                    }
                  />
                </li>
              )}
            </ul>
          )}
        </li>
      )
    })
  }
  const proposed =
    selectedId && targetId
      ? { sourceId: selectedId, targetId, position }
      : undefined
  return (
    <div className={cn(styles.tree, className)}>
      {nodes.length ? (
        <ul ref={root} role="tree" aria-label={label} className={styles.group}>
          {render(nodes, 0)}
        </ul>
      ) : (
        <DataRegion
          state="empty"
          emptyTitle={t("tree.noNodesInTheTree")}
          emptyDescription={t("tree.addNodesToViewTheirHierarchy")}
        />
      )}
      {onMove && (
        <form
          className={styles.move}
          aria-label={t("tree.moveNode")}
          onSubmit={(event) => {
            event.preventDefault()
            if (proposed) requestMove(proposed)
          }}
        >
          <span>
            {t("tree.move")}
            {all.find((entry) => entry.node.id === selectedId)?.node.label ??
              t("tree.selectANodeFirst")}
          </span>
          <label htmlFor={`${id}-target`}>{t("canvasWorkspace.target")}</label>
          <select
            id={`${id}-target`}
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">{t("tree.selectTarget")}</option>
            {all.map(({ node }) => (
              <option
                key={node.id}
                value={node.id}
                disabled={
                  node.disabled ||
                  (selectedId ? isWithin(nodes, selectedId, node.id) : false)
                }
              >
                {node.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-position`}>
            {t("nodeInspector.position")}
          </label>
          <select
            id={`${id}-position`}
            value={position}
            onChange={(event) =>
              setPosition(event.target.value as TreeMove["position"])
            }
          >
            <option value="inside">{t("tree.asChild")}</option>
            <option value="before">{t("tree.before")}</option>
            <option value="after">{t("tree.after")}</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            type="submit"
            disabled={!proposed || !valid(proposed)}
          >
            {t("tree.moveTo")}
          </Button>
        </form>
      )}
      <p className={styles.announcement} role="status">
        {announcement}
      </p>
    </div>
  )
}
