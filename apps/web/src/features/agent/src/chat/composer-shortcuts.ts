// Rebindable composer shortcuts. Chords persist as canonical strings; the
// editor resolves them against the platform on every keydown, so a stored
// "Mod+Enter" means Ctrl+Enter on Linux/Windows and ⌘+Enter on macOS.

export const COMPOSER_SHORTCUT_ACTIONS = ["send", "newline", "steer", "togglePlan"] as const;
export type ComposerShortcutAction = (typeof COMPOSER_SHORTCUT_ACTIONS)[number];
export type ComposerKeymap = Record<ComposerShortcutAction, string>;
/** Only bindings the user changed; untouched actions keep their preference-derived default. */
export type ComposerKeymapOverrides = Partial<Record<ComposerShortcutAction, string>>;

export type ShortcutChord = {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

export type ShortcutEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const MODIFIERS: Record<string, "mod" | "ctrl" | "meta" | "alt" | "shift"> = {
  mod: "mod", ctrl: "ctrl", control: "ctrl", meta: "meta", cmd: "meta", command: "meta",
  alt: "alt", option: "alt", opt: "alt", shift: "shift",
};

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", del: "Delete", space: "Space", spacebar: "Space",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
};

/** Keys that are safe to bind without a modifier: they never type a character. */
const BARE_KEYS: Record<string, true> = { Enter: true, Tab: true, Escape: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, Backspace: true, Delete: true, Home: true, End: true, PageUp: true, PageDown: true };

function normalizeKeyPart(part: string): string | undefined {
  const named = NAMED_KEYS[part.toLowerCase()];
  if (named) return named;
  if ([...part].length === 1) return part.toLowerCase();
  return undefined;
}

/**
 * Parse `Mod+Shift+Enter` into its parts. Returns undefined for anything the
 * editor could not match reliably (two keys, unknown names, bare letters).
 */
export function parseShortcutChord(chord: string): ShortcutChord | undefined {
  const parts = chord.split("+").map(part => part.trim());
  if (parts.some(part => part.length === 0) || parts.length > 5) return undefined;
  const keyPart = parts.at(-1)!;
  const chordParts: ShortcutChord = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier || chordParts[modifier]) return undefined;
    chordParts[modifier] = true;
  }
  const key = normalizeKeyPart(keyPart);
  if (!key) return undefined;
  const hasModifier = chordParts.mod || chordParts.ctrl || chordParts.meta || chordParts.alt || chordParts.shift;
  if (!hasModifier && !BARE_KEYS[key]) return undefined;
  return { ...chordParts, key };
}

export const modifierOrder = ["mod", "ctrl", "meta", "alt", "shift"] as const;

/** Canonical spelling of an event's chord; pending modifier-only presses return undefined. */
export function shortcutChordFromEvent(event: ShortcutEventLike): string | undefined {
  const key = normalizeKeyPart(event.key);
  if (!key || ["control", "meta", "shift", "alt"].includes(key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Store a chord only when the editor can match it later. */
export function normalizeShortcutChord(chord: unknown): string | undefined {
  if (typeof chord !== "string") return undefined;
  const parsed = parseShortcutChord(chord);
  if (!parsed) return undefined;
  const parts: string[] = [];
  for (const modifier of modifierOrder) if (parsed[modifier]) parts.push(modifier[0]!.toUpperCase() + modifier.slice(1));
  parts.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return parts.join("+");
}

/** Exact modifier match: a bound `Mod+Enter` must not fire on Ctrl+Shift+Enter. */
export function matchesShortcutChord(chord: string, event: ShortcutEventLike, isApple: boolean): boolean {
  const parsed = parseShortcutChord(chord);
  if (!parsed || normalizeKeyPart(event.key) !== parsed.key) return false;
  const expectCtrl = parsed.ctrl || (parsed.mod && !isApple);
  const expectMeta = parsed.meta || (parsed.mod && isApple);
  return event.ctrlKey === expectCtrl && event.metaKey === expectMeta && event.altKey === parsed.alt && event.shiftKey === parsed.shift;
}

export function isApplePlatform(platform: string | undefined = typeof navigator === "undefined" ? undefined : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/iu.test(platform ?? "");
}

/**
 * Defaults keep today's Enter semantics: in `enter` mode Enter sends and
 * Shift+Enter breaks the line; in `ctrlEnter` mode the pair swaps.
 */
export function defaultComposerKeymap(sendShortcut: "enter" | "ctrlEnter"): ComposerKeymap {
  return sendShortcut === "ctrlEnter"
    ? { send: "Mod+Enter", newline: "Enter", steer: "Mod+Shift+Enter", togglePlan: "Shift+Tab" }
    : { send: "Enter", newline: "Shift+Enter", steer: "Mod+Shift+Enter", togglePlan: "Shift+Tab" };
}

/** Overrides win per action; invalid stored chords fall back to the default. */
export function resolveComposerKeymap(overrides: ComposerKeymapOverrides | undefined, sendShortcut: "enter" | "ctrlEnter"): ComposerKeymap {
  const keymap = defaultComposerKeymap(sendShortcut);
  for (const action of COMPOSER_SHORTCUT_ACTIONS) {
    const chord = normalizeShortcutChord(overrides?.[action]);
    if (chord) keymap[action] = chord;
  }
  return keymap;
}

/** Actions that would fire on the same key press. */
export function findComposerKeymapConflicts(keymap: ComposerKeymap): Array<{ chord: string; actions: ComposerShortcutAction[] }> {
  const groups = new Map<string, ComposerShortcutAction[]>();
  for (const action of COMPOSER_SHORTCUT_ACTIONS) {
    const chord = normalizeShortcutChord(keymap[action]);
    if (!chord) continue;
    groups.set(chord, [...(groups.get(chord) ?? []), action]);
  }
  return [...groups].filter(([, actions]) => actions.length > 1).map(([chord, actions]) => ({ chord, actions }));
}

/** The conflicting actions a proposed binding would collide with. */
export function conflictingActions(keymap: ComposerKeymap, action: ComposerShortcutAction, chord: string): ComposerShortcutAction[] {
  const normalized = normalizeShortcutChord(chord);
  if (!normalized) return [];
  return COMPOSER_SHORTCUT_ACTIONS.filter(candidate => candidate !== action && normalizeShortcutChord(keymap[candidate]) === normalized);
}

/**
 * The action a key press triggers, in action order. `Enter`-to-send keeps the
 * pre-rebinding behaviour of also sending on Ctrl/⌘+Enter, so users who never
 * opened these settings see no change.
 */
export function matchComposerAction(keymap: ComposerKeymap, event: ShortcutEventLike, isApple: boolean): ComposerShortcutAction | undefined {
  for (const action of COMPOSER_SHORTCUT_ACTIONS) {
    if (matchesShortcutChord(keymap[action], event, isApple)) return action;
  }
  if (keymap.send === "Enter" && matchesShortcutChord("Mod+Enter", event, isApple)) return "send";
  return undefined;
}

export type ComposerRebindResult =
  | { overrides: ComposerKeymapOverrides; swapped?: ComposerShortcutAction }
  | { conflict: ComposerShortcutAction[] };

/**
 * Bind `action` to `chord`. When another action owns it, the two are swapped so
 * replacing Enter-to-send with Enter-to-break stays possible. A third collision
 * is refused and reported instead of silently breaking a binding.
 */
export function rebindComposerKeymap(overrides: ComposerKeymapOverrides, keymap: ComposerKeymap, action: ComposerShortcutAction, chord: string): ComposerRebindResult {
  const normalized = normalizeShortcutChord(chord);
  if (!normalized) return { overrides };
  const others = conflictingActions(keymap, action, normalized);
  if (!others.length) return { overrides: { ...overrides, [action]: normalized } };
  if (others.length > 1) return { conflict: others };
  const other = others[0]!;
  const previous = keymap[action];
  if (!previous) return { conflict: others };
  const third = conflictingActions(keymap, other, previous).filter(candidate => candidate !== action);
  if (third.length) return { conflict: others };
  return { overrides: { ...overrides, [action]: normalized, [other]: previous }, swapped: other };
}

/** Drop an override and fall back to the derived default. */
export function resetComposerKeymapBinding(overrides: ComposerKeymapOverrides, action: ComposerShortcutAction): ComposerKeymapOverrides {
  const next: ComposerKeymapOverrides = { ...overrides };
  delete next[action];
  return next;
}

/** Human label; the platform-independent `Mod` stays readable in both locales. */
export function formatShortcutChord(chord: string, modLabel = "Ctrl / ⌘"): string {
  const parsed = parseShortcutChord(chord);
  if (!parsed) return chord;
  const parts: string[] = [];
  if (parsed.mod) parts.push(modLabel);
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("⌘");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return parts.join(" + ");
}
