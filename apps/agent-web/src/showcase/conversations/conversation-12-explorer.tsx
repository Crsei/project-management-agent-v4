"use client";
import { Conversation12View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-12";
import { useConversation12Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-12-controller";
import {
  conversation12Scenarios,
  createConversation12Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-12-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation12Explorer = createConversationExplorer({
  page: "conversation-12",
  title: "Conversation 12",
  scenarios: conversation12Scenarios,
  createFixture: createConversation12Fixture,
  useController: useConversation12Controller,
  View: Conversation12View,
});
