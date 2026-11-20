/**
 * Paste-to-focus: clicking into the timeline blurs the composer, so a paste
 * that follows would land on nothing. Redirect it to the composer instead.
 * Editing surfaces, interactive controls and open floating layers keep their
 * own paste.
 */
export const COMPOSER_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
].join(",");

export const COMPOSER_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
].join(",");

/** Popups match only while open or closing; some stay mounted when closed. */
export const COMPOSER_FLOATING_LAYER_SELECTOR = [
  "[role='dialog'][aria-modal='true']",
  "[data-slot='alert-dialog-popup']:is([data-open],[data-ending-style])",
  "[data-slot='command-dialog-popup']:is([data-open],[data-ending-style])",
  "[data-slot='dialog-popup']:is([data-open],[data-ending-style])",
  "[data-slot='sheet-popup']:is([data-open],[data-ending-style])",
  "[data-slot='menu-popup']:is([data-open],[data-ending-style])",
  "[data-slot='select-popup']:is([data-open],[data-ending-style])",
  "[data-slot='popover-popup']:is([data-open],[data-ending-style])",
  "[data-slot='combobox-popup']:is([data-open],[data-ending-style])",
  "[data-slot='autocomplete-popup']:is([data-open],[data-ending-style])",
].join(",");

export type PasteFocusFacts = {
  eventDefaultPrevented: boolean;
  insideEditable: boolean;
  insideInteractive: boolean;
  floatingLayerOpen: boolean;
};

/** A paste outside every editor, control and open layer belongs in the composer. */
export function shouldFocusComposerForPaste(facts: PasteFocusFacts): boolean {
  return !facts.eventDefaultPrevented && !facts.insideEditable && !facts.insideInteractive && !facts.floatingLayerOpen;
}
