import type { KeyboardEvent } from "react";
import type { IntegrationCatalogEntry as MarketplaceEntry } from "@openhands/extensions/integrations";
import { McpLogoBadge } from "@pm/openhands-source/components/features/mcp-logo-badge";
import { CirclePlusCheckToggle } from "@pm/openhands-source/components/shared/buttons/circle-plus-check-toggle";
import { getDefaultMcpTransport } from "@pm/openhands-source/utils/mcp-marketplace-utils";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { cn } from "@pm/openhands-source/utils/utils";
import {
  extensionModuleCardInteractiveClassName,
  extensionModuleCardSurfaceClassName,
} from "@pm/openhands-source/utils/extension-module-card-classes";

interface MarketplaceCardProps {
  entry: MarketplaceEntry;
  onClick: () => void;
  onAdd: () => void;
  disabled?: boolean;
}

export function MarketplaceCard({
  entry,
  onClick,
  onAdd,
  disabled = false,
}: MarketplaceCardProps) {
  const { t } = useOpenHandsTranslation();
  const transport = getDefaultMcpTransport(entry);
  const transportLabel = (() => {
    switch (transport?.kind) {
      case "stdio":
        return "STDIO";
      case "shttp":
        return "HTTP";
      case "sse":
        return "SSE";
      default:
        return "";
    }
  })();

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={`${t("MCP$TOGGLE_ADD_SERVER")} · ${entry.name}`}
      onClick={() => { if (!disabled) onClick(); }}
      onKeyDown={handleKeyDown}
      data-testid={`mcp-marketplace-card-${entry.id}`}
      className={cn(
        "oh-mcp-marketplace-card flex flex-col overflow-hidden p-4 text-left",
        extensionModuleCardSurfaceClassName,
        extensionModuleCardInteractiveClassName,
      )}
    >
      <div className="flex items-start gap-3">
        <McpLogoBadge entry={entry} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold">{entry.name}</h3>
              <p className="mt-0.5 text-xs text-tertiary-alt">
                {transportLabel}
              </p>
            </div>
            <CirclePlusCheckToggle
              testId={`mcp-marketplace-toggle-${entry.id}`}
              isSelected={false}
              isDisabled={disabled}
              onToggle={(selected) => {
                if (selected) {
                  onAdd();
                }
              }}
              enableLabelKey="MCP$TOGGLE_ADD_SERVER"
              disableLabelKey="MCP$TOGGLE_ADD_SERVER"
              enableTooltipKey="MCP$TOGGLE_ADD_SERVER"
            />
          </header>
          <p className="line-clamp-3 text-xs leading-relaxed text-tertiary-light">
            {entry.description}
          </p>
        </div>
      </div>
    </div>
  );
}
