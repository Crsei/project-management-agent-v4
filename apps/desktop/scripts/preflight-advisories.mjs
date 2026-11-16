// Fast prefilter for dependency advisories.
//
// The authoritative vulnerability gate scans the exact shipped SBOM built from
// the final installers (sbom.mjs + osv.mjs inside verify-delivery). That gate
// can only run after the full native test suite, so a hostile advisory used to
// surface near the end of a multi-hour job. This preflight queries OSV for the
// lockfile-resolved production closure of the packaged workspaces before any
// build or test runs, so a known advisory fails in minutes and no artifact is
// produced. It is a prefilter only: passing here never authorizes delivery and
// the shipped-SBOM scan remains the only passing authority.
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireCleanVulnerabilityReport, scanSBOM } from "./osv.mjs";
import { npmPurl } from "./sbom.mjs";

// apps/desktop/scripts -> repository root: `pnpm list` must see the workspace.
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The workspaces whose production dependencies end up inside the installers.
// The repository root package is included because stage-workspace deploys its
// production dependencies into the packaged workspace runtime.
export const PRODUCTION_PROJECT_FILTERS = [
  "--filter",
  "project-management-agent-v4",
  "--filter",
  "@agent-workspace/server",
  "--filter",
  "@agent-workspace/desktop",
  "--filter",
  "@agent-workspace/cc-switch-host",
  "--filter",
  "@pm/web",
];

// Only exact registry semver ranges are queryable identities. Anything else
// (link:, file:, workspace:, git:, http(s):, catalog:, missing) has no OSV
// package identity and is skipped rather than guessed.
const PLAIN_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Deterministic provenance placeholders: real commit/artifact identities (owned
// by the shipped-SBOM gate) do not exist before packaging, and these values must
// never be mistaken for a verified source identity.
const PLACEHOLDER_SOURCE = JSON.stringify({ commit: "0".repeat(40), dirty: false, sha256: "0".repeat(64) });

/**
 * Recursively collect queryable production components from `pnpm list --json`.
 * Only `dependencies` and `optionalDependencies` are walked at any depth;
 * devDependencies are never part of an installed closure and are ignored even
 * when a caller passes them.
 *
 * Dependency-map keys are install aliases, not registry identities: an alias
 * such as `"lucide-pm": "npm:lucide-react@^0.577.0"` is listed under the key
 * `lucide-pm` with `from: "lucide-react"`. The registry name is `from` when it
 * is a nonempty string, otherwise the key. Components are deduplicated by
 * `name@version`.
 */
export function collectDependencies(projects) {
  const components = new Map();
  const visit = (dependencies) => {
    if (!dependencies || typeof dependencies !== "object") return;
    for (const [alias, entry] of Object.entries(dependencies)) {
      if (!entry || typeof entry !== "object") continue;
      const name = typeof entry.from === "string" && entry.from ? entry.from : alias;
      const version = entry.version;
      if (typeof name === "string" && name && typeof version === "string" && PLAIN_SEMVER.test(version))
        components.set(`${name}@${version}`, { name, version });
      // A skipped identity can still have queryable transitive packages.
      visit(entry.dependencies);
      visit(entry.optionalDependencies);
    }
  };
  for (const project of Array.isArray(projects) ? projects : []) {
    visit(project?.dependencies);
    visit(project?.optionalDependencies);
  }
  return [...components.values()].sort((left, right) =>
    left.name === right.name ? left.version.localeCompare(right.version, "en") : left.name.localeCompare(right.name, "en"),
  );
}

/**
 * Minimal CycloneDX document shaped exactly like the fields `scanSBOM` and
 * `requireCleanVulnerabilityReport` consume. PURLs come from `npmPurl` so npm
 * scoped names encode identically to the shipped SBOM.
 */
export function buildPreflightSBOM(components) {
  if (!Array.isArray(components) || !components.length)
    throw new Error("An empty production dependency closure is not a clean advisory scan.");
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      properties: [
        { name: "dovspace:source", value: PLACEHOLDER_SOURCE },
        { name: "dovspace:final-artifacts", value: "[]" },
      ],
    },
    components: components.map(({ name, version }) => {
      const purl = npmPurl(name, version);
      return { type: "library", "bom-ref": purl, name, version, purl };
    }),
  };
}

/** Read the lockfile-resolved production tree. No registry access happens here. */
export function readProductionTree({ cwd = REPOSITORY_ROOT, execFile = execFileSync } = {}) {
  const windows = process.platform === "win32";
  const stdout = execFile(
    windows ? "pnpm.cmd" : "pnpm",
    ["list", ...PRODUCTION_PROJECT_FILTERS, "--prod", "--depth", "Infinity", "--json"],
    { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, shell: windows, stdio: ["ignore", "pipe", "inherit"] },
  );
  const text = String(stdout ?? "");
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("pnpm list did not produce a JSON dependency tree.");
  const projects = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(projects) || !projects.length)
    throw new Error("pnpm list returned no selected workspace projects; an empty closure is not a pass.");
  return projects;
}

export async function runPreflight({ scan = scanSBOM, readTree = readProductionTree } = {}) {
  const components = collectDependencies(readTree());
  const sbom = buildPreflightSBOM(components);
  const { report } = await scan(sbom);
  const summary = {
    status: report?.status ?? "missing",
    components: sbom.components.length,
    queries: report?.queries?.length ?? 0,
    vulnerabilities: (report?.vulnerabilities ?? []).map((entry) => ({ id: entry.id, components: entry.components })),
  };
  console.log(JSON.stringify({ gate: "desktop-advisory-preflight", ...summary }, null, 2));
  // Throws on any non-pass status, feed error or uncovered component: a fast
  // prefilter must fail closed exactly like the shipped-SBOM gate.
  requireCleanVulnerabilityReport(report, sbom);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPreflight();
  } catch (cause) {
    console.error(`Desktop advisory preflight failed: ${cause.message}`);
    process.exitCode = 1;
  }
}
