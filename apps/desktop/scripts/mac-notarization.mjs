import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export function finalDmgNotarizationOptions(path, environment = process.env) {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".dmg") || /[\0\r\n]/.test(path))
    throw new Error("Final DMG notarization requires an exact absolute DMG path.");
  const names = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "PM_DESKTOP_MAC_TEAM_ID"];
  if (names.some((name) => environment[name] !== undefined && (typeof environment[name] !== "string" || environment[name].length > 4096 || /[\0\r\n]/.test(environment[name]))))
    throw new Error("Invalid or oversized protected notarization configuration.");
  const expectedTeam = environment.PM_DESKTOP_MAC_TEAM_ID ?? environment.APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(expectedTeam ?? "")) throw new Error("Final signed DMG notarization requires the expected Developer ID team.");
  if (environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID) {
    if (environment.APPLE_TEAM_ID !== expectedTeam) throw new Error("Final DMG notarization team differs from the expected signing team.");
    return { tool: "notarytool", appPath: path, appleId: environment.APPLE_ID, appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD, teamId: environment.APPLE_TEAM_ID };
  }
  if (environment.APPLE_API_KEY && environment.APPLE_API_KEY_ID && environment.APPLE_API_ISSUER)
    return { tool: "notarytool", appPath: path, appleApiKey: environment.APPLE_API_KEY, appleApiKeyId: environment.APPLE_API_KEY_ID, appleApiIssuer: environment.APPLE_API_ISSUER };
  throw new Error("Final signed DMG notarization requires the same complete protected Apple ID or API-key credentials as app notarization; no unsigned or unstapled fallback.");
}
export async function notarizeFinalDmg(path) {
  if (process.platform !== "darwin") throw new Error("Final DMG notarization/stapling requires native macOS.");
  const options = finalDmgNotarizationOptions(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error("Final notarization input must be a nonempty regular DMG.");
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const library = createRequire(builder.resolve("app-builder-lib"));
  // Reuse the builder's locked notarize dependency. Its DMG path uploads the
  // exact container, waits for Accepted, then staples; failures throw, never skip.
  const { notarize } = library("@electron/notarize");
  await notarize(options);
  const { stdout, stderr } = await execute("/usr/bin/xcrun", ["stapler", "validate", path], { maxBuffer: 1024 * 1024 });
  const sidecar = `${path}.blockmap`;
  const sidecarInfo = await lstat(sidecar).catch((cause) => { if (cause.code === "ENOENT") return null; throw cause; });
  if (sidecarInfo) {
    if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) throw new Error("Final DMG blockmap must be a regular builder-owned file.");
    // A staple changes container bytes. Never retain a pre-staple sidecar hash.
    const { buildBlockMap } = library("./targets/blockmap/blockmap.js");
    await buildBlockMap(path, "gzip", sidecar);
  }
  return { status: "passed", path: basename(path), scope: "Exact final DMG notarized and stapled before artifact hashing; credentials are never included in reports.",
    submission: { tool: "locked @electron/notarize/notarytool", accepted: true }, blockmapRegenerated: Boolean(sidecarInfo),
    stapler: { command: "/usr/bin/xcrun", args: ["stapler", "validate", "<final-dmg>"], exitCode: 0,
      stdout: stdout.replaceAll(path, "<final-dmg>"), stderr: stderr.replaceAll(path, "<final-dmg>") } };
}
