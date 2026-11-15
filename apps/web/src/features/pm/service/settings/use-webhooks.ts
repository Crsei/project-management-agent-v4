import { useEffect, useSyncExternalStore } from "react"
import { pmKeys } from "../pm-data"
import { usePmService, usePrivateQuery } from "../pm-service"
import { allowed } from "../pm-ui"
import { pageVisibility } from "../page-visibility"

export function useWebhooks(enabled = true) {
  const { actor, workspace } = usePmService()
  const visible = useSyncExternalStore(pageVisibility.subscribe, pageVisibility.getSnapshot, pageVisibility.getServerSnapshot)
  const authorized = enabled && !!actor && ["access.manage", "domain.read", "audit.read"].every(capability => allowed(workspace, capability))
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "webhooks"]
  const query = usePrivateQuery(key, "access.manage", undefined, (client, workspaceId, signal) => client.getWebhooks(workspaceId, { signal }), authorized)
  const refresh = query.refetch
  useEffect(() => {
    if (!authorized || !visible || query.error || query.isPaused) return
    const timer = window.setInterval(() => { void refresh() }, 10000)
    return () => window.clearInterval(timer)
  }, [authorized, visible, query.error, query.isPaused, refresh])
  return query
}
export function useWebhookDeliveries(endpointId: string, cursor?: string) {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "webhook-deliveries", endpointId, cursor ?? "head"]
  return usePrivateQuery(key, "access.manage", undefined, (client, workspaceId, signal) => client.getWebhookDeliveries(workspaceId, endpointId, { ...(cursor ? { cursor } : {}), limit: 20 }, { signal }))
}
export function useWebhookDelivery(deliveryId: string) {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "webhook-delivery", deliveryId]
  return usePrivateQuery(key, "access.manage", undefined, (client, workspaceId, signal) => client.getWebhookDelivery(workspaceId, deliveryId, { signal }))
}
