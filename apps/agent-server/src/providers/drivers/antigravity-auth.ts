// Ported from t3code provider/antigravityAuthSupport.ts and antigravityCallback.ts (MIT).
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__T3_ANTIGRAVITY_AUTH_URL__";
export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE = "Sign in to Antigravity in Settings before you continue.";
export const ANTIGRAVITY_DEFAULT_MODEL = "antigravity-default";
export const antigravityAuthMethods = [
  { value: "oauth-personal", label: "Google account" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform (Vertex AI)" },
] as const;
export type AntigravityAuthMethod = typeof antigravityAuthMethods[number]["value"];
export type AntigravitySettings = {
  authMethod: AntigravityAuthMethod; apiKey: string; gcpProject: string; gcpLocation: string; binaryPath: string;
};
export type AntigravityAuthorization = { authorizationUrl: string; redirectUri: string; state: string };
export type AntigravityProfile = {
  platform: NodeJS.Platform; geminiHome: string; acpDirectory: string; tokenPath: string;
  tempDirectory: string; browserCommand: string; caBundlePath?: string;
};
const removedEnvironmentKeys: Record<string, true> = {
  GEMINI_API_KEY: true, GOOGLE_API_KEY: true, GOOGLE_APPLICATION_CREDENTIALS: true, GOOGLE_CLOUD_PROJECT: true,
  GOOGLE_CLOUD_LOCATION: true, GOOGLE_CLOUD_QUOTA_PROJECT: true, GOOGLE_GENAI_USE_VERTEXAI: true, GCLOUD_PROJECT: true,
  CLOUDSDK_CORE_PROJECT: true, AGY_ACP_CCPA_PROJECT: true, AGY_ACP_ENABLE_OAUTH: true, GEMINI_HOME: true,
  AGY_ACP_FORCE_FILE_STORAGE: true, ANTIGRAVITY_HARNESS_PATH: true, BROWSER: true, PYTHONUNBUFFERED: true, ELECTRON_RUN_AS_NODE: true,
};
const browserHelperSource = `process.stderr.on("error",()=>process.exit(0)).write("${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;
const preflightUrl = "https://example.invalid/t3-antigravity-browser-preflight";

export function validateAntigravityConfig(config: ProviderConfig): AntigravitySettings {
  const allowed = ["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"] as const;
  for (const key of Object.keys(config)) if (!allowed.some((entry) => entry === key)) throw new Error(`Unknown Antigravity setting '${key}'.`);
  const result: AntigravitySettings = { authMethod: "oauth-personal", apiKey: "", gcpProject: "", gcpLocation: "", binaryPath: "" };
  for (const key of allowed) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`Antigravity '${key}' must be a string.`);
    if (value.includes("\0")) throw new Error(`Antigravity '${key}' cannot contain a NUL byte.`);
    Object.assign(result, { [key]: value.trim() });
  }
  if (!antigravityAuthMethods.some(({ value }) => value === result.authMethod)) throw new Error("Unsupported Antigravity sign-in method.");
  return result;
}
export function antigravityAuthUsesBrowser(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business";
}
export function antigravityAuthLabel(method: AntigravityAuthMethod): string {
  return antigravityAuthMethods.find(({ value }) => value === method)!.label;
}
export function antigravityAuthConfigIssue(auth: AntigravitySettings): string | null {
  switch (auth.authMethod) {
    case "oauth-personal": return null;
    case "oauth-business": return auth.gcpProject && auth.gcpLocation ? null : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
    case "gemini-api-key": return auth.apiKey ? null : "Enter a Gemini API key in the Antigravity provider settings.";
    case "agent-platform": return auth.apiKey || (auth.gcpProject && auth.gcpLocation) ? null : "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.";
  }
}
export function antigravityEnvironment(profile: AntigravityProfile, base: NodeJS.ProcessEnv, auth: AntigravitySettings, runtimeTempDirectory = profile.tempDirectory): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!Object.hasOwn(removedEnvironmentKeys, key.toUpperCase())) environment[key] = value;
  return {
    ...environment,
    ...(auth.authMethod === "gemini-api-key" && auth.apiKey ? { GEMINI_API_KEY: auth.apiKey } : {}),
    ...(auth.authMethod === "agent-platform" && auth.apiKey ? { GOOGLE_API_KEY: auth.apiKey } : {}),
    ...(profile.caBundlePath && base.SSL_CERT_FILE === undefined && base.SSL_CERT_DIR === undefined ? { SSL_CERT_FILE: profile.caBundlePath } : {}),
    GEMINI_HOME: profile.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: "1", ELECTRON_RUN_AS_NODE: "1",
    ...(profile.platform === "win32" ? { TEMP: runtimeTempDirectory, TMP: runtimeTempDirectory } : { TMPDIR: runtimeTempDirectory }),
  };
}
export async function prepareAntigravityProfile(context: ProviderDriverContext, auth: AntigravitySettings, signal?: AbortSignal): Promise<AntigravityProfile> {
  signal?.throwIfAborted();
  const platform = process.platform;
  const executable = platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const browserCommand = [executable, "-e", browserHelperSource, "--", "%s"].map(quote).join(" ");
  if (browserCommand.includes(platform === "win32" ? ";" : ":") || /[\r\n\0]/.test(executable) || executable.includes("%s")) {
    throw new Error("The server runtime path cannot be used to suppress Antigravity browser launches.");
  }
  const geminiHome = resolve(context.homeDirectory);
  const acpDirectory = join(geminiHome, "antigravity-acp");
  const profile: AntigravityProfile = { platform, geminiHome, acpDirectory, tokenPath: join(acpDirectory, "acp_token.json"), tempDirectory: join(acpDirectory, "tmp"), browserCommand };
  if (platform === "linux") {
    for (const candidate of [context.env.NIX_SSL_CERT_FILE, "/etc/ssl/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"]) {
      if (candidate && isAbsolute(candidate) && await stat(candidate).then((entry) => entry.isFile(), () => false)) { profile.caBundlePath = candidate; break; }
    }
  }
  for (const directory of [geminiHome, acpDirectory, profile.tempDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== "win32") await chmod(directory, 0o700);
  }
  const preflightSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5_000)]);
  const preflight = Promise.withResolvers<void>();
  const child = spawn(executable, ["-e", browserHelperSource, "--", preflightUrl], {
    cwd: context.homeDirectory, env: antigravityEnvironment(profile, context.env, auth), shell: false, signal: preflightSignal, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = ""; let oversized = false;
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 4_096) { oversized = true; child.kill("SIGKILL"); } });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 4_096) { oversized = true; child.kill("SIGKILL"); } });
  child.once("error", () => preflight.reject(new Error("Antigravity browser suppression could not be verified.")));
  child.once("close", (code) => code === 0 && !oversized && stdout === "" && stderr === `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(preflightUrl)}\n` ? preflight.resolve() : preflight.reject(new Error("Antigravity browser suppression could not be verified.")));
  await preflight.promise;
  const gcp = { ...(auth.gcpProject ? { project: auth.gcpProject } : {}), ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}) };
  await writeFile(join(acpDirectory, "settings.json"), `${JSON.stringify({ auth: { type: auth.authMethod }, ...(Object.keys(gcp).length ? { gcp } : {}) })}\n`, { mode: 0o600 });
  if (platform !== "win32") await chmod(join(acpDirectory, "settings.json"), 0o600);
  return profile;
}
export function buildAntigravityAcpSpawnInput(context: ProviderDriverContext, installation: { executablePath: string; harnessPath: string }, profile: AntigravityProfile, auth: AntigravitySettings, runtimeTempDirectory: string) {
  const env: NodeJS.ProcessEnv = { ...antigravityEnvironment(profile, context.env, auth, runtimeTempDirectory), ANTIGRAVITY_HARNESS_PATH: installation.harnessPath };
  return { command: installation.executablePath, args: profile.platform === "linux" ? ["--uid="] : [], env };
}
export function parseAntigravityAuthorizationUrl(authorizationUrl: string): AntigravityAuthorization {
  const invalid = () => new Error("Antigravity returned an invalid Google sign-in URL.");
  if (authorizationUrl.length > 16_384 || /\s/.test(authorizationUrl)) throw invalid();
  let url: URL;
  try { url = new URL(authorizationUrl); } catch { throw invalid(); }
  const state = url.searchParams.get("state"); const redirectUri = url.searchParams.get("redirect_uri");
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("redirect_uri").length !== 1 || url.searchParams.getAll("response_type").length !== 1 || url.searchParams.get("response_type") !== "code" || !state || state.length > 512 || /\s/.test(state) || !redirectUri || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)) throw invalid();
  const redirect = new URL(redirectUri);
  if (Number(redirect.port) < 1_024 || Number(redirect.port) > 65_535) throw invalid();
  return { authorizationUrl, state, redirectUri };
}
export function validateAntigravityCallbackUrl(pending: AntigravityAuthorization, callbackUrl: string): URL {
  if (callbackUrl.length > 16_384) throw new Error("The sign-in response URL is too long.");
  let callback: URL;
  try { callback = new URL(callbackUrl); } catch { throw new Error("Paste the complete redirect URL from the Google sign-in page."); }
  const expected = new URL(pending.redirectUri);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== pending.state) throw new Error("This redirect URL does not belong to the current sign-in.");
  const codes = callback.searchParams.getAll("code"); const errors = callback.searchParams.getAll("error");
  if (!((codes.length === 1 && Boolean(codes[0]) && errors.length === 0) || (errors.length === 1 && Boolean(errors[0]) && codes.length === 0))) throw new Error("The redirect URL must contain one Google sign-in response.");
  const issuers = callback.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")) throw new Error("The redirect URL is not a Google sign-in response.");
  return callback;
}
export async function forwardAntigravityCallback(callback: URL, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
  const completed = Promise.withResolvers<void>();
  const failed = () => new Error("Could not deliver the sign-in response. Start sign-in again.");
  const request = httpRequest({ protocol: "http:", hostname: "127.0.0.1", port: callback.port, path: `${callback.pathname}${callback.search}`, method: "GET", agent: false, signal: timeout }, (response) => {
    response.once("error", () => completed.reject(failed()));
    response.once("end", () => (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 ? completed.resolve() : completed.reject(failed()));
    response.resume();
  });
  request.once("error", () => completed.reject(failed()));
  request.end();
  await completed.promise;
}
export function makeAntigravityAuthHandlers(onAuthorizationUrl?: (authorization: AntigravityAuthorization) => void) {
  const deliver = (url: string) => {
    const authorization = parseAntigravityAuthorizationUrl(url);
    if (!onAuthorizationUrl) throw new Error(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE);
    onAuthorizationUrl(authorization);
  };
  let pending = "";
  return {
    filterStdoutLine: (line: string): string | null => {
      if (!line.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) return line;
      deliver(line.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length).replace(/\r?\n$/, ""));
      return null;
    },
    onStderr: (chunk: string): void => {
      const lines = `${pending}${chunk}`.split("\n"); pending = lines.pop() ?? "";
      if (pending.length > 16_500) pending = "";
      for (const line of lines) {
        const message = line.replace(/\r$/, "");
        if (message.length > 16_500) continue;
        let candidate: string | undefined;
        if (message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) candidate = message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length);
        else if (message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)) {
          try { const decoded: unknown = JSON.parse(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length)); if (typeof decoded === "string") candidate = decoded; } catch { continue; }
        }
        if (candidate === undefined) continue;
        let authorization: AntigravityAuthorization;
        try { authorization = parseAntigravityAuthorizationUrl(candidate); } catch { continue; }
        if (!onAuthorizationUrl) throw new Error(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE);
        onAuthorizationUrl(authorization);
      }
    },
  };
}
export async function removeAntigravitySessionFiles(home: string, sessionId: string | undefined, cwd: string): Promise<void> {
  if (!sessionId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)) return;
  const root = join(home, "antigravity-acp"); const base = join(root, "conversations", sessionId);
  try {
    const metadata: unknown = JSON.parse(await readFile(`${base}.meta`, "utf8"));
    if (!metadata || typeof metadata !== "object" || !("cwd" in metadata) || metadata.cwd !== cwd) return;
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) await rm(`${base}${suffix}`, { force: true });
    await rm(join(root, "brain", sessionId), { recursive: true, force: true });
  } catch { /* Disposal must not hide the original native result. */ }
}
