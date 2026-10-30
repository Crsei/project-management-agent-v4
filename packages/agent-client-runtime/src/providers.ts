import type {
  ProviderConfig, ProviderConfigField, ProviderDriver, ProviderDriverDefinition,
  ProviderInstance, ProviderModel, ProviderOptionDescriptor, ProviderOptionSelection,
} from "@agent-workspace/contracts/provider";
import { ProviderDriverKind, ProviderInstanceId, secretSettingsFields } from "@t3tools/contracts";
import { getProviderClient as getOriginalProviderClient, resolveModelShortName } from "@t3tools/client-runtime/providerClients";
import { deriveProviderSettingsFields } from "@t3tools/client-runtime/providerSettingsFields";
import { formatProviderUpdateRequiredNotice as formatOriginalUpdateNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import {
  buildTraitsTriggerDisplay, getPromptControlledTraits, replaceDescriptorCurrentValue,
} from "@t3tools/client-runtime/modelTraits";
import { resolveProviderInstanceDisplayName, shouldShowInstanceBadge } from "@t3tools/client-runtime/state/providerInstanceDisplay";
import * as Schema from "effect/Schema";

export {
  normalizeProviderAccentColor, providerAccentForegroundColor, providerInstanceInitials,
} from "@t3tools/client-runtime/state/providerInstanceDisplay";
export {
  getDescriptorStringValue, getPromptControlledTraits, getTraitSelectChange,
  REASONING_SELECT_DESCRIPTOR_IDS, selectableProviderOptionChoices, ULTRATHINK_PROMPT_PREFIX,
} from "@t3tools/client-runtime/modelTraits";
export type { ProviderIcon } from "@t3tools/provider-core/client";

/** Translate family names only; never rewrite a persisted instance identifier. */
export function getProviderDriverKind(driver: ProviderDriver): ProviderDriverKind {
  return ProviderDriverKind.make(driver === "claude" ? "claudeAgent" : driver);
}

export function getProviderClient(driver: ProviderDriver | null | undefined) {
  return driver ? getOriginalProviderClient(getProviderDriverKind(driver)) : undefined;
}

export function getProviderSettingsFields(driver: ProviderDriver, config?: ProviderConfig): ProviderConfigField[] {
  const client = getProviderClient(driver);
  if (!client) throw new Error(`Missing original Provider client: ${driver}.`);
  return deriveProviderSettingsFields(client, config).map(field => ({
    key: field.key, label: field.label, control: field.control,
    type: field.secret ? "password" : field.control === "select" ? "select" : field.control === "switch" ? "boolean" : "string",
    clearWhenEmpty: field.clearWhenEmpty,
    ...(field.secret ? { secret: true } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    ...(field.options ? { options: field.options.map(option => ({ ...option })) } : {}),
  }));
}

export function getProviderSecretConfigKeys(driver: ProviderDriver): readonly string[] {
  const client = getProviderClient(driver);
  if (!client) throw new Error(`Missing original Provider client: ${driver}.`);
  return secretSettingsFields(client.settingsSchema);
}

type HostProviderDefinition = Omit<ProviderDriverDefinition,
  "label" | "defaultInstance" | "fields" | "clientDriver" | "modelFamilies" | "icon" |
  "badgeLabel" | "featured" | "environmentFields" | "acpRegistryAgentIds">;

/** Source owns family/schema/branding metadata; PM owns installation and security boundaries. */
export function withProviderClientMetadata(definition: HostProviderDefinition): ProviderDriverDefinition {
  const client = getProviderClient(definition.driver);
  if (!client) throw new Error(`Missing original Provider client: ${definition.driver}.`);
  return {
    ...definition,
    label: client.label, defaultInstance: client.hasDefaultInstance !== false,
    fields: getProviderSettingsFields(definition.driver), clientDriver: client.driverKind,
    modelFamilies: client.modelFamilies ?? [],
    ...(client.icon ? { icon: client.icon } : {}),
    ...(client.badgeLabel ? { badgeLabel: client.badgeLabel } : {}),
    ...(client.featured !== undefined ? { featured: client.featured } : {}),
    ...(client.environmentFields ? { environmentFields: client.environmentFields } : {}),
    ...(client.acpRegistryAgentIds ? { acpRegistryAgentIds: [...client.acpRegistryAgentIds] } : {}),
  };
}

export function getProviderModelShortName(driver: ProviderDriver, model: Pick<ProviderModel, "label" | "shortName">): string | undefined {
  return resolveModelShortName({ name: model.label, shortName: model.shortName }, getProviderDriverKind(driver));
}

export function getProviderInstanceDisplayName(instance: Pick<ProviderInstance, "instanceId" | "driver" | "label">): string {
  const driver = getProviderDriverKind(instance.driver);
  // Historical PM IDs remain readable even when they cannot enter the native registry.
  if (!Schema.is(ProviderInstanceId)(instance.instanceId)) return instance.label.trim() || instance.instanceId;
  return resolveProviderInstanceDisplayName({
    driver, displayName: instance.label,
    instanceId: ProviderInstanceId.make(instance.instanceId === instance.driver ? driver : instance.instanceId),
  });
}

type ProviderBadgeInstance = Pick<ProviderInstance, "driver" | "enabled" | "accentColor" | "config">;

export function shouldShowProviderInstanceBadge(entry: ProviderBadgeInstance, entries: readonly ProviderBadgeInstance[]): boolean {
  const badgeEntry = (instance: ProviderBadgeInstance) => ({
    driverKind: getProviderDriverKind(instance.driver),
    enabled: instance.enabled,
    ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
    ...(typeof instance.config.agentId === "string" ? { acpRegistryAgentId: instance.config.agentId } : {}),
  });
  return shouldShowInstanceBadge(badgeEntry(entry), entries.map(badgeEntry));
}

export function formatProviderUpdateRequiredNotice(provider: Pick<ProviderInstance, "driver" | "updateRequiredModels">, searchQuery = ""): string | null {
  return formatOriginalUpdateNotice({
    driver: getProviderDriverKind(provider.driver),
    ...(provider.updateRequiredModels ? { updateRequiredModels: provider.updateRequiredModels.map(model => ({ slug: model.id, name: model.label, minVersion: model.minVersion })) } : {}),
  }, searchQuery);
}

export type ProviderModelSelectionState =
  | { status: "unselected-provider" }
  | { status: "missing-provider"; instanceId: string }
  | { status: "disabled-provider" | "unselected-model"; provider: ProviderInstance }
  | { status: "missing-model"; provider: ProviderInstance; modelId: string }
  | { status: "disabled-model" | "selected"; provider: ProviderInstance; model: ProviderModel };

/** Never pick the first/default model or replace a historical missing selection. */
export function resolveProviderModelSelection(
  providers: readonly ProviderInstance[], instanceId: string | null | undefined, modelId: string | null | undefined,
): ProviderModelSelectionState {
  if (!instanceId) return { status: "unselected-provider" };
  const provider = providers.find(entry => entry.instanceId === instanceId);
  if (!provider) return { status: "missing-provider", instanceId };
  if (!provider.enabled) return { status: "disabled-provider", provider };
  if (!modelId) return { status: "unselected-model", provider };
  const model = provider.models.find(entry => entry.id === modelId || entry.aliases?.includes(modelId));
  if (!model) return { status: "missing-model", provider, modelId };
  return { status: model.disabledReason ? "disabled-model" : "selected", provider, model };
}

export function getProviderModelTraits(input: {
  driver: ProviderDriver;
  model: ProviderModel;
  options?: readonly ProviderOptionSelection[];
  prompt?: string;
}) {
  let descriptors: readonly ProviderOptionDescriptor[] = input.model.capabilities?.optionDescriptors ?? [];
  const invalidOptions: ProviderOptionSelection[] = [];
  const seen = new Set<string>();
  for (const selection of input.options ?? []) {
    const descriptor = descriptors.find(entry => entry.id === selection.id);
    if (seen.has(selection.id) || !descriptor || (descriptor.type === "boolean"
      ? typeof selection.value !== "boolean"
      : typeof selection.value !== "string" || !descriptor.options.some(option => option.id === selection.value))) {
      invalidOptions.push(selection);
    } else {
      descriptors = replaceDescriptorCurrentValue(descriptors, selection.id, selection.value);
    }
    seen.add(selection.id);
  }
  const promptTraits = getPromptControlledTraits(descriptors, input.prompt ?? "");
  return {
    descriptors, invalidOptions, ...promptTraits,
    ...buildTraitsTriggerDisplay({
      provider: getProviderDriverKind(input.driver), descriptors,
      primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
      ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
    }),
  };
}
