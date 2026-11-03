import { useState } from 'react';
import { ChevronDown, Plus, Save, Trash2 } from 'lucide-react';
import type { ArchiveFilter } from '@pm-views';
import type { WorkspaceController } from './controller';
import {
  taskFilterFieldLabel,
  taskFilterFields,
  taskFilterOperatorLabel,
  taskFilterOptions,
  taskFilterValueSummary,
  type TaskFilterCondition,
  type TaskFilterField,
} from './task-filter';
import { RadixSelect } from "@/components/ui/radix-select"

interface Props {
  controller: WorkspaceController;
  en: boolean;
  projectId?: string;
  today?: string | null;
  actors?: readonly { id: string; name: string }[];
  onClose: () => void;
  onSavedView: (id: string) => void;
}

export default function TaskFilterCard({ controller: c, en, projectId, today, actors, onClose, onSavedView }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const t = (english: string, chinese: string) => en ? english : chinese;
  const conditions = c.prefs.conditions;
  const projects = c.projects.map(file => ({ id: file.id, title: file.entity.title }));
  const fixedProject = projectId ? projects.find(project => project.id === projectId)?.title ?? projectId : null;
  const optionsFor = (field: TaskFilterField) => taskFilterOptions(field, { en, configuration: c.configuration, files: c.files, actors, projects });
  const update = (next: TaskFilterCondition[]) => c.preference('conditions', next);
  const patch = (index: number, change: Partial<TaskFilterCondition>) => update(conditions.map((condition, current) => current === index ? { ...condition, ...change } : condition));
  const add = (field: TaskFilterField) => {
    update([...conditions, { field, operator: 'is', values: [] }]);
    setExpanded(conditions.length);
  };
  const remove = (index: number) => {
    update(conditions.filter((_, current) => current !== index));
    setExpanded(current => current === null ? null : current === index ? null : current > index ? current - 1 : current);
  };
  const toggleValue = (index: number, value: string) => {
    const current = conditions[index];
    patch(index, { values: current.values.includes(value) ? current.values.filter(entry => entry !== value) : [...current.values, value] });
  };
  const clearAll = () => {
    const { sort, sortDirection } = c.prefs;
    c.clearView();
    c.preference('sort', sort);
    c.preference('sortDirection', sortDirection);
    c.preference('conditions', []);
    if (!projectId) c.preference('project', '');
    c.preference('archived', 'exclude');
    onSavedView('');
  };

  return (
    <div className="task-filter-card">
      <div className="task-filter-card-header">
        <strong>{t('Filter by', '筛选条件')}</strong>
        <button type="button" className="text-button" onClick={clearAll}>{t('Clear all', '清除全部')}</button>
      </div>
      <div className="task-filter-rows">
        {fixedProject && <div className="task-filter-row task-filter-single">
          <span className="task-filter-conjunction">{t('Where', '条件')}</span>
          <label>{t('Project', '项目')}<strong>{fixedProject}</strong></label>
        </div>}
        {!conditions.length && <p className="task-filter-empty">{t('No filters applied. Combine filters to narrow the task list, e.g. Status is In Progress and Assignee is Sarah.', '尚未添加筛选。组合条件可缩小任务范围，例如“状态是进行中”且“负责人是 Sarah”。')}</p>}
        {conditions.map((condition, index) => {
          const options = optionsFor(condition.field);
          const bucket = condition.field === 'due' || condition.field === 'created' || condition.field === 'updated';
          return (
            <div className="task-filter-condition" key={index}>
              <div className="task-filter-row task-filter-condition-row">
                <span className="task-filter-conjunction">{!fixedProject && index === 0 ? t('Where', '条件') : t('and', '且')}</span>
                <label>
                  <RadixSelect className="task-filter-field" aria-label={t('Filter field', '筛选字段')} value={condition.field} onChange={event => patch(index, { field: event.target.value as TaskFilterField, values: [] })}>
                    {taskFilterFields.map(field => <option key={field} value={field}>{taskFilterFieldLabel(field, en)}</option>)}
                  </RadixSelect>
                  <RadixSelect className="task-filter-operator" aria-label={t('Filter operator', '筛选操作符')} value={condition.operator} onChange={event => patch(index, { operator: event.target.value as TaskFilterCondition['operator'] })}>
                    <option value="is">{taskFilterOperatorLabel('is', en)}</option>
                    <option value="isNot">{taskFilterOperatorLabel('isNot', en)}</option>
                  </RadixSelect>
                  {bucket ? (
                    <RadixSelect className="task-filter-value" aria-label={taskFilterFieldLabel(condition.field, en)} value={condition.values[0] ?? ''} onChange={event => patch(index, { values: event.target.value ? [event.target.value] : [] })}>
                      <option value="">{t('Any', '任意')}</option>
                      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </RadixSelect>
                  ) : (
                    <button type="button" className="task-filter-value" aria-expanded={expanded === index} onClick={() => setExpanded(expanded === index ? null : index)}>
                      <span>{taskFilterValueSummary(condition.field, condition.values, options, en)}</span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                  )}
                </label>
                <button type="button" className="task-filter-remove" aria-label={t('Remove filter', '移除筛选')} onClick={() => remove(index)}><Trash2 size={14} aria-hidden="true" /></button>
              </div>
              {expanded === index && !bucket && (
                <div className="task-filter-values">
                  {options.length
                    ? options.map(option => (
                        <label key={option.value}>
                          <input type="checkbox" checked={condition.values.includes(option.value)} onChange={() => toggleValue(index, option.value)} />
                          <span>{option.label}</span>
                        </label>
                      ))
                    : <p>{t('No options available', '暂无可选项')}</p>}
                </div>
              )}
            </div>
          );
        })}
        <div className="task-filter-add">
          <span>{t('Add filter', '添加筛选')}</span>
          {taskFilterFields.map(field => (
            <button key={field} type="button" onClick={() => add(field)} disabled={field === 'due' && !today} title={field === 'due' && !today ? t('Personal date is unavailable', '当前无法读取个人日期') : undefined}>
              <Plus size={12} aria-hidden="true" />{taskFilterFieldLabel(field, en)}
            </button>
          ))}
        </div>
        <div className="task-filter-row task-filter-single">
          <span className="task-filter-conjunction">{t('and', '且')}</span>
          <label>
            {t('Archive', '归档')}
            <RadixSelect aria-label={t('Archive filter', '归档筛选')} data-testid="archive-filter" value={c.prefs.archived} onChange={event => c.preference('archived', event.target.value as ArchiveFilter)}>
              <option value="exclude">{t('Active objects', '活动对象')}</option>
              <option value="include">{t('Include archived', '包含归档')}</option>
              <option value="only">{t('Archived only', '仅归档')}</option>
            </RadixSelect>
          </label>
        </div>
      </div>
      <div className="task-filter-actions">
        <button type="button" className="secondary-button" data-testid="save-view" onClick={() => { onClose(); c.setSaveViewOpen(true); }}><Save size={13} aria-hidden="true" />{t('Edit / save view', '编辑 / 保存视图')}</button>
        <button type="button" className="text-button" onClick={onClose}>{t('Done', '完成')}</button>
      </div>
    </div>
  );
}
