/** Presentation-only decisions for the session details surface. */
export type DetailsDensity = "essential" | "compact" | "full";
export type DetailsPresentation = "inline" | "overlay";
export type ScrollFade = "none" | "top" | "bottom" | "both";

export const DETAILS_ESSENTIAL_MAX = 220;
export const DETAILS_COMPACT_MAX = 460;

/**
 * Content height decides the density tier. Unmeasured content stays `full` so a
 * freshly opened panel never flashes at a smaller size before layout settles.
 */
export function detailsDensity(contentHeight: number): DetailsDensity {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return "full";
  if (contentHeight <= DETAILS_ESSENTIAL_MAX) return "essential";
  if (contentHeight <= DETAILS_COMPACT_MAX) return "compact";
  return "full";
}

/** Wide, non-embedded chat keeps the details inline; everything else opens an overlay. */
export function detailsPresentation({ wide, embedded }: { wide: boolean; embedded: boolean }): DetailsPresentation {
  return wide && !embedded ? "inline" : "overlay";
}

/**
 * Which scroll edges need the fade mask. Hidden overflow reports `none`, so a
 * short panel never fades content that is fully visible.
 */
export function scrollFade(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): ScrollFade {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (!(clientHeight > 0) || scrollHeight <= clientHeight + 1) return "none";
  const top = Math.max(0, scrollTop);
  const atTop = top <= 1;
  const atBottom = top + clientHeight >= scrollHeight - 1;
  if (atTop && atBottom) return "none";
  if (atTop) return "bottom";
  if (atBottom) return "top";
  return "both";
}
