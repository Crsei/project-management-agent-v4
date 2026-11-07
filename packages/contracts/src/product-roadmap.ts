import { z } from 'zod';
import { productDesignSchema } from './product-design.ts';

const text = z.string().max(6000);
export const productBriefSchema = z.strictObject({
  idea: text, audience: text, problem: text, journey: text, success: text,
  nonGoals: text, sharedContract: text, assumptions: text,
});
export const roadmapNodeSchema = z.strictObject({
  id: z.uuid(), title: z.string().max(160), outcome: text, acceptance: text,
  nonGoals: text, stage: z.string().max(80), dependsOn: z.array(z.uuid()).max(24),
  x: z.number().int().min(0).max(6000), y: z.number().int().min(0).max(6000),
});
export const roadmapPlanSchema = z.strictObject({ brief: productBriefSchema, nodes: z.array(roadmapNodeSchema).max(24), design: productDesignSchema.optional() });
export const roadmapReleaseSchema = z.strictObject({ id: z.uuid(), plan: roadmapPlanSchema, publishedAt: z.iso.datetime(), publishedBy: z.string() });
export const roadmapStoreSchema = z.strictObject({ schema: z.literal('pm/product-roadmap/v1'), draft: roadmapPlanSchema, releases: z.array(roadmapReleaseSchema).max(20) });
export const roadmapActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), commandId: z.uuid(), revision: z.string().min(1), plan: roadmapPlanSchema }),
  z.strictObject({ action: z.literal('publish'), commandId: z.uuid(), revision: z.string().min(1), releaseId: z.uuid(), confirm: z.literal(true) }),
  z.strictObject({ action: z.literal('materialize'), releaseId: z.uuid(), nodeId: z.uuid(), confirm: z.literal(true) }),
]);
export const ROADMAP_FIELD = 'x-pm-product-roadmap';
export const ROADMAP_ORIGIN = 'x-pm-roadmap-origin';
export const roadmapOriginSchema = z.strictObject({ releaseId: z.uuid(), nodeId: z.uuid() });
export type ProductBrief = z.infer<typeof productBriefSchema>;
export type RoadmapNode = z.infer<typeof roadmapNodeSchema>;
export type RoadmapPlan = z.infer<typeof roadmapPlanSchema>;
export type RoadmapRelease = z.infer<typeof roadmapReleaseSchema>;
export type RoadmapStore = z.infer<typeof roadmapStoreSchema>;
export type RoadmapAction = z.infer<typeof roadmapActionSchema>;
export type RoadmapTask = { nodeId: string; taskId: string; title: string; status: string; revision: string; archived: boolean; drifted: boolean };
export type RoadmapRead = { projectId: string; title: string; revision: string; archived: boolean; store: RoadmapStore; tasks: Record<string, RoadmapTask[]> };

export function emptyRoadmap(): RoadmapPlan {
  return { brief: { idea: '', audience: '', problem: '', journey: '', success: '', nonGoals: '', sharedContract: '', assumptions: '' }, nodes: [] };
}
/** Advisory validation shared with the editor; the application enforces it on publication. */
export function roadmapProblems(plan: RoadmapPlan): string[] {
  const problems: string[] = [];
  for (const [key, label] of [['idea', '产品想法'], ['audience', '目标用户'], ['problem', '用户问题'], ['journey', '核心使用流程'], ['success', '验证目标'], ['nonGoals', '非目标'], ['sharedContract', '共享约定']] as const)
    if (!plan.brief[key].trim()) problems.push(`请补充${label}。`);
  if (!plan.nodes.length) problems.push('至少需要一个可验收的任务。');
  const ids = new Set(plan.nodes.map(n => n.id));
  if (ids.size !== plan.nodes.length) problems.push('任务候选编号重复。');
  for (const n of plan.nodes) {
    if (!n.title.trim() || !n.outcome.trim() || !n.acceptance.trim() || !n.stage.trim()) problems.push(`${n.title || '未命名任务'}：需填写标题、成果、验收及阶段。`);
    if (new Set(n.dependsOn).size !== n.dependsOn.length || n.dependsOn.includes(n.id) || n.dependsOn.some(id => !ids.has(id))) problems.push(`${n.title}：依赖包含重复、自身或缺失节点。`);
  }
  const resolved = new Set<string>();
  for (let i = 0; i < plan.nodes.length; i++) for (const n of plan.nodes) if (n.dependsOn.every(id => resolved.has(id))) resolved.add(n.id);
  if (resolved.size !== ids.size) problems.push('依赖存在环或缺失节点；不能发布。');
  return [...new Set(problems)];
}
export function productBriefMarkdown(brief: ProductBrief): string {
  return [['产品想法', brief.idea], ['目标用户', brief.audience], ['用户问题', brief.problem], ['核心流程', brief.journey], ['验证目标', brief.success], ['本版不做', brief.nonGoals], ['共享实现约定', brief.sharedContract], ['假设 / 待确认', brief.assumptions]].map(([label, value]) => `## ${label}\n${value || '尚未提供'}`).join('\n\n');
}

export const roadmapDeliveryScopeSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/), releaseId: z.uuid() });
export type RoadmapDeliveryScope = z.infer<typeof roadmapDeliveryScopeSchema>;
export type RoadmapDeliveryRead = {
  eligible: boolean; reason: string; checkedAt: string;
  candidate: { id: string; head: string } | null;
  items: { taskId: string; title: string; deliveryId: string | null; head: string | null; pr: string | null; tested: boolean; ci: boolean; included: boolean; observedAt: string | null; issue: string | null }[];
};
