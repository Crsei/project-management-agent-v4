"use client";
import { useState, type ComponentType } from "react";
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider";
import { createComposerFixture } from "@easyuse-ui/agent-workspace-views/fixtures";
import { useComposerDemoController } from "@easyuse-ui/agent-workspace-views/demo-controller";
import { ComposerWorkspaceView } from "@easyuse-ui/agent-workspace-views/composer";
import type { Copy } from "@easyuse-ui/agent-workspace-views/model";
import type { RemainingPageProps } from "@easyuse-ui/agent-workspace-views/showcase/model";
import { RemainingPageStateProvider } from "@easyuse-ui/agent-workspace-views/showcase/state";
import { useComposerShowcaseHost } from "../composer-host";
import { ScenarioExplorer } from "../scenario-explorer";
import { useRemainingSession } from "./remaining-session";

function BusinessShell({
  host,
  pageId,
  title,
  children,
}: {
  host: RemainingPageProps["host"];
  pageId: string;
  title: Copy;
  children: React.ReactNode;
}) {
  const [source] = useState(() => createComposerFixture("empty"));
  const controller = useComposerDemoController(source, false, false);
  return (
    <ComposerWorkspaceView
      controller={controller}
      host={host}
      presentation={{
        id: pageId,
        title,
        welcome: { title, description: { "zh-CN": "", en: "" } },
        showSessionNavigation: false,
        pageHeader: null,
        renderBody: () => children,
      }}
    />
  );
}

export function createRemainingExplorer({
  pageId,
  routeId,
  title,
  View,
  scenarios,
  ownShell,
}: {
  pageId: string;
  routeId: string;
  title: Copy;
  View: ComponentType<RemainingPageProps>;
  scenarios: readonly { id: string; name: Copy }[];
  ownShell: boolean;
}) {
  return function RemainingExplorer({ scenario }: { scenario: string }) {
    const { locale } = useI18n();
    const host = useComposerShowcaseHost(pageId);
    const { caches, reset } = useRemainingSession();
    if (!scenarios.some((item) => item.id === scenario))
      return <p role="alert">{locale === "zh-CN" ? "找不到此场景。" : "Scenario not found."}</p>;
    return (
      <ScenarioExplorer
        pageId={routeId}
        title={title[locale]}
        scenario={scenario}
        scenarios={scenarios}
        onResetScenario={(id) => reset(pageId + ":" + id)}
        renderScenario={(id, active) => {
          const key = pageId + ":" + id;
          let cache = caches.get(key);
          if (!cache) {
            cache = new Map<string, unknown>();
            caches.set(key, cache);
          }
          const view = (
            <RemainingPageStateProvider cache={cache}>
              <View scenario={id} active={active} host={host} cache={cache} />
            </RemainingPageStateProvider>
          );
          return ownShell ? (
            view
          ) : (
            <BusinessShell pageId={pageId + "-" + id + "-shell"} host={host} title={title}>
              {view}
            </BusinessShell>
          );
        }}
      />
    );
  };
}
