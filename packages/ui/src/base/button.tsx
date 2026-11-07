import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/agent-cn";

const buttonVariants = cva(
  "group/button focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 inline-flex shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-transparent bg-clip-padding text-[13px] leading-5 font-medium whitespace-nowrap transition-colors duration-[var(--motion-button)] ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45 aria-pressed:border-primary aria-pressed:bg-selection aria-pressed:text-primary aria-invalid:ring-1 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        outline:
          "border-border bg-surface text-foreground hover:border-border-hover hover:bg-surface-hover active:bg-surface-pressed aria-expanded:border-border-hover aria-expanded:bg-surface-hover",
        secondary:
          "border-border bg-surface text-foreground hover:border-border-hover hover:bg-surface-hover active:bg-surface-pressed aria-expanded:border-border-hover aria-expanded:bg-surface-hover",
        ghost:
          "hover:bg-surface-hover active:bg-surface-pressed aria-expanded:bg-surface-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-background hover:bg-destructive/90 active:bg-destructive/80 focus-visible:border-destructive focus-visible:ring-destructive/30",
        link: "text-primary hover:text-primary/80",
      },
      size: {
        default:
          "h-8 min-w-16 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-[var(--control-radius)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 min-w-14 gap-1 px-2.5 text-xs leading-4 in-data-[slot=button-group]:rounded-[var(--control-radius)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-18 gap-2 px-4 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 [@media(pointer:coarse)]:min-w-11",
        "icon-xs":
          "size-6 in-data-[slot=button-group]:rounded-[var(--control-radius)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 [@media(pointer:coarse)]:min-w-11",
        "icon-lg": "size-9 [@media(pointer:coarse)]:min-w-11 [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
