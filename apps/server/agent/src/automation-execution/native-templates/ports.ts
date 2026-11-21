import type { StudioExecutionRequest, StudioNativeTemplateId } from '../../../../../../packages/contracts/src/automation-studio.ts';
import type { PmAutomationSnapshot, PmAutomationResult } from '../../../../../../packages/contracts/src/automation-pm.ts';

export type NativeTemplateId = StudioNativeTemplateId;
export type NativeTemplateState = { revision: number; value: unknown };
export type NativeAgentResult = {
  threadId: string; status: 'completed' | 'failed' | 'outcome_unknown'; text: string;
};
export type NativeTemplateOutcome = { summary: string; threadIds: string[]; details?: Record<string, unknown> };
export class NativeTemplateUnknownOutcome extends Error {
  readonly code = 'outcome_unknown';
  constructor(message: string) { super(message); this.name = 'NativeTemplateUnknownOutcome'; }
}
/** Every operation is bound to the original actor/workspace/project/definition/execution by the host. */
export interface NativeTemplateContext {
  readonly request: StudioExecutionRequest;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly now: Date;
  log(message: string): void;
  state: {
    read(key: string): Promise<NativeTemplateState | null>;
    compareAndSet(key: string, expectedRevision: number | null, value: unknown): Promise<NativeTemplateState>;
    /** Returns false when another live or unknown delivery already owns the key. */
    claim(key: string, value: unknown): Promise<boolean>;
  };
  /** Fixed connector origin; writes require a stable operationKey and must never blindly retry unknown results. */
  requestJson<T = unknown>(provider: 'github' | 'gitlab', apiPath: string, options?: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; operationKey?: string }): Promise<T>;
  /** Stable key reconciles an existing persisted scoped Chat instead of redispatching. */
  runAgent(input: { key: string; prompt: string; analysisSkill?: string }): Promise<NativeAgentResult>;
  /** PM data/results stay authoritative in the PM application; this port grants no business writes. */
  pm?: { snapshot(): Promise<PmAutomationSnapshot>; publish(result: PmAutomationResult): Promise<void> };
}
export type NativeTemplateHandler = (context: NativeTemplateContext) => Promise<NativeTemplateOutcome>;
