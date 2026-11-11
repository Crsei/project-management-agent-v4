import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_UPDATE_REPOSITORY, desktopUpdatePolicy, updateInstallStampAssetName } from "./update-policy.mjs";

test("desktop update channels bind only stable or preview versions to the fixed public repository", () => {
  assert.deepEqual(DESKTOP_UPDATE_REPOSITORY, { owner: "Crsei", repo: "project-management-agent-v4" });
  assert.equal(Object.isFrozen(DESKTOP_UPDATE_REPOSITORY), true);
  for (const [version, channel, allowPrerelease] of [["1.2.3", "latest", false], ["1.2.3-preview.1", "preview", true]]) {
    const policy = desktopUpdatePolicy({ version, platform: "win32", signing: "signed", url: "https://untrusted.invalid" });
    assert.deepEqual({ provider: policy.provider, owner: policy.owner, repo: policy.repo, channel: policy.channel, allowPrerelease: policy.allowPrerelease }, { provider: "github", ...DESKTOP_UPDATE_REPOSITORY, channel, allowPrerelease });
    assert.equal(policy.enabled, true);
    assert.equal(Object.isFrozen(policy), true);
  }
  for (const version of ["1.2.3-beta.1", "1.2.3-nightly.1", "1.2.3-preview", "1.2.3-preview.01", "01.2.3", "v1.2.3", "1.2.3+secret", "", null, ["1.2.3"]])
    assert.throws(() => desktopUpdatePolicy({ version, platform: "win32", signing: "signed" }), /version|prerelease/);
  assert.throws(() => desktopUpdatePolicy({ version: "1.2.3", platform: "win32", signing: "unknown" }), /explicit/);
});

test("unsupported and unsigned stable distributions never advertise installable updates", () => {
  for (const [version, platform, signing, enabled] of [
    ["1.2.3", "win32", "unsigned", false], ["1.2.3-preview.1", "win32", "unsigned", true],
    ["1.2.3", "darwin", "signed", true], ["1.2.3-preview.1", "darwin", "signed", true],
    ["1.2.3", "darwin", "unsigned", false], ["1.2.3-preview.1", "darwin", "unsigned", false],
    ["1.2.3-preview.1", "linux", "signed", false],
  ]) {
    const policy = desktopUpdatePolicy({ version, platform, signing });
    assert.equal(policy.enabled, enabled, `${version}/${platform}/${signing}`);
    assert.ok(policy.reason.length);
    if (enabled && signing === "unsigned") assert.match(policy.reason, /testing only.*not trusted signed production/);
  }
});

test("candidate install metadata has one immutable public name per supported native target", () => {
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"]])
    assert.equal(updateInstallStampAssetName({ platform, arch }), `desktop-install-stamp-${platform}-${arch}.json`);
  for (const [platform, arch] of [["linux", "x64"], ["win32", "arm64"], ["darwin", "../x64"]])
    assert.throws(() => updateInstallStampAssetName({ platform, arch }), /Unsupported/);
});
