import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPreflightSBOM, collectDependencies, PRODUCTION_PROJECT_FILTERS } from "./preflight-advisories.mjs";

// Offline only: these tests exercise the pure collection/building functions and
// never construct a scanner, so no OSV request can be made.
const node = (version, extra = {}) => ({ from: "", version, ...extra });

test("collects dependencies at every depth including optionalDependencies", () => {
  const projects = [
    {
      name: "@agent-workspace/desktop",
      dependencies: {
        pg: node("8.23.1", {
          dependencies: { "pg-pool": node("3.10.0", { dependencies: { "pg-types": node("2.2.0") } }) },
          optionalDependencies: { "pg-native": node("3.5.2") },
        }),
      },
    },
  ];
  assert.deepEqual(
    collectDependencies(projects).map((entry) => `${entry.name}@${entry.version}`),
    ["pg@8.23.1", "pg-native@3.5.2", "pg-pool@3.10.0", "pg-types@2.2.0"],
  );
});

test("deduplicates identical name@version across depth, projects and dependency kinds", () => {
  const shared = () => node("4.13.18");
  const projects = [
    { dependencies: { hono: shared(), "@hono/node-server": node("2.1.6", { dependencies: { hono: shared() } }) } },
    { dependencies: { hono: shared() }, optionalDependencies: { hono: shared() } },
  ];
  const components = collectDependencies(projects);
  assert.deepEqual(components, [{ name: "@hono/node-server", version: "2.1.6" }, { name: "hono", version: "4.13.18" }]);
  assert.equal(new Set(components.map((entry) => `${entry.name}@${entry.version}`)).size, components.length);
});

test("queries the aliased registry package instead of the install alias key", () => {
  // apps/web declares "lucide-pm": "npm:lucide-react@^0.577.0"; pnpm lists the
  // key as lucide-pm and the real registry identity in `from`.
  const components = collectDependencies([
    {
      dependencies: {
        "lucide-pm": { from: "lucide-react", version: "0.577.0" },
        "lucide-react": { from: "lucide-react", version: "1.61.0" },
        "missing-from": { version: "2.0.0" },
        "empty-from": { from: "", version: "3.0.0" },
      },
    },
  ]);
  assert.deepEqual(components, [
    { name: "empty-from", version: "3.0.0" },
    { name: "lucide-react", version: "0.577.0" },
    { name: "lucide-react", version: "1.61.0" },
    { name: "missing-from", version: "2.0.0" },
  ]);
  const purls = buildPreflightSBOM(components).components.map((component) => component.purl);
  assert.ok(purls.includes("pkg:npm/lucide-react@0.577.0"));
  assert.ok(!purls.some((purl) => purl.includes("lucide-pm")));
});

test("deduplicates an alias resolved to the same name@version as a direct dependency", () => {
  const components = collectDependencies([
    { dependencies: { "lucide-pm": { from: "lucide-react", version: "0.577.0" }, "lucide-react": { version: "0.577.0" } } },
  ]);
  assert.deepEqual(components, [{ name: "lucide-react", version: "0.577.0" }]);
});

test("keeps distinct versions of one package apart", () => {
  const components = collectDependencies([
    { dependencies: { semver: node("7.7.2", { dependencies: { semver: node("6.3.1") } }) } },
  ]);
  assert.deepEqual(
    components.map((entry) => `${entry.name}@${entry.version}`),
    ["semver@6.3.1", "semver@7.7.2"],
  );
});

test("skips non-registry and missing identities without losing their queryable children", () => {
  const projects = [
    {
      dependencies: {
        "@agent-workspace/contracts": node("link:../../../packages/agent-contracts", {
          dependencies: { zod: node("4.6.7") },
        }),
        "@t3tools/contracts": node("workspace:*"),
        "vendored-gfm": node("file:vendor/t3code/third-party/remark-gfm"),
        "git-only": node("git+https://example.invalid/repo.git#abcdef0"),
        "tarball-only": node("https://example.invalid/pkg-1.0.0.tgz"),
        "no-version": { from: "no-version" },
        "range-only": node("^1.2.3"),
        "catalog-ref": node("catalog:"),
        good: node("1.0.0", { dependencies: { "@scope/child": node("2.0.0") } }),
      },
    },
  ];
  assert.deepEqual(
    collectDependencies(projects).map((entry) => `${entry.name}@${entry.version}`),
    ["@scope/child@2.0.0", "good@1.0.0", "zod@4.6.7"],
  );
});

test("never collects devDependencies", () => {
  const projects = [
    {
      devDependencies: { electron: node("45.0.0"), "electron-builder": node("26.18.0") },
      dependencies: { "electron-updater": node("6.8.11") },
    },
  ];
  assert.deepEqual(collectDependencies(projects), [{ name: "electron-updater", version: "6.8.11" }]);
});

test("tolerates malformed project and dependency entries", () => {
  assert.deepEqual(collectDependencies(undefined), []);
  assert.deepEqual(collectDependencies([]), []);
  assert.deepEqual(collectDependencies([null, {}, { dependencies: null }, { dependencies: { broken: null, alsoBroken: 7 } }]), []);
});

test("emits the CycloneDX skeleton scanSBOM and the clean-report gate require", () => {
  const sbom = buildPreflightSBOM([
    { name: "@agent-workspace/server", version: "0.1.0" },
    { name: "hono", version: "4.13.18" },
  ]);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.version, 1);
  const properties = new Map(sbom.metadata.properties.map((entry) => [entry.name, entry.value]));
  const source = JSON.parse(properties.get("dovspace:source"));
  assert.deepEqual(source, { commit: "0".repeat(40), dirty: false, sha256: "0".repeat(64) });
  assert.deepEqual(JSON.parse(properties.get("dovspace:final-artifacts")), []);
  // buildPreflightSBOM preserves the caller's order; collectDependencies already
  // sorts deterministically before this point.
  assert.deepEqual(sbom.components, [
    {
      type: "library",
      "bom-ref": "pkg:npm/%40agent-workspace/server@0.1.0",
      name: "@agent-workspace/server",
      version: "0.1.0",
      purl: "pkg:npm/%40agent-workspace/server@0.1.0",
    },
    { type: "library", "bom-ref": "pkg:npm/hono@4.13.18", name: "hono", version: "4.13.18", purl: "pkg:npm/hono@4.13.18" },
  ]);
});

test("encodes scoped PURLs exactly like the shipped SBOM's npmPurl", () => {
  const sbom = buildPreflightSBOM([
    { name: "@pm/web", version: "0.1.0" },
    { name: "@hono/node-server", version: "2.1.6" },
    { name: "@napi-rs/keyring", version: "1.3.0" },
  ]);
  assert.deepEqual(
    sbom.components.map((component) => component.purl),
    ["pkg:npm/%40pm/web@0.1.0", "pkg:npm/%40hono/node-server@2.1.6", "pkg:npm/%40napi-rs/keyring@1.3.0"],
  );
  assert.equal(new Set(sbom.components.map((component) => component["bom-ref"])).size, sbom.components.length);
});

test("refuses to scan an empty closure", () => {
  assert.throws(() => buildPreflightSBOM([]), /empty production dependency closure/);
  assert.throws(() => buildPreflightSBOM(undefined), /empty production dependency closure/);
});

test("queries exactly the five packaged workspaces, including the root package", () => {
  assert.deepEqual(PRODUCTION_PROJECT_FILTERS.filter((entry) => entry !== "--filter"), [
    "project-management-agent-v4",
    "@agent-workspace/server",
    "@agent-workspace/desktop",
    "@agent-workspace/cc-switch-host",
    "@pm/web",
  ]);
});
