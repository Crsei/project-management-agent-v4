import type { ReactNode } from "react"
import type { Actor, ChangeNotification, Entity, Member } from "@contracts"
import type { DashboardViewProps } from "@/views/pm/controlled-contracts"
import type { QueryState } from "./pm-ui"

export type DashboardEntityQuery = Omit<QueryState, "data"> & { data: Entity[] | undefined }
export type DashboardMemberQuery = Omit<QueryState, "data"> & { data: Member[] | undefined }
export type DashboardChangeQuery = Omit<QueryState, "data"> & { data: ChangeNotification[] | undefined; historyTruncated: boolean }

/** Authorized service snapshots only. Missing snapshots are not empty results;
 * unavailable financial/time/presence facts must never come from Lab fixtures. */
export type ServiceDashboardProps = {
  surface: DashboardViewProps
  projects: DashboardEntityQuery
  issues: DashboardEntityQuery
  milestones: DashboardEntityQuery
  members: DashboardMemberQuery
  changes: DashboardChangeQuery
  actor: Actor | null
  openEntity: (id: string) => void
  openActivity: () => void
  dependencyEditor: ReactNode
}
