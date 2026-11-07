import { z } from "zod";
import { extensionProjectScopeSchema, type ExtensionProjectScope } from "@agent-workspace/contracts/extensions";
import { automationServiceHeaders } from "../../../../../packages/infrastructure/src/automation-execution-client.ts";
import { authorizePmTarget } from "../durable/pm-context.ts";
import { ExtensionError } from "./rpc.ts";

export async function extensionPmCallback(action: "authorize" | "references" | "invalidate", input: Record<string, unknown>): Promise<unknown> {
  let endpoint: URL;
  try {
    const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("invalid PM origin");
    endpoint = new URL(`/internal/extensions/${action}`, base.origin);
  } catch { throw new ExtensionError(503, "pm_authority_unavailable", "The PM authorization service origin is invalid."); }
  const body = JSON.stringify(input);
  let response: Response;
  try { response = await fetch(endpoint, { method: "POST", headers: automationServiceHeaders("POST", endpoint.pathname, body), body, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new ExtensionError(503, "pm_authority_unavailable", "The PM authorization service is unavailable; no authorization was inferred."); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExtensionError(response.status === 401 || response.status === 403 ? 403 : 503, "pm_authority_rejected", "PM did not authorize this scoped configuration operation.");
  }
  // Callback payloads contain authority metadata, never credential values.
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 1024 * 1024) { await response.body?.cancel(); throw new ExtensionError(502, "pm_authority_invalid", "PM returned an invalid authorization response."); }
  return response.json();
}
export async function authorizeExtensionProject(scope: ExtensionProjectScope, write = false, maintenance = false): Promise<void> {
  extensionProjectScopeSchema.parse(scope);
  const result = z.object({ authorized: z.literal(true) }).parse(await extensionPmCallback("authorize", { scope, write, ...(maintenance ? { maintenance: true } : {}) }));
  if (!result.authorized) throw new ExtensionError(403, "project_access_required", "Project configuration access is required.");
}
export async function resolveExtensionBrowserScope(input: { workspaceId: string; projectId: string }, headers: Headers, write = false): Promise<ExtensionProjectScope> {
  const resolved = await authorizePmTarget(input, headers);
  const scope = extensionProjectScopeSchema.parse({ actorId: resolved.actorId, ...resolved.target });
  await authorizeExtensionProject(scope, write);
  return scope;
}
export async function assertDefinitionNotReferenced(scope: ExtensionProjectScope, contextId: string, serverId: string): Promise<void> {
  const result = z.object({ references: z.array(z.object({ id: z.string(), label: z.string(), projectId: z.string() })) }).parse(await extensionPmCallback("references", { scope, contextId, serverId, reserveDelete: true }));
  if (result.references.length) throw new ExtensionError(409, "definition_in_use", "This definition is still bound to visible project connections. Revoke or unbind those connections before deleting it.", { references: result.references });
}
