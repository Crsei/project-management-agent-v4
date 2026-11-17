import type { CanvasRun } from '../../../../../../packages/contracts/src/product-canvas';
import { canvasIssue, canvasProgress } from './canvas-presentation';

export function CanvasBuildStatus({ run }: { run: CanvasRun }) {
  const view = canvasProgress(run);
  return <section className="canvas-build-status" aria-label="产品构建进度" data-state={run.status}>
    <div className="canvas-build-summary" role="status"><strong>{view.title}</strong><span>{view.verified} / {view.total} 个功能检查通过</span></div>
    <progress max={Math.max(1, view.total)} value={view.verified} aria-label="功能检查进度" />
    {view.feature && <p>{run.status === 'paused' ? '暂停在' : '当前功能'}：<strong>{view.feature}</strong></p>}
    <p>{view.description}</p>
  </section>;
}

export function CanvasOperationNotice({ message }: { message: string }) {
  const issue = canvasIssue(message);
  return <section className="canvas-operation-notice"><p role="alert"><strong>{issue.title}</strong> · {issue.description}</p>
    <details><summary>诊断详情</summary><pre>{message}</pre></details>
  </section>;
}
