/** Header breadcrumb layout only; measured width never changes the session identity. */
export type BreadcrumbTier = "wide" | "compact" | "tight";

export type BreadcrumbLayout = {
  tier: BreadcrumbTier;
  showWorkspace: boolean;
  showParent: boolean;
};

const WIDE_WIDTH = 560;
const COMPACT_WIDTH = 340;
const WORKSPACE_WITH_PARENT_WIDTH = 560;
const WORKSPACE_ONLY_WIDTH = 420;
const PARENT_WIDTH = 300;

/**
 * Collapse order is workspace label first, then the parent title (an icon-only
 * parent entry stays reachable), while the session title is always rendered.
 * An unmeasured container keeps the full trail to avoid a hide-then-show flash.
 */
export function breadcrumbLayout(
  width: number | undefined,
  segments: { workspace: boolean; parent: boolean },
): BreadcrumbLayout {
  if (width === undefined || !Number.isFinite(width)) {
    return { tier: "wide", showWorkspace: segments.workspace, showParent: segments.parent };
  }
  const available = Math.max(0, width);
  return {
    tier: available >= WIDE_WIDTH ? "wide" : available >= COMPACT_WIDTH ? "compact" : "tight",
    showWorkspace: segments.workspace && available >= (segments.parent ? WORKSPACE_WITH_PARENT_WIDTH : WORKSPACE_ONLY_WIDTH),
    showParent: segments.parent && available >= PARENT_WIDTH,
  };
}

const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** Deterministic initials from the reported workspace name; never generated content. */
export function workspaceInitials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/[\s\-_/.·]+/u).filter(Boolean);
  const first = words[0];
  if (!first) return "?";
  if (cjk.test(first)) {
    const characters = Array.from(first);
    return characters.slice(0, 2).join("");
  }
  const letters = (value: string) => Array.from(value).filter((character) => /[\p{L}\p{N}]/u.test(character));
  if (words.length >= 2) {
    const firstLetter = letters(first)[0];
    const secondLetter = letters(words[1] ?? "")[0];
    if (firstLetter) return `${firstLetter}${secondLetter ?? ""}`.toUpperCase();
  }
  return letters(first).slice(0, 2).join("").toUpperCase() || "?";
}

const TONES = 6;

/** Stable tone index for the fallback badge, derived only from the same name. */
export function initialsTone(name: string | undefined): number {
  let hash = 0;
  for (const character of name ?? "") hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
  return Math.abs(hash) % TONES;
}
