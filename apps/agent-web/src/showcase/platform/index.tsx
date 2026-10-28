import { lazy, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider";
import type { ApScenario } from "@easyuse-ui/agent-workspace-views/api-platform/model";
import type { ShowcasePage } from "../types";
import { apShowcases, type ApPageId } from "./api-platform-catalog";
import { ApiPlatformExplorer } from "./api-platform-explorer";

export { ApiPlatformSession as Provider } from "./api-platform-session";

const ModelCatalogView = lazy(() =>
  import("@easyuse-ui/agent-workspace-views/api-platform/model-catalog/view").then((module) => ({
    default: module.ModelCatalogView,
  })),
);
const ModelDetailView = lazy(() =>
  import("@easyuse-ui/agent-workspace-views/api-platform/model-detail/view").then((module) => ({
    default: module.ModelDetailView,
  })),
);
const views = {
  "model-pricing": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/model-pricing/view").then((module) => ({
      default: module.ModelPricingView,
    })),
  ),
  "model-benchmarks": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/model-benchmarks/view").then(
      (module) => ({ default: module.ModelBenchmarksView }),
    ),
  ),
  "api-keys": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/api-keys/view").then((module) => ({
      default: module.ApiKeysView,
    })),
  ),
  "project-settings": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/project-settings/view").then(
      (module) => ({ default: module.ProjectSettingsView }),
    ),
  ),
  plugins: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/plugins/view").then((module) => ({
      default: module.PluginsView,
    })),
  ),
  "organization-settings": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/organization-settings/view").then(
      (module) => ({ default: module.OrganizationSettingsView }),
    ),
  ),
  profile: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/profile/view").then((module) => ({
      default: module.ProfileView,
    })),
  ),
  billing: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/billing/view").then((module) => ({
      default: module.BillingView,
    })),
  ),
  "credit-usage": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/credit-usage/view").then((module) => ({
      default: module.CreditUsageView,
    })),
  ),
  "usage-insights": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/usage-insights/view").then((module) => ({
      default: module.UsageInsightsView,
    })),
  ),
  "model-usage": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/model-usage/view").then((module) => ({
      default: module.ModelUsageView,
    })),
  ),
  "api-requests": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/api-requests/view").then((module) => ({
      default: module.ApiRequestsView,
    })),
  ),
  incidents: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/incidents/view").then((module) => ({
      default: module.IncidentsView,
    })),
  ),
  "audio-playground": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/audio-playground/view").then(
      (module) => ({ default: module.AudioPlaygroundView }),
    ),
  ),
  tokenizer: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/tokenizer/view").then((module) => ({
      default: module.TokenizerView,
    })),
  ),
  evaluations: lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/evaluations/view").then((module) => ({
      default: module.EvaluationsView,
    })),
  ),
  "response-review": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/response-review/view").then(
      (module) => ({ default: module.ResponseReviewView }),
    ),
  ),
  "batch-jobs": lazy(() =>
    import("@easyuse-ui/agent-workspace-views/api-platform/batch-jobs/view").then((module) => ({
      default: module.BatchJobsView,
    })),
  ),
};

function PlatformPage({ pageId, scenario }: { pageId: ApPageId; scenario: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { locale } = useI18n();
  // The common route validates against this page's catalog before mounting it.
  const selectedScenario = scenario as ApScenario;
  const openModel = (modelId: string) => {
    const query = new URLSearchParams({ scenario, model: modelId });
    navigate(`/showcase/model-detail?${query}`, { preventScrollReset: true });
  };
  const View = pageId === "model-catalog" || pageId === "model-detail" ? undefined : views[pageId];

  return (
    <ApiPlatformExplorer pageId={pageId} scenario={selectedScenario}>
      <Suspense
        fallback={
          <p role="status">{locale === "en" ? "Loading local fixture…" : "正在加载本地场景…"}</p>
        }
      >
        {pageId === "model-catalog" ? (
          <ModelCatalogView scenario={selectedScenario} onOpenModel={openModel} />
        ) : pageId === "model-detail" ? (
          <ModelDetailView
            scenario={selectedScenario}
            modelId={searchParams.get("model") ?? undefined}
            onModelChange={openModel}
            onOpenCatalog={() => navigate("/showcase/model-catalog", { preventScrollReset: true })}
            onOpenPricing={() => navigate("/showcase/model-pricing", { preventScrollReset: true })}
          />
        ) : View ? (
          <View scenario={selectedScenario} />
        ) : null}
      </Suspense>
    </ApiPlatformExplorer>
  );
}

export const pages: ShowcasePage[] = apShowcases.map((page) => ({
  id: page.id,
  group: page.group,
  title: page.title,
  description: page.description,
  scenarios: page.scenarios,
  Component: function PlatformRoute({ scenario }) {
    return <PlatformPage pageId={page.id} scenario={scenario} />;
  },
}));
