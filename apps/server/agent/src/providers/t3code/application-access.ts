import type { PmProviderApplication } from "./application.ts";
import type { PmProviderBoundaryError } from "./contract.ts";

// No runtime imports: configuration can enumerate façades before application startup.
let readApplication: (() => PmProviderApplication | undefined) | undefined;

export function bindPmProviderApplicationAccess(readCurrent: () => PmProviderApplication | undefined): () => void {
  if (readApplication) throw new Error("Provider application access is already bound.");
  readApplication = readCurrent;
  return () => { if (readApplication === readCurrent) readApplication = undefined; };
}

export function getPmProviderApplication(): PmProviderApplication {
  const application = readApplication?.();
  if (!application) {
    const error: PmProviderBoundaryError = Object.assign(new Error("Provider application is not accepting operations."), {
      code: "provider_not_configured", status: 503,
    });
    throw error;
  }
  return application;
}
