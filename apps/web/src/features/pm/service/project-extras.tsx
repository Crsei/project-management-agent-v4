import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Command, Entity } from "@contracts"
import type { ProjectCover, ProjectExtrasProject, ProjectScopeItem } from "../../../../../../packages/domain/src/project-extras"
import { isProjectCoverMediaType, isProjectCoverRaster } from "../../../../../../packages/domain/src/project-extras"
import { Button } from "@/components/ui/button"
import { pmKeys } from "./pm-data"
import { usePmEntities, usePmEntity, usePmService, useProjectExtras } from "./pm-service"
import { Choice, CommandNotice, Field, Form, allowed, string, useAction, useDraftState, useText } from "./pm-ui"

export type ProjectExtrasEditorProps = { project: Entity }
export type ProjectCoverImages = {
  urls: Record<string, string>
  errors: { projectId: string; message: string }[]
  loading: boolean
  refetch: () => Promise<unknown>
}
type CoverImageSnapshot = { images: { projectId: string; blob: Blob }[]; errors: { projectId: string; message: string }[] }

/** URLs exist only for freshly authorized, signature-checked content; identity changes hide them synchronously. */
export function useProjectCoverImages(projects: readonly ProjectExtrasProject[]): ProjectCoverImages {
  const { client, actor, actorEpoch, workspace } = usePmService()
  const covers = projects.filter(row => row.cover?.data.artifactVersionId && isProjectCoverMediaType(row.cover.data.mediaType))
    .map(row => ({ projectId: row.projectId, versionId: row.cover!.data.artifactVersionId!, mediaType: row.cover!.data.mediaType! }))
  const signature = JSON.stringify(covers)
  const query = useQuery<CoverImageSnapshot>({
    queryKey: [...pmKeys.workspace(window.location.origin, actor?.id ?? "anonymous", workspace?.id ?? "none"), "project-cover-images", actorEpoch, workspace?.version ?? 0, signature],
    enabled: !!actor && !!workspace && covers.length > 0,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      if (!workspace || !actor) throw new Error("An authenticated workspace is required.")
      const results = await Promise.all(covers.map(async cover => {
        try {
          const result = await client.downloadArtifactVersion(workspace.id, cover.versionId, { signal })
          signal.throwIfAborted()
          if (!isProjectCoverMediaType(cover.mediaType) || !isProjectCoverRaster(result.bytes, cover.mediaType)) throw new Error("Cover content is not the registered safe raster image.")
          return { projectId: cover.projectId, blob: new Blob([Uint8Array.from(result.bytes)], { type: cover.mediaType }) }
        } catch (error) {
          signal.throwIfAborted()
          return { projectId: cover.projectId, message: error instanceof Error ? error.message : String(error) }
        }
      }))
      return { images: results.filter((result): result is { projectId: string; blob: Blob } => "blob" in result), errors: results.filter((result): result is { projectId: string; message: string } => "message" in result) }
    },
  })
  const [display, setDisplay] = useState<{ snapshot: CoverImageSnapshot; urls: Record<string, string> } | null>(null)
  useEffect(() => {
    if (!query.data) return
    const urls = Object.fromEntries(query.data.images.map(image => [image.projectId, URL.createObjectURL(image.blob)]))
    setDisplay({ snapshot: query.data, urls })
    return () => { for (const url of Object.values(urls)) URL.revokeObjectURL(url) }
  }, [query.data])
  return {
    urls: actor && workspace && covers.length > 0 && !query.error && display && display.snapshot === query.data ? display.urls : {},
    errors: query.data?.errors ?? (query.error ? [{ projectId: "", message: query.error.message }] : []),
    loading: covers.length > 0 && query.isPending,
    refetch: query.refetch,
  }
}

export function ProjectCoverImage({ projectId, cover, alt = "", className }: { projectId: string; cover?: ProjectCover | null; alt?: string; className?: string }) {
  const t = useText()
  const query = useProjectExtras()
  const selected = cover === undefined ? query.data?.projects.find(row => row.projectId === projectId)?.cover ?? null : cover
  const images = useProjectCoverImages([{ projectId, cover: selected, favorite: null, scope: null }])
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!selected?.data.artifactVersionId) return query.error ? <p role="alert" className="text-xs">{query.error.message}</p> : null
  const url = images.urls[projectId]
  const failed = !!url && failedUrl === url
  return <div className={className}>{url && !failed ? <img src={url} alt={alt} className="h-full w-full object-cover" onError={() => setFailedUrl(url)} /> : <div className="space-y-1"><p role={images.errors.length || failed ? "alert" : "status"} className="text-xs">{images.errors[0]?.message ?? (failed ? t("封面图片解码失败，已保存的关联未改变。", "Cover image could not be decoded; the stored association is unchanged.") : t("加载封面…", "Loading cover…"))}</p>{(images.errors.length > 0 || failed) && <Button size="sm" variant="ghost" onClick={() => { void images.refetch() }}>{t("重试封面", "Retry cover")}</Button>}</div>}</div>
}

export function ProjectFavoriteButton({ project }: ProjectExtrasEditorProps) {
  const { workspace } = usePmService()
  const query = useProjectExtras()
  const action = useAction()
  const t = useText()
  const current = query.data?.projects.find(row => row.projectId === project.id)
  return <div className="space-y-1"><Button variant="outline" size="sm" aria-pressed={current?.favorite?.data.favorite ?? false} disabled={!current || !!query.error || !allowed(workspace, "domain.read", project.id) || action.locked} onClick={() => { void action.run(async () => {
    if (!current) return
    await action.execute({ commandId: crypto.randomUUID(), commandType: "SetProjectFavorite", targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: project.version, ...(current.favorite ? { [current.favorite.id]: current.favorite.version } : {}) }, payload: { favorite: !current.favorite?.data.favorite } })
    await query.refetch()
  }) }}>{current?.favorite?.data.favorite ? t("取消收藏", "Unfavorite") : t("收藏项目", "Favorite project")}</Button>{query.error && <p role="alert" className="text-xs">{query.error.message}</p>}{action.localError && <p role="alert" className="text-xs">{action.localError}</p>}<CommandNotice /></div>
}

export function ProjectCoverEditor({ project }: ProjectExtrasEditorProps) {
  const query = useProjectExtras()
  const t = useText()
  const current = query.data?.projects.find(row => row.projectId === project.id)
  if (!current) return <p role={query.error ? "alert" : "status"} className="text-sm">{query.error?.message ?? (query.isPending ? t("加载项目封面…", "Loading project cover…") : t("项目不可访问。", "Project unavailable."))}</p>
  return <CoverEditorForm project={project} current={current} />
}

function CoverEditorForm({ project, current }: ProjectExtrasEditorProps & { current: ProjectExtrasProject }) {
  const query = useProjectExtras()
  const projectQuery = usePmEntity(project.id)
  const latestProject = projectQuery.data ?? project
  const versions = usePmEntities("artifact_version", project.id, "all")
  const { workspace } = usePmService()
  const action = useAction()
  const t = useText()
  const [base, setBase] = useDraftState(`project-cover:${project.id}`, "base", { projectVersion: latestProject.version, cover: current.cover })
  const [versionId, setVersionId] = useDraftState(`project-cover:${project.id}`, "version", current.cover?.data.artifactVersionId ?? "")
  const changed = base.projectVersion !== latestProject.version || base.cover?.version !== current.cover?.version
  const canEdit = allowed(workspace, "planning.edit", project.id) && !latestProject.data.archivedAt && latestProject.data.archived !== true && ["planning", "active"].includes(string(latestProject.data.status))
  const eligible = versions.data?.filter(version => version.projectId === project.id && isProjectCoverMediaType(version.data.mediaType)) ?? []
  const missingDraft = versionId !== "" && !eligible.some(version => version.id === versionId)
  return <section className="min-w-0 space-y-3 text-sm" aria-label={t("项目封面", "Project cover")}>
    <ProjectCoverImage projectId={project.id} cover={current.cover} className="max-h-60 overflow-hidden rounded-md" />
    {!current.cover?.data.artifactVersionId && <p className="text-muted-foreground">{t("未设置封面，仅使用默认装饰。", "No cover set; only default decoration is used.")}</p>}
    <p className="text-xs text-muted-foreground">{t("选择本项目已上传并登记的 PNG / JPEG / GIF / WebP 不可变版本。先在附件区上传；不接受外链或 SVG。", "Select an immutable PNG / JPEG / GIF / WebP version already uploaded and registered in this project. Upload through Files first; external URLs and SVG are not accepted.")}</p>
    {versions.error && <div role="alert"><p>{versions.error.message}</p><Button variant="outline" onClick={() => { void versions.refetch() }}>{t("重试读取图片", "Retry images")}</Button></div>}
    {!canEdit && <p>{t("只读：需要项目编辑权限且项目可写。", "Read only: requires project editing permission and a writable project.")}</p>}
    <Form disabled={!canEdit || action.locked || changed || !!query.error || !!projectQuery.error} onSubmit={async () => {
      if (versionId && (versions.isPending || versions.error || missingDraft)) throw new Error(t("请选择当前可用的已登记图片版本，或移除封面。", "Select an available registered image version, or remove the cover."))
      const command: Command = { commandId: crypto.randomUUID(), commandType: "SetProjectCover", targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: base.projectVersion, ...(base.cover ? { [base.cover.id]: base.cover.version } : {}) }, payload: { artifactVersionId: versionId || null } }
      await action.execute(command)
      const refreshed = await query.refetch()
      const next = refreshed.data?.projects.find(row => row.projectId === project.id)
      if (next) setBase({ projectVersion: latestProject.version, cover: next.cover })
    }}>
      <Choice label={t("封面图片（不可变版本）", "Cover image (immutable version)")} value={versionId} onChange={setVersionId} options={[{ value: "", label: t("移除封面 / 默认装饰", "Remove cover / default decoration") }, ...(missingDraft ? [{ value: versionId, label: `${t("草稿版本不可用", "Draft version unavailable")}: ${versionId}` }] : []), ...eligible.map(version => ({ value: version.id, label: `${string(version.data.fileName) || version.id} · ${version.id}` }))]} />
    </Form>
    {(changed || query.error || projectQuery.error) && <p role="status">{t("版本变化或读取失败，选择草稿仍保留。刷新并采用当前版本后重试；不会自动覆盖。", "Version changed or read failed; selection draft retained. Refresh and adopt the current version before retrying; no automatic overwrite.")}</p>}
    <Button variant="ghost" disabled={action.locked} onClick={() => { void action.run(async () => {
      const [refreshed, refreshedProject] = await Promise.all([query.refetch(), projectQuery.refetch()])
      const next = refreshed.data?.projects.find(row => row.projectId === project.id)
      if (!refreshed.error && !refreshedProject.error && next && refreshedProject.data) setBase({ projectVersion: refreshedProject.data.version, cover: next.cover })
    }) }}>{t("刷新并采用当前版本（保留草稿）", "Refresh and adopt current version (keep draft)")}</Button>
    <CommandNotice />
  </section>
}

export function ProjectScopeEditor({ project }: ProjectExtrasEditorProps) {
  const query = useProjectExtras()
  const t = useText()
  const current = query.data?.projects.find(row => row.projectId === project.id)
  if (!current) return <p role={query.error ? "alert" : "status"} className="text-sm">{query.error?.message ?? (query.isPending ? t("加载范围清单…", "Loading scope checklist…") : t("项目不可访问。", "Project unavailable."))}</p>
  return <ScopeEditorForm project={project} current={current} />
}

function ScopeEditorForm({ project, current }: ProjectExtrasEditorProps & { current: ProjectExtrasProject }) {
  const query = useProjectExtras()
  const projectQuery = usePmEntity(project.id)
  const latestProject = projectQuery.data ?? project
  const { workspace } = usePmService()
  const action = useAction()
  const t = useText()
  const [base, setBase] = useDraftState(`project-scope:${project.id}`, "base", { projectVersion: latestProject.version, scope: current.scope })
  const [items, setItems] = useDraftState<ProjectScopeItem[]>(`project-scope:${project.id}`, "items", () => structuredClone(current.scope?.data.items ?? []))
  const changed = base.projectVersion !== latestProject.version || base.scope?.version !== current.scope?.version
  const canEdit = allowed(workspace, "planning.edit", project.id) && !latestProject.data.archivedAt && latestProject.data.archived !== true && ["planning", "active"].includes(string(latestProject.data.status))
  return <section className="min-w-0 space-y-3 text-sm" aria-label={t("项目范围清单", "Project scope checklist")}>
    <p className="text-xs text-muted-foreground">{t("独立协作注释，不替代 Markdown 正文或验收标准。勾选不会完成项目。", "Independent collaboration notes, not Markdown scope or acceptance criteria. Checking an item does not complete the project.")}</p>
    <p>{current.scope?.data.items.filter(item => item.completed).length ?? 0} / {current.scope?.data.items.length ?? 0} {t("已保存条目完成", "saved items checked")}</p>
    {!canEdit && <p>{t("当前项目只读。", "This project is read only.")}</p>}
    <Form disabled={!canEdit || action.locked || changed || !!query.error || !!projectQuery.error} onSubmit={async () => {
      const command: Command = { commandId: crypto.randomUUID(), commandType: "SetProjectScope", targetId: project.id, projectId: project.id, expectedVersions: { [project.id]: base.projectVersion, ...(base.scope ? { [base.scope.id]: base.scope.version } : {}) }, payload: { items } }
      await action.execute(command)
      const refreshed = await query.refetch()
      const next = refreshed.data?.projects.find(row => row.projectId === project.id)
      if (next) setBase({ projectVersion: latestProject.version, scope: next.scope })
    }}>
      {items.length === 0 && <p className="text-muted-foreground">{t("范围清单为空。", "Scope checklist is empty.")}</p>}
      {items.map(item => <div key={item.id} className="space-y-2 rounded-md border p-2"><label className="flex items-center gap-2"><input type="checkbox" checked={item.completed} onChange={event => setItems(rows => rows.map(row => row.id === item.id ? { ...row, completed: event.target.checked } : row))} /><span>{t("已完成该注释项", "Annotation item checked")}</span></label><Field label={t("范围条目", "Scope item")} value={item.text} onChange={text => setItems(rows => rows.map(row => row.id === item.id ? { ...row, text } : row))} multiline required /><Button type="button" size="sm" variant="ghost" onClick={() => setItems(rows => rows.filter(row => row.id !== item.id))}>{t("删除条目", "Delete item")}</Button></div>)}
      <Button type="button" variant="outline" disabled={items.length >= 200} onClick={() => setItems(rows => [...rows, { id: crypto.randomUUID(), text: "", completed: false }])}>{t("添加范围条目", "Add scope item")}</Button>
    </Form>
    {(changed || query.error || projectQuery.error) && <p role="status">{t("版本变化或读取失败，全部条目草稿仍保留。不会自动合并或重试。", "Version changed or read failed; all item drafts retained. No automatic merge or retry.")}</p>}
    <Button variant="ghost" disabled={action.locked} onClick={() => { void action.run(async () => {
      const [refreshed, refreshedProject] = await Promise.all([query.refetch(), projectQuery.refetch()])
      const next = refreshed.data?.projects.find(row => row.projectId === project.id)
      if (!refreshed.error && !refreshedProject.error && next && refreshedProject.data) setBase({ projectVersion: refreshedProject.data.version, scope: next.scope })
    }) }}>{t("刷新并采用当前版本（保留草稿）", "Refresh and adopt current version (keep draft)")}</Button>
    <CommandNotice />
  </section>
}
