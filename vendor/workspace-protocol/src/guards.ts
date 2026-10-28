import type { ApprovalCommand, AnswerCommand, WorkspaceCommand } from "./commands.ts"
import type {
  Workspace, WorkspaceApproval, WorkspaceDraft, WorkspaceQuestion, WorkspaceResource,
  WorkspaceResourceReference, WorkspaceRun, WorkspaceSession, WorkspaceSettings, WorkspaceSkill, WorkspaceTerminal,
} from "./entities.ts"
import type { WorkspaceCapabilities, WorkspaceError, WorkspaceErrorCode } from "./primitives.ts"
import type { WorkspaceOperationReceipt } from "./operations.ts"

export function validateApprovalDecision(command: ApprovalCommand, approval: WorkspaceApproval, capabilities: WorkspaceCapabilities): WorkspaceError | null {
  if (command.target.approvalId !== approval.approvalId || command.target.sessionId !== approval.sessionId || command.target.runId !== approval.runId) return { code: "forbidden", message: "Approval does not belong to the command target.", retryable: false }
  if (command.expectedEpoch !== approval.source.epoch || command.expectedTurnId !== approval.turnId || approval.status !== "pending") return { code: "approval-expired", message: "Approval is no longer answerable in this source epoch and turn.", retryable: false }
  if (command.expectedVersion !== approval.version) return { code: "version-conflict", message: "Approval version changed.", retryable: false, currentVersion: approval.version }
  const option = approval.options.find((value) => value.optionId === command.optionId)
  if (!option) return { code: "approval-option-invalid", message: "Only source-advertised decisions are accepted.", retryable: false }
  if (option.scope === "persistent" && !capabilities.approval.persistentDecisions) return { code: "capability-unavailable", message: "Persistent approval is not available.", retryable: false }
  return null
}

export function validateQuestionAnswer(command: AnswerCommand, question: WorkspaceQuestion): WorkspaceError | null {
  if (command.target.questionId !== question.questionId || command.target.sessionId !== question.sessionId || command.target.runId !== question.runId) return { code: "forbidden", message: "Question does not belong to the command target.", retryable: false }
  if (command.expectedEpoch !== question.source.epoch || command.expectedTurnId !== question.turnId || question.status !== "pending") return { code: "approval-expired", message: "Question is no longer answerable in this source epoch and turn.", retryable: false }
  if (command.expectedVersion !== question.version) return { code: "version-conflict", message: "Question version changed.", retryable: false, currentVersion: question.version }
  if (command.response.kind === "cancel") return question.allowCancel ? null : { code: "answer-invalid", message: "The source did not advertise cancellation.", retryable: false }
  const responses = command.response.answers
  const seen = new Set<string>()
  for (const answer of responses) {
    const prompt = question.prompts.find((value) => value.promptId === answer.promptId)
    if (!prompt || seen.has(answer.promptId)) return { code: "answer-invalid", message: "Answers must identify unique advertised prompts.", retryable: false }
    seen.add(answer.promptId)
    if ((!prompt.allowText && answer.text !== null) || (!prompt.multiple && answer.optionIds.length > 1)
      || new Set(answer.optionIds).size !== answer.optionIds.length
      || answer.optionIds.some((id) => !prompt.options.some((option) => option.optionId === id))
      || (prompt.required && answer.optionIds.length === 0 && !answer.text?.trim())) return { code: "answer-invalid", message: "Answer violates the source-advertised options.", retryable: false }
  }
  if (question.prompts.some((prompt) => prompt.required && !seen.has(prompt.promptId))) return { code: "answer-invalid", message: "A required source prompt is unanswered.", retryable: false }
  return null
}

export function validateResourceReference(reference: WorkspaceResourceReference, resources: readonly WorkspaceResource[], workspaceId: string, sessionId: string | null): WorkspaceError | null {
  const resource = resources.find((value) => value.resourceId === reference.resourceId)
  if (!resource || resource.workspaceId !== workspaceId || (resource.sessionId !== null && resource.sessionId !== sessionId)) return { code: "forbidden", message: "Resource is not authorized for this scope.", retryable: false }
  if (resource.version !== reference.version || resource.contentHash !== reference.contentHash) return { code: "resource-version-conflict", message: "Resource content changed; select its current version.", retryable: false, currentVersion: resource.version }
  if (resource.availability !== "available" || resource.lifecycle === "deleted") return { code: "resource-unavailable", message: "Resource content is unavailable.", retryable: false }
  return null
}

// All entries must already be selected under the authenticated owner's authorization and write lock.
// This pure guard checks versions/capabilities; it is not authentication, path resolution, or a database transaction.
export type WorkspaceCommandContext = {
  workspace: Workspace
  capabilities: WorkspaceCapabilities
  resources: readonly WorkspaceResource[]
  skills: readonly WorkspaceSkill[]
  session?: WorkspaceSession
  run?: WorkspaceRun
  draft?: WorkspaceDraft
  approval?: WorkspaceApproval
  question?: WorkspaceQuestion
  settings?: WorkspaceSettings
  terminal?: WorkspaceTerminal
  operation?: WorkspaceOperationReceipt
  conflictingOperations?: readonly WorkspaceOperationReceipt[]
  worktreeState?: { hostCreated: boolean; dirty: boolean; activeRuns: number; activeTerminals: number; unknownRuns: number }
}
export function validateWorkspaceCommandContext(command: WorkspaceCommand, context: WorkspaceCommandContext): WorkspaceError | null {
  const error = (code: WorkspaceErrorCode, message: string, currentVersion?: number): WorkspaceError => currentVersion === undefined
    ? { code, message, retryable: false, operationId: command.operationId }
    : { code, message, retryable: false, operationId: command.operationId, currentVersion }
  const workspace = context.workspace
  if (command.target.workspaceId !== workspace.workspaceId) return error("forbidden", "Command workspace is not authorized.")
  if (!context.capabilities.actions[command.action]?.available) return error("capability-unavailable", "This action has not been advertised as available.")
  if ("sessionId" in command.target && command.target.sessionId !== null && (!context.session || context.session.sessionId !== command.target.sessionId || context.session.workspaceId !== workspace.workspaceId)) return error("forbidden", "Command session is not authorized in this workspace.")
  if (context.conflictingOperations?.some((operation) => operation.operationId !== command.operationId
    && !(command.action === "abandon-operation" && operation.operationId === command.target.operationId)
    && (operation.status === "unknown" || operation.status === "pending")
    && operation.target.workspaceId === command.target.workspaceId
    && (!("sessionId" in command.target) || !("sessionId" in operation.target) || operation.target.sessionId === command.target.sessionId))) return error("operation-conflict", "An unresolved operation locks this write target.")
  if ("expectedWorkspaceVersion" in command && command.expectedWorkspaceVersion !== workspace.version) return error("version-conflict", "Workspace version changed.", workspace.version)
  if (command.action === "send" || command.action === "steer" || command.action === "interrupt") {
    const active = context.run && ["queued", "running", "waiting", "unknown"].includes(context.run.status) ? context.run : undefined
    if (active && active.sessionId !== command.target.sessionId) return error("forbidden", "Active run belongs to another session.")
    if (command.action === "send" && active) return error(active.status === "unknown" ? "unknown-outcome" : "busy", "Ordinary send never queues behind an unresolved active turn.")
    if (command.action !== "send" && (!active || active.turnId !== command.expectedTurnId || active.status === "unknown")) return error("turn-conflict", "The expected active turn is no longer controllable.")
    if (active && context.session && (active.source.adapter !== context.session.source.adapter
      || active.source.engineIdentity !== context.session.source.engineIdentity || active.source.threadId !== context.session.source.threadId
      || active.source.epoch !== context.session.source.epoch)) return error("turn-conflict", "Active turn belongs to a different source generation.")
    if (command.action !== "interrupt") {
      const draft = context.draft
      if (!draft || draft.draftId !== command.draftId || draft.sessionId !== command.target.sessionId || draft.workspaceId !== workspace.workspaceId) return error("forbidden", "Submitted draft does not belong to this session.")
      if (draft.version !== command.draftVersion || draft.text !== command.input.text || JSON.stringify(draft.attachments) !== JSON.stringify(command.input.attachments) || JSON.stringify(draft.context) !== JSON.stringify(command.input.context)) return error("version-conflict", "Submitted draft content/version does not match the saved draft.", draft.version)
      for (const attachment of command.input.attachments) {
        const invalid = validateResourceReference(attachment, context.resources, workspace.workspaceId, command.target.sessionId)
        if (invalid) return invalid
        const resource = context.resources.find((value) => value.resourceId === attachment.resourceId)
        if (resource?.kind !== "attachment" || resource.attachmentState !== "engine-readable") return error("resource-unavailable", "A selected or uploaded attachment is not yet engine-readable.")
      }
      for (const selection of command.input.context) {
        if (selection.kind === "resource") {
          const invalid = validateResourceReference(selection.reference, context.resources, workspace.workspaceId, command.target.sessionId)
          if (invalid) return invalid
        } else {
          const skill = context.skills.find((value) => value.skillId === selection.skillId)
          if (!skill || !skill.loaded) return error("resource-unavailable", "Selected skill is not loaded by this runtime.")
          if (skill.version !== selection.version || skill.contentHash !== selection.contentHash) return error("resource-version-conflict", "Selected skill version changed.", skill.version)
        }
      }
    }
  }
  switch (command.action) {
    case "rename": case "archive":
      if (command.expectedVersion !== context.session?.version) return error("version-conflict", "Session version changed.", context.session?.version)
      break
    case "approval":
      if (!context.approval || !context.session || !context.run || context.run.runId !== command.target.runId
        || context.run.turnId !== command.expectedTurnId || context.run.status !== "waiting"
        || context.approval.source.epoch !== context.session.source.epoch
        || context.approval.source.threadId !== context.session.source.threadId
        || context.approval.source.engineIdentity !== context.session.source.engineIdentity
        || context.approval.source.adapter !== context.session.source.adapter) return error("approval-expired", "Approval source epoch and active turn are no longer answerable.")
      return validateApprovalDecision(command, context.approval, context.capabilities)
    case "answer":
      if (!context.question || !context.session || !context.run || context.run.runId !== command.target.runId
        || context.run.turnId !== command.expectedTurnId || context.run.status !== "waiting"
        || context.question.source.epoch !== context.session.source.epoch
        || context.question.source.threadId !== context.session.source.threadId
        || context.question.source.engineIdentity !== context.session.source.engineIdentity
        || context.question.source.adapter !== context.session.source.adapter) return error("approval-expired", "Question source epoch and active turn are no longer answerable.")
      return validateQuestionAnswer(command, context.question)
    case "save-draft": case "upload-attachment": {
      const draft = context.draft
      const expected = command.action === "save-draft" ? command.expectedVersion : command.expectedDraftVersion
      if (!draft && (command.action !== "save-draft" || expected !== 0)) return error("version-conflict", "Draft does not exist at the expected version.")
      if (draft && (draft.draftId !== command.target.draftId || draft.sessionId !== command.target.sessionId || draft.workspaceId !== workspace.workspaceId)) return error("forbidden", "Draft target is not authorized.")
      if (draft && draft.version !== expected) return error("version-conflict", "Draft version changed.", draft.version)
      if (command.action === "save-draft") for (const reference of command.attachments) {
        const invalid = validateResourceReference(reference, context.resources, workspace.workspaceId, command.target.sessionId)
        if (invalid) return invalid
      }
      if (command.action === "save-draft") for (const selection of command.context) {
        if (selection.kind === "resource") {
          const invalid = validateResourceReference(selection.reference, context.resources, workspace.workspaceId, command.target.sessionId)
          if (invalid) return invalid
        } else if (!context.skills.some(skill => skill.skillId === selection.skillId && skill.version === selection.version && skill.contentHash === selection.contentHash && skill.loaded)) return error("resource-unavailable", "The exact selected skill is not source-loaded.")
      }
      break
    }
    case "delete-attachment": {
      const resource = context.resources.find((value) => value.resourceId === command.target.resourceId)
      if (!resource || resource.workspaceId !== workspace.workspaceId || resource.kind !== "attachment") return error("forbidden", "Attachment target is not authorized.")
      if (resource.version !== command.expectedVersion) return error("version-conflict", "Attachment version changed.", resource.version)
      break
    }
    case "update-settings": {
      if (!context.settings || context.settings.version !== command.expectedVersion) return error("version-conflict", "Settings version changed.", context.settings?.version)
      const model = context.capabilities.models.find((value) => value.modelId === command.modelId)
      if (!model || (command.reasoningLevel !== null && !model.reasoningLevels.includes(command.reasoningLevel))) return error("capability-unavailable", "Model/reasoning level was not advertised.")
      if (!context.capabilities.permissionProfiles?.some((profile) => profile.profileId === command.permissionProfileId && profile.availability.available)) return error("capability-unavailable", "Permission profile was not advertised as available.")
      if (command.toolConnectionIds.some((id) => !context.capabilities.toolConnections?.some((connection) => connection.connectionId === id && connection.availability.available))) return error("capability-unavailable", "Tool connection was not advertised as available.")
      if (command.skillIds.some((id) => !context.skills.some((skill) => skill.skillId === id && skill.loaded))) return error("resource-unavailable", "Selected skill is not loaded by the runtime.")
      break
    }
    case "terminate-terminal":
      if (!context.terminal || context.terminal.terminalId !== command.target.terminalId || context.terminal.workspaceId !== workspace.workspaceId || context.terminal.generation !== command.expectedGeneration) return error("version-conflict", "Terminal generation changed.")
      break
    case "update-skill": {
      const skill = context.skills.find((value) => value.skillId === command.target.skillId)
      if (!skill) return error("forbidden", "Skill is not authorized.")
      if (skill.version !== command.expectedVersion || skill.contentHash !== command.expectedContentHash) return error("version-conflict", "Skill content changed.", skill.version)
      break
    }
    case "remove-worktree": {
      const worktree = context.worktreeState
      if (workspace.worktreeId !== command.worktreeId || !worktree?.hostCreated) return error("worktree-not-owned", "Only the Host-created worktree may be removed.")
      if (worktree.dirty) return error("worktree-dirty", "Worktree contains changes that must be preserved.")
      if (worktree.activeRuns || worktree.activeTerminals || worktree.unknownRuns) return error("workspace-locked", "Worktree has active or unknown processes.")
      break
    }
    case "abandon-operation":
      if (!context.operation || context.operation.operationId !== command.target.operationId || context.operation.version !== command.expectedVersion || context.operation.status !== "unknown") return error("operation-conflict", "Only the exact unknown operation can be explicitly abandoned.")
      break
  }
  return null
}
