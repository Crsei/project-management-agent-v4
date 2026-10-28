"use client"
import { useSyncExternalStore, type ReactNode } from "react"
import { Button } from "../../ui/button"
import { DashboardGrid, DashboardWidget } from "./dashboard"
import type { DashboardWidgetDefinition } from "../../../lib/dashboard-model"
import type { DashboardEditSession } from "../../../lib/dashboard-edit-session"
import { useI18n } from "../../../lib/i18n-provider"
export type WidgetTemplate = {
  id: string
  label: string
  create: (id: string) => DashboardWidgetDefinition
}
export function WidgetPicker({
  templates,
  onAdd,
  disabled,
}: {
  templates: readonly WidgetTemplate[]
  onAdd: (template: WidgetTemplate) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  return (
    <fieldset disabled={disabled}>
      <legend>{t("analytics.addWidget")}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {templates.map((template) => (
          <Button
            key={template.id}
            variant="secondary"
            onClick={() => onAdd(template)}
          >
            {template.label}
          </Button>
        ))}
      </div>
    </fieldset>
  )
}
export function DashboardLayoutEditor({
  session,
  templates,
  createWidgetId,
  renderWidget,
}: {
  session: DashboardEditSession
  templates: readonly WidgetTemplate[]
  createWidgetId: () => string
  renderWidget: (widget: DashboardWidgetDefinition) => ReactNode
}) {
  const { t } = useI18n(),
    state = useSyncExternalStore(
      session.subscribe,
      session.getSnapshot,
      session.getSnapshot,
    ),
    locked = state.status === "saving" || state.status === "unknown"
  return (
    <section aria-label={t("analytics.layoutEditor")}>
      <h2>{t("analytics.layoutEditor")}</h2>
      <p>
        {t("analytics.layoutDefinition")} · {t("analytics.revision")}:{" "}
        {state.base.revision}
      </p>
      <p role="status">
        {t(`analytics.save.${state.status}`)}
        {state.message && (
          <span>
            {" "}
            ·{" "}
            {state.message.startsWith("analytics.save")
              ? t(
                  state.message as
                    | "analytics.saveUnknown"
                    | "analytics.saveRejected"
                    | "analytics.saveMismatch",
                )
              : state.message}
          </span>
        )}
      </p>
      <div style={{ display: "flex", gap: 4, margin: "8px 0" }}>
        <Button
          disabled={locked || !state.dirty || !session.capabilities.save}
          onClick={() => void session.save()}
        >
          {t("analytics.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={locked || !state.dirty}
          onClick={() => session.reset()}
        >
          {t("analytics.cancel")}
        </Button>
        {state.status === "unknown" && session.capabilities.reconcile && (
          <Button variant="secondary" onClick={() => void session.reconcile()}>
            {t("analytics.reconcile")}
          </Button>
        )}
      </div>
      <WidgetPicker
        templates={templates}
        disabled={locked || state.draft.widgets.length >= 32}
        onAdd={(template) =>
          session.edit({
            kind: "add",
            widget: template.create(createWidgetId()),
          })
        }
      />
      <DashboardGrid>
        {state.draft.widgets.map((widget, i) => (
          <DashboardWidget
            key={widget.id}
            id={widget.id}
            title={widget.templateId}
            width={widget.width}
          >
            <div
              style={{
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
                marginBottom: 8,
              }}
            >
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || i === 0}
                onClick={() =>
                  session.edit({ kind: "move", id: widget.id, to: i - 1 })
                }
                aria-label={`${t("analytics.moveUp")} ${widget.id}`}
              >
                {t("analytics.moveUp")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || i === state.draft.widgets.length - 1}
                onClick={() =>
                  session.edit({ kind: "move", id: widget.id, to: i + 1 })
                }
                aria-label={`${t("analytics.moveDown")} ${widget.id}`}
              >
                {t("analytics.moveDown")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() =>
                  session.edit({
                    kind: "resize",
                    id: widget.id,
                    width: widget.width === 6 ? 12 : 6,
                    height: widget.height,
                  })
                }
              >
                {t("analytics.width")}: {widget.width}
              </Button>
              <label>
                {t("analytics.height")}{" "}
                <select
                  value={widget.height}
                  disabled={locked}
                  onChange={(e) =>
                    session.edit({
                      kind: "resize",
                      id: widget.id,
                      width: widget.width,
                      height: Number(e.target.value) as 240 | 320 | 400,
                    })
                  }
                >
                  {[240, 320, 400].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => session.edit({ kind: "remove", id: widget.id })}
              >
                {t("analytics.remove")}
              </Button>
            </div>
            {renderWidget(widget)}
          </DashboardWidget>
        ))}
      </DashboardGrid>
    </section>
  )
}
