import { z } from "zod";
import { responseStreamingModeSchema } from "./output.ts";
import { pmReferenceInputSchema, turnContextSchema } from "./pm-references.ts";
import { chatContextAttachmentBindingSchema, chatContextInputSchema } from "./message-context.ts";
import type { ExecutionPolicy, PmReferenceResolution, TurnContext } from "./pm-references.ts";
import type { ProviderOptionSelection } from "./provider.ts";
export { agentWorkspaceSchema, executionSelectionSchema, executionEnvironmentSchema, chatOnlyExecutionSelection } from "./execution.ts";
export type { AgentWorkspace, ExecutionSelection, ExecutionEnvironment } from "./execution.ts";
import { executionSelectionSchema, type ExecutionSelection, type ExecutionEnvironment } from "./execution.ts";

/**
 * Agent HTTP API identity shared by the server and the bundled UI. Bump it only
 * when a UI build can no longer speak to an older Agent service; both sides ship
 * from this repository, so a mismatch means one half was not restarted/updated.
 */
export const AGENT_API_VERSION = "2026-11-18.1";
/** Read-only runtime identity; never contains paths, tokens or configuration. */
export type AgentRuntimeInfo = { apiVersion: string; buildMode?: string };

export const providerOptionSelectionSchema = z.object({
  id: z.string().trim().min(1).max(256),
  value: z.union([z.string(), z.boolean()]),
}).strict();
export const interactionModeSchema = z.enum(["default", "plan"]);

export const createThreadSchema = z.object({
  id: z.string().min(1).max(256),
  executionSelection: executionSelectionSchema,
}).strict();

export const threadSettingsSchema = z.object({
  providerInstanceId: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
  systemPrompt: z.string().max(16000),
  temperature: z.number().finite().min(0).max(2),
  modelOptions: z.array(providerOptionSelectionSchema).max(100).optional(),
  interactionMode: interactionModeSchema.optional(),
});
export const messageContentSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    parts: z.array(z.object({ type: z.string().min(1) }).loose()).max(2000),
    metadata: z.unknown().optional(),
  })
  .loose();
export const uiMessageSchema = messageContentSchema.extend({ id: z.string().min(1).max(256) });
export const storedMessageSchema = z.object({
  id: z.string().min(1).max(256),
  parent_id: z.string().nullable(),
  format: z.string().min(1).max(128),
  content: messageContentSchema,
  /** Server-owned on reads; history writes cannot create or replace a binding. */
  turnContext: turnContextSchema.optional(),
});
export const chatBodySchema = z.object({
  id: z.string().min(1).max(256),
  messages: z.array(uiMessageSchema).min(1).max(10000),
  system: z.string().max(96000).optional(),
  tools: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  callSettings: z.object({ temperature: z.number().finite().min(0).max(2).optional() }).optional(),
  config: z
    .object({
      providerInstanceId: z.string().optional(),
      modelName: z.string().optional(),
      modelOptions: z.array(providerOptionSelectionSchema).max(100).optional(),
      interactionMode: interactionModeSchema.optional(),
      threadSettingsRevision: z.number().int().nonnegative().optional(),
      responseStreamingMode: responseStreamingModeSchema.optional(),
    })
    .loose()
    .optional(),
  trigger: z.enum(["submit-message", "regenerate-message"]).default("submit-message"),
  messageId: z.string().optional(),
  idempotencyKey: z.string().max(256).optional(),
  pmReferences: z.array(pmReferenceInputSchema).max(50).optional(),
  contextItems: z.array(chatContextInputSchema).max(20).optional(),
});
export const threadPatchSchema = z.object({
  title: z.string().max(200).optional(),
  status: z.enum(["regular", "archived"]).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  settings: threadSettingsSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  lifecycleRevision: z.number().int().nonnegative().optional(),
  executionSelection: executionSelectionSchema.optional(),
}).strict();
export const threadDeleteSchema = z.strictObject({
  lifecycleRevision: z.number().int().nonnegative(),
  confirm: z.literal(true),
  expectedGenerationId: z.string().min(1).max(256).nullable(),
  stopActive: z.boolean(),
});
export type ChatSubmissionLookup = {
  status: "accepted" | "not_accepted" | "unknown";
  generationId?: string;
  reason?: string;
  storeId: string;
  restoreEpoch: number;
};
export type ThreadLifecycleOperationView = {
  operationId: string; threadId: string; state: "stopping" | "blocked" | "committed";
  lifecycleRevision: number; expectedGenerationId: string | null;
  closingClaimed: boolean;
  reasons: string[]; deleted?: true; retainedGenerationIds?: string[];
  createdAt: string; updatedAt: string;
};
export const threadSidebarActionSchema = z.object({
  action: z.enum(["pin", "unpin", "settle", "unsettle", "snooze", "wake", "auto-settle", "mark-unread", "visit"]),
  revision: z.number().int().nonnegative(),
  snoozedUntil: z.string().datetime({ offset: true }).optional(),
  enabled: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.action === "snooze" && !value.snoozedUntil)
    context.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Snooze requires a wake time." });
  if (value.action === "auto-settle" && value.enabled === undefined)
    context.addIssue({ code: "custom", path: ["enabled"], message: "Auto-settle requires enabled." });
});
export type ThreadSidebarAction = z.infer<typeof threadSidebarActionSchema>;
export type ThreadSidebar = {
  revision: number;
  pinnedAt: string | null;
  settledAt: string | null;
  snoozedAt: string | null;
  snoozedUntil: string | null;
  autoSettle: boolean;
  lastVisitedAt: string | null;
  unread: boolean;
  section: "pinned" | "active" | "snoozed" | "settled";
  running: boolean;
  /** Derived from current generations and live, respondable interaction requests. */
  activity: {
    status: "idle" | "queued" | "running" | "waiting_approval" | "waiting_input" | "failed" | "cancelled" | "interrupted";
    generationId?: string;
  };
  canSnooze: boolean;
};

export type RemoteSettings = {
  providerInstanceId: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  modelOptions?: ProviderOptionSelection[];
  interactionMode?: "default" | "plan";
};

export type ChatFanoutSelection = Pick<RemoteSettings, "providerInstanceId" | "model" | "modelOptions">;
/** Fanout intentionally excludes PM/context bindings, quotes and all message metadata. */
export type ChatFanoutRequest = {
  operationId: string;
  sourceThreadId: string;
  message: {
    id: string;
    role: "user";
    parts: ({ type: "text"; text: string } | { type: "file"; mediaType: string; url: string; filename?: string })[];
    metadata?: never;
  };
  selections: ChatFanoutSelection[];
  /** Optional source-side correlation only; every child receives a fresh input message ID. */
  messageId?: string;
};
export type ChatFanoutResult = {
  operationId: string;
  sourceThreadId: string;
  /** Admission outcome, not proof that Provider execution completed successfully. */
  status: "created" | "partial" | "failed";
  children: {
    selection: ChatFanoutSelection;
    threadId: string;
    generationId?: string;
    error?: { code: string; message: string };
  }[];
  createdAt: string;
};
export type RemoteThread = {
  remoteId: string;
  executionSelection?: ExecutionSelection;
  executionEnvironment?: ExecutionEnvironment;
  status: "regular" | "archived";
  title?: string;
  custom?: Record<string, unknown>;
  revision: number;
  lifecycleRevision: number;
  deletionState?: "closing" | "committed";
  sidebar: ThreadSidebar;
  createdAt: string;
  updatedAt: string;
  settings: RemoteSettings;
  defaultsRevision?: number;
  lastMessageAt?: string;
  /** Public thread list signal; absent on older callers. */
  messageCount?: number;
};
/** Content-free exact-generation control-plane view; never a PM visibility projection. */
export const chatGenerationLifecycleSchema = z.strictObject({
  id: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  inputMessageId: z.string().min(1).max(256).optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]),
  createdAt: z.string(),
  endedAt: z.string().optional(),
});
export type ChatGenerationLifecycle = z.infer<typeof chatGenerationLifecycleSchema>;

export type ChatGenerationView = {
  id: string;
  threadId: string;
  messageId: string;
  /** Legacy records may lack these server-owned execution links. */
  inputMessageId?: string;
  traceId?: string;
  executionGrantId?: string;
  executionPolicy?: ExecutionPolicy;
  turnContext?: TurnContext;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  error?: string;
  errorClass?: string;
  resetAt?: string;
  providerInstanceId: string;
  modelId: string;
  continuationOf?: string;
  continuationId?: string;
  handoff?: { mode: "native" | "native-fork" | "portable"; reason: string };
  /** Resolved IDs, titles, revisions and short reasons only; never PM bodies or credentials. */
  pmReferences?: PmReferenceResolution[];
};

/** Explicit saved drafts are separate from the browser's current composer draft. */
export const chatDraftInputSchema = z.object({
  message: z.object({
    id: z.string().min(1).max(256),
    role: z.literal("user"),
    parts: z.array(z.union([
      z.object({ type: z.literal("text"), text: z.string().max(256000) }).strict(),
      z.object({
        type: z.literal("file"), url: z.string().max(24000000),
        mediaType: z.string().max(256), filename: z.string().max(512).optional(),
      }).strict(),
    ])).min(1).max(100),
    metadata: z.object({ custom: z.object({
      quote: z.unknown().optional(), contextAttachments: z.array(chatContextAttachmentBindingSchema).max(100).optional(),
    }).strict().optional() }).strict().optional(),
  }).strict(),
  pmReferences: z.array(pmReferenceInputSchema).max(50).optional(),
  contextItems: z.array(chatContextInputSchema).max(20).optional(),
}).strict();
export type ChatDraftInput = z.infer<typeof chatDraftInputSchema>;
export const savedChatDraftSchema = z.object({
  id: z.string().min(1).max(256),
  draft: chatDraftInputSchema,
  threadSettingsRevision: z.number().int().nonnegative(),
}).strict();
export const chatQueueActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove"), revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("move"), revision: z.number().int().nonnegative(), beforeId: z.string().nullable() }).strict(),
  z.object({ action: z.literal("edit"), revision: z.number().int().nonnegative(), draft: chatDraftInputSchema,
    threadSettingsRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("send"), revision: z.number().int().nonnegative(), confirmAfterGenerationId: z.string().optional(),
    expectedHeadId: z.string().nullable().optional(), expectedGenerationId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("reconcile"), revision: z.number().int().nonnegative() }).strict(),
]);
export type QueuedChatMessage = {
  id: string;
  threadId: string;
  revision: number;
  draft: ChatDraftInput | null;
  status: "queued" | "dispatching" | "sent" | "blocked" | "unknown" | "removed";
  createdAt: string;
  updatedAt: string;
  generationId?: string;
  /** Stable admission boundary used by a live foreground queue coordinator. */
  afterGenerationId?: string | null;
  afterHeadId?: string | null;
  afterGenerationWasActive?: boolean;
  reason?: string;
};
export type StashedChatDraft = {
  id: string;
  threadId: string;
  draft: ChatDraftInput | null;
  createdAt: string;
  reason?: string;
};
export type ThreadActionCapability = { supported: boolean; reason?: string };
export type ThreadActionCapabilities = {
  steer: ThreadActionCapability & { interruptsTools?: boolean; generationId?: string };
  fork: ThreadActionCapability;
  rewind: ThreadActionCapability;
  planImplementation: ThreadActionCapability;
  /** Conversation rewind never rolls back PM mutations or filesystem changes. */
  rewindEffects: "conversation-only";
};
