import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { AgentScope } from "../../pm/state";
import { inspectUrl } from "./api";

type InspectorScope = AgentScope & { threadId?: string };
const ScopeContext = createContext<InspectorScope | null>(null);

export function InspectorScopeProvider({ scope, children }: { scope: InspectorScope; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

export function useInspectorUrl() {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("文件检查器需要明确的 PM 工作区或项目作用域。");
  const { workspaceId, projectId, threadId } = scope;
  return useCallback((path: string, params?: Record<string, string | undefined>) => inspectUrl(path, {
    ...params, workspaceId, projectId: projectId ?? undefined, threadId,
  }), [workspaceId, projectId, threadId]);
}
