import type { PeopleIdentity as CandidateIdentity, PeopleCandidatePurpose } from "@contracts"
import { pmKeys } from "./pm-data"
import { usePmService, usePrivateQuery } from "./pm-service"

export type PeopleIdentity = { userId: string; name: string; avatarDataUrl?: string | null; jobTitle?: string | null }
export type { PeopleCandidatePurpose } from "@contracts"

/** Read every server page; a failed or cyclic page never becomes a complete picker. */
export function usePeopleCandidates({ purpose, projectId, q = "", enabled = true }: { purpose: PeopleCandidatePurpose; projectId?: string; q?: string; enabled?: boolean }) {
  const { actor, workspace } = usePmService()
  const query = usePrivateQuery<{ items: CandidateIdentity[]; nextCursor: null }>(
    [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "people", "candidates", purpose, projectId ?? null, q],
    purpose === "team" ? "access.manage" : "domain.read",
    projectId,
    async (client, workspaceId, signal) => {
      if ((purpose === "assignee" || purpose === "participant") && !projectId) throw new Error("A project is required for eligible member selection.")
      const items = new Map<string, CandidateIdentity>()
      const cursors = new Set<string>()
      let after: string | undefined
      do {
        const page = await client.people.candidates(workspaceId, { purpose, ...(projectId ? { projectId } : {}), ...(q ? { q } : {}), ...(after ? { after } : {}), limit: 100 }, signal)
        for (const member of page.items) items.set(member.userId, member)
        if (!page.nextCursor) return { items: [...items.values()], nextCursor: null }
        if (cursors.has(page.nextCursor)) throw new Error("The member directory returned a repeated cursor; selection is unavailable.")
        cursors.add(page.nextCursor)
        after = page.nextCursor
      } while (!signal.aborted)
      throw new DOMException("Aborted", "AbortError")
    }, enabled,
  )
  return { ...query, data: query.error ? undefined : query.data, items: query.error ? [] : query.data?.items ?? [], complete: !!query.data && !query.error }
}
