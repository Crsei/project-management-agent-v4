import type { RoadmapNode, RoadmapPlan } from '../../../../../../packages/contracts/src/product-roadmap';

/** Product design editor. Hidden metadata and scope stay in the original node. */
export function CanvasFeatureEditor({ node, plan, editable, onChange }: {
  node: RoadmapNode; plan: RoadmapPlan; editable: boolean; onChange: (changes: Partial<RoadmapNode>) => void;
}) {
  return <div className="canvas-feature-editor">
    <div className="roadmap-fields">
      <label>功能名称<input maxLength={160} value={node.title} readOnly={!editable} placeholder="例如：客户提交反馈" onChange={e => onChange({ title: e.target.value })} /></label>
      <label>用户能做什么<textarea rows={4} maxLength={6000} value={node.outcome} readOnly={!editable} placeholder="例如：客户填写反馈并提交，随后可以在列表中看到自己的反馈。" onChange={e => onChange({ outcome: e.target.value })} /></label>
      <label>预期效果<textarea rows={3} maxLength={6000} value={node.acceptance} readOnly={!editable} placeholder="例如：提交成功后显示新反馈；漏填必填项时提示补充，已填写内容不会丢失。" onChange={e => onChange({ acceptance: e.target.value })} /></label>
    </div>
    {plan.design && <p className="roadmap-muted">自动继承产品设计：{plan.design.title} · {plan.design.versionId.slice(0,8)}。无需逐节点配置。</p>}
    <details className="canvas-feature-options"><summary>补充设置</summary>
      <div className="roadmap-fields"><label>范围限制<textarea rows={2} maxLength={6000} value={node.nonGoals} readOnly={!editable} placeholder="仅在需要时说明这个功能暂不包含什么。" onChange={e => onChange({ nonGoals: e.target.value })} /></label>
        <label>计划分组<input maxLength={80} value={node.stage} readOnly={!editable} onChange={e => onChange({ stage: e.target.value })} /></label></div>
      <fieldset disabled={!editable}><legend>前置功能</legend><p className="roadmap-muted">只有必须先具备的功能才需要关联，不是用户操作顺序。</p>
        {plan.nodes.filter(n => n.id !== node.id).map(n => <label className="roadmap-check" key={n.id}><input type="checkbox" checked={node.dependsOn.includes(n.id)} onChange={e => onChange({ dependsOn: e.target.checked ? [...node.dependsOn, n.id] : node.dependsOn.filter(id => id !== n.id) })} />{n.title || '未命名功能'}</label>)}
        {plan.nodes.length <= 1 && <p className="roadmap-muted">暂无其他功能。</p>}
      </fieldset>
    </details>
  </div>;
}
