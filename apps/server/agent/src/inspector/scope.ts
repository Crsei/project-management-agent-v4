import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { realpath, stat } from "node:fs/promises";
import { agentScopeSchema } from "@agent-workspace/contracts/chat";
import { resolveAgentScope, sameAgentScope } from "../durable/agent-scope.ts";
import { DurableError } from "../durable/errors.ts";
import { getThread, validThreadId } from "../durable/threads.ts";

/** Resolve every request with its own PM credentials; never accept a client root. */
export async function resolveInspectorRoot(url: URL, headers: Headers): Promise<string> {
  const query = url.searchParams;
  for (const key of ["workspaceId", "projectId", "threadId"]) {
    if (query.getAll(key).length > 1)
      throw new DurableError(400, "invalid_scope", "文件区域参数不能重复。");
  }
  if (query.has("cwd") || query.has("root"))
    throw new DurableError(400, "invalid_scope", "文件区域必须由 PM 解析，不能指定本地目录。");
  const parsed = agentScopeSchema.safeParse({
    workspaceId: query.get("workspaceId"),
    projectId: query.get("projectId"),
  });
  if (!parsed.success)
    throw new DurableError(400, "invalid_scope", "请选择有效的工作区或项目文件区域。");
  const scope = parsed.data;
  const threadId = query.get("threadId");
  let selectedThread;
  if (threadId !== null) {
    if (!validThreadId(threadId))
      throw new DurableError(400, "invalid_thread", "无效的会话 ID。");
    const thread = getThread(threadId);
    if (!thread) throw new DurableError(404, "thread_not_found", "会话不存在。");
    selectedThread = thread;
    if (!thread.scope)
      throw new DurableError(412, "scope_required", "历史会话没有文件区域归属。");
    if (!sameAgentScope(thread.scope, scope))
      throw new DurableError(409, "scope_conflict", "文件区域与会话归属不一致。");
  }
  const snapshot = selectedThread ? await resolveChatExecutionScope(selectedThread, headers, "inspect") : await resolveAgentScope(scope, headers);
  try {
    const root = await realpath(snapshot.path);
    if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
    return root;
  } catch {
    throw new DurableError(412, "scope_unavailable", "当前文件区域目录不可用。");
  }
}
