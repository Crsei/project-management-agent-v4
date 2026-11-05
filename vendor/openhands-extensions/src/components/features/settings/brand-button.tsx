import { forwardRef } from "react";
import { cn } from "@pm/openhands-source/utils/utils";

interface BrandButtonProps {
  testId?: string;
  name?: string;
  variant: "primary" | "secondary" | "tertiary" | "danger" | "ghost-danger";
  type: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
  isDisabled?: boolean;
  className?: string;
  onClick?: (event?: React.MouseEvent<HTMLButtonElement>) => void;
  startContent?: React.ReactNode;
  /** Accessible label for icon-only buttons */
  ariaLabel?: string;
  /** Indicates busy/loading state for screen readers */
  "aria-busy"?: boolean;
  "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  "aria-expanded"?: boolean;
}

export const BrandButton = forwardRef<
  HTMLButtonElement,
  React.PropsWithChildren<BrandButtonProps>
>(function BrandButton(
  {
    testId,
    name,
    children,
    variant,
    type,
    isDisabled,
    className,
    onClick,
    startContent,
    ariaLabel,
    "aria-busy": ariaBusy,
    "aria-haspopup": ariaHasPopup,
    "aria-expanded": ariaExpanded,
  },
  ref,
) {
  return (
    <button
      ref={ref}
      name={name}
      data-testid={testId}
      disabled={isDisabled}
      // The type is already passed as a prop to the button component

      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      className={cn(
        "oh-brand-button",
        `oh-brand-button-${variant}`,
        startContent && "flex items-center justify-center gap-2",
        className,
      )}
    >
      {startContent}
      {children}
    </button>
  );
});
