import { useEffect, useMemo, useState } from "react"
import type { InvitationListDto, MemberDirectory } from "@contracts"
import { pmKeys } from "./pm-data"
import { usePmService, usePrivateQuery } from "./pm-service"
import { allowed } from "./pm-ui"

export function useMemberDirectory() {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "members", "directory"]
  const query = usePrivateQuery<MemberDirectory>(key, allowed(workspace, "access.manage") ? "access.manage" : "directory.read", undefined, (client, workspaceId, signal) => client.getMemberDirectory(workspaceId, { signal }))
  const refresh = query.refetch
  const ttl = query.data?.presenceTtlMs
  const hasSnapshot = !!query.data
  const [tick, setTick] = useState(() => performance.now())
  const serverNow = query.data?.serverNow
  const clock = useMemo(() => ({ instant: Date.parse(serverNow ?? ""), received: performance.now() }), [serverNow])
  useEffect(() => {
    if (!hasSnapshot) return
    const timer = window.setInterval(() => setTick(performance.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasSnapshot])
  useEffect(() => {
    if (!ttl || !hasSnapshot || query.error) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, Math.max(5_000, Math.min(ttl, 30_000)))
    return () => window.clearInterval(timer)
  }, [ttl, hasSnapshot, query.error, refresh])
  return { ...query, estimatedServerNow: clock.instant + Math.max(0, tick - clock.received) }
}

export function useMemberInvitations() {
  const { actor, workspace } = usePmService()
  const enabled = allowed(workspace, "access.manage")
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "members", "invitations"]
  const query = usePrivateQuery<InvitationListDto>(key, "access.manage", undefined, (client, workspaceId, signal) => client.listMemberInvitations(workspaceId, { signal }), enabled)
  const refresh = query.refetch
  const sending = query.data?.items.some(item => item.status === "pending" && (item.delivery?.status === "queued" || item.delivery?.status === "sending"))
  const pending = query.data?.items.some(item => item.status === "pending")
  useEffect(() => {
    if (!enabled || !pending || query.error) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, sending ? 5_000 : 15_000)
    return () => window.clearInterval(timer)
  }, [enabled, pending, sending, query.error, refresh])
  return query
}
