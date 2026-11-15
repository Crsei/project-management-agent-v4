import type { DocumentsFilesToolResult, DocumentsFilesArtifactVersion } from "../../../../../../../packages/agent-contracts/src/pm-tool-documents-files";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmObjectLink, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmDocumentsFilesResult({ result, workspaceId }: { result: DocumentsFilesToolResult; workspaceId: string | null }) {
  const t = useAgentText();
  switch (result.kind) {
    case "document-sources":
      return <><PmResultData value={{ scopes: result.scopes, sources: result.items }} />{!result.items.length && <PmEmptyResult>{t("这一页没有可见的来源关联；范围和关联 revision 仍如上所示。", "This page has no visible source associations; scope and association revisions are shown above.")}</PmEmptyResult>}</>;
    case "external-files":
      return <><PmResultData value={{ sourceId: result.sourceId, sourceRevision: result.sourceRevision, scanComplete: result.scanComplete, issues: result.issues, files: result.items }} />{!result.scanComplete && <p role="status">{t("来源扫描不完整，不能据此断言目录为空。", "The source scan is incomplete; this cannot establish that the directory is empty.")}</p>}{!result.items.length && <PmEmptyResult />}</>;
    case "external-file":
      return <><p>sourceId: <code>{result.sourceId}</code></p>{result.items.map(file => <article key={file.path}><PmExternalContent file={file} /></article>)}{!result.items.length && <PmEmptyResult>{t("本结果未包含可见文件正文；不是空文件。", "No visible file payload is included; this is not an empty file.")}</PmEmptyResult>}</>;
    case "external-file-operation":
      return <><p>sourceId: <code>{result.sourceId}</code></p>{result.items.map(operation => <article key={operation.operationId}><PmResultData value={{ operationId: operation.operationId, action: operation.action, status: operation.status, path: operation.path, targetSourceId: operation.targetSourceId, targetPath: operation.targetPath, message: operation.message }} />{operation.status !== "succeeded" && <p role="status">{operation.status === "unknown" ? t("文件业务效果未知；只核对原操作，不重新发送，也不宣称回滚。", "The file effect is unknown; reconcile only the original operation, without resending or claiming rollback.") : t("原文件操作确认未应用。", "The original file operation is confirmed not applied.")}</p>}{operation.content && <PmExternalContent file={operation.content} />}</article>)}{!result.items.length && <PmEmptyResult>{t("原操作结果尚未提供；不能推断文件修改成功。", "The original operation result is not provided; file mutation success cannot be inferred.")}</PmEmptyResult>}</>;
    case "uploads":
      return <><PmResultData value={result.items} />{!result.items.length && <PmEmptyResult />}</>;
    case "artifacts":
      return <><PmResultData value={result.items} />{result.items.slice(0, 20).map(item => <p key={item.id}><PmProjectFiles workspaceId={workspaceId} projectId={item.projectId} /></p>)}{!result.items.length && <PmEmptyResult />}</>;
    case "artifact-versions":
      return <><PmResultData value={result.items} /><PmVersionDownloads versions={result.items} />{!result.items.length && <PmEmptyResult />}</>;
    case "artifact-mutation":
      return <><PmResultData value={{ artifacts: result.artifacts, versions: result.versions }} /><PmVersionDownloads versions={result.versions} />{!result.artifacts.length && !result.versions.length && <p>{t("原操作未附带当前附件正文；业务事实以原收据为准。", "The original operation contains no current artifact payload; inspect its original receipt for the business fact.")}</p>}</>;
    case "artifact-copy-origin":
      return <><p>artifactVersionId: <code>{result.artifactVersionId}</code></p>{result.origin ? <PmResultData value={result.origin} /> : <p role="status">{t("来源未提供或已隐藏；不能据此断言没有复制来源。", "Copy origin is absent or redacted; this does not prove that no copy origin exists.")}</p>}</>;
    default: return unsupportedPmResult(result);
  }
}

function PmExternalContent({ file }: { file: Extract<DocumentsFilesToolResult, { kind: "external-file" }>["items"][number] }) {
  const t = useAgentText();
  return <><PmResultData value={{ path: file.path, revision: file.revision, sourceRevision: file.sourceRevision, size: file.size, modifiedAt: file.modifiedAt, canWrite: file.canWrite }} /><p>contentOffset: {file.contentOffset}</p><pre>{file.content}</pre>{file.nextContentOffset !== null && <p>{t("继续读取正文偏移（保持相同 revision）：", "Continue body offset (retain the same revision): ")}{file.nextContentOffset}</p>}</>;
}

function PmProjectFiles({ workspaceId, projectId }: { workspaceId: string | null; projectId: string }) {
  const t = useAgentText();
  return workspaceId ? <a href={`/pm/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files`}>{t("项目附件", "Project artifacts")} · {projectId}</a> : <PmObjectLink workspaceId={null} kind="project" id={projectId} />;
}

function PmVersionDownloads({ versions }: { versions: readonly DocumentsFilesArtifactVersion[] }) {
  const t = useAgentText();
  return <ul>{versions.slice(0, 20).map(version => {
    const expected = `/api/v1/workspaces/${encodeURIComponent(version.workspaceId)}/artifact-versions/${encodeURIComponent(version.id)}/content`;
    return <li key={version.id}>{version.downloadPath === expected ? <a href={expected}>{t("下载（仍需当前 PM 授权）：", "Download (current PM authorization required): ")}{version.fileName}</a> : <span>{t("下载引用不匹配，未生成链接。", "Download reference does not match; no link was created.")}</span>} · <code>{version.sha256}</code></li>;
  })}</ul>;
}
