import { generateId } from "ai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import type { ChatSettings } from "@agent/hooks/use-chat-settings";
import type {
  DurableRunRequest,
  MergePreview,
  ThreadFork,
} from "@agent-workspace/contracts/durable";
import type {
  ThreadWorkspace,
  WorkspacePanel,
  WorkspaceRun,
  WorkspaceRunRequest,
} from "@agent-workspace/contracts/workspace";
import { refreshThreadList } from "@agent/src/chat/remote-adapter";
import {
  agentInstructions,
  documentContext,
  emptyWorkspace,
  loadWorkspaces,
  WORKSPACE_IMPORT_KEY,
} from "./storage";
import { errorMessage, getActionIdentity, releaseActionIdentity } from "./api";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { workspaceClient } from "../network";

const DRAFT_PREFIX = "agent-workspace:resource-draft:";
const SUBMISSIONS_KEY = "agent-workspace:durable-submissions:v1";
type ResourceEntry = {
  workspace: ThreadWorkspace;
  change: number;
  saved: number;
  error?: string;
  conflict?: ThreadWorkspace;
  fork?: ThreadFork;
};
type ResourceStatus = "loading" | "saved" | "saving" | "unsaved" | "conflict";
type WorkspaceContextValue = {
  state: ThreadWorkspace;
  ready: boolean;
  busy: boolean;
  threadId: string | undefined;
  fork: ThreadFork | undefined;
  submitting: boolean;
  update: (recipe: (state: ThreadWorkspace) => ThreadWorkspace) => void;
  runWorkflow: (id: string, input: string) => Promise<void>;
  runAgent: (id: string, input: string) => Promise<void>;
  buildRunRequest: (kind: "agent" | "workflow", id: string, input: string) => DurableRunRequest;
  stopRun: (id: string) => Promise<void>;
  continueRun: (id: string, confirmSideEffects?: boolean) => Promise<WorkspaceRun>;
  forkRun: (id: string, stepId?: string) => Promise<void>;
  navigateToThread: (id: string) => Promise<void>;
  mergePreview: () => Promise<MergePreview>;
  mergeToParent: (preview: MergePreview) => Promise<void>;
  refreshRuns: () => Promise<void>;
  flushResources: () => Promise<void>;
  quote: (text: string) => void;
  captureConversation: () => string;
  panel: WorkspacePanel | null;
  setPanel: (panel: WorkspacePanel | null) => void;
  storageError: string | null;
  actionError: string | null;
  resourceStatus: ResourceStatus;
  resourceError: string | null;
  retrySave: () => Promise<void>;
  reloadResources: () => Promise<void>;
  resolveConflict: () => Promise<void>;
  pendingSubmission: DurableRunRequest | undefined;
  retrySubmission: () => Promise<void>;
  runConnectionError: string | null;
  settings: ChatSettings;
};
const Context = createContext<WorkspaceContextValue | null>(null);

function resources(workspace: ThreadWorkspace) {
  const { runs: _runs, ...value } = workspace;
  return value;
}
function readSubmissions(): Record<string, DurableRunRequest> {
  try {
    return JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function WorkspaceProvider({
  settings,
  children,
}: {
  settings: ChatSettings;
  children: ReactNode;
}) {
  const aui = useAui();
  const localThreadId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId,
  );
  const [entries, setEntries] = useState<Record<string, ResourceEntry>>({});
  const entriesRef = useRef(entries);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runConnectionError, setRunConnectionError] = useState<string | null>(null);
  const [panel, setPanel] = useState<WorkspacePanel | null>(null);
  const [migrationAttempt, setMigrationAttempt] = useState(0);
  const [migrated, setMigrated] = useState(false);
  const [submissions, setSubmissions] = useState(readSubmissions);
  const submissionsRef = useRef(submissions);
  const saving = useRef(new Map<string, Promise<void>>());
  const timers = useRef(new Map<string, number>());
  const submitting = useRef(new Set<string>());

  const putEntry = useCallback((id: string, entry: ResourceEntry) => {
    entriesRef.current = { ...entriesRef.current, [id]: entry };
    setEntries(entriesRef.current);
  }, []);
  const persistDraft = useCallback((id: string, entry: ResourceEntry) => {
    try {
      if (entry.change === entry.saved) localStorage.removeItem(`${DRAFT_PREFIX}${id}`);
      else localStorage.setItem(`${DRAFT_PREFIX}${id}`, JSON.stringify(resources(entry.workspace)));
    } catch {
      setStorageError("浏览器无法备份未保存草稿。服务端保存仍会尝试；请在离开前确认资源已保存。");
    }
  }, []);
  const saveResources = useCallback(
    (id: string): Promise<void> => {
      const inFlight = saving.current.get(id);
      if (inFlight) return inFlight;
      const task = (async () => {
        // Start after the task is registered so concurrent callers share the same write chain.
        await Promise.resolve();
        while (true) {
          const entry = entriesRef.current[id];
          if (!entry || entry.change === entry.saved) return;
          if (entry.conflict) throw new Error("资源已被其他页面修改。草稿保留，请先处理版本冲突。");
          const change = entry.change;
          try {
            const { workspace } = await workspaceClient.json<{ workspace: ThreadWorkspace }>(
              `/api/workspace/threads/${encodeURIComponent(id)}`,
              {
                method: "PUT",
                body: JSON.stringify(resources(entry.workspace)),
              },
            );
            const current = entriesRef.current[id];
            const next = {
              ...current,
              saved: change,
              error: undefined,
              workspace: { ...current.workspace, revision: workspace.revision },
            };
            putEntry(id, next);
            persistDraft(id, next);
          } catch (error) {
            const current = entriesRef.current[id];
            const conflict =
              error instanceof WorkspaceClientError && error.code === "revision_conflict"
                ? (error.body?.workspace as ThreadWorkspace | undefined)
                : undefined;
            putEntry(id, { ...current, error: errorMessage(error), conflict });
            throw error;
          }
        }
      })().finally(() => {
        saving.current.delete(id);
        setEntries({ ...entriesRef.current });
      });
      saving.current.set(id, task);
      setEntries({ ...entriesRef.current });
      return task;
    },
    [persistDraft, putEntry],
  );

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const legacy = loadWorkspaces();
      if (legacy.blocked) {
        if (!disposed) {
          setStorageError(legacy.error);
          setMigrated(true);
        }
        return;
      }
      try {
        if (Object.keys(legacy.data.threads).length) {
          // A stable import identity and retained original/backup make retries safe.
          const serialized = JSON.stringify(legacy.data);
          // This is a retry identity, not authentication; the server independently
          // fingerprints the full payload and rejects any identity collision.
          let first = 2166136261;
          let second = 2654435769;
          for (let index = 0; index < serialized.length; index++) {
            const code = serialized.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619);
            second = Math.imul(second ^ code, 2246822519);
          }
          const importId = `local-workspaces-v1:${serialized.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
          await workspaceClient.json("/api/workspace/import", {
            method: "POST",
            body: JSON.stringify({ threads: legacy.data.threads, importId }),
          });
          try {
            localStorage.setItem(WORKSPACE_IMPORT_KEY, importId);
          } catch {
            /* Original and server data remain intact. */
          }
        }
        if (!disposed) {
          setStorageError(legacy.error);
          setMigrated(true);
        }
      } catch (error) {
        if (!disposed)
          setStorageError(`旧工作区迁移失败；原始数据与备份均保留。${errorMessage(error)}`);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [migrationAttempt]);

  useEffect(() => {
    if (remoteId || !panel) return;
    let disposed = false;
    aui.threads
      .item({ id: localThreadId })
      .initialize()
      .catch((error: unknown) => {
        if (!disposed) setActionError(`无法建立会话工作区：${errorMessage(error)}`);
      });
    return () => {
      disposed = true;
    };
  }, [aui, localThreadId, remoteId, panel]);

  const loadResources = useCallback(
    async (id: string, discard = false) => {
      const requestedChange = entriesRef.current[id]?.change;
      const { workspace, fork } = await workspaceClient.json<{
        workspace: ThreadWorkspace;
        fork?: ThreadFork;
      }>(`/api/workspace/threads/${encodeURIComponent(id)}`);
      const current = entriesRef.current[id];
      if (discard && current?.change !== requestedChange)
        throw new Error("重新读取期间草稿又有修改，已保留新输入；请再次决定是否放弃。");
      if (current && current.change !== current.saved && !discard) return;
      let draft: Partial<ThreadWorkspace> | undefined;
      if (!discard && !current) {
        try {
          const value = localStorage.getItem(`${DRAFT_PREFIX}${id}`);
          if (value) draft = JSON.parse(value);
        } catch {
          setStorageError("未保存资源草稿无法读取；服务器资源仍然保留。");
        }
      }
      if (
        draft &&
        [draft.agents, draft.workflows, draft.documents, draft.skills].every(Array.isArray)
      ) {
        const conflict =
          (draft.revision ?? 0) !== (workspace.revision ?? 0) ? workspace : undefined;
        putEntry(id, {
          workspace: { ...workspace, ...draft, runs: workspace.runs },
          fork,
          change: 1,
          saved: 0,
          conflict,
          error: "已恢复未保存草稿，请确认后重试保存。",
        });
      } else {
        const entry = { workspace, fork, change: 0, saved: 0 };
        putEntry(id, entry);
        if (discard) persistDraft(id, entry);
      }
    },
    [persistDraft, putEntry],
  );

  useEffect(() => {
    if (!remoteId || !migrated) return;
    void loadResources(remoteId).catch((error) =>
      setActionError(`资源读取失败：${errorMessage(error)}`),
    );
  }, [remoteId, migrated, loadResources]);

  const mergeRuns = useCallback(
    (id: string, runs: WorkspaceRun[]) => {
      const entry = entriesRef.current[id];
      if (!entry) return;
      const known = new Map(entry.workspace.runs.map((run) => [run.id, run]));
      for (const run of runs) {
        const previous = known.get(run.id);
        if (!previous || (run.seq ?? 0) >= (previous.seq ?? 0)) known.set(run.id, run);
      }
      putEntry(id, { ...entry, workspace: { ...entry.workspace, runs: [...known.values()] } });
    },
    [putEntry],
  );
  const refreshThreadRuns = useCallback(
    async (id: string) => {
      const { runs } = await workspaceClient.json<{ runs: WorkspaceRun[] }>(
        `/api/workspace/runs?threadId=${encodeURIComponent(id)}`,
      );
      mergeRuns(id, runs);
      return runs;
    },
    [mergeRuns],
  );

  const hasWorkspace = Boolean(remoteId && entries[remoteId]);
  useEffect(() => {
    if (!remoteId || !entriesRef.current[remoteId]) return;
    const id = remoteId;
    const controller = new AbortController();
    const streams = new Map<string, AbortController>();
    const sequences = new Map<string, number>();
    const wait = (milliseconds: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        resolve();
      }
      controller.signal.addEventListener("abort", done, { once: true });
      if (controller.signal.aborted) done();
      return promise;
    };
    async function subscribe(runId: string) {
      const stream = new AbortController();
      streams.set(runId, stream);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await workspaceClient.fetch(
          `/api/workspace/runs/${encodeURIComponent(runId)}/events?after=${sequences.get(runId) ?? 0}`,
          { signal: stream.signal },
        );
        if (!response.ok || !response.body) throw new Error(`事件订阅失败 (${response.status})`);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const apply = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line) as { seq: number; type: string; run: WorkspaceRun };
          if (
            event.type !== "snapshot" ||
            event.run?.id !== runId ||
            !Number.isSafeInteger(event.seq)
          )
            throw new Error("服务端运行事件格式无效");
          if (event.seq <= (sequences.get(runId) ?? 0)) return;
          sequences.set(runId, event.seq);
          const entry = entriesRef.current[id];
          if (entry)
            mergeRuns(id, [event.run, ...entry.workspace.runs.filter((item) => item.id !== runId)]);
          setRunConnectionError(null);
        };
        while (!stream.signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            apply(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (done) {
            if (buffer.trim()) apply(buffer);
            break;
          }
        }
      } catch (error) {
        if (!stream.signal.aborted)
          setRunConnectionError(`运行订阅中断，正在补读；任务不会因此取消。${errorMessage(error)}`);
      } finally {
        await reader?.cancel().catch(() => {});
        streams.delete(runId);
      }
    }
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const runs = await refreshThreadRuns(id);
          if (controller.signal.aborted) break;
          setRunConnectionError(null);
          for (const run of runs)
            if ((run.status === "queued" || run.status === "running") && !streams.has(run.id))
              void subscribe(run.id);
        } catch (error) {
          if (!controller.signal.aborted)
            setRunConnectionError(`运行列表读取失败，将自动重连。${errorMessage(error)}`);
        }
        await wait(4000);
      }
    })();
    return () => {
      controller.abort();
      for (const stream of streams.values()) stream.abort();
    };
  }, [remoteId, hasWorkspace, mergeRuns, refreshThreadRuns]);

  useEffect(
    () => () => {
      for (const [id, timer] of timers.current) {
        clearTimeout(timer);
        void saveResources(id).catch(() => {});
      }
      timers.current.clear();
    },
    [saveResources],
  );

  const captureConversation = useCallback(
    () =>
      aui.thread
        .getState()
        .messages.map((message) => {
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          return text ? `${message.role === "user" ? "用户" : "助手"}：${text}` : "";
        })
        .filter(Boolean)
        .join("\n\n"),
    [aui],
  );
  const quote = useCallback(
    (text: string) => {
      if (text.trim()) {
        const composer = aui.thread.composer();
        composer.setText([composer.getState().text, text].filter(Boolean).join("\n\n"));
      }
    },
    [aui],
  );
  const update = useCallback(
    (recipe: (state: ThreadWorkspace) => ThreadWorkspace) => {
      if (!remoteId) return;
      const entry = entriesRef.current[remoteId];
      if (!entry) return;
      const draft = recipe(entry.workspace);
      const next = {
        ...entry,
        workspace: { ...draft, runs: entry.workspace.runs, revision: entry.workspace.revision },
        change: entry.change + 1,
        error: undefined,
      };
      putEntry(remoteId, next);
      persistDraft(remoteId, next);
      clearTimeout(timers.current.get(remoteId));
      timers.current.set(
        remoteId,
        window.setTimeout(() => {
          timers.current.delete(remoteId);
          void saveResources(remoteId).catch(() => {});
        }, 350),
      );
    },
    [remoteId, putEntry, persistDraft, saveResources],
  );

  function buildRunRequest(
    kind: "agent" | "workflow",
    id: string,
    input: string,
  ): DurableRunRequest {
    if (!remoteId || !entriesRef.current[remoteId]) throw new Error("当前会话尚未准备好");
    const source = entriesRef.current[remoteId].workspace;
    const workflow =
      kind === "workflow" ? source.workflows.find((item) => item.id === id) : undefined;
    const agent = kind === "agent" ? source.agents.find((item) => item.id === id) : undefined;
    const steps =
      workflow?.steps ??
      (agent
        ? [
            {
              id: generateId(),
              name: agent.name,
              agentId: agent.id,
              instruction: "执行用户任务，直接输出结果。",
            },
          ]
        : []);
    if (!input.trim() || input.length > 8000 || !steps.length || steps.length > 8)
      throw new Error("请填写 1–8 个步骤和不超过 8,000 字符的任务输入。");
    const name = workflow?.name ?? agent?.name;
    if (!name?.trim()) throw new Error("请先填写 Agent 或工作流名称。");
    const context = [captureConversation(), documentContext(source)]
      .filter(Boolean)
      .join("\n\n---\n\n");
    if (context.length > 64000)
      throw new Error("对话与选中文档超过 64,000 字符，请减少引用或在新会话运行。");
    const requestSteps: WorkspaceRunRequest["steps"] = steps.map((step) => {
      const assigned = source.agents.find((item) => item.id === step.agentId);
      if (
        !assigned?.name.trim() ||
        !step.name.trim() ||
        !step.instruction.trim() ||
        step.instruction.length > 16000
      )
        throw new Error("每个步骤需要名称、有效 Agent 和不超过 16,000 字符的指令。");
      const system = [settings.systemPrompt, agentInstructions(assigned, source)]
        .filter(Boolean)
        .join("\n\n");
      if (system.length > 16000)
        throw new Error("Agent 与技能系统指令超过 16,000 字符，请先缩短。");
      return {
        id: step.id,
        name: step.name,
        agentName: assigned.name,
        model: assigned.model,
        providerInstanceId: assigned.providerInstanceId ?? settings.providerInstanceId,
        system,
        instruction: step.instruction,
      };
    });
    return {
      threadId: remoteId,
      name,
      kind,
      runId: generateId(),
      input,
      context,
      temperature: settings.temperature,
      steps: requestSteps,
    };
  }
  function putSubmission(id: string, request?: DurableRunRequest) {
    const next = { ...submissionsRef.current };
    if (request) next[id] = request;
    else delete next[id];
    submissionsRef.current = next;
    setSubmissions(next);
    try {
      localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(next));
    } catch {
      setStorageError("提交身份无法写入浏览器。若提交回执丢失，请先核对运行列表，不要重复提交。");
    }
  }
  async function submit(request: DurableRunRequest) {
    if (submitting.current.has(request.threadId))
      throw new Error("正在提交此会话任务，请等待服务端回执。");
    submitting.current.add(request.threadId);
    putSubmission(request.threadId, request);
    try {
      await saveResources(request.threadId);
      const { run } = await workspaceClient.json<{ run: WorkspaceRun }>("/api/workspace/runs", {
        method: "POST",
        body: JSON.stringify(request),
      });
      const entry = entriesRef.current[request.threadId];
      if (entry)
        mergeRuns(request.threadId, [
          run,
          ...entry.workspace.runs.filter((item) => item.id !== run.id),
        ]);
      putSubmission(request.threadId);
      setActionError(null);
      setPanel("runs");
    } catch (error) {
      if (error instanceof WorkspaceClientError && error.status >= 400 && error.status < 500)
        putSubmission(request.threadId);
      setActionError(
        `提交未确认：${errorMessage(error)}。请核对运行记录；重试会复用同一提交身份。`,
      );
      throw error;
    } finally {
      submitting.current.delete(request.threadId);
      setEntries({ ...entriesRef.current });
    }
  }
  async function execute(kind: "agent" | "workflow", id: string, input: string) {
    if (!remoteId) throw new Error("当前会话尚未准备好");
    if (submissionsRef.current[remoteId])
      throw new Error("上次提交尚未确认，请先在运行记录重试或核对该提交。");
    const request = buildRunRequest(kind, id, input);
    request.idempotencyKey = `manual:${request.runId}`;
    await submit(request);
  }
  async function navigateToThread(id: string) {
    await refreshThreadList();
    await aui.threads.switchToThread(id);
  }
  async function stopRun(id: string) {
    await workspaceClient.json(`/api/workspace/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    if (remoteId) await refreshThreadRuns(remoteId);
  }
  async function continueRun(id: string, confirmSideEffects = false) {
    const idempotencyKey = getActionIdentity(`continue:${id}`);
    const { run } = await workspaceClient.json<{ run: WorkspaceRun }>(
      `/api/workspace/runs/${encodeURIComponent(id)}/continue`,
      { method: "POST", body: JSON.stringify({ idempotencyKey, confirmSideEffects }) },
    );
    if (remoteId) await refreshThreadRuns(remoteId);
    return run;
  }
  async function forkRun(id: string, stepId?: string) {
    if (remoteId) await saveResources(remoteId);
    const scope = `fork:${id}:${stepId ?? "latest"}`;
    const idempotencyKey = getActionIdentity(scope);
    const { threadId } = await workspaceClient.json<{ threadId: string }>(
      `/api/workspace/runs/${encodeURIComponent(id)}/fork`,
      { method: "POST", body: JSON.stringify({ stepId, idempotencyKey }) },
    );
    await navigateToThread(threadId);
    releaseActionIdentity(scope);
  }
  async function mergePreview() {
    if (!remoteId) throw new Error("当前会话尚未准备好");
    return workspaceClient.json<MergePreview>(
      `/api/workspace/threads/${encodeURIComponent(remoteId)}/merge-preview`,
    );
  }
  async function mergeToParent(preview: MergePreview) {
    if (!remoteId) throw new Error("当前会话尚未准备好");
    await workspaceClient.json(`/api/workspace/threads/${encodeURIComponent(remoteId)}/merge`, {
      method: "POST",
      body: JSON.stringify({
        confirmed: true,
        text: preview.text,
        parentThreadId: preview.parentThreadId,
      }),
    });
  }
  async function reloadResources() {
    if (!migrated) {
      setMigrationAttempt((value) => value + 1);
      return;
    }
    if (remoteId) {
      clearTimeout(timers.current.get(remoteId));
      timers.current.delete(remoteId);
      await saving.current.get(remoteId)?.catch(() => {});
      await loadResources(remoteId, true);
    }
  }
  async function resolveConflict() {
    if (!remoteId) return;
    const entry = entriesRef.current[remoteId];
    if (!entry?.conflict) return;
    const next = {
      ...entry,
      conflict: undefined,
      error: undefined,
      workspace: { ...entry.workspace, revision: entry.conflict.revision },
    };
    putEntry(remoteId, next);
    persistDraft(remoteId, next);
    await saveResources(remoteId);
  }
  const entry = remoteId ? entries[remoteId] : undefined;
  const state = entry?.workspace ?? emptyWorkspace;
  useEffect(() => {
    const request = remoteId ? submissionsRef.current[remoteId] : undefined;
    if (request && state.runs.some((run) => run.id === request.runId)) {
      putSubmission(request.threadId);
      setActionError(null);
    }
  }, [remoteId, state.runs]);
  const resourceStatus: ResourceStatus = !entry
    ? "loading"
    : entry.conflict
      ? "conflict"
      : saving.current.has(remoteId!)
        ? "saving"
        : entry.change === entry.saved
          ? "saved"
          : "unsaved";
  return (
    <Context.Provider
      value={{
        state,
        ready: Boolean(entry) && migrated,
        busy: state.runs.some((run) => run.status === "queued" || run.status === "running"),
        threadId: remoteId,
        update,
        fork: entry?.fork,
        submitting: Boolean(remoteId && submitting.current.has(remoteId)),
        runWorkflow: (id, input) => execute("workflow", id, input),
        runAgent: (id, input) => execute("agent", id, input),
        buildRunRequest,
        stopRun,
        continueRun,
        forkRun,
        navigateToThread,
        mergePreview,
        mergeToParent,
        refreshRuns: async () => {
          if (remoteId) await refreshThreadRuns(remoteId);
        },
        flushResources: async () => {
          if (!remoteId || !entriesRef.current[remoteId])
            throw new Error("当前会话资源尚未准备好，请等待载入后再创建分支。");
          await saveResources(remoteId);
        },
        quote,
        captureConversation,
        panel,
        setPanel,
        storageError,
        actionError,
        resourceStatus,
        resourceError: entry?.error ?? null,
        retrySave: async () => {
          if (remoteId) await saveResources(remoteId);
        },
        reloadResources,
        resolveConflict,
        pendingSubmission: remoteId ? submissions[remoteId] : undefined,
        retrySubmission: async () => {
          if (remoteId && submissionsRef.current[remoteId])
            await submit(submissionsRef.current[remoteId]);
        },
        runConnectionError,
        settings,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error("WorkspaceProvider is missing");
  return context;
}
