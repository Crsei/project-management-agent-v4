import { File, FileCode, FileSpreadsheet, FileText, FolderArchive, Image as ImageIcon, PenTool } from "lucide-react"
import { extensionOf, type FileKind } from "./model"
import styles from "./project-files.module.css"

const icons = {
  fig: PenTool,
  pdf: FileText,
  zip: FolderArchive,
  img: ImageIcon,
  sheet: FileSpreadsheet,
  doc: FileText,
  code: FileCode,
  other: File,
} as const

export function FileTypeIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  const Icon = icons[kind]
  return <span className={styles.typeIcon} data-kind={kind} aria-hidden="true"><Icon size={size} strokeWidth={1.7} /></span>
}

export function FilePreviewArt({ kind, name }: { kind: FileKind; name: string }) {
  const extension = extensionOf(name).slice(0, 4).toUpperCase()
  return <span className={styles.preview} data-kind={kind} aria-hidden="true">
    {kind === "img"
      ? <svg viewBox="0 0 100 60" preserveAspectRatio="none" className={styles.imageArt}>
          <path d="M0 60 L30 28 L52 46 L70 32 L100 58 L100 60 Z" />
          <circle cx="76" cy="16" r="7" />
        </svg>
      : kind === "sheet"
        ? <span className={styles.sheetArt}>{Array.from({ length: 20 }, (_, index) => <i key={index} />)}</span>
        : kind === "fig"
          ? <span className={styles.figArt}>
              <span className={styles.figColumn}><i className={styles.headingLine} /><i /><i style={{ width: "70%" }} /><i className={styles.blockLine} /></span>
              <span className={styles.figSide} />
            </span>
          : kind === "zip"
            ? <FolderArchive size={30} strokeWidth={1.5} />
            : <span className={styles.docArt}>
                <i className={styles.headingLine} /><i /><i /><i style={{ width: "80%" }} /><i /><i style={{ width: "60%" }} />
              </span>}
    {extension && <span className={styles.extBadge}>{extension}</span>}
  </span>
}
