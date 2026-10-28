"use client";
import { Conversation4View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-4";
import { useConversation4Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-4-controller";
import {
  conversation4Scenarios,
  createConversation4Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-4-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation4Explorer = createConversationExplorer({
  page: "conversation-4",
  title: "Conversation 4",
  scenarios: conversation4Scenarios,
  createFixture: createConversation4Fixture,
  useController: useConversation4Controller,
  View: Conversation4View,
});
