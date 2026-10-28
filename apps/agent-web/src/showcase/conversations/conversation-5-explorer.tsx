"use client";
import { Conversation5View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-5";
import { useConversation5Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-5-controller";
import {
  conversation5Scenarios,
  createConversation5Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-5-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation5Explorer = createConversationExplorer({
  page: "conversation-5",
  title: "Conversation 5",
  scenarios: conversation5Scenarios,
  createFixture: createConversation5Fixture,
  useController: useConversation5Controller,
  View: Conversation5View,
});
