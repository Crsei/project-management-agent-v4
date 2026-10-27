import { useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, ChevronRight, Folder, ListTodo } from "lucide-react"
import type { Entity } from "@contracts"
import { useI18n } from "@/lib/i18n-provider"

type Props = { projects: Entity[]; items: Entity[]; onProject: (id: string) => void; onItem: (item: Entity) => void }
type TreeRow = { id: string; label: string; level: 1 | 2; project?: Entity; item?: Entity; parent?: string; expandable: boolean; expanded: boolean; count: number }
const title = (entity: Entity) => typeof entity.data.title === "string" ? entity.data.title : typeof entity.data.name === "string" ? entity.data.name : entity.id

export function ServiceProjectTree({ projects, items, onProject, onItem }: Props) {
  const { locale } = useI18n()
  const en = locale === "en"
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [focusedId, setFocusedId] = useState("")
  const refs = useRef(new Map<string, HTMLDivElement>())
  const rows = useMemo(() => {
    const groups = projects.map(project => ({ id: `project:${project.id}`, project, label: title(project), children: [] as Entity[] }))
    const groupById = new Map(groups.map(group => [group.project.id, group]))
    const outside: Entity[] = []
    for (const item of items) {
      const group = item.projectId ? groupById.get(item.projectId) : undefined
      if (group) group.children.push(item)
      else outside.push(item)
    }
    const allGroups: { id: string; project?: Entity; label: string; children: Entity[] }[] = [...groups]
    if (outside.length) allGroups.push({ id: "unlisted-projects", label: en ? "Tasks whose projects are not in this collection" : "所属项目不在当前集合中的任务", children: outside })
    const result: TreeRow[] = []
    for (const group of allGroups) {
      const expanded = !collapsed.has(group.id)
      result.push({ id: group.id, label: group.label, level: 1, project: group.project, expandable: group.children.length > 0, expanded, count: group.children.length })
      if (expanded) for (const item of group.children) result.push({ id: `item:${item.id}`, label: title(item), item, parent: group.id, level: 2, expandable: false, expanded: false, count: 0 })
    }
    return result
  }, [projects, items, collapsed, en])
  const focusId = rows.some(row => row.id === focusedId) ? focusedId : rows[0]?.id
  function focus(id: string | undefined) { if (id) { setFocusedId(id); refs.current.get(id)?.focus() } }
  function toggle(id: string, expanded: boolean) { setCollapsed(previous => { const next = new Set(previous); if (expanded) next.delete(id); else next.add(id); return next }) }
  function open(row: TreeRow) { if (row.item) onItem(row.item); else if (row.project) onProject(row.project.id) }
  function keyDown(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) {
    if (event.target !== event.currentTarget) return
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); focus(rows[Math.min(index + 1, rows.length - 1)]?.id); break
      case "ArrowUp": event.preventDefault(); focus(rows[Math.max(index - 1, 0)]?.id); break
      case "Home": event.preventDefault(); focus(rows[0]?.id); break
      case "End": event.preventDefault(); focus(rows.at(-1)?.id); break
      case "ArrowRight": event.preventDefault(); if (row.expandable && !row.expanded) toggle(row.id, true); else if (row.expandable) focus(rows[index + 1]?.id); break
      case "ArrowLeft": event.preventDefault(); if (row.expandable && row.expanded) toggle(row.id, false); else focus(row.parent); break
      case "Enter": event.preventDefault(); open(row); break
      case " ": event.preventDefault(); if (row.expandable) toggle(row.id, !row.expanded); else open(row); break
    }
  }
  return <section className="space-y-3" aria-label={en ? "Project and task tree" : "项目任务树"}>
    <div role="tree" aria-label={en ? "Projects and tasks" : "项目与任务"} className="rounded-panel border border-border p-2">
      {rows.map((row, index) => <div key={row.id} ref={element => { if (element) refs.current.set(row.id, element); else refs.current.delete(row.id) }} role="treeitem" aria-level={row.level} aria-expanded={row.expandable ? row.expanded : undefined} aria-selected={row.id === focusId} aria-label={row.label} tabIndex={row.id === focusId ? 0 : -1} onFocus={() => setFocusedId(row.id)} onKeyDown={event => keyDown(event, row, index)} onClick={() => focus(row.id)} onDoubleClick={() => open(row)} className={`flex min-h-11 items-center gap-2 rounded-control px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring ${row.level === 2 ? "ml-7" : ""} ${row.id === focusId ? "bg-selection" : "hover:bg-surface-hover"}`}>
        {row.expandable ? <button type="button" tabIndex={-1} aria-label={row.expanded ? (en ? "Collapse" : "折叠") : (en ? "Expand" : "展开")} onClick={event => { event.stopPropagation(); focus(row.id); toggle(row.id, !row.expanded) }} className="rounded-control p-1">{row.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button> : <span className="w-6" />}
        {row.item ? <ListTodo size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        <span className="text-xs text-muted-foreground">{row.item ? String(row.item.data.status ?? "") : row.count}</span>
        {(row.item || row.project) && <button type="button" tabIndex={-1} onClick={event => { event.stopPropagation(); open(row) }} className="rounded-control px-2 py-1 hover:bg-surface-hover">{en ? "Open" : "打开"}</button>}
      </div>)}
    </div>
    {rows.length === 0 && <p role="status" className="p-4 text-sm text-muted-foreground">{en ? "No projects or tasks." : "暂无项目或任务。"}</p>}
  </section>
}
