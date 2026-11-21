import { z } from "zod";
import type {
  BundledSkillsCatalog,
  InstallBundledSkillsRequest,
  InstallBundledSkillsResult,
  ProviderBundledSkillsState,
} from "@agent-workspace/contracts/bundled-skills";

// Project only inventory metadata; never retain provider config or environment values.
export const bundledSkillProvidersSchema = z.object({ providers: z.array(z.object({
  instanceId: z.string(), label: z.string(), driver: z.string(),
  enabled: z.boolean(), configured: z.boolean(), nativeSessionReady: z.boolean(),
  authStatus: z.enum(["authenticated", "unauthenticated", "unknown", "not-installed"]),
  revision: z.number().optional(), email: z.string().optional(),
  credentialSource: z.enum(["provider"]).nullable().optional(),
})) });
export type BundledSkillProvider = z.infer<typeof bundledSkillProvidersSchema>["providers"][number];

/** Account/configuration changes invalidate a reviewed target, not merely its label. */
export function bundledSkillProviderIdentity(provider: BundledSkillProvider): string {
  return JSON.stringify([provider.instanceId, provider.driver, provider.revision ?? null,
    provider.email ?? null, provider.credentialSource ?? null, provider.enabled,
    provider.configured, provider.nativeSessionReady, provider.authStatus]);
}
export function bundledSkillProviderReady(provider: BundledSkillProvider): boolean {
  return provider.enabled && provider.configured && provider.nativeSessionReady;
}
/** Installation writes files into an already authorized native target; a live
 * session is useful evidence but is not required to copy the bundled bytes.
 * The panel still requires an authoritative target fingerprint from the server. */
export function bundledSkillProviderWritable(provider: BundledSkillProvider): boolean {
  return provider.enabled;
}

export class BundledSkillsError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Both entry points use existing independent Agent access, through the same-origin proxy. */
async function agentJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/agent/api${path}`, {
    ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const value = await response.json().catch(() => undefined) as { error?: string; code?: string } | undefined;
  if (!response.ok) throw new BundledSkillsError(value?.error ?? `HTTP ${response.status}`, value?.code ?? "bundled_skills_request_failed", response.status);
  if (!value) throw new BundledSkillsError("The Agent service did not return JSON.", "invalid_bundled_skills_response");
  return value as T;
}
export const readBundledSkillsCatalog = (signal?: AbortSignal) => agentJson<BundledSkillsCatalog>("/extensions/bundled-skills", { signal });
export const readProviderBundledSkills = (providerInstanceId: string, signal?: AbortSignal) =>
  agentJson<ProviderBundledSkillsState>(`/extensions/providers/${encodeURIComponent(providerInstanceId)}/bundled-skills`, { signal });
export const installProviderBundledSkills = (providerInstanceId: string, input: InstallBundledSkillsRequest) =>
  agentJson<InstallBundledSkillsResult>(`/extensions/providers/${encodeURIComponent(providerInstanceId)}/bundled-skills`, {
    method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(60_000),
  });
export async function readBundledSkillProviders(signal?: AbortSignal): Promise<BundledSkillProvider[]> {
  return bundledSkillProvidersSchema.parse(await agentJson<unknown>("/providers", { signal })).providers;
}
