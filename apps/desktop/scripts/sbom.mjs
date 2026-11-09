import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { asarTools } from "./packaged-application.mjs";
import { dependencyLayoutManifest } from "./dependency-layout-verifier.mjs";
import { assertNoNodeTooling, hashFile, inventoryTree, NODE_VERSION, POSTGRES_VERSION, validateRuntimeManifest } from "./runtime-manifest.mjs";
import { verifyHost } from "../../server/agent/scripts/cc-switch.mjs";

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safe = (path) => typeof path === "string" && path && !/[\\:\0\r\n]/.test(path) && !posix.isAbsolute(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
export const npmPurl = (name, version) => `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`;
function component(name, version, location, files, { ecosystem = "npm", license, sourceProvenance } = {}) {
  if (typeof name !== "string" || !name) throw new Error(`Shipped SBOM component lacks an exact name: ${location}`);
  const versioned = typeof version === "string" && version.length > 0;
  if (!versioned && (version !== null && version !== undefined || !sourceProvenance
    || !/^[a-f0-9]{40}$/.test(sourceProvenance.source?.commit ?? "") || !/^[a-f0-9]{64}$/.test(sourceProvenance.source?.sha256 ?? "")
    || typeof sourceProvenance.source?.dirty !== "boolean" || !/^[a-f0-9]{64}$/.test(sourceProvenance.inventory?.sha256 ?? "")))
    throw new Error(`Unversioned SBOM component lacks sealed source provenance: ${location}`);
  return { type: "library", "bom-ref": location, name,
    ...(versioned ? { version, purl: ecosystem === "npm" ? npmPurl(name, version) : `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}` } : {}),
    ...(typeof license === "string" && license ? { licenses: [{ license: { name: license } }] } : {}),
    properties: [{ name: "dovspace:shipped-location", value: location }, { name: "dovspace:resource-inventory-sha256", value: sha(files) },
      { name: "dovspace:resource-files", value: String(files.length) },
      { name: "dovspace:component-origin", value: versioned ? ecosystem === "npm" ? "versioned-npm" : "pinned-runtime-distribution" : "sealed-source-vendor" },
      ...(!versioned ? [{ name: "dovspace:source-provenance", value: JSON.stringify(sourceProvenance) }] : [])] };
}
export async function inspectShippedSBOM(resources, { target, version, electronVersion, source, artifacts }) {
  source = { commit: source?.commit, dirty: source?.dirty, sha256: source?.sha256 };
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(electronVersion ?? "") || !source?.sha256 || !artifacts?.length)
    throw new Error("SBOM requires pinned Electron and exact final source/artifact identities.");
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-sbom-")));
  const archive = join(resources, "app.asar"), asar = asarTools();
  asar.uncache(archive);
  try {
    asar.extractAll(archive, temporary);
    const components = [], dependencies = [];
    for (const [root, prefix] of [[temporary, "app.asar"], [join(resources, "workspace-runtime"), "workspace-runtime"]]) {
      const layout = JSON.parse(await readFile(join(root, dependencyLayoutManifest), "utf8"));
      for (const context of layout.contexts) {
        for (const instance of context.instances) {
          const path = `${prefix}/${instance.path}`;
          const metadata = JSON.parse(await readFile(join(root, instance.path, "package.json"), "utf8"));
          if (metadata.name !== instance.name || metadata.version !== instance.version) throw new Error("SBOM package metadata differs from verified shipped closure.");
          const files = [];
          for (const file of instance.files) {
            if (!safe(file.path)) throw new Error("Unsafe SBOM package resource path.");
            const input = join(root, instance.path, file.path), info = await lstat(input);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error("SBOM must inventory actual regular shipped resources.");
            files.push({ path: file.path, bytes: info.size, sha256: await hashFile(input) });
          }
          components.push(component(metadata.name, metadata.version, path, files, { license: metadata.license }));
          dependencies.push({ ref: path, dependsOn: [...new Set(Object.values(instance.dependencies).map((id) => `${prefix}/${id}`))].sort() });
        }
      }
    }
    const workspace = join(resources, "workspace-runtime");
    const agentPath = "agent-artifact-manifest.json";
    const agent = JSON.parse(await readFile(join(workspace, agentPath), "utf8"));
    if (!Array.isArray(agent.bundled)) throw new Error("SBOM requires actual Agent bundled-input provenance, not an installed development graph.");
    const agentInventorySha256 = await hashFile(join(workspace, agentPath));
    const agentProvenance = { source, inventory: { path: `workspace-runtime/${agentPath}`, sha256: agentInventorySha256 },
      ...(/^[a-f0-9]{40}$/.test(agent.upstreamCommit ?? "") ? { upstreamCommit: agent.upstreamCommit } : {}) };
    for (const [index, entry] of agent.bundled.entries()) {
      const files = [];
      for (const path of entry.notices) {
        if (!safe(path)) throw new Error("Unsafe Agent bundled notice path.");
        files.push({ path, sha256: await hashFile(join(workspace, path)) });
      }
      files.push({ path: agentPath, sha256: agentInventorySha256 });
      components.push(component(entry.name, entry.version, `agent-bundled/${index}`, files, { license: entry.license, sourceProvenance: agentProvenance }));
    }
    const hostDirectory = "apps/server/agent/dist/cc-switch/host";
    const host = await verifyHost(join(workspace, "apps/server/agent/dist"), { installationModes: true });
    if (agent.ccSwitchHost?.manifest !== `${hostDirectory}/manifest.json` || agent.ccSwitchHost.manifestSha256 !== host.manifestSha256
      || agent.ccSwitchHost.sourceCommit !== host.sourceCommit || agent.ccSwitchHost.upstreamVersion !== host.upstreamVersion)
      throw new Error("SBOM CC Switch host differs from the sealed Agent host provenance.");
    const hostIndexPath = `${hostDirectory}/licenses/dependencies/index.json`;
    const hostIndex = JSON.parse(await readFile(join(workspace, hostIndexPath), "utf8"));
    if (!Array.isArray(hostIndex.packages) || !hostIndex.packages.length) throw new Error("SBOM requires the actual separately bundled CC Switch dependency closure.");
    const hostProvenance = { source, inventory: { path: `workspace-runtime/${hostDirectory}/manifest.json`, sha256: host.manifestSha256 }, upstreamCommit: host.sourceCommit };
    for (const [index, entry] of hostIndex.packages.entries()) {
      if (!Array.isArray(entry.files) || !entry.files.length) throw new Error("SBOM CC Switch dependency lacks shipped evidence.");
      const files = [];
      for (const path of [...entry.files, "main.mjs", "manifest.json", "licenses/dependencies/index.json"]) {
        if (!safe(path)) throw new Error("Unsafe CC Switch bundled resource path.");
        files.push({ path: `${hostDirectory}/${path}`, sha256: await hashFile(join(workspace, hostDirectory, path)) });
      }
      components.push(component(entry.name, entry.version, `cc-switch-host-bundled/${index}`, files, { license: entry.license, sourceProvenance: hostProvenance }));
    }
    const webRoot = join(workspace, "apps/web/dist");
    const web = JSON.parse(await readFile(join(webRoot, "desktop-bundle-inputs.json"), "utf8"));
    if (web.schemaVersion !== 1 || !Array.isArray(web.packages) || !Array.isArray(web.outputs) || !web.outputs.length)
      throw new Error("SBOM requires exact Web Rollup bundle input/output provenance.");
    for (const file of web.outputs) {
      if (!safe(file.path) || await hashFile(join(webRoot, file.path)) !== file.sha256) throw new Error("Web SBOM provenance differs from final shipped bundle bytes.");
    }
    for (const [index, entry] of web.packages.entries())
      components.push(component(entry.name, entry.version, `web-bundled/${index}`, web.outputs, { license: entry.license }));
    const runtime = join(resources, "desktop-runtime");
    const runtimeManifest = JSON.parse(await readFile(join(runtime, "runtime-manifest.json"), "utf8"));
    validateRuntimeManifest(runtimeManifest, target);
    await assertNoNodeTooling(runtime, target);
    for (const [name, runtimeVersion, directory] of [["nodejs", NODE_VERSION, "node"], ["postgresql", POSTGRES_VERSION, "postgres"]]) {
      const entry = component(name, runtimeVersion, `desktop-runtime/${directory}`, await inventoryTree(join(runtime, directory)), { ecosystem: "generic" });
      if (directory === "node") entry.properties.push(
        { name: "dovspace:runtime-profile", value: runtimeManifest.nodeDistribution.profile },
        { name: "dovspace:source-archive-sha256", value: runtimeManifest.nodeDistribution.sourceArchiveSha256 },
        { name: "dovspace:source-inventory-sha256", value: sha(runtimeManifest.nodeDistribution.sourceFiles) },
        { name: "dovspace:omitted-tooling-notices", value: "desktop-runtime/node-tooling-notices; legal material only, no package-manager code" });
      components.push(entry);
    }
    const electron = component("electron", electronVersion, "electron-runtime", artifacts);
    electron.properties.push({ name: "dovspace:identity-source", value: "Pinned electronVersion from corresponding-source desktop/package.json and builder config; hashes bind final containers. Not an independently executed Electron version probe." });
    components.push(electron);
    components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"], "en"));
    dependencies.sort((a, b) => a.ref.localeCompare(b.ref, "en"));
    if (new Set(components.map((entry) => entry["bom-ref"])).size !== components.length) throw new Error("Duplicate shipped SBOM component identity.");
    return { bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
      metadata: { component: { type: "application", name: "Dovspace", version, "bom-ref": "desktop-application" },
        properties: [{ name: "dovspace:target", value: target }, { name: "dovspace:source", value: JSON.stringify(source) },
          { name: "dovspace:final-artifacts", value: JSON.stringify(artifacts) },
          { name: "dovspace:scope", value: "Verified physical production closures, exact Agent/CC Switch/Web bundled-input provenance, pinned execution-only Node/PostgreSQL/Electron; omitted Node tooling is not shipped code and its unchanged legal material is retained. Unversioned source/vendor components retain sealed source identity without invented registry versions. Not a legal authorization." }] },
      components, dependencies };
  } finally { asar.uncache(archive); await rm(temporary, { recursive: true, force: true }); }
}
