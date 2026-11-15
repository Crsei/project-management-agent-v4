import type { IntegrationsToolResult } from "../../../../../../../packages/agent-contracts/src/pm-tool-integrations";
import { useAgentText } from "../i18n";
import { PmEmptyResult, PmResultData, unsupportedPmResult } from "./pm-tool-result-ui";

export function PmIntegrationsResult({ result }: { result: IntegrationsToolResult }) {
  const t = useAgentText();
  switch (result.kind) {
    case "integration_connections":
      return <><PmResultData value={{ privateStorageAvailable: result.privateStorageAvailable, connections: result.items }} />{!result.privateStorageAvailable && <p role="status">{t("私有存储不可用，不能据此认为没有配置。", "Private storage is unavailable; this does not mean there is no configuration.")}</p>}{!result.items.length && <PmEmptyResult />}<PmIntegrationNotice /></>;
    case "integration_definitions":
      return <><PmResultData value={{ contextId: result.contextId, definitions: result.items }} />{!result.items.length && <PmEmptyResult />}<PmIntegrationNotice /></>;
    case "integration_receipt":
      return <><h4>{t("原集成请求收据", "Original integration request receipt")}</h4><PmResultData value={{ requestId: result.requestId, httpStatus: result.httpStatus, outcome: result.outcome, errorCode: result.errorCode, connection: result.connection, endpoint: result.endpoint }} /><PmIntegrationNotice /></>;
    case "integration_operation":
      return <><PmResultData value={result.operation} /><p>{t("仅展示原操作元数据；resultAvailable 不包含外部正文，也不是任务成功证据。", "Only original operation metadata is shown; resultAvailable does not include external payloads and is not evidence of task success.")}</p></>;
    case "event_endpoints": case "event_receipts": case "webhook_deliveries":
      return <>{!result.items.length && <PmEmptyResult />}<PmResultData value={result.items} /><PmIntegrationNotice /></>;
    case "webhook_overview":
      return <><PmResultData value={{ configuration: result.configuration, configurationDigest: result.configurationDigest, restoreFenced: result.restoreFenced, loopHealthy: result.loopHealthy, loopCycleAt: result.loopCycleAt, targets: result.targets, endpoints: result.endpoints }} />{result.nextTargetKey && <p>{t("目标目录下一游标（独立于端点游标）：", "Next target-directory cursor (independent of endpoint cursor): ")}<code>{result.nextTargetKey}</code></p>}{result.configuration !== "configured" && <p role="status">{t("Webhook 配置未就绪，不可当作空的已启用配置。", "Webhook configuration is not ready; this is not an empty enabled configuration.")}</p>}<PmIntegrationNotice /></>;
    case "webhook_delivery":
      return <><PmResultData value={result.delivery} />{result.nextAttemptNo !== null && <p>{t("下一尝试编号：", "Next attempt number: ")}{result.nextAttemptNo}</p>}{result.nextReceiptId && <p>{t("下一接收方收据游标：", "Next receiver receipt cursor: ")}<code>{result.nextReceiptId}</code></p>}<p>{t("尝试和接收方收据分别分页；unknown 不表示被接收方拒绝，也不允许自动重发。", "Attempts and receiver receipts paginate independently; unknown is not receiver rejection and does not authorize automatic resend.")}</p><PmIntegrationNotice /></>;
    case "webhook_action":
      return <><p><code>{result.action}</code></p><PmResultData value={result.result} /><p>{t("此结果表示原端点／投递管理动作；不证明事件已送达或任务完成。", "This is the original endpoint / delivery management action; it does not prove event delivery or task completion.")}</p></>;
    case "im_settings":
      return <><PmResultData value={{ configuration: result.configuration, connectivity: result.connectivity, bindings: result.bindings }} /><PmIntegrationNotice /></>;
    case "im_binding":
      return <><PmResultData value={{ revoked: result.revoked, binding: result.binding }} />{!result.binding && <p>{t("未提供当前绑定正文；不能由此推断通知已经送达。", "No current binding payload was provided; notification delivery cannot be inferred.")}</p>}<PmIntegrationNotice /></>;
    default: return unsupportedPmResult(result);
  }
}

function PmIntegrationNotice() {
  const t = useAgentText();
  return <p>{t("配置、验证、执行与接收方接受是不同事实；这些状态都不代表 PM 任务 Done。", "Configuration, verification, execution and receiver acceptance are separate facts; none means a PM task is Done.")}</p>;
}
