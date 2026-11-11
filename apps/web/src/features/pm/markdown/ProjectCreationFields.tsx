import { useEffect, useId, useRef, useState, type CSSProperties, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Asterisk, Briefcase, CalendarDays, Check, CircleDashed, Code, File, Folder, Globe, Heart, Layers, Megaphone, Palette, Rocket, Target } from 'lucide-react';
import { useMemberDirectory } from '../service/pm-member-hooks';
import { PROJECT_COLORS, PROJECT_ICONS } from '../service/project-menu-model';
import { usePmService } from '../service/pm-service';
import { allowed } from '../service/pm-ui';
import { RadixSelect } from "@/components/ui/radix-select"

const projectIcons = { folder: Folder, briefcase: Briefcase, layers: Layers, rocket: Rocket, globe: Globe, target: Target, code: Code, palette: Palette };
const iconLabels: Record<typeof PROJECT_ICONS[number], [string, string]> = {
  folder: ['文件夹', 'Folder'], briefcase: ['公文包', 'Briefcase'], layers: ['图层', 'Layers'], rocket: ['火箭', 'Rocket'],
  globe: ['地球', 'Globe'], target: ['目标', 'Target'], code: ['代码', 'Code'], palette: ['调色板', 'Palette'],
};
const colorLabels: Record<typeof PROJECT_COLORS[number], [string, string]> = {
  '#2F2E2A': ['炭灰', 'Charcoal'], '#5A67D8': ['靛蓝', 'Indigo'], '#3B82C4': ['蓝色', 'Blue'],
  '#23918A': ['青绿', 'Teal'], '#C54B78': ['玫红', 'Rose'], '#C48A1E': ['琥珀', 'Amber'],
};
const templates = [
  { id: 'blank', zh: '空白项目', en: 'Blank project', Icon: File },
  { id: 'product', zh: '产品开发', en: 'Product Development', Icon: Target },
  { id: 'web', zh: '网站', en: 'Website', Icon: Globe },
  { id: 'mkt', zh: '营销活动', en: 'Marketing Campaign', Icon: Megaphone },
  { id: 'design', zh: '设计项目', en: 'Design Project', Icon: Palette },
  { id: 'software', zh: '软件开发', en: 'Software Development', Icon: Code },
  { id: 'personal', zh: '个人项目', en: 'Personal Project', Icon: Heart },
];

function ProjectFieldLabel({ children, required = false, en }: { children: string; required?: boolean; en: boolean }) {
  const Icon = required ? Asterisk : CircleDashed;
  return <span className="project-creation-label"><span>{children}</span><span className="project-creation-requirement" data-required={required || undefined}><Icon size={11} aria-hidden="true" />{required ? en ? 'Required' : '必填' : en ? 'Optional' : '可选'}</span></span>;
}

function ProjectInput({ value, onChange, pickerLabel, ...props }: InputHTMLAttributes<HTMLInputElement> & { value: string; pickerLabel?: string }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pending.current !== undefined && value !== pending.current && !props.disabled) return;
    pending.current = undefined;
    if (props.disabled || document.activeElement !== input.current) setText(value);
  }, [props.disabled, value]);
  const field = <input {...props} ref={input} value={text} onChange={event => { pending.current = event.target.value; setText(event.target.value); onChange?.(event); }} />;
  return props.type === 'date' ? <span className="project-creation-date">{field}<button type="button" className="project-creation-date-button" disabled={props.disabled} aria-label={pickerLabel} title={pickerLabel} onClick={() => { input.current?.focus(); input.current?.showPicker?.(); }}><CalendarDays size={16} aria-hidden="true" /></button></span> : field;
}

function ProjectDescription({ value, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pending.current !== undefined && value !== pending.current && !props.disabled) return;
    pending.current = undefined;
    if (props.disabled || document.activeElement !== input.current) setText(value);
  }, [props.disabled, value]);
  return <textarea {...props} ref={input} value={text} onChange={event => { pending.current = event.target.value; setText(event.target.value); onChange?.(event); }} />;
}

export interface ProjectCreationFieldsProps {
  values: Record<string, unknown>;
  body: string;
  disabled: boolean;
  en: boolean;
  errors: Readonly<Record<string, string>>;
  onChange: (values: Record<string, unknown>) => void;
  onBodyChange: (body: string) => void;
}

export function ProjectCreationFields({ values, body, disabled, en, errors, onChange, onBodyChange }: ProjectCreationFieldsProps) {
  const uid = useId();
  const directory = useMemberDirectory();
  const { workspace } = usePmService();
  const canReadDirectory = allowed(workspace, 'access.manage') || workspace?.capabilities.includes('directory.read') === true;
  const t = (zh: string, english: string) => en ? english : zh;
  const icon = String(values['x-pm-icon'] ?? '');
  const color = String(values['x-pm-color'] ?? '');
  const PreviewIcon = projectIcons[icon as keyof typeof projectIcons] ?? Folder;
  const owner = String(values.owner ?? '');
  // A redacted access record is not proof of permission to a not-yet-created project.
  const members = directory.error ? [] : directory.data?.members.filter(member => member.access && !member.access.revokedAt && member.access.capabilities.includes('domain.read') && member.access.projectIds === null) ?? [];
  const ownerUnavailable = !!owner && !!directory.data && !directory.error && !members.some(member => member.userId === owner);
  const errorProps = (name: string) => ({ 'aria-invalid': !!errors[name], 'aria-describedby': errors[name] ? `${uid}-${name}-error` : undefined });
  const fieldError = (name: string) => errors[name] && <small id={`${uid}-${name}-error`} className="creation-field-error" role="alert">{errors[name]}</small>;
  const previewColor = PROJECT_COLORS.find(value => value === color) ?? PROJECT_COLORS[0];

  return <div className="project-creation-fields">
    <div className="project-creation-name-row">
      <span className="project-creation-preview" style={{ '--project-color': previewColor } as CSSProperties} aria-hidden="true"><PreviewIcon size={19} /></span>
      <label htmlFor={`${uid}-name`}><ProjectFieldLabel required en={en}>{t('项目名称', 'Project name')}</ProjectFieldLabel><ProjectInput id={`${uid}-name`} name="title" data-testid="new-task-title" aria-label={t('项目名称', 'Project name')} {...errorProps('title')} value={String(values.title ?? '')} disabled={disabled} required autoFocus placeholder={t('例如：网站改版', 'e.g. Website Redesign')} onChange={event => onChange({ title: event.target.value })} />{fieldError('title')}</label>
    </div>
    <label htmlFor={`${uid}-description`}><ProjectFieldLabel en={en}>{t('描述', 'Description')}</ProjectFieldLabel><ProjectDescription id={`${uid}-description`} name="body" aria-label={t('项目描述', 'Project description')} {...errorProps('body')} value={body} disabled={disabled} rows={2} placeholder={t('这个项目要做什么？', 'What is this project about?')} onChange={event => onBodyChange(event.target.value)} />{fieldError('body')}</label>
    <div className="project-creation-identity">
      <fieldset className="project-creation-choice-group" role="radiogroup" aria-label={t('图标', 'Icon')} aria-invalid={!!errors['x-pm-icon']} aria-describedby={errors['x-pm-icon'] ? `${uid}-x-pm-icon-error` : undefined}>
        <legend><ProjectFieldLabel en={en}>{t('图标', 'Icon')}</ProjectFieldLabel></legend>
        <div className="project-creation-icon-grid">
          {PROJECT_ICONS.map(value => {
            const Icon = projectIcons[value];
            const label = en ? iconLabels[value][1] : iconLabels[value][0];
            return <label key={value} className="project-creation-icon-option" title={label}>
              <input className="project-creation-radio" type="radio" name={`${uid}-icon`} value={value} checked={icon === value} disabled={disabled} aria-label={label} data-testid={`project-icon-${value}`} onChange={() => onChange({ 'x-pm-icon': value })} />
              <span><Icon size={16} aria-hidden="true" /><small>{label}</small></span>
            </label>;
          })}
        </div>
        {fieldError('x-pm-icon')}
      </fieldset>
      <fieldset className="project-creation-choice-group" role="radiogroup" aria-label={t('颜色', 'Color')} aria-invalid={!!errors['x-pm-color']} aria-describedby={errors['x-pm-color'] ? `${uid}-x-pm-color-error` : undefined}>
        <legend><ProjectFieldLabel en={en}>{t('颜色', 'Color')}</ProjectFieldLabel></legend>
        <div className="project-creation-swatches">
          {PROJECT_COLORS.map(value => {
            const label = en ? colorLabels[value][1] : colorLabels[value][0];
            return <label key={value} className="project-creation-color-option" title={label} style={{ '--project-color': value } as CSSProperties}>
              <input className="project-creation-radio" type="radio" name={`${uid}-color`} value={value} checked={color === value} disabled={disabled} aria-label={label} data-testid={`project-color-${value.slice(1)}`} onChange={() => onChange({ 'x-pm-color': value })} />
              <span>{color === value && <Check size={13} strokeWidth={3} aria-hidden="true" />}</span>
            </label>;
          })}
        </div>
        {fieldError('x-pm-color')}
      </fieldset>
    </div>
    <div className="project-creation-metadata">
      <label htmlFor={`${uid}-team`}><ProjectFieldLabel en={en}>{t('团队', 'Team')}</ProjectFieldLabel><RadixSelect id={`${uid}-team`} disabled aria-label={t('团队（创建后关联）', 'Team (link after creation)')}><option>{t('创建后关联', 'Link after creation')}</option></RadixSelect></label>
      <label htmlFor={`${uid}-owner`}><ProjectFieldLabel en={en}>{t('负责人', 'Lead')}</ProjectFieldLabel><RadixSelect id={`${uid}-owner`} name="owner" data-testid="field-owner" aria-label={t('项目负责人', 'Project lead')} {...errorProps('owner')} value={owner} disabled={disabled || !canReadDirectory || !!directory.error || !directory.data} onChange={event => onChange({ owner: event.target.value || null })}>
        <option value="">{t('未分配', 'Unassigned')}</option>
        {owner && !members.some(member => member.userId === owner) && <option value={owner} disabled>{t('草稿负责人待确认', 'Draft lead unavailable')} · {owner}</option>}
        {members.map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}
      </RadixSelect>{fieldError('owner')}</label>
      <label htmlFor={`${uid}-due`}><ProjectFieldLabel en={en}>{t('目标日期', 'Target date')}</ProjectFieldLabel><ProjectInput id={`${uid}-due`} name="due" data-testid="field-due" aria-label={t('项目目标日期', 'Project target date')} pickerLabel={t('选择项目目标日期', 'Choose project target date')} type="date" {...errorProps('due')} value={String(values.due ?? '')} disabled={disabled} onChange={event => onChange({ due: event.target.value || null })} />{fieldError('due')}</label>
    </div>
    {!canReadDirectory && <p className="project-creation-hint" role="status">{t('当前账号无成员目录读取权限，负责人选择不可用；可先不分配，不会自动授予成员权限。', 'Lead selection requires member-directory access. You may leave the lead unassigned; no member permissions are granted automatically.')}</p>}
    {canReadDirectory && directory.isPending && <p className="project-creation-hint" role="status">{t('正在读取有权访问新项目的成员…', 'Reading members authorized to access new projects…')}</p>}
    {directory.error && <div className="creation-alert" role="alert"><p>{t('成员目录读取失败，无法确认可选负责人；原草稿保留，不会以样例成员代替。', 'The member directory could not be read. Lead selection is unavailable; your draft is retained without sample members.')}</p><p>{directory.error.message}</p><button type="button" className="secondary-button" disabled={directory.isFetching} onClick={() => { void directory.refetch(); }}>{t('重新读取成员', 'Read members again')}</button></div>}
    {ownerUnavailable && <p className="creation-alert" role="status">{t('原草稿负责人当前没有已确认的新项目访问权限。请重新选择；不会自动改派或扩大授权。', 'The draft lead has no confirmed access to a new project. Choose an authorized member; no reassignment or access grant is automatic.')}</p>}
    {directory.data && !directory.error && members.length === 0 && <p className="project-creation-hint" role="status">{t('当前目录没有可确认的新项目负责人。可先不分配，创建后在项目设置中选择。', 'No eligible new-project lead is confirmed in the current directory. Leave unassigned and choose a lead in project settings later.')}</p>}
    <fieldset className="project-creation-choice-group project-creation-templates" role="radiogroup" aria-label={t('模板', 'Template')} aria-describedby={`${uid}-template-hint`}>
      <legend>{t('模板', 'Template')}</legend>
      <div className="project-creation-template-grid">{templates.map(({ id, zh, en: english, Icon }) => <label key={id} className="project-creation-template-option">
        <input className="project-creation-radio" type="radio" name={`${uid}-template`} value={id} checked={id === 'blank'} disabled={disabled || id !== 'blank'} readOnly aria-label={en ? english : zh} />
        <span className="project-creation-template-card"><Icon size={17} aria-hidden="true" /><strong>{en ? english : zh}</strong><span>{id === 'blank' ? t('从零开始', 'Start from scratch') : t('暂不可用', 'Not available yet')}</span></span>
      </label>)}</div>
      <p className="project-creation-hint" id={`${uid}-template-hint`}>{t('此表单目前仅支持空白项目；其他参考模板尚未接入。新工作区会独立初始化内置 Nova 示例项目，不复制其他实例的账号、权限或历史。', 'This form currently supports Blank project only; other reference templates are not connected. New workspaces receive an independent built-in Nova sample project, without copying accounts, permissions or history from another instance.')}</p>
    </fieldset>
  </div>;
}
