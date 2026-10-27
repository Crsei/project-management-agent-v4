import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Capability, Entity } from '../../domain/src/core.ts';
import { assertProjectWritable, assertRule, assertStatus } from '../../domain/src/planning.ts';
import type { CommandContext, CommandDefinition, CommandRegistry } from './ports.ts';

const uuid = z.uuid().toLowerCase();
const text = z.string().trim().min(1).max(16000);
const entityKinds = ['project', 'work_item', 'milestone', 'conversation', 'intent', 'decision', 'upload', 'artifact', 'artifact_version', 'evidence', 'submission', 'review'] as const;
const entityId = z.string().regex(/^(?:[A-Z][A-Z0-9]*-\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, 'Expected an entity ID');
const entityRef = z.strictObject({ kind: z.enum(entityKinds), id: entityId });
const basisRefs = z.array(entityRef).max(100).default([]);
const sourceMessageRefs = z.array(z.strictObject({ messageId: uuid, contentVersion: z.number().int().positive() })).max(100).default([]);
const intentFields = { summary: z.string().trim().min(1).max(1000), goal: text, conversationId: uuid.nullable().default(null), sourceMessageRefs };

function command(payload: CommandDefinition['payload'], handler: CommandDefinition['handler']): CommandDefinition {
  return { payload, handler };
}

function targetId(ctx: CommandContext): string {
  if (!ctx.command.targetId) throw new DomainError('target_required');
  return ctx.command.targetId;
}

async function scope(ctx: CommandContext, projectId: string | null, capability: Capability): Promise<void> {
  await ctx.require(capability, projectId);
  assertRule(!ctx.command.projectId || ctx.command.projectId === projectId, 'project_mismatch');
  if (projectId) assertProjectWritable(await ctx.get(projectId, 'project'));
}

async function existingIntent(ctx: CommandContext, capability: Capability): Promise<Entity> {
  const entity = await ctx.get(targetId(ctx), 'intent');
  await scope(ctx, entity.projectId, capability);
  ctx.checkVersion(entity);
  assertStatus(entity, ['proposed']);
  return entity;
}

async function validateSources(ctx: CommandContext, projectId: string | null, payload: Record<string, any>): Promise<void> {
  const refs = payload.sourceMessageRefs as { messageId: string; contentVersion: number }[];
  assertRule(new Set(refs.map(ref => ref.messageId)).size === refs.length, 'duplicate_message_reference');
  assertRule(payload.conversationId || refs.length === 0, 'conversation_required');
  if (!payload.conversationId) return;
  const conversation = await ctx.get(payload.conversationId, 'conversation');
  assertRule(conversation.projectId === projectId, 'project_mismatch');
  const messages = conversation.data.messages as { id: string; contentVersion: number }[];
  for (const ref of refs) assertRule(messages.some(message => message.id === ref.messageId && message.contentVersion === ref.contentVersion), 'source_message_mismatch');
}

async function validateBasis(ctx: CommandContext, refs: { kind: any; id: string }[], projectId: string | null): Promise<void> {
  assertRule(new Set(refs.map(ref => `${ref.kind}:${ref.id}`)).size === refs.length, 'duplicate_basis_reference');
  for (const ref of refs) {
    const entity = await ctx.get(ref.id, ref.kind);
    const actualProjectId = entity.kind === 'project' ? entity.id : entity.projectId;
    assertRule(actualProjectId === projectId, 'project_mismatch');
  }
}

async function decide(ctx: CommandContext, accepted: boolean): Promise<unknown> {
  const entity = await existingIntent(ctx, 'intent.decide');
  const p = ctx.command.payload;
  assertRule(entity.data.revision === p.revision, 'intent_revision_mismatch');
  await validateBasis(ctx, p.basisRefs as any, entity.projectId);
  const decision = await ctx.insert('decision', {
    subjectRef: { kind: 'intent', id: entity.id }, decisionType: accepted ? 'accept_intent' : 'reject_intent', actorId: ctx.actor.id,
    reason: p.reason, basisRefs: p.basisRefs, supersedesDecisionId: null,
    ...(accepted ? { acceptedRevision: entity.data.revision } : { rejectedRevision: entity.data.revision }),
  }, entity.projectId);
  const result = await ctx.update(entity, { ...entity.data, status: accepted ? 'accepted' : 'rejected', acceptedDecisionId: accepted ? decision.id : null, terminalDecisionId: decision.id });
  await ctx.emit('DecisionRecorded', decision);
  await ctx.emit(accepted ? 'IntentAccepted' : 'IntentRejected', result, { decisionId: decision.id, revision: entity.data.revision });
  return { intent: result, decision };
}

// Conversation message entries are immutable snapshots in this initial JSONB
// aggregate. A message contains id/authorId/content/contentVersion/createdAt.
// Decision subjectRef/basisRefs use {kind,id}; generic decisions cannot perform
// AcceptIntent/RejectIntent or alter previously created planning objects.
export const intentCommands: CommandRegistry = {
  CreateConversation: command(z.strictObject({ title: z.string().trim().min(1).max(300) }), async ctx => {
    assertRule(!ctx.command.targetId, 'invalid_scope');
    const projectId = ctx.command.projectId ?? null;
    await scope(ctx, projectId, 'intent.propose');
    const entity = await ctx.insert('conversation', { ...ctx.command.payload, messages: [] }, projectId);
    await ctx.emit('ConversationCreated', entity);
    return entity;
  }),

  AppendMessage: command(z.strictObject({ content: text }), async ctx => {
    const entity = await ctx.get(targetId(ctx), 'conversation');
    await scope(ctx, entity.projectId, 'intent.propose');
    ctx.checkVersion(entity);
    const message = { id: randomUUID(), authorId: ctx.actor.id, content: ctx.command.payload.content, contentVersion: 1, createdAt: new Date().toISOString() };
    const result = await ctx.update(entity, { ...entity.data, messages: [...entity.data.messages, message] });
    await ctx.emit('MessageAppended', result, { messageId: message.id, authorId: ctx.actor.id, contentVersion: 1 });
    return { conversation: result, message };
  }),

  ProposeIntent: command(z.strictObject(intentFields), async ctx => {
    assertRule(!ctx.command.targetId, 'invalid_scope');
    const projectId = ctx.command.projectId ?? null;
    await scope(ctx, projectId, 'intent.propose');
    await validateSources(ctx, projectId, ctx.command.payload);
    const entity = await ctx.insert('intent', { ...ctx.command.payload, revision: 1, status: 'proposed', acceptedDecisionId: null }, projectId);
    await ctx.emit('IntentProposed', entity);
    return entity;
  }),

  ReviseIntent: command(z.strictObject({ ...intentFields, revision: z.number().int().positive() }), async ctx => {
    const entity = await existingIntent(ctx, 'intent.propose');
    const p = ctx.command.payload;
    assertRule(entity.data.revision === p.revision, 'intent_revision_mismatch');
    await validateSources(ctx, entity.projectId, p);
    const result = await ctx.update(entity, { ...entity.data, ...p, revision: entity.data.revision + 1 });
    await ctx.emit('IntentRevised', result, { revision: result.data.revision });
    return result;
  }),

  AcceptIntent: command(z.strictObject({ revision: z.number().int().positive(), reason: text, basisRefs }), ctx => decide(ctx, true)),
  RejectIntent: command(z.strictObject({ revision: z.number().int().positive(), reason: text, basisRefs }), ctx => decide(ctx, false)),

  WithdrawIntent: command(z.strictObject({ reason: text }), async ctx => {
    const entity = await ctx.get(targetId(ctx), 'intent');
    await scope(ctx, entity.projectId, entity.createdBy === ctx.actor.id ? 'intent.propose' : 'intent.decide');
    ctx.checkVersion(entity);
    assertStatus(entity, ['proposed']);
    const result = await ctx.update(entity, { ...entity.data, status: 'withdrawn', withdrawalRecord: { reason: ctx.command.payload.reason, withdrawnBy: ctx.actor.id, withdrawnAt: new Date().toISOString() } });
    await ctx.emit('IntentWithdrawn', result);
    return result;
  }),

  RecordDecision: command(z.strictObject({ subjectRef: entityRef, decisionType: z.enum(['note', 'supersede']), reason: text, basisRefs, supersedesDecisionId: uuid.nullable().default(null) }), async ctx => {
    assertRule(!ctx.command.targetId, 'invalid_scope');
    const p = ctx.command.payload as any;
    const subject = await ctx.get(p.subjectRef.id, p.subjectRef.kind);
    const projectId = subject.kind === 'project' ? subject.id : subject.projectId;
    await scope(ctx, projectId, 'intent.decide');
    await validateBasis(ctx, p.basisRefs, projectId);
    assertRule((p.decisionType === 'supersede') === Boolean(p.supersedesDecisionId), 'superseded_decision_required');
    if (p.supersedesDecisionId) {
      const previous = await ctx.get(p.supersedesDecisionId, 'decision');
      // A new Intent may supersede a decision about an earlier Intent. This is
      // a new historical record and cannot undo that decision's WorkItem.
      assertRule(previous.projectId === projectId, 'project_mismatch');
    }
    const entity = await ctx.insert('decision', { ...p, actorId: ctx.actor.id }, projectId);
    await ctx.emit('DecisionRecorded', entity);
    return entity;
  }),
};
