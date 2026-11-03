import { useState } from "react";
import { Code2, MessageSquare, Upload, Workflow } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { studioNativeTemplateIdSchema, studioNativeTemplateRequiresProvider, studioProviderOptionsSchema, type StudioCapabilities, type StudioConfig } from "../../../../../../../../packages/contracts/src/automation-studio";
import { automationTemplateBundle, type AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog";
import { isPmAutomationTemplateId } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { parseStudioObject, type StudioFormValues } from "./studio-setup";
import { StudioSetupField as Field } from "./studio-setup-field";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select"

type Props = { action: StudioConfig["action"]; template?: AutomationCatalogTemplate; values: StudioFormValues; capabilities: StudioCapabilities | null; issues: Record<string, string>; optionsText: string; canWrite: boolean; disabled: boolean; onOptions: (text: string) => void; onChange: (patch: Partial<StudioConfig["action"]>) => void; onKindChange: (action: StudioConfig["action"]) => void; onUpload: (file: File) => void; onInvalidOptions: () => void };
/** Source Python is immutable provenance. Selecting native Template never executes or silently ignores Python text. */
export function StudioSetupAction({ action, template, values, capabilities, issues, optionsText, canWrite, disabled, onOptions, onChange, onKindChange, onUpload, onInvalidOptions }: Props) {
  const t = useAgentText();
  const [sourceFiles, setSourceFiles] = useState<Record<string, string> | null>(null);
  const [sourceError, setSourceError] = useState("");
  const selectedProvider = action.kind !== "script" ? capabilities?.providers.find(provider => provider.id === action.providerInstanceId) : undefined;
  const nativeId = studioNativeTemplateIdSchema.safeParse(template?.id);
  const pmNative = nativeId.success && isPmAutomationTemplateId(nativeId.data);
  const kinds = pmNative ? ["template"] as const : nativeId.success ? ["template", "prompt", "script"] as const : ["prompt", "script"] as const;
  const requiresProvider = action.kind === "prompt" || (action.kind === "template" && studioNativeTemplateRequiresProvider(action.templateId));
  function selectKind(kind: StudioConfig["action"]["kind"]) {
    if (kind === action.kind) return;
    const common = { repositories: action.repositories, plugins: action.plugins, timeoutSeconds: action.timeoutSeconds };
    if (kind === "script") onKindChange({ kind, ...common, content: "", files: [], entrypoint: "python3 main.py", setup: "", bundleRef: null });
    else {
      const model = action.kind === "script" ? { providerInstanceId: "", model: "", options: {} } : { providerInstanceId: action.providerInstanceId ?? "", model: action.model ?? "", options: action.options };
      if (kind === "template" && nativeId.success) onKindChange({ kind, ...common, ...(studioNativeTemplateRequiresProvider(nativeId.data) ? model : { providerInstanceId: null, model: null, options: {} }), templateId: nativeId.data, arguments: { ...values } });
      else onKindChange({ kind: "prompt", ...common, ...model, prompt: "" });
    }
  }
  return <>
    <div className={styles.modeTabs}>{kinds.map(kind => <button type="button" key={kind} disabled={disabled} aria-pressed={action.kind === kind} onClick={() => selectKind(kind)}>{kind === "template" ? <Workflow size={14} /> : kind === "prompt" ? <MessageSquare size={14} /> : <Code2 size={14} />}{kind === "template" ? t("原生模板工作流", "Native template workflow") : kind === "prompt" ? "Prompt" : "Custom Python / tarball"}</button>)}</div>
    {action.kind === "template" && <div className={styles.notice}><strong>{t("原生 PM 工作流", "Native PM workflow")}: {action.templateId}</strong><p>{pmNative ? t("范围、时间窗口、阈值及来源参数冻结在当前版本中。分析强制只读，不执行 Python，也不允许模型自行写入 PM。发现、证据、覆盖缺口和候选独立持久化；仅在运行详情预览并确认后才能应用候选。", "Scope, time window, threshold and source parameters are frozen in this revision. Analysis is enforced read-only: no Python and no model PM writes. Findings, evidence, coverage gaps and candidates persist independently; candidates are applied only after preview and explicit confirmation in execution details.") : t("上述来源表单字段会冻结为原生工作流参数，模型调用走当前 Provider，外部访问走已验证的项目连接。不运行来源 OpenHands Python/全局 API。切换至 Custom Python 是不同的执行类型。", "The source form fields above are frozen as native workflow arguments. Models use the current Provider; external access uses verified project connections. This does not execute source OpenHands Python or global APIs. Switching to Custom Python selects a different execution type.")}</p></div>}
    {action.kind === "prompt" && <Field label="Prompt" issue={issues["action.prompt"]}>{id => <textarea id={id} rows={10} maxLength={200000} value={action.prompt} onChange={event => onChange({ prompt: event.target.value })} />}</Field>}
    {action.kind === "template" && !requiresProvider && <Field label={t("Provider / 模型", "Provider / model")}>{id => <Input id={id} readOnly value={t("None — 确定性工作流，不调用模型", "None — deterministic workflow, no model invocation")} />}</Field>}
    {action.kind !== "script" && requiresProvider && <>
      <div className={styles.twoColumns}><Field label="Provider" issue={issues["action.providerInstanceId"]}>{id => <RadixSelect id={id} value={action.providerInstanceId ?? ""} onChange={event => onChange({ providerInstanceId: event.target.value, model: "" })}><option value="">{t("选择已配置 Provider", "Select a configured Provider")}</option>{capabilities?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</RadixSelect>}</Field>
      <Field label={t("模型", "Model")} issue={issues["action.model"]}>{id => <RadixSelect id={id} value={action.model ?? ""} onChange={event => onChange({ model: event.target.value })}><option value="">{t("选择真实模型", "Select an available model")}</option>{selectedProvider?.models.map(model => <option key={model} value={model}>{model}</option>)}</RadixSelect>}</Field></div>
      {!capabilities?.providers.length && <p className={styles.dependency}>{t("当前项目未返回可用 Provider/模型；没有静态模型降级列表。", "No Provider/model choices were returned for this project. There is no static fallback model list.")}</p>}
      <Field label={t("模型选项 JSON", "Model options JSON")} help={t("仅实际 Provider 模型选项（字符串或布尔值），不要填写凭据。", "Only actual Provider model options (strings or booleans); never credentials.")} issue={issues["action.options"]}>{id => <textarea id={id} rows={3} value={optionsText} onChange={event => { onOptions(event.target.value); try { onChange({ options: studioProviderOptionsSchema.parse(parseStudioObject(event.target.value)) }); } catch { onInvalidOptions(); } }} />}</Field>
    </>}
    {action.kind === "script" && <>
      <Field label={t("Python 源码（main.py）", "Python source (main.py)")} issue={issues["action.content"]}>{id => <textarea id={id} className={styles.codeInput} rows={12} value={action.content} onChange={event => onChange({ content: event.target.value, files: [], bundleRef: null })} />}</Field>
      <Field label={t("上传 .tar / .tar.gz", "Upload .tar / .tar.gz")} help={t("上传真实持久化；最大 2 MiB，拒绝路径越界、链接、非 UTF-8、超过 200 文件或展开 2 MiB。", "Uploads persist on the server. Maximum 2 MiB; traversal, links, non-UTF-8, more than 200 files, or over 2 MiB expanded are rejected.")}>{id => <input id={id} type="file" accept=".tar,.tar.gz,.tgz" disabled={!canWrite || disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />}</Field>
      <div className={styles.twoColumns}><Field label={t("入口命令", "Entrypoint")} issue={issues["action.entrypoint"]}>{id => <Input id={id} value={action.entrypoint} onChange={event => onChange({ entrypoint: event.target.value })} />}</Field><Field label={t("Setup 脚本或包内路径", "Setup script or bundled path")} issue={issues["action.setup"]}>{id => <textarea id={id} rows={2} value={action.setup} onChange={event => onChange({ setup: event.target.value })} />}</Field></div>
      {action.files.length > 0 && <details><summary><Upload size={14} /> {action.files.length} {t("个冻结文件", "frozen files")} · {action.bundleRef}</summary>{action.files.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</details>}
    </>}
    {template?.setup?.bundle && <details onToggle={event => { if (!event.currentTarget.open || sourceFiles) return; void automationTemplateBundle(template.id).then(setSourceFiles, reason => setSourceError(String(reason))); }}>
      <summary>{t("来源 Python bundle（只读溯源，不执行）", "Source Python bundle (read-only provenance, not executed)")}</summary>
      <p>{t("来源 bundle 可能依赖外部网络、OpenHands SDK 及会话/状态协议；原生模板不运行这些脚本。", "Source bundles may depend on external network, OpenHands SDK, and conversation/state protocols. Native templates do not execute these scripts.")}</p>
      {sourceError && <p className={styles.error}>{sourceError}</p>}
      {sourceFiles && Object.entries(sourceFiles).map(([path, content]) => <details key={path}><summary>{path}</summary><pre>{content}</pre></details>)}
      <Button type="button" variant="ghost" disabled={!sourceFiles} onClick={() => {
        if (!sourceFiles) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ templateId: template.id, files: sourceFiles }, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${template.id}.source-bundle.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }}>{t("下载来源文件（不是 PM 可导入定义）", "Download source files (not a PM import definition)")}</Button>
    </details>}
  </>;
}
