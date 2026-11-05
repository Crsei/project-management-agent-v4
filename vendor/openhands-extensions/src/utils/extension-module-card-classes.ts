/** Shared card chrome for Skills / MCP / Automations tiles (border on hover only). */
export const extensionModuleCardSurfaceClassName =
  "oh-module-card rounded-xl";

/** Adapted from the pinned `.extension-module-card-interactive` rules. */
export const extensionModuleCardInteractiveClassName =
  "extension-module-card-interactive";

/** Shared pill chrome for Skills, automation cards, and related modals. */
export const extensionModuleCardPillClassName =
  "oh-module-pill inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-4";

/** Establishes the inline-size container queried by {@link extensionModuleCardGridClassName}. */
export const extensionModuleCardGridContainerClassName =
  "oh-module-grid-container min-w-0 w-full";

/** Single column in narrow content columns; two columns from 600px container width up. */
export const extensionModuleCardGridClassName =
  "oh-module-grid grid min-w-0 gap-3";

/** Bordered empty-state panel used on MCP Installed and Automations list pages. */
export const extensionModuleEmptyStateClassName =
  "oh-module-empty rounded-xl border border-border p-8 text-center";
