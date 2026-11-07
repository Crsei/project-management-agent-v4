import type { AppId } from "@pm/cc-switch-ui";
import { APP_DISPLAY_NAME } from "@pm/cc-switch-ui";
import { cn } from "@pm/openhands-source/utils/utils";

interface Appearance {
  short: string;
  color: string;
  foreground: string;
}

const APPEARANCE: Partial<Record<AppId, Appearance>> = {
  codex: { short: "C", color: "#10a37f", foreground: "#ffffff" },
  claude: { short: "Cl", color: "#d97757", foreground: "#21100b" },
  "claude-desktop": { short: "Cd", color: "#d97757", foreground: "#21100b" },
  pi: { short: "Pi", color: "#f472b6", foreground: "#3f0a24" },
  omp: { short: "O", color: "#e2e8f0", foreground: "#0b0e14" },
  opencode: { short: "O", color: "#e2e8f0", foreground: "#0b0e14" },
  gemini: { short: "G", color: "#4285f4", foreground: "#ffffff" },
  openclaw: { short: "Oc", color: "#8b5cf6", foreground: "#ffffff" },
  hermes: { short: "H", color: "#f59e0b", foreground: "#21100b" },
  kimi: { short: "K", color: "#0ea5e9", foreground: "#ffffff" },
  mcode: { short: "M", color: "#ef4444", foreground: "#ffffff" },
  dsh: { short: "D", color: "#2563eb", foreground: "#ffffff" },
  agy: { short: "A", color: "#14b8a6", foreground: "#042f2e" },
  grokbuild: { short: "G", color: "#111827", foreground: "#ffffff" },
};

const FALLBACK_COLORS = ["#64748b", "#0891b2", "#7c3aed", "#be185d", "#b45309", "#15803d"];

function appearanceFor(app: string): Appearance {
  const known = APPEARANCE[app as AppId];
  if (known) return known;
  const name = APP_DISPLAY_NAME[app as AppId] ?? app;
  let hash = 0;
  for (const character of app) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return {
    short: name.slice(0, 2) || app.slice(0, 2).toUpperCase(),
    color: FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length]!,
    foreground: "#ffffff",
  };
}

const SIZES = {
  xs: "oh-agent-avatar-xs",
  sm: "oh-agent-avatar-sm",
  md: "oh-agent-avatar-md",
  lg: "oh-agent-avatar-lg",
} as const;

export function AgentAvatar({ app, size = "sm", className }: {
  app: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const appearance = appearanceFor(app);
  const name = APP_DISPLAY_NAME[app as AppId] ?? app;
  return <span
    title={name}
    aria-label={name}
    data-agent={app}
    className={cn("oh-agent-avatar", SIZES[size], className)}
    style={{ backgroundColor: appearance.color, color: appearance.foreground }}
  >{appearance.short}</span>;
}

export function AgentStack({ appIds, size = "sm", max = 4, className, emptyLabel }: {
  appIds: readonly string[];
  size?: keyof typeof SIZES;
  max?: number;
  className?: string;
  emptyLabel?: string;
}) {
  if (appIds.length === 0) return emptyLabel ? <span className="oh-agent-stack-empty">{emptyLabel}</span> : null;
  const visible = appIds.slice(0, max);
  const overflow = appIds.length - visible.length;
  return <span className={cn("oh-agent-stack", className)} aria-label={appIds.map(app => APP_DISPLAY_NAME[app as AppId] ?? app).join(", ")}>
    {visible.map(app => <AgentAvatar key={app} app={app} size={size} />)}
    {overflow > 0 ? <span className={cn("oh-agent-avatar oh-agent-avatar-overflow", SIZES[size])}>+{overflow}</span> : null}
  </span>;
}
