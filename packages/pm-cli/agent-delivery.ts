import { z } from 'zod';
import { connectAgent } from './agent-connection.ts';
import { CliRequestError, inputFile, nonempty, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';
import { deliveryActionSchema, deliveryScopeSchema, prepareDeliverySchema, type DeliveryScope, type TaskCodeDelivery } from '../contracts/src/task-code-delivery.ts';
import { workflowControlSchema, workflowSaveSchema, workflowStartSchema } from '../contracts/src/task-workflow.ts';
import { appPreviewActionSchema } from '../contracts/src/task-app-preview.ts';
import { roadmapDeliveryScopeSchema } from '../contracts/src/product-roadmap.ts';
import { executionSelectionSchema } from '../agent-contracts/src/execution.ts';
import { taskBriefStageSchema } from '../agent-contracts/src/task-brief.ts';

const HELP = `  pm agent delivery list --workspace-id UUID --project-id PRJ-N --task-id TASK-N
  pm agent delivery prepare --file REQUEST.json
  pm agent delivery get UUID
  pm agent delivery brief UUID --stage analysis|development|review|recovery
  pm agent delivery develop UUID --file DEVELOPMENT.json
  pm agent delivery test UUID --command COMMAND --confirm true
  pm agent delivery commit UUID --fingerprint FINGERPRINT --confirm true
  pm agent delivery push|draft-pr UUID --head SHA --confirm true
  pm agent delivery refresh UUID
  pm agent delivery new-session UUID --selection-file SELECTION.json --confirm true
  pm agent workflow catalog --workspace-id UUID --project-id PRJ-N --task-id TASK-N [--selection-file SELECTION.json]
  pm agent workflow save-definition --file DEFINITION.json
  pm agent workflow start --file START.json
  pm agent workflow get UUID
  pm agent workflow pause|resume|approve|confirm-transition UUID --version N --confirm true
  pm agent workflow new-session UUID --version N --selection-file SELECTION.json --confirm true
  pm agent preview task status UUID
  pm agent preview task start UUID --head SHA --confirm true
  pm agent preview task stop UUID --confirm true
  pm agent preview project candidate --workspace-id UUID --project-id PRJ-N --release-id UUID [--refresh true]
  pm agent preview project status UUID --workspace-id UUID --project-id PRJ-N --release-id UUID
  pm agent preview project start UUID --workspace-id UUID --project-id PRJ-N --release-id UUID --head SHA --confirm true
  pm agent preview project stop UUID --workspace-id UUID --project-id PRJ-N --release-id UUID --confirm true

Delivery/workflow/preview require Agent service access (PM_AGENT_URL) and current
native PM login (PM_API_URL). Unconfigured loopback needs no Agent login; configured
Agent access still requires its token. Neither grants PM permissions.
Use the same public origin with /agent, or literal loopback.
Input files use the existing strict API schemas (JSON/YAML, at most 5 MiB).
prepare requires your stable id, taskRevision, baseBranch, scope and explicit v2
executionSelection. develop files contain providerInstanceId, model and optional
purpose/instruction/allowWorktreeWrite; never an action, cwd or endpoint.
Selection files contain {version:2,agentWorkspaceId,agentWorkspaceRevision}.
save-definition includes id, scope, expectedRevision, graph and publish.
start includes a stable id, scope/taskRevision, definitionId/definitionVersion,
baseBranch/repository, Provider/model, executionSelection and separate consent
for execute, worktreeWrite, commit, push, draftPr and (if used) taskStatus.
Only the current finite node types/immutable published versions are supported;
this does not restore the retired Runner or authorize arbitrary DAG execution.
get/brief/candidate/status are observations, not development or task completion.
refresh explicitly reconciles the ORIGINAL delivery/generation/Git/PR/CI receipt;
unknown writes are never retried, and an unknown test cannot be inferred passed.
Changed requirements, code fingerprints or HEAD make old evidence stale. Review
receipts/diff before EACH commit, push and Draft PR authorization. Execution,
workflow/CI success and preview health NEVER mark a task Done. pause does not
cancel in-flight work; new-session preserves evidence and does not run a model.
Preview runs only committed app/server.mjs through the existing Linux namespace
protocol; unavailable isolation is rejection, never an ordinary-process fallback.
A lost preview start/stop response must be queried with status before another action.`;

type RequestPlan = { route: string; body?: unknown; deliveryReceipt?: boolean };
const scopeOptions = ['workspace-id', 'project-id', 'task-id'] as const;
const projectOptions = ['workspace-id', 'project-id', 'release-id'] as const;

function uuid(value: string | undefined): string { return z.uuid().parse(nonempty(value, 'UUID')); }
function positive(value: string | undefined): number {
  const text = nonempty(value, '--version');
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('--version must be a positive integer from the current run receipt');
  return Number(text);
}
function confirm(value: string | undefined): true {
  if (value !== 'true') throw new Error('This action requires explicit --confirm true');
  return true;
}
function scope(options: Record<string, string>): DeliveryScope {
  return deliveryScopeSchema.parse({ workspaceId: options['workspace-id'], projectId: options['project-id'], taskId: options['task-id'] });
}
function projectScope(options: Record<string, string>) {
  return roadmapDeliveryScopeSchema.parse({ workspaceId: options['workspace-id'], projectId: options['project-id'], releaseId: options['release-id'] });
}
function query(value: Record<string, string>): string { return new URLSearchParams(value).toString(); }
async function selection(filename: string | undefined) {
  const value = executionSelectionSchema.parse(await inputFile(filename));
  if (value.agentWorkspaceId === null) throw new Error('Delivery, workflow and replacement Session require an explicit Agent folder, not chat-only execution');
  return value;
}
function noTrailing(args: string[], count: number, usage: string): void { if (args.length !== count) throw new Error(`Usage: ${usage}`); }

async function delivery(args: string[]): Promise<RequestPlan> {
  const action = args[0];
  if (action === 'list') {
    const options = parseOptions(args.slice(1), scopeOptions);
    return { route: `/api/task-deliveries?${query(scope(options))}` };
  }
  if (action === 'prepare') {
    const options = parseOptions(args.slice(1), ['file']);
    return { route: '/api/task-deliveries', body: prepareDeliverySchema.parse(await inputFile(options.file)), deliveryReceipt: true };
  }
  if (!['get', 'brief', 'develop', 'test', 'commit', 'push', 'draft-pr', 'refresh', 'new-session'].includes(action ?? '')) {
    throw new Error('Usage: pm agent delivery list|prepare|get|brief|develop|test|commit|push|draft-pr|refresh|new-session; see pm --help');
  }
  const id = uuid(args[1]), route = `/api/task-deliveries/${id}`;
  if (action === 'get' || action === 'refresh') {
    noTrailing(args, 2, `pm agent delivery ${action} UUID`);
    return action === 'get' ? { route } : { route: `${route}/actions`, body: deliveryActionSchema.parse({ action }), deliveryReceipt: true };
  }
  if (action === 'brief') {
    const options = parseOptions(args.slice(2), ['stage']);
    return { route: `${route}/brief?${query({ stage: taskBriefStageSchema.parse(options.stage) })}` };
  }
  let body: unknown;
  if (action === 'develop') {
    const options = parseOptions(args.slice(2), ['file']);
    const input = await inputFile(options.file);
    if (Object.hasOwn(input, 'action')) throw new Error('The develop command fixes its action; input files must not supply action');
    body = deliveryActionSchema.parse({ action, ...input });
  } else if (action === 'test') {
    const options = parseOptions(args.slice(2), ['command', 'confirm']);
    body = deliveryActionSchema.parse({ action, command: options.command, confirm: confirm(options.confirm) });
  } else if (action === 'commit') {
    const options = parseOptions(args.slice(2), ['fingerprint', 'confirm']);
    body = deliveryActionSchema.parse({ action, fingerprint: options.fingerprint, confirm: confirm(options.confirm) });
  } else if (action === 'push' || action === 'draft-pr') {
    const options = parseOptions(args.slice(2), ['head', 'confirm']);
    body = deliveryActionSchema.parse({ action, head: options.head, confirm: confirm(options.confirm) });
  } else {
    const options = parseOptions(args.slice(2), ['selection-file', 'confirm']);
    body = deliveryActionSchema.parse({ action, executionSelection: await selection(options['selection-file']), confirm: confirm(options.confirm) });
  }
  return { route: `${route}/actions`, body, deliveryReceipt: true };
}

async function workflow(args: string[]): Promise<RequestPlan> {
  const action = args[0];
  if (action === 'catalog') {
    const options = parseOptions(args.slice(1), [...scopeOptions, 'selection-file']);
    const parameters: Record<string, string> = { ...scope(options) };
    if (options['selection-file'] !== undefined) parameters.executionSelection = JSON.stringify(await selection(options['selection-file']));
    return { route: `/api/task-workflows?${query(parameters)}` };
  }
  if (action === 'save-definition' || action === 'start') {
    const options = parseOptions(args.slice(1), ['file']);
    const input = await inputFile(options.file);
    const body = action === 'start' ? workflowStartSchema.parse(input) : workflowSaveSchema.parse(input);
    return { route: action === 'start' ? '/api/task-workflows/runs' : '/api/task-workflows/definitions', body };
  }
  if (!['get', 'pause', 'resume', 'approve', 'confirm-transition', 'new-session'].includes(action ?? '')) {
    throw new Error('Usage: pm agent workflow catalog|save-definition|start|get|pause|resume|approve|confirm-transition|new-session; see pm --help');
  }
  const route = `/api/task-workflows/runs/${uuid(args[1])}`;
  if (action === 'get') { noTrailing(args, 2, 'pm agent workflow get UUID'); return { route }; }
  const options = parseOptions(args.slice(2), action === 'new-session' ? ['version', 'selection-file', 'confirm'] : ['version', 'confirm']);
  const body = workflowControlSchema.parse({ action, version: positive(options.version), confirm: confirm(options.confirm),
    ...(action === 'new-session' ? { executionSelection: await selection(options['selection-file']) } : {}) });
  return { route: `${route}/control`, body };
}

async function preview(args: string[]): Promise<RequestPlan> {
  const target = args[0], action = args[1];
  if (target === 'project' && action === 'candidate') {
    const options = parseOptions(args.slice(2), [...projectOptions, 'refresh']);
    if (options.refresh !== undefined && options.refresh !== 'true') throw new Error('--refresh must be true when explicitly requesting fresh integration receipts');
    return { route: `/api/project-roadmap-deliveries?${query({ ...projectScope(options), ...(options.refresh === 'true' ? { refresh: '1' } : {}) })}` };
  }
  if (!['task', 'project'].includes(target ?? '') || !['status', 'start', 'stop'].includes(action ?? '')) {
    throw new Error('Usage: pm agent preview task|project status|start|stop UUID; project candidate reads the eligible integration receipt; see pm --help');
  }
  const options = parseOptions(args.slice(3), [...(target === 'project' ? projectOptions : []), ...(action === 'start' ? ['head', 'confirm'] : action === 'stop' ? ['confirm'] : [])]);
  const id = uuid(args[2]);
  const route = target === 'task' ? `/api/task-deliveries/${id}/preview` : `/api/project-app-previews/${id}?${query(projectScope(options))}`;
  if (action === 'status') return { route };
  return { route, body: appPreviewActionSchema.parse({ action, ...(action === 'start' ? { head: options.head } : {}), confirm: confirm(options.confirm) }) };
}

/** Closed operator API resources: never a raw git/gh, HTTP proxy or model-tool expansion. */
export const agentDeliveryFamily: CliFamily = {
  help: HELP,
  async dispatch(args: string[], runtime: CliRuntime): Promise<boolean> {
    if (args[0] !== 'agent' || !['delivery', 'workflow', 'preview'].includes(args[1] ?? '')) return false;
    // Validate every option and file before opening either authenticated connection.
    const plan = await (args[1] === 'delivery' ? delivery(args.slice(2)) : args[1] === 'workflow' ? workflow(args.slice(2)) : preview(args.slice(2)));
    const connection = await connectAgent();
    try {
      // These existing authority APIs explicitly recheck the caller's native PM identity.
      // It is additional context, never an Agent login credential or an ambient fallback.
      const pm = await runtime.authentication();
      // Existing verification commands may run for 120s; JSON convenience has a
      // shorter discovery timeout, so own this bounded request and its body.
      const response = await connection.request(plan.route, {
        signal: AbortSignal.timeout(150_000),
        ...(plan.body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan.body) }),
      }, pm);
      if (!response.ok) {
        await response.body?.cancel();
        throw new CliRequestError('AGENT_DELIVERY_REQUEST_FAILED', `Agent ${args[1]} request failed (HTTP ${response.status}); inspect the current original receipt. No write was retried.`, [], response.status);
      }
      let result: unknown;
      try { result = await response.json(); }
      catch { throw new CliRequestError('AGENT_DELIVERY_RESPONSE_UNKNOWN', 'The original Agent response was incomplete; inspect get/brief/status for this same identity before any further write. No write was retried.'); }
      runtime.print(result);
      if (plan.deliveryReceipt && result && typeof result === 'object') {
        const receipt = result as TaskCodeDelivery;
        if (receipt.pending) throw new CliRequestError('AGENT_DELIVERY_OUTCOME_UNKNOWN', `Original ${receipt.pending.action} outcome is unknown for ${receipt.id}; inspect get/brief and explicitly refresh this same delivery. No write was retried.`);
        if (args[1] === 'delivery' && args[2] === 'test' && receipt.test?.passed === false) throw new CliRequestError('AGENT_DELIVERY_VERIFICATION_FAILED', `Delivery ${receipt.id} retains failed or stale verification evidence; inspect the receipt, not merely the command exit status.`);
      }
      return true;
    } finally { connection.close(); }
  },
};
