"use client";
import { Conversation21View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-21";
import { useConversation21Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-21-controller";
import {
  conversation21Scenarios,
  createConversation21Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-21-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation21Explorer = createConversationExplorer({
  page: "parent-child-conversations",
  title: "Conversation 21",
  scenarios: conversation21Scenarios,
  createFixture: createConversation21Fixture,
  useController: useConversation21Controller,
  View: Conversation21View,
});
