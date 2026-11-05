import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { definitionFingerprint, hasOperationFailures, mergeMcpDefinitionSecrets, mergeMcpOverrideSecrets, mergeMcpServerSecrets, redactMcpImportPreview, redactMcpManagement, redactMcpServers, redactOperationResult } from "./secrets.ts";
import { parseExtensionCommand } from "./commands.ts";
import type { ExtensionMcpImportPreview, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { parseMcpImportPreview, parseMcpManagement } from "./mcp-wire.ts";

const key = "synthetic-unit-test-mask-key";
const contextId = "synthetic-context";
const previous = { id: "fixture", name: "Fixture", apps: { codex: false }, server: { type: "http", url: "https://mcp.example.invalid/rpc?token=fixture-query-secret", headers: { authorization: "fixture-private-header", "x-remove": "fixture-remove-header" }, env: { TOKEN: "fixture-private-env" }, args: ["fixture-private-arg"] } };
test("network masks protect headers, environment, argv and URL credentials while unchanged masks restore exact values", () => {
  const redacted = redactMcpServers({ fixture: previous }, key, contextId) as Record<string, typeof previous>;
  const wire = JSON.stringify(redacted);
  for (const value of ["fixture-query-secret", "fixture-private-header", "fixture-private-env", "fixture-private-arg"]) assert.equal(wire.includes(value), false);
  assert.deepEqual(mergeMcpServerSecrets(redacted.fixture!, previous, key, contextId), previous);
  assert.throws(() => mergeMcpServerSecrets({ ...redacted.fixture!, id: "different" }, previous, key, contextId), { code: "secret_mask_stale" });
  assert.throws(() => mergeMcpServerSecrets(redacted.fixture!, { ...previous, server: { ...previous.server, env: { TOKEN: "changed-fixture" } } }, key, contextId), { code: "secret_mask_stale" });
});
test("omission preserves private maps, provided complete maps remove individual rows, and empty maps explicitly clear", () => {
  const masked = (redactMcpServers({ fixture: previous }, key, contextId) as Record<string, typeof previous>).fixture!;
  const kept = mergeMcpServerSecrets({ ...masked, server: { type: "http", url: "https://mcp.example.invalid/rpc" } }, previous, key, contextId);
  assert.deepEqual((kept.server as Record<string, unknown>).headers, previous.server.headers);
  const removed = mergeMcpServerSecrets({ ...masked, server: { ...masked.server, headers: { authorization: masked.server.headers.authorization } } }, previous, key, contextId);
  assert.deepEqual((removed.server as Record<string, unknown>).headers, { authorization: previous.server.headers.authorization });
  const cleared = mergeMcpServerSecrets({ ...masked, server: { ...masked.server, headers: {}, env: {} } }, previous, key, contextId);
  assert.deepEqual((cleared.server as Record<string, unknown>).headers, {});
  assert.deepEqual((cleared.server as Record<string, unknown>).env, {});
});
test("definition fingerprints use PM's recursive lexical canonical form and ignore header order/case", () => {
  const endpoint = "https://mcp.example.invalid/rpc";
  const canonical = JSON.stringify({ endpoint, headers: { authorization: "fixture-a", "x-z": "fixture-z" }, transport: "streamable-http" });
  const expected = createHash("sha256").update(canonical).digest("hex");
  assert.equal(definitionFingerprint(endpoint, { "X-Z": "fixture-z", Authorization: "fixture-a" }), expected);
});
test("allowlist rejects arbitrary dispatch, browser filesystem paths and unexpected init fields", () => {
  assert.throws(() => parseExtensionCommand("host_initialize", {}), { code: "command_not_allowed" });
  assert.throws(() => parseExtensionCommand("install_skills_from_zip", { zipPath: "/tmp/arbitrary.zip", currentApp: "codex" }));
  assert.throws(() => parseExtensionCommand("read_skill_file", { directory: "skill", file: "../private" }));
  assert.throws(() => parseExtensionCommand("get_mcp_servers", { homeDir: "/tmp/other" }));
});
test("partial native outcomes retain failure state while private raw diagnostics are withheld", () => {
  const result = [{ app: "codex", ok: false, error: "fixture-private-header" }, { app: "claude", ok: true }];
  assert.equal(hasOperationFailures(result), true);
  assert.equal(JSON.stringify(redactOperationResult(result)).includes("fixture-private-header"), false);
});
test("URL secret masks remain valid form URLs and retain protected components across host-only edits", () => {
  const source = { ...previous, server: { ...previous.server, url: "https://fixture-user:fixture-password@mcp.example.invalid/rpc?token=fixture-query-secret&token=second-fixture#fixture-fragment" } };
  const masked = (redactMcpServers({ fixture: source }, key, contextId) as Record<string, typeof source>).fixture!;
  assert.doesNotThrow(() => new URL(masked.server.url));
  assert.equal(masked.server.url.includes("fixture-password"), false);
  assert.equal(masked.server.url.includes("fixture-query-secret"), false);
  const changed = new URL(masked.server.url);
  changed.hostname = "other.example.invalid";
  const restored = mergeMcpServerSecrets({ ...masked, server: { ...masked.server, url: changed.href } }, source, key, contextId);
  const endpoint = new URL(String((restored.server as Record<string, unknown>).url));
  assert.equal(endpoint.hostname, "other.example.invalid");
  assert.equal(endpoint.username, "fixture-user");
  assert.equal(endpoint.password, "fixture-password");
  assert.deepEqual(endpoint.searchParams.getAll("token"), ["fixture-query-secret", "second-fixture"]);
  assert.equal(endpoint.hash, "#fixture-fragment");
});

test("management masks bind context, definition, app, effective field and structured path without ambiguity", () => {
  const definition = { id: "fixture", name: "Fixture", server: { ...previous.server, command: "/private/native-root/bin/mcp", cwd: "/private/native-root", extension: { value: 7123, enabled: true }, "a/b": "same-secret", a: { b: "same-secret" } } };
  const override = { headers: { authorization: "fixture-override-secret" }, env: { TOKEN: "fixture-override-env" } };
  const management: ExtensionMcpManagement = { definitions: { fixture: definition }, boundApps: ["claude", "codex"], agentConfigurations: { fixture: Object.fromEntries((["claude", "codex"] as const).map(app => [app, { serverId: "fixture", app, enabled: true, override, effective: { ...definition.server, ...override }, compatibility: { supported: true, reason: null }, sync: { state: "synced" as const, reason: null } }])) } };
  const masked = redactMcpManagement(management, key, contextId);
  const wire = JSON.stringify(masked);
  for (const secret of ["fixture-override-secret", "fixture-override-env", "/private/native-root", "same-secret"]) assert.equal(wire.includes(secret), false);
  const maskedExtension = masked.definitions.fixture!.server.extension;
  assert.ok(maskedExtension && typeof maskedExtension === "object" && "value" in maskedExtension && "enabled" in maskedExtension);
  assert.notEqual(maskedExtension.value, 7123);
  assert.notEqual(maskedExtension.enabled, true);
  assert.deepEqual(mergeMcpDefinitionSecrets(masked.definitions.fixture!, definition, key, contextId), definition);
  assert.deepEqual(mergeMcpOverrideSecrets(masked.agentConfigurations.fixture!.claude!.override!, override, key, contextId, "fixture", "claude"), override);
  assert.throws(() => mergeMcpOverrideSecrets(masked.agentConfigurations.fixture!.claude!.override!, override, key, contextId, "fixture", "codex"), { code: "secret_mask_stale" });
  assert.throws(() => mergeMcpDefinitionSecrets(masked.definitions.fixture!, definition, key, "different-context"), { code: "secret_mask_stale" });
  assert.throws(() => mergeMcpOverrideSecrets(masked.definitions.fixture!.server, definition.server, key, contextId, "fixture", "claude"), { code: "secret_mask_stale" });
  assert.throws(() => mergeMcpOverrideSecrets(masked.agentConfigurations.fixture!.claude!.effective, management.agentConfigurations.fixture!.claude!.effective, key, contextId, "fixture", "claude"), { code: "secret_mask_stale" });
  const nested = masked.definitions.fixture!.server.a;
  assert.ok(nested && typeof nested === "object" && "b" in nested);
  const moved = { ...masked.definitions.fixture!, server: { "a/b": nested.b } };
  assert.throws(() => mergeMcpDefinitionSecrets(moved, definition, key, contextId), { code: "secret_mask_stale" });
  assert.deepEqual(mergeMcpOverrideSecrets({}, override, key, contextId, "fixture", "claude"), {});
  assert.deepEqual(mergeMcpOverrideSecrets({ headers: { authorization: null } }, override, key, contextId, "fixture", "claude"), { headers: { authorization: null } });
});

test("preview masks cannot authorize a definition or assignment write and never expose review secrets", () => {
  const definition = { id: "fixture", name: "Fixture", server: previous.server };
  const preview: ExtensionMcpImportPreview = { previewId: "preview-one", entries: [{ entryId: "entry-one", sourceApp: "claude", serverId: "fixture", name: "Fixture", definition, enabled: true, classification: "new", conflicts: [], resolutions: ["import", "skip"] }], warnings: [] };
  const masked = redactMcpImportPreview(preview, key, contextId);
  assert.equal(JSON.stringify(masked).includes("fixture-private-header"), false);
  assert.throws(() => mergeMcpDefinitionSecrets(masked.entries[0]!.definition, definition, key, contextId), { code: "secret_mask_stale" });
  assert.throws(() => mergeMcpOverrideSecrets(masked.entries[0]!.definition.server, definition.server, key, contextId, "fixture", "claude"), { code: "secret_mask_stale" });
  const nextPreview = redactMcpImportPreview({ ...preview, previewId: "preview-two" }, key, contextId);
  const nextEntry = redactMcpImportPreview({ ...preview, entries: [{ ...preview.entries[0]!, entryId: "entry-two" }] }, key, contextId);
  assert.notDeepEqual(masked.entries[0]!.definition.server, nextPreview.entries[0]!.definition.server);
  assert.notDeepEqual(masked.entries[0]!.definition.server, nextEntry.entries[0]!.definition.server);
});

test("new command inputs reject forged previews, paths, assignment fields and non-JSON configuration", () => {
  for (const command of ["get_mcp_management", "preview_mcp_import"]) assert.throws(() => parseExtensionCommand(command, { appDirs: { claude: "/private/unbound-root" } }));
  assert.throws(() => parseExtensionCommand("import_mcp_from_apps", {}), { code: "command_not_allowed" });
  assert.throws(() => parseExtensionCommand("save_mcp_definition", { definition: { id: "fixture", name: "Fixture", server: {}, apps: { claude: true } } }));
  assert.throws(() => parseExtensionCommand("set_mcp_agent_configuration", { serverId: "fixture", app: "claude", enabled: true, effective: { command: "injected" } }));
  assert.throws(() => parseExtensionCommand("apply_mcp_import", { previewId: "preview", entries: [{ definition: previous }], selections: [] }));
  assert.throws(() => parseExtensionCommand("apply_mcp_import", { previewId: "preview", selections: [{ entryId: "one", resolution: "import", definition: previous }] }));
  assert.throws(() => parseExtensionCommand("apply_mcp_import", { previewId: "preview", selections: [{ entryId: "one", resolution: "import" }, { entryId: "one", resolution: "skip" }] }));
  assert.throws(() => parseExtensionCommand("save_mcp_definition", { definition: { id: "fixture", name: "Fixture", server: JSON.parse('{\"__proto__\":{\"polluted\":true}}') as unknown } }));
  assert.throws(() => parseExtensionCommand("save_mcp_definition", { definition: { id: "fixture", name: "Fixture", server: { value: () => "not-json" } } }));
  const omitted = parseExtensionCommand("set_mcp_agent_configuration", { serverId: "fixture", app: "claude", enabled: true });
  assert.equal(Object.hasOwn(omitted.args, "override"), false);
  assert.equal(parseExtensionCommand("set_mcp_agent_configuration", { serverId: "fixture", app: "claude", enabled: false, override: null }).args.override, null);
});

test("wire schemas strip private authority fields, require real bound rows and refuse unsafe diagnostics", () => {
  const definition = { id: "fixture", name: "Fixture", server: {}, apps: { claude: true }, nativeRoot: "/private/root" };
  const row = { serverId: "fixture", app: "claude", enabled: false, override: null, effective: {}, compatibility: { supported: true, reason: null }, sync: { state: "unassigned", reason: null }, nativeRoot: "/private/root" };
  const source = { definitions: { fixture: definition }, boundApps: ["claude"], agentConfigurations: { fixture: { claude: row } }, privateSnapshot: "withheld" };
  const parsed = parseMcpManagement(source);
  assert.equal(JSON.stringify(parsed).includes("/private/root"), false);
  assert.equal(Object.hasOwn(parsed.definitions.fixture!, "apps"), false);
  assert.throws(() => parseMcpManagement({ ...source, agentConfigurations: {} }), { code: "sidecar_protocol_invalid" });
  assert.throws(() => parseMcpManagement({ ...source, agentConfigurations: { fixture: { claude: { ...row, app: "codex" } } } }), { code: "sidecar_protocol_invalid" });
  assert.throws(() => parseMcpManagement({ ...source, agentConfigurations: { fixture: { claude: { ...row, compatibility: { supported: false, reason: "/private/root fixture-secret" } } } } }), { code: "sidecar_protocol_invalid" });
  assert.throws(() => parseMcpImportPreview({ previewId: "preview", entries: [], warnings: [{ app: "claude", message: "/private/root fixture-secret" }] }), { code: "sidecar_protocol_invalid" });
});

test("legacy private Skills path fields are contextual labels, not browser filesystem authority", () => {
  assert.throws(() => parseExtensionCommand("get_cc_switch_skills_dir", {}), { code: "command_not_allowed" });
  const result = redactOperationResult({ backupPath: "/private/ssot/backups/one", preservedPiPath: "/private/home/.pi/skills/one", piCleanupIncomplete: true }) as Record<string, unknown>;
  assert.equal(JSON.stringify(result).includes("/private/"), false);
  assert.equal(typeof result.backupPath, "string");
  assert.equal(result.piCleanupIncomplete, true);
});
