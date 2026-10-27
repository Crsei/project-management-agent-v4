import type { ZodType } from 'zod';
import type { Actor, Capability, Command, Entity, EntityKind } from '../../domain/src/core.ts';
import type { FileRecord, ProtocolConfiguration } from '../../pm-schema/index.ts';
import type { SprintHistorySnapshot } from '../../pm-core/sprint-history.ts';

export type SqlExecutor = {
  query<T = Record<string, any>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};
/** Read access to the authoritative Markdown core for PM-only modules that reference it. */
export type CoreAccess = {
  handles(id: string, kind?: EntityKind): boolean;
  get(id: string, kind?: EntityKind): Promise<Entity>;
  list(kind: EntityKind): Promise<Entity[]>;
  records(): Promise<FileRecord[]>;
  sprintHistory(): Promise<SprintHistorySnapshot>;
  configuration(): ProtocolConfiguration;
  /** Validate authorization targets without disclosing project content to access-only managers. */
  validateMemberProjects?(projectIds: string[]): Promise<void>;
  /** Revalidate authoritative inputs after external I/O, before committing dependent facts. */
  refresh?(): Promise<void>;
};
export type CommandContext = {
  sql: SqlExecutor; actor: Actor; workspaceId: string; command: Command;
  core?: CoreAccess;
  requireSelf(): Promise<void>;
  require(capability: Capability, projectId?: string | null): Promise<void>;
  get(id: string, kind?: EntityKind): Promise<Entity>;
  list(kind: EntityKind, projectId?: string | null): Promise<Entity[]>;
  insert(kind: EntityKind, data: Record<string, any>, projectId?: string | null, id?: string): Promise<Entity>;
  update(entity: Entity, data: Record<string, any>): Promise<Entity>;
  checkVersion(entity: Entity): void;
  emit(eventType: string, entity: Entity, payload?: Record<string, unknown>): Promise<void>;
};
export type CommandDefinition = { payload: ZodType; handler(ctx: CommandContext): Promise<unknown> };
export type CommandRegistry = Record<string, CommandDefinition>;
