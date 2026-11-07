import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/check-third-party-notices.mjs [--integrity | --release]\nDefault: --release. Integrity checks public source notices only; it never grants release authorization.";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else if (args.length > 1 || (args.length === 1 && !["--integrity", "--release"].includes(args[0]))) {
  console.error(usage);
  process.exitCode = 1;
} else {
  await main(args[0] ?? "--release");
}

// All callers provide explicit public repository paths, never credentials,
// environment files, another checkout, node_modules or build/runtime data.
async function file(relative) {
  const segments = relative.split("/");
  if (!relative || segments.some((part) => !part || part === "." || part === "..") || path.isAbsolute(relative) || relative.includes("\\")) {
    throw new Error(`Invalid public notice path: ${relative}`);
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Notice must be a contained regular file: ${relative}`);
    }
  }
  const bytes = await readFile(current);
  if (!bytes.length) throw new Error(`Empty public notice: ${relative}`);
  return bytes;
}

async function json(relative) {
  return JSON.parse((await file(relative)).toString("utf8"));
}

function exactRecord(records, key, expected, manifest) {
  if (!Array.isArray(records)) throw new Error(`Missing original source records: ${manifest}`);
  const matches = records.filter((record) => record[key] === expected);
  if (matches.length !== 1) throw new Error(`Missing/duplicate original notice record ${expected}: ${manifest}`);
  return matches[0];
}

async function originalNotice(relative, record) {
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) {
    throw new Error(`Invalid original notice fingerprint: ${relative}`);
  }
  const bytes = await file(relative);
  if (bytes.length !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error(`Notice differs from its existing original source manifest: ${relative}`);
  }
}

async function equalCopy(original, copy) {
  if (!(await file(original)).equals(await file(copy))) throw new Error(`Legal copy differs from original ${original}: ${copy}`);
}

async function contains(relative, fragments) {
  const text = (await file(relative)).toString("utf8");
  for (const fragment of fragments) if (!text.includes(fragment)) throw new Error(`Incomplete/unexpected notice ${relative}: missing ${fragment}`);
}

function releaseRows(text) {
  const section = text.split(/^## Release blockers\s*$/m);
  if (section.length !== 2) throw new Error("Missing/duplicate Release blockers section in THIRD_PARTY_NOTICES.md");
  const body = section[1].split(/^## /m)[0];
  const rows = body.split(/\r?\n/).filter((line) => /^\| [A-Z][A-Z0-9-]* \|/.test(line) && !line.startsWith("| ID |"));
  const result = new Map();
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3 || !["OPEN", "RESOLVED"].includes(cells[1]) || cells[2].length < 30 || result.has(cells[0])) {
      throw new Error(`Malformed/duplicate release review record: ${row}`);
    }
    result.set(cells[0], { status: cells[1], evidence: cells[2] });
  }
  for (const id of ["OWN-LICENSE", "UI-OWNERSHIP", "MISANS-GRANT", "ASSET-ORIGINS", "ARTIFACT-NOTICES", "AGPL-SOURCE"]) {
    if (!result.has(id)) throw new Error(`Release review record cannot be silently removed: ${id}`);
  }
  return result;
}

async function main(mode) {
  const errors = [];
  let checks = 0;
  const check = async (label, action) => {
    try {
      await action();
      checks++;
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  };

  await check("t3code original notices", async () => {
    const manifestPath = "vendor/t3code/source-manifest.json", manifest = await json(manifestPath);
    const notices = ["vendor/t3code/LICENSE", ...manifest.licenses.spdx_text_resources];
    if (notices.length < 2) throw new Error("Missing existing t3code SPDX resources");
    for (const relative of notices) {
      // Check only the existing public license subtree, not arbitrary manifest paths.
      if (relative !== "vendor/t3code/LICENSE" && !/^third-party-licenses\/spdx\/v[0-9.]+\/[A-Za-z0-9.+-]+\.json$/.test(relative)) throw new Error("Unexpected t3code license resource");
      const destination = relative.startsWith("vendor/") ? relative : `vendor/t3code/${relative}`;
      await originalNotice(destination, exactRecord(manifest.files, "destination_path", destination, manifestPath));
    }
  });
  await check("cc-switch original notice", async () => {
    await contains("vendor/cc-switch/LICENSE", ["MIT License", "Copyright (c) 2025 Jason Young", "THE SOFTWARE IS PROVIDED \"AS IS\""]);
  });
  await check("OpenHands original notices", async () => {
    const manifestPath = "vendor/openhands-extensions/source-manifest.json", manifest = await json(manifestPath);
    for (const relative of ["LICENSE", "extensions/LICENSE"]) await originalNotice(`vendor/openhands-extensions/${relative}`, exactRecord(manifest.files, "destination", relative, manifestPath));
  });
  await check("OpenHands automation notices", async () => {
    const manifestPath = "vendor/openhands-automations/source-pin.json", manifest = await json(manifestPath);
    for (const relative of ["LICENSE.agent-canvas", "LICENSE.extensions"]) {
      const destination = `vendor/openhands-automations/${relative}`;
      await originalNotice(destination, exactRecord(manifest.files, "path", destination, manifestPath));
    }
  });

  for (const [original, copy] of [
    ["vendor/t3code/LICENSE", "LICENSE.t3code"],
    ["vendor/t3code/LICENSE", "apps/web/public/LICENSE.t3code"],
    ["vendor/t3code/LICENSE", "apps/marketing/public/LICENSE.t3code"],
    ["vendor/openhands-extensions/LICENSE", "vendor/openhands-automations/LICENSE.agent-canvas"],
    ["vendor/openhands-extensions/extensions/LICENSE", "vendor/openhands-automations/LICENSE.extensions"],
    ["LICENSE", "apps/web/public/LICENSE"],
    ["LICENSE", "apps/marketing/public/LICENSE"],
  ]) await check(`Notice copy ${copy}`, () => equalCopy(original, copy));

  await check("Host license selection", async () => {
    await contains("LICENSE", ["GNU AFFERO GENERAL PUBLIC LICENSE", "Version 3, 19 November 2007", "13. Remote Network Interaction", "END OF TERMS AND CONDITIONS", "How to Apply These Terms to Your New Programs"]);
    if ((await json("package.json")).license !== "AGPL-3.0-only") throw new Error("Root package license must match the selected AGPL-3.0-only declaration");
  });
  for (const relative of [
    "apps/web/public/fonts/Inter-LICENSE.txt",
    "apps/marketing/public/fonts/dm-sans-OFL.txt",
    "apps/marketing/public/fonts/jetbrains-mono-OFL.txt",
  ]) await check(`OFL text ${relative}`, () => contains(relative, ["SIL OPEN FONT LICENSE Version 1.1", "Permission is hereby granted, free of charge", "TERMINATION", "DISCLAIMER"]));
  await check("MiSans retained agreement", () => contains("apps/web/public/fonts/MiSans-LICENSE.txt", ["https://hyperos.mi.com/font/en/download/", "MiSans Fonts Intellectual Property License Agreement", "You may not adapt or redevelop", "nor may you redistribute or sell the font software"]));
  await check("Retained shadcn public notice", async () => {
    await contains("apps/web/public/licenses/shadcn/LICENSE", ["MIT License", "Copyright (c) 2023 shadcn", "Permission is hereby granted, free of charge", "THE SOFTWARE IS PROVIDED \"AS IS\""]);
  });
  await check("Existing supplemental dependency notices", async () => {
    const manifest = await json("vendor/openhands-extensions/dependency-notices.json");
    if (!Array.isArray(manifest.notices) || !manifest.notices.length) throw new Error("Missing reviewed supplemental notices");
    for (const notice of manifest.notices) {
      if (!notice.name || !notice.version || !notice.license || typeof notice.source !== "string" || !notice.source.startsWith("https://") || typeof notice.text !== "string" || !notice.text.trim() || !/^[a-f0-9]{64}$/.test(notice.sha256 ?? "")) throw new Error("Invalid reviewed supplemental notice");
      if (createHash("sha256").update(notice.text).digest("hex") !== notice.sha256) throw new Error(`Supplemental upstream notice changed: ${notice.name}@${notice.version}`);
    }
  });
  for (const relative of [
    "vendor/t3code/SYNC.md", "vendor/cc-switch/LICENSING.md", "vendor/cc-switch/SYNC.md",
    "vendor/openhands-extensions/LICENSING.md", "vendor/openhands-extensions/SYNC.md",
    "vendor/openhands-automations/README.md", "apps/web/public/fonts/MiSans-NOTICE.txt",
    "apps/marketing/public/THIRD_PARTY_NOTICES.txt",
  ]) await check(`Existing legal/provenance record ${relative}`, () => file(relative));

  let records;
  await check("Release review records", async () => {
    records = releaseRows((await file("THIRD_PARTY_NOTICES.md")).toString("utf8"));
  });
  if (errors.length) {
    console.error(`Notice integrity FAILED (${errors.length} error(s)):\n${errors.join("\n")}`);
  } else {
    console.log(`Scoped public-notice integrity: ${checks} checks passed. This is not authorization or final-artifact verification.`);
  }
  const open = records ? [...records].filter(([, record]) => record.status === "OPEN").map(([id]) => id) : [];
  if (open.length) console.error(`Release authorization BLOCKED: ${open.join(", ")}. See THIRD_PARTY_NOTICES.md#release-blockers.`);
  if (mode === "--release" && !errors.length && !open.length) console.log("Recorded release gate is clear; maintainers remain responsible for the evidence and applicable license obligations.");
  if (errors.length || (mode === "--release" && open.length)) process.exitCode = 1;
}
