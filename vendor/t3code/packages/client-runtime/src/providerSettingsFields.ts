// Browser-safe extraction of apps/web/src/components/settings/ProviderSettingsForm.tsx
// at 30eb7e7bb1. Rendering and schema decoding stay with their respective hosts.
import * as Schema from "effect/Schema";
import {
  isSecretSetting,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
} from "@t3tools/contracts";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

export type SettingsFormDefinition = Pick<ProviderClientDefinition, "settingsSchema"> & {
  readonly driverKind?: ProviderClientDefinition["driverKind"];
};

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly secret?: boolean | undefined;
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value: unknown = Reflect.get(config, key);
  return typeof value === "string" ? value : "";
}

export function deriveProviderSettingsFields(
  definition: SettingsFormDefinition,
  value?: unknown,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const isLocalAcp = definition.driverKind === "acpRegistry" && readProviderConfigString(value, "source") === "local";
  const schemaAnnotation = Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
  const orderedKeys = new Map((schemaAnnotation.order ?? []).map((key, index) => [key, index] as const));
  const orderFallbackOffset = orderedKeys.size;
  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) =>
      (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
      (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index))
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const annotations = Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
      const formAnnotation = annotations?.providerSettingsForm ?? {};
      if (formAnnotation.hidden) return [];
      if (isLocalAcp && key !== "source" && key !== "commandPath") return [];
      const title = annotations?.title;
      const description = annotations?.description;
      return [{
        key,
        control: formAnnotation.control ?? "text",
        label: isLocalAcp && key === "commandPath" ? "Executable" : typeof title === "string" ? title : titleizeFieldKey(key),
        ...(isLocalAcp && key === "commandPath"
          ? { description: "Executable name or path on this environment." }
          : typeof description === "string" ? { description } : {}),
        ...(isLocalAcp && key === "commandPath"
          ? { placeholder: "e.g. dsh" }
          : formAnnotation.placeholder !== undefined ? { placeholder: formAnnotation.placeholder } : {}),
        clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
        ...(isSecretSetting(fieldSchema) ? { secret: true } : {}),
        ...(formAnnotation.control === "select" && formAnnotation.options ? { options: formAnnotation.options } : {}),
      } satisfies ProviderSettingsFieldModel];
    });
}
