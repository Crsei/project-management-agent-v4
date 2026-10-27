import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Entity } from "@contracts"
import { ServiceBoard } from "./service-board"
import { ServiceCalendar } from "./service-calendar"
import { ServiceGantt } from "./service-gantt"
import { ServiceTable } from "./service-table"
import { ServiceDependencyGraph } from "./service-dependency-graph"
import { ServiceProjectTree } from "./service-project-tree"
import { ServiceWhiteboard } from "./service-whiteboard"
import { RichTextEditor } from "./rich-text-editor"

const project: Entity = { id: "story-project", workspaceId: "story-workspace", projectId: null, kind: "project", version: 1, createdAt: "2026-10-17T09:00:00Z", updatedAt: "2026-10-17T09:00:00Z", createdBy: "story-person", data: { name: "Component demonstration", status: "active" } }
const items: Entity[] = ["draft", "ready", "in_progress", "in_review", "done"].map((status, index) => ({ ...project, id: `story-task-${index}`, projectId: project.id, kind: "work_item", data: { title: ["Plan acceptance criteria", "Prepare delivery", "Implement interface", "Review exact artifact", "Accepted work"][index], status, priority: index === 2 ? "high" : "normal", description: "Explicit example data; never written to a service.", startDate: index === 0 ? null : `2026-10-${18 + index}`, dueDate: index === 0 ? null : `2026-10-${20 + index}`, prerequisiteIds: index === 2 ? ["story-task-4"] : [] } }))
const meta: Meta = { title: "Project Management/Service components", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj<typeof meta>
function CollectionStory({ kind, readonly = false, empty = false }: { kind: "board" | "calendar" | "gantt" | "table"; readonly?: boolean; empty?: boolean }) {
  const [records, setRecords] = useState(empty ? [] : items)
  const [selected, setSelected] = useState<Entity | null>(null)
  const open = (item: Entity) => setSelected(item)
  const schedule = (item: Entity, startDate: string | null, dueDate: string | null) => setRecords(current => current.map(record => record.id === item.id ? { ...record, data: { ...record.data, startDate, dueDate } } : record))
  return <div><p className="mb-4 text-sm text-muted-foreground">Storybook example · {readonly ? "Read only" : "Local interaction only"}</p>
    {kind === "board" && <ServiceBoard items={records} onOpen={open} canMove={(item, state) => !readonly && ((item.data.status === "draft" && state === "ready") || (item.data.status === "ready" && state === "in_progress"))} onMove={(item, status) => setRecords(current => current.map(record => record.id === item.id ? { ...record, data: { ...record.data, status } } : record))} />}
    {kind === "calendar" && <ServiceCalendar items={records} onOpen={open} onSchedule={readonly ? undefined : schedule} />}
    {kind === "gantt" && <ServiceGantt items={records} onOpen={open} onSchedule={readonly ? undefined : schedule} />}
    {kind === "table" && <ServiceTable items={records} onOpen={open} />}
    <p role="status" className="mt-4 text-sm">{selected ? `Selected: ${selected.data.title}` : "Select a task to inspect its identity"}</p>
  </div>
}
export const Kanban: Story = { render: () => <CollectionStory kind="board" /> }
export const ReadOnlyKanban: Story = { render: () => <CollectionStory kind="board" readonly /> }
export const EmptyKanban: Story = { render: () => <CollectionStory kind="board" empty /> }
export const Calendar: Story = { render: () => <CollectionStory kind="calendar" /> }
export const Gantt: Story = { render: () => <CollectionStory kind="gantt" /> }
export const IssueTable: Story = { render: () => <CollectionStory kind="table" /> }
export const EmptyTable: Story = { render: () => <CollectionStory kind="table" empty /> }
export const ProjectTree: Story = { render: () => { const [selection, setSelection] = useState(""); return <><ServiceProjectTree projects={[project]} items={items} onProject={setSelection} onItem={item => setSelection(item.id)} /><p role="status">{selection}</p></> } }
export const PersonalWhiteboard: Story = { render: () => <div className="h-[700px]"><ServiceWhiteboard storageKey="pm:storybook:whiteboard" /></div> }
export const RichText: Story = { render: () => { const [value, setValue] = useState("## Acceptance criteria\n\n- Inspect the exact artifact\n- Record a review\n\n**Review does not complete a work item.**"); return <><RichTextEditor label="Task description" value={value} onChange={setValue} /><pre className="mt-4 whitespace-pre-wrap rounded-module border p-4 text-sm">{value}</pre></> } }
export const DependencyGraph: Story = { render: () => { const [selection, setSelection] = useState(""); return <><ServiceDependencyGraph items={items} onOpen={item => setSelection(String(item.data.title))} /><p role="status">{selection}</p></> } }
