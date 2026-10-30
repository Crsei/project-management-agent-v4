"use client";
import { Conversation10View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-10";
import { useConversation10Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-10-controller";
import {
  conversation10Scenarios,
  createConversation10Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-10-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation10Explorer = createConversationExplorer({
  page: "conversation-10",
  title: "Conversation 10",
  scenarios: conversation10Scenarios,
  createFixture: createConversation10Fixture,
  useController: useConversation10Controller,
  View: Conversation10View,
});
