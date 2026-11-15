import { useSyncExternalStore } from "react";
import { workspaceClient } from "../network";
import { createChatSubmissionRecovery } from "./submission-recovery-model.ts";

const recovery = createChatSubmissionRecovery({
  client: workspaceClient,
  storage: {
    getItem: key => typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key),
  },
});
export const { getPendingChatSubmission, rememberChatSubmission, forgetChatSubmission, reconcileChatSubmission } = recovery;
export function usePendingChatSubmission(threadId: string | undefined) {
  return useSyncExternalStore(recovery.subscribe, () => threadId ? recovery.getPendingChatSubmission(threadId) : null, () => null);
}
