import type { AutomationToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-automation";
import type { StudioConfig, StudioDefinition, StudioExecution } from "../../../../../../../packages/contracts/src/automation-studio";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmResultData, unsupportedPmResult, type PmDisplayData } from "./pm-tool-result-ui";

/** Select finite display fields; event filters, template inputs/arguments and historical selections are opaque. */
function configData(config: StudioConfig): PmDisplayData {
  const action = config.action;
  const trigger = config.trigger;
  return {
    name: config.name, description: config.description, projectId: config.projectId, tags: config.tags,
    templateId: config.templateId, templateVersion: config.templateVersion, quickAccess: config.quickAccess,
    dailyLimit: config.dailyLimit, cooldownMinutes: config.cooldownMinutes,
    trigger: trigger.kind === "event" ? { kind: trigger.kind, source: trigger.source, key: trigger.key, filter: "Opaque event filter is not rendered" } : trigger,
    action: {
      kind: action.kind, repositories: action.repositories, plugins: action.plugins, timeoutSeconds: action.timeoutSeconds,
      ...(action.kind === "script" ? { entrypoint: action.entrypoint, setup: action.setup, content: action.content, bundleRef: action.bundleRef, files: action.files }
        : { providerInstanceId: action.providerInstanceId, model: action.model, options: action.options, ...(action.kind === "prompt" ? { prompt: action.prompt } : { templateId: action.templateId, arguments: "Opaque template arguments are not rendered" }) }),
    },
  };
}
function definitionData(definition: StudioDefinition): PmDisplayData {
  return { id: definition.id, revision: definition.revision, status: definition.status, createdAt: definition.createdAt, updatedAt: definition.updatedAt, lastRunAt: definition.lastRunAt, nextDueAt: definition.nextDueAt, executionUnavailableReason: definition.executionUnavailableReason, config: configData(definition.config) };
}
function executionData(execution: StudioExecution): PmDisplayData {
  return { id: execution.id, definitionId: execution.definitionId, definitionRevision: execution.definitionRevision, requestId: execution.requestId, status: execution.status, trigger: execution.trigger, createdAt: execution.createdAt, startedAt: execution.startedAt, finishedAt: execution.finishedAt, threadId: execution.threadId, externalExecutionId: execution.externalExecutionId, executionUnavailableReason: execution.executionUnavailableReason, summary: execution.summary, error: execution.error, configSnapshot: configData(execution.configSnapshot) };
}

export function PmAutomationResult({ result }: { result: AutomationToolResult }) {
  const t = useAgentText();
  switch (result.kind) {
    case "automation_capabilities": return <PmResultData value={result.capabilities} />;
    case "automation_templates": return <>{!result.templates.length && <PmEmptyResult />}<PmResultData value={result.templates} /></>;
    case "automation_timezones": return <>{!result.timezones.length && <PmEmptyResult />}<PmResultData value={result.timezones} /></>;
    case "automation_validation": return <><h4>{t("验证（不保存、不执行）", "Validation (no save or execution)")}</h4><PmResultData value={result.validation} /></>;
    case "automation_definitions": return <>{!result.definitions.length && <PmEmptyResult />}<PmResultData value={result.definitions.slice(0, 20).map(definitionData)} />{result.definitions.length > 20 && <p role="status">{t("卡片仅展示本页前 20 个定义；这不是完整页。", "The card shows only the first 20 definitions of this page; this is not the full page.")}</p>}</>;
    case "automation_definition": return <><p>{t("定义保存与实际执行是不同事实。", "Saving a definition and executing it are separate facts.")}</p><PmResultData value={definitionData(result.definition)} /></>;
    case "automation_deleted": return <p>{t("原定义已删除；这不取消原执行，也不删除执行收据。", "The original definition was deleted; this does not cancel prior executions or delete their receipts.")}</p>;
    case "automation_executions": return <>{!result.executions.length && <PmEmptyResult />}<PmExecutionNotice /><PmResultData value={result.executions.slice(0, 20).map(executionData)} />{result.executions.length > 20 && <p role="status">{t("卡片仅展示本页前 20 次执行；这不是完整页。", "The card shows only the first 20 executions of this page; this is not the full page.")}</p>}</>;
    case "automation_execution": return <><PmExecutionNotice /><PmResultData value={executionData(result.execution)} /></>;
    case "automation_logs": return <>{!result.logs.length && <PmEmptyResult />}<PmResultData value={result.logs} /></>;
    case "automation_studio_receipt": {
      const original = result.original;
      const payload = original.result;
      return <><h4>{t("原 Studio 请求收据", "Original Studio request receipt")}</h4><PmResultData value={{ requestId: original.requestId, httpStatus: original.httpStatus, result: "config" in payload ? definitionData(payload) : "definitionId" in payload ? executionData(payload) : payload }} /><PmExecutionNotice /></>;
    }
    case "automation_snapshot": {
      const snapshot = result.snapshot;
      return <><h4>{t("冻结的授权来源快照", "Frozen authorized source snapshot")}</h4><PmResultData value={{ executionId: snapshot.executionId, templateId: snapshot.templateId, workspaceId: snapshot.workspaceId, projectId: snapshot.projectId, observedAt: snapshot.observedAt, timeWindow: snapshot.timeWindow, counts: { tasks: snapshot.tasks.length, documents: snapshot.documents.length, relationships: snapshot.relationships.length, comments: snapshot.comments.length, activities: snapshot.activities.length, sessions: snapshot.sessions.length, executions: snapshot.executions.length, pullRequests: snapshot.pullRequests.length, milestones: snapshot.milestones.length }, coverage: snapshot.coverage, sources: snapshot.sources }} /><p>{t("这是快照索引与有界来源，不是完整来源正文；partial/unavailable 不表示没有相关数据。", "This is a snapshot index with bounded source references, not complete source bodies; partial / unavailable does not mean no relevant data exists.")}</p></>;
    }
    case "automation_result": return <><h4>{t("发现与待审候选（不自动应用）", "Findings and review candidates (not automatically applied)")}</h4><PmResultData value={result.result} /></>;
    case "automation_preview": return <><h4>{t("候选预览（不应用）", "Candidate preview (not applied)")}</h4><PmResultData value={result.preview} /></>;
    case "automation_review_receipt": return <><h4>{t("原候选审阅收据", "Original candidate review receipt")}</h4><PmResultData value={result.original} /><p>{t("edited/ignored/conflict/outcome_unknown 不是 applied；预览不修改业务对象。", "Edited / ignored / conflict / outcome_unknown are not applied; preview does not mutate business objects.")}</p></>;
    case "automation_transfer_preview": return <><h4>{t("导入预览（不保存）", "Import preview (not saved)")}</h4><PmResultData value={{ format: result.preview.format, warnings: result.preview.warnings, validation: result.preview.validation, config: configData(result.preview.config) }} /></>;
    case "automation_import_receipt": return <PmResultData value={{ requestId: result.original.requestId, status: result.original.status, error: result.original.error, definition: result.original.definition ? definitionData(result.original.definition) : null }} />;
    case "automation_export": return <PmResultData value={{ filename: result.exported.filename, limits: result.exported.limits, document: result.exported.document.kind === "pm-automation-bundle" ? { kind: result.exported.document.kind, version: result.exported.document.version, spec: configData(result.exported.document.spec) } : result.exported.document }} />;
    case "automation_bundle": return <><PmResultData value={result.bundle} /><p>{t("上传文件仅作为有界文本展示，不执行脚本，也不生成宿主文件链接。", "Uploaded files are bounded text only; scripts are not executed and no host file links are created.")}</p></>;
    case "automation_git_status": return <PmResultData value={result.status} />;
    case "automation_git_operation": return <><PmResultData value={result.operation} /><PmExecutionNotice /></>;
    case "automation_git_receipt": return <PmResultData value={result.original} />;
    case "automation_git_check": return <><PmResultData value={result.check} /><p>{t("可读不证明可推送或可解密。", "Readability does not establish push permission or decryptability.")}</p></>;
    default: return unsupportedPmResult(result);
  }
}

function PmExecutionNotice() {
  const t = useAgentText();
  return <p role="status">{t("queued/running/cancel_requested/outcome_unknown 保留原执行状态；执行完成不表示 PM 任务 Done，取消请求不表示已取消。", "Queued / running / cancel_requested / outcome_unknown retain their original execution states; execution completion is not PM task Done, and a cancellation request is not confirmed cancellation.")}</p>;
}
