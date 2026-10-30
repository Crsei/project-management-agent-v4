"use client";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { ComposerHost } from "@easyuse-ui/agent-workspace-views/composer";
import type { Copy } from "@easyuse-ui/agent-workspace-views/model";
import type { ThreadPage } from "@easyuse-ui/agent-workspace-views/conversations/fixtures";
import { ScenarioExplorer } from "../scenario-explorer";
import { useComposerShowcaseHost } from "../composer-host";

/** A page-specific controller remains mounted when its scenario is hidden. */
export function createConversationExplorer<Id extends string, Fixture, Controller>({
  page,
  title,
  scenarios,
  createFixture,
  useController,
  View,
}: {
  page: ThreadPage;
  title: string;
  scenarios: readonly { id: Id; name: Copy }[];
  createFixture: (scenario: Id) => Fixture;
  useController: (fixture: Fixture, scenario: Id, active: boolean) => Controller;
  View: ComponentType<{ controller: Controller; host: ComposerHost }>;
}) {
  function Instance({ scenario, active }: { scenario: Id; active: boolean }) {
    const mounted = useRef<HTMLDivElement>(null);
    const [fixture] = useState(() => createFixture(scenario));
    const controller = useController(fixture, scenario, active);
    const host = useComposerShowcaseHost(page);
    useEffect(() => {
      mounted.current?.setAttribute("data-conversation-hydrated", "true");
    }, []);
    return (
      <div ref={mounted} className="h-full">
        <View controller={controller} host={host} />
      </div>
    );
  }
  return function Explorer({ scenario }: { scenario: Id }) {
    return (
      <ScenarioExplorer
        pageId={page}
        title={title}
        scenario={scenario}
        scenarios={scenarios}
        renderScenario={(id, active) => <Instance scenario={id} active={active} />}
      />
    );
  };
}
