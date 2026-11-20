/**
 * Presentation-only worktree decisions.
 *
 * The server owns every mutation and every refusal; this module only decides
 * which controls are shown as available and which reason blocks them. It never
 * infers a directory, branch or revision.
 */

import { z } from "zod";

const worktreeSnapshotSchema = z.object({
  branch: z.string().min(1),
  directory: z.string().min(1),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
  clean: z.boolean(),
  state: z.enum(["active", "transitioning"]).optional(),
});

/** GET/POST/DELETE all return this shape; unknown server fields are ignored. */
export const worktreeStateSchema = z.object({
  worktree: worktreeSnapshotSchema.nullable(),
  revision: z.number().int().nonnegative(),
  lifecycleRevision: z.number().int().nonnegative(),
});

/** DELETE additionally reports the branch the server intentionally kept. */
export const worktreeEndStateSchema = worktreeStateSchema.extend({
  retainedBranch: z.string().min(1),
});

export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>;
export type WorktreeState = z.infer<typeof worktreeStateSchema>;

export type WorktreeBlocker = "exists" | "busy" | "transitioning" | "terminals" | "dirty";

export type WorktreeHealth = "clean" | "dirty" | "transitioning";

export function worktreeHealth(worktree: WorktreeSnapshot): WorktreeHealth {
  if (worktree.state === "transitioning") return "transitioning";
  return worktree.clean ? "clean" : "dirty";
}

/** Cheap display form; the full SHA stays available in the title attribute. */
export function shortCommit(sha: string, length = 10): string {
  const trimmed = sha.trim();
  return trimmed.length <= length ? trimmed : trimmed.slice(0, length);
}

/**
 * Create is unavailable while another switch is in flight, while a terminal is
 * attached, or once a worktree already exists. An existing worktree is never
 * silently recreated.
 */
export function worktreeCreateBlockers(input: {
  worktree: WorktreeSnapshot | null;
  busy: boolean;
  activeTerminals: number;
}): WorktreeBlocker[] {
  const blockers: WorktreeBlocker[] = [];
  if (input.busy) blockers.push("busy");
  if (input.worktree) blockers.push("exists");
  if (input.worktree?.state === "transitioning") blockers.push("transitioning");
  if (input.activeTerminals > 0) blockers.push("terminals");
  return blockers;
}

/**
 * End is refused by the server for a dirty tree, a live terminal, a pending
 * transition or a concurrent request. Mirror that order so the UI explains the
 * first refusal the user would hit.
 */
export function worktreeEndBlockers(input: {
  worktree: WorktreeSnapshot | null;
  busy: boolean;
  activeTerminals: number;
}): WorktreeBlocker[] {
  if (!input.worktree) return [];
  const blockers: WorktreeBlocker[] = [];
  if (input.busy) blockers.push("busy");
  if (input.worktree.state === "transitioning") blockers.push("transitioning");
  if (input.activeTerminals > 0) blockers.push("terminals");
  if (!input.worktree.clean) blockers.push("dirty");
  return blockers;
}

/** Only the revisions read from the server travel back with a mutation. */
export function worktreeMutationRevisions(state: WorktreeState): { revision: number; lifecycleRevision: number } {
  return { revision: state.revision, lifecycleRevision: state.lifecycleRevision };
}
