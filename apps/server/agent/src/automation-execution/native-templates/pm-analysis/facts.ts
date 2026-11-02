import {
  pmAutomationArgumentsSchema, pmAutomationSnapshotSchema,
  type PmAutomationArguments, type PmAutomationCoverage, type PmAutomationEvidence,
  type PmAutomationSnapshot, type PmAutomationSourceRef, type PmAutomationTask,
} from '../../../../../../../packages/contracts/src/automation-pm.ts';
import { time } from './source.ts';

type CoverageKind = PmAutomationCoverage['source'];
export class PmAnalysisFacts {
  readonly snapshot: PmAutomationSnapshot;
  readonly args: PmAutomationArguments;
  readonly refs = new Map<string, PmAutomationSourceRef>();
  readonly texts = new Map<string, string>();
  readonly excerpts = new Map<string, string[]>();
  readonly gaps: Array<{ source: CoverageKind; reason: string }> = [];
  readonly tasks: PmAutomationTask[];
  readonly taskById: Map<string, PmAutomationTask>;
  readonly targets: PmAutomationTask[];
  readonly at: number;
  constructor(snapshot: PmAutomationSnapshot, args: PmAutomationArguments) {
    this.snapshot = pmAutomationSnapshotSchema.parse(snapshot);
    snapshot = this.snapshot;
    this.args = pmAutomationArgumentsSchema.parse(args);
    if (JSON.stringify(this.args) !== JSON.stringify(pmAutomationArgumentsSchema.parse(snapshot.args))) throw new Error('PM analysis arguments differ from frozen execution arguments');
    this.at = Date.parse(snapshot.observedAt);
    for (const ref of snapshot.sources) {
      if (ref.actorId !== snapshot.actorId || ref.workspaceId !== snapshot.workspaceId || ref.projectId !== snapshot.projectId) throw new Error('PM analysis source scope mismatch');
      if (this.refs.has(ref.refId)) throw new Error('Duplicate PM analysis source reference');
      this.refs.set(ref.refId, ref);
    }
    const add = (refId: string, kind: PmAutomationSourceRef['kind'], id: string, value: unknown, revision?: string) => {
      const ref = this.refs.get(refId);
      if (!ref || ref.kind !== kind || ref.id !== id || (revision !== undefined && ref.revision !== revision)) throw new Error(`Invalid ${kind} provenance`);
      this.texts.set(refId, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    };
    add(snapshot.project.sourceRefId, 'project', snapshot.project.id, snapshot.project, snapshot.project.revision);
    if (snapshot.project.id !== snapshot.projectId) throw new Error('PM analysis project mismatch');
    for (const goal of snapshot.project.goals) {
      if (!goal.sourceRefId) continue;
      const ref = this.refs.get(goal.sourceRefId);
      if (!ref || (goal.revision !== undefined && goal.revision !== ref.revision)) throw new Error('Invalid goal revision provenance');
      if (ref.kind === 'project') {
        if (goal.sourceRefId !== snapshot.project.sourceRefId || goal.id !== `${snapshot.project.id}:goal` || ref.revision !== snapshot.project.revision) throw new Error('Invalid embedded project goal provenance');
      } else add(goal.sourceRefId, 'goal', goal.id, goal, goal.revision);
    }
    const workflowRef = this.refs.get(snapshot.workflow.sourceRefId);
    if (!workflowRef || workflowRef.kind !== 'workflow') throw new Error('Invalid workflow provenance');
    this.texts.set(workflowRef.refId, JSON.stringify(snapshot.workflow, null, 2));
    const statusById = new Map(snapshot.workflow.statuses.map(status => [status.id, status]));
    if (statusById.size !== snapshot.workflow.statuses.length) throw new Error('Duplicate workflow status');
    for (const task of snapshot.tasks) {
      if (task.projectId !== snapshot.projectId) throw new Error('PM analysis task scope mismatch');
      add(task.sourceRefId, 'task', task.id, task, task.revision);
      const status = statusById.get(task.status);
      if (!status || status.category !== task.statusCategory) this.gap('workflow', `Task ${task.id} has unknown or inconsistent workflow category`);
    }
    this.tasks = snapshot.tasks.filter(task => statusById.get(task.status)?.category === task.statusCategory && task.statusCategory !== null);
    this.taskById = new Map(this.tasks.map(task => [task.id, task]));
    if (this.taskById.size !== this.tasks.length) throw new Error('Duplicate PM analysis task identity');
    for (const task of this.tasks) if (task.dependsOn.some(dependency => !this.taskById.has(dependency))) this.gap('relationships', `Task ${task.id} has a prerequisite absent from readable current task facts; dependency satisfaction is unknown`);
    for (const doc of snapshot.documents) add(doc.sourceRefId, 'document', doc.id, doc, doc.revision);
    for (const rel of snapshot.relationships) add(rel.sourceRefId, 'relationship', rel.id, rel);
    for (const comment of snapshot.comments) add(comment.sourceRefId, 'comment', comment.id, comment.text);
    for (const activity of snapshot.activities) add(activity.sourceRefId, 'activity', activity.id, activity);
    for (const session of snapshot.sessions) {
      add(session.sourceRefId, 'session', session.id, session);
      for (const message of session.messages) add(message.sourceRefId, 'message', message.id, message.text);
    }
    for (const run of snapshot.executions) {
      add(run.sourceRefId, 'execution', run.id, run);
      for (const test of run.tests) this.addChild(test.sourceRefId, ['test', 'tool', 'execution'], test.detail.trim() ? test.detail : test.name, run.id);
      for (const log of run.logs) this.addChild(log.sourceRefId, ['tool', 'execution', 'message'], log.text, run.id);
      for (const tool of run.tools) this.addChild(tool.sourceRefId, ['tool', 'execution'], tool.summary || tool.name, run.id);
    }
    for (const pr of snapshot.pullRequests) {
      add(pr.sourceRefId, 'pull-request', pr.id, pr);
      for (const item of pr.coverage) this.addChild(item.sourceRefId, ['pull-request', 'test', 'tool'], item.evidence || item.criterion, pr.id);
    }
    for (const milestone of snapshot.milestones) add(milestone.sourceRefId, 'milestone', milestone.id, milestone);
    for (const boundary of [snapshot.before, snapshot.after]) {
      if (!boundary) continue;
      if (boundary.task.projectId !== snapshot.projectId) throw new Error('Version boundary project mismatch');
      add(boundary.task.sourceRefId, 'task', boundary.task.id, boundary.task, boundary.task.revision);
      const ref = this.refs.get(boundary.sourceRefId);
      if (!ref || ref.id !== boundary.task.id || ref.revision !== boundary.task.revision) throw new Error('Invalid frozen version boundary source');
      this.texts.set(boundary.sourceRefId, JSON.stringify(boundary, null, 2));
    }
    for (const coverage of snapshot.coverage) {
      if (coverage.status !== 'complete' || (coverage.totalRecords !== null && coverage.observedRecords < coverage.totalRecords)) this.gap(coverage.source, coverage.reason ?? `${coverage.source} coverage is ${coverage.status}`);
    }
    const selectors = this.args;
    if (selectors.taskIds?.some(id => !this.taskById.has(id))) throw new Error('Selected task unavailable; analysis cannot widen scope');
    if (selectors.statusIds?.some(id => !statusById.has(id))) throw new Error('Selected status unavailable; analysis cannot widen scope');
    this.targets = this.tasks.filter(task => (!selectors.taskIds || selectors.taskIds.includes(task.id)) && (!selectors.statusIds || selectors.statusIds.includes(task.status)) && (!selectors.assigneeIds || selectors.assigneeIds.some(id => task.assigneeIds.includes(id))) && (!selectors.labels || selectors.labels.every(label => task.labels.includes(label))) && (!selectors.milestoneId || snapshot.templateId === 'pm-next-phase-plan' || selectors.milestoneId === task.milestoneId));
    if (selectors.milestoneId && !snapshot.milestones.some(item => item.id === selectors.milestoneId)) throw new Error('Selected milestone unavailable');
    if (!this.targets.length) this.gap('tasks', 'No readable task facts match the frozen scope; this is not a successful project assessment');
  }
  private addChild(refId: string, kinds: PmAutomationSourceRef['kind'][], text: string, parentId: string) {
    const ref = this.refs.get(refId);
    if (!ref || !kinds.includes(ref.kind) || ((ref.kind === 'execution' || ref.kind === 'pull-request') && ref.id !== parentId)) throw new Error('Invalid execution evidence provenance');
    const previous = this.texts.get(refId);
    if (previous === undefined) this.texts.set(refId, text);
    const excerpts = this.excerpts.get(refId) ?? [];
    excerpts.push(text); this.excerpts.set(refId, excerpts);
  }
  gap(source: CoverageKind, reason: string): void {
    if (!this.gaps.some(item => item.source === source && item.reason === reason)) this.gaps.push({ source, reason });
  }
  complete(...sources: CoverageKind[]): boolean {
    const missing = sources.filter(source => !this.snapshot.coverage.some(item => item.source === source && item.status === 'complete' && (item.totalRecords === null || item.observedRecords >= item.totalRecords)));
    for (const source of missing) this.gap(source, `Complete ${source} coverage is required for this absence/all-members rule`);
    return !missing.length && !sources.some(source => this.gaps.some(gap => gap.source === source));
  }
  evidence(refId: string, quote?: string): PmAutomationEvidence {
    const text = this.texts.get(refId);
    if (text === undefined) throw new Error('Evidence source has no validated facts');
    const excerpt = quote ?? text.slice(0, 12000);
    if ((!text.includes(excerpt) && !this.excerpts.get(refId)?.some(value => value.includes(excerpt))) || !excerpt.trim()) throw new Error('Evidence quote is not present in source');
    return { sourceRefId: refId, quote: excerpt.slice(0, 12000) };
  }
  sourceRefs(evidence: readonly PmAutomationEvidence[]): PmAutomationSourceRef[] {
    return [...new Set(evidence.map(item => item.sourceRefId))].map(id => this.refs.get(id)!);
  }
  open(task: PmAutomationTask): boolean { return !task.archived && task.statusCategory !== 'completed' && task.statusCategory !== 'canceled'; }
  running(taskId: string): boolean { return this.snapshot.executions.some(run => run.taskId === taskId && ['queued', 'running', 'outcome_unknown'].includes(run.status)); }
  latest(task: PmAutomationTask): number | undefined {
    const values = [task.createdAt, task.updatedAt, task.lastActivityAt,
      ...this.snapshot.comments.filter(item => item.taskId === task.id).map(item => item.at),
      ...this.snapshot.activities.filter(item => item.taskId === task.id && !item.automationOrigin).map(item => item.at),
      ...this.snapshot.sessions.filter(item => item.taskIds.includes(task.id)).flatMap(item => [item.createdAt, item.updatedAt, ...item.messages.map(message => message.at)]),
      ...this.snapshot.executions.filter(item => item.taskId === task.id).flatMap(item => [item.startedAt, item.finishedAt]),
    ].map(time).filter((value): value is number => value !== undefined);
    if (values.some(value => value > this.at)) { this.gap('tasks', `Task ${task.id} has future activity timestamps`); return undefined; }
    return values.length ? Math.max(...values) : undefined;
  }
  satisfied(task: PmAutomationTask): boolean {
    return task.dependsOn.every(id => this.taskById.get(id)?.statusCategory === 'completed');
  }
}
