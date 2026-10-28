"use client";
import { Conversation7View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-7";
import { useConversation7Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-7-controller";
import {
  conversation7Scenarios,
  createConversation7Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-7-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation7Explorer = createConversationExplorer({
  page: "conversation-7",
  title: "Conversation 7",
  scenarios: conversation7Scenarios,
  createFixture: createConversation7Fixture,
  useController: useConversation7Controller,
  View: Conversation7View,
});
