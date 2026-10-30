"use client";
import { Conversation15View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-15";
import { useConversation15Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-15-controller";
import {
  conversation15Scenarios,
  createConversation15Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-15-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation15Explorer = createConversationExplorer({
  page: "conversation-15",
  title: "Conversation 15",
  scenarios: conversation15Scenarios,
  createFixture: createConversation15Fixture,
  useController: useConversation15Controller,
  View: Conversation15View,
});
