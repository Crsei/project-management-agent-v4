"use client";
import { Conversation14View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-14";
import { useConversation14Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-14-controller";
import {
  conversation14Scenarios,
  createConversation14Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-14-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation14Explorer = createConversationExplorer({
  page: "conversation-14",
  title: "Conversation 14",
  scenarios: conversation14Scenarios,
  createFixture: createConversation14Fixture,
  useController: useConversation14Controller,
  View: Conversation14View,
});
