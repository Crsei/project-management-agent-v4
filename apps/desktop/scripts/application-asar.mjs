import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { asarTools } from "./packaged-application.mjs";
import { verifyDependencyLayout } from "./dependency-layout-verifier.mjs";
import { hashFile } from "./runtime-manifest.mjs";
import { inspectDeployment } from "./stage-workspace.mjs";

// The Electron closure includes pg and the GitHub updater. Native Node/SDK
// dependencies remain in the separate, loose workspace-runtime. Prepacking the
// whole Electron closure keeps builder's dependency filters and package.json
// cleanup from changing inventoried resources (including README/type files).
export async function prepackApplication(application, output) {
  if (!isAbsolute(output)) throw new Error("Prepacked application output must be absolute.");
  for (let current = output; ; current = dirname(current)) {
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (current === output || !info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Prepacked application output must be new with real directory ancestors.");
    if (dirname(current) === current) break;
  }
  application = await realpath(application);
  await inspectDeployment(application);
  await verifyDependencyLayout(application);
  await mkdir(output);
  // No loose package.json may accompany app.asar: the locked builder detects a
  // prepacked project only when its projectDir has no ordinary package manifest.
  const archive = join(output, "app.asar");
  await asarTools().createPackage(application, archive);
  return { directory: output, sha256: await hashFile(archive) };
}
