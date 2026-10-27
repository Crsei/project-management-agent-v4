import { useState } from "react"
import { cn } from "../../lib/utils"
export type AvatarProps = {
  name: string
  src?: string
  initials?: string
  size?: 20 | 24 | 32 | 36 | 40
  className?: string
}
function AvatarImage({
  src,
  name,
  fallback,
}: {
  src: string
  name: string
  fallback: React.ReactNode
}) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    fallback
  ) : (
    // Portable caller-owned images.
    <img
      src={src}
      alt={name}
      className="size-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}
export function Avatar({
  name,
  src,
  initials,
  size = 32,
  className,
}: AvatarProps) {
  const text =
    initials ??
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toLocaleUpperCase()
  const fallback = (
    <span
      role="img"
      aria-label={name}
      className="flex size-full items-center justify-center bg-surface-raised text-xs font-medium"
    >
      {text || "?"}
    </span>
  )
  return (
    <span
      className={cn(
        "inline-flex shrink-0 overflow-hidden rounded-full border align-middle",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {src ? (
        <AvatarImage key={src} src={src} name={name} fallback={fallback} />
      ) : (
        fallback
      )}
    </span>
  )
}
