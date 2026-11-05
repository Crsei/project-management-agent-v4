import { Check, type LucideIcon } from "lucide-react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { cn } from "@pm/openhands-source/utils/utils";

interface SkillFacetRowProps {
  labelKey: string;
  count: number;
  checked: boolean;
  disabled: boolean;
  icon?: LucideIcon;
  testId: string;
  onToggle: () => void;
}

export function SkillFacetRow({
  labelKey,
  count,
  checked,
  disabled,
  icon: Icon,
  testId,
  onToggle,
}: SkillFacetRowProps) {
  const { t } = useOpenHandsTranslation();
  const label = t(labelKey);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm",
        disabled
          ? "cursor-default text-tertiary-alt/40"
          : // Same hover pair as the extensions nav links: a raised surface the
            // label brightens against, rather than a light fill it sinks into.
            "cursor-pointer hover:bg-surface-raised hover:text-contrast",
        checked ? "text-contrast" : "text-tertiary-light",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
          checked
            ? "border-contrast bg-contrast text-contrast-foreground"
            : "border-border",
        )}
      >
        {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
      {/* The rail cannot be wide enough for every locale, so a truncated label stays readable on hover. */}
      <span title={label} className="min-w-0 flex-1 truncate">
        {label}
      </span>
      <span className="shrink-0 text-xs text-tertiary-alt">{count}</span>
    </button>
  );
}
