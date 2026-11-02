// Provider presentation adapted from t3code usageProviders.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { UsageProviderKind } from "@agent-workspace/contracts/usage";
import { ProviderGlyph } from "../settings/provider-card";
import "./usage-charts.css";

const PRESENTATION = {
  codex: { label: "Codex", color: "var(--foreground)" },
  claude: { label: "Claude Code", color: "#d97757" },
  grok: { label: "Grok Build", color: "color-mix(in oklab, var(--foreground) 72%, var(--background))" },
  fx: { label: "FX", color: "#b48b36" },
  cursor: { label: "Cursor", color: "#8b8b8b" },
  opencode: { label: "OpenCode", color: "#5b9bbd" },
  antigravity: { label: "Antigravity", color: "#8c7bd1" },
  pi: { label: "Pi", color: "#4d9f8a" },
  omp: { label: "OMP", color: "#c17b36" },
  muse: { label: "Muse Code", color: "#0866ff" },
  acpRegistry: { label: "ACP Registry", color: "#b36b9f" },
} satisfies Record<UsageProviderKind, { label: string; color: string }>;

export function providerPresentation(provider: UsageProviderKind): { label: string; color: string } {
  return PRESENTATION[provider];
}

/** Decorative brand mark; the adjacent provider name supplies its accessible label. */
export function UsageProviderIcon({ provider, size = 18, className }: { provider: UsageProviderKind; size?: number; className?: string }) {
  return <span className={`usage-provider-icon${className ? ` ${className}` : ""}`} style={{ width: size, height: size }} aria-hidden="true"><ProviderGlyph driver={provider} /></span>;
}
