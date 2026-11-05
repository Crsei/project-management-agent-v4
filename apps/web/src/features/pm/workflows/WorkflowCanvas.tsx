import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { workflowKinds, workflowLabels, workflowProblems, type WorkflowGraph, type WorkflowKind, type WorkflowNode, type WorkflowRun } from '../../../../../../packages/contracts/src/task-workflow';
import '@xyflow/react/dist/style.css';
import { RadixSelect } from "@/components/ui/radix-select"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@/components/ui/context-menu';
import { workflowNodeMessage } from './workflow-presentation';

type CanvasNode = Node<{ definition: WorkflowNode; state?: string; active: boolean; inspect: (id: string) => void; actionLabel: string }, 'workflow'>;
function WorkflowCard({ data, selected }: NodeProps<CanvasNode>) {
  const n = data.definition;
  return <ContextMenu>
    <ContextMenuTrigger asChild onContextMenu={event => event.stopPropagation()}>
      <div className={`workflow-node ${selected ? 'selected' : ''} ${data.active ? 'active' : ''}`} data-state={data.state} tabIndex={0} aria-label={`${n.label}，${workflowLabels[n.kind]}`}>
        {n.kind !== 'task' && <Handle type="target" position={Position.Left} />}
        <small>{workflowLabels[n.kind]}</small><strong>{n.label}</strong>
        <span>{data.state ?? (n.kind === 'agent' ? n.config.mode === 'analyze' ? '只读分析' : '独立目录开发' : n.kind === 'test' ? n.config.command : n.kind === 'end' ? n.config.outcome === 'failure' ? '失败结束' : '成果待审查' : '受控步骤')}</span>
        {n.kind === 'condition' ? <><Handle type="source" position={Position.Right} id="pass" style={{ top: '35%' }} /><span className="workflow-port pass">通过</span><Handle type="source" position={Position.Right} id="fail" style={{ top: '75%' }} /><span className="workflow-port fail">失败</span></> : n.kind !== 'end' && <Handle type="source" position={Position.Right} id="next" />}
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent><ContextMenuLabel>{n.label}</ContextMenuLabel><ContextMenuItem onSelect={() => data.inspect(n.id)}>{data.actionLabel}</ContextMenuItem></ContextMenuContent>
  </ContextMenu>;
}
const nodeTypes = { workflow: WorkflowCard };
const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const configFor = (kind: WorkflowKind): WorkflowNode['config'] => kind === 'agent' ? { mode: 'develop' } : kind === 'test' ? { command: '' } : kind === 'condition' ? { source: 'test' } : kind === 'ci' ? { timeoutMinutes: 15 } : kind === 'end' ? { outcome: 'success' } : {};
export function WorkflowCanvas({ graph, onChange: changeGraph, run, initialNodeId = '' }: { graph: WorkflowGraph; onChange?: (graph: WorkflowGraph) => void; run?: WorkflowRun; initialNodeId?: string }) {
  const onChange = run ? undefined : changeGraph, editable = !!onChange;
  const [selected, setSelected] = useState(() => graph.nodes.some(n => n.id === initialNodeId) ? initialNodeId : graph.nodes[0]?.id ?? '');
  const [edgeId, setEdgeId] = useState('');
  const [addKind, setAddKind] = useState<WorkflowKind>('approval');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [port, setPort] = useState<'next' | 'pass' | 'fail'>('next');
  const [focusNode, setFocusNode] = useState<string | null>(null), properties = useRef<HTMLElement>(null);
  const inspectNode = useCallback((id: string) => { setSelected(id); setEdgeId(''); setFocusNode(id); }, []);
  const current = graph.nodes.find(n => n.id === selected);
  useEffect(() => {
    if (!focusNode || current?.id !== focusNode || !properties.current) return;
    properties.current.focus({ preventScroll: true }); properties.current.scrollIntoView({ block: 'nearest' }); setFocusNode(null);
  }, [focusNode, current?.id]);
  const nodes = useMemo<CanvasNode[]>(() => graph.nodes.map(n => ({ id: n.id, type: 'workflow', position: { x: n.x, y: n.y }, selected: n.id === selected, data: { definition: n, state: run?.nodes[n.id]?.state, active: run?.current === n.id, inspect: inspectNode, actionLabel: run ? '查看执行记录' : editable ? '配置节点' : '查看节点详情' }, ariaLabel: `${n.label}，${workflowLabels[n.kind]}` })), [graph.nodes, selected, run, inspectNode, editable]);
  const edges = useMemo<Edge[]>(() => graph.edges.map(e => ({ ...e, sourceHandle: e.port, label: e.port === 'pass' ? '通过' : e.port === 'fail' ? '失败' : '', selected: e.id === edgeId, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: e.port === 'fail' ? 'var(--destructive)' : 'var(--muted-foreground)', strokeWidth: 2 } })), [graph.edges, edgeId]);
  const changeNode = (patch: Partial<WorkflowNode>) => onChange?.({ ...graph, nodes: graph.nodes.map(n => n.id === selected ? { ...n, ...patch } : n) });
  const connect = (source: string, target: string, outlet: 'next' | 'pass' | 'fail') => {
    if (!source || !target || source === target || !onChange) return;
    onChange({ ...graph, edges: [...graph.edges.filter(e => !(e.source === source && e.port === outlet)), { id: newId('edge'), source, target, port: outlet }] });
  };
  const problems = workflowProblems(graph);
  return <div className="workflow-editor">
    <div className="workflow-canvas" aria-label="工作流节点画布">
      <ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} maxZoom={1.6} nodesDraggable={!!onChange} nodesConnectable={!!onChange} deleteKeyCode={null}
        onNodeClick={(_, n) => { setSelected(n.id); setEdgeId(''); }} onEdgeClick={(_, e) => setEdgeId(e.id)}
        onNodesChange={changes => { if (!onChange) return; const positions = changes.filter(c => c.type === 'position'); if (positions.some(c => c.position)) onChange({ ...graph, nodes: graph.nodes.map(n => { const p = positions.find(c => c.id === n.id)?.position; return p ? { ...n, x: Math.max(-10000, Math.min(10000, Math.round(p.x))), y: Math.max(-10000, Math.min(10000, Math.round(p.y))) } : n; }) }); }}
        onConnect={c => connect(c.source, c.target, c.sourceHandle === 'pass' || c.sourceHandle === 'fail' ? c.sourceHandle : 'next')}>
        <Background gap={22} /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <aside className="workflow-properties" aria-label={run ? '节点执行记录' : onChange ? '节点配置' : '节点详情'} ref={properties} tabIndex={-1}>
      {onChange && <><h3>节点工具箱</h3><label>节点类型<RadixSelect value={addKind} onChange={e => setAddKind(e.target.value as WorkflowKind)}>{workflowKinds.map(kind => <option key={kind} value={kind}>{workflowLabels[kind]}</option>)}</RadixSelect></label><button type="button" disabled={graph.nodes.length >= 32} onClick={() => { const id = newId('node'); onChange({ ...graph, nodes: [...graph.nodes, { id, kind: addKind, label: workflowLabels[addKind], x: 120 + graph.nodes.length * 20, y: 400, config: configFor(addKind) }] }); setSelected(id); }}>添加节点</button></>}
      <h3>{run ? '节点执行记录' : onChange ? '配置节点' : '节点详情'}</h3>
      <label>选中节点<RadixSelect value={selected} onChange={e => setSelected(e.target.value)}>{graph.nodes.map(n => <option key={n.id} value={n.id}>{n.label} · {n.id}</option>)}</RadixSelect></label>
      {current && <><label>节点名称<input value={current.label} maxLength={100} readOnly={!onChange} onChange={e => changeNode({ label: e.target.value })} /></label>
        {current.kind === 'agent' && <><label>执行方式<RadixSelect disabled={!onChange} value={current.config.mode} onChange={e => changeNode({ config: { ...current.config, mode: e.target.value as 'analyze' | 'develop', ...(e.target.value === 'analyze' ? { taskTransition: undefined } : {}) } })}><option value="analyze">只读分析</option><option value="develop">开发与测试</option></RadixSelect></label><label>节点补充要求<textarea readOnly={!onChange} maxLength={8000} value={current.config.instruction ?? ''} onChange={e => changeNode({ config: { ...current.config, instruction: e.target.value } })} /></label></>}
        {current.kind === 'test' && <label>测试命令<input readOnly={!onChange} maxLength={2000} value={current.config.command ?? ''} onChange={e => changeNode({ config: { command: e.target.value } })} /><small>在任务工作目录执行，上限 120 秒；启动前明确确认。</small></label>}
        {current.kind === 'condition' && <label>判断来源<RadixSelect disabled={!onChange} value={current.config.source} onChange={e => changeNode({ config: { source: e.target.value as 'test' | 'ci' } })}><option value="test">测试是否通过</option><option value="ci">CI 是否通过</option></RadixSelect></label>}
        {current.kind === 'ci' && <label>等待期限（分钟）<input type="number" min={1} max={60} readOnly={!onChange} value={current.config.timeoutMinutes ?? 15} onChange={e => changeNode({ config: { ...current.config, timeoutMinutes: Number(e.target.value) } })} /></label>}
        {current.kind === 'ci' && <label>必须通过的 CI 检查（逗号分隔）<input readOnly={!onChange} key={current.id} defaultValue={current.config.requiredChecks?.join(', ') ?? ''} placeholder="填写 GitHub 中实际检查名称，例如 test" onBlur={e => { const config = { ...current.config }; const names = e.target.value.split(',').map(v => v.trim()).filter(Boolean); if (names.length) config.requiredChecks = [...new Set(names)]; else delete config.requiredChecks; changeNode({ config }); }} /><small>按当前提交 SHA 精确匹配。缺少任一检查就继续等待；空白为旧版行为，不建议用于正式交付。</small></label>}
        {(current.kind === 'ci' || current.kind === 'agent' && current.config.mode === 'develop') && <><label>任务状态联动<RadixSelect disabled={!onChange} value={current.config.taskTransition?.mode ?? 'off'} onChange={e => { const config = { ...current.config }; if (e.target.value === 'off') delete config.taskTransition; else config.taskTransition = { phase: current.kind === 'agent' ? 'start' : 'review', mode: e.target.value as 'auto' | 'confirm' }; changeNode({ config }); }}><option value="off">不联动</option><option value="auto">自动申请流转</option><option value="confirm">等待人工确认后流转</option></RadixSelect></label><small>{current.kind === 'agent' ? '进入开发节点、派发 Agent 前：待办 → 进行中。' : '同提交的测试、开放 Draft PR 与 CI 通过后：进行中 → 待审核。'} PM 业务服务校验状态边与权限，不自动完成任务。</small></>}
        {run?.transitions?.[current.id] && <p className="workflow-node-output">状态联动：{run.transitions[current.id]?.message}<br />收据：{run.transitions[current.id]?.commandId ?? '尚未确认'}</p>}
        {current.kind === 'approval' && <label>人工确认事项<textarea readOnly={!onChange} maxLength={8000} value={current.config.instruction ?? ''} onChange={e => changeNode({ config: { instruction: e.target.value } })} /></label>}
        {current.kind === 'end' && <label>结束结果<RadixSelect disabled={!onChange} value={current.config.outcome} onChange={e => changeNode({ config: { outcome: e.target.value as 'success' | 'failure' } })}><option value="success">工作流完成，成果待审查</option><option value="failure">失败，交由人工处理</option></RadixSelect></label>}
        {run && <p className="workflow-node-output">{workflowNodeMessage(run, current.id)}<br />开始：{run.nodes[current.id]?.startedAt ?? '—'}<br />结束：{run.nodes[current.id]?.finishedAt ?? '—'}</p>}
        {onChange && <button type="button" onClick={() => { onChange({ ...graph, nodes: graph.nodes.filter(n => n.id !== selected), edges: graph.edges.filter(e => e.source !== selected && e.target !== selected) }); setSelected(''); }}>删除选中节点及连线</button>}
      </>}
      {onChange && <><h3>连线（也可拖动端口）</h3><label>起点<RadixSelect value={from} onChange={e => setFrom(e.target.value)}><option value="">选择节点</option>{graph.nodes.filter(n => n.kind !== 'end').map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</RadixSelect></label><label>出口<RadixSelect value={port} onChange={e => setPort(e.target.value as typeof port)}><option value="next">下一步</option><option value="pass">条件：通过</option><option value="fail">条件：失败</option></RadixSelect></label><label>终点<RadixSelect value={to} onChange={e => setTo(e.target.value)}><option value="">选择节点</option>{graph.nodes.filter(n => n.kind !== 'task' && n.id !== from).map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</RadixSelect></label><button type="button" disabled={!from || !to} onClick={() => connect(from, to, port)}>连接 / 替换出口</button>
        <label>选中连线<RadixSelect value={edgeId} onChange={e => setEdgeId(e.target.value)}><option value="">选择连线</option>{graph.edges.map(e => <option key={e.id} value={e.id}>{graph.nodes.find(n => n.id === e.source)?.label} → {graph.nodes.find(n => n.id === e.target)?.label} ({e.port})</option>)}</RadixSelect></label><button type="button" disabled={!edgeId} onClick={() => { onChange({ ...graph, edges: graph.edges.filter(e => e.id !== edgeId) }); setEdgeId(''); }}>删除连线</button>
        <h3>发布校验</h3>{problems.length ? <ul className="workflow-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul> : <p className="workflow-valid">图结构校验通过</p>}<small>第一版：最多 32 个节点；不支持循环或并行。每个出口仅连接一个节点。</small>
      </>}
    </aside>
  </div>;
}
