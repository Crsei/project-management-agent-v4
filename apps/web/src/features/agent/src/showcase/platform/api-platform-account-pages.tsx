"use client";
import type { ReactNode } from "react";
import type { ApScenario } from "@easyuse-ui/agent-workspace-views/api-platform/model";
import { apScope } from "@easyuse-ui/agent-workspace-views/api-platform/model";
import { ApAccountProvider } from "@easyuse-ui/agent-workspace-views/api-platform/account-state";
import { ApStateProvider } from "@easyuse-ui/agent-workspace-views/api-platform/state";
import type { ApCache } from "@easyuse-ui/agent-workspace-views/api-platform/state";
import { useApiPlatformSession } from "./api-platform-session";

export const accountPageIds = [
  "organization-settings",
  "project-settings",
  "profile",
  "api-keys",
  "plugins",
  "billing",
] as const;
export type AccountPageId = (typeof accountPageIds)[number];
export function isAccountPageId(value: string): value is AccountPageId {
  return accountPageIds.some((id) => id === value);
}
export function accountDomainKey(scenario: ApScenario) {
  return `account-domain:${scenario}:${apScope.orgId}`;
}
export function ApiPlatformAccountScope({
  scenario,
  cache,
  children,
}: {
  scenario: ApScenario;
  cache: ApCache;
  children: ReactNode;
}) {
  const { cache: accountCache } = useApiPlatformSession(accountDomainKey(scenario));
  return (
    <ApAccountProvider cache={accountCache} scenario={scenario}>
      <ApStateProvider cache={cache}>{children}</ApStateProvider>
    </ApAccountProvider>
  );
}
