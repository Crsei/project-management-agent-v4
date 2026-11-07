// Transport adaptation of t3code ConnectAgentSurface's approval/decision requests.
// Browser-managed PM cookies are the only identity here; never Agent or external MCP tokens.
export class McpBrowserError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function mcpBrowserJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", redirect: "error", cache: "no-store", headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new McpBrowserError(typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  if (!body) throw new McpBrowserError("The service did not return JSON.", response.status);
  return body as T;
}
export type McpScope = { workspaceId: string; projectId: string | null };
export type McpApproval = {
  clientName: string; redirectHost: string; csrfToken: string;
  authorization: Record<string, string>; defaultAccess: "read-only";
  allowedAccess: ("read-only" | "full")[];
  catalog: { workspaces: { id: string; name: string; workspaceAllowed: boolean; projects: { id: string; name: string }[] }[] };
  threads: { id: string; title: string }[];
};
export type McpClients = { csrfToken: string; items: { id: string; clientName: string; scope: McpScope; access: "read-only" | "full"; threadIds: string[]; createdAt: string; expiresAt: string; revokedAt: string | null }[] };
