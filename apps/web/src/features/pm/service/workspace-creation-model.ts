import type { ProjectManagementClient, WorkspaceCreationResult } from '@contracts';
import { z } from 'zod';

const workspaceCreationDraftSchema = z.strictObject({ key: z.uuid(), name: z.string().trim().min(1).max(200) });
export type WorkspaceCreationDraft = z.infer<typeof workspaceCreationDraftSchema>;

export function decodeWorkspaceCreationDraft(value: string | null): WorkspaceCreationDraft | null {
  return value === null ? null : workspaceCreationDraftSchema.parse(JSON.parse(value));
}

/** Preparation never replaces a prior uncertain request, including another tab’s. */
export function prepareWorkspaceCreation(storage: Pick<Storage, 'getItem' | 'setItem'>, storageKey: string, input: WorkspaceCreationDraft): WorkspaceCreationDraft {
  const current = decodeWorkspaceCreationDraft(storage.getItem(storageKey));
  if (current) return current;
  const draft = workspaceCreationDraftSchema.parse(input);
  storage.setItem(storageKey, JSON.stringify(draft));
  return draft;
}

/** Reconcile unknown effects first; only the still-current actor may explicitly resume. */
export async function runWorkspaceCreation(client: Pick<ProjectManagementClient, 'getMe' | 'createWorkspace' | 'getWorkspaceCreation' | 'recoverWorkspaceCreation'>, mode: 'create' | 'check' | 'recover', original: WorkspaceCreationDraft, actorId: string, isCurrent: () => boolean): Promise<WorkspaceCreationResult> {
  function requireCurrent() {
    if (!isCurrent()) throw new Error('The session changed; no further request was sent. / 会话已改变，未发送后续请求。');
  }
  async function requireAuthority() {
    requireCurrent();
    // Local React state and the asynchronous pm-session broadcast can lag a
    // different tab's HttpOnly Cookie. Re-read the existing session authority.
    const { actor } = await client.getMe();
    requireCurrent();
    if (actor.id !== actorId) throw new Error('The session changed; no further request was sent. / 会话已改变，未发送后续请求。');
  }
  requireCurrent();
  if (mode === 'create') {
    await requireAuthority();
    requireCurrent();
    return client.createWorkspace({ name: original.name, expectedActorId: actorId }, original.key);
  }
  const result = await client.getWorkspaceCreation(original.key);
  requireCurrent();
  if (mode !== 'recover' || result.status === 'ready') return result;
  await requireAuthority();
  requireCurrent();
  // The mutation binds the captured actor to its own authenticated principal,
  // even if another tab changes the Cookie after this authority preflight.
  return result.status === 'pending'
    ? client.recoverWorkspaceCreation(original.key, { expectedActorId: actorId })
    : client.createWorkspace({ name: original.name, expectedActorId: actorId }, original.key);
}
