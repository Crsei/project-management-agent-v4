import path from 'node:path';
import { z } from 'zod';
import { administrationCommandPayloadSchemas } from '../application/src/agent-tool-administration.ts';
import { workspaceCreationRequestSchema, workspaceCreationRecoveryRequestSchema } from '../contracts/src/workspace-creation.ts';
import { changeOwnPasswordSchema, revokeOwnSessionsSchema, recoverAccountSecurityActionSchema, accountSecurityActionSchema } from '../contracts/src/account-security-schemas.ts';
import { beginRecoveryEmailSchema, confirmRecoveryEmailSchema, cancelRecoveryEmailSchema, unbindRecoveryEmailSchema, recoveryRequestSchema, recoveryRequestIdSchema, recoveryTokenSchema, completePasswordRecoverySchema, recoveryActionInputSchema, recoveryRequestResultSchema, recoveryRequestLookupSchema, recoveryInspectionSchema, passwordResetActionSchema, passwordResetActionLookupSchema } from '../contracts/src/account-recovery-schemas.ts';
import { localDirectorySchema, localProjectInitializationSchema, localProjectPreviewSchema, localProjectProbeSchema, localProjectSettingsUpdateSchema, localProjectMoveSchema, localProjectRelocationSchema } from '../contracts/src/local-projects.ts';
import { isIanaTimeZone } from '../domain/src/dashboard-personal.ts';
import { readPrivateFile } from './private-files.ts';
import { serviceOrigin } from './auth.ts';
import { CliRequestError, inputFile, nonempty, parseOptions, type CliFamily, type CliRuntime, type PmScope } from './runtime.ts';

const uuid = z.uuid().toLowerCase();
const projectId = z.string().regex(/^PRJ-\d+$/);
const key = z.string().min(1).max(512).refine(value => !!value.trim());
const versions = z.record(z.string().min(1).max(80), z.number().int().positive());
const profilePayload = z.strictObject({ name: z.string().trim().min(1).max(200).optional(), timeZone: z.string().min(1).max(200).refine(isIanaTimeZone).optional(), jobTitle: z.string().trim().min(1).max(200).nullable().optional(), phone: z.string().trim().min(1).max(80).nullable().optional(), avatarDataUrl: z.string().max(349560).nullable().optional() }).refine(value => Object.keys(value).length > 0, 'Provide a profile field');
const copyPayload = z.strictObject({ name: z.string().trim().min(1).max(500), includeTasks: z.boolean(), localDirectory: localDirectorySchema.optional() });
const nativeCommands = {
  'workspace update': ['UpdateWorkspaceIdentity', administrationCommandPayloadSchemas.UpdateWorkspaceIdentity],
  'account profile-update': ['UpdateSelfProfile', profilePayload],
  'members set': ['SetWorkspaceMember', administrationCommandPayloadSchemas.SetWorkspaceMember],
  'members role': ['SetMemberRole', administrationCommandPayloadSchemas.SetMemberRole],
  'members revoke': ['RevokeWorkspaceMember', administrationCommandPayloadSchemas.RevokeWorkspaceMember],
  'invitations create': ['CreateMemberInvitation', administrationCommandPayloadSchemas.CreateMemberInvitation],
  'invitations revoke': ['RevokeMemberInvitation', administrationCommandPayloadSchemas.RevokeMemberInvitation],
  'invitations resend': ['ResendMemberInvitation', administrationCommandPayloadSchemas.ResendMemberInvitation],
  'teams create': ['CreateProjectTeam', administrationCommandPayloadSchemas.CreateProjectTeam],
  'teams rename': ['RenameProjectTeam', administrationCommandPayloadSchemas.RenameProjectTeam],
  'teams update': ['UpdateProjectTeamDetails', administrationCommandPayloadSchemas.UpdateProjectTeamDetails],
  'teams members': ['SetProjectTeamMembers', administrationCommandPayloadSchemas.SetProjectTeamMembers],
  'teams maintainers': ['SetProjectTeamMaintainers', administrationCommandPayloadSchemas.SetProjectTeamMaintainers],
  'teams archive': ['ArchiveProjectTeam', administrationCommandPayloadSchemas.ArchiveProjectTeam],
  'teams projects': ['SetProjectTeams', administrationCommandPayloadSchemas.SetProjectTeams],
  'capacity set': ['SetMemberCapacity', administrationCommandPayloadSchemas.SetMemberCapacity],
  'project favorite': ['SetProjectFavorite', administrationCommandPayloadSchemas.SetProjectFavorite],
  'project order': ['SetProjectSidebarOrder', administrationCommandPayloadSchemas.SetProjectSidebarOrder],
  'project cover': ['SetProjectCover', administrationCommandPayloadSchemas.SetProjectCover],
  'project scope': ['SetProjectScope', administrationCommandPayloadSchemas.SetProjectScope],
  'project copy': ['DuplicateProject', copyPayload],
} as const;
const reads: Record<string, { scope: PmScope; endpoint: string }> = {
  'workspace list': { scope: 'service', endpoint: '/workspaces' },
  'workspace identity': { scope: 'workspace', endpoint: '/identity' },
  'account me': { scope: 'service', endpoint: '/auth/me' },
  'account security': { scope: 'service', endpoint: '/auth/security' },
  'members list': { scope: 'workspace', endpoint: '/members' },
  'members directory': { scope: 'workspace', endpoint: '/members/directory' },
  'invitations list': { scope: 'workspace', endpoint: '/members/invitations' },
  'teams list': { scope: 'workspace', endpoint: '/teams/directory' },
  'workload get': { scope: 'workspace', endpoint: '/teams/workload' },
  'project extras': { scope: 'workspace', endpoint: '/projects/extras' },
  'project directory': { scope: 'workspace', endpoint: '/projects/directory' },
  'directories settings': { scope: 'workspace', endpoint: '/local-projects/settings' },
};
const secrets = {
  'account password': { endpoint: '/auth/security/password', schema: changeOwnPasswordSchema, anonymous: false },
  'account recovery-email-begin': { endpoint: '/auth/security/recovery-email', schema: beginRecoveryEmailSchema, anonymous: false },
  'account recovery-email-confirm': { endpoint: '/auth/security/recovery-email/confirm', schema: confirmRecoveryEmailSchema, anonymous: false },
  'account recovery-email-cancel': { endpoint: '/auth/security/recovery-email/cancel', schema: cancelRecoveryEmailSchema, anonymous: false },
  'account recovery-email-unbind': { endpoint: '/auth/security/recovery-email/unbind', schema: unbindRecoveryEmailSchema, anonymous: false },
  'account recovery-request': { endpoint: '/auth/password-recovery/requests', schema: recoveryRequestSchema, anonymous: true },
  'account recovery-request-status': { endpoint: '/auth/password-recovery/requests/lookup', schema: recoveryRequestIdSchema, anonymous: true },
  'account recovery-request-recover': { endpoint: '/auth/password-recovery/requests/recover', schema: recoveryRequestIdSchema, anonymous: true },
  'account recovery-inspect': { endpoint: '/auth/password-recovery/inspect', schema: recoveryTokenSchema, anonymous: true },
  'account recovery-complete': { endpoint: '/auth/password-recovery/complete', schema: completePasswordRecoverySchema, anonymous: true },
  'account recovery-action-status': { endpoint: '/auth/password-recovery/actions/lookup', schema: recoveryActionInputSchema, anonymous: true },
  'account recovery-action-recover': { endpoint: '/auth/password-recovery/actions/recover', schema: recoveryActionInputSchema, anonymous: true },
  'invitations inspect': { endpoint: '/invitations/inspect', schema: z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), anonymous: true },
  'invitations accept': { endpoint: '/invitations/accept', schema: z.strictObject({ commandId: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().max(256), name: z.string().trim().min(1).max(200).optional() }), anonymous: true },
  'invitations receipt': { endpoint: '/invitations/receipt', schema: z.strictObject({ commandId: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().max(256) }), anonymous: true },
} as const;
const acceptedInvitation = z.strictObject({ workspaceId: uuid, userId: uuid, email: z.email().max(254), alreadyAccepted: z.boolean() });
const privateResultSchemas: Record<keyof typeof secrets, z.ZodType> = {
  'account password': accountSecurityActionSchema,
  'account recovery-email-begin': accountSecurityActionSchema, 'account recovery-email-confirm': accountSecurityActionSchema,
  'account recovery-email-cancel': accountSecurityActionSchema, 'account recovery-email-unbind': accountSecurityActionSchema,
  'account recovery-request': recoveryRequestResultSchema, 'account recovery-request-status': recoveryRequestLookupSchema, 'account recovery-request-recover': recoveryRequestLookupSchema,
  'account recovery-inspect': recoveryInspectionSchema, 'account recovery-complete': passwordResetActionSchema,
  'account recovery-action-status': passwordResetActionLookupSchema, 'account recovery-action-recover': passwordResetActionLookupSchema,
  'invitations inspect': z.strictObject({ workspaceId: uuid, workspaceName: z.string().max(200), email: z.email().max(254), role: z.enum(['admin', 'member', 'guest']), projectIds: z.array(projectId).nullable(), expiresAt: z.iso.datetime({ offset: true }), accountExists: z.boolean() }),
  'invitations accept': acceptedInvitation, 'invitations receipt': z.strictObject({ outcome: acceptedInvitation.nullable() }),
};
const directoryWrites = {
  'directories defaults': { endpoint: '/local-projects/settings', method: 'PUT', schema: localProjectSettingsUpdateSchema },
  'directories probe': { endpoint: '/local-projects/probe', method: 'POST', schema: localProjectProbeSchema },
  'directories preview': { endpoint: '/local-projects/preview', method: 'POST', schema: localProjectPreviewSchema },
  'directories initialize': { endpoint: '/local-projects/initializations', method: 'POST', schema: localProjectInitializationSchema },
} as const;
const prefixes = ['workspace', 'account', 'members', 'invitations', 'teams', 'capacity', 'workload', 'project', 'directories'];
function validated<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Input does not match this named operation’s strict schema; unsupported fields and invalid values were not sent.');
  return result.data as z.output<Schema>;
}
async function expectedActor(runtime: CliRuntime, expected: string | undefined): Promise<void> {
  const id = validated(uuid, nonempty(expected, '--expected-actor'));
  const current = await runtime.json<{ actor: { id: string } }>('service', '/auth/me');
  if (current.actor.id !== id) throw new Error('session_changed: The authenticated actor differs from the original request. No write was sent; retain the original identity.');
}
async function privateInput(filename: string | undefined, schema: z.ZodType): Promise<unknown> {
  const source = await readPrivateFile(path.resolve(nonempty(filename, '--private-file')));
  if (source === undefined) throw new Error('The explicitly selected private input file does not exist.');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Private input must be strict JSON; its contents were not printed.'); }
  return validated(schema, value);
}
/** Public bearer recovery/acceptance routes must remain usable with no PM login. */
async function anonymousPost(endpoint: string, body: unknown): Promise<unknown> {
  let response: Response;
  try { response = await fetch(`${serviceOrigin()}/api/v1${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: serviceOrigin() }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('The original anonymous request outcome is unconfirmed. Query its original request/action/acceptance identity; do not resend or replace it.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The named account/invitation request failed (HTTP ${response.status}); private input was not printed. Query the original identity before another write.`); }
  try { return await response.json(); } catch { throw new Error('The response was not valid JSON; the original outcome remains unconfirmed.'); }
}
export const administrationFamily: CliFamily = {
  help: `Administration (all writes are explicit; JSON/YAML --file never accepts commandType):
  workspace list | identity
  workspace create --file request.json --request-id UUID
  workspace creation-status UUID
  workspace creation-recover UUID --expected-actor UUID
  workspace update --file command.json --command-id UUID
  account me | profile | security
  account profile-update --file command.json --command-id UUID
  account password --private-file password.json
  account sessions-revoke --file action.json
  account action UUID | action-recover UUID --file kind.json
  account recovery-email-begin|recovery-email-confirm|recovery-email-cancel|recovery-email-unbind --private-file input.json
  account recovery-request|recovery-request-status|recovery-request-recover|recovery-inspect|recovery-complete|recovery-action-status|recovery-action-recover --private-file input.json
  members list | directory
  members set|role|revoke --file command.json --command-id UUID
  invitations list | create|revoke|resend --file command.json --command-id UUID
  invitations inspect|accept|receipt --private-file input.json
  teams list | create|rename|update|members|maintainers|archive|projects --file command.json --command-id UUID
  capacity set --file command.json --command-id UUID
  workload get
  project extras | directory
  project favorite|order|cover|scope --file command.json --command-id UUID
  project copy --file command.json --command-id UUID --expected-actor UUID
  project copy-status UUID | copy-recover UUID --expected-actor UUID
  directories settings | list [--path ABSOLUTE_SERVER_PATH]
  directories defaults|probe|preview --file input.json
  directories initialize --file input.json --request-id KEY --expected-actor UUID
  directories initialization-status KEY | initialization-recover KEY --expected-actor UUID
  directories location PRJ-ID
  directories migrate|relocate PRJ-ID --file input.json --request-id KEY --expected-actor UUID
Command files contain only {targetId?,projectId?,expectedVersions?,payload}; native versions and directory identities are never inferred. Store original IDs before sending. Secrets require owned regular 0600 JSON files in private 0700 directories; passwords/tokens are never argv/stdout. Recovery does not automatically replay unknown writes. SMTP queue acceptance is not verified mailbox delivery.`,
  async dispatch(args, runtime) {
    if (!prefixes.includes(args[0] ?? '')) return false;
    const command = `${args[0]} ${args[1] ?? ''}`;
    const rest = args.slice(2);
    if (Object.hasOwn(reads, command)) {
      parseOptions(rest, []);
      const operation = reads[command]!;
      runtime.print(await runtime.json(operation.scope, operation.endpoint));
    } else if (Object.hasOwn(nativeCommands, command)) {
      const copy = command === 'project copy';
      const options = parseOptions(rest, copy ? ['file', 'command-id', 'expected-actor'] : ['file', 'command-id']);
      const [commandType, payload] = nativeCommands[command as keyof typeof nativeCommands];
      const schema = z.strictObject({ targetId: z.string().min(1).max(80).optional(), projectId: projectId.optional(), expectedVersions: versions.optional(), payload });
      const body = validated(schema, await inputFile(options.file));
      const commandId = validated(uuid, nonempty(options['command-id'], '--command-id'));
      if (copy) await expectedActor(runtime, options['expected-actor']);
      runtime.print(await runtime.json('workspace', '/commands', { method: 'POST', body: { ...body, commandId, commandType } }));
    } else if (Object.hasOwn(secrets, command)) {
      const options = parseOptions(rest, ['private-file']);
      const operation = secrets[command as keyof typeof secrets];
      const body = await privateInput(options['private-file'], operation.schema);
      let result: unknown;
      try { result = operation.anonymous ? await anonymousPost(operation.endpoint, body) : await runtime.json('service', operation.endpoint, { method: 'POST', body }); }
      catch (error) {
        const status = error instanceof CliRequestError ? error.status : undefined;
        throw new Error(`The private account/invitation operation was not confirmed${status ? ` (HTTP ${status})` : ''}. Retain the original action/request/acceptance identity and query it before another write; private diagnostics were withheld.`);
      }
      const safe = privateResultSchemas[command as keyof typeof secrets].safeParse(result);
      if (!safe.success) throw new Error('The private operation returned an unexpected result shape; no response content was printed. Query its original identity before another write.');
      runtime.print(safe.data);
    } else if (command === 'workspace create') {
      const options = parseOptions(rest, ['file', 'request-id']);
      const body = validated(workspaceCreationRequestSchema, await inputFile(options.file));
      runtime.print(await runtime.json('service', '/workspaces', { method: 'POST', body, idempotencyKey: validated(uuid, options['request-id']) }));
    } else if (command === 'workspace creation-status' || command === 'workspace creation-recover') {
      const id = validated(uuid, rest[0]);
      const options = parseOptions(rest.slice(1), command.endsWith('-recover') ? ['expected-actor'] : []);
      const endpoint = `/workspace-creations/${encodeURIComponent(id)}`;
      if (command.endsWith('-recover')) {
        const body = validated(workspaceCreationRecoveryRequestSchema, { expectedActorId: options['expected-actor'] });
        runtime.print(await runtime.json('service', endpoint + '/recover', { method: 'POST', body }));
      } else runtime.print(await runtime.json('service', endpoint));
    } else if (command === 'account profile') {
      parseOptions(rest, []);
      const result = await runtime.json<{ profile: unknown }>('workspace', '/dashboard/personal');
      runtime.print(result.profile);
    } else if (command === 'account sessions-revoke') {
      const options = parseOptions(rest, ['file']);
      runtime.print(await runtime.json('service', '/auth/security/sessions/revoke', { method: 'POST', body: validated(revokeOwnSessionsSchema, await inputFile(options.file)) }));
    } else if (command === 'account action' || command === 'account action-recover') {
      const id = validated(uuid, rest[0]);
      const options = parseOptions(rest.slice(1), command.endsWith('-recover') ? ['file'] : []);
      const endpoint = `/auth/security/actions/${encodeURIComponent(id)}`;
      runtime.print(command.endsWith('-recover') ? await runtime.json('service', endpoint + '/recover', { method: 'POST', body: validated(recoverAccountSecurityActionSchema, await inputFile(options.file)) }) : await runtime.json('service', endpoint));
    } else if (command === 'project copy-status' || command === 'project copy-recover') {
      const id = validated(uuid, rest[0]);
      const options = parseOptions(rest.slice(1), command.endsWith('-recover') ? ['expected-actor'] : []);
      const endpoint = `/commands/${encodeURIComponent(id)}`;
      if (command.endsWith('-recover')) {
        await expectedActor(runtime, options['expected-actor']);
        runtime.print(await runtime.json('workspace', endpoint + '/recover', { method: 'POST', body: {} }));
      } else runtime.print(await runtime.json('workspace', endpoint));
    } else if (Object.hasOwn(directoryWrites, command)) {
      const initialize = command === 'directories initialize';
      const options = parseOptions(rest, initialize ? ['file', 'request-id', 'expected-actor'] : ['file']);
      const operation = directoryWrites[command as keyof typeof directoryWrites];
      const body = validated(operation.schema, await inputFile(options.file));
      if (initialize) await expectedActor(runtime, options['expected-actor']);
      runtime.print(await runtime.json('workspace', operation.endpoint, { method: operation.method, body, ...(initialize ? { idempotencyKey: validated(key, options['request-id']) } : {}) }));
    } else if (command === 'directories list') {
      const options = parseOptions(rest, ['path']);
      const query = options.path === undefined ? '' : `?path=${encodeURIComponent(validated(z.string().min(1).max(4096), options.path))}`;
      runtime.print(await runtime.json('workspace', '/local-projects/directories' + query));
    } else if (command === 'directories initialization-status' || command === 'directories initialization-recover') {
      const id = validated(key, rest[0]);
      const recover = command.endsWith('-recover');
      const options = parseOptions(rest.slice(1), recover ? ['expected-actor'] : []);
      if (recover) await expectedActor(runtime, options['expected-actor']);
      const endpoint = `/local-projects/initializations/${encodeURIComponent(id)}`;
      runtime.print(await runtime.json('workspace', endpoint + (recover ? '/recover' : ''), recover ? { method: 'POST', body: {} } : undefined));
    } else if (command === 'directories location') {
      const id = validated(projectId, rest[0]);
      parseOptions(rest.slice(1), []);
      runtime.print(await runtime.json('workspace', `/local-projects/projects/${encodeURIComponent(id)}/location`));
    } else if (command === 'directories migrate' || command === 'directories relocate') {
      const id = validated(projectId, rest[0]);
      const options = parseOptions(rest.slice(1), ['file', 'request-id', 'expected-actor']);
      const body = validated(command === 'directories migrate' ? localProjectMoveSchema : localProjectRelocationSchema, await inputFile(options.file));
      await expectedActor(runtime, options['expected-actor']);
      runtime.print(await runtime.json('workspace', `/local-projects/projects/${encodeURIComponent(id)}/${args[1]}`, { method: 'POST', body, idempotencyKey: validated(key, options['request-id']) }));
    } else throw new Error(`Unknown ${args[0]} operation. Run pm --help for the finite administration commands.`);
    return true;
  },
};
