import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commits = new Set([
  "d53873b6a4799e87afd63c8d288ef0089f5a3748",
  "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c",
]);
function relative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe adaptation path: ${value}`);
  return value;
}
function blob(source, commit, name) {
  if (!commits.has(commit)) throw new Error(`Unapproved source commit: ${commit}`);
  return execFileSync("git", ["-C", source, "show", `${commit}:${relative(name)}`], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}
function splice(original, recipe, name) {
  if (recipe.kind !== "exact-line-splices" || recipe.primaryInput !== 0 || !Array.isArray(recipe.splices)) throw new Error(`Invalid adaptation recipe: ${name}`);
  const lines = original.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output = [];
  let cursor = 0;
  for (const item of recipe.splices) {
    if (!Number.isInteger(item.start) || item.start < cursor || item.start > lines.length || !Array.isArray(item.before) || !Array.isArray(item.after) || ![...item.before, ...item.after].every((line) => typeof line === "string")) throw new Error(`Invalid adaptation ranges: ${name}`);
    const end = item.start + item.before.length;
    if (end > lines.length || lines.slice(item.start, end).join("") !== item.before.join("")) throw new Error(`Adaptation preimage conflict: ${name}`);
    output.push(...lines.slice(cursor, item.start), ...item.after);
    cursor = end;
  }
  output.push(...lines.slice(cursor));
  return Buffer.from(output.join(""));
}

// Returns all bytes before the caller inspects/writes any destination. Git committed
// blobs are inputs only; neither the source worktree nor .ref is a runtime import.
export async function planMcpSkillsAdaptations(repository, source) {
  const manifestPath = path.join(repository, "vendor/t3code/mcp-skills-adaptations.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe adaptation manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || manifest.baselineCommit !== "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c") throw new Error("Adaptation manifest identity mismatch");
  const cache = new Map();
  const modes = new Map();
  const licensed = new Set();
  const distributedLicense = await readFile(path.join(repository, "vendor/t3code/LICENSE"));
  for (const sourceEntry of manifest.sources) {
    const license = blob(source, sourceEntry.commit, sourceEntry.license.path);
    if (sourceEntry.license.spdx !== "MIT" || sourceEntry.license.distributedPath !== "vendor/t3code/LICENSE" || hash(license) !== sourceEntry.license.sha256 || !license.equals(distributedLicense)) throw new Error("Pinned source MIT coverage mismatch");
    licensed.add(sourceEntry.commit);
  }
  const outputs = new Map();
  for (const entry of manifest.outputs) {
    const name = relative(entry.destination);
    if (!/^(?:vendor\/t3code\/|apps\/server\/|apps\/web\/|packages\/)/.test(name) || name.includes("/node_modules/") || name.includes("/.git/") || outputs.has(name)) throw new Error(`Unapproved/duplicate adaptation destination: ${name}`);
    if (![0o644, 0o755].includes(entry.mode)) throw new Error(`Invalid adaptation mode: ${name}`);
    const inputs = entry.inputs ?? [];
    if (Boolean(inputs.length) !== (entry.provenance === "adapted-upstream") || !["adapted-upstream", "local-integration"].includes(entry.provenance)) throw new Error(`Invalid adaptation classification: ${name}`);
    for (const input of inputs) {
      if (!licensed.has(input.commit)) throw new Error(`Unlicensed adaptation input: ${name}`);
      const key = `${input.commit}:${relative(input.path)}`;
      if (!cache.has(key)) {
        cache.set(key, blob(source, input.commit, input.path));
        modes.set(key, execFileSync("git", ["-C", source, "ls-tree", input.commit, "--", input.path], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).split(/\s/)[0]);
      }
      const bytes = cache.get(key);
      const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (hash(bytes) !== input.sha256 || bytes.length !== input.bytes || gitBlob !== input.gitBlobSha1 || !["100644", "100755"].includes(input.gitMode) || modes.get(key) !== input.gitMode) throw new Error(`Adaptation original hash/blob conflict: ${key}`);
    }
    let bytes;
    if (inputs.length) bytes = splice(cache.get(`${inputs[0].commit}:${inputs[0].path}`), entry.recipe, name);
    else {
      if (entry.recipe.kind !== "local-bytes" || typeof entry.recipe.base64 !== "string") throw new Error(`Invalid local integration recipe: ${name}`);
      bytes = Buffer.from(entry.recipe.base64, "base64");
      if (bytes.toString("base64") !== entry.recipe.base64) throw new Error(`Invalid local integration bytes: ${name}`);
    }
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Adaptation output hash conflict: ${name}`);
    outputs.set(name, { relative: name, bytes, mode: entry.mode });
  }
  return outputs;
}
