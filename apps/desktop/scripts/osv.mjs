import { createHash } from "node:crypto";

export const OSV_ENDPOINT = "https://api.osv.dev/v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => JSON.stringify(value, null, 2) + "\n";

function sourceOnlyCoverage(component) {
  if (component.purl !== undefined) return null;
  const provenance = JSON.parse(component.properties?.find((entry) => entry.name === "dovspace:source-provenance")?.value ?? "null");
  if (component.version !== undefined || !component["bom-ref"] || !component.name
    || component.properties?.find((entry) => entry.name === "dovspace:component-origin")?.value !== "sealed-source-vendor"
    || !/^[a-f0-9]{40}$/.test(provenance?.source?.commit ?? "") || !/^[a-f0-9]{64}$/.test(provenance?.source?.sha256 ?? "")
    || typeof provenance?.source?.dirty !== "boolean" || typeof provenance?.inventory?.path !== "string"
    || !/^[a-f0-9]{64}$/.test(provenance?.inventory?.sha256 ?? ""))
    throw new Error("Unqueryable SBOM component lacks explicit sealed source/vendor provenance.");
  return { component: component["bom-ref"], name: component.name, status: "not-scanned-source-provenance",
    reason: "No registry version or PURL exists; retained exact source/inventory identity, not counted as a successful OSV package query.", provenance };
}
export function vulnerabilitySARIF(report) {
  const vulnerabilities = report.vulnerabilities ?? [];
  const rules = vulnerabilities.map((entry) => ({ id: entry.id, shortDescription: { text: entry.summary || entry.id },
    helpUri: entry.references?.[0]?.url ?? `https://osv.dev/vulnerability/${encodeURIComponent(entry.id)}` }));
  const results = vulnerabilities.flatMap((entry) => entry.components.map((component) => ({ ruleId: entry.id, level: "error",
    message: { text: `${component}: ${entry.summary || entry.id}. Fixed versions: ${(entry.fixedVersions ?? []).join(", ") || "none supplied by advisory"}. No automatic dependency update or suppression is performed.` },
    properties: { component, aliases: entry.aliases, fixedVersions: entry.fixedVersions } })));
  const success = report.status === "passed";
  return { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{
    tool: { driver: { name: "Dovspace shipped-closure OSV gate", informationUri: "https://osv.dev", rules } },
    invocations: [{ executionSuccessful: success || report.status === "vulnerabilities-found", toolExecutionNotifications: success ? [] : [{ level: "error", message: { text: report.error ?? "Unwithdrawn vulnerabilities block delivery." } }] }],
    results, properties: { scanStatus: report.status, sbomSha256: report.sbomSha256, endpoint: report.endpoint, finalArtifacts: report.artifacts, source: report.source, sourceComponents: report.sourceComponents },
  }] };
}
export async function scanSBOM(sbom, { fetcher = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const bytes = jsonBytes(sbom);
  const report = { schemaVersion: 1, endpoint: OSV_ENDPOINT, startedAt: now(), status: "running", sbomSha256: hash(bytes),
    source: JSON.parse(sbom.metadata.properties.find((entry) => entry.name === "dovspace:source").value),
    artifacts: JSON.parse(sbom.metadata.properties.find((entry) => entry.name === "dovspace:final-artifacts").value),
    coverageScope: "OSV indexed advisories queried by exact shipped component PURL; generic Node/PostgreSQL PURLs use OSV's OSS-Fuzz mapping, not a comprehensive upstream vendor CVE audit. Unversioned source/vendor components are explicitly not-scanned with sealed provenance, not registry-query passes. An empty successful query is not a claim that a component has no vulnerabilities outside this feed.",
    policy: "Every unwithdrawn OSV advisory blocks delivery; no severity, network-error, unsupported-feed or missing-response bypass.", queries: [], sourceComponents: [], advisories: [], vulnerabilities: [] };
  let failureKind = "feed-error";
  async function request(path, body) {
    let response;
    try {
      response = await fetcher(`${OSV_ENDPOINT}${path}`, { method: body ? "POST" : "GET", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000), redirect: "error" });
    } catch (cause) { failureKind = "network-error"; throw new Error(`OSV network request failed; this is not a clean scan: ${cause.message}`); }
    if (!response.ok) throw new Error(`OSV feed request failed with HTTP ${response.status}; no clean result is available.`);
    const result = await response.json();
    if (!result || typeof result !== "object" || result.error || result.code || result.message) throw new Error("OSV feed returned an API error or unsupported query.");
    return result;
  }
  try {
    const packages = new Map();
    for (const component of sbom.components) {
      const sourceOnly = sourceOnlyCoverage(component);
      if (sourceOnly) { report.sourceComponents.push(sourceOnly); continue; }
      if (typeof component.purl !== "string" || !component.purl || !component["bom-ref"]) throw new Error("Shipped component lacks a queryable exact package identity.");
      if (!packages.has(component.purl)) packages.set(component.purl, []);
      packages.get(component.purl).push(component["bom-ref"]);
    }
    if (!packages.size) throw new Error("An empty shipped closure is not a clean vulnerability scan.");
    const entries = [...packages].sort(([left], [right]) => left.localeCompare(right, "en"));
    const impacted = new Map();
    for (let offset = 0; offset < entries.length; offset += 100) {
      const batch = entries.slice(offset, offset + 100);
      const queries = batch.map(([purl]) => ({ package: { purl } }));
      const response = await request("/querybatch", { queries });
      if (!Array.isArray(response.results) || response.results.length !== batch.length) throw new Error("Incomplete OSV batch response; missing feed coverage is not a pass.");
      for (const [index, result] of response.results.entries()) {
        if (!result || typeof result !== "object" || result.error || result.code || result.message || result.vulns !== undefined && !Array.isArray(result.vulns)) throw new Error("Invalid or unsupported OSV component response.");
        const [purl, components] = batch[index];
        report.queries.push({ purl, components, response: result });
        for (const advisory of result.vulns ?? []) {
          if (typeof advisory.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(advisory.id)) throw new Error("OSV response lacks a safe advisory identifier.");
          if (!impacted.has(advisory.id)) impacted.set(advisory.id, new Set());
          for (const component of components) impacted.get(advisory.id).add(component);
        }
      }
    }
    for (const [id, components] of [...impacted].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      const advisory = await request(`/vulns/${encodeURIComponent(id)}`);
      if (advisory.id !== id || !Array.isArray(advisory.affected)) throw new Error("OSV advisory details do not match the returned affected-package identity.");
      report.advisories.push(advisory);
      if (!advisory.withdrawn) report.vulnerabilities.push({ id, summary: advisory.summary ?? advisory.details ?? id, aliases: advisory.aliases ?? [],
        components: [...components].sort(), fixedVersions: [...new Set(advisory.affected.flatMap((entry) => (entry.ranges ?? []).flatMap((range) => (range.events ?? []).flatMap((event) => event.fixed ? [event.fixed] : []))))].sort(), references: advisory.references ?? [] });
    }
    report.sourceComponents.sort((a, b) => a.component.localeCompare(b.component, "en"));
    report.status = report.vulnerabilities.length ? "vulnerabilities-found" : "passed";
  } catch (cause) { report.status = failureKind; report.error = cause.message; }
  report.finishedAt = now();
  return { report, sarif: vulnerabilitySARIF(report) };
}
export function requireCleanVulnerabilityReport(report, sbom) {
  if (report?.status !== "passed" || report.endpoint !== OSV_ENDPOINT || !Array.isArray(report.queries) || !report.queries.length
    || !Array.isArray(report.vulnerabilities) || report.vulnerabilities.length || !Array.isArray(report.advisories) || !Array.isArray(report.sourceComponents)
    || report.advisories.some((entry) => !entry.withdrawn)
    || report.queries.some((entry) => !entry.response || entry.response.error || entry.response.code
      || entry.response.message || entry.response.vulns?.some((vuln) => !report.advisories.some((advisory) => advisory.id === vuln.id && advisory.withdrawn))))
    throw new Error(`Shipped dependency vulnerability gate failed (${report?.status ?? "missing"}): ${report?.error ?? `${report?.vulnerabilities?.length ?? "unknown"} unwithdrawn advisories; inspect desktop-osv.json and desktop-vulnerabilities.sarif`}`);
  if (sbom) {
    const packages = new Map();
    const expectedSources = [];
    for (const component of sbom.components) {
      const sourceOnly = sourceOnlyCoverage(component);
      if (sourceOnly) { expectedSources.push(sourceOnly); continue; }
      if (!packages.has(component.purl)) packages.set(component.purl, []);
      packages.get(component.purl).push(component["bom-ref"]);
    }
    const expected = [...packages].map(([purl, components]) => ({ purl, components: components.sort() })).sort((a, b) => a.purl.localeCompare(b.purl, "en"));
    const actual = report.queries.map(({ purl, components }) => ({ purl, components: [...components].sort() })).sort((a, b) => a.purl.localeCompare(b.purl, "en"));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("OSV scan does not cover the exact complete shipped SBOM component set.");
    const sources = [...report.sourceComponents].sort((a, b) => a.component.localeCompare(b.component, "en"));
    if (JSON.stringify(expectedSources.sort((a, b) => a.component.localeCompare(b.component, "en"))) !== JSON.stringify(sources))
      throw new Error("OSV source-only coverage does not match the exact sealed unversioned SBOM components.");
  }
}
