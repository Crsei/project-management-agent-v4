import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { FolderTerminalRequest } from "../../pm/execution-terminals";
import { agentText } from "../../i18n-text.ts";
import { useAgentText } from "../../i18n";
import { inspectUrl } from "./api";

export type InspectorScope = { threadId?: string; environment?: ExecutionEnvironment; onOpenTerminal?: (request: FolderTerminalRequest) => void };
const ScopeContext = createContext<InspectorScope | null>(null);
export function InspectorScopeProvider({ scope, children }: { scope: InspectorScope; children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
export function useInspectorScope() {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error(agentText("检查器需要当前会话的真实代码环境。", "The inspector requires the current session's actual code environment."));
  return scope;
}
export function InspectorExecution({ children }: { children: ReactNode }) {
  const scope = useInspectorScope();
  const t = useAgentText();
  const environment = scope.environment;
  if (!environment?.agentWorkspaceId || !environment.executionPath || !scope.threadId) return <p className="inspector-empty">{t("此会话未选择真实代码文件夹。", "This session has no selected code folder.")}</p>;
  return <div className="pm-inspector-roots">
    <p className="inspector-muted pm-inspector-root-path" title={`Source: ${environment.sourcePath}\nExecution: ${environment.executionPath}`}>{environment.agentWorkspaceName} · {environment.worktree ? "Worktree" : t("会话目录", "Session folder")}<code>{environment.executionPath}</code>{environment.sourcePath !== environment.executionPath && <small>{t("来源", "Source")}: {environment.sourcePath}</small>}</p>
    <InspectorScopeProvider key={`${scope.threadId}:${environment.agentWorkspaceId}:${environment.executionPath}`} scope={scope}>{children}</InspectorScopeProvider>
  </div>;
}
export function useInspectorUrl() {
  const { threadId } = useInspectorScope();
  return useCallback((path: string, params?: Record<string, string | undefined>) => inspectUrl(path, { ...params, threadId }), [threadId]);
}
