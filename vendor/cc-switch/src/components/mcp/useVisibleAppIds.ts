import type { AppId } from "../../lib/api/types";

/** Keep all twelve upstream adapters visible; target availability is shown separately. */
export function useVisibleAppIds<T extends AppId>(appIds: readonly T[]): T[] {
  return [...appIds];
}
