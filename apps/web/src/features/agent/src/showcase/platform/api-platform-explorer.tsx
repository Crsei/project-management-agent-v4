import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApStateProvider } from "@easyuse-ui/agent-workspace-views/api-platform/state";
import { apScope, type ApScenario } from "@easyuse-ui/agent-workspace-views/api-platform/model";
import type { ApPageId } from "./api-platform-catalog";
import { useApiPlatformSession } from "./api-platform-session";
import { ApiPlatformChrome } from "./api-platform-chrome";
import {
  ApiPlatformAccountScope,
  accountDomainKey,
  accountPageIds,
  isAccountPageId,
} from "./api-platform-account-pages";

export function ApiPlatformExplorer({
  pageId,
  scenario,
  children,
}: {
  pageId: ApPageId;
  scenario: ApScenario;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const key = `${pageId}:${scenario}:${apScope.orgId}:${apScope.projectId}`;
  const { cache, caches, version, reset } = useApiPlatformSession(key);
  const modelId = searchParams.get("model");
  const accountScope = ![
    "model-catalog",
    "model-detail",
    "model-pricing",
    "model-benchmarks",
  ].includes(pageId);

  return (
    <ApiPlatformChrome
      pageId={pageId}
      scenario={scenario}
      onScenario={(id) => {
        const query = new URLSearchParams({ scenario: id });
        if (modelId !== null) query.set("model", modelId);
        navigate(`/agent/showcase/${pageId}?${query}`, { preventScrollReset: true });
      }}
      onReset={() => {
        if (isAccountPageId(pageId)) {
          caches.delete(accountDomainKey(scenario));
          for (const id of accountPageIds) {
            caches.delete(`${id}:${scenario}:${apScope.orgId}:${apScope.projectId}`);
          }
        }
        reset(key);
      }}
    >
      {accountScope ? (
        <ApiPlatformAccountScope key={`${key}:${version}`} scenario={scenario} cache={cache}>
          {children}
        </ApiPlatformAccountScope>
      ) : (
        <ApStateProvider key={`${key}:${version}`} cache={cache}>
          {children}
        </ApStateProvider>
      )}
    </ApiPlatformChrome>
  );
}
