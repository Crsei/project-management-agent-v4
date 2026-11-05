import React from "react";
import { Check as CheckmarkIcon, Plus as PlusIcon, X as RemoveIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@pm/cc-switch-source/components/ui/tooltip";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { cn } from "@pm/openhands-source/utils/utils";

interface CirclePlusCheckToggleProps {
  testId?: string;
  isSelected: boolean;
  onToggle: (selected: boolean) => void;
  isDisabled?: boolean;
  className?: string;
  enableLabelKey?: string;
  disableLabelKey?: string;
  enableTooltipKey?: string;
  disableTooltipKey?: string;
  removeTooltipKey?: string;
}

export function CirclePlusBadge({
  className,
  testId,
  tooltipKey = "AUTOMATIONS$ADD_AUTOMATION",
}: {
  className?: string;
  testId?: string;
  tooltipKey?: string;
}) {
  const { t } = useOpenHandsTranslation();

  return (
    <Tooltip><TooltipTrigger asChild>
      <span
        aria-hidden="true"
        data-testid={testId}
        className={cn(
          "oh-circle-toggle oh-circle-add inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
          className,
        )}
      >
        <PlusIcon className="size-3" />
      </span>
    </TooltipTrigger><TooltipContent side="top">{t(tooltipKey)}</TooltipContent></Tooltip>
  );
}

export function CirclePlusCheckToggle({
  testId,
  isSelected,
  onToggle,
  isDisabled = false,
  className,
  enableLabelKey = "SETTINGS$SKILLS_ENABLE_SKILL",
  disableLabelKey = "SETTINGS$SKILLS_DISABLE_SKILL",
  enableTooltipKey = "COMMON$ENABLE",
  disableTooltipKey,
  removeTooltipKey = "COMMON$REMOVE",
}: CirclePlusCheckToggleProps) {
  const { t } = useOpenHandsTranslation();
  const [isPointerOver, setIsPointerOver] = React.useState(false);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isDisabled) {
      return;
    }
    onToggle(!isSelected);
    event.currentTarget.blur();
  };

  const showRemoveIcon = isSelected && isPointerOver;
  const selectedTooltipKey = disableTooltipKey ?? removeTooltipKey;
  const tooltipLabel = t(isSelected ? selectedTooltipKey : enableTooltipKey);
  const ariaLabel = t(isSelected ? disableLabelKey : enableLabelKey);

  return (
    <Tooltip><TooltipTrigger asChild>
      <button
        type="button"
        role="switch"
        aria-checked={isSelected}
        data-testid={testId}
        data-showing-remove={showRemoveIcon ? "true" : "false"}
        disabled={isDisabled}
        aria-label={ariaLabel}
        onClick={handleClick}
        onPointerEnter={() => setIsPointerOver(true)}
        onPointerLeave={() => setIsPointerOver(false)}
        className={cn(
          "oh-circle-toggle inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full p-0 transition-colors",
          isSelected &&
            (showRemoveIcon
              ? "border-0 bg-[rgba(248,113,113,0.14)] text-[#ef4444] hover:bg-[rgba(248,113,113,0.24)]"
              : "border border-contrast bg-transparent text-contrast"),
          !isSelected &&
            "border-0 bg-surface-raised text-contrast hover:bg-interactive-hover",
          isDisabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        {isSelected ? (
          showRemoveIcon ? (
            <RemoveIcon
              aria-hidden
              width={14}
              height={14}
              className="stroke-[2.5]"
            />
          ) : (
            <CheckmarkIcon aria-hidden width={14} height={14} />
          )
        ) : (
          <PlusIcon aria-hidden className="size-3" />
        )}
      </button>
    </TooltipTrigger><TooltipContent side="top">{tooltipLabel}</TooltipContent></Tooltip>
  );
}
