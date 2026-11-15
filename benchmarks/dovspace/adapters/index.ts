import { ControlTransportSchema, type Arm, type BenchAgentAdapter, type ControlTransport } from '../schemas/types.ts';
import { AgentChatAdapter } from './agent-chat.ts';
import { ProductCliAdapter } from './product-cli.ts';

/** Control transport is fixed across arms; source-derived workflow context remains the treatment. */
export function createAdapter(arm: Arm, controlTransport: ControlTransport = 'http'): BenchAgentAdapter {
  return ControlTransportSchema.parse(controlTransport) === 'cli' ? new ProductCliAdapter(arm) : new AgentChatAdapter(arm);
}
export { AgentChatAdapter, AdapterError } from './agent-chat.ts';
export { ProductCliAdapter } from './product-cli.ts';
export { parseSse } from './sse.ts';
export class RawBaselineAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('raw', transport); } }
export class KnowledgeAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('knowledge', transport); } }
export class DovspaceAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('dovspace', transport); } }
