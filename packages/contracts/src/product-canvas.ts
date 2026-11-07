import type { CanvasHandoff, CanvasTaskContext } from './task-context.ts';
import { z } from 'zod';
import type { RoadmapPlan } from './product-roadmap.ts';
export const canvasScopeSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/) });
export const canvasStartSchema = canvasScopeSchema.extend({ id: z.uuid(), releaseId: z.uuid(), revision: z.string().min(1), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/), providerInstanceId: z.string().min(1).max(256), model: z.string().min(1).max(256), consent: z.strictObject({ execute: z.literal(true), worktreeWrite: z.literal(true), commit: z.literal(true), push: z.literal(true), draftPr: z.literal(true), taskStatus: z.literal(true), createTasks: z.literal(true) }) });
export const canvasControlSchema = z.strictObject({ action: z.enum(['pause', 'resume']), version: z.number().int().positive(), confirm: z.literal(true) });
export type CanvasScope = z.infer<typeof canvasScopeSchema>;
export type CanvasStart = z.infer<typeof canvasStartSchema>;
export type CanvasNodeRun = { nodeId: string; childId: string; taskId?: string; owned?: boolean; phase: 'pending' | 'creating' | 'ready' | 'starting' | 'running' | 'verified'; baseBranch?: string; branch?: string; message?: string; context?: CanvasTaskContext; handoff?: CanvasHandoff };
export type CanvasRun = { id: string; input: CanvasStart; version: number; plan: RoadmapPlan; nodes: CanvasNodeRun[]; status: 'running' | 'paused' | 'completed'; message: string; createdAt: string; updatedAt: string };
export function canvasOrder(plan: RoadmapPlan): string[] {
  const result: string[] = [], seen = new Set<string>();
  for (let pass = 0; pass < plan.nodes.length; pass++) for (const n of plan.nodes) if (!seen.has(n.id) && n.dependsOn.every(id => seen.has(id))) { result.push(n.id); seen.add(n.id); }
  if (result.length !== plan.nodes.length) throw new Error('画布依赖无效或存在环。');
  return result;
}
