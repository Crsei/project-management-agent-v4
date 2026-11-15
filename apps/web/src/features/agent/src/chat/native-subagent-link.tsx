import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import type { NativeOutputItem } from "@agent-workspace/contracts/output";
import { useAgentText } from "../i18n";
import { useChatActions } from "./chat-actions";
import { resolveSubagent } from "./thread-actions";

/** Provider child IDs are not assumed to be authorized local thread IDs. */
export function NativeSubagentLink({ generationId, item }: { generationId: string; item: NativeOutputItem }) {
  const t = useAgentText();
  const actions = useChatActions();
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const [error, setError] = useState<string>();
  const open = async () => {
    if (!actions || pending) return;
    setPending(true); setError(undefined); setUnavailable(undefined);
    try {
      const result = await resolveSubagent(generationId, item.id);
      if (result.threadId) await actions.navigateSession(result.threadId);
      else setUnavailable(result.reason || t("此原生子代理没有可访问的工作台会话。", "This native subagent has no accessible workspace session."));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <div className="native-subagent-navigation">
    <Button type="button" variant="outline" size="sm" disabled={!actions || pending} onClick={() => void open()}><GitBranch aria-hidden="true" />{pending ? t("正在解析会话…", "Resolving session…") : t("打开子代理会话", "Open subagent session")}</Button>
    {unavailable && <p role="status">{unavailable}</p>}
    {error && <p role="alert" className="native-error">{error}</p>}
  </div>;
}
