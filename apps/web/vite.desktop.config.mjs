import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config.ts";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

// Desktop packaging adds its own provenance without modifying the sealed shared
// Web config or claiming ownership of the OpenHands source generation.
function desktopBundleInputsPlugin() {
  let packages = [];
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return {
    name: "desktop-shipped-web-inputs",
    apply: "build",
    async generateBundle(_options, bundle) {
      const found = new Map();
      const ids = [...new Set(Object.values(bundle).flatMap((output) => output.type === "chunk" ? Object.keys(output.modules) : []))].sort();
      for (const id of ids) {
        const filename = id.split("?")[0];
        if (!filename || id.includes("\0") || !isAbsolute(filename) || !filename.split(/[\\/]/).includes("node_modules")) continue;
        const input = await realpath(filename);
        let directory = dirname(input);
        while (directory !== parse(directory).root) {
          const metadata = await readFile(join(directory, "package.json"), "utf8").then((bytes) => JSON.parse(bytes)).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (metadata?.name && metadata.version) {
            const entry = found.get(directory) ?? { name: metadata.name, version: metadata.version, ...(typeof metadata.license === "string" ? { license: metadata.license } : {}), inputs: [] };
            entry.inputs.push({ path: relative(workspaceRoot, input).split("\\").join("/"), sha256: sha256(await readFile(input)) });
            found.set(directory, entry);
            break;
          }
          directory = dirname(directory);
        }
        if (directory === parse(directory).root) throw new Error(`Actual bundled npm module lacks exact package provenance: ${id}`);
      }
      packages = [...found.values()].sort((a, b) => `${a.name}@${a.version}:${a.inputs[0]?.path}`.localeCompare(`${b.name}@${b.version}:${b.inputs[0]?.path}`, "en"));
    },
    async writeBundle(options, bundle) {
      if (!options.dir) throw new Error("Web SBOM provenance requires directory output");
      const outputs = [];
      for (const name of Object.keys(bundle).sort()) {
        if (isAbsolute(name) || name.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe Web SBOM output path");
        const bytes = await readFile(resolve(options.dir, name));
        outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
      }
      await writeFile(join(options.dir, "desktop-bundle-inputs.json"), JSON.stringify({ schemaVersion: 1, scope: "Actual emitted Rollup chunk npm modules, not installed development dependencies", packages, outputs }, null, 2) + "\n");
    },
  };
}

export default defineConfig(async (environment) => mergeConfig(await baseConfig(environment), { plugins: [desktopBundleInputsPlugin()] }));
