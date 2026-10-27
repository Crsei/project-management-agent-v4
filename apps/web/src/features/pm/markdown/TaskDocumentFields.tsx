import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays, Check, ChevronDown, ChevronRight, Circle, CircleCheck, Flag, Folder,
  ListChecks, MapPin, Plus, Tag, Timer, UserRound, X,
} from 'lucide-react';
import { workflowFor, type ProtocolConfiguration } from '@pm-schema';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';

/** A borderless, auto-growing title. The value is the task's only title source. */
export function TaskTitleField({ value, disabled, invalid, describedBy, en, autoFocus, testId, className, placeholder, required, onValue }: {
  value: string;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  en: boolean;
  autoFocus?: boolean;
  testId?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  onValue: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => { if (disabled || document.activeElement !== input.current) setText(value); }, [value, disabled]);
  useEffect(() => {
    const title = input.current;
    if (!title) return;
    const resize = () => {
      title.style.height = 'auto';
      title.style.height = `${title.scrollHeight}px`;
    };
    resize();
    let width = -1;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth === undefined || nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(title);
    return () => observer.disconnect();
  }, [text]);
  return <textarea
    ref={input}
    className={className ?? 'doc-title'}
    rows={1}
    aria-label={en ? 'Task title' : '任务标题'}
    data-testid={testId}
    placeholder={placeholder}
    value={text}
    disabled={disabled}
    autoFocus={autoFocus}
    aria-invalid={invalid || undefined}
    aria-describedby={describedBy}
    required={required}
    onChange={event => {
      const next = event.target.value.replace(/[\r\n]+/g, ' ');
      setText(next);
      if (!composing.current) onValue(next);
    }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => { composing.current = false; onValue(event.currentTarget.value); }}
    onKeyDown={event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.currentTarget.blur();
      }
    }}
  />;
}

const priorityLabels: Record<string, [zh: string, en: string]> = {
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
  urgent: ['紧急', 'Urgent'],
};

export interface TaskPropertyMember { userId: string; name: string }
export interface TaskPropertyProject { id: string; title: string }

export interface TaskPropertiesProps {
  values: Record<string, unknown>;
  configuration: ProtocolConfiguration;
  members: TaskPropertyMember[];
  projects?: TaskPropertyProject[];
  projectLocked?: boolean;
  labelSuggestions?: string[];
  disabled: boolean;
  en: boolean;
  errors?: Record<string, string | undefined>;
  onChange: (patch: Record<string, unknown>) => void;
}

type OptionalField = 'x-pm-start' | 'due' | 'labels' | 'x-pm-estimate' | 'x-pm-location';

const optionalFields: { name: OptionalField; zh: string; en: string; icon: typeof CalendarDays }[] = [
  { name: 'x-pm-start', zh: '开始日期', en: 'Start date', icon: CalendarDays },
  { name: 'due', zh: '截止日期', en: 'Due date', icon: CalendarDays },
  { name: 'labels', zh: '标签', en: 'Labels', icon: Tag },
  { name: 'x-pm-estimate', zh: '估算点数', en: 'Estimate', icon: Timer },
  { name: 'x-pm-location', zh: '位置', en: 'Location', icon: MapPin },
];

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
}

function PropertyChip({ icon: Icon, label, display, empty, disabled, invalid, testId, children }: {
  icon: typeof Circle;
  label: string;
  display: string;
  empty: boolean;
  disabled: boolean;
  invalid?: boolean;
  testId?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button
      type="button"
      className="doc-chip"
      data-empty={empty || undefined}
      data-active={!empty || undefined}
      data-invalid={invalid || undefined}
      disabled={disabled}
      aria-label={`${label}: ${display}`}
      data-testid={testId}
    />}>
      <Icon size={13} aria-hidden="true" />
      <span className="doc-chip-value">{display}</span>
      <ChevronDown size={11} className="doc-chip-caret" aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent className="doc-popover" side="bottom" align="start">
      <div className="doc-popover-title">{label}</div>
      {children(() => setOpen(false))}
    </PopoverContent>
  </Popover>;
}

function Option({ selected, muted, onClick, children }: {
  selected?: boolean;
  muted?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return <button type="button" className="doc-option" data-selected={selected || undefined} data-muted={muted || undefined} aria-pressed={!!selected} onClick={onClick}>
    {children}
    {selected && <Check size={14} className="doc-option-check" aria-hidden="true" />}
  </button>;
}

function PopoverInput({ label, value, type = 'text', placeholder, min, max, step, disabled, onChange }: {
  label: string;
  value: string;
  type?: 'text' | 'date' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | 'any';
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return <label className="doc-popover-field">
    <span>{label}</span>
    <input type={type} value={value} placeholder={placeholder} min={min} max={max} step={step} disabled={disabled} onChange={event => onChange(event.target.value)} />
  </label>;
}

function PopoverLabels({ label, rendered, suggestions, disabled, onChange }: {
  label: string;
  rendered: string;
  suggestions: string[];
  disabled?: boolean;
  onChange: (labels: string[]) => void;
}) {
  const [text, setText] = useState(rendered);
  useEffect(() => setText(rendered), [rendered]);
  const id = useId();
  return <label className="doc-popover-field">
    <span>{label}</span>
    <input value={text} list={`${id}-labels`} disabled={disabled} placeholder="design, bug" onChange={event => {
      setText(event.target.value);
      onChange([...new Set(event.target.value.split(',').map(item => item.trim()).filter(Boolean))]);
    }} />
    <datalist id={`${id}-labels`}>{suggestions.map(item => <option key={item} value={item} />)}</datalist>
  </label>;
}

/**
 * Obsidian-style property row. Every edit goes through the caller's existing
 * update path; this component never derives or stores task facts itself.
 */
export function TaskProperties({
  values, configuration, members, projects = [], projectLocked = false, labelSuggestions = [], disabled, en, errors = {}, onChange,
}: TaskPropertiesProps) {
  const [shown, setShown] = useState<Set<OptionalField>>(() => new Set());
  const workflow = workflowFor('work_item', configuration);
  const status = workflow?.states.find(state => state.id === values.status);
  const assignee = String(values.assignee ?? '');
  const member = members.find(item => item.userId === assignee);
  const priority = String(values.priority ?? '');
  const priorityDisplay = priorityLabels[priority] ? priorityLabels[priority][en ? 1 : 0] : (en ? 'Priority' : '优先级');
  const project = String(values.project ?? '');
  const projectTitle = projects.find(item => item.id === project)?.title ?? project;
  const visible = (name: OptionalField) => shown.has(name) || hasValue(values[name]);
  const addable = optionalFields.filter(field => !visible(field.name));
  const [addOpen, setAddOpen] = useState(false);
  const clear = (name: OptionalField) => {
    onChange({ [name]: null });
    setShown(previous => {
      const next = new Set(previous);
      next.delete(name);
      return next;
    });
  };
  const propertyError = (name: string) => errors[name];
  const statusDisplay = status?.label ?? (values.status ? String(values.status) : (en ? 'Status' : '状态'));

  return <div className="doc-properties" role="group" aria-label={en ? 'Task properties' : '任务属性'}>
    {!projectLocked && <PropertyChip icon={Folder} label={en ? 'Project' : '项目'} display={projectTitle || (en ? 'Project' : '项目')} empty={!project} disabled={disabled} invalid={!!propertyError('project')} testId="field-project">
      {close => projects.length === 0
        ? <p className="doc-popover-empty">{en ? 'No writable project is available.' : '没有可写项目。'}</p>
        : projects.map(item => <Option key={item.id} selected={item.id === project} onClick={() => { onChange({ project: item.id }); close(); }}><Folder size={13} aria-hidden="true" />{item.title}<span className="doc-option-meta">{item.id}</span></Option>)}
    </PropertyChip>}

    <PropertyChip icon={Circle} label={en ? 'Status' : '状态'} display={statusDisplay} empty={!status} disabled={disabled} invalid={!!propertyError('status')} testId="field-status">
      {close => workflow?.states.length
        ? workflow.states.map(state => <Option key={state.id} selected={state.id === values.status} onClick={() => { onChange({ status: state.id }); close(); }}>
          <span className="doc-status-dot" data-category={state.category} aria-hidden="true" />{state.label}
        </Option>)
        : <p className="doc-popover-empty">{en ? 'No workflow states are configured.' : '没有配置工作流状态。'}</p>}
    </PropertyChip>

    <PropertyChip icon={UserRound} label={en ? 'Assignee' : '负责人'} display={member?.name ?? (assignee || (en ? 'Assignee' : '负责人'))} empty={!member && !assignee} disabled={disabled} invalid={!!propertyError('assignee')} testId="field-assignee">
      {close => <>
        <Option selected={!assignee} muted onClick={() => { onChange({ assignee: null }); close(); }}>{en ? 'Unassigned' : '未分配'}</Option>
        {assignee && !member && <Option selected onClick={() => { onChange({ assignee }); close(); }}>{en ? 'Current assignee unavailable' : '原负责人不可用'}<span className="doc-option-meta">{assignee}</span></Option>}
        {members.map(item => <Option key={item.userId} selected={item.userId === assignee} onClick={() => { onChange({ assignee: item.userId }); close(); }}><UserRound size={13} aria-hidden="true" />{item.name}<span className="doc-option-meta">{item.userId}</span></Option>)}
        {members.length === 0 && <p className="doc-popover-empty">{en ? 'No assignable member is available.' : '没有可分派的成员。'}</p>}
      </>}
    </PropertyChip>

    <PropertyChip icon={Flag} label={en ? 'Priority' : '优先级'} display={priorityDisplay} empty={!priority} disabled={disabled} invalid={!!propertyError('priority')} testId="field-priority">
      {close => <>
        <Option selected={!priority} muted onClick={() => { onChange({ priority: null }); close(); }}>{en ? 'No priority' : '未设置优先级'}</Option>
        {Object.entries(priorityLabels).map(([value, labels]) => <Option key={value} selected={priority === value} onClick={() => { onChange({ priority: value }); close(); }}>
          <Flag size={13} data-priority={value} aria-hidden="true" />{labels[en ? 1 : 0]}
        </Option>)}
      </>}
    </PropertyChip>

    {visible('x-pm-start') && <PropertyChip icon={CalendarDays} label={en ? 'Start date' : '开始日期'} display={String(values['x-pm-start'] ?? '') || (en ? 'Start date' : '开始日期')} empty={!values['x-pm-start']} disabled={disabled} invalid={!!propertyError('x-pm-start')} testId="field-x-pm-start">
      {close => <>
        <PopoverInput type="date" label={en ? 'Start date' : '开始日期'} value={String(values['x-pm-start'] ?? '')} disabled={disabled} onChange={value => onChange({ 'x-pm-start': value || null })} />
        <div className="doc-popover-footer"><button type="button" className="doc-option" data-muted onClick={() => { clear('x-pm-start'); close(); }}><X size={13} aria-hidden="true" />{en ? 'Remove property' : '移除属性'}</button></div>
      </>}
    </PropertyChip>}

    {visible('due') && <PropertyChip icon={CalendarDays} label={en ? 'Due date' : '截止日期'} display={String(values.due ?? '') || (en ? 'Due date' : '截止日期')} empty={!values.due} disabled={disabled} invalid={!!propertyError('due')} testId="field-due">
      {close => <>
        <PopoverInput type="date" label={en ? 'Due date' : '截止日期'} value={String(values.due ?? '')} disabled={disabled} onChange={value => onChange({ due: value || null })} />
        <div className="doc-popover-footer"><button type="button" className="doc-option" data-muted onClick={() => { clear('due'); close(); }}><X size={13} aria-hidden="true" />{en ? 'Remove property' : '移除属性'}</button></div>
      </>}
    </PropertyChip>}

    {visible('labels') && <PropertyChip icon={Tag} label={en ? 'Labels' : '标签'} display={Array.isArray(values.labels) && values.labels.length ? values.labels.join(', ') : (en ? 'Labels' : '标签')} empty={!hasValue(values.labels)} disabled={disabled} invalid={!!propertyError('labels')} testId="field-labels">
      {close => <>
        <PopoverLabels label={en ? 'Comma-separated labels' : '标签，以逗号分隔'} rendered={Array.isArray(values.labels) ? values.labels.join(', ') : ''} suggestions={labelSuggestions} disabled={disabled} onChange={labels => onChange({ labels })} />
        <div className="doc-popover-footer"><button type="button" className="doc-option" data-muted onClick={() => { clear('labels'); close(); }}><X size={13} aria-hidden="true" />{en ? 'Remove property' : '移除属性'}</button></div>
      </>}
    </PropertyChip>}

    {visible('x-pm-estimate') && <PropertyChip icon={Timer} label={en ? 'Estimate' : '估算点数'} display={values['x-pm-estimate'] === null || values['x-pm-estimate'] === undefined || values['x-pm-estimate'] === '' ? (en ? 'Estimate' : '估算点数') : String(values['x-pm-estimate'])} empty={!hasValue(values['x-pm-estimate'])} disabled={disabled} invalid={!!propertyError('x-pm-estimate')} testId="field-x-pm-estimate">
      {close => <>
        <PopoverInput type="number" min={0} max={1_000_000} step="any" label={en ? 'Estimate points' : '估算点数'} value={String(values['x-pm-estimate'] ?? '')} disabled={disabled} onChange={value => onChange({ 'x-pm-estimate': value === '' ? null : Number(value) })} />
        <div className="doc-popover-footer"><button type="button" className="doc-option" data-muted onClick={() => { clear('x-pm-estimate'); close(); }}><X size={13} aria-hidden="true" />{en ? 'Remove property' : '移除属性'}</button></div>
      </>}
    </PropertyChip>}

    {visible('x-pm-location') && <PropertyChip icon={MapPin} label={en ? 'Location' : '位置'} display={String(values['x-pm-location'] ?? '') || (en ? 'Location' : '位置')} empty={!values['x-pm-location']} disabled={disabled} invalid={!!propertyError('x-pm-location')} testId="field-x-pm-location">
      {close => <>
        <PopoverInput label={en ? 'Location' : '位置'} value={String(values['x-pm-location'] ?? '')} disabled={disabled} onChange={value => onChange({ 'x-pm-location': value || null })} />
        <div className="doc-popover-footer"><button type="button" className="doc-option" data-muted onClick={() => { clear('x-pm-location'); close(); }}><X size={13} aria-hidden="true" />{en ? 'Remove property' : '移除属性'}</button></div>
      </>}
    </PropertyChip>}

    {addable.length > 0 && <Popover open={addOpen} onOpenChange={setAddOpen}>
      <PopoverTrigger render={<button type="button" className="doc-chip doc-chip-add" disabled={disabled} aria-label={en ? 'Add property' : '添加属性'} />}>
        <Plus size={13} aria-hidden="true" /><span className="doc-chip-value">{en ? 'Add property' : '属性'}</span>
      </PopoverTrigger>
      <PopoverContent className="doc-popover" side="bottom" align="start">
        <div className="doc-popover-title">{en ? 'Add property' : '添加属性'}</div>
        {addable.map(field => {
          const Icon = field.icon;
          return <button key={field.name} type="button" className="doc-option" onClick={() => { setShown(previous => new Set(previous).add(field.name)); setAddOpen(false); }}>
            <Icon size={13} aria-hidden="true" />{en ? field.en : field.zh}
          </button>;
        })}
      </PopoverContent>
    </Popover>}
  </div>;
}

export interface InlineSubtaskItem {
  draftId: string;
  values: Record<string, unknown>;
  body: string;
  locked?: boolean;
}

export interface InlineSubtasksProps {
  items: InlineSubtaskItem[];
  configuration: ProtocolConfiguration;
  members: TaskPropertyMember[];
  disabled: boolean;
  en: boolean;
  max?: number;
  errorFor?: (index: number) => string[];
  onAdd: () => void;
  onRemove: (draftId: string) => void;
  onChange: (draftId: string, changes: { values?: Record<string, unknown>; body?: string }) => void;
}

/**
 * Subtasks stay formal work-item drafts: title, status and assignee are read
 * from the creation draft, never parsed from Markdown checklist text.
 */
export function InlineSubtasks({ items, configuration, members, disabled, en, max = 100, errorFor, onAdd, onRemove, onChange }: InlineSubtasksProps) {
  const workflow = workflowFor('work_item', configuration);
  const complete = workflow?.states.find(state => state.category === 'completed');
  const open = workflow?.states.find(state => state.category === 'unstarted' || state.category === 'backlog') ?? workflow?.states.find(state => !['completed', 'canceled'].includes(state.category));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusPending, setFocusPending] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const count = items.filter(item => workflow?.states.find(state => state.id === item.values.status)?.category === 'completed').length;
  useEffect(() => {
    if (!focusPending || items.length === 0) return;
    const inputs = list.current?.querySelectorAll<HTMLInputElement>('input.doc-subtask-input');
    inputs?.[inputs.length - 1]?.focus();
    setFocusPending(false);
  }, [focusPending, items.length]);
  const setCompleted = (item: InlineSubtaskItem, completed: boolean) => {
    if (!complete || !open) return;
    onChange(item.draftId, { values: { status: completed ? complete.id : open.id } });
  };
  const toggleExpanded = (id: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <section className="doc-subtasks" aria-labelledby="doc-subtasks-heading">
    <header className="doc-subtasks-header">
      <ListChecks size={14} aria-hidden="true" />
      <h2 id="doc-subtasks-heading">{en ? 'Subtasks' : '子任务'}</h2>
      {items.length > 0 && <span className="doc-subtasks-count">{count}/{items.length}</span>}
      <span className="doc-subtasks-note" title={en ? 'Formal subtasks create separate work items with their own status, assignee and audit trail. Markdown checkboxes never become subtasks automatically.' : '正式子任务会创建独立工作项，拥有独立状态、负责人和审计记录；Markdown 勾选项不会自动转换为子任务。'}>
        {en ? 'Formal work items' : '正式工作项'}
      </span>
    </header>
    <ul className="doc-subtasks-list" ref={list}>
      {items.map((item, index) => {
        const done = workflow?.states.find(state => state.id === item.values.status)?.category === 'completed';
        const isOpen = expanded.has(item.draftId);
        const locked = disabled || item.locked;
        const errors = errorFor?.(index) ?? [];
        const assignee = String(item.values.assignee ?? '');
        const member = members.find(candidate => candidate.userId === assignee);
        return <li key={item.draftId} className="doc-subtask" data-done={done || undefined} data-locked={locked || undefined}>
          <button type="button" className="doc-subtask-check" role="checkbox" aria-checked={!!done} aria-label={`${en ? 'Complete subtask' : '完成子任务'} ${index + 1}`} disabled={locked || !complete || !open} onClick={() => setCompleted(item, !done)}>
            {done ? <CircleCheck size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
          </button>
          <input
            className="doc-subtask-input"
            value={String(item.values.title ?? '')}
            aria-label={`${en ? 'Subtask title' : '子任务标题'} ${index + 1}`}
            aria-invalid={errors.length > 0 || undefined}
            placeholder={en ? 'Subtask title' : '子任务标题'}
            disabled={locked}
            onChange={event => onChange(item.draftId, { values: { title: event.target.value } })}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (items.length < max) { setFocusPending(true); onAdd(); }
              }
            }}
          />
          <div className="doc-subtask-actions">
            <button type="button" className="doc-icon-button" aria-expanded={isOpen} aria-label={`${en ? 'Edit subtask details' : '编辑子任务属性'} ${index + 1}`} onClick={() => toggleExpanded(item.draftId)}>
              <ChevronRight size={14} className={isOpen ? 'is-open' : undefined} aria-hidden="true" />
            </button>
            <button type="button" className="doc-icon-button" aria-label={`${en ? 'Remove subtask' : '移除子任务'} ${index + 1}`} disabled={locked} onClick={() => onRemove(item.draftId)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {isOpen && <div className="doc-subtask-details">
            <label className="doc-subtask-field">
              <span>{en ? 'Markdown description' : 'Markdown 描述'}</span>
              <textarea rows={3} value={item.body} disabled={locked} onChange={event => onChange(item.draftId, { body: event.target.value })} placeholder={en ? 'Optional details for this subtask' : '此子任务的可选说明'} />
            </label>
            <label className="doc-subtask-field">
              <span>{en ? 'Assignee' : '负责人'}</span>
              <select value={assignee} disabled={locked} onChange={event => onChange(item.draftId, { values: { assignee: event.target.value || null } })}>
                <option value="">{en ? 'Unassigned' : '未分配'}</option>
                {assignee && !member && <option value={assignee}>{en ? 'Current assignee unavailable' : '原负责人不可用'}</option>}
                {members.map(candidate => <option key={candidate.userId} value={candidate.userId}>{candidate.name} · {candidate.userId}</option>)}
              </select>
            </label>
            <p className="doc-subtask-status">{en ? 'Status is controlled by the circle toggle. Saving creates a separate work item linked to this parent.' : '状态由左侧圆形按钮控制；保存后会创建独立工作项并关联父任务。'}</p>
          </div>}
          {errors.length > 0 && <p className="doc-subtask-error" role="alert">{errors.join(' · ')}</p>}
        </li>;
      })}
    </ul>
    <button type="button" className="doc-add-subtask" disabled={disabled || items.length >= max} onClick={() => { setFocusPending(true); onAdd(); }}>
      <Plus size={14} aria-hidden="true" />{en ? 'Add subtask' : '添加子任务'}
    </button>
  </section>;
}
