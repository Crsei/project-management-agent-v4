"use client"

import { useState } from "react"
import { Tabs, TabsList, TabsTab } from "../../ui/tabs"
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import { Item } from "../../ui/item"
import { ExecutionSessionList } from "./panels"
import { RuntimeStatusBadge } from "../../ui/runtime-status-badge"
import { useI18n } from "../../../lib/i18n-provider"
import { runtimePanelMessages } from "../../../lib/i18n-runtime-messages"
import type { SessionSnapshot } from "../../../lib/agent-workbench-model"
import type { ComponentProps } from "react"
import styles from "./runtime-panel.module.css"

export function RuntimePanel({
  session,
  ...props
}: ComponentProps<typeof ExecutionSessionList> & { session: SessionSnapshot }) {
  const { locale } = useI18n()
  const [tab, setTab] = useState("output")
  const x = runtimePanelMessages[locale]
  const labels = x.labels
  const failures = props.commands.filter(
    (c) => c.status === "failed" || c.outcome === "unknown",
  )
  return (
    <section
      data-runtime-panel
      className={styles.runtime}
      aria-label={x.records}
    >
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          {Object.entries(labels).map(([id, label]) => (
            <TabsTab key={id} value={id}>
              {label}
              {id === "problems" && failures.length > 0
                ? ` (${failures.length})`
                : ""}
            </TabsTab>
          ))}
        </TabsList>
        {(["output", "logs"] as const).map((id) => (
          <BaseTabs.Panel key={id} value={id} keepMounted>
            <ExecutionSessionList {...props} />
          </BaseTabs.Panel>
        ))}
        <BaseTabs.Panel value="tests" keepMounted>
          <p className={styles.notice}>
            {x.noTests}
          </p>
        </BaseTabs.Panel>
        <BaseTabs.Panel value="problems" keepMounted>
          {failures.length ? (
            failures.map((c) => (
              <Item
                key={c.commandId}
                title={c.command}
                description={
                  <>
                    <RuntimeStatusBadge status={c.status} /> · {c.commandId} ·{" "}
                    {c.outcome === "unknown"
                      ? x.unknown
                      : x.failure}
                  </>
                }
                onSelect={() => {
                  props.onSelect(c.commandId)
                  setTab("output")
                }}
              />
            ))
          ) : (
            <p className={styles.notice}>
              {x.noProblems}
            </p>
          )}
        </BaseTabs.Panel>
        <BaseTabs.Panel value="events" keepMounted>
          {session.tools.map((tool) => (
            <Item
              key={tool.id}
              title={tool.name}
              description={
                <>
                  <RuntimeStatusBadge status={tool.status} /> · {tool.id}
                </>
              }
              onSelect={
                props.onOpenTool ? () => props.onOpenTool?.(tool.id) : undefined
              }
            />
          ))}
        </BaseTabs.Panel>
        <BaseTabs.Panel value="metrics" keepMounted>
          <p className={styles.notice}>
            {x.noMetrics}
          </p>
        </BaseTabs.Panel>
        <BaseTabs.Panel value="terminal" keepMounted>
          <p className={styles.notice}>
            {x.noTerminal}
          </p>
        </BaseTabs.Panel>
      </Tabs>
    </section>
  )
}
