import { createContext, useContext, useMemo, type ReactNode } from "react";
import { agentText } from "../i18n-text.ts";
import { normalizeChatFilePath } from "./chat-actions-policy";

export type ChatInspectorRequest = {
  id: string;
  threadId: string;
  executionPath: string;
  kind: "files" | "git";
  path?: string;
  line?: number;
  staged?: boolean;
};

export type ChatActions = {
  threadId?: string;
  executionPath?: string;
  canOpenFiles: boolean;
  openFile: (path: string, line?: number) => void;
  openDiff: (path?: string, options?: { staged?: boolean }) => void;
  navigateSession: (sessionId: string) => Promise<void>;
};

const Context = createContext<ChatActions | null>(null);

export function ChatActionsProvider({ threadId, executionPath, canOpenFiles, onOpenInspector, onNavigateSession, children }: {
  threadId?: string;
  executionPath?: string;
  canOpenFiles: boolean;
  onOpenInspector: (request: ChatInspectorRequest) => void;
  onNavigateSession: (sessionId: string) => Promise<void>;
  children: ReactNode;
}) {
  const value = useMemo<ChatActions>(() => {
    const open = (kind: ChatInspectorRequest["kind"], path?: string, line?: number, staged?: boolean) => {
      if (!canOpenFiles || !threadId || !executionPath) throw new Error(agentText("当前会话没有可访问的代码文件夹。", "This session has no accessible code folder."));
      const normalized = path === undefined ? undefined : normalizeChatFilePath(path, executionPath);
      if (normalized === null || (line !== undefined && (!Number.isSafeInteger(line) || line < 1))) throw new Error(agentText("文件链接不在当前会话的代码目录内，或行号无效。", "The file link is outside this session's code folder, or its line number is invalid."));
      onOpenInspector({ id: crypto.randomUUID(), threadId, executionPath, kind, path: normalized, line, staged });
    };
    return {
      threadId,
      executionPath,
      canOpenFiles,
      openFile: (path, line) => open("files", path, line),
      openDiff: (path, options) => open("git", path, undefined, options?.staged),
      navigateSession: onNavigateSession,
    };
  }, [threadId, executionPath, canOpenFiles, onOpenInspector, onNavigateSession]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Renderers outside a live chat must leave session-only actions unavailable. */
export function useChatActions(): ChatActions | null {
  return useContext(Context);
}
