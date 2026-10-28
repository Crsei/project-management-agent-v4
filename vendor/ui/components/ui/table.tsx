import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"
export function TableContainer({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      tabIndex={0}
      {...props}
      className={cn(
        "max-w-full overflow-auto overscroll-contain rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
    />
  )
}
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <table
      {...props}
      className={cn(
        "w-full border-collapse text-left text-[13px] leading-5",
        className,
      )}
    />
  )
}
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      {...props}
      className={cn("bg-surface-raised text-muted-foreground", className)}
    />
  )
}
export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody {...props} />
}
export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot {...props} className={cn("border-t bg-surface-raised", className)} />
  )
}
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      {...props}
      className={cn(
        "border-b last:border-b-0 data-[selected=true]:bg-selection data-[active=true]:outline data-[active=true]:outline-1 data-[active=true]:-outline-offset-1 data-[active=true]:outline-primary",
        className,
      )}
    />
  )
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      {...props}
      className={cn("h-10 whitespace-nowrap px-3 py-1 font-medium", className)}
    />
  )
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td {...props} className={cn("h-10 px-3 py-1 align-middle", className)} />
  )
}
export function TableCaption({
  className,
  ...props
}: ComponentProps<"caption">) {
  return (
    <caption
      {...props}
      className={cn("p-3 text-left text-xs text-muted-foreground", className)}
    />
  )
}
