import { z } from 'zod';
import { planningRecordsNativeInputSchemas, planningRecordsResourceSchema, PlanningRecordsToolInputSchemas, type PlanningRecordsCommandType } from '../application/src/agent-tool-planning-records.ts';
import { roadmapActionSchema, type RoadmapRead } from '../contracts/src/product-roadmap.ts';
import { roadmapDependencyClosure } from '../application/src/product-roadmap.ts';
import { inputFile, nonempty, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';

const uuid = z.uuid().toLowerCase();
const project = z.string().regex(/^PRJ-\d+$/);
const actions: Record<string, Readonly<Record<string, PlanningRecordsCommandType>>> = {
  evidence: { record: 'RecordEvidence' }, submission: { create: 'SubmitWorkItemResult', return: 'ReturnWorkItemForChanges' }, review: { record: 'RecordReview' },
  conversation: { create: 'CreateConversation', append: 'AppendMessage' }, intent: { propose: 'ProposeIntent', revise: 'ReviseIntent', accept: 'AcceptIntent', reject: 'RejectIntent', withdraw: 'WithdrawIntent', task: 'CreateWorkItemFromIntent' }, decision: { record: 'RecordDecision' },
};
const help = `
Planning and independent delivery (actual PM identity and native capabilities):
  evidence|submission|review|conversation|intent|decision list [--project PRJ-ID] [--limit 1..100] [--after CURSOR]
  evidence|submission|review|conversation|intent|decision read UUID
  evidence record | submission create|return | conversation create|append
  intent propose|revise|accept|reject|withdraw|task | decision record
    --file FILE --request-id UUID
  review record --file FILE --request-id UUID --human-confirm true
    Native human-operator only; no model approval tool. Body: {projectId,targetId,expectedVersions:[{id,version}],payload}.
    Artifact/evidence/PM-record references use actual UUIDs; native projects/tasks retain original IDs.
  roadmap read|mapping|drift --project PRJ-ID [--release UUID (mapping/drift only)]
  roadmap save|publish --file FILE --request-id UUID
    save: {projectId,revision,plan}; publish: {projectId,revision,releaseId,confirm:true}
  roadmap materialize --file FILE
    {projectId,releaseId,nodeIds:[original published node UUIDs],confirm:true}; includes dependency closure.
  roadmap inspect --file FILE
    {projectId,input: original save|publish|materialize action}; no write/replay, original commandId for save/publish.
  Integrated delivery evidence: agent preview project candidate --workspace-id UUID --project-id PRJ-ID --release-id UUID [--refresh true]
    Requires independent Agent operator identity and explicit current PM context. Success/review/CI never completes a task.
  On connection loss retain the original file/request ID, inspect/read mapping first; never replace a key or automatically retry.
`;
function usage(resource: string): never { throw new Error(`Unknown or invalid ${resource} command. Run pm --help for the finite ${resource} operations.`); }
async function roadmapCommand(action: string | undefined, rest: string[], runtime: CliRuntime): Promise<void> {
  if (action === 'read' || action === 'mapping' || action === 'drift') {
    const options = parseOptions(rest, action === 'read' ? ['project'] : ['project', 'release']);
    const projectId = project.parse(nonempty(options.project, '--project'));
    const result = await runtime.json<RoadmapRead>('workspace', `/projects/${encodeURIComponent(projectId)}/product-roadmap`);
    if (action === 'read') { runtime.print(result); return; }
    const releaseId = options.release === undefined ? undefined : uuid.parse(options.release);
    if (releaseId && !result.store.releases.some(release => release.id === releaseId)) throw new Error('The original published roadmap release does not exist');
    const mappings = Object.entries(result.tasks).filter(([id]) => releaseId === undefined || id === releaseId).map(([id, tasks]) => ({ releaseId: id, tasks: action === 'drift' ? tasks.filter(task => task.drifted || task.archived) : tasks }));
    runtime.print({ projectId, revision: result.revision, mappings }); return;
  }
  if (action === 'inspect') {
    const options = parseOptions(rest, ['file']);
    const input = z.strictObject({ projectId: project, input: roadmapActionSchema }).parse(await inputFile(options.file));
    runtime.print(await runtime.json('workspace', `/projects/${encodeURIComponent(input.projectId)}/product-roadmap/inspect`, { method: 'POST', body: input.input })); return;
  }
  if (action === 'save' || action === 'publish') {
    const options = parseOptions(rest, ['file', 'request-id']), commandId = uuid.parse(nonempty(options['request-id'], '--request-id'));
    const input = await inputFile(options.file);
    if (action === 'save') {
      const { projectId, ...args } = PlanningRecordsToolInputSchemas.pm_save_roadmap.parse(input);
      runtime.print(await runtime.json('workspace', `/projects/${encodeURIComponent(projectId)}/product-roadmap`, { method: 'POST', body: { ...args, action, commandId } }));
    } else {
      const { projectId, ...args } = PlanningRecordsToolInputSchemas.pm_publish_roadmap.parse(input);
      runtime.print(await runtime.json('workspace', `/projects/${encodeURIComponent(projectId)}/product-roadmap`, { method: 'POST', body: { ...args, action, commandId } }));
    }
    return;
  }
  if (action === 'materialize') {
    const options = parseOptions(rest, ['file']), args = PlanningRecordsToolInputSchemas.pm_materialize_roadmap.parse(await inputFile(options.file));
    const endpoint = `/projects/${encodeURIComponent(args.projectId)}/product-roadmap`;
    let roadmap = await runtime.json<RoadmapRead>('workspace', endpoint);
    const release = roadmap.store.releases.find(row => row.id === args.releaseId);
    if (!release) throw new Error('Publish and inspect the original roadmap version before materialization');
    const dependencyClosure = roadmapDependencyClosure(release, args.nodeIds);
    for (const nodeId of dependencyClosure) roadmap = await runtime.json<RoadmapRead>('workspace', endpoint, { method: 'POST', body: { action: 'materialize', releaseId: args.releaseId, nodeId, confirm: true } });
    const idMap = dependencyClosure.map(nodeId => {
      const rows = (roadmap.tasks[args.releaseId] ?? []).filter(row => row.nodeId === nodeId);
      if (rows.length !== 1) throw new Error('Original node mapping is not uniquely available; inspect instead of recreating');
      return { nodeId, taskId: rows[0]!.taskId, revision: rows[0]!.revision };
    });
    runtime.print({ roadmap, selectedNodeIds: args.nodeIds, dependencyClosure, idMap }); return;
  }
  usage('roadmap');
}
export const planningRecordsFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    const [resource, action, ...rest] = args;
    if (resource !== 'roadmap' && !planningRecordsResourceSchema.safeParse(resource).success) return false;
    if (resource === 'roadmap') { await roadmapCommand(action, rest, runtime); return true; }
    const kind = planningRecordsResourceSchema.parse(resource);
    if (action === 'list') {
      const options = parseOptions(rest, ['project', 'limit', 'after']);
      const query = new URLSearchParams({ kind });
      if (options.project !== undefined) query.set('projectId', project.parse(options.project));
      if (options.limit !== undefined) query.set('limit', String(z.coerce.number().int().min(1).max(100).parse(options.limit)));
      if (options.after !== undefined) query.set('after', nonempty(options.after, '--after'));
      runtime.print(await runtime.json('workspace', `/entities?${query}`)); return true;
    }
    if (action === 'read') {
      if (rest.length !== 1) usage(kind);
      const id = uuid.parse(rest[0]);
      const value = await runtime.json<{ kind: string }>('workspace', `/entities/${encodeURIComponent(id)}`);
      if (value.kind !== kind) throw new Error('Record does not match the requested business resource');
      runtime.print(value); return true;
    }
    const commandType = action === undefined ? undefined : actions[kind]?.[action];
    if (!commandType) usage(kind);
    const options = parseOptions(rest, kind === 'review' ? ['file', 'request-id', 'human-confirm'] : ['file', 'request-id']);
    if (kind === 'review' && options['human-confirm'] !== 'true') throw new Error('Review recording is an explicit human-operator action; pass --human-confirm true only after actual human review');
    const commandId = uuid.parse(nonempty(options['request-id'], '--request-id'));
    const input = planningRecordsNativeInputSchemas[commandType].parse(await inputFile(options.file));
    runtime.print(await runtime.json('workspace', '/commands', { method: 'POST', body: { commandId, commandType, ...(input.projectId === null ? {} : { projectId: input.projectId }), ...(input.targetId === null ? {} : { targetId: input.targetId }), expectedVersions: Object.fromEntries(input.expectedVersions.map(entry => [entry.id, entry.version])), payload: input.payload } }));
    return true;
  },
};
