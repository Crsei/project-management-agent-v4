import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { encode, file, inside, prefix, relative, repository, safePath, sha256, verifyOutputs } from "./provenance.mjs";
import { verifyOutputs as verifyCcSwitchOutputs } from "../../cc-switch/scripts/provenance.mjs";

const marker = "openhands-provenance.json";
const legalFiles = ["LICENSE", "extensions/LICENSE", "extensions/source-package.json", "LICENSING.md", "SYNC.md", "source-manifest.json", "supplemental-inputs.json", "dependency-notices.json", "fork-policy.json", "output-inventory.json", "resource-closure.json"];
const sharedLegalFiles = [{ source: "vendor/cc-switch/LICENSE", destination: "licenses/cc-switch/LICENSE" }, { source: "vendor/cc-switch/LICENSING.md", destination: "licenses/cc-switch/LICENSING.md" }];
function requiredModules(loaded) {
  return [`${prefix}src/web/index.tsx`, `${prefix}src/routes/mcp.tsx`, `${prefix}src/routes/skills-settings.tsx`, `${prefix}extensions/integrations/index.js`, `${prefix}extensions/integrations/catalog-index.js`, ...loaded.manifest.files.filter((entry) => entry.origin === "extensions-npm" && /^integrations\/catalog\/[^/]+\.json$/.test(entry.source)).map((entry) => prefix + entry.destination)];
}

/** Production-only Vite/Rollup hook; development never requires a final capture. */
export function openHandsProvenancePlugin() {
  let loaded, ccSwitch, outputs, modules, dependencyNotices;
  return {
    name: "reviewed-openhands-runtime-closure",
    apply: "build",
    enforce: "post",
    async buildStart() {
      loaded = await verifyOutputs();
      ccSwitch = await verifyCcSwitchOutputs();
    },
    async generateBundle(_options, bundle) {
      const ids = [...this.getModuleIds()], sourceFiles = new Set(), packageRoots = new Map();
      // Follow the presentation's actual runtime imports, including CC Switch
      // reuse, without claiming unrelated PM/Provider modules as fork inputs.
      const reachable = new Set(), pending = ids.filter(id => id.startsWith(path.resolve(repository, prefix) + path.sep));
      while (pending.length) {
        const id = pending.pop();
        if (reachable.has(id)) continue;
        reachable.add(id);
        const info = this.getModuleInfo(id);
        if (info) pending.push(...info.importedIds, ...info.dynamicallyImportedIds);
      }
      for (const id of ids) {
        if (id.startsWith("\0")) continue;
        const source = id.split("?")[0];
        if (!path.isAbsolute(source)) continue;
        const info = await lstat(source).catch((error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; });
        if (!info?.isFile()) continue;
        const actual = await realpath(source);
        if (inside(path.resolve(repository, prefix), actual)) sourceFiles.add(path.relative(repository, actual).split(path.sep).join("/"));
        if (!reachable.has(id) || !actual.split(path.sep).includes("node_modules")) continue;
        let directory = path.dirname(actual);
        while (directory !== path.parse(directory).root) {
          const metadata = await readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (metadata?.name) { packageRoots.set(directory, metadata); break; }
          directory = path.dirname(directory);
        }
      }
      for (const name of requiredModules(loaded)) if (!sourceFiles.has(name)) throw new Error(`Real OpenHands source/static registry missing from production module graph: ${name}`);
      const known = new Set(loaded.inventory.files.map((entry) => entry.destination));
      for (const name of sourceFiles) if (!known.has(name)) throw new Error(`Unreviewed module in Web production bundle: ${name}`);
      modules = [...sourceFiles].sort();
      for (const name of legalFiles) this.emitFile({ type: "asset", fileName: `licenses/openhands/${name}`, source: (await file(repository, prefix + name)).bytes });
      for (const entry of sharedLegalFiles) this.emitFile({ type: "asset", fileName: entry.destination, source: (await file(repository, entry.source)).bytes });
      dependencyNotices = [];
      const supplementalNotices = JSON.parse((await file(repository, prefix + "dependency-notices.json")).bytes).notices;
      const emit = (asset) => this.emitFile(asset);
      for (const [index, [directory, metadata]] of [...packageRoots].sort(([, a], [, b]) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en")).entries()) {
        const notices = [];
        async function collect(current, within = "") {
          for (const name of (await readdir(current)).sort()) {
            if (!within && !/^(?:licen[cs]es?|copying|notices?|copyright|third-party-licenses)(?:[._-]|$)/i.test(name)) continue;
            const source = path.join(current, name), info = await lstat(source), relativeName = within ? `${within}/${name}` : name;
            if (info.isSymbolicLink() || !inside(directory, source)) throw new Error(`Unsafe Web dependency notice: ${metadata.name}: ${relativeName}`);
            if (info.isDirectory()) await collect(source, relativeName);
            else if (info.isFile()) {
              const bytes = await readFile(source), target = `licenses/openhands/dependencies/${String(index).padStart(4, "0")}/${relativeName}`;
              notices.push({ path: target, sha256: sha256(bytes), bytes: bytes.length });
              emit({ type: "asset", fileName: target, source: bytes });
            } else throw new Error(`Unsupported Web notice: ${relativeName}`);
          }
        }
        await collect(directory);
        if (!notices.length) {
          const notice = supplementalNotices.find(entry => entry.name === metadata.name && entry.version === metadata.version && entry.license === metadata.license);
          if (notice) {
            const bytes = Buffer.from(notice.text), target = `licenses/openhands/dependencies/${String(index).padStart(4, "0")}/LICENSE`;
            if (sha256(bytes) !== notice.sha256) throw new Error(`Changed reviewed upstream notice: ${metadata.name}`);
            notices.push({ path: target, sha256: notice.sha256, bytes: bytes.length, source: notice.source });
            emit({ type: "asset", fileName: target, source: bytes });
          }
        }
        if (!notices.length) throw new Error(`Imported Web dependency has no shipped legal notice: ${metadata.name}@${metadata.version}`);
        dependencyNotices.push({ name: metadata.name, version: metadata.version ?? null, license: metadata.license ?? null, notices });
      }
      this.emitFile({ type: "asset", fileName: "licenses/openhands/dependencies/index.json", source: encode({ scope: "Transitive runtime imports of the actual OpenHands presentation, including CC Switch reuse; unrelated PM/Provider modules are not claimed.", packages: dependencyNotices }) });
      outputs = Object.keys(bundle);
    },
    async writeBundle(options, bundle) {
      if (!options.dir) throw new Error("OpenHands Web provenance requires a directory output.");
      const current = await verifyOutputs();
      if (sha256(current.inventoryBytes) !== sha256(loaded.inventoryBytes)) throw new Error("OpenHands source generation changed during Web build.");
      const currentCcSwitch = await verifyCcSwitchOutputs();
      if (sha256(currentCcSwitch.inventoryBytes) !== sha256(ccSwitch.inventoryBytes)) throw new Error("CC Switch source generation changed during Web build.");
      const directory = path.resolve(options.dir), files = [];
      // writeBundle runs after Vite's transforms; hash the actual emitted bytes,
      // including inlined assets in chunks and legal assets added by this hook.
      for (const name of [...new Set([...outputs, ...Object.keys(bundle)])].sort()) {
        relative(name); const input = await file(directory, name);
        files.push({ path: name, sha256: sha256(input.bytes), bytes: input.bytes.length });
      }
      await writeFile(await safePath(directory, marker), encode({ version: 1, upstreamCommit: loaded.policy.upstreamCommit, outputInventorySha256: sha256(loaded.inventoryBytes), ccSwitchOutputInventorySha256: sha256(ccSwitch.inventoryBytes), sourceManifestSha256: sha256(loaded.manifestBytes), modules, dependencyNotices, files }));
    },
  };
}

/** Verify the exact built Web generation before Agent or desktop staging. */
export async function verifyWebDistribution(directory, root = repository) {
  const loaded = await verifyOutputs(root), bytes = (await file(directory, marker)).bytes, inventory = JSON.parse(bytes);
  if (inventory.version !== 1 || inventory.upstreamCommit !== loaded.policy.upstreamCommit || inventory.outputInventorySha256 !== sha256(loaded.inventoryBytes) || inventory.sourceManifestSha256 !== sha256(loaded.manifestBytes) || !Array.isArray(inventory.modules) || !Array.isArray(inventory.files)) throw new Error("Web artifact was not built from the current reviewed OpenHands generation.");
  const ccSwitch = await verifyCcSwitchOutputs(root);
  if (inventory.ccSwitchOutputInventorySha256 !== sha256(ccSwitch.inventoryBytes)) throw new Error("Web artifact CC Switch source generation changed.");
  const knownModules = new Set(loaded.inventory.files.map((entry) => entry.destination));
  for (const name of requiredModules(loaded)) if (!inventory.modules.includes(name)) throw new Error(`Missing real OpenHands runtime module: ${name}`);
  for (const name of inventory.modules) if (!knownModules.has(name)) throw new Error(`Unreviewed packaged source module: ${name}`);
  const seen = new Set();
  for (const entry of inventory.files) {
    relative(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate Web artifact entry: ${entry.path}`);
    seen.add(entry.path);
    const current = await file(directory, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes) throw new Error(`Web resource changed after build: ${entry.path}`);
  }
  for (const name of legalFiles) {
    const target = `licenses/openhands/${name}`;
    if (!seen.has(target)) throw new Error(`Missing packaged OpenHands legal resource: ${target}`);
    if (!(await file(directory, target)).bytes.equals((await file(root, prefix + name)).bytes)) throw new Error(`Packaged OpenHands legal/source ledger differs from reviewed source: ${target}`);
  }
  for (const entry of sharedLegalFiles) {
    if (!seen.has(entry.destination) || !(await file(directory, entry.destination)).bytes.equals((await file(root, entry.source)).bytes)) throw new Error(`Missing/changed shared CC Switch legal asset: ${entry.destination}`);
  }
  if (!seen.has("licenses/openhands/dependencies/index.json") || !Array.isArray(inventory.dependencyNotices) || !inventory.dependencyNotices.length) throw new Error("Missing actual Web dependency license closure.");
  for (const dependency of inventory.dependencyNotices) {
    if (!Array.isArray(dependency.notices) || !dependency.notices.length) throw new Error(`Missing dependency notice: ${dependency.name}`);
    for (const notice of dependency.notices) {
      if (!seen.has(notice.path) || sha256((await file(directory, notice.path)).bytes) !== notice.sha256) throw new Error(`Missing/changed dependency legal asset: ${notice.path}`);
    }
  }
  return { inventory, sha256: sha256(bytes), outputInventorySha256: sha256(loaded.inventoryBytes) };
}
