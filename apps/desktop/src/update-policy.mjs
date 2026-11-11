export const DESKTOP_UPDATE_REPOSITORY = Object.freeze({ owner: "Crsei", repo: "project-management-agent-v4" });

export function desktopUpdatePolicy({ version, platform, signing }) {
  const match = typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(preview)\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) throw new Error("Desktop updates require an exact stable or preview.N version; unknown prerelease channels are not supported.");
  if (!["signed", "unsigned"].includes(signing)) throw new Error("Desktop updates require an explicit signed or unsigned distribution identity.");
  const allowPrerelease = match[4] === "preview";
  let enabled = false;
  let reason;
  if (platform !== "win32" && platform !== "darwin") reason = "This operating system has no supported desktop updater distribution.";
  else if (platform === "darwin" && signing !== "signed") reason = "Unsigned/ad-hoc macOS distributions cannot install updates; a signed and notarized application is required.";
  else if (signing === "unsigned" && !allowPrerelease) reason = "Unsigned stable distributions cannot install updates; use a signed release.";
  else {
    enabled = true;
    reason = signing === "unsigned" ? "Unsigned Windows preview updates are for explicit testing only, not trusted signed production releases." : "Updates use the fixed public GitHub Releases repository and preserve native signature verification.";
  }
  return Object.freeze({ provider: "github", ...DESKTOP_UPDATE_REPOSITORY, channel: allowPrerelease ? "preview" : "latest", allowPrerelease, enabled, reason });
}

export function updateInstallStampAssetName({ platform, arch }) {
  if (!(platform === "win32" && arch === "x64" || platform === "darwin" && ["x64", "arm64"].includes(arch))) throw new Error("Unsupported desktop update install-stamp target.");
  return `desktop-install-stamp-${platform}-${arch}.json`;
}
