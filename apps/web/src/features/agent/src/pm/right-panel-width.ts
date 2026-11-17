/** Only a finite value within the panel's allowed range is restored. */
export function parseStoredPanelWidth(value: string | null, min: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const width = Number(value);
  return Number.isFinite(width) && width >= min ? width : undefined;
}

export const RIGHT_PANEL_WIDTH_KEY = "pm-agent-right-panel-width:v1";
