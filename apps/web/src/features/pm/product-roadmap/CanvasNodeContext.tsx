import type { RoadmapPlan, RoadmapNode } from '../../../../../../packages/contracts/src/product-roadmap';
import type { CanvasRun } from '../../../../../../packages/contracts/src/product-canvas';
import { productReport, type CanvasHandoff } from '../../../../../../packages/contracts/src/task-context';

function ProductChanges({ handoff }: { handoff?: CanvasHandoff }) {
  const report = productReport(handoff);
  return report ? report.changes.length
    ? <ul>{report.changes.map((change, i) => <li key={i}>{change}</li>)}</ul>
    : <p>本节点没有产品功能变化。</p>
    : <p>尚未生成产品变化说明；不会把需求当成已实现功能。</p>;
}

function ExecutionEvidence({ handoff }: { handoff: CanvasHandoff }) {
  const legacy = handoff.report && 'interfaces' in handoff.report ? handoff.report : undefined;
  return <article><p>{handoff.taskId} · 提交 {handoff.head}</p>
    <p>测试：{handoff.testCommand} · 摘要 {handoff.testDigest}</p>
    <p>CI：{handoff.ci.join('、')} · 核对于 {handoff.checkedAt}</p>
    <a href={handoff.pr} target="_blank" rel="noreferrer">查看交付 PR ↗</a>
    <details><summary>变更文件{handoff.filesTruncated ? '（部分）' : ''}</summary><pre>{handoff.files.join('\n')}</pre></details>
    {legacy && <details><summary>历史技术交接</summary><p>接口与模型：{legacy.interfaces.join('；')}</p><p>设计决定：{legacy.decisions.join('；')}</p><p>使用方式：{legacy.usage}</p><p>风险与未验证：{legacy.risks.join('；') || '未提供；不代表没有风险'}</p></details>}
  </article>;
}

export function CanvasNodeContext({ plan, node, run }: { plan: RoadmapPlan; node: RoadmapNode; run: CanvasRun | null }) {
  const current = run?.nodes.find(n => n.nodeId === node.id);
  const handoff = current?.phase === 'verified' ? current.handoff : undefined;
  // Show this node's input, never a later node's product state.
  const inputIds = new Set(current?.context?.included.map(n => n.nodeId));
  const latest = run?.nodes.filter(n => inputIds.has(n.nodeId) && n.phase === 'verified').at(-1);
  const capabilities = productReport(latest?.handoff)?.capabilities;
  // A design draft has no execution context. Do not reserve space for future results.
  if (!current) return null;
  const changes = productReport(handoff)?.changes;
  return <section className="canvas-context" aria-label="产品变化">
    {!!changes?.length && <div className="canvas-feature-changes"><h3>本次功能变化</h3><ProductChanges handoff={handoff} /></div>}
    <details><summary>运行记录</summary>
      {handoff && !changes?.length && <p>{changes ? '本次没有产品功能变化。' : '本次运行未提供功能变化说明。'}</p>}
      <details><summary>产品上下文</summary>
      <p>每个节点使用独立会话；自动传递产品能力与体验约定，不传递完整聊天。</p>
      <h3>体验与共享约定</h3><pre>{plan.brief.sharedContract || '尚未填写，可在画布顶部的“体验约定”中补充。'}</pre>
      <h3>节点开始前的产品能力</h3>
      {capabilities ? capabilities.length ? <ul>{capabilities.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>该版本的能力摘要为空。</p> : <p>该版本尚无能力摘要，执行时需根据代码核实；不会回退到更早的产品说明。</p>}
      {latest?.handoff && capabilities && <small>对应版本 {latest.handoff.head.slice(0, 12)}；Agent 描述，不代表逐项验收通过。</small>}
      <h3>前置功能变化</h3>{node.dependsOn.length ? node.dependsOn.map(id => {
        const source = plan.nodes.find(n => n.id === id), previous = run?.nodes.find(n => n.nodeId === id);
        return <article key={id}><strong>{source?.title || '缺失节点'}</strong><ProductChanges handoff={previous?.phase === 'verified' ? previous.handoff : undefined} /></article>;
      }) : <p>没有直接前置功能节点。</p>}
      </details>
      <details><summary>执行详情</summary>
      {current?.context && <p>冻结版本 {current.context.sharedVersion.slice(0, 12)} · {current.context.releaseId}<br />代码基线：{current.context.baseBranch} · 累计继承 {current.context.included.length} 项已核验成果。</p>}
      {handoff ? <ExecutionEvidence handoff={handoff} /> : <p>尚无本节点的交付证据。</p>}
      {run?.nodes.filter(n => inputIds.has(n.nodeId) && n.handoff).map(n => <ExecutionEvidence key={n.nodeId} handoff={n.handoff!} />)}
      <p>版本、测试与 CI 校验仍由系统执行；交付验证不代表业务完成。</p>
      </details>
    </details>
  </section>;
}
