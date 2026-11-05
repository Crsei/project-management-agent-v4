import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import type { IntegrationCatalogEntry } from "@openhands/extensions/integrations";
import slackLogoUrl from "@pm/openhands-source/icons/slack.svg";
import { cn } from "@pm/openhands-source/utils/utils";

type McpLogoEntry = Pick<
  IntegrationCatalogEntry,
  "id" | "name" | "iconBg" | "iconColor" | "logoUrl"
>;

export type { McpLogoEntry };

interface McpLogoBadgeProps {
  entry?: McpLogoEntry | null;
  size?: "xs" | "sm" | "base" | "md";
  className?: string;
  fallback?: ReactNode;
  testId?: string;
}

const sizeClassNames = {
  xs: "h-4 w-4 rounded [&>svg]:h-2.5 [&>svg]:w-2.5",
  sm: "h-5 w-5 rounded-md [&>svg]:h-3 [&>svg]:w-3",
  base: "h-7 w-7 rounded-lg [&>svg]:h-3.5 [&>svg]:w-3.5",
  md: "h-10 w-10 rounded-lg [&>svg]:h-5 [&>svg]:w-5",
};


export function McpLogoBadge({
  entry,
  size = "md",
  className,
  fallback,
  testId,
}: McpLogoBadgeProps) {
  const localLogoUrl = entry?.id === "slack" ? slackLogoUrl : undefined;
  return (
    <span
      aria-hidden="true"
      title={entry?.name}
      data-testid={testId}
      data-logo-size={size}
      className={cn(
        "oh-mcp-logo inline-flex shrink-0 items-center justify-center overflow-hidden",
        sizeClassNames[size],
        className,
      )}
      style={{
        backgroundColor: entry?.iconBg ?? "var(--oh-color-tertiary)",
        color:
          entry?.iconColor ??
          (entry?.iconBg ? "#FFFFFF" : "var(--oh-contrast)"),
      }}
    >
      {localLogoUrl || entry?.logoUrl ? (
        <img
          src={localLogoUrl ?? entry?.logoUrl}
          alt=""
          className="h-full w-full object-contain p-[22%]"
          onError={(e) => {
            const image = e.currentTarget;
            image.style.display = "none";
          }}
        />
      ) : (
        (fallback ?? <Bot className="h-5 w-5" strokeWidth={2.25} />)
      )}
    </span>
  );
}
