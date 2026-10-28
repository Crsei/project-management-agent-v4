"use client";
import { Conversation13View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-13";
import { useConversation13Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-13-controller";
import {
  conversation13Scenarios,
  createConversation13Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-13-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation13Explorer = createConversationExplorer({
  page: "conversation-13",
  title: "Conversation 13",
  scenarios: conversation13Scenarios,
  createFixture: createConversation13Fixture,
  useController: useConversation13Controller,
  View: Conversation13View,
});
