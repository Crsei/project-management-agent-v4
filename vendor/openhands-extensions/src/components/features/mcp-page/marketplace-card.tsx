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

export function MarketplaceCard({ entry, onClick, onAdd, disabled = false }: MarketplaceCardProps) {
  const { t } = useOpenHandsTranslation();
  const transport = getDefaultMcpTransport(entry);
  const transportLabel = transport?.kind === "stdio" ? "STDIO" : transport?.kind === "sse" ? "SSE" : transport?.kind === "shttp" ? "HTTP" : "";
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onClick();
    }
  };
  return <div
    role="button"
    tabIndex={disabled ? -1 : 0}
    aria-disabled={disabled}
    aria-label={`${t("MCP$TOGGLE_ADD_SERVER")} · ${entry.name}`}
    onClick={() => { if (!disabled) onClick(); }}
    onKeyDown={handleKeyDown}
    data-testid={`mcp-marketplace-card-${entry.id}`}
    className={cn("oh-mcp-marketplace-card", extensionModuleCardSurfaceClassName, extensionModuleCardInteractiveClassName)}
  >
    <div className="oh-mcp-marketplace-copy">
      <McpLogoBadge entry={entry} />
      <div>
        <header>
          <div>
            <h3 title={entry.name}>{entry.name}</h3>
            <p>{transportLabel}</p>
          </div>
          <CirclePlusCheckToggle
            testId={`mcp-marketplace-toggle-${entry.id}`}
            isSelected={false}
            isDisabled={disabled}
            onToggle={selected => { if (selected) onAdd(); }}
            enableLabelKey="MCP$TOGGLE_ADD_SERVER"
            disableLabelKey="MCP$TOGGLE_ADD_SERVER"
            enableTooltipKey="MCP$TOGGLE_ADD_SERVER"
          />
        </header>
        <p className="oh-mcp-marketplace-description">{entry.description}</p>
      </div>
    </div>
  </div>;
}
