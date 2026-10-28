"use client";
import { Conversation16View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-16";
import { useConversation16Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-16-controller";
import {
  conversation16Scenarios,
  createConversation16Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-16-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation16Explorer = createConversationExplorer({
  page: "conversation-16",
  title: "Conversation 16",
  scenarios: conversation16Scenarios,
  createFixture: createConversation16Fixture,
  useController: useConversation16Controller,
  View: Conversation16View,
});
