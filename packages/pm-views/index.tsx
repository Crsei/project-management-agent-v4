import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, useDndContext, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table';
import { Circle, CircleDashed, CheckCircle2, XCircle, LockKeyhole, GitBranch, Plus, CalendarDays, ArrowUpRight, Pencil, Ellipsis } from 'lucide-react';
import { defaultConfiguration, entityKinds, fieldRegistry, workflowFor, statusCategory, type FileRecord, type Status, type Priority, type ViewConfig, type ProtocolConfiguration } from '../pm-schema/index.ts';
import { relationFields } from '../pm-schema/relations.ts';
import { applyView, groupChange } from '../pm-schema/query.ts';
import type { GraphQuery } from '../pm-schema/graph.ts';
import { KnowledgeGraph } from './KnowledgeGraph.tsx';
import { CompactSelect as RadixSelect } from "@pm/ui/radix/compact-select";
import { documentKindLabels } from './document-kind.ts';
export { documentKindLabels };
import type { GraphSource } from './KnowledgeGraph.tsx';

export { KnowledgeGraph };
export type { GraphSource, KnowledgeGraphProps } from './KnowledgeGraph.tsx';

export const priorities: Priority[] = ['urgent', 'high', 'medium', 'low'];
const priorityLabels: Record<string, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };

const labelTones = ['var(--accent)', 'var(--info)', 'var(--success)', 'var(--warning)', 'var(--agent)', 'var(--destructive)'];
const labelTone = (id: string) => labelTones[Array.from(id).reduce((hash, character) => (hash * 31 + (character.codePointAt(0) ?? 0)) % 997, 0) % labelTones.length];
export const StatusIcon = ({ category }: { category?: string }) => { const Icon = category === 'completed' ? CheckCircle2 : category === 'started' ? CircleDashed : category === 'canceled' ? XCircle : Circle; return <Icon size={14} className={`status-icon ${category || 'unstarted'}`} />; };
export const PriorityIcon = ({ priority, en }: { priority?: string; en?: boolean }) => {
  const level = priority === 'urgent' || priority === 'high' ? 3 : priority === 'medium' ? 2 : priority === 'low' ? 1 : 0;
  return <svg width="13" height="13" viewBox="0 0 14 14" role="img" aria-label={en === false ? priorityLabels[priority || ''] || priority || '' : priority || ''} className={`priority-icon priority-${priority || 'none'}`}>{[1.8, 5.7, 9.6].map((x, index) => <rect key={x} x={x} y={12 - (4.5 + index * 3)} width="2.6" height={4.5 + index * 3} rx="1" fill="currentColor" opacity={index < level ? 1 : .18} />)}</svg>;
};
export type ArchiveFilter = 'exclude' | 'include' | 'only';
export type ContextMenuAction = { id: string; label: string; disabled?: boolean; reason?: string; destructive?: boolean; separatorBefore?: boolean; onSelect: () => void };
export type ContextMenuRenderer = (trigger: React.ReactElement, actions: ContextMenuAction[], file?: FileRecord) => React.ReactNode;
export function matchesArchive(file: FileRecord, filter: ArchiveFilter = 'exclude') { return filter === 'include' || (filter === 'only' ? !!file.entity.archived : !file.entity.archived); }
export type ViewProps = { files: FileRecord[]; allFiles?: FileRecord[]; config: ViewConfig; configuration?: ProtocolConfiguration; archiveFilter?: ArchiveFilter; selectedId?: string; draftIds?: Set<string>; onSelect: (id: string) => void; onInspect?: (id: string) => void; onOpenPage?: (id: string) => void; onPatch: (id: string, changes: Record<string, unknown>) => Promise<void>; canEdit: (id: string, changes?: Record<string, unknown>) => boolean; canLifecycle?: (id: string) => boolean; onLifecycle?: (id: string, action: 'archive' | 'restore') => void; onRequestDelete?: (id: string) => void; onCreate?: (status: Status, origin: ViewConfig) => void; onMove?: (id: string, direction: -1 | 1) => void; renderContextMenu?: ContextMenuRenderer; renderItemAdornment?: (file: FileRecord) => React.ReactNode; embedded?: boolean; graphSource?: GraphSource; graphQuery?: GraphQuery; graphRefreshKey?: unknown; graphScopeTarget?: HTMLElement | null; graphToggleTarget?: HTMLElement | null; en?: boolean };

export function filterFiles(files: FileRecord[], config: ViewConfig, search = '', archiveFilter: ArchiveFilter = 'exclude', configuration = defaultConfiguration) { return applyView(files, config, { search, archived: archiveFilter, configuration }); }
export function unresolvedBlockers(file: FileRecord, files: FileRecord[], configuration = defaultConfiguration) { return file.entity.blocked_by.filter(id => { const entity = files.find(f => f.id === id)?.entity; const category = entity && statusCategory(entity, configuration); return category !== 'completed' && category !== 'canceled'; }); }
function StateSelect({ file, props }: { file: FileRecord; props: ViewProps }) {
  const workflow = workflowFor(file.entity.entity, props.configuration);
  if (!workflow) return <span className="muted">{String(file.entity.document_kind || '—')}</span>;
  const targets = workflow.states.filter(state => state.id !== file.entity.status && workflow.transitions.some(transition => transition.from === file.entity.status && transition.to === state.id) && props.canEdit(file.id, { status: state.id }));
  return <RadixSelect aria-label={`Status for ${file.id}`} value={file.entity.status} disabled={!targets.length} onChange={event => void props.onPatch(file.id, { status: event.target.value })}>{workflow.states.map(state => <option value={state.id} key={state.id} disabled={state.id !== file.entity.status && !targets.some(target => target.id === state.id)}>{state.label}</option>)}</RadixSelect>;
}
function MoveControls({ file, props }: { file: FileRecord; props: ViewProps }) { return props.onMove && !props.embedded ? <span className="manual-order-controls"><button aria-label={`Move ${file.id} up`} disabled={props.files[0]?.id === file.id} onClick={() => props.onMove?.(file.id, -1)}>↑</button><button aria-label={`Move ${file.id} down`} disabled={props.files.at(-1)?.id === file.id} onClick={() => props.onMove?.(file.id, 1)}>↓</button></span> : null; }

function permitsGroup(file: FileRecord, value: unknown, props: ViewProps): boolean {
  if (file.entity.entity === 'work_item' && props.config.group_by === 'project' && value !== file.entity.project) return false;
  try { return props.canEdit(file.id, groupChange(file.entity, props.config.group_by || 'status', value, props.configuration)); }
  catch { return false; }
}

function TaskCard({ file, props, draggable, groupId, groups, onGroup, landed }: { file: FileRecord; props: ViewProps; draggable: boolean; groupId: string; groups: Map<string, { value: unknown; label: string; category?: string }>; onGroup: (id: string, group: string) => void; landed: boolean }) {
  const disabled = !draggable;
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({ id: file.id, disabled });
  const blocked = unresolvedBlockers(file, props.allFiles || props.files, props.configuration);
  const completed = statusCategory(file.entity, props.configuration) === 'completed';
  const clickTimer = useRef<number | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => () => window.clearTimeout(clickTimer.current ?? undefined), []);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointer = (event: PointerEvent) => { if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnKey);
    return () => { document.removeEventListener('pointerdown', closeOnPointer); document.removeEventListener('keydown', closeOnKey); };
  }, [menuOpen]);
  const inspect = props.onInspect ?? props.onSelect;
  const targets = [...groups].map(([key, group]) => ({ key, label: group.label, allowed: permitsGroup(file, group.value, props) })).filter(target => target.key !== groupId);
  const canLifecycle = props.canLifecycle?.(file.id) ?? false;
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
    if (target instanceof HTMLElement && target.closest('select, input, textarea')) return;
    window.clearTimeout(clickTimer.current ?? undefined);
    clickTimer.current = null;
    props.onOpenPage?.(file.id);
  }
  function openPage() { if (props.onOpenPage) props.onOpenPage(file.id); else inspect(file.id); }
  async function copyId() { try { await navigator.clipboard.writeText(file.id); } catch { /* clipboard unavailable */ } }
  const actions: ContextMenuAction[] = [
    { id: 'open', label: props.en === false ? '打开完整页面' : 'Open page', onSelect: openPage },
    { id: 'edit', label: props.en === false ? '编辑' : 'Edit', onSelect: () => inspect(file.id) },
    ...targets.map((target, index) => ({ id: `group:${target.key}`, label: `${props.en === false ? '移动到' : 'Move to'} · ${target.label}`, disabled: !target.allowed, reason: !target.allowed ? (props.en === false ? '当前状态、权限或写入锁不允许此移动' : 'Unavailable for the current workflow, permissions or write state') : undefined, separatorBefore: index === 0, onSelect: () => onGroup(file.id, target.key) })),
    { id: 'copy', label: props.en === false ? '复制编号' : 'Copy ID', separatorBefore: true, onSelect: copyId },
    ...(props.onLifecycle ? [{ id: 'lifecycle', label: file.entity.archived ? (props.en === false ? '恢复' : 'Restore') : (props.en === false ? '归档' : 'Archive'), disabled: !canLifecycle, reason: !canLifecycle ? (props.en === false ? '请先处理权限、草稿或待核对的写入' : 'Resolve permissions, drafts or pending writes first') : undefined, separatorBefore: true, onSelect: () => props.onLifecycle?.(file.id, file.entity.archived ? 'restore' : 'archive') }] : []),
    ...(props.onRequestDelete ? [{ id: 'delete', label: props.en === false ? '删除' : 'Delete', destructive: true, disabled: !canLifecycle, reason: !canLifecycle ? (props.en === false ? '请先处理权限、草稿或待核对的写入' : 'Resolve permissions, drafts or pending writes first') : undefined, onSelect: () => props.onRequestDelete?.(file.id) }] : []),
  ];
  const card = <article tabIndex={0} ref={setNodeRef} onPointerDown={event => listeners?.onPointerDown?.(event)} onContextMenu={() => { window.clearTimeout(clickTimer.current ?? undefined); clickTimer.current = null; }} onDoubleClick={openCard} data-testid={`card-${file.id}`} className={`task-card ${props.selectedId === file.id ? 'selected' : ''}${completed ? ' done' : ''}${isDragging ? ' dragging' : ''}${landed ? ' landed' : ''}`} style={{ transform: transform ? `${CSS.Translate.toString(transform)} rotate(1.2deg)` : undefined }} onClick={event => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button, select, input, textarea, a, label')) return;
    selectCard(event);
  }}>
    <div className="card-topline">
      <div className="card-labels">{file.entity.labels.slice(0, 3).map(label => <span key={label} title={label} style={{ '--label-color': labelTone(label) } as React.CSSProperties}>{label}</span>)}</div>
      <div className="card-flags">{!props.config.project && file.entity.project && <span className="card-project" title={file.entity.project} aria-label={`${props.en === false ? '所属项目' : 'Project'} ${file.entity.project}`} style={{ '--project-color': labelTone(file.entity.project) } as React.CSSProperties} />}{props.draftIds?.has(file.id) && <span className="draft-pill">Draft</span>}{file.entity.kind === 'epic' && <span className="epic-pill">Epic</span>}</div>
      <div className="card-actions" ref={actionsRef} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <button type="button" className="icon-button" aria-label={`${props.en === false ? '打开' : 'Open'} ${file.id}`} onClick={openPage}><ArrowUpRight size={13} /></button>
        <button type="button" className="icon-button" aria-label={`${props.en === false ? '编辑' : 'Edit'} ${file.id}`} onClick={() => inspect(file.id)}><Pencil size={12} /></button>
        <button type="button" className="icon-button" aria-label={`${props.en === false ? '更多操作' : 'More actions'} ${file.id}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><Ellipsis size={13} /></button>
        {menuOpen && <div className="card-menu" role="menu" onPointerDown={event => event.stopPropagation()}>
          {actions.map(action => <React.Fragment key={action.id}>{action.separatorBefore && <div className="card-menu-sep" />}<button type="button" role="menuitem" className={action.destructive ? 'danger' : undefined} disabled={action.disabled} title={action.reason} onClick={() => { setMenuOpen(false); action.onSelect(); }}>{action.label}</button></React.Fragment>)}
        </div>}
      </div>
    </div>
    <button className="card-title" title={file.entity.title} onClick={selectCard}>{file.entity.title}</button>
    <div className="card-bottom">
      <span className="card-id mono">{file.id}</span>
      {props.renderItemAdornment?.(file)}
      {file.entity.entity === 'work_item' && <PriorityIcon priority={file.entity.priority} en={props.en} />}
      {file.entity.due && <span className="card-due" title={`${props.en === false ? '截止日期' : 'Due date'} ${file.entity.due}`}><CalendarDays size={12} aria-hidden="true" />{file.entity.due.length > 7 ? file.entity.due.slice(5) : file.entity.due}</span>}
      {blocked.length > 0 && <span className="blocked-badge" title={`Blocked by ${blocked.join(', ')}`}><LockKeyhole size={11} />{blocked.length}</span>}
      <span className="card-bottom-spacer" />
      {file.entity.archived && <span className="draft-pill">Archived</span>}
      <span className="assignee-avatar" title={file.entity.assignee || String(file.entity.owner || 'Unassigned')}>{String(file.entity.assignee || file.entity.owner || '?').replace('agent:', '').slice(0, 1).toUpperCase()}</span>
    </div>
    <MoveControls file={file} props={props} />
  </article>;
  return props.renderContextMenu ? props.renderContextMenu(card, actions) : card;
}
function BoardColumn({ id, value, label, category, files, props, groups, onGroup, landedId }: { id: string; value: unknown; label: string; category?: string; files: FileRecord[]; props: ViewProps; groups: Map<string, { value: unknown; label: string; category?: string }>; onGroup: (id: string, group: string) => void; landedId: string }) {
  const { active } = useDndContext();
  const activeFile = active && props.files.find(file => file.id === String(active.id));
  const canDrop = !!activeFile && permitsGroup(activeFile, value, props);
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !canDrop });
  const statusGroup = (props.config.group_by || 'status') === 'status';
  const workflow = props.config.entity && workflowFor(props.config.entity, props.configuration);
  const priorityGroup = props.config.group_by === 'priority' && props.config.entity === 'work_item';
  const creationStatus = statusGroup && typeof value === 'string' && workflow?.states.some(state => state.id === value) ? value : priorityGroup ? workflow?.initial : undefined;
  const create = creationStatus && props.onCreate ? () => props.onCreate?.(creationStatus, priorityGroup ? { ...props.config, filter: { ...props.config.filter, priority: value } } : props.config) : undefined;
  const column = <section tabIndex={0} aria-label={label} ref={setNodeRef} data-testid={`column-${String(value ?? 'unset')}`} data-drop-enabled={canDrop} className={`board-column ${isOver ? 'drop-over' : ''}`}>
    <div className="column-heading"><StatusIcon category={category} /><h3>{label}</h3><span className="count">{files.length}</span>{create && <button className="icon-button column-add" aria-label={`${props.en === false ? '新建' : 'Add'} ${label}`} onClick={create}><Plus size={14} aria-hidden="true" /></button>}</div>
    <div className="column-cards">{files.map(file => {
      const targets = [...groups].map(([key, group]) => ({ key, ...group, allowed: permitsGroup(file, group.value, props) }));
      const writable = targets.some(target => target.allowed);
      return <div key={file.id}><TaskCard file={file} props={props} draggable={writable} groupId={id} groups={groups} onGroup={onGroup} landed={landedId === file.id} />{!statusGroup && <label className="card-group-control"><span>{props.config.group_by}</span><RadixSelect aria-label={`Group ${props.config.group_by} for ${file.id}`} value={id} disabled={!writable} onChange={event => onGroup(file.id, event.target.value)}>{targets.map(target => <option key={target.key} value={target.key} disabled={!target.allowed}>{target.label}</option>)}</RadixSelect></label>}</div>;
    })}{!files.length && !create && <div className="column-empty">{props.en === false ? '暂无任务' : 'No tasks'}</div>}{create && <button type="button" className="addcard" onClick={create}><Plus size={14} aria-hidden="true" />{props.en === false ? '新建任务' : 'Add task'}</button>}</div>
  </section>;
  return create && props.renderContextMenu ? props.renderContextMenu(column, [{ id: 'create', label: `${props.en === false ? '新建任务' : 'Add task'} · ${label}`, onSelect: create }]) : column;
}
function Board(props: ViewProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const [error, setError] = useState('');
  const [landedId, setLandedId] = useState('');
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
    if (!file || !group || !permitsGroup(file, group.value, props)) return;
    try { const changes = groupChange(file.entity, field, group.value, props.configuration); setError(''); await props.onPatch(file.id, changes); setLandedId(id); window.setTimeout(() => setLandedId(current => current === id ? '' : current), 520); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function drop(event: DragEndEvent) { if (event.over) void moveToGroup(String(event.active.id), String(event.over.id)); }
  return <>{error && <div className="inline-error" role="alert">{error}</div>}<DndContext sensors={sensors} onDragEnd={drop}><div className="kanban-board">{[...groups].map(([id, group]) => <BoardColumn key={id} id={id} value={group.value} label={group.label} category={group.category} files={props.files.filter(file => key(file.entity[field]) === id)} props={props} groups={groups} onGroup={(fileId, groupId) => void moveToGroup(fileId, groupId)} landedId={landedId} />)}</div></DndContext></>;
}
function Table(props: ViewProps) {
  const columns = useMemo<ColumnDef<FileRecord>[]>(() => {
    const configured = props.config.columns || ['status', 'priority', 'assignee', 'blocked_by', ...(props.configuration?.custom_fields.filter(field => !props.config.entity || field.entities.includes(props.config.entity)).map(field => field.name) || [])];
    const names = !props.config.project && !configured.includes('project') ? ['project', ...configured] : configured;
    return [
      { id: 'item', header: props.config.entity === 'document' ? (props.en === false ? '文档名称' : 'Document') : 'Entity', cell: ({ row: { original: file } }) => <><button className="table-title" onClick={() => props.onSelect(file.id)}>{file.entity.entity === 'document' ? <><strong>{file.entity.title}</strong><span className="mono">{file.id}</span></> : <><span className="mono">{file.id}</span><strong>{file.entity.title}</strong></>}{props.draftIds?.has(file.id) && <span className="draft-pill">Draft</span>}</button>{props.renderItemAdornment?.(file)}<MoveControls file={file} props={props} /></> },
      ...names.filter(name => name !== 'title' && name !== 'id').map((name): ColumnDef<FileRecord> => ({ id: name, header: props.config.entity === 'document' && name === 'document_kind' ? (props.en === false ? '类型' : 'Type') : props.config.entity === 'document' && name === 'project' ? (props.en === false ? '项目' : 'Project') : props.configuration?.custom_fields.find(field => field.name === name)?.label || name.replaceAll('_', ' '), cell: ({ row: { original: file } }) => {
        if (name === 'document_kind') return <span className="muted">{documentKindLabels[String(file.entity.document_kind ?? 'note')]?.[props.en === false ? 'zh' : 'en'] ?? String(file.entity.document_kind ?? '—')}</span>;
        if (name === 'project' && file.entity.entity === 'document') {
          const project = (props.allFiles ?? props.files).find(candidate => candidate.entity.entity === 'project' && candidate.id === file.entity.project);
          const title = project?.entity.title ?? String(file.entity.project ?? '—');
          return <span className="muted" title={title}>{title}</span>;
        }
        if (name === 'status') return <StateSelect file={file} props={props} />;
        if (name === 'priority' && ['work_item', 'requirement'].includes(file.entity.entity)) return <RadixSelect aria-label={`Priority for ${file.id}`} disabled={!props.canEdit(file.id)} value={String(file.entity.priority || 'medium')} onChange={event => void props.onPatch(file.id, { priority: event.target.value })}>{priorities.map(priority => <option key={priority}>{priority}</option>)}</RadixSelect>;
        return <span className="muted">{Array.isArray(file.entity[name]) ? (file.entity[name] as unknown[]).join(', ') : String(file.entity[name] ?? '—')}</span>;
      } })),
    ];
  }, [props]);
  const table = useReactTable({ data: props.files, columns, getCoreRowModel: getCoreRowModel() });
  return <div className="table-scroll"><table className="work-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => {
    const file = row.original;
    const trigger = <tr tabIndex={0} className={props.selectedId === file.id ? 'selected' : ''} data-testid={`row-${file.id}`}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>;
    const actions: ContextMenuAction[] = [
      { id: 'open', label: props.en === false ? '打开完整页面' : 'Open page', onSelect: () => (props.onOpenPage ?? props.onSelect)(file.id) },
      { id: 'inspect', label: props.en === false ? '查看属性' : 'Inspect attributes', onSelect: () => (props.onInspect ?? props.onSelect)(file.id) },
    ];
    return <React.Fragment key={row.id}>{props.renderContextMenu ? props.renderContextMenu(trigger, actions, file) : trigger}</React.Fragment>;
  })}</tbody></table>{!props.files.length && <div className="empty-state">No entities match these filters.</div>}</div>;
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
  return <div className={`pm-view ${props.embedded ? 'embedded-view' : ''}`} data-testid={`view-${props.config.layout}`}>{props.config.layout === 'table' ? <Table {...next} /> : props.config.layout === 'tree' ? <Tree {...next} /> : props.config.layout === 'graph' ? <KnowledgeGraph files={props.allFiles || props.files} configuration={props.configuration} source={props.graphSource} query={{ ...props.graphQuery, view: props.graphQuery?.view ?? props.config, archived: props.graphQuery?.archived ?? props.archiveFilter }} refreshKey={props.graphRefreshKey} selectedId={props.selectedId} onSelect={props.onSelect} draftIds={props.draftIds} embedded={props.embedded} en={props.en} graphScopeTarget={props.graphScopeTarget} graphToggleTarget={props.graphToggleTarget} renderContextMenu={props.renderContextMenu} /> : <Board {...next} />}</div>;
}
