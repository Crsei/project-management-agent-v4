import React, { useEffect, useId, useRef, useState } from 'react';
import { fieldRegistry, workflowFor, type EntityKind, type FileRecord, type ProtocolConfiguration } from '@pm-schema';
import { relationFields } from '@pm-schema/relations';
import { RadixSelect } from "@/components/ui/radix-select"

function TextField({ name, label, value, type, disabled, required, min, max, creating, error, onChange }: { name: string; label: string; value: unknown; type: string; disabled: boolean; required?: boolean; min?: number; max?: number; creating: boolean; error?: string; onChange: (value: unknown) => void }) {
  const rendered = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  const [text, setText] = useState(rendered);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => { if (disabled || document.activeElement !== input.current) setText(rendered); }, [disabled, rendered]);
  const commit = () => { if (text !== rendered) onChange(type.endsWith('[]') ? text.split(',').map(v => v.trim()).filter(Boolean) : text === '' ? (required ? '' : null) : type === 'number' ? Number(text) : text); };
  return <label className="property-field"><span>{label}</span><input ref={input} name={name} aria-label={name === 'title' ? 'Title' : `Property ${name.replaceAll('_', ' ')}`} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} data-testid={creating && name === 'title' ? 'new-task-title' : `field-${name}`} type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} step={type === 'number' ? 'any' : undefined} min={min} max={max} required={required} value={text} disabled={disabled} onChange={event => { const next = event.target.value; setText(next); if (creating) onChange(type.endsWith('[]') ? next.split(',').map(value => value.trim()).filter(Boolean) : next === '' ? (required ? '' : null) : type === 'number' ? Number(next) : next); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') setText(rendered); }} />{error && <small id={errorId} className="creation-field-error">{error}</small>}</label>;
}

export function EntityFields({ kind, values, files, configuration, disabled = false, creating = false, section = 'all', exclude = [], en = true, errors = {}, onChange }: { kind: EntityKind; values: Record<string, unknown>; files: FileRecord[]; configuration: ProtocolConfiguration; disabled?: boolean; creating?: boolean; section?: 'all' | 'properties' | 'relations'; exclude?: readonly string[]; en?: boolean; errors?: Readonly<Record<string, string>>; onChange: (changes: Record<string, unknown>) => void }) {
  const relations = relationFields(configuration).filter(field => field.entities.includes(kind));
  const errorPrefix = useId();
  const workflow = workflowFor(kind, configuration);
  const zh: Record<string, string> = { title: '标题', project: '项目', status: '状态', kind: '类型', parent: '父项', priority: '优先级', assignee: '负责人', owner: '所有者', labels: '标签', due: '截止日期', start: '开始日期', 'x-pm-start': '开始日期', 'x-pm-estimate': '估算点', 'x-pm-location': '位置', cycle: 'Sprint（周期）', milestone: '里程碑', module: '模块', requirement: '需求', release: '发布', goals: '目标', related_to: '关联对象', blocked_by: '阻塞项', depends_on: '依赖项目', document_kind: '文档类型', target: '目标值', unit: '单位', version: '版本', estimated_duration_days: '预计持续天数' };
  const fields = [
    ...fieldRegistry.filter(field => field.editable && field.name !== 'archived' && field.entities.includes(kind)).map(field => ({ ...field, label: !en && zh[field.name] ? zh[field.name]! : field.name === 'cycle' ? 'Sprint (cycle)' : field.name.replaceAll('_', ' '), required: field.name === 'status' || !field.nullable, options: field.type.startsWith('enum:') ? field.type.slice(5).split('|') : undefined, min: undefined as number | undefined, max: undefined as number | undefined })),
    ...configuration.custom_fields.filter(field => field.entities.includes(kind)).map(field => ({ ...field, type: field.type === 'text' ? 'string' : field.type, required: field.required || false })),
  ];
  return <>{fields.filter(field => !exclude.includes(field.name) && (section === 'all' || (section === 'relations') === relations.some(ref => ref.name === field.name))).map(field => {
    const reference = relations.find(ref => ref.name === field.name);
    const value = values[field.name];
    const save = (next: unknown) => onChange({ [field.name]: next });
    const error = errors[field.name];
    const errorId = `${errorPrefix}-${field.name}`;
    const errorProps = { 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined };
    let options = field.options?.map(option => ({ value: option, label: option, disabled: false }));
    if (field.name === 'status') options = workflow?.states.map(state => ({ value: state.id, label: `${state.label} · ${state.category}`, disabled: !creating && value !== state.id && !workflow.transitions.some(t => t.from === value && t.to === state.id) }));
    if (reference) options = files.filter(file => file.id !== values.id && (!reference.target || file.entity.entity === (reference.target === 'self' ? kind : reference.target)) && (!reference.scoped || file.entity.project === (values.project || undefined))).map(file => ({ value: file.id, label: `${file.id} · ${file.entity.title}${file.entity.archived ? ' (archived)' : ''}`, disabled: false }));
    if (field.type === 'boolean') return <label className="property-field" key={field.name}><span>{field.label}</span><RadixSelect aria-label={`Property ${field.name.replaceAll('_', ' ')}`} {...errorProps} data-testid={`field-${field.name}`} value={value === undefined || value === null ? '' : String(value)} disabled={disabled} onChange={event => save(event.target.value === '' ? null : event.target.value === 'true')}><option value="" disabled={field.required}>{en ? 'Unset' : '未设置'}</option><option value="true">{en ? 'True' : '是'}</option><option value="false">{en ? 'False' : '否'}</option></RadixSelect>{error && <small id={errorId} className="creation-field-error">{error}</small>}</label>;
    if (options) {
      const multiple = reference?.multiple || field.type === 'multi_select';
      const selected = multiple ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? (creating && field.name === 'status' ? workflow?.initial ?? '' : ''));
      const missing = (Array.isArray(selected) ? selected : selected ? [selected] : []).filter(id => !options!.some(option => option.value === id));
      return <label className="property-field" key={field.name}><span>{field.label}{multiple ? en ? ' (multiple)' : '（多选）' : ''}</span><RadixSelect name={field.name} multiple={multiple} required={field.required} aria-label={`Property ${field.name.replaceAll('_', ' ')}`} {...errorProps} data-testid={`field-${field.name}`} disabled={disabled} value={selected} onChange={event => save(multiple ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value || null)}>{!multiple && <option value="" disabled={field.required}>{en ? 'Unset' : '未设置'}</option>}{missing.map(id => <option key={id} value={id}>{id} {en ? '(unavailable)' : '（不可用）'}</option>)}{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</RadixSelect>{error && <small id={errorId} className="creation-field-error">{error}</small>}</label>;
    }
    return <TextField key={`${kind}-${field.name}`} name={field.name} label={field.label} value={value} type={field.type} required={field.required} min={field.min} max={field.max} disabled={disabled} creating={creating} error={error} onChange={save} />;
  })}</>;
}
