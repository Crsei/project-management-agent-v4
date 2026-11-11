import { createHash } from "node:crypto";

export function installStamp(version = "0.1.1-preview.1", overrides = {}) {
  return {
    formatVersion: 1, appId: "com.projectmanagementagent.v4", commit: "a".repeat(40), version,
    platform: "win32", arch: "x64", distribution: "nsis", payload: "bundled", updateMechanism: "github-releases",
    ownership: { installation: "self", scope: "per-user" }, source: { sha256: "b".repeat(64), dirty: false },
    signing: "unsigned", runtime: { node: "24.21.0", postgres: "16.15" },
    compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) }, ...overrides,
  };
}

// Intentionally inert bytes: this fixture exercises network/integrity behavior,
// never OS installation, signature validation or a real packaged installer.
export function updateRelease({ version = "0.1.1-preview.2", current = installStamp(), targetArch = current.arch } = {}) {
  const payload = Buffer.from("Inert desktop updater network fixture; this is not an executable installer.\n".repeat(128));
  const stamp = installStamp(version, { ...structuredClone(current), version, arch: targetArch, commit: "d".repeat(40) });
  const asset = `PM-Agent-v4-${version}-${stamp.platform === "darwin" ? "mac" : "win"}-${stamp.arch}-${stamp.signing}.${stamp.platform === "darwin" ? "zip" : "exe"}`;
  const artifact = { path: asset, bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
  const info = { version, tag: `v${version}`, files: [{ url: asset, size: payload.length, sha512: createHash("sha512").update(payload).digest("base64") }], path: asset, sha512: createHash("sha512").update(payload).digest("base64") };
  const stampName = `desktop-install-stamp-${stamp.platform}-${stamp.arch}.json`;
  const manifestName = `${stamp.platform}-${stamp.arch}-${stamp.signing}-desktop-package.json`;
  const manifest = { schemaVersion: 3, version, target: `${stamp.platform}-${stamp.arch}`, signing: stamp.signing,
    source: { commit: stamp.commit, ...stamp.source }, installStamp: stamp, artifacts: [artifact], materials: [] };
  const release = { current, payload, stamp, info, artifact, manifest, stampName, manifestName, requests: [] };
  release.routes = () => {
    const stampBytes = Buffer.from(`${JSON.stringify(stamp)}\n`);
    manifest.materials = [{ path: stampName, bytes: stampBytes.length, sha256: createHash("sha256").update(stampBytes).digest("hex") }];
    const prefix = `/Crsei/project-management-agent-v4/releases/download/v${version}/`;
    return new Map([
      [`${prefix}${stampName}`, stampBytes], [`${prefix}${manifestName}`, Buffer.from(JSON.stringify(manifest))],
      [`/repos/Crsei/project-management-agent-v4/git/ref/tags/v${version}`, Buffer.from(JSON.stringify({ object: { type: "commit", sha: stamp.commit } }))],
      [`${prefix}${asset}`, payload],
    ]);
  };
  release.fetch = async (url, options) => {
    release.requests.push({ url, options });
    const bytes = release.routes().get(new URL(url).pathname);
    return new Response(bytes ?? "missing", { status: bytes ? 200 : 404 });
  };
  return release;
}
