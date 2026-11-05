import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, FlaskConical, MessageSquare, Save, Sparkles } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { Entity } from "../../../../../../../../packages/contracts/src/client";
import { studioConfigSchema, studioDefinitionSchema, studioExecutionSchema, studioNativeTemplateIdSchema, studioNativeTemplateRequiresProvider, studioProviderOptionsSchema, type StudioCapabilities, type StudioConfig, type StudioDefinition, type StudioExecution, type StudioValidation } from "../../../../../../../../packages/contracts/src/automation-studio";
import { StudioApiError, StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { AutomationTransferClient } from "../../../../../../../../packages/contracts/src/automation-transfer-client";
import { AUTOMATION_TRANSFER_LIMITS, type AutomationBundleUpload } from "../../../../../../../../packages/contracts/src/automation-transfer";
import { automationCatalogById, automationCatalogSource, automationTemplateLaunchPrompt, automationTemplateTags } from "../../../../../../../../packages/automation-resources/catalog";
import type { AutomationCatalogField } from "../../../../../../../../packages/contracts/src/automation-catalog";
import { automationIntegrationPlugin } from "../../../../../../../../packages/contracts/src/automation-integrations";
import { validateNativeTemplateArguments } from "../../../../../../../../packages/automation-resources/native-template-arguments";
import { isPmAutomationTemplateId } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { studioPrerequisites, useStudioConnections } from "./studio-setup-dependencies";
import { applyStudioAssistantPatch, clearStudioRecovery, cronEditorClock, cronFor, emptyStudioConfig, frequencyOf, interpolateStudioExpression, interpolateStudioTemplate, localTimeInZone, normalizeStudioTemplateValues, onceInZone, parseStudioObject, readStudioDraft, redactStudioRecovery, serializeStudioDraft, settleStudioPriorRequest, studioConnectionSupportsAction, studioDraftKey, studioFieldIssue, studioPendingFromPriorMembership, studioProviderToolReadiness, templateDefaults, type StudioDraftState, type StudioFormValues, type StudioFrequency, type StudioPending } from "./studio-setup";
import { StudioSetupField as Field } from "./studio-setup-field";
import { StudioSetupAction } from "./studio-setup-action";
import { StudioPmParameters } from "./studio-pm-parameters";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select"

export type StudioAssistRequest = { prompt: string; projectId: string; definitionId?: string; draftId?: string; templateId?: string; config?: StudioConfig; onApply?: (patch: Partial<StudioConfig>) => void };
export type StudioAssistCallback = (request: StudioAssistRequest) => void | Promise<void>;
type Props = { workspaceId: string; actorId: string; membershipVersion: number; projectId?: string; draftId?: string; projects: Entity[]; definition?: StudioDefinition | null; templateId?: string | null; writable: boolean; onSaved: (definition: StudioDefinition) => void; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void; onExecution?: (execution: StudioExecution) => void; onAssist?: StudioAssistCallback; onIntegrations?: () => void; onAccessLost?: () => void };
export function StudioEditor(props: Props) {
  const { workspaceId, actorId, membershipVersion, projects, writable, onSaved, onCancel, onDirtyChange, onExecution, onAssist, onIntegrations } = props;
  const t = useAgentText();
  const template = automationCatalogById.get(props.templateId ?? props.definition?.config.templateId ?? (props.definition?.config.action.kind === "template" ? props.definition.config.action.templateId : ""));
  const mode = template?.setup?.mode ?? (template ? "launch" : "direct");
  const editorId = props.definition?.id ?? props.draftId ?? `new:${template?.id ?? "blank"}:${props.projectId ?? ""}`;
  const key = studioDraftKey(actorId, workspaceId, membershipVersion, editorId);
  const api = useMemo(() => new StudioClient(workspaceId), [workspaceId]);
  const transfer = useMemo(() => new AutomationTransferClient(workspaceId), [workspaceId]);
  const [initial] = useState(() => {
    let config = props.definition?.config ?? emptyStudioConfig(props.projectId);
    if (!props.definition && template) {
      config = { ...config, name: template.name, description: template.description, templateId: template.id };
      const cron = template.setup?.form.triggers?.cron;
      const event = template.setup?.form.triggers?.event;
      if (template.setup?.native) config.trigger = { kind: "manual" };
      else if (cron) config.trigger = { kind: "cron", expression: String(cron.schedule?.default ?? "0 9 * * *"), timezone: String(cron.timezone?.default ?? "UTC") };
      else if (event) config.trigger = { kind: "event", source: String(event.source?.default ?? "github"), key: String(event.on?.default ?? ""), filter: {} };
      const nativeTemplate = studioNativeTemplateIdSchema.safeParse(template.id);
      if (nativeTemplate.success) {
        const templateId = nativeTemplate.data;
        const requiresProvider = studioNativeTemplateRequiresProvider(templateId);
        config.action = { kind: "template", templateId, arguments: templateDefaults(template), providerInstanceId: requiresProvider ? "" : null, model: requiresProvider ? "" : null, options: {}, repositories: [], plugins: [], timeoutSeconds: template.setup?.bundle?.timeout ?? 600 };
      }
    }
    const fresh: StudioDraftState = { version: 1, config, baseline: config, definition: props.definition ?? null, values: { ...templateDefaults(template), ...(config.action.kind === "template" ? config.action.arguments as StudioFormValues : {}), ...config.templateInputs as StudioFormValues }, touched: [], pending: null, test: null, testPayload: "{}" };
    try { return { state: readStudioDraft(key) ?? { ...fresh, pending: studioPendingFromPriorMembership(actorId, workspaceId, membershipVersion, editorId) }, error: "" }; } catch (reason) { return { state: fresh, error: reason instanceof Error ? reason.message : "Cannot read recovery storage" }; }
  });
  const [state, setState] = useState(initial.state);
  const live = useRef(state);
  live.current = state;
  const [storageError, setStorageError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const recoveryFinished = useRef(false);
  const accessLost = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<StudioValidation | null>(null);
  const [latest, setLatest] = useState<StudioDefinition | null>(null);
  const [capabilities, setCapabilities] = useState<StudioCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityVersion, setCapabilityVersion] = useState(0);
  const [stage, setStage] = useState<"prerequisites" | "form" | "review">(template && !props.definition ? "prerequisites" : "form");
  const [frequency, setFrequency] = useState<StudioFrequency>(() => frequencyOf(initial.state.config.trigger));
  const initialTrigger = initial.state.config.trigger;
  const [time, setTime] = useState(initial.state.recovery?.time ?? (initialTrigger.kind === "cron" ? cronEditorClock(initialTrigger.expression).time : "09:00"));
  const [weekday, setWeekday] = useState(initial.state.recovery?.weekday ?? (initialTrigger.kind === "cron" ? cronEditorClock(initialTrigger.expression).weekday : "1"));
  const [once, setOnce] = useState(initial.state.recovery?.once ?? (initialTrigger.kind === "once" ? localTimeInZone(initialTrigger.at, initialTrigger.timezone) : ""));
  const [filterText, setFilterText] = useState(initial.state.recovery?.filterText ?? (initialTrigger.kind === "event" ? JSON.stringify(initialTrigger.filter, null, 2) : "{}"));
  const [optionsText, setOptionsText] = useState(initial.state.recovery?.optionsText ?? (initial.state.config.action.kind !== "script" ? JSON.stringify(initial.state.config.action.options, null, 2) : "{}"));
  const [tagsText, setTagsText] = useState(initial.state.recovery?.tagsText ?? initial.state.config.tags.join(", "));
  const [assistantJson, setAssistantJson] = useState("");
  const [assistantPreview, setAssistantPreview] = useState<StudioConfig | null>(null);
  const [assisting, setAssisting] = useState(false);
  const connections = useStudioConnections(workspaceId, state.config.projectId);
  const config = state.config;
  const saved = state.definition;
  const scopeMismatch = Boolean(props.projectId && config.projectId !== props.projectId);
  const usableConnections = connections.connections.filter(connection => studioConnectionSupportsAction(connection, config.action.kind));
  const providerTools = studioProviderToolReadiness(withTemplatePlugins(config), capabilities);
  const needsReadOnlyAnalysis = providerTools.featureId?.endsWith(":pmAnalysis") === true;
  const prerequisites = studioPrerequisites(template, connections.connections, capabilities, config.action);
  if (providerTools.featureId) prerequisites.push({ id: providerTools.featureId, required: true, available: providerTools.available, reason: providerTools.reason ?? t("所选 Provider 支持所需工具适配器。", "The selected Provider supports the required tool adapter.") });
  const blocked = prerequisites.filter(item => item.required && !item.available);
  let invalidBuffer = false;
  try { if (config.action.kind === "prompt" || (config.action.kind === "template" && studioNativeTemplateRequiresProvider(config.action.templateId))) studioProviderOptionsSchema.parse(parseStudioObject(optionsText)); if (config.trigger.kind === "event") parseStudioObject(filterText); } catch { invalidBuffer = true; }
  const dirty = JSON.stringify(config) !== JSON.stringify(state.baseline) || JSON.stringify(state.values) !== JSON.stringify({ ...templateDefaults(template), ...(state.baseline.action.kind === "template" ? state.baseline.action.arguments as StudioFormValues : {}), ...state.baseline.templateInputs as StudioFormValues }) || invalidBuffer || (!saved && (Boolean(config.name) || Boolean(config.action.kind === "prompt" && config.action.prompt))) || Boolean(state.pending);
  const locked = busy || Boolean(state.pending) || Boolean(storageError);
  const canWrite = !scopeMismatch && writable && capabilities?.canWrite === true && projects.some(project => project.id === config.projectId && !project.data.archivedAt && !["completed", "cancelled"].includes(String(project.data.status ?? "")));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirtyChange?.(dirty || Boolean(storageError)); }, [dirty, storageError, onDirtyChange]);
  useEffect(() => {
    if (storageError || recoveryFinished.current) return;
    try {
      sessionStorage.setItem(key, serializeStudioDraft({ ...state, recovery: { optionsText, filterText, once, tagsText, time, weekday } }));
      redactStudioRecovery(actorId, workspaceId, membershipVersion);
    } catch { setStorageError(t("无法保存恢复日志；在存储恢复前不会发送修改。", "Recovery storage is unavailable; no mutations will be sent until storage recovers.")); }
  }, [state, key, actorId, workspaceId, membershipVersion, optionsText, filterText, once, tagsText, time, weekday, storageError, t]);
  useEffect(() => {
    let current = true;
    setCapabilities(null); setCapabilityError("");
    if (!config.projectId) return;
    void api.capabilities(config.projectId, { actionKind: config.action.kind }).then(value => { if (current) setCapabilities(value); }, (reason: unknown) => { if (!current) return; if (reason instanceof StudioApiError && [401, 403].includes(reason.status)) revoke(); else setCapabilityError(reason instanceof Error ? reason.message : "Cannot load runtime capabilities"); });
    return () => { current = false; };
  }, [api, config.projectId, config.action.kind, capabilityVersion]);
  useEffect(() => { if (props.definition && saved && props.definition.id === saved.id && props.definition.revision > saved.revision) setLatest(props.definition); }, [props.definition, saved]);

  function persist(next: StudioDraftState): boolean {
    try {
      sessionStorage.setItem(key, serializeStudioDraft({ ...next, recovery: { optionsText, filterText, once, tagsText, time, weekday } }));
      if (!next.pending && live.current.pending) settleStudioPriorRequest(actorId, workspaceId, live.current.pending.requestId, key);
    } catch { setStorageError(t("无法持久记录请求，修改未发送。", "Cannot persist the request journal; no mutation was sent.")); return false; }
    live.current = next; setState(next); return true;
  }
  function finishRecovery(): boolean {
    try {
      sessionStorage.removeItem(key);
      recoveryFinished.current = true;
      onDirtyChange?.(false);
      return true;
    } catch {
      setStorageError(t("配置已保存，但无法清除恢复记录；请恢复浏览器存储后再次保存。", "Configuration is saved, but its recovery record could not be cleared. Restore browser storage and save again."));
      return false;
    }
  }
  function revoke() {
    accessLost.current = true;
    const pending = live.current.pending ? { ...live.current.pending, config: null, payload: null, after: null } : null;
    try { clearStudioRecovery(actorId, workspaceId); } catch { setStorageError(t("权限已撤销；恢复存储需要人工核对。", "Access revoked; recovery storage requires reconciliation.")); }
    const empty = emptyStudioConfig();
    live.current = { version: 1, config: empty, baseline: empty, definition: null, values: {}, touched: [], pending, test: null, testPayload: "{}" };
    setState(live.current); setOptionsText("{}"); setFilterText("{}"); setTagsText(""); setOnce(""); setAssistantJson(""); setAssistantPreview(null); setCapabilities(null);
    props.onAccessLost?.();
  }
  function retryStorage() {
    try {
      const recovered = readStudioDraft(key);
      if (initial.error && recovered) { live.current = recovered; setState(recovered); syncControls(recovered.config); }
      if (persist(live.current)) setStorageError("");
    } catch (reason) { setStorageError(reason instanceof Error ? reason.message : "Recovery storage is still invalid"); }
  }
  function syncControls(next: StudioConfig) {
    setTagsText(next.tags.join(", "));
    setOptionsText(next.action.kind !== "script" ? JSON.stringify(next.action.options, null, 2) : "{}");
    setFrequency(frequencyOf(next.trigger));
    setFilterText(next.trigger.kind === "event" ? JSON.stringify(next.trigger.filter, null, 2) : "{}");
    setOnce(next.trigger.kind === "once" ? localTimeInZone(next.trigger.at, next.trigger.timezone) : "");
    if (next.trigger.kind === "cron") {
      const clock = cronEditorClock(next.trigger.expression);
      setTime(clock.time); setWeekday(clock.weekday);
    }
  }
  function loadServerVersion(definition: StudioDefinition) {
    if (!persist({ ...live.current, config: definition.config, baseline: definition.config, definition, values: { ...templateDefaults(template), ...(definition.config.action.kind === "template" ? definition.config.action.arguments as StudioFormValues : {}), ...definition.config.templateInputs as StudioFormValues }, touched: [] })) return;
    syncControls(definition.config); setLatest(null); setIssues({}); setValidation(null);
  }
  function applyAssistantPreview() {
    if (!assistantPreview || locked) return;
    const protectedConfig = applyStudioAssistantPatch(live.current.config, assistantPreview, new Set(live.current.touched));
    const parsed = studioConfigSchema.safeParse(protectedConfig);
    if (!parsed.success) { setError(parsed.error.message); return; }
    const values = { ...live.current.values, ...(parsed.data.templateInputs as StudioFormValues | undefined), ...(parsed.data.action.kind === "template" ? parsed.data.action.arguments as StudioFormValues : {}) };
    if (!persist({ ...live.current, config: parsed.data, values })) return;
    syncControls(parsed.data); setAssistantPreview(null); setValidation(null);
  }
  function change(patch: Partial<StudioConfig>, paths = Object.keys(patch)) {
    if (locked) return;
    const next = { ...live.current, config: { ...live.current.config, ...patch }, touched: [...new Set([...live.current.touched, ...paths])] };
    setValidation(null); setAssistantPreview(null); setIssues({}); setError(""); setNotice("");
    live.current = next; setState(next);
  }
  function actionChange(patch: Partial<StudioConfig["action"]>) { change({ action: { ...config.action, ...patch } as StudioConfig["action"] }, Object.keys(patch).map(path => `action.${path}`)); }
  function withTemplatePlugins(value: StudioConfig): StudioConfig {
    const touched = live.current.touched;
    if (touched.includes("action") || touched.includes("action.plugins") || !template || template.setup?.native || (studioNativeTemplateIdSchema.safeParse(template.id).success && value.action.kind !== "template")) return value;
    const providers = value.action.kind === "template" ? automationTemplateTags(template) : Object.keys(template.requires.integrations);
    const refs = usableConnections.filter(connection => providers.includes(connection.provider)).map(automationIntegrationPlugin);
    return { ...value, action: { ...value.action, plugins: [...value.action.plugins.filter(plugin => !plugin.id.startsWith("integration:")), ...refs] } };
  }
  function formChange(name: string, value: StudioFormValues[string]) {
    const values = { ...live.current.values };
    if (value === undefined) delete values[name]; else values[name] = value;
    const current = live.current.config.action;
    const next = { ...live.current, config: current.kind === "template" ? { ...live.current.config, action: { ...current, arguments: values } } : live.current.config, values, touched: [...new Set([...live.current.touched, `template.${name}`, ...(current.kind === "template" ? [`action.arguments.${name}`] : [])])] };
    live.current = next; setState(next); setValidation(null); setIssues({}); setError("");
  }
  function chooseFrequency(value: StudioFrequency) {
    if (value === "event" && template?.setup?.native && !template.setup.form.triggers?.event) { setError(t("此模板未声明内部事件，请使用手动或既有后台日程。", "This template declares no internal event. Use manual dispatch or the existing background schedule.")); return; }
    setFrequency(value);
    if (value === "manual") change({ trigger: { kind: "manual" } });
    else if (value === "event") {
      const fields = template?.setup?.form.triggers?.event;
      const next = { kind: "event" as const, source: String(fields?.source?.default ?? "github"), key: String(fields?.on?.default ?? ""), filter: {} };
      change({ trigger: next }); setFilterText("{}");
    }
    else if (value === "once") { if (once) { try { change({ trigger: { kind: "once", at: onceInZone(once, "UTC"), timezone: "UTC" } }); } catch (reason) { setError(String(reason)); } } else change({ trigger: { kind: "once", at: new Date().toISOString(), timezone: "UTC" } }); }
    else change({ trigger: { kind: "cron", expression: cronFor(value, time, weekday, config.trigger.kind === "cron" ? config.trigger.expression : "0 9 * * *"), timezone: "timezone" in config.trigger ? config.trigger.timezone : "UTC" } });
  }
  function preparedConfig(input = live.current.config): StudioConfig | null {
    let value = input;
    try {
      if (value.action.kind === "template" && !studioNativeTemplateRequiresProvider(value.action.templateId)) value = { ...value, action: { ...value.action, providerInstanceId: null, model: null, options: {} } };
      else if (value.action.kind !== "script") value = { ...value, action: { ...value.action, options: studioProviderOptionsSchema.parse(parseStudioObject(optionsText)) } };
      if (value.trigger.kind === "cron" && frequency !== "custom") {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || (frequency === "weekly" && !/^[0-6]$/.test(weekday))) throw new Error(t("请选择完整的本地时间与星期。", "Choose a complete local time and weekday."));
        value = { ...value, trigger: { ...value.trigger, expression: cronFor(frequency, time, weekday, value.trigger.expression) } };
      }
      if (frequency === "once") value = { ...value, trigger: { kind: "once", at: onceInZone(once, "timezone" in value.trigger ? value.trigger.timezone : "UTC"), timezone: "timezone" in value.trigger ? value.trigger.timezone : "UTC" } };
      if (value.trigger.kind === "event" && !(template?.setup?.filter && (!template.setup.bundle || value.action.kind === "template") && !live.current.touched.includes("trigger") && !live.current.touched.includes("trigger.filter"))) value = { ...value, trigger: { ...value.trigger, filter: parseStudioObject(filterText) } };
      const result = studioConfigSchema.safeParse(value);
      if (!result.success) { setIssues(Object.fromEntries(result.error.issues.map(issue => [issue.path.join("."), issue.message]))); setError(t("请检查标出的配置字段。", "Check the highlighted configuration fields.")); return null; }
      if (!projects.some(project => project.id === result.data.projectId)) throw new Error(t("请选择当前可访问的项目。", "Select a currently accessible project."));
      return result.data;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
  }
  async function prepareTemplateConfig(): Promise<StudioConfig | null> {
    setError(""); setNotice("");
    const fieldIssues: Record<string, string> = {};
    const values = normalizeStudioTemplateValues(template, live.current.values);
    for (const [name, field] of Object.entries(template && isPmAutomationTemplateId(template.id) ? {} : template?.setup?.form.args ?? {})) {
      if (template?.setup?.bundle && live.current.config.action.kind !== "template") continue;
      if (template?.id === "custom-automation" && ["name", "model", "timeout"].includes(name)) continue;
      const issue = studioFieldIssue(field, values[name] ?? ""); if (issue) fieldIssues[`template.${name}`] = issue;
    }
    if (live.current.config.action.kind === "template") for (const issue of validateNativeTemplateArguments(live.current.config.action.templateId, values)) fieldIssues[issue.path] = issue.message;
    if (Object.keys(fieldIssues).length) { setIssues(fieldIssues); setError(t("请检查模板字段。", "Check the template fields.")); return null; }
    if (template?.id === "github-repo-monitor" && state.values.authorization === "anyone" && state.values.workMode === "implement") { setError(t("允许任意用户触发时不能允许推送代码。", "Allowing anyone to trigger cannot be combined with implement/push mode.")); return null; }
    let value = live.current.config;
    if (template) value = { ...value, templateInputs: { ...values }, templateVersion: template.version ?? automationCatalogSource.extensionsVersion };
    const touched = new Set(live.current.touched);
    if (value.action.kind === "template") value = { ...value, action: { ...value.action, arguments: { ...values } } };
    if (template?.setup?.prompt && value.action.kind === "prompt" && !touched.has("action") && !touched.has("action.prompt")) value = { ...value, action: { ...value.action, prompt: String(interpolateStudioTemplate(template.setup.prompt, values)) } };
    value = withTemplatePlugins(value);
    if (value.trigger.kind === "event" && template?.setup?.filter && (!template.setup.bundle || value.action.kind === "template") && !touched.has("trigger") && !touched.has("trigger.filter")) {
      const expression = interpolateStudioExpression(template.setup.filter, values);
      value = { ...value, trigger: { ...value.trigger, filter: expression ? { expression } : {} } };
      setFilterText(JSON.stringify(value.trigger.kind === "event" ? value.trigger.filter : {}, null, 2));
    }
    live.current = { ...live.current, config: value, values }; setState(live.current);
    return mode === "direct" ? preparedConfig(value) : value;
  }
  async function review() {
    if (inFlight.current || locked) return;
    inFlight.current = true;
    const value = await prepareTemplateConfig();
    if (!value) { inFlight.current = false; return; }
    if (mode !== "direct") { setStage("review"); inFlight.current = false; return; }
    const parsed = studioConfigSchema.safeParse(value);
    if (!parsed.success) { setIssues(Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join("."), issue.message]))); setError(t("请补齐配置后再预检。", "Complete the configuration before preflight.")); inFlight.current = false; return; }
    setBusy(true);
    try { const result = await api.validate(parsed.data); setValidation(result); setIssues(Object.fromEntries(result.issues.map(issue => [issue.path, issue.message]))); setStage("review"); }
    catch (reason) { if (reason instanceof StudioApiError && [401, 403].includes(reason.status)) revoke(); else setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); inFlight.current = false; }
  }
  async function acceptResult(pending: StudioPending, result: unknown) {
    if (accessLost.current) return;
    if (pending.kind === "upload") {
      const bundle = result as AutomationBundleUpload;
      if (!bundle || typeof bundle.bundleId !== "string" || typeof bundle.sha256 !== "string" || !Array.isArray(bundle.files) || !bundle.files.every(file => typeof file.path === "string" && typeof file.content === "string")) throw new Error("Invalid upload receipt");
      const current = live.current.config.action;
      if (current.kind !== "script") throw new Error("The uploaded script configuration changed before reconciliation");
      if (!persist({ ...live.current, pending: null, config: { ...live.current.config, action: { ...current, content: "", files: bundle.files, bundleRef: bundle.bundleId } }, touched: [...new Set([...live.current.touched, "action.files", "action.bundleRef", "action.content"])] })) return;
      setNotice(t(`上传已持久保存；SHA-256 ${bundle.sha256}`, `Upload persisted; SHA-256 ${bundle.sha256}`));
      return;
    }
    if (pending.kind === "test") {
      const execution = studioExecutionSchema.parse(result);
      const next = { ...live.current, pending: null, test: execution };
      if (!persist(next)) return;
      setNotice(t("试运行已持久受理；队列/运行状态不是成功结果。", "The test was durably accepted; queued/running is not a success result.")); if (onExecution && finishRecovery()) onExecution(execution); return;
    }
    const definition = studioDefinitionSchema.parse(result);
    const next = { ...live.current, pending: null, definition, baseline: definition.config, config: definition.config, values: { ...templateDefaults(template), ...(definition.config.action.kind === "template" ? definition.config.action.arguments as StudioFormValues : {}), ...definition.config.templateInputs as StudioFormValues } };
    if (!persist(next)) return;
    syncControls(definition.config);
    setLatest(null);
    if (props.projectId && definition.config.projectId !== props.projectId) { setNotice(t("原请求的保存结果已核对。当前 URL 项目不匹配，不会继续测试或启用。请选择原项目后继续。", "The original save was reconciled. The URL project does not match, so test/enable continuation was not sent. Select the original project to continue.")); return; }
    if (pending.after) {
      const follow: StudioPending = { ...pending, kind: pending.after === "test" ? "test" : "enable", requestId: crypto.randomUUID(), definitionId: definition.id, expectedRevision: definition.revision, config: definition.config, after: null };
      await sendMutation(follow);
    } else { setNotice(t("配置已保存至服务器。", "Configuration saved to the server.")); if (finishRecovery()) onSaved(definition); }
  }
  async function sendMutation(pending: StudioPending) {
    if (props.projectId && pending.config && pending.config.projectId !== props.projectId) { setError(t("恢复配置与当前 URL 项目不一致。请先选择匹配项目；请求未发送。", "The recovery configuration does not match the URL project. Select the matching scope first; no request was sent.")); return; }
    if (pending.config && (pending.kind === "test" || pending.kind === "enable" || (pending.kind === "update" && live.current.definition?.status === "enabled"))) {
      const tools = studioProviderToolReadiness(pending.config, capabilities);
      if (!tools.available) { setError(tools.reason ?? t("所选 Provider 不支持此操作所需工具。", "The selected Provider cannot receive the tools required for this action.")); return; }
    }
    if (!persist({ ...live.current, config: pending.config ?? live.current.config, pending })) return;
    if (!pending.config) { setError(t("授权变化后只能核对原请求，不能重发。", "After an authorization change, the original request may only be reconciled, never resent.")); return; }
    try {
      const result = pending.kind === "create" ? await api.create(pending.requestId, pending.config) : pending.kind === "update" ? await api.update(pending.definitionId!, pending.requestId, pending.expectedRevision!, pending.config) : pending.kind === "test" ? await api.dispatchTest(pending.definitionId!, pending.requestId, pending.expectedRevision!, pending.payload ?? undefined) : await api.setStatus(pending.definitionId!, pending.requestId, pending.expectedRevision!, "enabled");
      await acceptResult(pending, result);
    } catch (reason) {
      if (reason instanceof StudioApiError && [401, 403].includes(reason.status)) { if (reason.code !== "invalid_response") persist({ ...live.current, pending: null }); revoke(); return; }
      const definite = reason instanceof StudioApiError && reason.code !== "invalid_response" && reason.status >= 400 && reason.status < 500 && ![408, 429].includes(reason.status);
      if (definite) {
        persist({ ...live.current, pending: null });
        if (reason.status === 409 && pending.definitionId) { try { setLatest(await api.definition(pending.definitionId)); } catch { /* The user's input remains intact even when the newest version cannot be read. */ } }
        setError(reason.message);
      } else setError(t("结果未知。保留原请求标识；请先核对，不会自动重发。", "The outcome is unknown. The original request ID is retained; reconcile it before any other mutation. It will not be resent automatically."));
    }
  }
  async function save(after: "test" | "enable" | null) {
    if (scopeMismatch) { setError(t("恢复配置与当前 URL 项目不一致，输入已保留。请选择匹配项目后再保存、测试或启用。", "The recovery configuration does not match the URL project. Your input is retained; select the matching project before saving, testing or enabling.")); return; }
    if (inFlight.current || locked || !canWrite || latest) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const value = await prepareTemplateConfig(); if (!value) return;
      if (after || saved?.status === "enabled") {
        const tools = studioProviderToolReadiness(value, capabilities);
        if (!tools.available) { setError(tools.reason ?? t("所选 Provider 不支持此操作所需工具。", "The selected Provider cannot receive the tools required for this action.")); return; }
      }
      let payload: Record<string, unknown> | null = null;
      if (after === "test") { try { payload = parseStudioObject(live.current.testPayload); } catch (reason) { setError(String(reason)); return; } }
      if (after && blocked.length) { setError(t("请先满足模板的必需依赖。", "Satisfy the template's required dependencies first.")); return; }
      if (after === "test" && !window.confirm(template?.setup?.native ? t("保存冻结版本并执行真实只读分析？可能调用所选模型产生费用，并读取已选授权来源；不会应用候选或完成任务。", "Save a frozen revision and run real read-only analysis? It may incur model cost and read the selected authorized sources. It will not apply candidates or complete tasks.") : t("试运行会先保存冻结版本，再执行真实 Provider/脚本，可能产生费用及外部副作用。继续？", "Test saves a frozen version then runs the real Provider/script. It may incur cost or external side effects. Continue?"))) return;
      if (after === "enable" && !window.confirm(template?.setup?.native ? t("保存并启用后台只读分析？后续事件/日程可能调用模型并产生费用；每项 PM 写入仍需在结果详情预览并由您确认。", "Save and enable background read-only analysis? Later events/schedules may incur model cost. Every PM write still requires preview and your confirmation in result details.") : t("保存并启用此自动化？后台会根据触发器执行真实操作。", "Save and enable this automation? Its trigger can cause real background execution."))) return;
      const unchanged = saved && JSON.stringify(value) === JSON.stringify(saved.config);
      if (unchanged && after) await sendMutation({ requestId: crypto.randomUUID(), kind: after === "test" ? "test" : "enable", definitionId: saved.id, expectedRevision: saved.revision, config: value, after: null, payload });
      else if (unchanged) { setNotice(t("配置没有变化。", "No configuration changes.")); if (finishRecovery()) onSaved(saved); }
      else await sendMutation({ requestId: crypto.randomUUID(), kind: saved ? "update" : "create", definitionId: saved?.id ?? null, expectedRevision: saved?.revision ?? null, config: value, after, payload });
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function reconcile() {
    const pending = live.current.pending; if (!pending || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (pending.kind === "upload") { await acceptResult(pending, await transfer.uploadBundleReceipt(pending.requestId)); return; }
      const receipt = await api.receipt(pending.requestId);
      if (receipt.httpStatus >= 200 && receipt.httpStatus < 300) await acceptResult(pending, receipt.result);
      else { persist({ ...live.current, pending: null }); setError(t(`请求被拒绝 (${receipt.httpStatus})；输入已保留。`, `Request was rejected (${receipt.httpStatus}); your input is retained.`)); }
    } catch (reason) { if (reason instanceof StudioApiError && [401, 403].includes(reason.status)) revoke(); else setError(t("尚无法证明原请求结果，继续保留原键，不会重发。", "The original outcome is still unproven. Its request ID is retained and it will not be resent.") + " " + (reason instanceof Error ? reason.message : String(reason))); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function previewAssistant(patch: Partial<StudioConfig>) {
    if (accessLost.current) return;
    const merged = applyStudioAssistantPatch(live.current.config, patch, new Set(live.current.touched));
    const parsed = studioConfigSchema.safeParse(merged);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")); return; }
    setAssistantPreview(parsed.data); setNotice(t("请审查建议。用户编辑过的字段不会被覆盖。", "Review the suggestion. User-edited fields will not be overwritten."));
  }
  async function assist() {
    if (!onAssist || !config.projectId || scopeMismatch || assisting || locked || blocked.some(item => Object.hasOwn(template?.requires.integrations ?? {}, item.id))) return;
    if (!persist(live.current)) return;
    setAssisting(true); setError("");
    const context = template ? automationTemplateLaunchPrompt(template) : t("协助配置此 PM 自动化。", "Help configure this PM automation.");
    const prompt = `${context}\n\nProject: ${config.projectId}\nSaved definition: ${saved?.id ?? "not yet saved"}\nCurrent configuration:\n${JSON.stringify(config, null, 2)}\n\nReturn proposed configuration changes as a JSON object for explicit review in the automation editor. Do not create, enable, dispatch, or send anything without explicit user authorization.`;
    try { await onAssist({ prompt, projectId: config.projectId, ...(saved ? { definitionId: saved.id } : { draftId: editorId }), ...(template ? { templateId: template.id } : {}), config: structuredClone(config), onApply: previewAssistant }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssisting(false); }
  }
  async function upload(file: File) {
    if (inFlight.current || locked || !canWrite || config.action.kind !== "script") return;
    if (!/\.(?:tar|tar\.gz|tgz)$/i.test(file.name)) { setError(t("请选择 .tar 或 .tar.gz 文件。", "Choose a .tar or .tar.gz file.")); return; }
    if (file.size > AUTOMATION_TRANSFER_LIMITS.archiveBytes) { setError(t("上传文件超过 2 MiB。", "The upload exceeds 2 MiB.")); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const pending: StudioPending = { requestId: crypto.randomUUID(), kind: "upload", definitionId: saved?.id ?? null, expectedRevision: saved?.revision ?? null, config, after: null, payload: null };
      if (!persist({ ...live.current, pending })) return;
      const bundle = await transfer.uploadBundle({ requestId: pending.requestId, projectId: config.projectId, filename: file.name, archiveBase64: btoa(binary) });
      await acceptResult(pending, bundle);
    } catch (reason) {
      if (reason instanceof StudioApiError && reason.code !== "invalid_response" && reason.status >= 400 && reason.status < 500 && ![408, 429].includes(reason.status)) persist({ ...live.current, pending: null });
      if (reason instanceof StudioApiError && [401, 403].includes(reason.status)) { revoke(); return; }
      setError((reason instanceof Error ? reason.message : String(reason)) + " " + t("上传结果未知时保留原键，请核对后再操作。", "If the upload result is unknown, keep its original key and reconcile before another upload."));
    } finally { inFlight.current = false; setBusy(false); }
  }
  function renderTemplateField(name: string, field: AutomationCatalogField) {
    if (template?.id === "custom-automation" && ["name", "model", "timeout"].includes(name)) return null;
    const value = state.values[name] ?? "";
    const help = config.action.kind === "template" && name.endsWith("TokenSecret")
      ? `${field.help} ${t("此字段仅保留来源名称用于溯源；原生工作流使用已选择、经验证的项目 Integration，绝不查找任意环境变量秘密。", "This source name is provenance only. The native workflow authenticates through the selected, verified project Integration and never looks up arbitrary environment secrets.")}`
      : field.help;
    return <Field key={name} label={field.label + (field.required ? " *" : "")} help={help} issue={issues[`template.${name}`] ?? issues[`action.arguments.${name}`]}>{id =>
      field.type === "select" ? <RadixSelect id={id} value={String(value)} onChange={event => formChange(name, event.target.value)}><option value="">—</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</RadixSelect>
      : field.type === "repo-picker" ? field.multiple
        ? <textarea id={id} rows={3} value={Array.isArray(value) ? value.join("\n") : String(value)} aria-description={t("每行一个明确的 Provider 仓库名称；执行时会按项目连接核对权限。", "One explicit Provider repository name per line; execution rechecks the project's connector authorization.")} onChange={event => formChange(name, event.target.value.split(/\r?\n/))} />
        : <Input id={id} value={String(value)} onChange={event => formChange(name, event.target.value)} />
      : field.type === "textarea" ? <textarea id={id} rows={4} value={String(value)} placeholder={field.placeholder} maxLength={field.constraints?.maxLength} onChange={event => formChange(name, event.target.value)} />
      : <Input id={id} type={field.type === "number" ? "number" : "text"} value={String(value)} placeholder={field.placeholder} min={field.constraints?.min} max={field.constraints?.max} maxLength={field.constraints?.maxLength} onChange={event => formChange(name, field.type === "number" ? event.target.value === "" ? "" : Number(event.target.value) : event.target.value)} />
    }</Field>;
  }
  const actionAvailable = capabilities?.actions.find(action => action.id === config.action.kind);
  const timezone = "timezone" in config.trigger ? config.trigger.timezone : "UTC";
  const renderConfiguration = mode === "direct";
  if (props.templateId && !template) return <article className={styles.editor}><h1>{t("模板不存在", "Template not found")}</h1><p role="alert">{t("此 ID 不在固定的 production 目录中；不会创建空白替代规则。", "This ID is not in the pinned production catalog; no blank replacement rule is created.")}</p><Button onClick={onCancel}>{t("返回", "Back")}</Button></article>;
  return <article className={styles.editor} aria-label={t("执行自动化编辑器", "Execution automation editor")}>
    <header className={styles.heading}><div><Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}><ArrowLeft size={14} />{t("返回", "Back")}</Button><h1>{saved ? t("编辑自动化", "Edit automation") : template?.name ?? t("新建自动化", "New automation")}</h1><p>{t("配置 Agent、脚本或原生模板的触发条件与执行动作。", "Configure triggers and actions for an agent, script, or native template.")}</p></div><span className={styles.badge}>{saved ? `${saved.status} · v${saved.revision}` : t("尚未保存至服务器", "Not saved to server")}</span></header>
    {template && <><nav className={styles.steps} aria-label={t("设置步骤", "Setup steps")}>{(["prerequisites", "form", "review"] as const).map((step, index) => <button type="button" key={step} disabled={locked} aria-current={stage === step ? "step" : undefined} onClick={() => step === "review" ? void review() : setStage(step)}>{index + 1}. {step === "prerequisites" ? t("前提条件", "Prerequisites") : step === "form" ? t("配置", "Configure") : t("审查", "Review")}</button>)}</nav><p className={styles.provenance}>{isPmAutomationTemplateId(template.id) ? t("PM 原生 · agent-pm-studio 场景适配", "PM native · agent-pm-studio scenario adaptation") : `OpenHands · extensions ${automationCatalogSource.extensionsVersion} · MIT`} · {template.id}@{template.version ?? "catalog"} · {mode}</p></>}
    {storageError && <section className={styles.error} role="alert"><p>{storageError}</p><Button variant="outline" onClick={retryStorage}>{t("重试本地恢复存储", "Retry recovery storage")}</Button></section>}
    {state.pending && <section className={styles.warning} role="status"><strong>{t("原请求的结果待核对", "Original request needs reconciliation")}</strong><p>{state.pending.kind} · <code>{state.pending.requestId}</code></p><p>{t("不会重发或以新键替代。未找到收据也不证明请求从未执行。", "This request will not be resent or replaced with a new key. A missing receipt is not proof it never executed.")}</p><Button disabled={busy} onClick={() => { void reconcile(); }}>{t("核对原请求", "Reconcile original request")}</Button></section>}
    {latest && <section className={styles.warning}>
      <strong>{t("版本冲突；您的输入已保留。", "Revision conflict; your input is retained.")}</strong><p>v{saved?.revision} → v{latest.revision}</p>
      <details><summary>{t("查看服务器版本", "View server version")}</summary><pre>{JSON.stringify(latest.config, null, 2)}</pre></details>
      <div className={styles.actions}><Button variant="outline" disabled={locked} onClick={() => { persist({ ...live.current, definition: latest, baseline: latest.config }); setLatest(null); }}>{t("保留输入，采用当前 revision", "Keep input, adopt current revision")}</Button>
      <Button variant="ghost" disabled={locked} onClick={() => loadServerVersion(latest)}>{t("载入服务器配置", "Load server configuration")}</Button></div>
    </section>}
    <Field label={t("项目", "Project")} issue={issues.projectId}>{id => <RadixSelect id={id} disabled={locked || Boolean(saved)} value={config.projectId} onChange={event => change({ projectId: event.target.value })}><option value="">{t("选择项目", "Choose a project")}</option>{projects.map(project => <option key={project.id} value={project.id}>{typeof project.data.name === "string" ? project.data.name : project.id} ({project.id})</option>)}</RadixSelect>}</Field>
    {scopeMismatch && <section className={styles.warning} role="alert"><strong>{t("恢复草稿与当前项目范围不一致", "Recovery draft does not match the current project scope")}</strong><p>{t(`草稿项目：${config.projectId || "未选择"}；URL 项目：${props.projectId}。输入不会自动改写。请在项目字段选择 URL 项目，或返回草稿所属项目后继续。保存、上传、测试与启用均被阻止。`, `Draft project: ${config.projectId || "not selected"}; URL project: ${props.projectId}. Your input is not rewritten. Select the URL project in the project field, or return to the draft's project. Saving, uploading, testing and enabling are blocked.`)}</p></section>}
    {(capabilityError || connections.error) && <div className={styles.error} role="alert">{capabilityError || connections.error}<Button variant="ghost" size="sm" onClick={() => { setCapabilityVersion(value => value + 1); connections.refresh(); }}>{t("刷新能力", "Refresh capabilities")}</Button></div>}
    {!providerTools.available && <section className={styles.warning} role="status"><strong>{needsReadOnlyAnalysis ? t("无工具只读分析 Provider 尚未就绪", "No-tools read-only analysis Provider is not ready") : t("所选 Provider 的工具能力不可用", "Selected Provider tool capability is unavailable")}</strong><p>{providerTools.reason}</p><p>{needsReadOnlyAnalysis ? t("请选择明确声明 pmAnalysis 能力且已认证的 Provider；工具沙箱不等于无工具执行。没有兼容 Provider 时可保存草稿，但不能试运行或启用。无需模型的确定性模板不受影响。", "Choose an authenticated Provider explicitly advertising pmAnalysis. A tool sandbox is not a no-tools boundary. Without a compatible Provider you can save a draft, but cannot test or enable it. Deterministic templates do not require a model.") : t("未启用的配置仍可保存；已启用定义请先暂停或选择支持的 Provider。此限制只针对当前需要连接器/工作区工具的操作，不会禁用普通 Prompt、新闻摘要或确定性工作流。", "Non-enabled configurations can still be saved; pause an enabled definition or choose a supported Provider before updating it. This applies only to the current connector/workspace-tool action; ordinary prompts, news summaries and deterministic workflows remain available.")}</p><code>{providerTools.featureId}</code><Button variant="ghost" size="sm" onClick={() => setCapabilityVersion(value => value + 1)}>{t("刷新 Provider 能力", "Refresh Provider capabilities")}</Button></section>}
    {(stage === "prerequisites" || (template && stage === "review")) && <section className={styles.section}><h2>{t("必需能力与连接", "Required capabilities and connections")}</h2>{!prerequisites.length && <p>{t("此模板不要求额外外部连接。", "This template requires no additional external integration.")}</p>}<ul className={styles.prerequisites}>{prerequisites.map(item => <li key={item.id}><span className={item.available ? styles.connected : styles.dependency}>{item.available ? <Check size={14} /> : "○"} {item.id} {!item.required && t("（可选）", " (optional)")}</span><p>{item.reason}</p><small>{item.available ? t("已就绪", "Available") : t("尚未就绪", "Not available")}</small></li>)}</ul><div className={styles.actions}><Button variant="outline" onClick={() => { connections.refresh(); setCapabilityVersion(value => value + 1); }}>{t("刷新前提条件", "Refresh prerequisites")}</Button>{onIntegrations && <Button variant="ghost" onClick={onIntegrations}>{t("管理项目连接", "Manage project integrations")}</Button>}<Button disabled={locked || !config.projectId} onClick={() => setStage("form")}>{blocked.length ? t("继续配置（尚不可运行）", "Configure (not ready to run)") : t("继续", "Continue")}</Button></div></section>}
    {(stage === "form" || (!template && stage !== "review")) && <form onSubmit={event => { event.preventDefault(); void review(); }}>
      <fieldset disabled={locked} className={styles.formBody}>
        {template?.setup?.form.note && <p className={styles.notice}>{template.setup.form.note}</p>}
        {template && isPmAutomationTemplateId(template.id) && config.action.kind === "template" ? <StudioPmParameters values={state.values} issues={issues} templateId={template.id} allowRepository={template.id === "pm-pr-acceptance-coverage"} onChange={formChange} /> : template?.setup && (!template.setup.bundle || config.action.kind === "template") && Object.entries(template.setup.form.args).map(([name, field]) => renderTemplateField(name, field))}
        {renderConfiguration && <>
          <section className={styles.section}><h2>{t("内容", "Content")}</h2>
          <Field label={t("名称", "Name")} issue={issues.name}>{id => <Input id={id} value={config.name} maxLength={160} onChange={event => change({ name: event.target.value })} />}</Field>
          <Field label={t("说明", "Description")} issue={issues.description}>{id => <textarea id={id} rows={3} maxLength={4000} value={config.description} onChange={event => change({ description: event.target.value })} />}</Field>
          <Field label={t("标签（逗号分隔）", "Tags (comma-separated)")} issue={issues.tags}>{id => <Input id={id} value={tagsText} onChange={event => { setTagsText(event.target.value); change({ tags: event.target.value.split(",").map(tag => tag.trim()).filter(Boolean) }); }} />}</Field>
          <StudioSetupAction action={config.action} template={template} values={state.values} capabilities={capabilities} issues={issues} optionsText={optionsText} canWrite={canWrite} disabled={locked}
            onOptions={setOptionsText} onChange={actionChange} onInvalidOptions={() => change({}, ["action.options"])}
            onKindChange={action => { change({ action }, ["action.kind"]); setOptionsText(action.kind === "script" ? "{}" : JSON.stringify(action.options, null, 2)); }}
            onUpload={file => { void upload(file); }} />
          {!actionAvailable?.available && <p className={styles.dependency}>{actionAvailable?.reason ?? t("执行环境尚未就绪。草稿可保存，运行不可用。", "The execution environment is not ready. Drafts can be saved; running is unavailable.")}</p>}
          </section>
          <section className={styles.section}>
            <h2>{template?.setup?.native ? t("只读执行边界", "Read-only execution boundary") : t("仓库与插件", "Repositories and plugins")}</h2><p>{template?.setup?.native ? t("PM 原生分析不暴露本机仓库或通用插件。仅 PR 覆盖模板允许一个明确版本的只读原生 API 连接。", "PM-native analysis exposes no local repository or general-purpose plugins. Only the PR coverage template accepts one explicitly versioned read-only native API connection.") : t("以下选项由当前授权运行环境返回，保存的是明确引用及版本。", "Choices below come from the authorized runtime. Explicit references and versions are persisted.")}</p>
            {!template?.setup?.native && <><Field label={t("仓库", "Repositories")} issue={issues["action.repositories"]}>{id => <RadixSelect id={id} multiple value={config.action.repositories.map(repository => repository.id)} onChange={event => actionChange({ repositories: Array.from(event.target.selectedOptions, option => config.action.repositories.find(repository => repository.id === option.value) ?? { id: option.value, ref: null }) })}>{capabilities?.repositories.map(repository => <option value={repository.id} key={repository.id}>{repository.name}</option>)}</RadixSelect>}</Field>
            {config.action.repositories.map(repository => <Field key={repository.id} label={`${repository.id} · ref`}>{id => <Input id={id} value={repository.ref ?? ""} onChange={event => actionChange({ repositories: config.action.repositories.map(item => item.id === repository.id ? { ...item, ref: event.target.value || null } : item) })} />}</Field>)}</>}
            {template?.id === "pm-pr-acceptance-coverage" ? <Field label={t("已验证的只读 API 来源连接", "Verified read-only API source connection")} issue={issues["action.plugins"]}>{id => <RadixSelect id={id} value={config.action.plugins[0]?.id ?? ""} onChange={event => { const connection = usableConnections.find(item => `integration:${item.id}` === event.target.value); actionChange({ plugins: connection ? [automationIntegrationPlugin(connection)] : [] }); }}><option value="">{t("不使用外部连接", "No external connection")}</option>{usableConnections.filter(connection => connection.provider === "github" || connection.provider === "gitlab").map(connection => <option key={connection.id} value={`integration:${connection.id}`}>{connection.provider} · {connection.label} @v{connection.revision}</option>)}</RadixSelect>}</Field> : !template?.setup?.native && <Field label={config.action.kind === "template" ? t("插件与已验证原生 API 连接", "Plugins and verified native API connections") : t("插件与已验证 MCP 连接", "Plugins and verified MCP connections")} issue={issues["action.plugins"]}>{id => <RadixSelect id={id} multiple value={config.action.plugins.map(plugin => plugin.id)} onChange={event => actionChange({ plugins: Array.from(event.target.selectedOptions, option => {
              const connection = usableConnections.find(item => `integration:${item.id}` === option.value);
              if (connection) return automationIntegrationPlugin(connection);
              const plugin = capabilities?.plugins.find(item => item.id === option.value);
              return { id: option.value, version: plugin?.version ?? null };
            }) })}>{capabilities?.plugins.map(plugin => <option value={plugin.id} key={plugin.id}>{plugin.name}{plugin.version ? ` @${plugin.version}` : ""}</option>)}{usableConnections.filter(connection => !capabilities?.plugins.some(plugin => plugin.id === `integration:${connection.id}`)).map(connection => <option key={connection.id} value={`integration:${connection.id}`}>{connection.provider} · {connection.label} @v{connection.revision}</option>)}</RadixSelect>}</Field>}
            <Field label={t("超时（秒）", "Timeout (seconds)")} issue={issues["action.timeoutSeconds"]}>{id => <Input id={id} type="number" min={1} max={86400} value={config.action.timeoutSeconds} onChange={event => actionChange({ timeoutSeconds: Number(event.target.value) })} />}</Field>
          </section>
          <section className={styles.section}><h2>{t("触发器", "Trigger")}</h2><Field label={t("运行频率", "Frequency")}>{id => <RadixSelect id={id} value={frequency} onChange={event => chooseFrequency(event.target.value as StudioFrequency)}>{([ ["manual", t("仅手动", "Manual only")], ["once", t("单次", "Once")], ["hourly", t("每小时", "Hourly")], ["daily", t("每天", "Daily")], ["weekdays", t("工作日", "Weekdays")], ["weekly", t("每周", "Weekly")], ["custom", t("自定义 Cron", "Custom cron")], ["event", t("事件", "Event")] ] as const).filter(([value]) => value !== "event" || !template?.setup?.native || Boolean(template.setup.form.triggers?.event)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</RadixSelect>}</Field>
          {config.trigger.kind === "once" && <Field label={t("日期与本地时间（含年份）", "Date and local time (including year)")} issue={issues["trigger.at"]}>{id => <Input id={id} type="datetime-local" value={once} onChange={event => { setOnce(event.target.value); try { change({ trigger: { kind: "once", at: onceInZone(event.target.value, timezone), timezone } }); } catch (reason) { setError(String(reason)); } }} />}</Field>}
          {config.trigger.kind === "cron" && frequency !== "custom" && <Field label={frequency === "hourly" ? t("每小时的分钟", "Minute within each hour") : t("本地时间", "Local time")}>{id => <Input id={id} type="time" value={time} onChange={event => { setTime(event.target.value); change({ trigger: { kind: "cron", expression: cronFor(frequency, event.target.value, weekday, config.trigger.kind === "cron" ? config.trigger.expression : ""), timezone } }); }} />}</Field>}
          {frequency === "weekly" && <Field label={t("星期", "Day of week")}>{id => <RadixSelect id={id} value={weekday} onChange={event => { setWeekday(event.target.value); change({ trigger: { kind: "cron", expression: cronFor("weekly", time, event.target.value, ""), timezone } }); }}>{[t("周日", "Sunday"), t("周一", "Monday"), t("周二", "Tuesday"), t("周三", "Wednesday"), t("周四", "Thursday"), t("周五", "Friday"), t("周六", "Saturday")].map((day, index) => <option value={index} key={day}>{day}</option>)}</RadixSelect>}</Field>}
          {config.trigger.kind === "cron" && frequency === "custom" && <Field label="Cron (minute hour day month weekday)" issue={issues["trigger.expression"]}>{id => <Input id={id} value={config.trigger.kind === "cron" ? config.trigger.expression : ""} onChange={event => change({ trigger: { kind: "cron", expression: event.target.value, timezone } })} />}</Field>}
          {(config.trigger.kind === "cron" || config.trigger.kind === "once") && <Field label={t("IANA 时区", "IANA timezone")} issue={issues["trigger.timezone"]}>{id => <Input id={id} value={timezone} onChange={event => change({ trigger: { ...config.trigger, timezone: event.target.value } as StudioConfig["trigger"] })} />}</Field>}
          {config.trigger.kind === "event" && <>
            <div className={styles.twoColumns}>
              <Field label={t("事件来源", "Event source")} issue={issues["trigger.source"]}>{id => <Input id={id} readOnly={Boolean(template?.setup?.native)} value={config.trigger.kind === "event" ? config.trigger.source : ""} onChange={event => change({ trigger: { ...(config.trigger as Extract<StudioConfig["trigger"], { kind: "event" }>), source: event.target.value } }, ["trigger.source"])} />}</Field>
              <Field label={template?.setup?.form.triggers?.event?.on?.label ?? t("事件键 / 通配符", "Event key / wildcard")} help={template?.setup?.form.triggers?.event?.on?.help} issue={issues["trigger.key"]}>{id => template?.setup?.form.triggers?.event?.on?.options
                ? <RadixSelect id={id} value={config.trigger.kind === "event" ? config.trigger.key : ""} onChange={event => change({ trigger: { ...(config.trigger as Extract<StudioConfig["trigger"], { kind: "event" }>), key: event.target.value } }, ["trigger.key"])}><option value="">—</option>{template.setup.form.triggers.event.on.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</RadixSelect>
                : <Input id={id} value={config.trigger.kind === "event" ? config.trigger.key : ""} onChange={event => change({ trigger: { ...(config.trigger as Extract<StudioConfig["trigger"], { kind: "event" }>), key: event.target.value } }, ["trigger.key"])} />}</Field>
            </div>
            <Field label={t("过滤器 JSON object", "Filter JSON object")} help={t('支持路径/相等过滤或 {"expression":"JMESPath"}，包含 glob/icontains。', 'Use path/equality filters or {"expression":"JMESPath"}, including glob/icontains.')} issue={issues["trigger.filter"]}>{id => <textarea id={id} rows={5} value={filterText} onChange={event => { setFilterText(event.target.value); try { change({ trigger: { ...(config.trigger as Extract<StudioConfig["trigger"], { kind: "event" }>), filter: parseStudioObject(event.target.value) } }, ["trigger.filter"]); } catch { change({}, ["trigger.filter"]); } }} />}</Field>
            <p>{config.trigger.source === "pm" ? t("PM 内部信号由授权事件桥持久化投递，不要求公共 Webhook，也不依赖页面计时器。", "PM internal signals are durably delivered by the authorized event bridge. They require neither a public webhook nor browser timers.") : t("保存定义后在项目连接页注册签名 Webhook；仅填写来源并不代表连接完成。", "After saving, register its signed webhook in project integrations. Entering a source does not establish a connection.")}</p>
          </>}
          <div className={styles.twoColumns}><Field label={t("每日运行上限", "Daily run limit")} issue={issues.dailyLimit}>{id => <Input id={id} type="number" min={1} max={100} value={config.dailyLimit} onChange={event => change({ dailyLimit: Number(event.target.value) })} />}</Field><Field label={t("冷却（分钟）", "Cooldown (minutes)")} issue={issues.cooldownMinutes}>{id => <Input id={id} type="number" min={0} max={10080} value={config.cooldownMinutes} onChange={event => change({ cooldownMinutes: Number(event.target.value) })} />}</Field></div></section>
        </>}
      </fieldset>
      <div className={styles.actions}><Button type="submit" disabled={locked || !config.projectId}>{t("预检与审查", "Preflight and review")}</Button></div>
    </form>}
    {stage === "review" && <section className={styles.section}>
      <h2>{t("审查配置", "Review configuration")}</h2><p>{mode === "direct" ? t("只读预检不执行模型、不产生运行记录。保存草稿、试运行与启用是分开的动作。", "Read-only preflight does not invoke a model or create a run. Save draft, test, and enable are separate actions.") : t("这些起点将预填到现有 Chat。您仍需在对话中确认并发送，不会在此创建规则。", "These starting points prefill the existing Chat. You still review and send there; this does not create a rule.")}</p>
      {validation && <><p className={validation.valid ? styles.connected : styles.dependency}>{validation.valid ? t("预检通过", "Preflight passed") : t("预检发现问题", "Preflight found issues")}{validation.nextDueAt && ` · ${t("下次", "Next")}: ${validation.nextDueAt}`}</p><ul>{validation.issues.map(issue => <li key={`${issue.path}:${issue.code}`} className={styles.dependency}><code>{issue.path}</code>: {issue.message}</li>)}</ul></>}
      <details open><summary>{t("冻结配置预览", "Frozen configuration preview")}</summary><pre>{JSON.stringify(mode === "direct" ? config : { templateId: template?.id, projectId: config.projectId, values: state.values }, null, 2)}</pre></details><Button variant="ghost" onClick={() => setStage("form")}>{t("返回修改", "Back to edit")}</Button>
    </section>}
    {renderConfiguration && <>
      <section className={styles.section}>
        <Field label={t("试运行事件 Payload（JSON object）", "Test event payload (JSON object)")}>{id => <textarea id={id} rows={3} value={state.testPayload} disabled={locked} onChange={event => { const next = { ...live.current, testPayload: event.target.value }; live.current = next; setState(next); }} />}</Field>
        <div className={styles.actions}>
          <Button variant="outline" disabled={locked || !canWrite || Boolean(latest) || (saved?.status === "enabled" && !providerTools.available)} onClick={() => { void save(null); }}><Save size={14} />{saved ? t("保存修改", "Save changes") : t("保存草稿", "Save draft")}</Button>
          <Button variant="outline" disabled={locked || !canWrite || Boolean(latest) || blocked.length > 0 || !actionAvailable?.available} onClick={() => { void save("test"); }}><FlaskConical size={14} />{t("保存并真实试运行", "Save and run real test")}</Button>
          <Button disabled={locked || !canWrite || Boolean(latest) || blocked.length > 0 || !actionAvailable?.available || ((config.trigger.kind === "once" || config.trigger.kind === "cron") && !capabilities?.scheduler.ready)} onClick={() => { void save("enable"); }}>{saved ? t("保存并启用", "Save and enable") : t("创建并启用", "Create and enable")}</Button>
        </div>
        {!canWrite && <p className={styles.dependency}>{t("需要当前项目的编辑权限与实时能力响应。", "Current project edit permission and a live capability response are required.")}</p>}
      </section>
      {state.test && <section className={styles.section}><h2>{t("真实试运行", "Real test execution")}</h2><p>{state.test.id} · {state.test.status} · v{state.test.definitionRevision}</p>{JSON.stringify(config) !== JSON.stringify(state.test.configSnapshot) && <p className={styles.warning}>{t("配置已修改；这是旧冻结版本的试运行。", "Configuration changed; this test belongs to an older frozen version.")}</p>}<p>{state.test.error ?? state.test.summary}</p><Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void api.query(state.test!.id).then(execution => { persist({ ...live.current, test: execution }); onExecution?.(execution); }, reason => setError(String(reason))).finally(() => setBusy(false)); }}>{t("查询运行真实状态", "Query actual run status")}</Button></section>}
    </>}
    <section className={styles.assistant}>
      <h2><Sparkles size={16} />{mode === "direct" ? t("需要配置帮助？", "Need help configuring?") : t("在现有 Chat 中继续", "Continue in existing Chat")}</h2>
      <p>{t("只有点击此按钮才打开辅助 Chat；仅预填，不自动发送。用户改过的字段受保护。", "Only this explicit action opens assisted Chat. It prefills but never sends automatically. User-edited fields are protected.")}</p>
      <Button variant="outline" disabled={!onAssist || !config.projectId || scopeMismatch || locked || assisting || blocked.some(item => Object.hasOwn(template?.requires.integrations ?? {}, item.id))} onClick={() => { void assist(); }}><MessageSquare size={14} />{assisting ? t("打开中…", "Opening…") : t("打开辅助 Chat（不发送）", "Open assisted Chat (do not send)")}</Button>
      {!onAssist && <p className={styles.dependency}>{t("当前宿主未提供 Chat 打开回调。", "The host did not provide an existing-Chat callback.")}</p>}
      {renderConfiguration && <details><summary>{t("审查并应用助手结构化建议", "Review and apply structured assistant suggestions")}</summary>
        <p>{t("粘贴 Chat 返回的配置 JSON。先生成预览，再确认；已编辑字段绝不覆盖。不自动解析助手回复。", "Paste configuration JSON returned by Chat. Preview first, then confirm. Edited fields are never overwritten. Assistant replies are not parsed automatically.")}</p>
        <textarea aria-label={t("助手配置 JSON", "Assistant configuration JSON")} rows={5} value={assistantJson} disabled={locked} onChange={event => { setAssistantJson(event.target.value); setAssistantPreview(null); }} />
        <Button variant="outline" disabled={locked} onClick={() => { try { previewAssistant(parseStudioObject(assistantJson) as Partial<StudioConfig>); } catch (reason) { setError(String(reason)); } }}>{t("预览受保护的修改", "Preview protected changes")}</Button>
        {assistantPreview && <><pre>{JSON.stringify(assistantPreview, null, 2)}</pre><Button disabled={locked} onClick={applyAssistantPreview}>{t("确认应用未编辑字段", "Apply only untouched fields")}</Button></>}
      </details>}
    </section>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
  </article>;
}
