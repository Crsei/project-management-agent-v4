import type { ReactNode } from "react";
import { cn } from "@pm/openhands-source/utils/utils";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "accent" | "info";

export function StatusPill({ tone = "neutral", dot = false, children, className, title }: {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return <span className={cn("oh-status-pill", className)} data-tone={tone} title={title}>
    {dot ? <span className="oh-status-pill-dot" aria-hidden /> : null}
    {children}
  </span>;
}
