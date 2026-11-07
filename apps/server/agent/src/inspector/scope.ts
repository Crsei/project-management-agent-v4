import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { realpath, stat } from "node:fs/promises";
import { executionSelectionSchema } from "@agent-workspace/contracts/chat";
import { DurableError } from "../durable/errors.ts";
import { getThread, validThreadId } from "../durable/threads.ts";

const INSPECTOR_QUERY_KEYS: Record<string, true> = { threadId: true, path: true, staged: true, q: true };

/** A Session's server-resolved execution directory is the only inspector root. */
export async function resolveInspectorRoot(url: URL, headers: Headers): Promise<string> {
  const query = url.searchParams;
  const allowed = INSPECTOR_QUERY_KEYS;
  for (const key of query.keys()) {
    if (!Object.hasOwn(allowed, key) || query.getAll(key).length > 1)
      throw new DurableError(400, "invalid_inspector_request", "文件区域只接受会话与相对路径参数，且不能重复。");
  }
  const threadId = query.get("threadId");
  if (!validThreadId(threadId))
    throw new DurableError(400, "invalid_inspector_request", "请选择 Session。");
  const thread = getThread(threadId);
  if (!thread) throw new DurableError(404, "thread_not_found", "会话不存在。");
  const selection = executionSelectionSchema.safeParse(thread.executionSelection);
  if (!selection.success)
    throw new DurableError(412, "session_cutover_required", "旧会话不能获得代码执行目录。");
  if (!selection.data.agentWorkspaceId)
    throw new DurableError(412, "code_environment_required", "纯聊天 Session 没有代码 Files/Git/Terminal。");
  const snapshot = await resolveChatExecutionScope(thread, headers, "inspect");
  const environment = snapshot.environment;
  if (environment.agentWorkspaceId !== selection.data.agentWorkspaceId ||
      environment.agentWorkspaceRevision !== selection.data.agentWorkspaceRevision)
    throw new DurableError(409, "execution_binding_changed", "Session 执行目录绑定已改变。");
  const executionPath = environment.executionPath;
  if (!executionPath)
    throw new DurableError(412, "code_environment_required", "Session 没有代码执行目录。");
  try {
    const root = await realpath(executionPath);
    if (root !== executionPath || !(await stat(root)).isDirectory()) throw new Error("Changed root");
    return root;
  } catch { throw new DurableError(412, "execution_unavailable", "当前执行目录不可用。"); }
}
