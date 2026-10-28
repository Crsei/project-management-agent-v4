"use client"
import { memo, useDeferredValue, useMemo, useState } from "react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Field } from "../ui/field"
import { NativeSelect } from "../ui/native-select"
import { Item } from "../ui/item"
import { DataRegion } from "../ui/data-region"
import { useSvgI18n as useI18n } from "../../lib/i18n-svg"
import type { DataState } from "../../lib/runtime-status"
import {
  svgCollections,
  type SvgCollection,
  type SvgIconAsset,
} from "../../lib/svg-workbench-assets"
import { parseSvg } from "../../lib/svg-workbench-parse"
import { SvgArtwork } from "./svg-canvas"
import styles from "./svg-workbench.module.css"

export type SvgIconLibraryProps = {
  assets: SvgIconAsset[]
  collection: SvgCollection
  onCollectionChange: (value: SvgCollection) => void
  state?: DataState
  error?: string
  onRetry?: () => void
  onInsert: (asset: SvgIconAsset) => void
}
const IconPreview = memo(function IconPreview({
  asset,
}: {
  asset: SvgIconAsset
}) {
  const parsed = useMemo(() => parseSvg(asset.svg), [asset.svg])
  return parsed.document ? (
    <SvgArtwork
      document={parsed.document}
      prefix={`asset-${asset.id.replace(/[^\w-]/g, "-")}`}
      className={styles.iconPreview}
    />
  ) : (
    <span aria-hidden="true">?</span>
  )
})
export const SvgIconLibrary = memo(function SvgIconLibrary({
  assets,
  collection,
  onCollectionChange,
  state = "success",
  error,
  onRetry,
  onInsert,
}: SvgIconLibraryProps) {
  const { t } = useI18n(),
    [search, setSearch] = useState(""),
    deferred = useDeferredValue(search),
    [style, setStyle] = useState(""),
    [license, setLicense] = useState(""),
    [page, setPage] = useState(0),
    [selectedId, setSelectedId] = useState<string>()
  const filtered = useMemo(() => {
    const query = deferred.trim().toLowerCase()
    return assets.filter(
      (a) =>
        (!style || a.source.style === style) &&
        (!license || a.source.license === license) &&
        (!query ||
          [a.name, ...a.tags, ...a.categories]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    )
  }, [assets, deferred, style, license])
  const maxPage = Math.max(0, Math.ceil(filtered.length / 12) - 1),
    currentPage = Math.min(page, maxPage),
    current = assets.find((a) => a.id === selectedId)
  return (
    <section className={styles.library} aria-label={t("svg.library")}>
      <div className={styles.filters}>
        <Field label={t("svg.collection")}>
          {(p) => (
            <NativeSelect
              {...p}
              value={collection}
              onChange={(e) => {
                setPage(0)
                setSelectedId(undefined)
                setStyle("")
                setLicense("")
                onCollectionChange(e.target.value as SvgCollection)
              }}
            >
              {svgCollections.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Input
          aria-label={t("svg.search")}
          placeholder={t("svg.search")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
        />
        <div className={styles.twoFields}>
          <Field label={t("svg.style")}>
            {(p) => (
              <NativeSelect
                {...p}
                value={style}
                onChange={(e) => {
                  setStyle(e.target.value)
                  setPage(0)
                }}
              >
                <option value="">{t("svg.all")}</option>
                {[...new Set(assets.map((a) => a.source.style))].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={t("svg.license")}>
            {(p) => (
              <NativeSelect
                {...p}
                value={license}
                onChange={(e) => {
                  setLicense(e.target.value)
                  setPage(0)
                }}
              >
                <option value="">{t("svg.all")}</option>
                {[...new Set(assets.map((a) => a.source.license))].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("svg.refresh")}
          </Button>
        )}
      </div>
      <DataRegion
        state={state === "success" && filtered.length === 0 ? "empty" : state}
        hasContent={assets.length > 0}
        loadingLabel={t("svg.library")}
        emptyTitle={t("svg.noResults")}
        emptyDescription={t("svg.trySearch")}
        partialDescription={t("svg.subset", { count: assets.length })}
        error={{
          category: "request",
          message: t("svg.loadFailed"),
          reason: error ?? t("svg.retry"),
        }}
        onRetry={onRetry}
      >
        <ul className={styles.assetList} aria-label={t("svg.library")}>
          {filtered
            .slice(currentPage * 12, (currentPage + 1) * 12)
            .map((asset) => (
              <li key={asset.id}>
                <Item
                  title={asset.name}
                  description={asset.categories.join(" · ")}
                  leading={<IconPreview asset={asset} />}
                  selected={selectedId === asset.id}
                  ariaLabel={asset.id}
                  onSelect={() => setSelectedId(asset.id)}
                />
              </li>
            ))}
        </ul>
        <div className={styles.pagination}>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("svg.previous")}
          </Button>
          <span>
            {t("svg.page", { page: currentPage + 1, total: maxPage + 1 })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage >= maxPage}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("svg.next")}
          </Button>
        </div>
      </DataRegion>
      {current && (
        <section className={styles.assetDetail} aria-label={t("svg.detail")}>
          <h3>{current.name}</h3>
          <p>
            {current.source.collection} · {current.source.style}
          </p>
          <Button onClick={() => onInsert(current)}>{t("svg.insert")}</Button>
          <dl>
            <dt>{t("svg.license")}</dt>
            <dd>{current.source.license}</dd>
            <dt>{t("svg.commit")}</dt>
            <dd>{current.source.commit}</dd>
            <dt>{t("svg.path")}</dt>
            <dd>{current.source.assetPath}</dd>
          </dl>
          {current.source.notice && <p>{current.source.notice}</p>}
          {current.adaptations.map((a) => (
            <p key={a}>{a}</p>
          ))}
          <details>
            <summary>{t("svg.license")}</summary>
            <pre>{current.licenseText}</pre>
          </details>
        </section>
      )}
    </section>
  )
})
