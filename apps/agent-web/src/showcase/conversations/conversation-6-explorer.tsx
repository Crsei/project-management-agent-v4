"use client";
import { Conversation6View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-6";
import { useConversation6Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-6-controller";
import {
  conversation6Scenarios,
  createConversation6Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-6-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation6Explorer = createConversationExplorer({
  page: "conversation-6",
  title: "Conversation 6",
  scenarios: conversation6Scenarios,
  createFixture: createConversation6Fixture,
  useController: useConversation6Controller,
  View: Conversation6View,
});
