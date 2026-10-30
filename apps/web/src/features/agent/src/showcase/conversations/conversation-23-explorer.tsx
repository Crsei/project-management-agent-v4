"use client";
import { Conversation23View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-23";
import { useConversation23Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-23-controller";
import {
  conversation23Scenarios,
  createConversation23Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-23-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation23Explorer = createConversationExplorer({
  page: "conversation-23",
  title: "Conversation 23",
  scenarios: conversation23Scenarios,
  createFixture: createConversation23Fixture,
  useController: useConversation23Controller,
  View: Conversation23View,
});
