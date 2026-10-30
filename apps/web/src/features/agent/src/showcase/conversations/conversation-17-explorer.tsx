"use client";
import { Conversation17View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-17";
import { useConversation17Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-17-controller";
import {
  conversation17Scenarios,
  createConversation17Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-17-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation17Explorer = createConversationExplorer({
  page: "conversation-17",
  title: "Conversation 17",
  scenarios: conversation17Scenarios,
  createFixture: createConversation17Fixture,
  useController: useConversation17Controller,
  View: Conversation17View,
});
