import { z } from "zod"
import type { Command, MemberRole } from "@contracts"

export type InvitationAttempt = { email: string; command: Command<"CreateMemberInvitation">; status: "ready" | "unknown" | "committed" | "rejected"; invitationId?: string; error?: string }

/** Freeze one command per normalized recipient before dispatching any write. */
export function prepareInvitationBatch(input: { emails: string; role: MemberRole; projectIds: string[] | null; teamIds: string[] }, commandId: () => string = () => crypto.randomUUID()): InvitationAttempt[] {
  const emails = z.array(z.email().max(254)).min(1).max(100).parse([...new Set(input.emails.split(/[\s,;]+/).filter(Boolean).map(email => email.toLowerCase()))])
  return emails.map(email => ({ email, status: "ready", command: { commandId: commandId(), commandType: "CreateMemberInvitation", payload: { email, role: input.role, projectIds: input.projectIds === null ? null : [...input.projectIds], teamIds: [...input.teamIds] } } }))
}

export function capabilityChanges(before: readonly string[], after: readonly string[]) {
  return { added: after.filter(value => !before.includes(value)), removed: before.filter(value => !after.includes(value)), retained: after.filter(value => before.includes(value)) }
}
