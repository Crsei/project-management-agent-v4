/**
 * Reading-lane geometry for the Chat transcript.
 *
 * The appearance preference picks a preferred lane; the CSS in `chat-lane.css`
 * clamps it to the conversation width and, while a side panel shares the row,
 * to a comfortable reading measure. `resolveChatLaneWidth` encodes that rule so
 * the behavior is pinned by tests without a browser, and the constants feed the
 * appearance page copy. No runtime measurement is needed: the browser resolves
 * the same rule with container-query units.
 */
export type ChatLanePreference = "standard" | "wide" | "full";

export const CHAT_LANE_STANDARD_WIDTH = 808;
export const CHAT_LANE_WIDE_WIDTH = 1040;
/** Page padding inside the lane: 24px on each side (`px-6`). */
export const CHAT_LANE_GUTTER = 48;
/** Comfortable text measure; below it the lane starts squeezing the composer. */
export const CHAT_LANE_MIN_TEXT_WIDTH = 640;
/** Lane box that still fits that measure: 640 px text + 48 px page padding. */
export const CHAT_LANE_MIN_USABLE_WIDTH = CHAT_LANE_MIN_TEXT_WIDTH + CHAT_LANE_GUTTER;
/** Reading measure cap while the details aside or the right panel is open (46rem). */
export const CHAT_LANE_PANEL_MAX_WIDTH = 736;

/** `null` means "fill the available space"; otherwise a CSS pixel width. */
export function preferredChatLaneWidth(preference: ChatLanePreference): number | null {
  if (preference === "wide") return CHAT_LANE_WIDE_WIDTH;
  if (preference === "full") return null;
  return CHAT_LANE_STANDARD_WIDTH;
}

export type ChatLaneResolution = {
  /** Effective lane width in CSS px. */
  width: number;
  /** The remaining width is below the minimal comfortable lane. */
  belowMinUsable: boolean;
  /** A side panel's clearance capped the lane to the reading measure. */
  panelCapped: boolean;
};

/**
 * Resolve the lane width the way the CSS does: preferred width, never wider
 * than the container, and capped at the panel measure once a details aside or
 * right panel is open. Avoidance is skipped when the container is already
 * narrower than a minimal usable lane, so the composer keeps all the room there
 * is instead of being squeezed twice.
 */
export function resolveChatLaneWidth({
  preference,
  containerWidth,
  panelOpen,
}: {
  preference: ChatLanePreference;
  containerWidth: number;
  panelOpen: boolean;
}): ChatLaneResolution {
  const available = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0;
  const preferred = preferredChatLaneWidth(preference);
  const preferredWidth = preferred === null ? available : Math.min(preferred, available);
  const panelCapped = panelOpen && available >= CHAT_LANE_MIN_USABLE_WIDTH;
  const width = panelCapped ? Math.min(preferredWidth, CHAT_LANE_PANEL_MAX_WIDTH) : preferredWidth;
  return { width, belowMinUsable: width < CHAT_LANE_MIN_USABLE_WIDTH, panelCapped };
}
