import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { ButtonTooltip } from "./button-tooltip"
import { cva, type VariantProps } from "class-variance-authority"
import { LoaderCircle } from "lucide-react"
import { cn } from "../../lib/utils"

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control border border-transparent text-[13px] leading-5 font-medium transition-colors duration-[var(--motion-button)] ease-out outline-none forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 forced-colors:focus-visible:outline-[Highlight] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background forced-colors:aria-pressed:underline aria-pressed:border-primary aria-pressed:bg-selection aria-pressed:text-primary aria-invalid:border-destructive forced-colors:aria-invalid:border-dashed disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        outline:
          "border-border bg-surface hover:border-border-hover hover:bg-surface-hover active:bg-surface-pressed",
        secondary:
          "border-border bg-surface hover:border-border-hover hover:bg-surface-hover active:bg-surface-pressed",
        ghost: "hover:bg-surface-hover active:bg-surface-pressed",
        destructive:
          "bg-destructive text-background hover:bg-destructive/90 active:bg-destructive/80",
      },
      size: {
        sm: "h-control-sm min-w-14 px-2 text-xs leading-4",
        default: "h-control min-w-16 px-3",
        lg: "h-control-lg min-w-18 px-4 text-sm",
        "icon-sm": "size-control-sm [@media(pointer:coarse)]:min-w-11",
        icon: "size-control [@media(pointer:coarse)]:min-w-11",
        "icon-lg":
          "size-control-lg [@media(pointer:coarse)]:min-w-11 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export type ButtonProps = Omit<ButtonPrimitive.Props, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string
    loading?: boolean
  }

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const button = (
    <ButtonPrimitive
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading && (
        <LoaderCircle
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
          strokeWidth={1.75}
        />
      )}
      {children}
    </ButtonPrimitive>
  )
  const label = props["aria-label"]
  if (!size?.startsWith("icon") || !label) return button
  return <ButtonTooltip label={label}>{button}</ButtonTooltip>
}
