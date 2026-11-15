import { workspaceClient } from "../network";
import { agentText } from "../i18n-text";
import { createAgentSessionLifecycle } from "./session-lifecycle-model.ts";

export const { setAgentSessionStatus, deleteAgentSession } = createAgentSessionLifecycle({
  client: workspaceClient,
  storage: {
    getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key),
  },
  confirm: message => window.confirm(message),
  text: agentText,
});
