import { useEffect } from "react"
import { pmKeys } from "../pm-data"
import { usePmService, usePrivateQuery } from "../pm-service"

export function useWebhooks() {
  const { actor, workspace } = usePmService()
  const key = [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "webhooks"]
  const query = usePrivateQuery(key, "access.manage", undefined, (client, workspaceId, signal) => client.getWebhooks(workspaceId, { signal }))
  const refresh = query.refetch
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 10000)
    return () => window.clearInterval(timer)
  }, [refresh])
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
