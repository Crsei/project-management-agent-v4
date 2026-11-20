import type { AgentText } from "../i18n";

/**
 * Chinese display text for upstream provider metadata (labels, descriptions,
 * option names). Keys are the exact English strings from provider definitions;
 * unknown or user-defined text falls through unchanged.
 */
const DISPLAY_TEXT: Readonly<Record<string, readonly [zh: string, en: string]>> = {
  Runtime: ["运行时", "Runtime"],
  Setup: ["环境设置", "Setup"],
  "Codex runtime": ["Codex 运行时", "Codex runtime"],
  "Binary path": ["二进制路径", "Binary path"],
  "CODEX_HOME path": ["CODEX_HOME 路径", "CODEX_HOME path"],
  "Shadow home path": ["影子 Home 路径", "Shadow home path"],
  "Launch arguments": ["启动参数", "Launch arguments"],
  "CLAUDE_CONFIG_DIR path": ["CLAUDE_CONFIG_DIR 路径", "CLAUDE_CONFIG_DIR path"],
  "Auto-compact after": ["自动压缩阈值", "Auto-compact after"],
  "Compact idle threads": ["空闲会话压缩", "Compact idle threads"],
  "Server URL": ["服务器地址", "Server URL"],
  "Server password": ["服务器密码", "Server password"],
  "Sign-in method": ["登录方式", "Sign-in method"],
  "API key": ["API 密钥", "API key"],
  "GCP project": ["GCP 项目", "GCP project"],
  "GCP location": ["GCP 区域", "GCP location"],
  "ACP source": ["ACP 来源", "ACP source"],
  "Registry agent ID": ["注册表 Agent ID", "Registry agent ID"],
  "Executable override": ["可执行文件覆盖", "Executable override"],
  "Authentication method": ["认证方式", "Authentication method"],
  "Cursor API key": ["Cursor API 密钥", "Cursor API key"],

  "Use default": ["使用默认", "Use default"],
  "When you return": ["返回时", "When you return"],
  "Before the cache expires (beta)": ["缓存过期前（测试版）", "Before the cache expires (beta)"],
  Never: ["从不", "Never"],
  "Google account": ["Google 账号", "Google account"],
  "Gemini Enterprise": ["Gemini 企业版", "Gemini Enterprise"],
  "Gemini API key": ["Gemini API 密钥", "Gemini API key"],
  "Agent Platform (Vertex AI)": ["Agent Platform（Vertex AI）", "Agent Platform (Vertex AI)"],
  "ACP Registry": ["ACP 注册表", "ACP Registry"],
  "Local command": ["本地命令", "Local command"],
  "Paste API key": ["粘贴 API 密钥", "Paste API key"],
  Optional: ["可选", "Optional"],
  Automatic: ["自动", "Automatic"],
  "e.g. 300000": ["例如 300000", "e.g. 300000"],
  "e.g. --chrome": ["例如 --chrome", "e.g. --chrome"],

  Reasoning: ["推理强度", "Reasoning"],
  "Service Tier": ["服务层级", "Service Tier"],
  Low: ["低", "Low"],
  Medium: ["中", "Medium"],
  High: ["高", "High"],
  "Extra High": ["超高", "Extra High"],
  Xhigh: ["超高", "Xhigh"],
  Max: ["最高", "Max"],
  Ultra: ["极致", "Ultra"],
  None: ["无", "None"],
  Minimal: ["极低", "Minimal"],
  Thinking: ["思考", "Thinking"],
  Standard: ["标准", "Standard"],
  Fast: ["快速", "Fast"],
  Ultrafast: ["极速", "Ultrafast"],

  "Path to the Codex binary used by this instance.": ["此实例使用的 Codex 可执行文件路径。", "Path to the Codex binary used by this instance."],
  "Custom Codex home and config directory.": ["自定义 Codex home 与配置目录。", "Custom Codex home and config directory."],
  "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.": ["账号专属 Codex home；保持 auth.json 独立，同时共享 CODEX_HOME 状态。", "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME."],
  "Additional CLI arguments passed to codex app-server on session start.": ["会话启动时传给 codex app-server 的额外 CLI 参数。", "Additional CLI arguments passed to codex app-server on session start."],
  "Path to the Claude binary used by this instance.": ["此实例使用的 Claude 可执行文件路径。", "Path to the Claude binary used by this instance."],
  "Custom Claude home and config directory. Keeps .claude.json and .claude separate.": ["自定义 Claude home 与配置目录；保持 .claude.json 与 .claude 分离。", "Custom Claude home and config directory. Keeps .claude.json and .claude separate."],
  "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.": ["在 100,000 至 1,000,000 token 后压缩；留空使用 Claude 默认值。", "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default."],
  "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.": ["空闲会话超过 200,000 token 时的压缩时机：返回时、提示缓存过期前或从不。覆盖“提供商 > 高级”中的默认值。", "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced."],
  "Additional CLI arguments passed on session start.": ["会话启动时传入的额外 CLI 参数。", "Additional CLI arguments passed on session start."],
  "Optional. Overrides browser sign-in for this provider.": ["可选；覆盖此提供商的浏览器登录。", "Optional. Overrides browser sign-in for this provider."],
  "Path to the Grok CLI binary.": ["Grok CLI 可执行文件路径。", "Path to the Grok CLI binary."],
  "Path to the fx binary. All fx instances on this machine share its fx login.": ["fx 可执行文件路径；本机所有 fx 实例共享其 fx 登录。", "Path to the fx binary. All fx instances on this machine share its fx login."],
  "Path to the OpenCode binary.": ["OpenCode 可执行文件路径。", "Path to the OpenCode binary."],
  "Leave blank to let T3 Code spawn the server when needed.": ["留空则在需要时由 T3 Code 启动服务器。", "Leave blank to let T3 Code spawn the server when needed."],
  "Stored separately on the host.": ["在主机上单独保存。", "Stored separately on the host."],
  "Google accounts use your subscription; API keys and Agent Platform bill usage.": ["Google 账号使用订阅；API 密钥与 Agent Platform 按用量计费。", "Google accounts use your subscription; API keys and Agent Platform bill usage."],
  "Gemini or Vertex AI express key. Stored separately on the host.": ["Gemini 或 Vertex AI express 密钥；在主机上单独保存。", "Gemini or Vertex AI express key. Stored separately on the host."],
  "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.": ["Gemini 企业版必填；Agent Platform 在未设置 API 密钥时使用。", "Required for Gemini Enterprise. Agent Platform uses it when no API key is set."],
  "Region for Gemini Enterprise or Agent Platform.": ["Gemini 企业版或 Agent Platform 的区域。", "Region for Gemini Enterprise or Agent Platform."],
  "Custom ACP executable. Leave empty to select automatically.": ["自定义 ACP 可执行文件；留空自动选择。", "Custom ACP executable. Leave empty to select automatically."],
  "Path to the Muse Code binary on this environment. Sign in with muse login on that host.": ["此环境中的 Muse Code 可执行文件路径；请在该主机使用 muse login 登录。", "Path to the Muse Code binary on this environment. Sign in with muse login on that host."],
  "Path to the Pi coding agent binary.": ["Pi 编程 Agent 可执行文件路径。", "Path to the Pi coding agent binary."],
  "Additional CLI arguments passed to pi --mode rpc on session start.": ["会话启动时传给 pi --mode rpc 的额外 CLI 参数。", "Additional CLI arguments passed to pi --mode rpc on session start."],
  "Path to the externally managed Oh My Pi coding agent binary.": ["外部管理的 Oh My Pi 编程 Agent 可执行文件路径。", "Path to the externally managed Oh My Pi coding agent binary."],
  "Additional safe OMP options. Protocol, model, permissions, tools, session and configuration paths are controlled by the host. Authenticate with OMP in a terminal; credentials must not be put here.": ["额外的安全 OMP 选项。协议、模型、权限、工具、会话与配置路径由宿主控制。请在终端完成 OMP 认证；不要在此填写凭据。", "Additional safe OMP options. Protocol, model, permissions, tools, session and configuration paths are controlled by the host. Authenticate with OMP in a terminal; credentials must not be put here."],
  "Agent identifier from the official ACP Registry, for example 'devin'.": ["官方 ACP 注册表中的 Agent 标识，例如 'devin'。", "Agent identifier from the official ACP Registry, for example 'devin'."],
  "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment.": ["此环境中的可执行文件。对注册表 Agent，此设置会覆盖分发包的可执行文件，同时保留其参数与环境。", "Executable on this environment. For registry agents, this overrides the distribution executable while keeping its arguments and environment."],
  "Optional ACP authentication method ID. By default, the first agent-managed method is selected.": ["可选的 ACP 认证方式 ID；默认选择第一个由 Agent 管理的方式。", "Optional ACP authentication method ID. By default, the first agent-managed method is selected."],

  "2x speed, increased usage": ["速度 2×，用量增加", "2x speed, increased usage"],
  "Even faster, more expensive": ["更快，费用更高", "Even faster, more expensive"],
  "1.5x speed": ["速度 1.5×", "1.5x speed"],
  "1.5x speed, increased usage": ["速度 1.5×，用量增加", "1.5x speed, increased usage"],
};

export function providerDisplayText(t: AgentText, text: string): string;
export function providerDisplayText(t: AgentText, text: string | undefined): string | undefined;
export function providerDisplayText(t: AgentText, text: string | undefined): string | undefined {
  if (!text) return text;
  const entry = DISPLAY_TEXT[text];
  return entry ? t(entry[0], entry[1]) : text;
}
