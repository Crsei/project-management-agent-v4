import { z } from 'zod';
import {
  evaluationPolicyInputSchema, evaluationPolicyActionSchema, evaluationDeleteSchema, evaluationMetadataExportSchema,
  evaluationWindowInputSchema, evaluationDecisionInputSchema, evaluationWindowSummaryEnvelopeSchema,
} from '../agent-contracts/src/evaluation-feedback.ts';
import { connectAgent, type AgentPmContext } from './agent-connection.ts';
import { inputFile, parseOptions, type CliFamily } from './runtime.ts';

const help = `  agent evaluation status
  agent evaluation configure --file SCOPED_METADATA_POLICY.json
  agent evaluation pause|revoke --file ORIGINAL_POLICY_REVISION.json
  agent evaluation export [--pm-context true]
  agent evaluation delete --file OBSERVATION_DELETION.json
  agent evaluation retention
  agent evaluation window-create --file PREREGISTERED_WINDOW.json
  agent evaluation window UUID [--pm-context true]
  agent evaluation decision --file AUDITED_DECISION.json
  agent evaluation decisions [--pm-context true]
  All commands accept --origin AGENT_SERVICE_URL and explicit --pm-context true|false.
  Sampling defaults OFF; release identities come only from deployment-owned service configuration.
  Configure requires an exact Session scope, purpose, expiry/retention and separate random/failure/unknown probabilities.
  Export is sanitized technical metadata, never Chat content or release authorization.
  Pause affects new metadata admissions only; rollback records do not cancel executions, deploy, restore databases or undo PM facts.
  Unknown writes are not retried. Read status/original window/decisions before any new command.`;

export const agentEvaluationFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    if (args[0] !== 'agent' || args[1] !== 'evaluation') return false;
    const action = args[2], tail = args.slice(3);
    const readActions: Record<string, string> = { status: '/status', export: '/export', retention: '/retention', decisions: '/decisions' };
    const schemas: Record<string, { schema: z.ZodType; endpoint: string }> = {
      configure: { schema: evaluationPolicyInputSchema, endpoint: '/policies' },
      pause: { schema: evaluationPolicyActionSchema, endpoint: '/policies/pause' },
      revoke: { schema: evaluationPolicyActionSchema, endpoint: '/policies/revoke' },
      delete: { schema: evaluationDeleteSchema, endpoint: '/observations/delete' },
      'window-create': { schema: evaluationWindowInputSchema, endpoint: '/windows' },
      decision: { schema: evaluationDecisionInputSchema, endpoint: '/decisions' },
    };
    let route: string, body: unknown, post = false;
    let options: Record<string, string>;
    if (action === 'window') {
      const id = z.uuid().parse(tail[0]);
      options = parseOptions(tail.slice(1), ['origin', 'pm-context']); route = `/windows/${id}`;
    } else if (action && Object.hasOwn(readActions, action)) {
      options = parseOptions(tail, ['origin', 'pm-context']); route = readActions[action]!;
      post = action === 'export' || action === 'retention';
    } else if (action && Object.hasOwn(schemas, action)) {
      options = parseOptions(tail, ['origin', 'pm-context', 'file']);
      const operation = schemas[action]!;
      body = operation.schema.parse(await inputFile(options.file)); route = operation.endpoint; post = true;
    } else throw new Error(`Unknown or incomplete pm agent evaluation command.\n${help}`);
    if (options['pm-context'] !== undefined && !['true', 'false'].includes(options['pm-context'])) throw new Error('--pm-context requires true or false');
    const connection = await connectAgent(options.origin === undefined ? {} : { origin: options.origin });
    try {
      let pmContext: AgentPmContext | undefined;
      if (options['pm-context'] === 'true') {
        const authentication = await runtime.authentication();
        pmContext = { origin: authentication.origin, headers: authentication.headers };
      }
      const value = await connection.json(`/api/evaluation${route}`, { ...(post ? { method: 'POST' as const } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, pmContext);
      runtime.print(action === 'export' ? evaluationMetadataExportSchema.parse(value) : action === 'window' ? evaluationWindowSummaryEnvelopeSchema.parse(value) : value);
      return true;
    } finally { connection.close(); }
  },
};
