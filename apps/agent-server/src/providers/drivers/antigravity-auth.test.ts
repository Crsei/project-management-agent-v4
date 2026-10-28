import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER, ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  antigravityAuthConfigIssue, antigravityEnvironment, buildAntigravityAcpSpawnInput,
  makeAntigravityAuthHandlers, parseAntigravityAuthorizationUrl, prepareAntigravityProfile,
  validateAntigravityCallbackUrl, validateAntigravityConfig, type AntigravityProfile,
} from "./antigravity-auth.ts";

const url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A46353%2F&state=opaque-state";
const profile: AntigravityProfile = { platform: "linux", geminiHome: "/private/home", acpDirectory: "/private/home/antigravity-acp", tokenPath: "/private/home/antigravity-acp/acp_token.json", tempDirectory: "/private/tmp", browserCommand: "private-browser-helper" };

test("Antigravity settings enforce exactly the native source schema and method requirements", () => {
  assert.equal(validateAntigravityConfig({}).authMethod, "oauth-personal");
  assert.throws(() => validateAntigravityConfig({ homePath: "/shared" }), /Unknown/);
  assert.throws(() => validateAntigravityConfig({ authMethod: "oauth" }), /Unsupported/);
  assert.throws(() => validateAntigravityConfig({ binaryPath: false }), /string/);
  assert.throws(() => validateAntigravityConfig({ apiKey: "unsafe\0key" }), /NUL/);
  assert.match(antigravityAuthConfigIssue(validateAntigravityConfig({ authMethod: "oauth-business" }))!, /project and location/);
  assert.equal(antigravityAuthConfigIssue(validateAntigravityConfig({ authMethod: "oauth-business", gcpProject: "project", gcpLocation: "us-central1" })), null);
  assert.equal(antigravityAuthConfigIssue(validateAntigravityConfig({ authMethod: "agent-platform", apiKey: "express-key" })), null);
  assert.equal(antigravityAuthConfigIssue(validateAntigravityConfig({ authMethod: "agent-platform", gcpProject: "project", gcpLocation: "global" })), null);
});

test("all native modes scrub ambient credentials and select only their configured secret", () => {
  const ambient = { HOME: "/private/home", GEMINI_API_KEY: "ambient", google_api_key: "ambient-alias", GOOGLE_APPLICATION_CREDENTIALS: "/host/adc.json", GOOGLE_CLOUD_PROJECT: "host-project", GOOGLE_GENAI_USE_VERTEXAI: "1", AGY_ACP_ENABLE_OAUTH: "1", GEMINI_HOME: "/host/gemini", ANTIGRAVITY_HARNESS_PATH: "/host/harness", BROWSER: "xdg-open", CUSTOM: "preserve" };
  const original = { ...ambient };
  for (const authMethod of ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]) {
    const config = validateAntigravityConfig({ authMethod, apiKey: "configured", gcpProject: "project", gcpLocation: "region" });
    const environment = antigravityEnvironment(profile, ambient, config, "/private/run-one");
    assert.equal(environment.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(environment.google_api_key, undefined);
    assert.equal(environment.GOOGLE_CLOUD_PROJECT, undefined);
    assert.equal(environment.GOOGLE_GENAI_USE_VERTEXAI, undefined);
    assert.equal(environment.GEMINI_HOME, profile.geminiHome);
    assert.equal(environment.GEMINI_API_KEY, authMethod === "gemini-api-key" ? "configured" : undefined);
    assert.equal(environment.GOOGLE_API_KEY, authMethod === "agent-platform" ? "configured" : undefined);
    assert.equal(environment.TMPDIR, "/private/run-one");
    assert.equal(environment.CUSTOM, "preserve");
  }
  assert.deepEqual(ambient, original);
  const windows = antigravityEnvironment({ ...profile, platform: "win32" }, ambient, validateAntigravityConfig({}), "/private/windows-run");
  assert.equal(windows.TEMP, "/private/windows-run"); assert.equal(windows.TMP, "/private/windows-run");
});

test("Google authorization and callback URLs reject confused-deputy and duplicate parameter inputs", () => {
  const pending = parseAntigravityAuthorizationUrl(url);
  assert.equal(validateAntigravityCallbackUrl(pending, `${pending.redirectUri}?state=opaque-state&code=accepted`).hostname, "127.0.0.1");
  for (const invalid of [url.replace("accounts.google.com", "accounts.google.com.evil.invalid"), `${url}&state=second`, url.replace("46353", "22"), url.replace("46353", "99999"), url.replace("response_type=code", "response_type=token"), `${url}#fragment`, url.replace("127.0.0.1", "localhost")]) assert.throws(() => parseAntigravityAuthorizationUrl(invalid));
  for (const invalid of ["http://127.0.0.1:46353/?state=wrong&code=secret", "http://127.0.0.1:46354/?state=opaque-state&code=secret", "http://localhost:46353/?state=opaque-state&code=secret", "http://127.0.0.1:46353/?state=opaque-state&code=one&code=two", "http://127.0.0.1:46353/?state=opaque-state&code=one&error=denied", "http://127.0.0.1:46353/?state=opaque-state&code=one&iss=https://evil.invalid"]) assert.throws(() => validateAntigravityCallbackUrl(pending, invalid));
});

test("browser markers tolerate split stderr chunks but never pass auth messages into ACP JSON", () => {
  const seen: string[] = [];
  const handler = makeAntigravityAuthHandlers((authorization) => seen.push(authorization.authorizationUrl));
  assert.equal(handler.filterStdoutLine(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${url}`), null);
  assert.equal(handler.filterStdoutLine('{"jsonrpc":"2.0","id":1,"result":{}}'), '{"jsonrpc":"2.0","id":1,"result":{}}');
  const marker = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(url)}\n`;
  handler.onStderr(marker.slice(0, 19)); handler.onStderr(marker.slice(19));
  handler.onStderr(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}"https://evil.invalid"\n`);
  assert.deepEqual(seen, [url, url]);
  assert.throws(() => makeAntigravityAuthHandlers().filterStdoutLine(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${url}`), /Sign in/);
  assert.throws(() => makeAntigravityAuthHandlers().onStderr(marker), /Sign in/);
});

test("private native profile suppresses OS browsers and never writes the API key to settings", async () => {
  const home = await mkdtemp(join(tmpdir(), "pm-antigravity-profile-"));
  try {
    const context: ProviderDriverContext = { instanceId: "private", driver: "antigravity", config: {}, homeDirectory: home, cwd: home, env: { PATH: process.env.PATH, HOME: home }, revision: 1 };
    const config = validateAntigravityConfig({ authMethod: "agent-platform", apiKey: "not-on-disk", gcpProject: "project", gcpLocation: "global" });
    const prepared = await prepareAntigravityProfile(context, config);
    const settingsPath = join(prepared.acpDirectory, "settings.json");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { auth: { type: "agent-platform" }, gcp: { project: "project", location: "global" } });
    assert.equal((await readFile(settingsPath, "utf8")).includes("not-on-disk"), false);
    if (process.platform !== "win32") { assert.equal((await stat(home)).mode & 0o777, 0o700); assert.equal((await stat(settingsPath)).mode & 0o777, 0o600); }
    const spawn = buildAntigravityAcpSpawnInput(context, { executablePath: "/native/server", harnessPath: "/native/localharness_external" }, prepared, config, join(prepared.tempDirectory, "owned-run"));
    assert.deepEqual(spawn.args, process.platform === "linux" ? ["--uid="] : []);
    assert.equal(spawn.env.ANTIGRAVITY_HARNESS_PATH, "/native/localharness_external");
    assert.equal(spawn.env.GOOGLE_API_KEY, "not-on-disk");
  } finally { await rm(home, { recursive: true, force: true }); }
});
