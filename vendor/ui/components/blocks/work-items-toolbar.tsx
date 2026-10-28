"use client"
import type { ReactNode } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Checkbox } from "../ui/checkbox"
import { Segmented, SegmentedItem } from "../ui/segmented"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../ui/popover"
import { FilterToolbar } from "./filter-toolbar"
import { WorkItemAssigneePicker } from "./work-item-properties"
import type {
  WorkItemCatalog,
  WorkItemProperty,
  WorkItemsViewState,
} from "../../lib/work-items-model"
import { useI18n } from "../../lib/i18n-provider"
import styles from "./work-items.module.css"
export type WorkItemsToolbarProps = {
  view: WorkItemsViewState
  onViewChange: (view: WorkItemsViewState) => void
  catalog: WorkItemCatalog
  enhancements?: {
    swimlanes?: boolean
    subItems?: boolean
    offscreen?: boolean
  }
  extensions?: ReactNode
}
export function WorkItemsDisplayOptions({
  view,
  onViewChange,
  enhancements,
}: Pick<WorkItemsToolbarProps, "view" | "onViewChange" | "enhancements">) {
  const { t } = useI18n()
  const properties: WorkItemProperty[] = [
    "state",
    "priority",
    "assignees",
    "labels",
    "startDate",
    "dueDate",
    "counts",
  ]
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" />}>
        {t("workItems.display")}
      </PopoverTrigger>
      <PopoverContent>
        <div className={styles.display}>
          <label>
            {t("workItems.groupBy")}
            <select
              disabled={
                view.layout === "timeline" || view.layout === "calendar"
              }
              aria-label={t("workItems.groupBy")}
              value={view.groupBy}
              onChange={(e) =>
                onViewChange({
                  ...view,
                  groupBy: e.target.value as WorkItemsViewState["groupBy"],
                  subGroupBy:
                    e.target.value === view.subGroupBy
                      ? "none"
                      : view.subGroupBy,
                })
              }
            >
              <option value="state">{t("workItems.state")}</option>
              <option value="priority">{t("workItems.priority")}</option>
            </select>
          </label>
          {enhancements && (
            <>
              {enhancements.swimlanes && (
                <>
                  <label>
                    {t("workItems.swimlanes")}
                    <select
                      aria-label={t("workItems.swimlanes")}
                      value={view.subGroupBy ?? "none"}
                      onChange={(e) =>
                        onViewChange({
                          ...view,
                          subGroupBy: e.target
                            .value as WorkItemsViewState["subGroupBy"],
                        })
                      }
                    >
                      <option value="none">{t("workItems.noSwimlanes")}</option>
                      <option value="state" disabled={view.groupBy === "state"}>
                        {t("workItems.state")}
                      </option>
                      <option
                        value="priority"
                        disabled={view.groupBy === "priority"}
                      >
                        {t("workItems.priority")}
                      </option>
                    </select>
                  </label>
                  <p className="text-xs">{t("workItems.swimlaneLayoutHint")}</p>
                </>
              )}
              {enhancements.subItems && (
                <label>
                  <Checkbox
                    checked={view.showSubItems ?? false}
                    onCheckedChange={(showSubItems) =>
                      onViewChange({ ...view, showSubItems })
                    }
                  />
                  {t("workItems.showSubItems")}
                </label>
              )}
              {enhancements.offscreen && (
                <label>
                  <Checkbox
                    checked={view.deferOffscreen ?? false}
                    onCheckedChange={(deferOffscreen) =>
                      onViewChange({ ...view, deferOffscreen })
                    }
                  />
                  {t("workItems.deferOffscreen")}
                </label>
              )}
            </>
          )}
          <label>
            {t("workItems.sort")}
            <select
              aria-label={t("workItems.sort")}
              value={view.sort}
              onChange={(e) =>
                onViewChange({
                  ...view,
                  sort: e.target.value as WorkItemsViewState["sort"],
                  sortDirection: "asc",
                })
              }
            >
              {["manual", "title", "dueDate", "priority"].map((value) => (
                <option key={value} value={value}>
                  {t(`workItems.${value}` as "workItems.sort")}
                </option>
              ))}
            </select>
          </label>
          {view.sort !== "manual" && (
            <p className="text-xs text-muted-foreground">
              {t("workItems.autoSortHint")}
            </p>
          )}
          <label>
            <Checkbox
              checked={view.showEmptyGroups}
              onCheckedChange={(showEmptyGroups) =>
                onViewChange({ ...view, showEmptyGroups })
              }
            />
            {t("workItems.showEmptyGroups")}
          </label>
          {properties.map((property) => (
            <label key={property}>
              <Checkbox
                checked={view.visibleProperties.includes(property)}
                onCheckedChange={(checked) =>
                  onViewChange({
                    ...view,
                    visibleProperties: checked
                      ? [...view.visibleProperties, property]
                      : view.visibleProperties.filter(
                          (key) => key !== property,
                        ),
                  })
                }
              />
              {t(`workItems.${property}` as "workItems.sort")}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function WorkItemsToolbar({
  view,
  onViewChange,
  catalog,
  enhancements,
  extensions,
}: WorkItemsToolbarProps) {
  const { t } = useI18n()
  const options = {
    state: catalog.states,
    priority: catalog.priorities,
    assignees: catalog.assignees,
    labels: catalog.labels,
  }
  const filters = (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" />}>
        {t("commonComponents.filters")}
      </PopoverTrigger>
      <PopoverContent>
        <div className={styles.display}>
          <p className="text-xs">{t("workItems.filterHint")}</p>
          {(Object.keys(options) as (keyof typeof options)[]).map((field) => (
            <div key={field}>
              <span>{t(`workItems.${field}` as "workItems.sort")}</span>
              <WorkItemAssigneePicker
                label={t(`workItems.${field}` as "workItems.sort")}
                value={view.filters[field]}
                options={options[field]}
                onChange={(value) =>
                  onViewChange({
                    ...view,
                    filters: { ...view.filters, [field]: value },
                  })
                }
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
  return (
    <div>
      <FilterToolbar
        className={styles.toolbar}
        label={t("workItems.toolbar")}
        search={
          <>
            <Segmented
              className="max-w-full flex-wrap"
              value={view.layout}
              aria-label={t("workItems.layout")}
              onValueChange={(layout) =>
                onViewChange({
                  ...view,
                  layout: layout as WorkItemsViewState["layout"],
                })
              }
            >
              {(
                ["list", "board", "table", "timeline", "calendar"] as const
              ).map((layout) => (
                <SegmentedItem
                  key={layout}
                  value={layout}
                  className="shrink-0 whitespace-nowrap"
                >
                  {t(`workItems.${layout}`)}
                </SegmentedItem>
              ))}
            </Segmented>
            <Input
              className="w-44"
              value={view.query}
              aria-label={t("workItems.search")}
              placeholder={t("workItems.search")}
              onChange={(e) => onViewChange({ ...view, query: e.target.value })}
            />
          </>
        }
        filters={filters}
        actions={
          <>
            <WorkItemsDisplayOptions
              view={view}
              onViewChange={onViewChange}
              enhancements={enhancements}
            />
            {extensions}
          </>
        }
      />
      <div className={styles.chips}>
        {(Object.keys(options) as (keyof typeof options)[]).flatMap((field) =>
          view.filters[field].map((id) => (
            <Button
              key={`${field}:${id}`}
              variant="secondary"
              size="sm"
              aria-label={t("workItems.removeFilter", {
                name:
                  options[field].find((option) => option.id === id)?.label ??
                  id,
              })}
              onClick={() =>
                onViewChange({
                  ...view,
                  filters: {
                    ...view.filters,
                    [field]: view.filters[field].filter(
                      (value) => value !== id,
                    ),
                  },
                })
              }
            >
              {options[field].find((option) => option.id === id)?.label ?? id} ×
            </Button>
          )),
        )}
        {(view.query ||
          Object.values(view.filters).some((values) => values.length)) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onViewChange({
                ...view,
                query: "",
                filters: { state: [], priority: [], assignees: [], labels: [] },
              })
            }
          >
            {t("workItems.clearFilters")}
          </Button>
        )}
      </div>
    </div>
  )
}
