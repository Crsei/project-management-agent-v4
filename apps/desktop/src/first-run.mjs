const setupTokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Reads the unauthenticated first-run status through the desktop public origin. */
export async function readSetupStatus(origin, { signal } = {}) {
  if (typeof origin !== "string") throw new Error("First-run status requires a workspace origin.");
  const response = await fetch(`${origin}/api/v1/setup/status`, {
    method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
    signal: signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`First-run status read failed (HTTP ${response.status}).`);
  const value = await response.json().catch(() => null);
  if (!value || typeof value.initialized !== "boolean" || typeof value.setupAllowed !== "boolean" || value.registrationMode !== "invite_only")
    throw new Error("First-run status response was invalid.");
  return value;
}

/** Completes the ordinary HTTP setup with the desktop-prepared token. The token
 * stays in memory and is never written to a URL, storage or diagnostic output. */
export async function completeFirstRunSetup({ origin, setupToken, credentials }) {
  if (typeof origin !== "string") throw new Error("First-run setup requires a workspace origin.");
  if (typeof setupToken !== "string" || !setupTokenPattern.test(setupToken)) throw new Error("The local first-run setup token is unavailable.");
  const { email, password, name, workspaceName } = credentials ?? {};
  if (typeof email !== "string" || typeof password !== "string" || typeof name !== "string" || typeof workspaceName !== "string")
    throw new Error("First-run setup credentials are incomplete.");
  const response = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", credentials: "include", redirect: "error",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ setupToken, email, password, name, workspaceName }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const code = value && typeof value.error?.code === "string" ? `: ${value.error.code}` : "";
    throw new Error(`First-run setup failed (HTTP ${response.status}${code}).`);
  }
  if (!value || typeof value.workspaceId !== "string" || typeof value.actor?.id !== "string")
    throw new Error("First-run setup response was invalid.");
  return value;
}
