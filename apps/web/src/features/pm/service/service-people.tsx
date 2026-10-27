import { useSearchParams } from "react-router"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { CoreSessionProvider } from "../markdown/session"
import { ServiceMembers } from "./pm-members"
import { usePmService } from "./pm-service"
import { ServiceGuard, useText } from "./pm-ui"
import { ServiceTeams } from "./service-teams"
import styles from "./service-people.module.css"

export function ServicePeople() {
  const { actor, workspace, actorEpoch, refresh } = usePmService()
  return <ServiceGuard>{actor && workspace && <CoreSessionProvider key={`${workspace.id}:${actor.id}:${workspace.version}:${actorEpoch}`} hostNamespace={window.location.origin} workspaceId={workspace.id} actorId={actor.id} membershipVersion={workspace.version} actorEpoch={actorEpoch} onAccessFailure={refresh}><PeopleWorkspace /></CoreSessionProvider>}</ServiceGuard>
}

function PeopleWorkspace() {
  const [params, setParams] = useSearchParams()
  const t = useText()
  const requested = params.get("tab")
  const tab = requested === "teams" || requested === "workload" ? requested : "members"
  const changeTab = (value: string | number) => {
    if (value !== "members" && value !== "teams" && value !== "workload") return
    const next = new URLSearchParams(params)
    next.set("tab", value)
    next.delete("panel")
    next.delete("profile")
    setParams(next)
  }
  return <section className={`${styles.page} flex h-full min-h-0 min-w-0 flex-col overflow-hidden`} aria-label={t("成员与团队", "Members and teams")} data-pm-people>
    <header className="shrink-0 border-b bg-surface px-4 pt-4 md:px-6">
      <h1 className="text-xl font-semibold">{t("成员与团队", "Members and teams")}</h1>
      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList activateOnFocus={false} className="mt-3 max-w-full overflow-x-auto" aria-label={t("人员工作区", "People workspace")}>
          <TabsTab value="members">{t("成员", "Members")}</TabsTab>
          <TabsTab value="teams">{t("团队", "Teams")}</TabsTab>
          <TabsTab value="workload">{t("工作量", "Workload")}</TabsTab>
        </TabsList>
      </Tabs>
    </header>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pm-people-tab={tab}>
      {tab === "members" ? <ServiceMembers /> : <ServiceTeams key={tab} variant={tab === "teams" ? "team1" : "team3"} />}
    </div>
  </section>
}
