import React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@pm/openhands-source/utils/utils";

/** Compact enum filter matching the source presentation's toolbar dropdown. */
export function EnumFilterDropdown<T extends string>({
  testId,
  value,
  onChange,
  options,
  labelByValue,
  ariaLabel,
  className,
  triggerClassName,
  startContent,
}: {
  testId: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly T[];
  labelByValue: Partial<Record<T, string>>;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  startContent?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const selectedLabel = labelByValue[value] ?? value;
  const defaultOption = options[0];

  React.useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={root} className={cn("oh-enum-filter", className)} data-testid={testId}>
    <button
      type="button"
      data-testid="dropdown-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={() => setOpen(current => !current)}
      className={cn("oh-enum-filter-trigger", triggerClassName)}
      data-filtered={defaultOption && value !== defaultOption ? "true" : undefined}
    >
      {startContent}
      <span>{selectedLabel}</span>
      <ChevronDown className={cn("oh-enum-filter-chevron", open && "oh-enum-filter-chevron-open")} aria-hidden />
    </button>
    {open ? <div role="menu" data-testid={`${testId}-menu`} aria-label={ariaLabel} className="oh-enum-filter-menu">
      {options.map(option => <button
        key={option}
        type="button"
        role="menuitemradio"
        aria-checked={option === value}
        className="oh-enum-filter-option"
        onClick={() => { onChange(option); setOpen(false); }}
      >
        <span>{labelByValue[option] ?? option}</span>
        {option === value ? <Check aria-hidden /> : null}
      </button>)}
    </div> : null}
  </div>;
}
