"use client";
import { Conversation9View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-9";
import { useConversation9Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-9-controller";
import {
  conversation9Scenarios,
  createConversation9Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-9-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation9Explorer = createConversationExplorer({
  page: "conversation-9",
  title: "Conversation 9",
  scenarios: conversation9Scenarios,
  createFixture: createConversation9Fixture,
  useController: useConversation9Controller,
  View: Conversation9View,
});
