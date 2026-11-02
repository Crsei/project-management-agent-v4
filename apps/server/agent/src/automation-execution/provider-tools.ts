import { studioNativeTemplateRequiresWorkspace, type StudioConfig } from '../../../../../packages/contracts/src/automation-studio.ts';
import { getStoredInstance } from '../providers/instances.ts';
import { isPmAutomationTemplateId } from '../../../../../packages/contracts/src/automation-pm.ts';
import { pmAutomationTemplateRequiresProvider } from '../../../../../packages/contracts/src/automation-pm-catalog.ts';
import { pmAnalysisProviderSupport } from './native-templates/pm-analysis-policy.ts';

export type AutomationProviderToolRequirement = 'promptConnectors' | 'templateWorkspace';
export type AutomationProviderToolAvailability = { available: boolean; reason: string | null };
export type AutomationProviderToolSupport = Record<AutomationProviderToolRequirement, AutomationProviderToolAvailability>;
const supported = (): AutomationProviderToolAvailability => ({ available: true, reason: null });
const unsupported = (reason: string): AutomationProviderToolAvailability => ({ available: false, reason });
/** Actual adapter transport AND unattended host-tool admission, not a generic “supports MCP” claim. */
export function getAutomationProviderToolSupport(driver: string): AutomationProviderToolSupport {
  switch (driver) {
    // Codex projects every bound stdio descriptor. These ACP families use the
    // generic per-generation MCP/ACP bridge with live host authorization.
    case 'codex': case 'antigravity': case 'grok': case 'fx': case 'acpRegistry':
      return { promptConnectors: supported(), templateWorkspace: supported() };
    case 'opencode':
      return { promptConnectors: unsupported('OpenCode accepts only one generation-scoped host transport. A prompt already uses the PM tools bridge, so an additional integration descriptor is unsupported.'), templateWorkspace: supported() };
    case 'omp': {
      const reason = 'OMP currently accepts only the single legacy pm_tools loopback bridge, not automation integration or scratch-workspace MCP descriptors. Select a compatible Provider; model-only templates remain usable.';
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
    case 'pi': {
      const reason = 'Pi currently requires the single generation-owned pm_tools extension and legacy loopback endpoint. Automation integration and scratch-workspace descriptors are unsupported; model-only templates remain usable.';
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
    case 'cursor': {
      const reason = 'Cursor host tools currently admit only the pm_tools server and pm_* tool names. Automation integration and scratch-workspace descriptors are not admitted; model-only templates remain usable.';
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
    case 'claude': {
      const reason = 'Claude’s current unattended host-tool approval path authorizes only mcp__pm_tools__* calls. Generic automation MCP calls require approvals that this runtime declines; model-only templates remain usable.';
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
    case 'muse': {
      const reason = 'Muse’s current unattended host-tool approval path authorizes only the legacy pm_tools pm_* calls. Generic automation integration and scratch tools are not preauthorized; model-only templates remain usable.';
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
    default: {
      const reason = `Provider driver ${driver} has no verified automation MCP descriptor/admission mapping. Select a compatible Provider.`;
      return { promptConnectors: unsupported(reason), templateWorkspace: unsupported(reason) };
    }
  }
}
export function assertAutomationProviderToolRequirement(providerInstanceId: string | null, requirement: AutomationProviderToolRequirement): void {
  const instance = providerInstanceId ? getStoredInstance(providerInstanceId) : null;
  if (!instance?.enabled) throw new Error('Select an enabled Provider instance for this automation tool requirement.');
  const capability = getAutomationProviderToolSupport(instance.driver)[requirement];
  if (!capability.available) throw Object.assign(new Error(capability.reason ?? 'Selected Provider does not support the required automation tools.'), { code: 'provider_automation_tools_unsupported', status: 412 });
}
export function assertAutomationProviderToolSupport(config: StudioConfig): void {
  const action = config.action;
  if (action.kind === 'prompt' && action.plugins.length) assertAutomationProviderToolRequirement(action.providerInstanceId, 'promptConnectors');
  else if (action.kind === 'template' && studioNativeTemplateRequiresWorkspace(action.templateId)) assertAutomationProviderToolRequirement(action.providerInstanceId, 'templateWorkspace');
  else if (action.kind === 'template' && isPmAutomationTemplateId(action.templateId) && pmAutomationTemplateRequiresProvider(action.templateId)) {
    const instance = action.providerInstanceId ? getStoredInstance(action.providerInstanceId) : null;
    if (!instance?.enabled) throw new Error('PM semantic analysis requires an explicitly selected enabled Provider.');
    const support = pmAnalysisProviderSupport(instance.driver);
    if (!support.available) throw Object.assign(new Error(support.reason!), { code: 'provider_pm_analysis_unsupported', status: 412 });
  }
}
