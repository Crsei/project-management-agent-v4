import type { ProviderDriver, ProviderModel, ProviderOptionSelection } from "@agent-workspace/contracts/provider";
import { getProviderModelTraits, getTraitSelectChange, selectableProviderOptionChoices } from "@agent-workspace/client-runtime/providers";

type TraitChangeInput = {
  driver: ProviderDriver;
  model: ProviderModel;
  selections?: readonly ProviderOptionSelection[];
  prompt: string;
  id: string;
  value: string | boolean;
};

/** Native prompt semantics, with PM's explicit-only persisted option ownership. */
export function getComposerTraitChange(input: TraitChangeInput): { prompt: string; modelOptions?: ProviderOptionSelection[] } | null {
  const traits = getProviderModelTraits({ driver: input.driver, model: input.model, options: input.selections, prompt: input.prompt });
  const descriptor = traits.descriptors.find((entry) => entry.id === input.id);
  if (!descriptor) return null;
  const retained = () => (input.selections ?? []).filter((selection) => selection.id !== descriptor.id).map((selection) => ({ ...selection }));
  if (descriptor.type === "boolean") {
    if (typeof input.value !== "boolean") return null;
    return { prompt: input.prompt, modelOptions: [...retained(), { id: descriptor.id, value: input.value }] };
  }
  if (typeof input.value !== "string" || !selectableProviderOptionChoices(descriptor).some((choice) => choice.id === input.value)) return null;
  const change = getTraitSelectChange(traits, descriptor, input.prompt, input.value);
  if (!change) return null;
  if (!("modelOptions" in change)) return { prompt: change.prompt };
  // The original helper expands descriptor defaults. Persist only the edited ID;
  // keep every other explicit selection, including invalid ones, for correction.
  const edited = change.modelOptions?.find((selection) => selection.id === descriptor.id);
  return { prompt: change.prompt, modelOptions: [...retained(), ...(edited ? [{ ...edited }] : [])] };
}
