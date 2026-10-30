"use client";
import { Conversation19View } from "@easyuse-ui/agent-workspace-views/conversations/conversation-19";
import { useConversation19Controller } from "@easyuse-ui/agent-workspace-views/conversations/conversation-19-controller";
import {
  conversation19Scenarios,
  createConversation19Fixture,
} from "@easyuse-ui/agent-workspace-views/conversations/conversation-19-fixtures";
import { createConversationExplorer } from "./conversation-explorer-factory";
export const Conversation19Explorer = createConversationExplorer({
  page: "conversation-19",
  title: "Conversation 19",
  scenarios: conversation19Scenarios,
  createFixture: createConversation19Fixture,
  useController: useConversation19Controller,
  View: Conversation19View,
});
