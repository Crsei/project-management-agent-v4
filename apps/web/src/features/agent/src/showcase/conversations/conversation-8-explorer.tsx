"use client";
import { Conversation8View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-8";
import { useConversation8Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-8-controller";
import {
  conversation8Scenarios,
  createConversation8Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-8-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation8Explorer = createConversationExplorer({
  page: "conversation-8",
  title: "Conversation 8",
  scenarios: conversation8Scenarios,
  createFixture: createConversation8Fixture,
  useController: useConversation8Controller,
  View: Conversation8View,
});
