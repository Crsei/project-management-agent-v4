import { studioRequiredProviderToolFeature, type StudioCapabilities, type StudioConfig, type StudioDefinition, type StudioExecution } from "../../../../../../../../packages/contracts/src/automation-studio.ts";
import type { AutomationCatalogField, AutomationCatalogTemplate } from "../../../../../../../../packages/contracts/src/automation-catalog";
import { automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationConnection } from "../../../../../../../../packages/contracts/src/automation-integrations.ts";
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema, type PmAutomationArguments } from "../../../../../../../../packages/contracts/src/automation-pm.ts";
import { pmAutomationDefaultArguments } from "../../../../../../../../packages/automation-resources/pm-catalog.ts";

export type StudioFrequency = "manual" | "once" | "hourly" | "daily" | "weekdays" | "weekly" | "custom" | "event";
export type StudioFormValues = Record<string, string | number | boolean | null | string[] | PmAutomationArguments["repository"]>;
export type StudioPending = { requestId: string; kind: "create" | "update" | "test" | "enable" | "upload"; definitionId: string | null; expectedRevision: number | null; config: StudioConfig | null; after: "test" | "enable" | null; payload: Record<string, unknown> | null };
export type StudioDraftState = { version: 1; config: StudioConfig; baseline: StudioConfig; definition: StudioDefinition | null; values: StudioFormValues; touched: string[]; pending: StudioPending | null; test: StudioExecution | null; testPayload: string; recovery?: { optionsText: string; filterText: string; once: string; tagsText?: string; time?: string; weekday?: string } };

/** Configuration support alone is not verification: the selected execution channel must have been probed successfully. */
export function studioConnectionSupportsAction(connection: AutomationIntegrationConnection, kind: StudioConfig["action"]["kind"]): boolean {
  if (connection.status !== "verified") return false;
  if (kind === "template" && (connection.provider === "github" || connection.provider === "gitlab")) return automationIntegrationSupportsNativeApi(connection) && connection.verification?.nativeApi === true;
  return automationIntegrationSupportsMcp(connection) && Boolean(connection.mcpConfigFingerprint) && connection.verification?.mcp === true;
}
/** Model availability does not imply that this Provider can receive the required PM/connector/workspace tools. */
export function studioProviderToolReadiness(config: StudioConfig, capabilities: StudioCapabilities | null): { featureId: string | null; available: boolean; reason: string | null } {
  const featureId = studioRequiredProviderToolFeature(config);
  if (!featureId) return { featureId: null, available: true, reason: null };
  const feature = capabilities?.features?.find(item => item.id === featureId);
  return feature?.available === true
    ? { featureId, available: true, reason: null }
    : { featureId, available: false, reason: feature?.reason ?? "The selected Provider has not advertised support for the required tool adapter." };
}
export function emptyStudioConfig(projectId = ""): StudioConfig {
  return { name: "", description: "", projectId, tags: [], templateId: null, action: { kind: "prompt", providerInstanceId: "", model: "", options: {}, prompt: "", repositories: [], plugins: [], timeoutSeconds: 600 }, trigger: { kind: "manual" }, dailyLimit: 10, cooldownMinutes: 0 };
}
export function templateDefaults(template?: AutomationCatalogTemplate): StudioFormValues {
  const fields = Object.entries(template?.setup?.form.args ?? {});
  if (template && isPmAutomationTemplateId(template.id)) return { ...pmAutomationDefaultArguments(template.id) };
  return Object.fromEntries(fields.map(([key, field]) => [key, field.default ?? (field.multiple ? [] : "")]));
}
export function normalizeStudioTemplateValues(template: AutomationCatalogTemplate | undefined, values: StudioFormValues): StudioFormValues {
  const result = { ...values };
  if (template && isPmAutomationTemplateId(template.id)) {
    for (const name of ["taskIds", "statusIds", "assigneeIds", "labels"]) {
      const value = values[name];
      if (Array.isArray(value)) result[name] = value.map(item => item.trim()).filter(Boolean);
    }
    return result;
  }
  for (const [name, field] of Object.entries(template?.setup?.form.args ?? {})) {
    if (field.type !== "repo-picker") continue;
    const value = values[name];
    result[name] = Array.isArray(value) ? value.map(item => item.trim()).filter(Boolean) : typeof value === "string" ? value.trim() : value ?? "";
  }
  return result;
}
/** Omitted selectors mean project scope; explicit empty selections remain invalid, never silently widen. */
export function studioPmArguments(values: StudioFormValues): PmAutomationArguments {
  return pmAutomationArgumentsSchema.parse(values);
}
export function studioFieldIssue(field: AutomationCatalogField, value: StudioFormValues[string]): string | null {
  if (field.required && (value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length))) return "Required";
  if (value === "" || value === null || value === undefined) return null;
  const limits = field.constraints;
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number";
    if (limits?.min !== undefined && value < limits.min) return `Minimum ${limits.min}`;
    if (limits?.max !== undefined && value > limits.max) return `Maximum ${limits.max}`;
  }
  if (typeof value === "string") {
    if (limits?.minLength !== undefined && value.length < limits.minLength) return `Minimum ${limits.minLength} characters`;
    if (limits?.maxLength !== undefined && value.length > limits.maxLength) return `Maximum ${limits.maxLength} characters`;
    if (limits?.format === "safeExpressionLiteral" && /['\\\x00-\x1f]/.test(value)) return "Quotes, backslashes and control characters are not allowed here";
  }
  if (field.options && !field.options.some(option => option.value === value)) return "Select an available option";
  return null;
}
/** A whole-value placeholder retains arrays/numbers; substitutions in text are never evaluated as code. */
export function interpolateStudioTemplate(value: unknown, values: StudioFormValues): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{form\.([A-Za-z0-9_]+)\}\}$/.exec(value);
    if (whole) return values[whole[1]!] ?? "";
    return value.replace(/\{\{form\.([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
      const item = values[key] ?? "";
      return Array.isArray(item) ? JSON.stringify(item) : String(item);
    });
  }
  if (Array.isArray(value)) return value.map(item => interpolateStudioTemplate(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateStudioTemplate(item, values)]));
  return value;
}

/** JMESPath raw-string escaping, including list literals used by the pinned review template. */
export function interpolateStudioExpression(template: string, values: StudioFormValues): string {
  return template.replace(/\{\{form\.([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const value = values[key] ?? "";
    return Array.isArray(value) ? `[${value.map(item => `'${escape(item)}'`).join(", ")}]` : escape(String(value));
  });
}
export function frequencyOf(trigger: StudioConfig["trigger"]): StudioFrequency {
  if (trigger.kind !== "cron") return trigger.kind;
  const parts = trigger.expression.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  const [minute, hour, day, month, week] = parts;
  if (!/^\d+$/.test(minute!)) return "custom";
  if (hour === "*" && day === "*" && month === "*" && week === "*") return "hourly";
  if (!/^\d+$/.test(hour!) || day !== "*" || month !== "*") return "custom";
  if (week === "*") return "daily";
  if (week === "1-5") return "weekdays";
  return /^[0-6]$/.test(week!) ? "weekly" : "custom";
}
export function cronEditorClock(expression: string): { time: string; weekday: string } {
  const [minute = "", hour = "", , , week = ""] = expression.trim().split(/\s+/);
  const normalizedHour = /^\d+$/.test(hour) && Number(hour) <= 23 ? hour : "9";
  const normalizedMinute = /^\d+$/.test(minute) && Number(minute) <= 59 ? minute : "0";
  return { time: `${normalizedHour.padStart(2, "0")}:${normalizedMinute.padStart(2, "0")}`, weekday: /^[0-6]$/.test(week) ? week : "1" };
}
export function cronFor(frequency: StudioFrequency, time: string, weekday: string, expression: string): string {
  const [hour = "9", minute = "0"] = time.split(":").map(value => String(Number(value)));
  if (frequency === "hourly") return `${minute} * * * *`;
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (frequency === "weekly") return `${minute} ${hour} * * ${weekday}`;
  return expression;
}
export function localTimeInZone(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
/** A once schedule keeps its year and UTC instant. Reject nonexistent DST wall times rather than silently shifting them. */
export function onceInZone(wallTime: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wallTime)) throw new Error("Choose a complete date and time");
  const target = Date.parse(`${wallTime}:00Z`);
  let guess = target;
  for (let count = 0; count < 4; count++) {
    const observed = Date.parse(`${localTimeInZone(new Date(guess).toISOString(), timezone)}:00Z`);
    const correction = target - observed;
    if (!correction) break;
    guess += correction;
  }
  if (localTimeInZone(new Date(guess).toISOString(), timezone) !== wallTime) throw new Error("That local time does not exist in this timezone (DST)");
  return new Date(guess).toISOString();
}
export function parseStudioObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a JSON object, not an array or primitive");
  return value as Record<string, unknown>;
}
/** Typed assistant updates are limited to fields the user has never edited. Nested paths are checked individually. */
export function applyStudioAssistantPatch(config: StudioConfig, patch: Partial<StudioConfig>, touched: ReadonlySet<string>): StudioConfig {
  function merge(current: unknown, proposal: unknown, path: string): unknown {
    if (touched.has(path) || (path.startsWith("templateInputs.") && touched.has(path.replace("templateInputs.", "template.")))) return structuredClone(current);
    if (proposal === undefined) return structuredClone(current);
    if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
      let before = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
      const next = proposal as Record<string, unknown>;
      if ((path === "action" || path === "trigger") && next.kind !== undefined && next.kind !== before.kind) {
        if ([...touched].some(item => item.startsWith(`${path}.`))) return structuredClone(current);
        before = {};
      }
      const result = { ...before };
      for (const [key, value] of Object.entries(next)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Unsafe assistant configuration key");
        const child = path ? `${path}.${key}` : key;
        result[key] = merge(before[key], value, child);
      }
      return result;
    }
    if ([...touched].some(item => item.startsWith(`${path}.`))) return structuredClone(current);
    return structuredClone(proposal);
  }
  return merge(config, patch, "") as StudioConfig;
}
export function studioDraftKey(actorId: string, workspaceId: string, membershipVersion: number, editorId: string): string { return `pm.automation-studio.v1:${actorId}:${workspaceId}:${membershipVersion}:${editorId}`; }
/** Share frozen snapshots in the recovery envelope rather than storing a script bundle four times. */
export function serializeStudioDraft(state: StudioDraftState): string {
  const baselineMatchesConfig = state.baseline === state.config;
  const definitionUsesBaseline = state.definition?.config === state.baseline;
  const pendingUsesConfig = state.pending?.config === state.config;
  return JSON.stringify({
    ...state, baseline: baselineMatchesConfig ? undefined : state.baseline, baselineMatchesConfig,
    definition: state.definition ? { ...state.definition, config: definitionUsesBaseline ? undefined : state.definition.config } : null, definitionUsesBaseline,
    pending: state.pending ? { ...state.pending, config: pendingUsesConfig ? undefined : state.pending.config } : null, pendingUsesConfig,
  });
}
export function readStudioDraft(key: string): StudioDraftState | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as StudioDraftState & { baselineMatchesConfig?: boolean; definitionUsesBaseline?: boolean; pendingUsesConfig?: boolean };
  if (value.version === 1 && !value.config && value.pending?.config === null) return null;
  if (value.baselineMatchesConfig) value.baseline = value.config;
  if (value.definitionUsesBaseline && value.definition) value.definition.config = value.baseline;
  if (value.pendingUsesConfig && value.pending) value.pending.config = value.config;
  if (value.version !== 1 || !value.config || !value.baseline || !Array.isArray(value.touched) || !value.values) throw new Error("The saved local recovery draft is invalid");
  for (const config of [value.config, value.baseline]) {
    if (typeof config.name !== "string" || typeof config.projectId !== "string" || !Array.isArray(config.tags) || !config.action || !["prompt", "script", "template"].includes(config.action.kind) || !Array.isArray(config.action.repositories) || !Array.isArray(config.action.plugins) || !config.trigger || !["manual", "once", "cron", "event"].includes(config.trigger.kind)) throw new Error("The saved local recovery configuration is invalid");
  }
  return value;
}

/** Permission changes erase private drafts, but never erase the original uncertain request identity. */
export function redactStudioRecovery(actorId: string, workspaceId: string, membershipVersion: number): void {
  const prefix = `pm.automation-studio.v1:${actorId}:${workspaceId}:`;
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith(prefix) || key.startsWith(`${prefix}${membershipVersion}:`)) continue;
    const record = JSON.parse(sessionStorage.getItem(key) ?? "null") as { pending?: StudioPending } | null;
    if (record?.pending) sessionStorage.setItem(key, JSON.stringify({ version: 1, pending: { ...record.pending, config: null, payload: null, after: null } }));
    else sessionStorage.removeItem(key);
  }
}
export function studioPendingFromPriorMembership(actorId: string, workspaceId: string, membershipVersion: number, editorId: string): StudioPending | null {
  const prefix = `pm.automation-studio.v1:${actorId}:${workspaceId}:`;
  let pending: StudioPending | null = null;
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith(prefix) || !key.endsWith(`:${editorId}`)) continue;
    const record = JSON.parse(sessionStorage.getItem(key) ?? "null") as { pending?: StudioPending; config?: StudioConfig } | null;
    if (key.startsWith(`${prefix}${membershipVersion}:`) && record?.config) continue;
    if (!record?.pending) continue;
    if (pending && pending.requestId !== record.pending.requestId) throw new Error("Multiple unresolved requests require reconciliation before editing");
    pending = { ...record.pending, config: null, payload: null, after: null };
  }
  return pending;
}
export function settleStudioPriorRequest(actorId: string, workspaceId: string, requestId: string, currentKey: string): void {
  const prefix = `pm.automation-studio.v1:${actorId}:${workspaceId}:`;
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith(prefix) || key === currentKey) continue;
    const record = JSON.parse(sessionStorage.getItem(key) ?? "null") as { pending?: StudioPending } | null;
    if (record?.pending?.requestId === requestId) sessionStorage.removeItem(key);
  }
}

export function clearStudioRecovery(actorId: string, workspaceId: string): void {
  redactStudioRecovery(actorId, workspaceId, -1);
}
