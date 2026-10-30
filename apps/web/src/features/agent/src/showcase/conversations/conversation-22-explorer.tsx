"use client";
import { Conversation22View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-22";
import { useConversation22Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-22-controller";
import {
  conversation22Scenarios,
  createConversation22Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-22-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation22Explorer = createConversationExplorer({
  page: "web-answer",
  title: "Conversation 22",
  scenarios: conversation22Scenarios,
  createFixture: createConversation22Fixture,
  useController: useConversation22Controller,
  View: Conversation22View,
});
