"use client";

import { useState } from "react";
import { LayersIcon, XIcon } from "lucide-react";
import type { ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { ComposerModelPicker, type ComposerModelPickerProps } from "@agent/components/assistant-ui/elements/composer-model-picker.aui";
import { useAgentText } from "../i18n";
import type { FanoutModelSelection } from "./model-fanout";
import {
  beginFanoutStacking,
  exitFanoutStacking,
  fanoutModelAvailability,
  fanoutPickerActive,
  fanoutPickerCandidate,
  fanoutPickerCapacity,
  fanoutPickerSingle,
  toggleFanoutPickerModel,
  type ModelFanoutPickerState,
} from "./model-fanout-picker-model";
import "./model-fanout-picker.css";

export type ModelFanoutPickerProps = Omit<ComposerModelPickerProps, "selectedModels" | "onToggleModel"> & {
  /** Receives active stacked selections, or null when the picker returns to single-model mode. */
  onFanoutChange?: (selections: FanoutModelSelection[] | null) => void;
  /** Options that belong to the model checked when stacking begins; newly stacked models use provider defaults. */
  modelOptions?: ProviderOptionSelection[];
};

/**
 * Wraps the single-model picker with an explicit stacking mode. The underlying
 * picker keeps its single-select contract whenever stacking has not started.
 */
export function ModelFanoutPicker({ onFanoutChange, modelOptions, ...picker }: ModelFanoutPickerProps) {
  const t = useAgentText();
  const [state, setState] = useState<ModelFanoutPickerState>(() => fanoutPickerSingle({
    providerInstanceId: picker.providerInstanceId,
    model: picker.model,
    ...(modelOptions ? { modelOptions } : {}),
  }));
  const [limitNotice, setLimitNotice] = useState(false);
  const capacity = fanoutPickerCapacity(state.selections);
  const active = fanoutPickerActive(state);

  const enterStacking = () => {
    setLimitNotice(false);
    setState((current) => current.mode === "stacking" ? current : beginFanoutStacking({
      providerInstanceId: picker.providerInstanceId,
      model: picker.model,
      ...(modelOptions ? { modelOptions } : {}),
    }));
  };
  const exitStacking = () => {
    const next = exitFanoutStacking(state);
    setLimitNotice(false);
    setState(next);
    onFanoutChange?.(null);
    if (next.single.providerInstanceId !== picker.providerInstanceId || next.single.model !== picker.model) {
      void picker.onChange(next.single.providerInstanceId, next.single.model);
    }
  };
  const toggleStacked = (selection: FanoutModelSelection) => {
    const provider = picker.catalog.providers.find((entry) => entry.instanceId === selection.providerInstanceId);
    if (fanoutModelAvailability(provider, selection.model) !== "available") return;
    const outcome = toggleFanoutPickerModel(state, fanoutPickerCandidate(
      state.selections,
      selection,
      { providerInstanceId: picker.providerInstanceId, model: picker.model, ...(modelOptions ? { modelOptions } : {}) },
    ));
    setLimitNotice(outcome.limitReached);
    if (!outcome.changed) return;
    setState(outcome.state);
    if (outcome.state.mode === "stacking") {
      if (outcome.state.selections.length >= 2) onFanoutChange?.([...outcome.state.selections]);
      return;
    }
    onFanoutChange?.(null);
    if (outcome.state.single.providerInstanceId !== picker.providerInstanceId || outcome.state.single.model !== picker.model) {
      void picker.onChange(outcome.state.single.providerInstanceId, outcome.state.single.model);
    }
  };

  return <div className="model-fanout-picker" data-fanout-active={active ? "true" : undefined}>
    <ComposerModelPicker
      {...picker}
      {...(state.mode === "stacking" ? { selectedModels: state.selections, onToggleModel: toggleStacked } : {})}
    />
    {state.mode === "single"
      ? <button type="button" className="model-fanout-picker-enter" disabled={picker.disabled || !picker.model} aria-label={t("叠选多个模型并行发送", "Stack multiple models for one message")} title={t("叠选多个模型并行发送", "Stack multiple models for one message")} onClick={enterStacking}>
        <LayersIcon aria-hidden="true" />
        <span>{t("多选", "Stack")}</span>
      </button>
      : <div className="model-fanout-picker-status">
        <span role="status" aria-live="polite" className="model-fanout-picker-count">
          {capacity.atLimit
            ? t(`已叠选 ${capacity.count}/${capacity.limit}，已达上限`, `${capacity.count}/${capacity.limit} stacked, limit reached`)
            : t(`已叠选 ${capacity.count}/${capacity.limit}`, `${capacity.count}/${capacity.limit} stacked`)}
        </span>
        {!active && <span className="model-fanout-picker-hint">{t("再选一个模型即可并行", "Select one more model to fan out")}</span>}
        {active && !capacity.atLimit && <span className="model-fanout-picker-hint">{t(`最多 ${capacity.limit} 个模型`, `Up to ${capacity.limit} models`)}</span>}
        {limitNotice && <span role="alert" className="model-fanout-picker-limit">{t("已达叠选上限，请先取消一个模型。", "Stack limit reached; remove a model first.")}</span>}
        <button type="button" className="model-fanout-picker-exit" aria-label={t("退出多选，回到单选模型", "Exit stacking and return to a single model")} title={t("退出多选，回到单选模型", "Exit stacking and return to a single model")} onClick={exitStacking}>
          <XIcon aria-hidden="true" />
          <span>{t("退出多选", "Exit stacking")}</span>
        </button>
      </div>}
  </div>;
}
