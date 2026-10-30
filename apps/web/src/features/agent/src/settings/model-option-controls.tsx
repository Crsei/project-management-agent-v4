import type { ProviderInstance, ProviderModel, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { selectableProviderOptionChoices } from "@agent-workspace/client-runtime/providers";
import { useAgentText } from "../i18n";

/** Native session readiness is authoritative; account identity is independent. */
export function providerSelectable(provider: ProviderInstance | undefined): boolean {
  return provider?.enabled === true && provider.nativeSessionReady === true;
}

/** Catalog ordering and visibility are instance-scoped, not browser preferences. */
export function visibleProviderModels(provider: ProviderInstance): ProviderModel[] {
  const preferences = provider.modelPreferences;
  const order = new Map((preferences?.order ?? []).map((id, index) => [id, index]));
  return provider.models.filter((model) => !preferences?.hidden.includes(model.id))
    .map((model, index) => ({ model, index }))
    .sort((a, b) => (order.get(a.model.id) ?? Infinity) - (order.get(b.model.id) ?? Infinity) || a.index - b.index)
    .map(({ model }) => model);
}

export function modelOptionsValid(model: ProviderModel | undefined, selections: ProviderOptionSelection[] | undefined): boolean {
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const ids = new Set<string>();
  return (selections ?? []).every(({ id, value }) => {
    if (ids.has(id)) return false;
    ids.add(id);
    const descriptor = descriptors.find((entry) => entry.id === id);
    return descriptor?.type === "boolean" ? typeof value === "boolean"
      : descriptor?.type === "select" ? typeof value === "string" && descriptor.options.some((option) => option.id === value)
      : false;
  });
}

export function ModelOptionControls({ model, selections, disabled, onChange }: {
  model?: ProviderModel;
  selections?: ProviderOptionSelection[];
  disabled?: boolean;
  onChange: (selections: ProviderOptionSelection[]) => void;
}) {
  const t = useAgentText();
  const update = (id: string, value: string | boolean | undefined) => {
    const next = (selections ?? []).filter((selection) => selection.id !== id);
    if (value !== undefined) next.push({ id, value });
    onChange(next);
  };
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  return <div className="flex flex-wrap gap-3">
    {descriptors.map((descriptor) => {
      const saved = selections?.find((entry) => entry.id === descriptor.id);
      if (descriptor.type === "boolean") {
        const valid = !saved || typeof saved.value === "boolean";
        return <label key={descriptor.id} className="flex flex-col gap-1 text-sm" title={descriptor.description}>
          <span>{descriptor.label}</span><select aria-label={descriptor.label} disabled={disabled} value={saved ? String(saved.value) : "default"} onChange={(event) => update(descriptor.id, event.target.value === "default" ? undefined : event.target.value === "true")}>
            <option value="default">{t("默认", "Default")}{descriptor.currentValue === undefined ? "" : descriptor.currentValue ? t("（开启）", " (on)") : t("（关闭）", " (off)")}</option>
            {!valid && <option value={String(saved?.value)}>{t("不可用：", "Unavailable: ")}{String(saved?.value)}</option>}
            <option value="true">{t("开启", "On")}</option><option value="false">{t("关闭", "Off")}</option>
          </select>{descriptor.description && <small>{descriptor.description}</small>}
        </label>;
      }
      const current = descriptor.options.find((option) => option.id === descriptor.currentValue) ?? descriptor.options.find((option) => option.isDefault);
      const valid = !saved || typeof saved.value === "string" && descriptor.options.some((option) => option.id === saved.value);
      return <label key={descriptor.id} className="flex flex-col gap-1 text-sm" title={descriptor.description}>
        <span>{descriptor.label}</span><select aria-label={descriptor.label} disabled={disabled} value={saved ? String(saved.value) : ""} onChange={(event) => update(descriptor.id, event.target.value || undefined)}>
          <option value="">{t("默认", "Default")}{current ? ` (${current.label})` : ""}</option>
          {!valid && <option value={String(saved?.value)}>{t("不可用：", "Unavailable: ")}{String(saved?.value)}</option>}
          {selectableProviderOptionChoices(descriptor).map((option) => <option key={option.id} value={option.id} title={option.description}>{option.label}</option>)}
        </select>{descriptor.description && <small>{descriptor.description}</small>}
      </label>;
    })}
    {!modelOptionsValid(model, selections) && <p role="alert" className="text-destructive text-xs">{t("保存的模型选项已不可用，请重新选择。", "Saved model options are unavailable; select again.")} <button type="button" disabled={disabled} className="underline" onClick={() => onChange([])}>{t("清除选项", "Clear options")}</button></p>}
  </div>;
}
