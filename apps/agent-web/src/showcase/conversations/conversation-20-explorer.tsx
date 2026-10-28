"use client";
import { Conversation20View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-20";
import { useConversation20Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-20-controller";
import {
  conversation20Scenarios,
  createConversation20Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-20-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation20Explorer = createConversationExplorer({
  page: "conversation-20",
  title: "Conversation 20",
  scenarios: conversation20Scenarios,
  createFixture: createConversation20Fixture,
  useController: useConversation20Controller,
  View: Conversation20View,
});
