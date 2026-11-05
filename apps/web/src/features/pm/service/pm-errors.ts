import { ApiError, CommandOutcomeUnknown, type Command, type CommandReceipt } from "@contracts"

export class PmCommandError extends Error {
  readonly code: string
  readonly status: number

  constructor(readonly receipt: Extract<CommandReceipt, { status: "rejected" }>, readonly command: Command) {
    super(receipt.error.message)
    this.name = "PmCommandError"
    this.code = receipt.error.code
    this.status = receipt.httpStatus
  }
}

export class PmServiceError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "PmServiceError"
  }
}

export function asPmError(error: unknown): Error {
  return error instanceof Error ? error : new PmServiceError("temporarily_unavailable")
}

export function isAccessError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)
}

const messages: Record<string, readonly [string, string]> = {
  invalid_credentials: ["The email or password is incorrect.", "邮箱或密码不正确。"],
  unauthenticated: ["Your session has ended. Sign in again.", "登录已失效，请重新登录。"],
  permission_denied: ["You do not have permission for this action.", "你没有执行此操作的权限。"],
  not_found_or_forbidden: ["This resource does not exist or is not accessible.", "资源不存在或你没有访问权限。"],
  origin_forbidden: ["This page's origin is not accepted. Open the service at its configured public address.", "服务不接受当前页面的来源，请使用配置的公共访问地址打开。"],
  version_conflict: ["This object changed elsewhere. Your draft is preserved; refresh and review it before submitting a new command.", "对象已被其他人修改。草稿已保留，请刷新并核对后重新提交。"],
  idempotency_conflict: ["This command ID belongs to a different request. Reconcile the original command first.", "此命令编号已用于其他请求，请先核对原命令。"],
  validation_failed: ["Check the required fields and their values.", "请检查必填项及输入值。"],
  invalid_transition: ["The current state does not allow this action.", "当前状态不允许执行此操作。"],
  dependency_cycle: ["This dependency would create a cycle.", "此依赖会形成循环。"],
  dependency_unsatisfied: ["Complete the prerequisites before continuing.", "请先完成前置工作项。"],
  blocked: ["Resolve the blockers before continuing.", "请先解除阻塞。"],
  project_not_active: ["Activate or reopen the project before continuing.", "请先激活或重新打开项目。"],
  resource_archived: ["Restore this archived resource before changing it.", "请先恢复已归档的资源。"],
  artifact_hidden: ["Restore this hidden artifact before renaming it or adding a version.", "请先恢复已隐藏的成果，再修改显示名或追加版本。"],
  review_required: ["A passing review of the current submission is required.", "当前提交需要通过审核。"],
  review_stale: ["The review no longer matches the current submission. Submit and review the current content.", "审核已过期，请提交并审核当前内容。"],
  review_already_recorded: ["This submission already has a final review.", "此提交已有最终审核结论。"],
  last_administrator: ["The final workspace administrator cannot be removed.", "不能移除工作区的最后一位管理员。"],
  capability_not_enabled: ["This capability is not enabled by the service.", "服务尚未启用此能力。"],
  setup_unavailable: ["First-time setup is not prepared. Ask the deployment administrator to prepare a one-time setup token.", "首次设置尚未准备，请联系部署管理员准备一次性设置令牌。"],
  setup_token_invalid: ["The setup token was not accepted. Check the token provided by the deployment administrator.", "设置令牌未通过核验，请检查部署管理员提供的完整令牌。"],
  instance_initialized: ["This instance is already initialized. Use ordinary sign-in; do not submit setup again.", "此实例已完成设置，请使用普通登录，不要重复提交首次设置。"],
  backend_not_initialized: ["The backend is not initialized.", "后端尚未初始化。"],
  cursor_expired: ["The event cursor expired. Reloading an authorized snapshot is required.", "事件游标已过期，需要重新读取有权限的快照。"],
  command_pending: ["A command is already in progress. Do not submit it again.", "命令正在处理中，请勿重复提交。"],
  outcome_unknown: ["The result is unknown. Keep the original command and query its receipt; do not submit a replacement.", "结果尚不确定。请保留原命令并查询收据，不要重复提交。"],
  receipt_unavailable: ["No accessible receipt was found yet. This does not prove failure; keep querying the original command ID.", "尚未找到可访问的收据，这不代表执行失败。请继续查询原命令编号。"],
  recovery_storage_unavailable: ["Browser recovery storage is unavailable or full. New commands are blocked; previously pending commands still require reconciliation.", "浏览器恢复存储不可用或已满。已禁止发送新命令，此前待定的命令仍需核对。"],
  session_changed: ["Your session changed. Reload the current workspace before continuing.", "登录会话已改变，请重新加载当前工作区。"],
  rate_limited: ["Too many requests. Wait before trying again.", "请求过于频繁，请稍后再试。"],
  invalid_response: ["The service returned an unexpected response. Existing data may be stale.", "服务返回了异常响应，现有数据可能已过期。"],
  temporarily_unavailable: ["The service cannot be reached right now. Existing data may be stale; try refreshing.", "暂时无法连接服务。现有数据可能已过期，请尝试刷新。"],
}

/** Present only known, localized descriptions; never echo backend internals or request payloads. */
export function pmErrorMessage(error: unknown, language: "en" | "zh" = "en"): string {
  const code = error instanceof CommandOutcomeUnknown ? "outcome_unknown"
    : error instanceof ApiError || error instanceof PmCommandError || error instanceof PmServiceError ? error.code
      : "temporarily_unavailable"
  const fallback = error instanceof PmCommandError || (error instanceof ApiError && error.status < 500)
    ? ["The service rejected this action. Check the current state and required fields.", "服务拒绝了此操作，请检查当前状态和必填项。"]
    : messages.temporarily_unavailable
  return (messages[code] ?? fallback)[language === "zh" ? 1 : 0]
}
