"use client";
import { Conversation18View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-18";
import { useConversation18Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-18-controller";
import {
  conversation18Scenarios,
  createConversation18Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-18-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation18Explorer = createConversationExplorer({
  page: "conversation-18",
  title: "Conversation 18",
  scenarios: conversation18Scenarios,
  createFixture: createConversation18Fixture,
  useController: useConversation18Controller,
  View: Conversation18View,
});
