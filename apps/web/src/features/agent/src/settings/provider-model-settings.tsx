import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { ProviderCustomModel, ProviderDriver, ProviderModel, ProviderModelPreferences, ProviderOptionDescriptor, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getProviderModelShortName, getProviderModelTraits, selectableProviderOptionChoices } from "@agent-workspace/client-runtime/providers";
import { useAgentText } from "../i18n";
import { RadixSelect } from "@/components/ui/radix-select"

export const emptyModelPreferences = (): ProviderModelPreferences => ({ hidden: [], order: [], favorites: [], options: {} });

export function ProviderModelSettings({ driver, models, customModels, preferences, allowCustom, onModelsChange, onPreferencesChange }: {
  driver: ProviderDriver;
  models: ProviderModel[];
  customModels: ProviderCustomModel[];
  preferences: ProviderModelPreferences;
  allowCustom: boolean;
  onModelsChange: (models: ProviderCustomModel[]) => void;
  onPreferencesChange: (preferences: ProviderModelPreferences) => void;
}) {
  const t = useAgentText();
  const byId = new Map(models.filter((model) => model.source !== "custom").map((model) => [model.id, model]));
  for (const model of customModels) if (model.id) {
    const known = byId.get(model.id) ?? models.find((entry) => entry.id === model.id);
    byId.set(model.id, { ...known, ...model, source: "custom", temperature: known?.temperature ?? false, capabilities: model.capabilities ?? known?.capabilities });
  }
  const ids = [...preferences.order.filter((id) => byId.has(id)), ...[...byId.keys()].filter((id) => !preferences.order.includes(id))];
  const toggle = (key: "hidden" | "favorites", id: string) => onPreferencesChange({ ...preferences, [key]: preferences[key].includes(id) ? preferences[key].filter((item) => item !== id) : [...preferences[key], id] });
  const move = (id: string, delta: number) => {
    const order = [...ids, ...preferences.order.filter((id) => !byId.has(id))];
    const index = order.indexOf(id), target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    onPreferencesChange({ ...preferences, order });
  };
  const updateModel = (index: number, patch: Partial<ProviderCustomModel>) => onModelsChange(customModels.map((model, i) => i === index ? { ...model, ...patch } : model));
  const setDescriptors = (index: number, descriptors: ProviderOptionDescriptor[]) => updateModel(index, { capabilities: { ...customModels[index]?.capabilities, optionDescriptors: descriptors } });
  const changeOption = (modelId: string, option: ProviderOptionDescriptor, value: string) => {
    const selections = (preferences.options[modelId] ?? []).filter((entry) => entry.id !== option.id).map((entry) => ({ ...entry }));
    if (value !== "") selections.push({ id: option.id, value: option.type === "boolean" ? value === "true" : value });
    onPreferencesChange({ ...preferences, options: { ...preferences.options, [modelId]: selections } });
  };
  const removeInvalidOption = (modelId: string, selection: ProviderOptionSelection) => {
    const selections = [...(preferences.options[modelId] ?? [])];
    const index = selections.indexOf(selection);
    if (index < 0) return;
    selections.splice(index, 1);
    onPreferencesChange({ ...preferences, options: { ...preferences.options, [modelId]: selections } });
  };
  return <section className="provider-settings-section" aria-label={t("模型", "Models")}>
    <h3>{t("模型", "Models")}</h3><div className="provider-settings-group provider-models">
      {ids.map((id, index) => {
        const model = byId.get(id)!;
        const traits = getProviderModelTraits({ driver, model, options: preferences.options[id] });
        const shortName = getProviderModelShortName(driver, model);
        return <div className="provider-model-row" key={id}>
        <div><span>{model.label}</span>{model.badge === "new" && <span className="provider-model-capability">{t("新", "New")}</span>}<code>{id}</code>{(shortName || model.subProvider) && <small className="provider-model-metadata">{[shortName, model.subProvider].filter(Boolean).join(" · ")}</small>}<small>{model.disabledReason ?? (model.legacy ? t("旧版模型", "Legacy model") : model.source === "custom" ? t("自定义", "Custom") : model.source === "discovered" ? t("已发现", "Discovered") : t("内置", "Built-in"))}</small>
          {traits.descriptors.map((option) => {
            const selection = preferences.options[id]?.find((entry) => entry.id === option.id);
            const choices = option.type === "select" ? selectableProviderOptionChoices(option) : [];
            const invalid = selection && (option.type === "boolean" ? typeof selection.value !== "boolean" : typeof selection.value !== "string" || !choices.some((choice) => choice.id === selection.value));
            return <label className="provider-model-option" key={option.id}>{option.label}
              <RadixSelect value={selection ? String(selection.value) : ""} aria-invalid={Boolean(invalid)} title={option.description} onChange={(event) => changeOption(id, option, event.target.value)}>
                <option value="">{t("原生默认", "Native default")}</option>
                {invalid && <option value={String(selection.value)} disabled>{String(selection.value)}{t("（已失效）", " (invalid)")}</option>}
                {option.type === "boolean" ? <><option value="true">{t("开", "On")}</option><option value="false">{t("关", "Off")}</option></> : choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </RadixSelect>
            </label>;
          })}
          {traits.invalidOptions.map((selection, optionIndex) => <div key={optionIndex} className="provider-model-invalid-option" role="alert"><span>{t("已保存选项失效：", "Saved option is invalid: ")}<code>{selection.id} = {String(selection.value)}</code></span><Button type="button" size="sm" variant="ghost" onClick={() => removeInvalidOption(id, selection)}>{t("移除此选项", "Remove this option")}</Button></div>)}
        </div>
        <label><input type="checkbox" checked={!preferences.hidden.includes(id)} onChange={() => toggle("hidden", id)} />{t("显示", "Show")}</label>
        <label><input type="checkbox" checked={preferences.favorites.includes(id)} onChange={() => toggle("favorites", id)} />{t("收藏", "Favorite")}</label>
        <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => move(id, -1)} aria-label={t(`上移 ${model.label}`, `Move ${model.label} up`)}>↑</Button><Button type="button" size="sm" variant="ghost" disabled={index === ids.length - 1} onClick={() => move(id, 1)} aria-label={t(`下移 ${model.label}`, `Move ${model.label} down`)}>↓</Button>
      </div>; })}
      {!ids.length && <p className="provider-section-note">{t("没有可展示的模型。请先配置并检查 Agent。", "No models to show. Configure and check the Agent first.")}</p>}
      {allowCustom && <div className="provider-custom-models"><Button type="button" size="sm" variant="outline" disabled={customModels.length >= 100} onClick={() => onModelsChange([...customModels, { id: "", label: "" }])}>{t("添加自定义模型", "Add custom model")}</Button>
        {customModels.map((model, index) => <div className="provider-custom-model" key={index}><div className="provider-custom-model-fields"><Input aria-label={t(`自定义模型 ID ${index + 1}`, `Custom model ID ${index + 1}`)} placeholder={t("模型 ID", "Model ID")} value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} /><Input aria-label={t(`自定义模型名称 ${index + 1}`, `Custom model name ${index + 1}`)} placeholder={t("显示名称", "Display name")} value={model.label} onChange={(event) => updateModel(index, { label: event.target.value })} /><Button type="button" variant="ghost" size="sm" onClick={() => { if (window.confirm(t("移除此模型？引用该模型的设置和会话可能需要重新选择。", "Remove this model? Settings and sessions that reference it may need to be reselected."))) onModelsChange(customModels.filter((_, i) => i !== index)); }}>{t("移除", "Remove")}</Button></div>
          <details><summary>{t("模型能力选项", "Model capability options")}</summary>{(model.capabilities?.optionDescriptors ?? []).map((option, optionIndex, descriptors) => <div className="provider-custom-option" key={optionIndex}>
            <Input aria-label={t("选项 ID", "Option ID")} placeholder={t("选项 ID", "Option ID")} value={option.id} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...entry, id: event.target.value } : entry))} />
            <Input aria-label={t("选项名称", "Option name")} placeholder={t("选项名称", "Option name")} value={option.label} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...entry, label: event.target.value } : entry))} />
            <Input aria-label={t("选项说明", "Option description")} placeholder={t("选项说明（可选）", "Option description (optional)")} value={option.description ?? ""} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...entry, description: event.target.value || undefined } : entry))} />
            <RadixSelect aria-label={t("选项类型", "Option type")} value={option.type} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i !== optionIndex ? entry : event.target.value === "boolean" ? { id: entry.id, label: entry.label, type: "boolean" } : { id: entry.id, label: entry.label, type: "select", options: [] }))}><option value="select">{t("选择", "Select")}</option><option value="boolean">{t("开关", "Toggle")}</option></RadixSelect>
            {option.type === "boolean" ? <label>{t("当前默认值", "Current default")} <RadixSelect value={option.currentValue === undefined ? "" : String(option.currentValue)} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, currentValue: event.target.value === "" ? undefined : event.target.value === "true" } : entry))}><option value="">{t("原生默认", "Native default")}</option><option value="true">{t("开", "On")}</option><option value="false">{t("关", "Off")}</option></RadixSelect></label> : <>
              {option.options.map((choice, choiceIndex) => <div className="provider-custom-model-fields" key={choiceIndex}>
                <Input aria-label={t("值 ID", "Value ID")} placeholder={t("值 ID", "Value ID")} value={choice.id} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: option.options.map((value, j) => j === choiceIndex ? { ...value, id: event.target.value } : value) } : entry))} />
                <Input aria-label={t("值名称", "Value name")} placeholder={t("值名称", "Value name")} value={choice.label} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: option.options.map((value, j) => j === choiceIndex ? { ...value, label: event.target.value } : value) } : entry))} />
                <Input aria-label={t("值说明", "Value description")} placeholder={t("值说明（可选）", "Value description (optional)")} value={choice.description ?? ""} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: option.options.map((value, j) => j === choiceIndex ? { ...value, description: event.target.value || undefined } : value) } : entry))} />
                <label><input type="radio" name={`${index}-${optionIndex}-default`} checked={choice.isDefault === true} onChange={() => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: option.options.map((value, j) => ({ ...value, isDefault: j === choiceIndex })) } : entry))} />{t("默认", "Default")}</label>
                <label><input type="checkbox" checked={option.promptInjectedValues?.includes(choice.id) ?? false} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, promptInjectedValues: event.target.checked ? [...(option.promptInjectedValues ?? []), choice.id] : (option.promptInjectedValues ?? []).filter((id) => id !== choice.id) } : entry))} />{t("提示注入", "Prompt injection")}</label>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: option.options.filter((_, j) => j !== choiceIndex), currentValue: option.currentValue === choice.id ? undefined : option.currentValue, promptInjectedValues: option.promptInjectedValues?.filter((id) => id !== choice.id) } : entry))}>{t("移除值", "Remove value")}</Button>
              </div>)}
              <Button type="button" size="sm" variant="outline" onClick={() => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, options: [...option.options, { id: "", label: "" }] } : entry))}>{t("添加值", "Add value")}</Button>
              <label>{t("当前值", "Current value")} <RadixSelect value={option.currentValue ?? ""} onChange={(event) => setDescriptors(index, descriptors.map((entry, i) => i === optionIndex ? { ...option, currentValue: event.target.value || undefined } : entry))}><option value="">{t("原生默认", "Native default")}</option>{option.options.map((choice, i) => <option key={i} value={choice.id}>{choice.label}</option>)}</RadixSelect></label>
            </>}
            <Button type="button" size="sm" variant="ghost" onClick={() => setDescriptors(index, descriptors.filter((_, i) => i !== optionIndex))}>{t("移除选项", "Remove option")}</Button>
          </div>)}<Button type="button" size="sm" variant="outline" onClick={() => setDescriptors(index, [...(model.capabilities?.optionDescriptors ?? []), { id: "", label: "", type: "select", options: [] }])}>{t("添加能力选项", "Add capability option")}</Button></details>
        </div>)}
      </div>}
    </div>
  </section>;
}
