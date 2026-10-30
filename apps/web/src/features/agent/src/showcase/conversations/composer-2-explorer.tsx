"use client";
import { useState } from "react";
import { Composer2View } from "@easyuse-ui/agent-workspace-views/composer-2";
import { useComposer2Controller } from "@easyuse-ui/agent-workspace-views/composer-2-controller";
import {
  composer2Scenarios,
  createComposer2Fixture,
  type Composer2Scenario,
} from "@easyuse-ui/agent-workspace-views/composer-2-fixtures";
import { ScenarioExplorer } from "../scenario-explorer";
import { useComposerShowcaseHost } from "../composer-host";

function ScenarioInstance({ scenario, active }: { scenario: Composer2Scenario; active: boolean }) {
  const [source] = useState(() => createComposer2Fixture(scenario));
  const controller = useComposer2Controller(source, active);
  const host = useComposerShowcaseHost("composer-2");
  return active ? <Composer2View controller={controller} host={host} /> : null;
}

export function Composer2Explorer({ scenario }: { scenario: Composer2Scenario }) {
  return (
    <ScenarioExplorer
      pageId="composer-2"
      title="Composer 2"
      scenario={scenario}
      scenarios={composer2Scenarios}
      renderScenario={(id, active) => <ScenarioInstance scenario={id} active={active} />}
    />
  );
}
