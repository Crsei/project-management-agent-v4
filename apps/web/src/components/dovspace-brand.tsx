import styles from "./dovspace-brand.module.css"

export function DovspaceWordmark({ height = 22 }: { height?: number }) {
  return <span className={styles.wordmark} style={{ fontSize: height, lineHeight: `${height}px` }}>Dovspace</span>
}

export function DovspaceMark({ size = 22, decorative = false }: { size?: number; decorative?: boolean }) {
  return <img className={styles.mark} src="/dovspace.svg?v=20261115" width={size} height={size} alt={decorative ? "" : "Dovspace"} />
}

export function DovspaceBrandLink({ collapsed = false, canLeave }: { collapsed?: boolean; canLeave?: () => boolean }) {
  return <a href="/pm" className={styles.link} aria-label="Dovspace" title="Dovspace"
    data-navigation-close data-automation-leave-guarded={canLeave ? "true" : undefined}
    onClick={event => { if (canLeave && !canLeave()) event.preventDefault() }}>
    <DovspaceMark decorative />
    {!collapsed && <DovspaceWordmark />}
  </a>
}

/** A read/load indicator only; callers own the actual pending state and message. */
export function DovspaceLoading({ message, className = "" }: { message: string; className?: string }) {
  return <div role="status" className={`${styles.loading} ${className}`}>
    <span className={styles.loadingMark}><DovspaceMark size={24} decorative /></span>
    <span>{message}</span>
  </div>
}
