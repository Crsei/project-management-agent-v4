import { createHash } from 'node:crypto';
import { pmToolCallRecordSchema } from '../../../packages/agent-contracts/src/pm-tools.ts';
import { canonical } from '../fixtures/snapshot.ts';
import { measureBriefBytes, type BriefByteMeasurement } from './measurement.ts';

export interface BriefWireObservation {
  pointer: string; operationId: string; requestUtf8Bytes: number; requestSha256: string;
  toolTextUtf8Bytes: number; literal: string;
  outerSources: { occurrences: number; distinct: number; repeatedOccurrences: number; entries: unknown[] };
  measurement: BriefByteMeasurement;
}

/** Input MUST be the actual forwarded provider request body, not reconstructed Host content/details, trace prose or a PM HTTP result. */
export function observeBriefsInProviderRequest(requestBody: string): BriefWireObservation[] {
  const request: unknown = JSON.parse(requestBody);
  if (!request || typeof request !== 'object') throw new Error('Provider request must be a JSON object');
  const texts: { pointer: string; literal: string }[] = [];
  if ('messages' in request && Array.isArray(request.messages)) {
    request.messages.forEach((message: unknown, index: number) => {
      if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'tool' && message.role !== 'function' || !('content' in message)) return;
      if (typeof message.content === 'string') texts.push({ pointer: `/messages/${index}/content`, literal: message.content });
      else if (Array.isArray(message.content)) message.content.forEach((block: unknown, blockIndex: number) => {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') texts.push({ pointer: `/messages/${index}/content/${blockIndex}/text`, literal: block.text });
      });
    });
  }
  if ('input' in request && Array.isArray(request.input)) {
    request.input.forEach((item: unknown, index: number) => {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output' && 'output' in item && typeof item.output === 'string') texts.push({ pointer: `/input/${index}/output`, literal: item.output });
    });
  }
  const observations: BriefWireObservation[] = [];
  for (const text of texts) {
    let decoded: unknown;
    try { decoded = JSON.parse(text.literal); } catch { continue; }
    const parsed = pmToolCallRecordSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.name !== 'pm_task_brief' || parsed.data.status !== 'succeeded' || parsed.data.result?.kind !== 'task_brief') continue;
    const result = parsed.data.result;
    // Full structured value equality, not a partial identity/revision key. This only observes; it does not mutate or remove source roles.
    const entries = result.sources.map(source => canonical(source)), distinct = new Set(entries).size;
    observations.push({ pointer: text.pointer, operationId: parsed.data.operationId, requestUtf8Bytes: Buffer.byteLength(requestBody, 'utf8'), requestSha256: createHash('sha256').update(requestBody).digest('hex'),
      toolTextUtf8Bytes: Buffer.byteLength(text.literal, 'utf8'), literal: text.literal,
      outerSources: { occurrences: entries.length, distinct, repeatedOccurrences: entries.length - distinct, entries: result.sources },
      measurement: measureBriefBytes(result.brief, result) });
  }
  return observations;
}
