import { z } from "zod";
import { agentChatToolEntitySchema, agentChatToolWorkflowSchema, agentChatToolCommentSchema, agentChatToolRelationSchema, agentChatToolResultFields as resultFields } from './pm-tool-shared.ts';
export * from './pm-tool-shared.ts';
import { taskBriefSchema, taskKnowledgePageSchema } from "./task-brief.ts";
import { coreToolResultSchema } from './pm-tool-core.ts';
import { CollaborationToolResultSchema } from './pm-tool-collaboration.ts';
import { AdministrationToolResultSchema } from './pm-tool-administration.ts';
import { DocumentsFilesToolResultSchema } from './pm-tool-documents-files.ts';
import { DashboardToolResultSchema } from './pm-tool-dashboard.ts';
import { PlanningRecordsToolResultSchema } from './pm-tool-planning-records.ts';
import { AutomationToolResultSchema } from './pm-tool-automation.ts';
import { IntegrationsToolResultSchema } from './pm-tool-integrations.ts';

export const agentChatToolResultSchema = z.union([
  coreToolResultSchema,
  CollaborationToolResultSchema,
  AdministrationToolResultSchema,
  DocumentsFilesToolResultSchema,
  DashboardToolResultSchema,
  PlanningRecordsToolResultSchema,
  AutomationToolResultSchema,
  IntegrationsToolResultSchema,
  z.strictObject({ kind: z.enum(["project", "task", "document", "cycle", "milestone", "module", "requirement", "release", "goal", "query"]), items: z.array(agentChatToolEntitySchema), ...resultFields }),
  z.strictObject({ kind: z.literal("workflow"), items: z.array(z.never()), workflow: agentChatToolWorkflowSchema, ...resultFields }),
  z.strictObject({ kind: z.literal("task_brief"), items: z.array(z.never()), brief: taskBriefSchema, ...resultFields }),
  z.strictObject({ kind: z.literal("knowledge"), items: z.array(z.never()), knowledge: taskKnowledgePageSchema, ...resultFields }),
  z.strictObject({ kind: z.literal("comment"), items: z.array(agentChatToolCommentSchema), ...resultFields }),
  z.strictObject({ kind: z.literal("relation"), items: z.array(agentChatToolRelationSchema), ...resultFields }),
  // Lifecycle writes may leave no current entity (permanent deletion); the receipt still proves the original outcome.
  z.strictObject({ kind: z.literal("lifecycle"), items: z.array(agentChatToolEntitySchema), ...resultFields }),
  z.strictObject({ kind: z.literal("workspaces"), items: z.array(z.strictObject({
    id: z.uuid(), name: z.string(), workspaceAllowed: z.boolean().optional(),
    projects: z.array(z.strictObject({ id: agentChatToolEntitySchema.shape.id, name: z.string() })),
  })), ...resultFields }),
]);
export type AgentChatToolResult = z.infer<typeof agentChatToolResultSchema>;
