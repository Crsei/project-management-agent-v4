import { z } from "zod";
import { responseStreamingModeSchema } from "./output.ts";
import { pmReferenceInputSchema, turnContextSchema } from "./pm-references.ts";
import type { ExecutionPolicy, PmReferenceResolution, TurnContext } from "./pm-references.ts";
import type { ProviderOptionSelection } from "./provider.ts";
export { agentWorkspaceSchema, executionSelectionSchema, executionEnvironmentSchema, chatOnlyExecutionSelection } from "./execution.ts";
export type { AgentWorkspace, ExecutionSelection, ExecutionEnvironment } from "./execution.ts";
import { executionSelectionSchema, type ExecutionSelection, type ExecutionEnvironment } from "./execution.ts";

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
});
export const threadPatchSchema = z.object({
  title: z.string().max(200).optional(),
  status: z.enum(["regular", "archived"]).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  settings: threadSettingsSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  executionSelection: executionSelectionSchema.optional(),
}).strict();
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
export type RemoteThread = {
  remoteId: string;
  executionSelection?: ExecutionSelection;
  executionEnvironment?: ExecutionEnvironment;
  status: "regular" | "archived";
  title?: string;
  custom?: Record<string, unknown>;
  revision: number;
  sidebar: ThreadSidebar;
  createdAt: string;
  updatedAt: string;
  settings: RemoteSettings;
  defaultsRevision?: number;
  lastMessageAt?: string;
};
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
