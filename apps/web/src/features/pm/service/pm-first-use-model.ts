import { z } from "zod"
import type { InstanceSetupStatus, SetupResponse, Workspace } from "@contracts"

const statusSchema = z.object({
  initialized: z.boolean(),
  setupAllowed: z.boolean(),
  registrationMode: z.literal("invite_only"),
}).strict().refine(value => !value.initialized || !value.setupAllowed)

const responseSchema = z.object({
  actor: z.object({ id: z.string().uuid(), email: z.email(), name: z.string() }).strict(),
  workspaceId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict()

export const parseSetupStatus = (value: unknown): InstanceSetupStatus => statusSchema.parse(value)
export const parseSetupResponse = (value: unknown): SetupResponse => responseSchema.parse(value)

export type SetupEntryState = "unprepared" | "ready" | "initialized" | "unknown"

/** Only an authoritative status and a confirmed anonymous session permit setup.
 * A received success is never undone by a contradictory later status read. */
export function setupEntryState(status: InstanceSetupStatus, session: "anonymous" | "authenticated" | "unknown", completed = false): SetupEntryState {
  if (status.initialized) return "initialized"
  if (completed || session !== "anonymous") return "unknown"
  return status.setupAllowed ? "ready" : "unprepared"
}

/** Navigate only to a workspace returned by the current authorized directory.
 * A lost setup response has no ID; only an unambiguous real directory can select it. */
export function setupWorkspaceId(workspaces: readonly Pick<Workspace, "id">[], expectedId: string | null): string | null {
  if (expectedId) return workspaces.find(workspace => workspace.id === expectedId)?.id ?? null
  return workspaces.length === 1 ? workspaces[0]!.id : null
}
