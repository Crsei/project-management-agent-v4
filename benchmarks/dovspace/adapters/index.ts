import type { Arm } from '../schemas/types.ts';
import { AgentChatAdapter } from './agent-chat.ts';

/** Same real model/runtime/tool rights; only source-derived workflow context differs. */
export function createAdapter(arm: Arm): AgentChatAdapter { return new AgentChatAdapter(arm); }
export { AgentChatAdapter, AdapterError } from './agent-chat.ts';
export { parseSse } from './sse.ts';
export class RawBaselineAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('raw', transport); } }
export class KnowledgeAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('knowledge', transport); } }
export class DovspaceAdapter extends AgentChatAdapter { constructor(transport: typeof fetch = fetch) { super('dovspace', transport); } }
