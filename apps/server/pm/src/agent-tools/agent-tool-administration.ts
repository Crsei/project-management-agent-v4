import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor, type Command, type CommandReceipt } from '../../../../packages/domain/src/core.ts';
import { memberOverloaded } from '../../../../packages/domain/src/team-workload.ts';
import type { MemberDirectory } from '../../../../packages/domain/src/members.ts';
import { AdministrationToolInputSchemas, AdministrationToolMetadata, administrationToolCommands, type AdministrationToolName } from '../../../../packages/application/src/agent-tool-administration.ts';
import { AdministrationToolResultSchema, type AdministrationToolResult } from '../../../../packages/agent-contracts/src/pm-tool-administration.ts';
import { getMembership, requireCapability } from '../../../../packages/application/src/access.ts';
import { readWorkspaceIdentity } from '../../../../packages/application/src/workspace-identity.ts';
import { readSelfProfile } from '../../../../packages/application/src/dashboard-personal.ts';
import { readMemberDirectory } from '../../../../packages/application/src/member-directory.ts';
import { listMemberInvitations } from '../../../../packages/application/src/invitations.ts';
import { readTeamDirectory } from '../../../../packages/application/src/team-directory.ts';
import { readTeamWorkload } from '../../../../packages/application/src/team-workload.ts';
import { readProjectExtras } from '../../../../packages/application/src/project-extras.ts';
import { readProjectDirectory } from '../../../../packages/application/src/project-directory.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import type { DashboardReadContext } from '../../../../packages/application/src/dashboard-read.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import type { InvitationMailConfig } from '../../../../packages/infrastructure/src/invitation-mail.ts';
import type { ProjectMount } from '../../../../packages/pm-core/project-locations.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext } from '../../../../packages/application/src/agent-chat-tools.ts';
import type { AgentChatToolFamily } from './agent-chat-tools.ts';
import type { CoreWorkspacePool } from './core-routes.ts';
import { CoreCommandJournal } from './core-journal.ts';

type Inputs = { [K in AdministrationToolName]: z.infer<typeof AdministrationToolInputSchemas[K]> };
type Input = Inputs[AdministrationToolName];
export type AdministrationToolDependencies = {
  database: () => Pool;
  applicationRead: <T>(actor: Actor, workspaceId: string, reader: (context: DashboardReadContext) => Promise<T>, directoryManagement?: boolean | 'members') => Promise<T>;
  executeCommand: (actor: Actor, workspaceId: string, command: Command, checkAuthorization?: AgentChatToolContext['checkAuthorization']) => Promise<CommandReceipt>;
  readCommandReceipt: (actor: Actor, workspaceId: string, command: Command) => Promise<CommandReceipt | null>;
  coreWorkspaces: CoreWorkspacePool;
  checkMount: (mount: ProjectMount) => Promise<void>;
  localProjects: { enabled: boolean; defaultParent: string | null };
  invitationMail?: InvitationMailConfig;
};
const names = Object.keys(AdministrationToolInputSchemas) as AdministrationToolName[];
const own = (name: string): name is AdministrationToolName => Object.hasOwn(AdministrationToolInputSchemas, name);
const parse = (name: AdministrationToolName, input: unknown): Input => {
  const parsed = AdministrationToolInputSchemas[name].safeParse(input);
  if (!parsed.success) throw new DomainError('agent_tool_invalid_input', 'Arguments must match the registered administration schema', 400);
  return parsed.data;
};
const standard = { nextCursor: null, truncated: false, sources: [] };
/** Cursor binds actor/scope/resource and the complete current projection; changed pages never splice old data. */
function page<T>(items: T[], args: { after: string | null; limit: number }, binding: unknown) {
  const hash = requestHash({ binding, items });
  let offset = 0;
  if (args.after !== null) {
    const match = /^([a-f0-9]{64}):(\d+)$/.exec(args.after);
    if (!match || match[1] !== hash || !Number.isSafeInteger(Number(match[2]))) throw new DomainError('cursor_stale', 'The authorized directory changed; begin a new read with after:null', 409);
    offset = Number(match[2]);
    if (offset > items.length) throw new DomainError('cursor_stale', 'The current page is unavailable', 409);
  }
  const next = offset + args.limit;
  return { items: items.slice(offset, next), nextCursor: next < items.length ? `${hash}:${next}` : null, truncated: next < items.length };
}
function narrowContext(ctx: DashboardReadContext, context: AgentChatToolContext): DashboardReadContext {
  const allowed = (projectId: string | null | undefined) => !!projectId && context.scope.projectIds.includes(projectId);
  return { ...ctx, core: { ...ctx.core,
    async get(id, kind) { const entity = await ctx.core.get(id, kind); if (!allowed(entity.kind === 'project' ? entity.id : entity.projectId)) throw new DomainError('not_found_or_forbidden', 'Resource is outside the current project scope', 404); return entity; },
    async list(kind) { return (await ctx.core.list(kind)).filter(entity => allowed(entity.kind === 'project' ? entity.id : entity.projectId)); },
    async records() { return (await ctx.core.records()).filter(record => allowed(record.entity.entity === 'project' ? record.id : record.entity.project)); },
  } };
}
async function directoryMemberIds(ctx: DashboardReadContext, context: AgentChatToolContext, directory: MemberDirectory): Promise<Set<string>> {
  if (context.scope.kind === 'workspace' || !directory.capabilities.canManageMembers) return new Set(directory.members.map(member => member.userId));
  // Managers see global rows. Narrow delegated reads using actual active identities
  // and native grants, never using task assignment or team membership as permission.
  const projects = await readProjectDirectory(ctx);
  const active = new Set(projects.management?.members.map(member => member.id) ?? []);
  return new Set(directory.members.filter(member => member.isSelf || active.has(member.userId) && member.access?.revokedAt === null
    && member.access.capabilities.includes('domain.read') && (member.access.projectIds === null || member.access.projectIds.some(id => context.scope.projectIds.includes(id)))).map(member => member.userId));
}
export function createAdministrationToolFamily(options: AdministrationToolDependencies): AgentChatToolFamily {
  const authorize = async (name: AdministrationToolName, args: Input, context: AgentChatToolContext, sql: SqlExecutor = options.database()) => {
    assertAgentToolNotAborted(context);
    if (args.workspaceId !== context.workspaceId) throw new DomainError('scope_mismatch', 'The explicitly targeted workspace differs from the current tool workspace', 409);
    const membership = await getMembership(sql, context.actor, context.workspaceId);
    const metadata = AdministrationToolMetadata[name];
    if (metadata.scope === 'workspace-admin' || name === 'pm_duplicate_project') {
      if (context.scope.kind !== 'workspace' || membership.projectIds !== null) throw new DomainError('permission_denied', 'This operation requires explicit unrestricted workspace scope', 403);
    }
    for (const capability of metadata.capabilities) {
      if (!membership.capabilities.includes(capability)) throw new DomainError('permission_denied', `Capability ${capability} is required`, 403);
    }
    const workspaceManager = membership.projectIds === null && membership.capabilities.includes('access.manage');
    // Repeat the native OR-gates at final delivery too; metadata arrays cannot express
    // alternatives, and a directory-only grant must never become a core read grant.
    if ((name === 'pm_read_members' || name === 'pm_read_workload') && !membership.capabilities.includes('directory.read') && !workspaceManager) throw new DomainError('permission_denied', 'Capability directory.read or workspace access.manage is required', 403);
    if ((name === 'pm_read_teams' || name === 'pm_read_project_directory') && !membership.capabilities.includes('domain.read') && !workspaceManager) throw new DomainError('permission_denied', 'Capability domain.read or workspace access.manage is required', 403);
    if (metadata.scope === 'workspace-admin') await requireCapability(sql, context.actor, context.workspaceId, 'access.manage');
    if ('projectId' in args) assertAgentToolProject(context.scope, args.projectId);
    if (name === 'pm_set_project_order') for (const id of (args as Inputs['pm_set_project_order']).payload.projectIds) assertAgentToolProject(context.scope, id);
    if (name === 'pm_set_member' || name === 'pm_set_member_role' || name === 'pm_create_invitation') {
      const grants = (args as Inputs['pm_set_member']).payload.projectIds;
      // Native workspace authority may grant only the explicit tool-authorized project set.
      if (grants) for (const id of grants) assertAgentToolProject(context.scope, id);
    }
    await context.checkAuthorization?.(sql);
    return membership;
  };
  function commandFor(name: AdministrationToolName, args: Input, context: AgentChatToolContext): Command {
    if (!Object.hasOwn(administrationToolCommands, name)) throw new DomainError('agent_tool_not_available', 'This is not an administration write', 403);
    const commandType = administrationToolCommands[name as keyof typeof administrationToolCommands];
    const write = args as Input & { expectedVersions: Record<string, number>; payload?: Record<string, unknown>; targetId?: string | null; projectId?: string };
    let targetId = write.targetId ?? write.projectId;
    if (commandType === 'UpdateWorkspaceIdentity') targetId = context.workspaceId;
    if (commandType === 'SetWorkspaceMember' || commandType === 'SetMemberRole' || commandType === 'RevokeWorkspaceMember') targetId = String(write.payload!.userId);
    const copy = args as Inputs['pm_duplicate_project'];
    const payload = commandType === 'DuplicateProject' ? { name: copy.name, includeTasks: copy.includeTasks,
      ...(options.localProjects.enabled ? { localDirectory: { mode: 'new', parentPath: options.localProjects.defaultParent, folderName: `agent-copy-${context.operationId}` } } : {}) } : write.payload!;
    if (commandType === 'DuplicateProject' && options.localProjects.enabled && !options.localProjects.defaultParent) throw new DomainError('local_project_directory_required', 'Configure a trusted default project parent before copying', 409);
    return { commandId: context.operationId, commandType, expectedVersions: write.expectedVersions, payload,
      ...(targetId ? { targetId } : {}), ...(write.projectId ? { projectId: write.projectId } : {}) };
  }
  function projectedReceipt(command: Command, receipt: CommandReceipt, context: AgentChatToolContext): AdministrationToolResult {
    if (receipt.status !== 'committed') throw new DomainError(receipt.error?.code ?? 'agent_tool_rejected', receipt.error?.message ?? 'The native administration command was rejected', receipt.httpStatus);
    const result = receipt.result && typeof receipt.result === 'object' ? receipt.result as { id?: unknown; version?: unknown; userId?: unknown; workspaceId?: unknown } : null;
    const id = typeof result?.id === 'string' ? result.id : typeof result?.userId === 'string' ? result.userId : typeof result?.workspaceId === 'string' ? result.workspaceId : command.targetId;
    const version = typeof result?.version === 'number' && Number.isInteger(result.version) && result.version > 0 ? result.version : null;
    return { kind: 'administration_command', items: id ? [{ id, version }] : [], ...standard,
      receipt: { kind: 'command', operationId: context.operationId, commandId: receipt.commandId, action: command.commandType, targetId: id ?? null, revision: version === null ? null : String(version), ...(context.linkage ? { linkage: context.linkage } : {}) } };
  }
  async function execute(nameValue: string, input: unknown, context: AgentChatToolContext): Promise<AdministrationToolResult> {
    if (!own(nameValue)) throw new DomainError('agent_tool_not_available', 'Unknown administration tool', 403);
    const name = nameValue, args = parse(name, input);
    await authorize(name, args, context);
    if (Object.hasOwn(administrationToolCommands, name)) {
      const command = commandFor(name, args, context);
      const receipt = await options.executeCommand(context.actor, context.workspaceId, command, sql => authorize(name, args, context, sql).then(() => undefined));
      await authorize(name, args, context);
      return projectedReceipt(command, receipt, context);
    }
    const binding = { actorId: context.actor.id, workspaceId: context.workspaceId, scope: context.scope, name };
    const paged = args as Input & { after: string | null; limit: number };
    let output: unknown;
    if (name === 'pm_read_workspace_identity') output = { kind: 'administration_workspace', items: [await readWorkspaceIdentity(options.database(), context.actor, context.workspaceId)], ...standard };
    else if (name === 'pm_read_account_profile') {
      const profile = await readSelfProfile({ sql: options.database(), actor: context.actor, workspaceId: context.workspaceId });
      const safe = { userId: profile.userId, name: profile.name, timeZone: profile.timeZone, jobTitle: profile.jobTitle, version: profile.version, joinedAt: profile.joinedAt, updatedAt: profile.updatedAt };
      output = { kind: 'administration_profile', items: [safe], ...standard };
    } else if (name === 'pm_read_invitations') {
      const result = await listMemberInvitations(options.database(), context.actor, context.workspaceId, options.invitationMail);
      output = { kind: 'administration_invitations', ...standard, ...page(result.items, paged, binding), enabled: result.enabled };
    } else if (name === 'pm_read_project_directory_reference') {
      const { projectId } = args as Inputs['pm_read_project_directory_reference'];
      await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', projectId);
      const workspace = await options.coreWorkspaces.get(context.workspaceId);
      const record = workspace.get(projectId);
      if (record.entity.entity !== 'project') throw new DomainError('not_found_or_forbidden', 'Project is unavailable', 404);
      const registered = workspace.projectLocations().find(item => item.projectId === projectId);
      let status: 'available' | 'unavailable' = 'available';
      try { const mount = workspace.projectLocation(projectId); if (mount) await options.checkMount(mount); } catch { status = 'unavailable'; }
      output = { kind: 'administration_directory_reference', items: [{ projectId, storageId: registered?.storageId ?? null, kind: registered ? 'local' : 'legacy', status }], ...standard };
    } else output = await options.applicationRead(context.actor, context.workspaceId, async original => {
      const ctx = narrowContext(original, context);
      if (name === 'pm_read_members') {
        const result = await readMemberDirectory(ctx);
        const visible = await directoryMemberIds(ctx, context, result);
        const directory = context.scope.kind === 'projects' && original.membership.capabilities.includes('domain.read') ? await readProjectDirectory(ctx) : null;
        const items = result.members.filter(item => visible.has(item.userId)).map(item => ({ userId: item.userId, name: item.name, jobTitle: item.jobTitle, joinedAt: item.joinedAt, isSelf: item.isSelf,
          role: context.scope.kind === 'projects' && !item.isSelf ? 'unknown' as const : item.role,
          teams: directory ? item.teams.filter(team => directory.projects.some(project => project.teams.some(candidate => candidate.id === team.id))) : item.teams,
          presence: item.presence, access: context.scope.kind === 'projects' ? null : item.access }));
        return { kind: 'administration_members', ...standard, ...page(items, paged, binding), serverNow: result.serverNow, presenceTtlMs: result.presenceTtlMs, canManageMembers: context.scope.kind === 'workspace' && result.capabilities.canManageMembers };
      }
      if (name === 'pm_read_teams') {
        const result = await readTeamDirectory(ctx);
        const directory = context.scope.kind === 'projects' ? await readProjectDirectory(ctx) : null;
        const visible = directory ? new Set(directory.projects.flatMap(item => item.identities.map(identity => identity.id))) : null;
        const items = result.teams.filter(item => !visible || item.projectIds.some(id => context.scope.projectIds.includes(id))).map(item => ({ ...item,
          projectIds: item.projectIds.filter(id => context.scope.projectIds.includes(id)), scopeComplete: item.scopeComplete && context.scope.kind === 'workspace',
          ...(visible ? { createdBy: item.createdBy && visible.has(item.createdBy) ? item.createdBy : null, data: { ...item.data, memberIds: item.data.memberIds.filter(id => visible.has(id)), maintainerIds: item.data.maintainerIds.filter(id => visible.has(id)) } } : {}) }));
        return { kind: 'administration_teams', ...standard, ...page(items, paged, binding), canManage: context.scope.kind === 'workspace' && result.canManage };
      }
      if (name === 'pm_read_workload') {
        const result = await readTeamWorkload(ctx);
        const section = (args as Inputs['pm_read_workload']).section;
        const partial = context.scope.kind === 'projects' || !result.scope.complete;
        const directory = partial ? await readProjectDirectory(ctx) : null;
        const visible = await directoryMemberIds(ctx, context, await readMemberDirectory(ctx));
        const teams = result.teams.filter(team => !partial || directory!.projects.some(project => project.teams.some(item => item.id === team.id))).map(team => ({ ...team, memberIds: team.memberIds.filter(id => visible.has(id)) }));
        const visibleTeams = new Set(teams.map(team => team.id));
        const members = result.members.filter(member => visible.has(member.userId)).map(member => ({ ...member, teamIds: member.teamIds.filter(id => visibleTeams.has(id)),
          scope: partial ? { complete: false, reason: 'partial' as const } : member.scope,
          overloaded: memberOverloaded(member.knownOpenPoints, member.unknownEstimateCount, member.capacityPoints, !partial && member.scope.complete) }));
        const tasks = result.tasks.map(task => ({ ...task, teamIds: task.teamIds.filter(id => visibleTeams.has(id)) }));
        const metadata = { serverNow: result.serverNow, unit: result.unit, scope: { ...result.scope, complete: !partial, reason: partial ? 'projects' as const : 'workspace' as const }, summary: { ...result.summary, overloadedMemberCount: members.filter(item => item.overloaded === true).length, unknownOverloadMemberCount: members.filter(item => item.overloaded === null).length } };
        const scopedBinding = { ...binding, section, scope: metadata.scope, summary: metadata.summary };
        if (section === 'members') return { kind: 'administration_workload_members', ...standard, ...metadata, ...page(members, paged, scopedBinding) };
        if (section === 'teams') return { kind: 'administration_workload_teams', ...standard, ...metadata, ...page(teams, paged, scopedBinding) };
        return { kind: 'administration_workload_tasks', ...standard, ...metadata, ...page(tasks, paged, scopedBinding) };
      }
      if (name === 'pm_read_project_extras') {
        const result = await readProjectExtras(ctx);
        return { kind: 'administration_project_extras', ...standard, ...page(result.projects, paged, { ...binding, sidebarOrder: result.sidebarOrder }), sidebarOrder: result.sidebarOrder };
      }
      if (name === 'pm_read_project_directory') {
        const result = await readProjectDirectory(ctx);
        return { kind: 'administration_project_directory', ...standard, ...page(result.projects, paged, binding) };
      }
      throw new DomainError('agent_tool_not_available', 'Unknown administration read', 403);
    }, name === 'pm_read_members' || name === 'pm_read_workload' ? 'members' : true);
    await authorize(name, args, context);
    return AdministrationToolResultSchema.parse(output);
  }
  return {
    names,
    execute,
    recoveryIdentity(nameValue, input, context) {
      if (!own(nameValue) || !Object.hasOwn(administrationToolCommands, nameValue)) return null;
      const command = commandFor(nameValue, parse(nameValue, input), context);
      return { kind: 'command', commandId: command.commandId, action: command.commandType, hash: requestHash(command as unknown as Record<string, unknown>) };
    },
    async recover(nameValue, input, context) {
      if (!own(nameValue) || !Object.hasOwn(administrationToolCommands, nameValue)) return null;
      const args = parse(nameValue, input);
      await authorize(nameValue, args, context);
      let command: Command;
      if (nameValue === 'pm_duplicate_project') {
        // The retained command, including original directory identity, wins over changed defaults.
        const workspace = await options.coreWorkspaces.get(context.workspaceId);
        const original = new CoreCommandJournal(workspace.root).entries().find(entry => entry.kind === 'pending' && entry.commandId === context.operationId && entry.actorId === context.actor.id && entry.commandType === 'DuplicateProject');
        if (!original || original.kind !== 'pending' || !original.command) return null;
        command = original.command;
        const copy = args as Inputs['pm_duplicate_project'];
        if (command.targetId !== copy.projectId || command.projectId !== copy.projectId || command.payload.name !== copy.name || command.payload.includeTasks !== copy.includeTasks || requestHash({ versions: command.expectedVersions }) !== requestHash({ versions: copy.expectedVersions }) || requestHash(command as unknown as Record<string, unknown>) !== original.hash) throw new DomainError('command_id_conflict', 'The original project copy does not match this tool request', 409);
      } else command = commandFor(nameValue, args, context);
      const receipt = await options.readCommandReceipt(context.actor, context.workspaceId, command);
      if (!receipt || receipt.error?.code.toLowerCase().includes('unknown')) return null;
      await authorize(nameValue, args, context);
      if (receipt.status === 'rejected') throw new DomainError('agent_tool_recovered_rejection', 'The original native administration command was rejected; no write was replayed', 409);
      return projectedReceipt(command, receipt, context);
    },
    async authorizeResult(nameValue, input, resultValue, context) {
      if (!own(nameValue)) throw new DomainError('agent_tool_not_available', 'Unknown administration result family', 403);
      const args = parse(nameValue, input);
      const membership = await authorize(nameValue, args, context);
      const result = AdministrationToolResultSchema.parse(resultValue);
      const unavailable = () => { throw new DomainError('not_found_or_forbidden', 'The saved administration result is no longer readable in the current scope', 404); };
      const projectIds = new Set<string>();
      if ('projectId' in args) projectIds.add(args.projectId);
      if (result.kind === 'administration_project_extras' || result.kind === 'administration_project_directory' || result.kind === 'administration_directory_reference') {
        for (const item of result.items) projectIds.add(item.projectId);
      }
      if (result.kind === 'administration_project_extras') {
        for (const id of result.sidebarOrder?.data.projectIds ?? []) projectIds.add(id);
        if (result.sidebarOrder && result.sidebarOrder.ownerId !== context.actor.id) unavailable();
        for (const item of result.items) if (item.favorite && item.favorite.ownerId !== context.actor.id) unavailable();
      }
      if (result.kind === 'administration_workload_members' || result.kind === 'administration_workload_tasks' || result.kind === 'administration_workload_teams') {
        for (const id of result.scope.projectIds) projectIds.add(id);
      }
      if (result.kind === 'administration_teams') for (const team of result.items) for (const id of team.projectIds) projectIds.add(id);
      for (const id of projectIds) {
        assertAgentToolProject(context.scope, id);
        await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', id);
      }
      if (result.kind === 'administration_workspace' && result.items.some(item => item.workspaceId !== context.workspaceId)) unavailable();
      if (result.kind === 'administration_profile' && result.items.some(item => item.userId !== context.actor.id)) unavailable();
      if (result.kind === 'administration_command') {
        if (result.receipt?.operationId !== context.operationId || result.receipt.commandId !== context.operationId) unavailable();
        // The newly copied project was not in the pre-write frozen set. Its receipt
        // is not a grant: current unrestricted native workspace authority is required.
        if (nameValue === 'pm_duplicate_project') for (const item of result.items) await requireCapability(options.database(), context.actor, context.workspaceId, 'domain.read', item.id);
      }
      if (result.kind === 'administration_directory_reference') {
        const workspace = await options.coreWorkspaces.get(context.workspaceId);
        for (const item of result.items) if ((workspace.projectLocations().find(location => location.projectId === item.projectId)?.storageId ?? null) !== item.storageId) unavailable();
      }
      const sensitiveDirectory = result.kind === 'administration_members' || result.kind === 'administration_teams' || result.kind === 'administration_workload_members' || result.kind === 'administration_workload_tasks' || result.kind === 'administration_workload_teams' || result.kind === 'administration_project_directory';
      if (sensitiveDirectory) await options.applicationRead(context.actor, context.workspaceId, async original => {
        const ctx = narrowContext(original, context);
        const projects = membership.capabilities.includes('domain.read') || membership.projectIds === null && membership.capabilities.includes('access.manage') ? await readProjectDirectory(ctx) : null;
        const directory = result.kind === 'administration_members' || result.kind.startsWith('administration_workload_') ? await readMemberDirectory(ctx) : null;
        const allowedMembers = directory ? await directoryMemberIds(ctx, context, directory) : new Set([
          ...(projects?.projects.flatMap(project => project.identities.map(identity => identity.id)) ?? []),
          ...(context.scope.kind === 'workspace' ? projects?.management?.members.map(member => member.id) ?? [] : []),
        ]);
        const checkMember = (id: string) => { if (!allowedMembers.has(id)) unavailable(); };
        const teams = membership.capabilities.includes('domain.read') || membership.capabilities.includes('access.manage') ? await readTeamDirectory(ctx) : null;
        const allowedTeams = new Set(teams?.teams.filter(team => context.scope.kind === 'workspace' || team.projectIds.some(id => context.scope.projectIds.includes(id))).map(team => team.id) ?? []);
        const checkTeam = (id: string) => { if (!allowedTeams.has(id)) unavailable(); };
        if (result.kind === 'administration_members') for (const member of result.items) {
          checkMember(member.userId);
          if (member.access && member.userId !== context.actor.id && (context.scope.kind !== 'workspace' || !directory?.capabilities.canManageMembers)) unavailable();
          for (const team of member.teams) checkTeam(team.id);
        }
        if (result.kind === 'administration_teams') for (const team of result.items) {
          checkTeam(team.id);
          if (team.createdBy) checkMember(team.createdBy);
          for (const id of [...team.data.memberIds, ...team.data.maintainerIds]) checkMember(id);
        }
        if (result.kind === 'administration_project_directory') for (const project of result.items) {
          for (const identity of project.identities) checkMember(identity.id);
          for (const team of project.teams) { checkTeam(team.id); for (const identity of team.members) checkMember(identity.id); }
        }
        if (result.kind === 'administration_workload_members' || result.kind === 'administration_workload_tasks' || result.kind === 'administration_workload_teams') {
          const current = await readTeamWorkload(ctx);
          const currentTasks = new Set(current.tasks.map(task => task.id));
          const currentMembers = new Set(current.members.map(member => member.userId));
          const checkWorkloadMember = (id: string) => { checkMember(id); if (!currentMembers.has(id)) unavailable(); };
          if (result.kind === 'administration_workload_members') for (const member of result.items) { checkWorkloadMember(member.userId); for (const id of member.teamIds) checkTeam(id); for (const id of member.taskIds) if (!currentTasks.has(id)) unavailable(); }
          if (result.kind === 'administration_workload_teams') for (const team of result.items) { checkTeam(team.id); for (const id of team.memberIds) checkWorkloadMember(id); for (const id of team.taskIds) if (!currentTasks.has(id)) unavailable(); }
          if (result.kind === 'administration_workload_tasks') for (const task of result.items) { if (!currentTasks.has(task.id)) unavailable(); if (task.assigneeId) checkWorkloadMember(task.assigneeId); for (const id of task.teamIds) checkTeam(id); }
        }
      }, 'members');
      if (result.kind === 'administration_members' && result.items.some(member => member.access !== null && member.userId !== context.actor.id)) await requireCapability(options.database(), context.actor, context.workspaceId, 'access.manage');
      await authorize(nameValue, args, context);
    },
  };
}
