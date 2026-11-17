import desktopPackage from "../../../desktop/package.json";

type UnavailableEvidence = { status: "unavailable"; reason: string };
type HistoricalArtifact = {
  name: string;
  bytes: number;
  sha256: string;
  metadataUrl: string;
};
type HistoricalPlatform = {
  name: string;
  architecture: string;
  mark: string;
  format: string;
  requirement: string;
  manifestUrl: string;
  artifacts: readonly HistoricalArtifact[];
  installation: { status: "disabled"; reason: string };
} & (
  | { target: "win32-x64"; signature: "unsigned"; notarization: "not-applicable" }
  | { target: "darwin-arm64" | "darwin-x64"; signature: "ad-hoc"; notarization: "not-notarized" }
);
type HistoricalRelease = {
  scope: "historical-prerelease";
  tag: string;
  applicationVersion: string;
  channel: "preview";
  publishedAt: string;
  url: string;
  apiUrl: string;
  source: {
    commit: string;
    commitUrl: string;
    archiveUrl: string;
    tagEvidenceUrl: string;
    packageIdentity: UnavailableEvidence;
  };
  checksums: { url: string; evidence: string; installerBytesVerified: false };
  materials: UnavailableEvidence;
  nativeAcceptance: UnavailableEvidence;
  platforms: readonly HistoricalPlatform[];
};

export const releaseRepository = {
  url: "https://github.com/Crsei/project-management-agent-v4",
  releasesUrl: "https://github.com/Crsei/project-management-agent-v4/releases",
  metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4",
};

// Reviewed public metadata only. No runtime fetch, installer URL or permission to publish.
export const releaseSnapshot = {
  reviewedOn: "2026-11-14",
  inventoryUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases?per_page=100",
  publicReleaseCount: 1,
  scope: "读取时公开 API 返回一个非草稿预发布；本页不是实时更新源，也不覆盖私有、草稿或未发布材料。",
};

// Read at marketing build time; this is a source declaration, never a built-artifact identity.
export const currentDesktopSource = {
  declaredVersion: desktopPackage.version,
  distribution: "unreleased-source",
  installation: {
    status: "disabled",
    reason: "当前源码的 Windows／macOS 安装、启动、升级、卸载保留数据及 GUI 验收仍未闭合；历史材料不适用于本次工作树。",
  },
  sourceIdentity: {
    status: "unavailable",
    reason: "未建立当前完整工作树、实际成品与公开对应源码的精确关系；仓库首页或某个已推送 commit 不能代替这一证明。",
  },
  materials: {
    status: "unavailable",
    reason: "本快照未找到此声明版本的公开 Release 材料；当前安装器摘要、签名／公证与成品清单不可从历史包沿用。",
  },
  openReleaseBlockers: ["ARTIFACT-NOTICES", "AGPL-SOURCE"],
} as const;

export const historicalDesktopRelease = {
  scope: "historical-prerelease",
  tag: "v0.1.0-preview.1",
  applicationVersion: "0.1.0",
  channel: "preview",
  publishedAt: "2026-11-04T03:18:25Z",
  url: "https://github.com/Crsei/project-management-agent-v4/releases/tag/v0.1.0-preview.1",
  apiUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/433471286",
  source: {
    commit: "a063dc07b06f82c1123dfeeb3f93b22b0fb33542",
    commitUrl: "https://github.com/Crsei/project-management-agent-v4/commit/a063dc07b06f82c1123dfeeb3f93b22b0fb33542",
    archiveUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/zipball/a063dc07b06f82c1123dfeeb3f93b22b0fb33542",
    tagEvidenceUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/git/ref/tags/v0.1.0-preview.1",
    packageIdentity: {
      status: "unavailable",
      reason: "提交由历史发行说明与公开 tag 相互印证；旧 desktop-package 清单没有 source.commit、dirty 或源码内容摘要，不能据此证明安装器的完整对应源码。",
    },
  },
  checksums: {
    url: "https://github.com/Crsei/project-management-agent-v4/releases/download/v0.1.0-preview.1/SHA256SUMS.txt",
    evidence: "下列安装器 SHA256 在公开 Releases API、各平台 desktop-package 清单与 SHA256SUMS.txt 中一致；大小取自 API。未下载或重新计算安装器字节摘要，摘要不是发布者签名。",
    installerBytesVerified: false,
  },
  materials: {
    status: "unavailable",
    reason: "公开资产列表没有当前格式的 desktop-release.json、desktop-verification.json、完整 desktop-source／desktop-legal 归档、SBOM／漏洞报告或候选 install stamp。旧平台清单未声明 schemaVersion，不能按当前 schema 3 交付验收。",
  },
  nativeAcceptance: {
    status: "unavailable",
    reason: "历史发行说明仅记录原生测试与服务冒烟；它同时明确安装／卸载 GUI 和真实 Provider 推理未完成。未提供安装、升级、卸载保留数据与 GUI 的完整验收证据。",
  },
  platforms: [
    {
      name: "macOS",
      architecture: "Apple Silicon · arm64",
      target: "darwin-arm64",
      mark: "M",
      format: ".dmg / .zip",
      requirement: "历史包要求 macOS 15 或更高版本",
      signature: "ad-hoc",
      notarization: "not-notarized",
      manifestUrl: "https://github.com/Crsei/project-management-agent-v4/releases/download/v0.1.0-preview.1/desktop-package-darwin-arm64.json",
      artifacts: [
        {
          name: "PM-Agent-v4-0.1.0-mac-arm64-unsigned.dmg",
          bytes: 375430386,
          sha256: "9d267b43adf6f2620b4b4cd2ffd1b5841cf6bf0d392ea89b9d68fea93a75f54f",
          metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/assets/708050428",
        },
        {
          name: "PM-Agent-v4-0.1.0-mac-arm64-unsigned.zip",
          bytes: 387946314,
          sha256: "a266a3c1e742f60f98d3d447384ea12882683f8074f135bab65f7c2239e3063d",
          metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/assets/708050835",
        },
      ],
      installation: {
        status: "disabled",
        reason: "仅有历史 ad-hoc 测试材料，没有 Developer ID 签名或公证，原生安装与 GUI 验收不完整；不提供安装入口。",
      },
    },
    {
      name: "macOS",
      architecture: "Intel · x64",
      target: "darwin-x64",
      mark: "M",
      format: ".dmg / .zip",
      requirement: "历史包要求 macOS 15 或更高版本",
      signature: "ad-hoc",
      notarization: "not-notarized",
      manifestUrl: "https://github.com/Crsei/project-management-agent-v4/releases/download/v0.1.0-preview.1/desktop-package-darwin-x64.json",
      artifacts: [
        {
          name: "PM-Agent-v4-0.1.0-mac-x64-unsigned.dmg",
          bytes: 386806579,
          sha256: "ee95a57c3d306afef5db9bb396c1d43e8ee7a7645b7a8d0951b65ff946eb8577",
          metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/assets/708051254",
        },
        {
          name: "PM-Agent-v4-0.1.0-mac-x64-unsigned.zip",
          bytes: 399241603,
          sha256: "2b87dc88cc34c2ed62e3a878935267b4782510ecf2506a481365bc4eba5e171d",
          metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/assets/708052038",
        },
      ],
      installation: {
        status: "disabled",
        reason: "仅有历史 ad-hoc 测试材料，没有 Developer ID 签名或公证，原生安装与 GUI 验收不完整；不提供安装入口。",
      },
    },
    {
      name: "Windows",
      architecture: "x64",
      target: "win32-x64",
      mark: "W",
      format: "NSIS · .exe",
      requirement: "历史目标仅 x64；不提供 Windows ARM64",
      signature: "unsigned",
      notarization: "not-applicable",
      manifestUrl: "https://github.com/Crsei/project-management-agent-v4/releases/download/v0.1.0-preview.1/desktop-package-win32-x64.json",
      artifacts: [
        {
          name: "PM-Agent-v4-0.1.0-win-x64-unsigned.exe",
          bytes: 1148704327,
          sha256: "ad599faa5f9d7fb0e264cd805c4128effa186383508fa25809d38eb34a25c0cf",
          metadataUrl: "https://api.github.com/repos/Crsei/project-management-agent-v4/releases/assets/708052431",
        },
      ],
      installation: {
        status: "disabled",
        reason: "unsigned preview 仅供测试，不是可信签名生产包；完整安装、升级、卸载保留数据及 GUI 验收缺失，不提供安装入口。",
      },
    },
  ],
} as const satisfies HistoricalRelease;
