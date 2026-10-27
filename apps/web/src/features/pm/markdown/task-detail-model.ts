import { parseMarkdown, patchMarkdown } from '../../../../../../packages/pm-markdown/index.ts';
import { ProtocolError, workflowFor, type Entity, type FileRecord, type ProtocolConfiguration } from '../../../../../../packages/pm-schema/index.ts';

function taskEntity(file: FileRecord, raw: string, configuration: ProtocolConfiguration): Entity {
  const entity = parseMarkdown(raw, configuration);
  const immutable = (['id', 'schema', 'entity'] as const).find(field => entity[field] !== file.entity[field]);
  if (immutable || entity.entity !== 'work_item') throw new ProtocolError([{
    code: 'IMMUTABLE_FIELD', severity: 'error', path: file.path, entityId: file.id, field: immutable || 'entity',
    message: `The ${immutable || 'entity'} field cannot be changed.`,
  }]);
  if (file.entity.archived || entity.archived) throw new Error('Archived sources are read-only.');
  return entity;
}

/** Staging is not a workflow transition. Save validates the final source against the saved entity. */
export function patchTaskDraftRaw(file: FileRecord, raw: string, changes: Record<string, unknown>, configuration: ProtocolConfiguration): string {
  const entity = taskEntity(file, raw, configuration);
  const workflow = workflowFor('work_item', configuration);
  const status = changes.status;
  const localConfiguration = workflow && typeof status === 'string' && status !== entity.status
    ? { ...configuration, workflows: { ...configuration.workflows, work_item: { ...workflow, transitions: [...workflow.transitions, { from: entity.status!, to: status }] } } }
    : configuration;
  return patchMarkdown(raw, changes, localConfiguration);
}

/** Use the current parsed checklist, never a saved projection or a checklist-looking code line. */
export function toggleTaskChecklistRaw(file: FileRecord, raw: string, line: number, configuration: ProtocolConfiguration, expectedLine?: string): string {
  const entity = taskEntity(file, raw, configuration);
  const lines = raw.split('\n');
  const marker = /^([\t ]*(?:>[\t ]*)*(?:[-+*]|\d+[.)])[\t ]+\[)([ xX])(\])/;
  const currentLine = lines[line - 1] || '';
  const changed = expectedLine !== undefined && currentLine.replace(marker, '$1 $3') !== expectedLine.replace(marker, '$1 $3');
  if (!Number.isSafeInteger(line) || changed || !entity.checklist.some(item => item.line === line) || !marker.test(currentLine)) {
    throw new Error('This checklist line moved. Refresh the preview before editing.');
  }
  lines[line - 1] = currentLine.replace(marker, (_, prefix: string, checked: string, suffix: string) => `${prefix}${checked === ' ' ? 'x' : ' '}${suffix}`);
  return lines.join('\n');
}
