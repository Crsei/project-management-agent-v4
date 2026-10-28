"use client"
import {
  WorkItemsWorkspace,
  type WorkItemsWorkspaceProps,
} from "../work-items-workspace"
import type { DrilldownSelection } from "../../../lib/analytics-model"
import { useI18n } from "../../../lib/i18n-provider"
/** Caller queries historical membership and supplies original business capabilities unchanged. */
export function WorkItemsViewAdapter({
  selection,
  snapshotId,
  workspace,
  access = "allowed",
}: {
  selection: DrilldownSelection
  snapshotId: string
  workspace: WorkItemsWorkspaceProps
  access?: "allowed" | "denied"
}) {
  const { t } = useI18n()
  if (access === "denied") return <p role="status">{t("analytics.noAccess")}</p>
  if (
    selection.queryKey !== workspace.queryKey ||
    selection.snapshotId !== snapshotId
  )
    return <p role="status">{t("analytics.pending")}</p>
  return <WorkItemsWorkspace {...workspace} />
}
