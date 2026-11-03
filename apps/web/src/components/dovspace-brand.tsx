import styles from "./dovspace-brand.module.css"

export function DovspaceWordmark({ height = 22 }: { height?: number }) {
  return <span className={styles.wordmark} style={{ fontSize: height, lineHeight: `${height}px` }}>Dovspace</span>
}

export function DovspaceMark({ size = 22 }: { size?: number }) {
  return <img className={styles.mark} src="/dovspace.svg" width={size} height={size} alt="Dovspace" />
}

export function DovspaceBrandLink({ collapsed = false, canLeave }: { collapsed?: boolean; canLeave?: () => boolean }) {
  return <a href="/pm" className={styles.link} aria-label="Dovspace" title="Dovspace"
    data-navigation-close data-automation-leave-guarded={canLeave ? "true" : undefined}
    onClick={event => { if (canLeave && !canLeave()) event.preventDefault() }}>
    <DovspaceMark />
    {!collapsed && <DovspaceWordmark />}
  </a>
}
