"use client"
import { useId, useState, type ReactNode } from "react"
import { Tabs, TabsList, TabsTab } from "../../ui/tabs"
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import { Button } from "../../ui/button"
import { Menu, MenuTrigger, MenuContent, MenuItem } from "../../ui/menu"
import { RuntimeStatusBadge } from "../../ui/runtime-status-badge"
import { Input } from "../../ui/input"
import { uiMessage } from "../../../lib/i18n-core"
import { useUiFeedback } from "../../../lib/i18n-provider"
import { useI18n } from "../../../lib/i18n-provider"
import { redact } from "../../../lib/redact"
import type { WorkbenchPanelId } from "../../../lib/agent-workbench-model"
import styles from "./workbench.module.css"
export type WorkbenchPanelDescriptor = {
  id: WorkbenchPanelId
  label: ReactNode
  available: boolean
  reason?: string
  badge?: string | number
  render: () => ReactNode
}
export function WorkbenchPanelTabs({
  panels,
  value,
  onChange,
  primaryPanels,
}: {
  panels: readonly WorkbenchPanelDescriptor[]
  value: WorkbenchPanelId
  onChange: (id: WorkbenchPanelId) => void
  /** Optional compact navigation; other panels remain available in a keyboard menu. */
  primaryPanels?: readonly WorkbenchPanelId[]
}) {
  const { t } = useI18n()
  const primary = primaryPanels
    ? primaryPanels.flatMap((id) => panels.filter((p) => p.id === id))
    : [...panels]
  const active = panels.find((p) => p.id === value)
  if (primaryPanels && active && !primary.some((p) => p.id === value)) {
    if (primary.length >= 3) primary.pop()
    primary.push(active)
  }
  const more = panels.filter((p) => !primary.some((item) => item.id === p.id))
  return (
    <Tabs
      value={value}
      onValueChange={(v) => {
        if (panels.some((p) => p.id === v)) onChange(v as WorkbenchPanelId)
      }}
    >
      <div className={styles.panelNavigation} data-panel-navigation>
        <TabsList className={styles.tabs}>
          {primary.map((p) => (
            <TabsTab key={p.id} value={p.id}>
              {p.label}
              {p.badge !== undefined && ` (${p.badge})`}
            </TabsTab>
          ))}
        </TabsList>
        {primaryPanels && more.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="sm" />}>
              {t("workbench.morePanels")}
            </MenuTrigger>
            <MenuContent>
              {more.map((p) => (
                <MenuItem key={p.id} onClick={() => onChange(p.id)}>
                  {p.label}
                  {p.badge !== undefined && ` (${p.badge})`}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
      </div>
      {panels.map((p) => (
        <BaseTabs.Panel
          key={p.id}
          value={p.id}
          keepMounted
          className={styles.tabPanel}
        >
          {p.available ? (
            p.render()
          ) : (
            <p className={styles.section}>
              {p.reason ?? t("workbench.noCapability")}
            </p>
          )}
        </BaseTabs.Panel>
      ))}
    </Tabs>
  )
}
export function ExecutionOutputPanel({
  text,
  source,
  timestamp,
  truncated,
  connected = true,
  onReconnect,
  terminal,
}: {
  text: string
  source: string
  timestamp: string
  truncated?: boolean
  connected?: boolean
  onReconnect?: () => void
  terminal?: ReactNode
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState("")
  const [feedback, setFeedback] = useUiFeedback("")
  const safe = redact(text)
  const lines = safe.split("\n")
  const bounded = lines.slice(0, 200).join("\n").slice(0, 32768)
  const shown = bounded
    .split("\n")
    .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
    .join("\n")
  return (
    <section className={styles.section}>
      <div className={styles.row}>
        <span className={styles.meta}>
          {source} · <time>{timestamp}</time>
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(shown)
              setFeedback(uiMessage("workbench.copied"))
            } catch {
              setFeedback(uiMessage("workbench.copyFailed"))
            }
          }}
        >
          {t("workbench.copy")}
        </Button>
      </div>
      <Input
        aria-label={t("workbench.outputFilter")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {!connected && (
        <p role="status">
          {t("workbench.disconnected")}{" "}
          {onReconnect && (
            <Button size="sm" onClick={onReconnect}>
              {t("workbench.retry")}
            </Button>
          )}
        </p>
      )}
      {terminal ?? (
        <>
          <p className={styles.meta}>{t("workbench.noPty")}</p>
          <pre className={styles.code} tabIndex={0}>
            {shown || t("workbench.emptyOutput")}
          </pre>
        </>
      )}
      {(truncated || bounded.length < safe.length) && (
        <p role="status">{t("workbench.truncated")}</p>
      )}
      <span role="status">{feedback}</span>
    </section>
  )
}
export function PreviewPanel({
  url,
  allowed = false,
  reason,
  children,
}: {
  url?: string
  allowed?: boolean
  reason?: string
  children?: ReactNode
}) {
  const { t } = useI18n()
  const id = useId()
  let safe: string | undefined
  try {
    const parsed = new URL(url ?? "")
    if (
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    )
      safe = parsed.href
  } catch {}
  return (
    <section aria-label={t("workbench.preview")} className={styles.section}>
      {children ??
        (safe && allowed ? (
          <iframe
            title={`${t("workbench.preview")} ${id}`}
            className={styles.preview}
            src={safe}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <p>
            {reason ??
              t(url ? "workbench.previewBlocked" : "workbench.noPreview")}
          </p>
        ))}
    </section>
  )
}

/** Selection only observes a host-owned command. Closing output never stops its process. */
export function ExecutionSessionList({
  commands,
  selectedId,
  onSelect,
  onOpenTool,
  onOpenResource,
  onSource,
  onReconnect,
  terminal,
}: {
  commands: readonly import("../../../lib/workbench-resource-model").CommandRecord[]
  selectedId?: string
  onSelect: (id: string) => void
  onOpenTool?: (id: string) => void
  onOpenResource?: (id: string) => void
  onSource?: (messageId: string) => void
  onReconnect?: (id: string) => void
  terminal?: (commandId: string) => ReactNode
}) {
  const { t } = useI18n()
  const selected =
    commands.find((c) => c.commandId === selectedId) ?? commands[0]
  return (
    <section
      className={styles.commandPanel}
      aria-label={t("resource.commands")}
    >
      <div className={styles.commandList}>
        {commands.map((c) => (
          <Button
            key={c.commandId}
            variant="ghost"
            aria-pressed={c === selected}
            onClick={() => onSelect(c.commandId)}
          >
            {redact(c.command)} · <RuntimeStatusBadge status={c.status} />
            {c.outcome === "unknown" && ` · ${t("workbench.unknown")}`}
          </Button>
        ))}
      </div>
      {!selected && <p>{t("workbench.emptyOutput")}</p>}
      {commands.map((c) => (
        <div
          hidden={c !== selected}
          key={c.commandId}
          data-command-id={c.commandId}
          className={styles.commandOutput}
        >
          <dl className={styles.meta}>
            <dt>{t("resource.cwd")}</dt>
            <dd>{redact(c.cwd)}</dd>
            <dt>Run / Tool</dt>
            <dd>
              {c.runId} / {c.toolCallId ?? "—"}
            </dd>
            <dt>{t("resource.exitCode")}</dt>
            <dd data-command-exit>{c.exitCode ?? "—"}</dd>
            <dt>{t("resource.duration")}</dt>
            <dd>{c.durationMs === undefined ? "—" : `${c.durationMs} ms`}</dd>
            <dt>{t("workbench.source")}</dt>
            <dd>
              {c.startedAt} → {c.endedAt ?? "—"}
            </dd>
          </dl>
          {c.outcome === "unknown" && (
            <p role="status">{t("resource.outcomeUnknown")}</p>
          )}
          {!c.output.text && (
            <p>
              {t(
                ["running", "starting", "queued"].includes(c.status)
                  ? "resource.runningNoOutput"
                  : "resource.endedNoOutput",
              )}
            </p>
          )}
          <div className={styles.row}>
            {c.toolCallId && onOpenTool && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenTool(c.toolCallId!)}
              >
                {t("resource.toolGroup")}
              </Button>
            )}
            {c.messageId && onSource && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSource(c.messageId!)}
              >
                {t("resource.locateSource")}
              </Button>
            )}
            {c.resourceIds?.map(
              (id) =>
                onOpenResource && (
                  <Button
                    key={id}
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenResource(id)}
                  >
                    {t("workbench.files")} · {id}
                  </Button>
                ),
            )}
          </div>
          <ExecutionOutputPanel
            {...c.output}
            connected={c.connection === "connected"}
            onReconnect={
              onReconnect ? () => onReconnect(c.commandId) : undefined
            }
            terminal={terminal?.(c.commandId)}
          />
        </div>
      ))}
    </section>
  )
}
