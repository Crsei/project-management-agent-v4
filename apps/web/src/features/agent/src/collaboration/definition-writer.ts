import { useEffect, useRef, useState } from "react";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import type { AgentDefinition, TeamDefinition, DefinitionRequestResponse } from "@agent-workspace/contracts/collaboration";
import { captureCollaborationAuthority, collaborationJson, errorText, useCollaborationState } from "./data";

type Definition = AgentDefinition | TeamDefinition;
export function useDefinitionWriter(kind: "agent" | "team", workspaceId: string, identity: string, onSaved: (item: Definition) => void) {
  const key = `agent-collaboration:definition-request:${workspaceId}:${kind}:${identity}`;
  const [attempt, setAttempt] = useState<string | null>(() => { try { return sessionStorage.getItem(key); } catch { return null; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useCollaborationState<string | null>(null, null);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const finish = (item: Definition) => {
    sessionStorage.removeItem(key); if (mounted.current) { setAttempt(null); onSaved(item); }
  };
  const write = async (path: string, method: string, body: Record<string, unknown>) => {
    if (active.current || attempt) return;
    const requestId = crypto.randomUUID();
    try { sessionStorage.setItem(key, requestId); } catch { setError("无法保存原请求身份，未提交。 / Cannot save original request identity; nothing submitted."); return; }
    active.current = true; setAttempt(requestId); setBusy(true); setError(null);
    const currentAuthority = captureCollaborationAuthority();
    try {
      const result = await collaborationJson<{ agent?: AgentDefinition; team?: TeamDefinition }>(path, { method, body: JSON.stringify({ ...body, requestId }) });
      if (!mounted.current || !currentAuthority()) return;
      const item = kind === "agent" ? result.agent : result.team;
      if (!item) throw new Error("定义响应不兼容；请核对原请求。 / Invalid definition response; reconcile original request.");
      finish(item);
    } catch (cause) {
      if (!mounted.current || !currentAuthority()) return;
      if (cause instanceof WorkspaceClientError && [400, 404, 409, 422].includes(cause.status)) { sessionStorage.removeItem(key); setAttempt(null); }
      if (mounted.current) setError(errorText(cause));
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const reconcile = async () => {
    if (!attempt || active.current) return;
    active.current = true; setBusy(true); setError(null);
    const currentAuthority = captureCollaborationAuthority();
    try {
      const result = await collaborationJson<DefinitionRequestResponse>(`/api/collaboration/requests/${encodeURIComponent(attempt)}?${new URLSearchParams({ workspaceId })}`, { cache: "no-store" });
      if (!mounted.current || !currentAuthority()) return;
      if (result.request) {
        if (result.request.kind !== kind) throw new Error("原收据类型不匹配。 / Original receipt type mismatch.");
        finish(result.request.result);
      } else {
        if (mounted.current) setError("尚无原请求收据，不能据此证明未受理。保留原身份并继续只读核对，不创建新请求。 / No receipt yet is not proof of nonacceptance. Keep the original identity and recheck without creating another request.");
      }
    } catch (cause) { if (mounted.current && currentAuthority()) setError(errorText(cause)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  return { write, reconcile, busy, attempt, error, locked: busy || !!attempt };
}
