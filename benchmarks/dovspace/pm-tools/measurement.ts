import { createHash } from 'node:crypto';
import type { TaskBrief, TaskBriefSourceRef } from '../../../packages/agent-contracts/src/task-brief.ts';
import type { AgentChatToolResult } from '../../../packages/agent-contracts/src/pm-tool-result.ts';

const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');
export interface BriefByteMeasurement {
  boundary: 'application-brief' | 'pm-service-result';
  serializedUtf8Bytes: number;
  sha256: string;
  bodyUtf8Bytes: number;
  bodyOffsetUnit: 'javascript-utf16-code-units';
  statements: { section: string; index: number; utf8Bytes: number; exactVisibleBodyCopy: boolean; sourceRefs: TaskBriefSourceRef[] }[];
  exactVisibleStatementCopyUtf8Bytes: number;
  outsideVisibleBodyStatementUtf8Bytes: number;
  sourceRefs: { occurrences: number; distinct: number; repeatedOccurrences: number; repeatedSerializedUtf8Bytes: number };
  outerSources: { occurrences: number; distinct: number; repeatedOccurrences: number; repeatedSerializedUtf8Bytes: number } | null;
  modelRequestUtf8Bytes: null;
  tokens: null;
  modelQuality: null;
  notice: string;
}
function repetitions(values: readonly unknown[]) {
  const seen = new Set<string>();
  let repeatedOccurrences = 0, repeatedSerializedUtf8Bytes = 0;
  for (const value of values) {
    const encoded = JSON.stringify(value);
    if (seen.has(encoded)) { repeatedOccurrences++; repeatedSerializedUtf8Bytes += utf8(encoded); }
    else seen.add(encoded);
  }
  return { occurrences: values.length, distinct: seen.size, repeatedOccurrences, repeatedSerializedUtf8Bytes };
}

/** Measure exact literals already present in this returned body page. Never infer a second model copy from MCP/OMP envelope fields. */
export function measureBriefBytes(brief: TaskBrief, result?: AgentChatToolResult): BriefByteMeasurement {
  if (result && (result.kind !== 'task_brief' || result.brief !== brief)) throw new Error('Measurement must identify the actual returned brief, not an unrelated result');
  const sectionNames = ['goals', 'acceptanceCriteria', 'constraints', 'nonGoals'] as const;
  const statements = sectionNames.flatMap(section => brief[section].map((statement, index) => {
    const exactVisibleBodyCopy = statement.sourceRefs.some(ref => {
      if (ref.workspaceId !== brief.task.workspaceId || ref.projectId !== brief.task.projectId || ref.entityId !== brief.task.taskId || ref.kind !== 'work_item' || ref.revision !== brief.task.revision || ref.location.type !== 'body') return false;
      const local = ref.location.offset - brief.task.bodyOffset;
      return local >= 0 && local + ref.location.length <= brief.task.body.length && ref.location.length === statement.text.length && brief.task.body.slice(local, local + ref.location.length) === statement.text;
    });
    return { section, index, utf8Bytes: utf8(statement.text), exactVisibleBodyCopy, sourceRefs: statement.sourceRefs };
  }));
  const refs = [...brief.sources, ...sectionNames.flatMap(section => brief[section].flatMap(statement => statement.sourceRefs)), ...brief.relations.flatMap(relation => [relation.source, relation.target])];
  const encoded = JSON.stringify(result ?? brief);
  return {
    boundary: result ? 'pm-service-result' : 'application-brief', serializedUtf8Bytes: Buffer.byteLength(encoded, 'utf8'), sha256: createHash('sha256').update(encoded).digest('hex'),
    bodyUtf8Bytes: utf8(brief.task.body), bodyOffsetUnit: 'javascript-utf16-code-units', statements,
    exactVisibleStatementCopyUtf8Bytes: statements.filter(statement => statement.exactVisibleBodyCopy).reduce((sum, statement) => sum + statement.utf8Bytes, 0),
    outsideVisibleBodyStatementUtf8Bytes: statements.filter(statement => !statement.exactVisibleBodyCopy).reduce((sum, statement) => sum + statement.utf8Bytes, 0),
    sourceRefs: repetitions(refs), outerSources: result ? repetitions(result.sources) : null,
    modelRequestUtf8Bytes: null, tokens: null, modelQuality: null,
    notice: 'Observed UTF-8 bytes at the named boundary only. Copy-byte components overlap and are not additive savings. Source references in different semantic roles are not automatically removable. Native content/details and MCP content/structuredContent are not counted as two model copies without an actual provider request.',
  };
}
