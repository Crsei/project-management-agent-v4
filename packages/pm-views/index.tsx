import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, useDndContext, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table';
import { Circle, CircleDashed, CheckCircle2, XCircle, GripVertical, LockKeyhole, ArrowUpRight, GitBranch, Plus } from 'lucide-react';
import { defaultConfiguration, entityKinds, fieldRegistry, workflowFor, statusCategory, type FileRecord, type Status, type Priority, type ViewConfig, type ProtocolConfiguration } from '../pm-schema/index.ts';
import { relationFields } from '../pm-schema/relations.ts';
import { applyView, groupChange } from '../pm-schema/query.ts';
import type { GraphQuery } from '../pm-schema/graph.ts';
import { KnowledgeGraph } from './KnowledgeGraph.tsx';
import type { GraphSource } from './KnowledgeGraph.tsx';

export { KnowledgeGraph };
export type { GraphSource, KnowledgeGraphProps } from './KnowledgeGraph.tsx';

export const priorities: Priority[] = ['urgent', 'high', 'medium', 'low'];
const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };
export const StatusIcon = ({ category }: { category?: string }) => { const Icon = category === 'completed' ? CheckCircle2 : category === 'started' ? CircleDashed : category === 'canceled' ? XCircle : Circle; return <Icon size={14} className={`status-icon ${category || 'unstarted'}`} />; };
export type ArchiveFilter = 'exclude' | 'include' | 'only';
export function matchesArchive(file: FileRecord, filter: ArchiveFilter = 'exclude') { return filter === 'include' || (filter === 'only' ? !!file.entity.archived : !file.entity.archived); }
export type ViewProps = { files: FileRecord[]; allFiles?: FileRecord[]; config: ViewConfig; configuration?: ProtocolConfiguration; archiveFilter?: ArchiveFilter; selectedId?: string; draftIds?: Set<string>; onSelect: (id: string) => void; onInspect?: (id: string) => void; onOpenPage?: (id: string) => void; onPatch: (id: string, changes: Record<string, unknown>) => Promise<void>; canEdit: (id: string) => boolean; onCreate?: (status: Status, origin: ViewConfig) => void; onMove?: (id: string, direction: -1 | 1) => void; embedded?: boolean; graphSource?: GraphSource; graphQuery?: GraphQuery; graphRefreshKey?: unknown; en?: boolean };

export function filterFiles(files: FileRecord[], config: ViewConfig, search = '', archiveFilter: ArchiveFilter = 'exclude', configuration = defaultConfiguration) { return applyView(files, config, { search, archived: archiveFilter, configuration }); }
export function unresolvedBlockers(file: FileRecord, files: FileRecord[], configuration = defaultConfiguration) { return file.entity.blocked_by.filter(id => { const entity = files.find(f => f.id === id)?.entity; const category = entity && statusCategory(entity, configuration); return category !== 'completed' && category !== 'canceled'; }); }
function StateSelect({ file, props }: { file: FileRecord; props: ViewProps }) {
  const workflow = workflowFor(file.entity.entity, props.configuration);
  if (!workflow) return <span className="muted">{String(file.entity.document_kind || '—')}</span>;
  return <select aria-label={`Status for ${file.id}`} value={file.entity.status} disabled={!props.canEdit(file.id)} onChange={event => void props.onPatch(file.id, { status: event.target.value })}>{workflow.states.map(state => <option value={state.id} key={state.id} disabled={state.id !== file.entity.status && !workflow.transitions.some(t => t.from === file.entity.status && t.to === state.id)}>{state.label}</option>)}</select>;
}
function MoveControls({ file, props }: { file: FileRecord; props: ViewProps }) { return props.onMove && !props.embedded ? <span className="manual-order-controls"><button aria-label={`Move ${file.id} up`} disabled={props.files[0]?.id === file.id} onClick={() => props.onMove?.(file.id, -1)}>↑</button><button aria-label={`Move ${file.id} down`} disabled={props.files.at(-1)?.id === file.id} onClick={() => props.onMove?.(file.id, 1)}>↓</button></span> : null; }

function permitsGroup(file: FileRecord, value: unknown, props: ViewProps): boolean {
  if (!props.canEdit(file.id)) return false;
  try { groupChange(file.entity, props.config.group_by || 'status', value, props.configuration); return true; }
  catch { return false; }
}

function TaskCard({ file, props, draggable }: { file: FileRecord; props: ViewProps; draggable: boolean }) {
  const disabled = !draggable;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: file.id, disabled });
  const blocked = unresolvedBlockers(file, props.allFiles || props.files, props.configuration);
  const completed = statusCategory(file.entity, props.configuration) === 'completed';
  const clickTimer = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(clickTimer.current ?? undefined), []);
  const inspect = props.onInspect ?? props.onSelect;
  function selectCard(event: React.MouseEvent) {
    if (event.detail > 1) {
      window.clearTimeout(clickTimer.current ?? undefined);
      clickTimer.current = null;
      return;
    }
    // Opening the inspector changes board width; defer the first selection so a double-click is not split by that reflow.
    if (props.selectedId) { inspect(file.id); return; }
    window.clearTimeout(clickTimer.current ?? undefined);
    clickTimer.current = window.setTimeout(() => { clickTimer.current = null; inspect(file.id); }, 250);
  }
  function openCard(event: React.MouseEvent) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('select, input, textarea, .drag-handle')) return;
    window.clearTimeout(clickTimer.current ?? undefined);
    clickTimer.current = null;
    props.onOpenPage?.(file.id);
  }
  return <article ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? .45 : 1 }} data-testid={`card-${file.id}`} className={`task-card ${props.selectedId === file.id ? 'selected' : ''}${completed ? ' done' : ''}`} onClick={event => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button, select, input, textarea, a, label')) return;
    selectCard(event);
  }} onDoubleClick={openCard}>
    <div className="card-eyebrow"><span className="mono">{file.id}</span><span className="card-flags">{props.draftIds?.has(file.id) && <span className="draft-pill">Draft</span>}{file.entity.kind === 'epic' && <span className="epic-pill">Epic</span>}<button className="drag-handle icon-button" aria-label={`Drag ${file.id}`} disabled={disabled} {...attributes} {...listeners}><GripVertical size={13} /></button></span></div>
    <button className="card-title" onClick={selectCard}>{file.entity.title}</button>
    {!props.config.project && file.entity.project && <span className="muted" title={props.en ? 'Project' : '所属项目'}>{file.entity.project}</span>}
    {file.entity.labels.length > 0 && <div className="card-labels">{file.entity.labels.slice(0, 2).map(label => <span key={label}>{label}</span>)}</div>}
    {blocked.length > 0 && <span className="blocked-badge" title={`Blocked by ${blocked.join(', ')}`}><LockKeyhole size={11} /> Blocked · {blocked.length}</span>}
    <div className="card-bottom">{file.entity.archived && <span className="draft-pill">Archived</span>}{file.entity.entity === 'work_item' && <span className={`priority priority-${file.entity.priority}`}>{file.entity.priority}</span>}<span className="assignee-avatar" title={file.entity.assignee || String(file.entity.owner || 'Unassigned')}>{String(file.entity.assignee || file.entity.owner || '?').replace('agent:', '').slice(0, 1).toUpperCase()}</span></div>
    <label className="card-status"><span className="sr-only">Status for {file.id}</span><StateSelect file={file} props={props} /><ArrowUpRight size={12} /></label><MoveControls file={file} props={props} />
  </article>;
}
function BoardColumn({ id, value, label, category, files, props, groups, onGroup }: { id: string; value: unknown; label: string; category?: string; files: FileRecord[]; props: ViewProps; groups: Map<string, { value: unknown; label: string; category?: string }>; onGroup: (id: string, group: string) => void }) {
  const { active } = useDndContext();
  const activeFile = active && props.files.find(file => file.id === String(active.id));
  const canDrop = !!activeFile && permitsGroup(activeFile, value, props);
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !canDrop });
  const statusGroup = (props.config.group_by || 'status') === 'status';
  const workflow = props.config.entity && workflowFor(props.config.entity, props.configuration);
  const priorityGroup = props.config.group_by === 'priority' && props.config.entity === 'work_item';
  const creationStatus = statusGroup && typeof value === 'string' && workflow?.states.some(state => state.id === value) ? value : priorityGroup ? workflow?.initial : undefined;
  const create = creationStatus && props.onCreate ? () => props.onCreate?.(creationStatus, priorityGroup ? { ...props.config, filter: { ...props.config.filter, priority: value } } : props.config) : undefined;
  return <section ref={setNodeRef} data-testid={`column-${String(value ?? 'unset')}`} data-drop-enabled={canDrop} className={`board-column ${isOver ? 'drop-over' : ''}`}>
    <div className="column-heading"><StatusIcon category={category} /><h3>{label}</h3><span className="count">{files.length}</span>{create && <button className="icon-button column-add" aria-label={`${props.en === false ? '新建' : 'Add'} ${label}`} onClick={create}><Plus size={14} aria-hidden="true" /></button>}</div>
    <div className="column-cards">{files.map(file => {
      const targets = [...groups].map(([key, group]) => ({ key, ...group, allowed: permitsGroup(file, group.value, props) }));
      const writable = targets.some(target => target.allowed);
      return <div key={file.id}><TaskCard file={file} props={props} draggable={writable} />{!statusGroup && <label className="card-group-control"><span>{props.config.group_by}</span><select aria-label={`Group ${props.config.group_by} for ${file.id}`} value={id} disabled={!writable} onChange={event => onGroup(file.id, event.target.value)}>{targets.map(target => <option key={target.key} value={target.key} disabled={!target.allowed}>{target.label}</option>)}</select></label>}</div>;
    })}{!files.length && !create && <div className="column-empty">{props.en === false ? '暂无任务' : 'No tasks'}</div>}{create && <button type="button" className="addcard" onClick={create}><Plus size={14} aria-hidden="true" />{props.en === false ? '新建任务' : 'Add task'}</button>}</div>
  </section>;
}
function Board(props: ViewProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const [error, setError] = useState('');
  const field = props.config.group_by || 'status';
  const key = (value: unknown) => JSON.stringify(value ?? null);
  const groups = new Map<string, { value: unknown; label: string; category?: string }>();
  if (field === 'status') (props.config.entity ? [props.config.entity] : entityKinds).forEach(kind => workflowFor(kind, props.configuration)?.states.forEach(state => groups.set(key(state.id), { value: state.id, label: state.label, category: state.category })));
  const custom = (props.configuration || defaultConfiguration).custom_fields.find(definition => definition.name === field);
  const builtin = fieldRegistry.find(definition => definition.name === field);
  const options = custom?.options || (builtin?.type.startsWith('enum:') ? builtin.type.slice(5).split('|') : []);
  options.forEach(value => groups.set(key(value), { value, label: field === 'priority' && props.en === false ? priorityLabels[value] || value : value }));
  if (custom?.type === 'boolean' || builtin?.type === 'boolean') [true, false].forEach(value => groups.set(key(value), { value, label: String(value) }));
  const reference = relationFields(props.configuration).find(definition => definition.name === field);
  if (reference) (props.allFiles || props.files).filter(file => !reference.target || file.entity.entity === (reference.target === 'self' ? props.config.entity : reference.target)).forEach(file => groups.set(key(file.id), { value: file.id, label: `${file.id} · ${file.entity.title}` }));
  const nullable = custom ? !custom.required : !!builtin?.nullable;
  const defaulted = field === 'status' || Object.prototype.hasOwnProperty.call(custom || builtin || {}, 'default');
  if (nullable && !defaulted) groups.set(key(null), { value: null, label: 'Unset' });
  props.files.forEach(file => { const value = file.entity[field] ?? null; if (!groups.has(key(value))) groups.set(key(value), { value, label: value === null ? 'Unset' : String(value) }); });
  async function moveToGroup(id: string, groupId: string) {
    const file = props.files.find(file => file.id === id);
    const group = groups.get(groupId);
    if (!file || !group || !props.canEdit(file.id)) return;
    try { const changes = groupChange(file.entity, field, group.value, props.configuration); setError(''); await props.onPatch(file.id, changes); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function drop(event: DragEndEvent) { if (event.over) void moveToGroup(String(event.active.id), String(event.over.id)); }
  return <>{error && <div className="inline-error" role="alert">{error}</div>}<DndContext sensors={sensors} onDragEnd={drop}><div className="kanban-board">{[...groups].map(([id, group]) => <BoardColumn key={id} id={id} value={group.value} label={group.label} category={group.category} files={props.files.filter(file => key(file.entity[field]) === id)} props={props} groups={groups} onGroup={(fileId, groupId) => void moveToGroup(fileId, groupId)} />)}</div></DndContext></>;
}
function Table(props: ViewProps) {
  const columns = useMemo<ColumnDef<FileRecord>[]>(() => {
    const configured = props.config.columns || ['status', 'priority', 'assignee', 'blocked_by', ...(props.configuration?.custom_fields.filter(field => !props.config.entity || field.entities.includes(props.config.entity)).map(field => field.name) || [])];
    const names = !props.config.project && !configured.includes('project') ? ['project', ...configured] : configured;
    return [
      { id: 'item', header: 'Entity', cell: ({ row: { original: file } }) => <><button className="table-title" onClick={() => props.onSelect(file.id)}><span className="mono">{file.id}</span><strong>{file.entity.title}</strong>{props.draftIds?.has(file.id) && <span className="draft-pill">Draft</span>}</button><MoveControls file={file} props={props} /></> },
      ...names.filter(name => name !== 'title' && name !== 'id').map((name): ColumnDef<FileRecord> => ({ id: name, header: props.configuration?.custom_fields.find(field => field.name === name)?.label || name.replaceAll('_', ' '), cell: ({ row: { original: file } }) => name === 'status' ? <StateSelect file={file} props={props} /> : name === 'priority' && ['work_item', 'requirement'].includes(file.entity.entity) ? <select aria-label={`Priority for ${file.id}`} disabled={!props.canEdit(file.id)} value={String(file.entity.priority || 'medium')} onChange={event => void props.onPatch(file.id, { priority: event.target.value })}>{priorities.map(priority => <option key={priority}>{priority}</option>)}</select> : <span className="muted">{Array.isArray(file.entity[name]) ? (file.entity[name] as unknown[]).join(', ') : String(file.entity[name] ?? '—')}</span> })),
    ];
  }, [props]);
  const table = useReactTable({ data: props.files, columns, getCoreRowModel: getCoreRowModel() });
  return <div className="table-scroll"><table className="work-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id} className={props.selectedId === row.original.id ? 'selected' : ''} data-testid={`row-${row.original.id}`}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!props.files.length && <div className="empty-state">No entities match these filters.</div>}</div>;
}
function Tree(props: ViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visited = new Set<string>();
  function render(file: FileRecord, depth: number, ancestors: Set<string>): React.ReactNode {
    if (ancestors.has(file.id)) return <div key={`${file.id}-cycle`} className="relation-warning">Circular parent reference: {file.id}</div>;
    visited.add(file.id);
    const children = props.files.filter(f => f.entity.parent === file.id);
    const next = new Set(ancestors).add(file.id);
    return <React.Fragment key={file.id}><div className={`tree-row ${props.selectedId === file.id ? 'selected' : ''}`} style={{ paddingLeft: 16 + depth * 22 }}><button className="icon-button" aria-label={`${collapsed.has(file.id) ? 'Expand' : 'Collapse'} ${file.id}`} disabled={!children.length} onClick={() => setCollapsed(old => { const copy = new Set(old); if (copy.has(file.id)) copy.delete(file.id); else copy.add(file.id); return copy; })}>{children.length ? collapsed.has(file.id) ? '▸' : '▾' : '·'}</button><StatusIcon category={statusCategory(file.entity, props.configuration)} /><button className="tree-title" onClick={() => props.onSelect(file.id)}><span className="mono">{file.id}</span>{file.entity.title}</button>{!props.config.project && file.entity.project && <span className="muted" title={props.en ? 'Project' : '所属项目'}>{file.entity.project}</span>}<span className="muted">{file.entity.kind || file.entity.entity}</span><MoveControls file={file} props={props} />{file.entity.parent && !(props.allFiles || props.files).some(f => f.id === file.entity.parent) && <span className="relation-warning">Missing parent {file.entity.parent}</span>}</div>{!collapsed.has(file.id) && children.map(child => render(child, depth + 1, next))}</React.Fragment>;
  }
  const roots = props.files.filter(f => !f.entity.parent || !props.files.some(p => p.id === f.entity.parent));
  const result = roots.map(f => render(f, 0, new Set()));
  // Mark collapsed descendants as reachable so they cannot appear again as roots.
  function mark(id: string, seen = new Set<string>()) { if (seen.has(id)) return; seen.add(id); visited.add(id); props.files.filter(f => f.entity.parent === id).forEach(f => mark(f.id, seen)); }
  roots.forEach(f => mark(f.id));
  props.files.forEach(f => { if (!visited.has(f.id)) result.push(<React.Fragment key={`orphan-${f.id}`}><div className="relation-warning">Parent cycle</div>{render(f, 0, new Set())}</React.Fragment>); });
  return <div className="tree-view"><div className="view-description"><GitBranch size={15} /> Epic → task → subtask · select a work item to open its source</div>{result.length ? result : <div className="empty-state">No matching work items.</div>}</div>;
}
export function PMView(props: ViewProps) {
  const result = useMemo(() => { try { return { files: filterFiles(props.files, props.config, '', props.archiveFilter, props.configuration), error: '' }; } catch (error) { return { files: [], error: error instanceof Error ? error.message : String(error) }; } }, [props.files, props.config, props.archiveFilter, props.configuration]);
  const next = { ...props, files: result.files, allFiles: props.allFiles || props.files };
  if (result.error) return <div role="alert" className="inline-error">Invalid view: {result.error}</div>;
  return <div className={`pm-view ${props.embedded ? 'embedded-view' : ''}`} data-testid={`view-${props.config.layout}`}>{props.config.layout === 'table' ? <Table {...next} /> : props.config.layout === 'tree' ? <Tree {...next} /> : props.config.layout === 'graph' ? <KnowledgeGraph files={props.allFiles || props.files} configuration={props.configuration} source={props.graphSource} query={{ ...props.graphQuery, view: props.graphQuery?.view ?? props.config, archived: props.graphQuery?.archived ?? props.archiveFilter }} refreshKey={props.graphRefreshKey} selectedId={props.selectedId} onSelect={props.onSelect} draftIds={props.draftIds} embedded={props.embedded} en={props.en} /> : <Board {...next} />}</div>;
}
