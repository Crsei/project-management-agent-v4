"use client";
import { Conversation11View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-11";
import { useConversation11Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-11-controller";
import {
  conversation11Scenarios,
  createConversation11Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-11-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation11Explorer = createConversationExplorer({
  page: "conversation-11",
  title: "Conversation 11",
  scenarios: conversation11Scenarios,
  createFixture: createConversation11Fixture,
  useController: useConversation11Controller,
  View: Conversation11View,
});
