import { ProductRoadmapPage } from "@/features/pm/product-roadmap/ProductRoadmapPage"
import { lazy, Suspense } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router"
import { PmHome, PmLabLayout, PmProductLayout } from "@/features/pm/pm-shell"
import { PmErrorRoute } from "@/routes/error-page"
import { PmNotFound } from "@/routes/not-found"
import { PmDashboardRoute } from "@/routes/pm-dashboard"
import { PmIssuesRoute } from "@/routes/pm-issues"
import { PmMembersRoute } from "@/routes/pm-members"
import { PmNotificationsRoute } from "@/routes/pm-notifications"
import { PmProjectDetailRoute } from "@/routes/pm-project-detail"
import { PmProjectIssueDetailRoute } from "@/routes/pm-project-issue-detail"
import { PmProjectIssuesRoute } from "@/routes/pm-project-issues"
import { PmProjectsRoute } from "@/routes/pm-projects"
import { PmTeamsRoute } from "@/routes/pm-teams"
import { PmProjectEventsRoute } from "@/routes/pm-project-events"
import { ServiceHome, ServiceDashboard, ServiceProjects, ServiceIssues, ServiceEntityPage, ServiceDocuments, ServiceViews, ServiceWorkspaceSettings, ServiceNotifications, ServiceEvents } from "@/features/pm/service/pm-pages"
import { PmWhiteboardPage } from "@/features/pm/service/pm-whiteboard-page"
import { ServiceProjectLayout } from "@/features/pm/service/service-project-layout"
import { ServiceProjectActivity, ServiceProjectEntry, ServiceProjectFiles, ServiceProjectOverview } from "@/features/pm/service/service-project-pages"
import { ServicePeople } from "@/features/pm/service/service-people"
import { SettingsRoute } from "@/features/pm/service/settings/settings-layout"
import { PmInvitationAcceptPage } from "@/features/pm/service/pm-invitation-accept"
import { ServiceTaskCreationPage } from "@/features/pm/markdown/page"
import { ServiceWorkspaceHome } from "@/features/pm/service/service-workspace-home"
import { AccountSecurityPage, PasswordRecoveryPage, VerifyRecoveryEmailPage } from "@/features/pm/service/account-recovery-pages"
import { AgentChatPage } from "@/features/pm/agent/agent-chat-page"
import { useWorkspaceStore } from "@/providers/app-providers"
import { PmServiceProvider, usePmService } from "@/features/pm/service/pm-service"
import { ServiceGuard } from "@/features/pm/service/pm-ui"
const AgentApp = lazy(() => import("@/features/agent/src/app").then(module => ({ default: module.App })))
const ConnectAgentPage = lazy(() => import("@/features/agent/src/mcp/connect-agent"))



/** Project document links use the single workspace document page. */
function ProjectDocumentsRoute() {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const location = useLocation()
  if (!workspaceSlug) return <Navigate to="/pm" replace />
  return <Navigate to={`/pm/${encodeURIComponent(workspaceSlug)}/documents${location.search}${location.hash}`} replace state={location.state} />
}

function WorkspaceStartRoute() {
  const { workspace, error } = usePmService()
  const startPage = useWorkspaceStore(state => state.startPage)
  return <ServiceGuard>{!error && workspace && <Navigate to={`/pm/${encodeURIComponent(workspace.id)}/${startPage}`} replace />}</ServiceGuard>
}

/** Real service routes and explicitly isolated component demonstrations. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/pm" replace />} />
      <Route path="/agent/*" element={<Suspense fallback={<div role="status">正在加载工作区…</div>}><AgentApp /></Suspense>} />
      <Route path="/connect-agent" element={<Suspense fallback={<div role="status">正在核对连接请求…</div>}><ConnectAgentPage /></Suspense>} />
      <Route path="/pm/invitations/accept" element={<PmInvitationAcceptPage />} />
      <Route path="/pm/account" element={<PmServiceProvider><Outlet /></PmServiceProvider>}>
        <Route index element={<Navigate to="security" replace />} />
        <Route path="security" element={<AccountSecurityPage />} />
        <Route path="recovery" element={<PasswordRecoveryPage />} />
        <Route path="verify-recovery-email" element={<VerifyRecoveryEmailPage />} />
      </Route>
      <Route path="/pm" element={<PmProductLayout><Outlet /></PmProductLayout>}>
        <Route index element={<ServiceHome />} />
        <Route path=":workspaceSlug" element={<WorkspaceStartRoute />} />
        <Route path=":workspaceSlug/home" element={<ServiceWorkspaceHome />} />
        <Route path=":workspaceSlug/dashboard" element={<ServiceDashboard />} />
        <Route path=":workspaceSlug/projects" element={<ServiceProjects />} />
        <Route path=":workspaceSlug/projects/:projectId" element={<ServiceProjectLayout />}>
          <Route index element={<ServiceProjectEntry />} />
          <Route path="overview" element={<ServiceProjectOverview />} />
          <Route path="roadmap" element={<ProductRoadmapPage />} />
          <Route path="issues" element={<ServiceIssues />} />
          <Route path="documents" element={<ProjectDocumentsRoute />} />
          <Route path="issues/new" element={<ServiceTaskCreationPage />} />
          <Route path="entities/:entityId" element={<ServiceEntityPage />} />
          <Route path="events" element={<ServiceEvents />} />
          <Route path="files" element={<ServiceProjectFiles />} />
          <Route path="activity" element={<ServiceProjectActivity />} />
        </Route>
        <Route path=":workspaceSlug/issues" element={<ServiceIssues />} />
        <Route path=":workspaceSlug/issues/new" element={<ServiceTaskCreationPage />} />
        <Route path=":workspaceSlug/entities/:entityId" element={<ServiceEntityPage />} />
        <Route path=":workspaceSlug/documents" element={<ServiceDocuments />} />
        <Route path=":workspaceSlug/agent" element={<AgentChatPage />} />
        <Route path=":workspaceSlug/views" element={<ServiceViews />} />
        <Route path=":workspaceSlug/members" element={<ServicePeople />} />
        <Route path=":workspaceSlug/notifications" element={<ServiceNotifications />} />
        <Route path=":workspaceSlug/whiteboard" element={<PmWhiteboardPage />} />
        <Route path=":workspaceSlug/settings" element={<ServiceWorkspaceSettings />} />
        <Route path=":workspaceSlug/settings/:settingsPage" element={<SettingsRoute mode="service" />} />
      </Route>
      {import.meta.env.PM_LAB_ENABLED && <Route
        path="/lab/pm"
        element={
          <PmLabLayout>
            <Outlet />
          </PmLabLayout>
        }
      >
        <Route index element={<PmHome />} />
        <Route path=":workspaceSlug/dashboard" element={<PmDashboardRoute />} />
        <Route path=":workspaceSlug/issues" element={<PmIssuesRoute />} />
        <Route path=":workspaceSlug/members" element={<PmMembersRoute />} />
        <Route
          path=":workspaceSlug/notifications"
          element={<PmNotificationsRoute />}
        />
        <Route path=":workspaceSlug/projects" element={<PmProjectsRoute />} />
        <Route
          path=":workspaceSlug/projects/:projectId"
          element={<PmProjectDetailRoute />}
        />
        <Route
          path=":workspaceSlug/projects/:projectId/issues"
          element={<PmProjectIssuesRoute />}
        />
        <Route
          path=":workspaceSlug/projects/:projectId/events"
          element={<PmProjectEventsRoute />}
        />
        <Route
          path=":workspaceSlug/projects/:projectId/issues/:issueId"
          element={<PmProjectIssueDetailRoute />}
        />
        <Route path=":workspaceSlug/teams" element={<PmTeamsRoute />} />
        <Route path=":workspaceSlug/settings" element={<Navigate to="general" replace />} />
        <Route path=":workspaceSlug/settings/:settingsPage" element={<SettingsRoute mode="lab" />} />
      </Route>}
      <Route path="/errors/:code" element={<PmErrorRoute />} />
      <Route path="*" element={<PmNotFound />} />
    </Routes>
  )
}
