import { isAbsolute } from "node:path";
import { inspectPayloadFiles, WINDOWS_INSTALL_FILE_LIMIT } from "./payload-files.mjs";

let root;
let limit = WINDOWS_INSTALL_FILE_LIMIT;
let byteLimit = null;
let allowContainedSymlinks = false;
const seen = new Set();
const usage = "Usage: node apps/desktop/scripts/payload-report.mjs --root ABS_DIRECTORY [--limit N] [--byte-limit N] [--allow-contained-symlinks]";
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (seen.has(name)) throw new Error(`Duplicate ${name} argument.`);
  seen.add(name);
  if (name === "--allow-contained-symlinks") {
    allowContainedSymlinks = true;
  } else if (["--root", "--limit", "--byte-limit"].includes(name) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    const value = process.argv[++index];
    if (name === "--root") root = value;
    else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a non-negative safe integer.`);
      if (name === "--limit") limit = Number(value);
      else byteLimit = Number(value);
    }
  } else throw new Error(usage);
}
if (!root || !isAbsolute(root)) throw new Error("An explicit absolute --root directory is required.");

const report = await inspectPayloadFiles(root, { fileLimit: limit, byteLimit, allowContainedSymlinks });
console.log(JSON.stringify({ ...report, limit, byteLimit, withinLimit: report.budgets.withinLimit }, null, 2));
if (!report.budgets.withinLimit) process.exitCode = 1;
