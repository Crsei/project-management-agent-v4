export class DomainError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message = code, status = 400, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type EntityKind = 'project' | 'work_item' | 'milestone' | 'conversation' | 'intent' | 'decision' | 'upload' | 'artifact' | 'artifact_version' | 'evidence' | 'submission' | 'review';
export type Entity = {
  id: string; workspaceId: string; projectId: string | null; kind: EntityKind;
  version: number; data: Record<string, any>; createdAt: string | null; updatedAt: string | null; createdBy: string;
};
export type Actor = { id: string; email: string; name: string };
export type Command = {
  commandId: string; commandType: string; targetId?: string; projectId?: string;
  expectedVersions?: Record<string, number>; payload: Record<string, unknown>;
};
export type CommandReceipt = {
  commandId: string; status: 'committed' | 'rejected'; httpStatus: number;
  result?: unknown; error?: { code: string; message: string; details?: unknown };
};

export const CAPABILITIES = ['domain.read', 'directory.read', 'audit.read', 'intent.propose', 'intent.decide', 'planning.edit', 'planning.lifecycle', 'workitem.cancel_reopen', 'delivery.write', 'delivery.submit', 'delivery.review', 'workitem.complete', 'access.manage'] as const;
export type Capability = typeof CAPABILITIES[number];
