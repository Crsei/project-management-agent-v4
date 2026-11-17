import type { ProviderInstance } from "@agent-workspace/contracts/provider";

export type ProviderSendIssue = "missing" | "disabled" | "not-installed";

/** Only explicit provider configuration states become a banner; unknown auth stays neutral. */
export function providerSendIssue(provider: ProviderInstance | undefined): ProviderSendIssue | undefined {
  if (!provider) return "missing";
  if (!provider.enabled) return "disabled";
  if (provider.installation?.status === "not-installed") return "not-installed";
  return undefined;
}
