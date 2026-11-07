import { emptyRoadmap, type ProductBrief, type RoadmapPlan } from '../../../../../../packages/contracts/src/product-roadmap.ts';
export function layoutRoadmap(plan: RoadmapPlan): RoadmapPlan {
  const depths = new Map<string, number>();
  for (let i = 0; i < plan.nodes.length; i++) for (const n of plan.nodes) if (!depths.has(n.id) && n.dependsOn.every(id => depths.has(id))) depths.set(n.id, n.dependsOn.length ? Math.max(...n.dependsOn.map(id => depths.get(id)!)) + 1 : 0);
  const rows = new Map<number, number>();
  // Wrap long dependency chains instead of clamping several cards to the same coordinate.
  return { ...plan, nodes: plan.nodes.map(n => { const column = (depths.get(n.id) ?? 0) % 12, row = rows.get(column) ?? 0; rows.set(column, row + 1); return { ...n, x: column * 310 + 30, y: row * 200 + 30 }; }) };
}
/** Rules-based starter, deliberately not represented as an LLM result. */
export function suggestRoadmap(brief: ProductBrief, id: () => string): RoadmapPlan {
  const steps = brief.journey.split(/\n/).map(s => s.replace(/^\s*[-\d.、）)]+\s*/, '').trim()).filter(Boolean).slice(0, 12);
  let previous = '';
  const nodes = steps.map((step, i) => {
    const current = id(), dependsOn = previous ? [previous] : []; previous = current;
    const title = step.slice(0, 160), audience = brief.audience.slice(0, 240) || '目标用户';
    return { id: current, title, outcome: `${audience}可以${title}。`, acceptance: `可以通过界面完成“${title}”；结果刷新后保留；无效输入有明确提示；能够衔接前置功能继续操作。`, nonGoals: '', stage: `M${i + 1} · ${i === 0 ? '最小闭环' : i === steps.length - 1 ? '完整验证' : '逐步扩展'}`, dependsOn, x: i * 310 + 30, y: 30 };
  });
  return { brief, nodes };
}
export function feedbackScenario(id: () => string): RoadmapPlan {
  const plan = emptyRoadmap();
  plan.brief = {
    idea: '客户反馈与需求决策平台', audience: '小型产品团队的产品经理，以及提供反馈的客户',
    problem: '反馈散落在聊天记录里，团队无法解释先做什么，也无法告诉客户建议处理到哪一步。',
    journey: '客户提交反馈\n产品经理分类与检索反馈\n将同类反馈归并为需求\n按价值与成本确定优先级\n发布路线图并回看原始反馈',
    success: '用3条虚构客户反馈跑通“提交→归并→排序→路线图→回看来源”，刷新与重启后关联保持。',
    nonGoals: '不做支付、真实客户导入、多人权限体系、邮件通知或公网部署。',
    sharedContract: '同一个仓库与 App；复用统一布局、错误反馈和持久化层。POC采用Node 24内置模块、无第三方依赖，入口app/server.mjs；监听PREVIEW_SOCKET Unix socket，数据写DATA_DIR，GET /health返回200；本地独立启动支持HOST/PORT。HTML/CSS/JS同源、无内联脚本或CDN；通过npm test运行真实接口与持久化测试，README说明启动和验收。反馈模型固定为{id,title,description,category,createdAt}，ID永久稳定；需求模型为{id,title,feedbackIds,value,effort,status}，引用反馈ID而非复制内容；路线图引用需求ID，状态为planned/in_progress/done。接口与数据迁移需向后兼容。前置成果未集成到基线前不启动后续开发。',
    assumptions: '待验证：产品经理能否用评分说明取舍；客户是否愿意持续提供反馈。POC仅使用虚构数据，不将这些假设写成已验证事实。',
  };
  const suggested = suggestRoadmap(plan.brief, id);
  const criteria = [
    '通过表单提交标题、描述与分类；必填校验有效；列表显示新反馈及稳定ID；刷新和服务重启后记录保留。仅实现反馈收集，不提前开发归并、评分或路线图。',
    '在前置反馈列表按标题/描述搜索，按分类筛选，支持组合条件和清空；没有结果时展示空状态；保留提交功能及已有持久化数据。',
    '选择至少两条反馈归并为一个需求；需求页显示原始反馈引用并能回看；同一需求中不重复引用；重启后关联保持。',
    '需求可填写1～5的价值与1～5的成本，按价值/成本降序排序并展示评分依据；拒绝0及越界值；保留反馈归并与来源引用。',
    '需求按计划中/开发中/已完成展示在路线图三栏；切换状态可持久化；从路线图回看需求及原始反馈；用3条虚构反馈串联验证提交、归并、评分、路线图，重启后全链路保留，并增加端到端回归测试。',
  ];
  return { ...suggested, nodes: suggested.nodes.map((node, i) => ({ ...node, acceptance: criteria[i]! })) };
}

/** Explicitly add a real task; never mark integration verified just by creating the node. */
export function addIntegrationTask(plan: RoadmapPlan, id: string): RoadmapPlan {
  if (!plan.nodes.length || plan.nodes.length >= 24 || plan.nodes.some(n=>n.id===id)) throw new Error('请先添加功能任务，并为集成验收保留一个节点名额。');
  const depended=new Set(plan.nodes.flatMap(n=>n.dependsOn)), leaves=plan.nodes.filter(n=>!depended.has(n.id));
  if (!leaves.length) throw new Error('请先修正依赖环。');
  return {...plan,nodes:[...plan.nodes,{id,title:'阶段集成验收',stage:'集成验收',outcome:'继承前置代码，在同一个 App 上验证核心用户流程、共享数据与接口兼容性，补充跨模块自动化测试。记录实际结果与未验证项，不以单节点成功代替整体可用。',acceptance:`产品验证目标：${plan.brief.success.slice(0,5000)||'请补充完整用户流程与预期结果'}\n串联本阶段前置功能，覆盖正常路径、关键失败路径与已有功能回归；实际执行并记录验证，不自动合并、部署或通过业务验收。`,nonGoals:plan.brief.nonGoals,dependsOn:leaves.map(n=>n.id),x:30,y:Math.min(6000,Math.max(...plan.nodes.map(n=>n.y))+200)}]};
}
