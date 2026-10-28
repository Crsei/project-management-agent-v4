import { createWorkspaceClient } from "@agent-workspace/client-runtime";

// Web and Desktop both load this UI from the service/proxy origin. Browser-managed
// HttpOnly access cookies stay in fetch/WebSocket; no token is persisted or injected here.
// The absent browser origin also keeps the existing Node migration tests portable.
export const workspaceClient = createWorkspaceClient({
  baseUrl: typeof window === "undefined" ? undefined : window.location.origin,
  basePath: "/agent",
});
