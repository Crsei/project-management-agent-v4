import type { AutomationCatalogField, AutomationCatalogTemplate } from '../contracts/src/automation-catalog.ts';
import { pmAutomationTemplateVersion, type PmAutomationArguments, type PmAutomationTemplateId } from '../contracts/src/automation-pm.ts';

export const pmAutomationCategories = ['tasks/dependencies', 'execution/collaboration', 'knowledge/changes', 'project/planning'] as const;
export type PmAutomationCategory = typeof pmAutomationCategories[number];
export const pmAutomationCatalogSource = {
  id: 'pm', name: 'PM native', version: pmAutomationTemplateVersion,
  reference: '../agent-pm-studio/src/proactive-rules.ts:10-35',
  semantics: '../agent-pm-studio/integration-scenarios/PROACTIVE.md:27-66',
  runtime: 'pm-native-read-only-analysis',
} as const;

type Scenario = { id: PmAutomationTemplateId; scenario: string; name: string; category: PmAutomationCategory; description: string; events: string[]; recommended?: true };
const scenarios: Scenario[] = [
  { id: 'pm-duplicate-tasks', scenario: '01', name: '新任务重复检查', category: 'tasks/dependencies', description: '比较同项目真实任务标题与验收内容，展示相似证据并准备关联提案；不合并或删除任务。', events: ['task.created'] },
  { id: 'pm-requirement-review', scenario: '02', name: '需求完整性提醒', category: 'tasks/dependencies', description: '核对验收标准、范围边界与已提及的前置依赖，准备可编辑的字段补全提案；不冒充已确认需求。', events: ['task.updated'], recommended: true },
  { id: 'pm-stalled-tasks', scenario: '03', name: '任务长期无进展', category: 'tasks/dependencies', description: '用任务、评论、活动、Session 和 Run 的真实最近时间识别至少七天停滞的开放任务，准备跟进备注；不推定完成。', events: [], recommended: true },
  { id: 'pm-ready-dependencies', scenario: '04', name: '依赖已完成可启动', category: 'tasks/dependencies', description: '依据当前工作流类别核对全部前置任务确实完成，再建议配置允许的待启动状态；不代替验收。', events: ['task.state_changed', 'task.dependencies_changed'] },
  { id: 'pm-execution-status-review', scenario: '05', name: '执行结果与状态不一致', category: 'tasks/dependencies', description: '同版本成功 Run 有非空且全部通过的测试证据时，准备当前工作流允许的人工送审建议；绝不自动完成任务。', events: ['agent.run.terminal'] },
  { id: 'pm-task-overlap', scenario: '06', name: '任务依赖与文件交叉', category: 'tasks/dependencies', description: '比较显式依赖与声明修改范围，准备协调顺序的调查任务；文件交叉不等于已发生冲突。', events: ['task.updated', 'task.dependencies_changed'] },
  { id: 'pm-run-summary', scenario: '07', name: 'Run 完成总结', category: 'execution/collaboration', description: '整理真实成功 Run 的摘要、修改文件、测试与关联任务活动，准备来源化总结文档；Run 成功不等于任务完成。', events: ['agent.run.terminal'] },
  { id: 'pm-run-failure-investigation', scenario: '08', name: 'Run 失败调查建议', category: 'execution/collaboration', description: '引用真实失败测试、日志片段与相关文件，准备可编辑调查任务；不声称根因已证实，不自动重跑。', events: ['agent.run.terminal'] },
  { id: 'pm-session-followups', scenario: '09', name: 'Session 遗留工作提取', category: 'execution/collaboration', description: '从已授权空闲或完成对话的明确未解决事项提取带原话来源的任务候选，人工审阅后创建。', events: ['agent.session.idle'] },
  { id: 'pm-pr-acceptance-coverage', scenario: '10', name: 'PR 验收覆盖缺口', category: 'execution/collaboration', description: '对照明确仓库/PR 范围的真实只读快照与任务验收条目；未能核验的覆盖明确报告缺口，不伪造 CI 或 PR webhook。', events: [] },
  { id: 'pm-parallel-run-overlap', scenario: '11', name: '并行 Run 文件交叉', category: 'execution/collaboration', description: '用真实 Run 时间区间及实际 diff 路径识别并行交叉，准备协调任务；不宣称已发生合并冲突。', events: ['agent.run.terminal'] },
  { id: 'pm-repeated-failure-hypothesis', scenario: '12', name: '重复失败共同假设', category: 'execution/collaboration', description: '聚合同名失败测试与相同错误片段，提出带证据的共同原因假设和待人工批准的验证建议；不自动启动隔离执行。', events: ['agent.run.terminal'] },
  { id: 'pm-decision-record', scenario: '13', name: '讨论决策沉淀', category: 'knowledge/changes', description: '仅针对对话中的明确决策语句准备来源化决策文档，保留原话与当前授权范围。', events: ['agent.session.idle'] },
  { id: 'pm-scope-drift', scenario: '14', name: '实现范围偏移', category: 'knowledge/changes', description: '对比真实 diff 文件与任务明确允许范围，准备范围复核任务；不推断未声明边界，不自动回滚代码。', events: ['agent.run.terminal'] },
  { id: 'pm-requirement-change-impact', scenario: '15', name: '需求版本变更影响', category: 'knowledge/changes', description: '比较持久记录的需求 before/after 版本，列出真实关联 Session、文档与下游任务；无历史边界时明确缺口。', events: ['task.updated'] },
  { id: 'pm-session-knowledge', scenario: '16', name: '跨 Session 技术主题', category: 'knowledge/changes', description: '同一明确技术主题在多个真实会话重复出现时准备来源化知识文档，不按标题猜测会话关联。', events: ['agent.session.idle'] },
  { id: 'pm-cross-task-failures', scenario: '17', name: '跨任务共性技术问题', category: 'knowledge/changes', description: '不同关联任务具有同名失败测试及共同技术标签时准备共享调查任务，不将假设冒充根因。', events: ['agent.run.terminal'] },
  { id: 'pm-next-phase-plan', scenario: '18', name: '阶段完成后的下一阶段', category: 'project/planning', description: '指定阶段确已完成且存在真实未完成下游依赖时准备可编辑规划；选择发布复用既有任务并校验依赖闭包。', events: ['task.state_changed', 'milestone.changed'] },
  { id: 'pm-project-digest', scenario: '19', name: '今日项目脉搏', category: 'project/planning', description: '在真实访问或后台日程中汇总观察窗口内的变化、失败和待审结果，所有条目可回到来源；无变化不制造日报。', events: ['project.visited'], recommended: true },
  { id: 'pm-project-stagnation', scenario: '20', name: '项目长期停滞风险', category: 'project/planning', description: '项目至少十四天无可见进展、近期无完成结果且存在真实阻塞时准备调查任务；不创建或载入 DEMO 数据。', events: [] },
  { id: 'pm-milestone-readiness', scenario: '21', name: '里程碑交付检查', category: 'project/planning', description: '针对指定里程碑收集未完成任务、失败测试与未审结果，准备发布风险文档；不自动宣告可交付。', events: ['milestone.changed'] },
  { id: 'pm-since-last-visit', scenario: '22', name: '离开之后发生了什么', category: 'project/planning', description: '严格使用当前主体/项目的上次访问持久边界汇总新增任务、评论、活动、文档与 Run；首次访问不伪造离开区间。', events: ['project.visited'] },
  { id: 'pm-goal-drift', scenario: '23', name: '项目目标偏移提醒', category: 'project/planning', description: '必须同时存在明确项目目标、未完成目标任务与偏离目标范围的近期变更，才准备来源化规划建议。', events: [] },
  { id: 'pm-next-actions', scenario: '24', name: '下一步可执行规划', category: 'project/planning', description: '根据目标关联任务、真实已完成依赖与明确遗留工作准备可编辑规划；不自动启动执行或标记完成。', events: [] },
];

const commonArgs: Record<string, AutomationCatalogField> = {
  taskIds: { type: 'text', label: 'Task IDs', help: 'Optional explicit TASK IDs. An explicit selection is never widened to the whole project.', required: false },
  statusIds: { type: 'text', label: 'Workflow status IDs', help: 'Optional current workflow status IDs, not hardcoded status names.', required: false },
  assigneeIds: { type: 'text', label: 'Assignee IDs', help: 'Optional real member IDs.', required: false },
  labels: { type: 'text', label: 'Labels', help: 'Optional exact labels limiting the inspected tasks.', required: false },
  lookbackDays: { type: 'number', label: 'Lookback days', help: 'Bound the source observation window.', default: 7, required: false, constraints: { min: 1, max: 365 } },
  staleDays: { type: 'number', label: 'Stale days', help: 'Minimum inactivity window; scenario semantics retain their own minimum.', default: 7, required: false, constraints: { min: 1, max: 365 } },
  milestoneId: { type: 'text', label: 'Milestone ID', help: 'Optional real milestone; required facts must exist for milestone-specific analysis.', required: false },
  instructions: { type: 'textarea', label: 'Review instructions', help: 'Additional untrusted analysis context, never permission to write or invoke tools.', default: '', required: false, constraints: { maxLength: 12000 } },
};
const digestLookbackField: AutomationCatalogField = { type: 'number', label: 'Custom lookback days (optional)', help: 'Leave unset for the current UTC day. Set an explicit value only for a custom lookback window; the result reports its actual boundaries.', required: false, constraints: { min: 1, max: 365 } };
export function pmAutomationDefaultArguments(id: PmAutomationTemplateId): PmAutomationArguments {
  if (id === 'pm-project-digest') return { staleDays: 7, instructions: '' };
  return { lookbackDays: id === 'pm-project-stagnation' ? 14 : 7, staleDays: id === 'pm-project-stagnation' ? 14 : 7, instructions: '' };
}
export const pmAutomationCatalog: readonly AutomationCatalogTemplate[] = scenarios.map((scenario, index) => ({
  id: scenario.id, version: pmAutomationTemplateVersion, name: scenario.name, category: scenario.category,
  source: 'pm', sourceCategory: scenario.category, maturity: 'stable', recommended: scenario.recommended === true, scenario: scenario.scenario,
  description: scenario.description, icon: 'sparkles', popularityRank: 100 - index, estimatedSetupMinutes: 2,
  requires: { integrations: {}, features: [`template:${scenario.id}`] },
  exampleImplementation: 'Registered PM-native read-only analysis. Results and editable typed proposals persist independently of Agent Chat; explicit authorized preview/apply is required for every write.',
  setup: {
    version: '1.0', mode: 'direct', native: { templateId: scenario.id },
    form: {
      note: 'Native PM analysis, not a prompt or script bundle. Source readiness, model readiness and source completeness are independently reported.',
      args: { ...commonArgs, lookbackDays: scenario.id === 'pm-project-digest' ? digestLookbackField : { ...commonArgs.lookbackDays!, default: scenario.id === 'pm-project-stagnation' ? 14 : 7 }, staleDays: { ...commonArgs.staleDays!, default: scenario.id === 'pm-project-stagnation' ? 14 : 7 } },
      triggers: {
        manual: {},
        cron: { schedule: { type: 'cron', label: 'Schedule', help: 'Existing Worker schedule; no browser timer.', default: '0 9 * * *', required: true }, timezone: { type: 'timezone', label: 'Timezone', help: 'IANA timezone.', default: 'UTC', required: true } },
        ...(scenario.events.length ? { event: { source: { type: 'event-source' as const, label: 'Native PM source', help: 'Durable internal PM events do not require a public webhook secret.', default: 'pm', required: true }, on: { type: 'select' as const, label: 'PM event', help: 'Observe an authorized durable source change.', default: scenario.events[0]!, required: true, options: scenario.events.map(value => ({ value, label: value })) } } } : {}),
      },
    },
  },
}));
export const pmAutomationCatalogById = new Map(pmAutomationCatalog.map(template => [template.id as PmAutomationTemplateId, template]));
export const pmAutomationRecommendedIds = scenarios.filter(scenario => scenario.recommended).map(scenario => scenario.id);
