"use client";
import { useState } from "react";
import { ComposerWorkspaceView } from "@easyuse-ui/agent-workspace-views/composer";
import { useComposerDemoController } from "@easyuse-ui/agent-workspace-views/demo-controller";
import {
  composerScenarios,
  createComposerFixture,
  type ComposerScenario,
} from "@easyuse-ui/agent-workspace-views/fixtures";
import { ScenarioExplorer } from "../scenario-explorer";
import { useComposerShowcaseHost } from "../composer-host";

function ScenarioInstance({ scenario, active }: { scenario: ComposerScenario; active: boolean }) {
  const [source] = useState(() => createComposerFixture(scenario));
  const controller = useComposerDemoController(source, active);
  const host = useComposerShowcaseHost("composer");
  return active ? <ComposerWorkspaceView controller={controller} host={host} /> : null;
}

export function ComposerExplorer({ scenario }: { scenario: ComposerScenario }) {
  return (
    <ScenarioExplorer
      pageId="composer"
      title="Composer"
      scenario={scenario}
      scenarios={composerScenarios}
      renderScenario={(id, active) => <ScenarioInstance scenario={id} active={active} />}
    />
  );
}
