"use client";
import { useState } from "react";
import { Conversation1View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-1";
import { Conversation2View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-2";
import { Conversation3View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-3";
import { useConversation1Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-1-controller";
import { useConversation2Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-2-controller";
import { useConversation3Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-3-controller";
import {
  conversation1Scenarios,
  createConversation1Fixture,
  type Conversation1Scenario,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-1-fixtures";
import {
  conversation2Scenarios,
  createConversation2Fixture,
  type Conversation2Scenario,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-2-fixtures";
import {
  conversation3Scenarios,
  createConversation3Fixture,
  type Conversation3Scenario,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-3-fixtures";
import { ScenarioExplorer } from "../scenario-explorer";
import { useComposerShowcaseHost } from "../composer-host";

function Conversation1Instance({
  scenario,
  active,
}: {
  scenario: Conversation1Scenario;
  active: boolean;
}) {
  const [source] = useState(() => createConversation1Fixture(scenario));
  const controller = useConversation1Controller(source, scenario, active);
  const host = useComposerShowcaseHost("conversation-1");
  return <Conversation1View controller={controller} host={host} />;
}
function Conversation2Instance({
  scenario,
  active,
}: {
  scenario: Conversation2Scenario;
  active: boolean;
}) {
  const [fixture] = useState(() => createConversation2Fixture(scenario));
  const controller = useConversation2Controller(fixture, scenario, active);
  const host = useComposerShowcaseHost("conversation-2");
  return <Conversation2View controller={controller} host={host} />;
}
function Conversation3Instance({
  scenario,
  active,
}: {
  scenario: Conversation3Scenario;
  active: boolean;
}) {
  const [source] = useState(() => createConversation3Fixture(scenario));
  const controller = useConversation3Controller(source, scenario, active);
  const host = useComposerShowcaseHost("conversation-3");
  return <Conversation3View controller={controller} host={host} />;
}
export function Conversation1Explorer({ scenario }: { scenario: Conversation1Scenario }) {
  return (
    <ScenarioExplorer
      pageId="conversation-1"
      title="Conversation 1"
      scenario={scenario}
      scenarios={conversation1Scenarios}
      renderScenario={(id, active) => <Conversation1Instance scenario={id} active={active} />}
    />
  );
}
export function Conversation2Explorer({ scenario }: { scenario: Conversation2Scenario }) {
  return (
    <ScenarioExplorer
      pageId="conversation-2"
      title="Conversation 2"
      scenario={scenario}
      scenarios={conversation2Scenarios}
      renderScenario={(id, active) => <Conversation2Instance scenario={id} active={active} />}
    />
  );
}
export function Conversation3Explorer({ scenario }: { scenario: Conversation3Scenario }) {
  return (
    <ScenarioExplorer
      pageId="conversation-3"
      title="Conversation 3"
      scenario={scenario}
      scenarios={conversation3Scenarios}
      renderScenario={(id, active) => <Conversation3Instance scenario={id} active={active} />}
    />
  );
}
