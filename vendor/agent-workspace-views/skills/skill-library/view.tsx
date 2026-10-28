"use client"

import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  History,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  Sun,
  Upload,
} from "lucide-react"
import { Button } from "@easyuse-ui/ui/components/ui/button"
import { Input } from "@easyuse-ui/ui/components/ui/input"
import { Textarea } from "@easyuse-ui/ui/components/ui/textarea"
import { Label } from "@easyuse-ui/ui/components/ui/label"
import { Item } from "@easyuse-ui/ui/components/ui/item"
import { Skeleton } from "@easyuse-ui/ui/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@easyuse-ui/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@easyuse-ui/ui/components/ui/dropdown-menu"
import { MessageContent } from "@easyuse-ui/ui/components/blocks/message-content"
import { CodePreview } from "@easyuse-ui/ui/components/blocks/code-preview"
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider"
import {
  remainingPageScenarios,
  type RemainingPageProps,
} from "../../showcase/model"
import { useRemainingPageState } from "../../showcase/state"
import {
  cancelSkillEdit,
  createSkillsState,
  draftKey,
  exportSkillFile,
  importSkillFile,
  openSkillDialog,
  parseSkillFile,
  recoverSkills,
  restoreSkillVersion,
  saveSkillEdit,
  selectSkill,
  updateSkillDraft,
  type SkillDialog,
} from "./controller"
import styles from "./view.module.css"

export const pageScenarios = remainingPageScenarios

export function RemainingPageView({
  scenario,
  active,
  host,
  cache,
}: RemainingPageProps) {
  const { locale } = useI18n()
  const label = (zh: string, en: string) => (locale === "en" ? en : zh)
  const [state, setState] = useRemainingPageState(
    `skill-library:${scenario}`,
    () => createSkillsState(scenario),
  )
  const skill = state.skills.find((item) => item.slug === state.selectedSlug)
  const draft = state.drafts[draftKey(state)]
  const reading = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [editor, setEditor] = useState<HTMLTextAreaElement | null>(null)
  const actionButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const prefix = useId()
  const loading = state.dataState === "loading"
  const canEdit = !state.readonly && !loading
  const readingKey = `skill-library:${scenario}:reading:${state.selectedSlug}`
  const dialog = active ? state.dialog : null
  const editDialog =
    dialog === "metadata" || dialog === "instructions" || dialog === "add"
  const parsedUpload = state.upload ? parseSkillFile(state.upload.text) : null

  useLayoutEffect(() => {
    if (!active) return
    if (reading.current)
      reading.current.scrollTop = Number(cache.get(readingKey) ?? 0)
    if (list.current)
      list.current.scrollTop = Number(
        cache.get(`skill-library:${scenario}:list-scroll`) ?? 0,
      )
  }, [active, cache, readingKey, scenario, locale, host.resolvedTheme])

  useLayoutEffect(() => {
    if (!active || dialog !== "instructions" || !editor) return
    const retained = cache.get(
      `skill-library:${scenario}:editor:${state.selectedSlug}`,
    ) as { top: number; start: number; end: number } | undefined
    const element = editor
    const frame = requestAnimationFrame(() => {
      element.focus({ preventScroll: true })
      if (retained) {
        element.setSelectionRange(retained.start, retained.end)
        element.scrollTop = retained.top
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [
    active,
    editor,
    cache,
    dialog,
    scenario,
    state.selectedSlug,
    locale,
    host.resolvedTheme,
  ])

  function open(
    dialog: NonNullable<SkillDialog>,
    uploadTarget: string | null = null,
  ) {
    trigger.current =
      document.activeElement?.getAttribute("role") === "menuitem"
        ? actionButton.current
        : (document.activeElement as HTMLElement)
    setState((previous) =>
      openSkillDialog(previous, dialog, locale, uploadTarget),
    )
  }
  function close() {
    if (dialog === "instructions" && editor) {
      const element = editor
      cache.set(`skill-library:${scenario}:editor:${state.selectedSlug}`, {
        top: element.scrollTop,
        start: element.selectionStart,
        end: element.selectionEnd,
      })
    }
    setState((previous) => ({ ...previous, dialog: null, error: null }))
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    setState((previous) =>
      dialog === "upload" ? importSkillFile(previous) : saveSkillEdit(previous),
    )
  }
  function download() {
    if (!skill) return
    const url = URL.createObjectURL(
      new Blob([exportSkillFile(skill, locale)], {
        type: "text/markdown;charset=utf-8",
      }),
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `${skill.slug}-SKILL.md`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const error = state.error
    ? {
        required: label(
          "请填写名称、描述或指令。",
          "Provide a name, description, or instructions.",
        ),
        slug: label(
          "目录名只能包含小写字母、数字及单个连字符。",
          "Use lowercase letters, numbers, and single hyphens for the slug.",
        ),
        duplicate: label(
          "该目录名已存在。请使用新的目录名，或上传新版本。",
          "This slug already exists. Choose another slug or upload a new version.",
        ),
        frontmatter: label(
          "文件需要 YAML frontmatter 中的 name、description 以及 Markdown 指令。",
          "The file needs name and description in YAML frontmatter, followed by Markdown instructions.",
        ),
        file: label(
          "无法读取此文件，请重新选择 Markdown 文件。",
          "This file could not be read. Choose a Markdown file again.",
        ),
      }[state.error]
    : null

  return (
    <section
      className={styles.page}
      data-skill-library
      data-locale={locale}
      aria-busy={loading || undefined}
    >
      <header className={styles.header}>
        <span>{label("技能", "Skills")}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon"
                variant="ghost"
                aria-label={label("切换主题", "Toggle theme")}
              />
            }
          >
            {host.resolvedTheme === "dark" ? <Moon /> : <Monitor />}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => host.setTheme("light")}>
              <Sun />
              {label("浅色", "Light")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("dark")}>
              <Moon />
              {label("深色", "Dark")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => host.setTheme("system")}>
              <Monitor />
              {label("跟随系统", "System")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {state.readonly && (
        <div className={styles.notice} role="status">
          {label(
            "只读技能库：可阅读、查看版本和导出；不能修改技能。",
            "Read-only library: reading, version history, and export are available; editing is disabled.",
          )}
        </div>
      )}
      {state.dataState === "refresh-error" && (
        <div className={styles.notice} role="alert">
          <span>
            {label(
              "技能库刷新失败，已保留当前技能、版本、草稿与阅读位置。",
              "Library refresh failed. Current skills, versions, drafts, and reading positions are retained.",
            )}
          </span>
          <Button variant="outline" onClick={() => setState(recoverSkills)}>
            {label("重新读取本地示例", "Reload local sample")}
          </Button>
        </div>
      )}
      <div className={styles.columns}>
        <aside
          className={styles.library}
          aria-label={label("技能列表", "Skill list")}
        >
          <div className={styles.listHeader}>
            <h1>{label("全部技能", "All Skills")}</h1>
            <Button
              size="icon-lg"
              variant="ghost"
              aria-label={label("添加技能", "Add skill")}
              disabled={!canEdit}
              onClick={() => open("add")}
            >
              <Plus />
            </Button>
          </div>
          <div className={styles.upload}>
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => open("upload")}
            >
              <Upload />
              {label("上传技能", "Upload skill")}
            </Button>
          </div>
          {loading ? (
            <div className={styles.loading} role="status">
              <span>{label("正在读取技能目录…", "Reading skills…")}</span>
              {[0, 1, 2, 3, 4].map((key) => (
                <Skeleton key={key} className="h-16 w-full" />
              ))}
              <Button variant="outline" onClick={() => setState(recoverSkills)}>
                {label("载入本地示例", "Load local sample")}
              </Button>
            </div>
          ) : (
            <ul
              ref={list}
              className={styles.skillList}
              onScroll={(event) =>
                cache.set(
                  `skill-library:${scenario}:list-scroll`,
                  event.currentTarget.scrollTop,
                )
              }
            >
              {state.skills.map((item) => (
                <li key={item.slug}>
                  <Item
                    className={styles.skillRow}
                    title={item.name}
                    description={item.description[locale]}
                    leading={<FileText aria-hidden="true" />}
                    selected={item.slug === state.selectedSlug}
                    ariaLabel={item.name}
                    onSelect={() =>
                      setState((previous) => selectSkill(previous, item.slug))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {!loading && state.skills.length === 0 && (
            <div className={styles.listEmpty}>
              {label("暂无技能", "No skills yet")}
            </div>
          )}
        </aside>
        <section
          className={styles.detail}
          aria-label={label("技能详情", "Skill details")}
        >
          <div className={styles.detailHeader}>
            {skill && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      ref={actionButton}
                      variant="ghost"
                      className={styles.skillMenu}
                      aria-label={label("技能操作", "Skill actions")}
                    />
                  }
                >
                  {skill.name}
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => open("history")}>
                    <History />
                    {label("版本历史", "Version history")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canEdit}
                    onClick={() => open("upload", skill.slug)}
                  >
                    <Upload />
                    {label("上传新版本", "Upload new version")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={download}>
                    <Download />
                    {label("导出 SKILL.md", "Export SKILL.md")}
                  </DropdownMenuItem>
                  {skill.upstream && (
                    <DropdownMenuItem
                      render={
                        <a
                          href={skill.upstream}
                          target="_blank"
                          rel="noreferrer"
                        />
                      }
                    >
                      <ExternalLink />
                      {label("打开上游源码", "Open upstream source")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={
                      !canEdit || !skill.repository || skill.version === 1
                    }
                    onClick={() =>
                      setState((previous) =>
                        restoreSkillVersion(previous, "repository"),
                      )
                    }
                  >
                    <RotateCcw />
                    {label("恢复仓库版本", "Restore repository version")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div
            ref={reading}
            className={styles.reading}
            data-skill-reading
            onScroll={(event) =>
              cache.set(readingKey, event.currentTarget.scrollTop)
            }
          >
            {skill ? (
              <div className={styles.content}>
                <div className={styles.summary}>
                  <div className={styles.fileIcon}>
                    <FileText aria-hidden="true" />
                  </div>
                  <div>
                    <h2>{skill.name}</h2>
                    <p>{skill.description[locale]}</p>
                  </div>
                </div>
                <section
                  className={styles.metadata}
                  aria-labelledby={`${prefix}-metadata`}
                >
                  <div className={styles.sectionHeading}>
                    <h3 id={`${prefix}-metadata`}>
                      {label("元数据", "Metadata")}
                    </h3>
                    <Button
                      variant="outline"
                      aria-label={label("编辑元数据", "Edit metadata")}
                      disabled={!canEdit}
                      onClick={() => open("metadata")}
                    >
                      {label("编辑", "Edit")}
                    </Button>
                  </div>
                  <dl>
                    <div>
                      <dt>{label("目录名", "Slug")}</dt>
                      <dd>{skill.slug}</dd>
                    </div>
                    <div>
                      <dt>{label("版本", "Version")}</dt>
                      <dd data-skill-version>v{skill.version}</dd>
                    </div>
                    <div>
                      <dt>{label("名称", "Name")}</dt>
                      <dd>{skill.name}</dd>
                    </div>
                    <div>
                      <dt>{label("描述", "Description")}</dt>
                      <dd>{skill.description[locale]}</dd>
                    </div>
                    <div>
                      <dt>{label("来源", "Source")}</dt>
                      <dd>
                        {skill.source === "repository"
                          ? label(
                              "Cloudflare skills · 仓库",
                              "Cloudflare skills · repository",
                            )
                          : skill.source === "upload"
                            ? label("本地上传 · 内存", "Local upload · memory")
                            : label("本地创建 · 内存", "Local skill · memory")}
                      </dd>
                    </div>
                    <div>
                      <dt>{label("位置", "Location")}</dt>
                      <dd>
                        <button
                          type="button"
                          className={styles.fileLink}
                          onClick={() => open("file")}
                        >
                          skills/{skill.slug}/SKILL.md
                        </button>
                      </dd>
                    </div>
                  </dl>
                </section>
                <section
                  className={styles.instructions}
                  aria-labelledby={`${prefix}-instructions`}
                >
                  <div className={styles.sectionHeading}>
                    <h3 id={`${prefix}-instructions`}>
                      {label("指令", "Instructions")}
                    </h3>
                    <div>
                      <Button
                        size="icon-lg"
                        variant="ghost"
                        aria-label={label("展开指令", "Expand instructions")}
                        onClick={() => open("expanded")}
                      >
                        <Maximize2 />
                      </Button>
                      <Button
                        variant="outline"
                        aria-label={label("编辑指令", "Edit instructions")}
                        disabled={!canEdit}
                        onClick={() => open("instructions")}
                      >
                        {label("编辑", "Edit")}
                      </Button>
                    </div>
                  </div>
                  <div
                    className={styles.instructionBody}
                    tabIndex={0}
                    aria-label={label(
                      "技能指令内容",
                      "Skill instruction content",
                    )}
                    onScroll={(event) =>
                      cache.set(
                        `${readingKey}:instructions`,
                        event.currentTarget.scrollTop,
                      )
                    }
                    ref={(element) => {
                      if (element && active)
                        element.scrollTop = Number(
                          cache.get(`${readingKey}:instructions`) ?? 0,
                        )
                    }}
                  >
                    <MessageContent
                      content={skill.instructions}
                      className={styles.markdown}
                    />
                  </div>
                </section>
              </div>
            ) : loading ? (
              <div className={styles.loading}>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <div className={styles.empty}>
                <FileText />
                <h2>
                  {label("创建您的第一个技能", "Create your first skill")}
                </h2>
                <p>
                  {label(
                    "添加名称、描述和 Markdown 指令，或从本地文件导入技能。",
                    "Add a name, description, and Markdown instructions, or import a local skill file.",
                  )}
                </p>
                <Button disabled={!canEdit} onClick={() => open("add")}>
                  <Plus />
                  {label("添加技能", "Add skill")}
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(opened) => {
          if (!opened) close()
        }}
      >
        <DialogContent
          className={
            dialog === "expanded"
              ? styles.expandedDialog
              : dialog === "instructions" || dialog === "file"
                ? styles.wideDialog
                : styles.dialog
          }
          finalFocus={() => trigger.current}
          initialFocus={dialog === "instructions" ? false : undefined}
        >
          <DialogTitle className={styles.dialogTitle}>
            {dialog === "metadata"
              ? label("编辑元数据", "Edit metadata")
              : dialog === "instructions"
                ? label("编辑指令", "Edit instructions")
                : dialog === "add"
                  ? label("添加技能", "Add skill")
                  : dialog === "upload"
                    ? label("上传技能", "Upload skill")
                    : dialog === "history"
                      ? label("版本历史", "Version history")
                      : dialog === "file"
                        ? `skills/${skill?.slug}/SKILL.md`
                        : skill?.name}
          </DialogTitle>
          <DialogDescription className={styles.dialogDescription}>
            {editDialog
              ? label(
                  "修改仅保存在此演示内存中，可导出技能文件。",
                  "Changes are saved in this demo's memory, then export the skill file.",
                )
              : dialog === "upload"
                ? label(
                    "导入 Markdown 到此演示内存中。已有目录将生成新版本。",
                    "Import Markdown into this demo's memory. Existing slugs receive a new version.",
                  )
                : dialog === "history"
                  ? label(
                      `${skill?.slug} · 当前版本 ${skill?.version}。保留最多 20 个历史版本。`,
                      `${skill?.slug} · Current version ${skill?.version}. Up to 20 previous versions are retained.`,
                    )
                  : dialog === "file"
                    ? label(
                        "当前技能的本地文件预览。",
                        "Local file preview of the current skill.",
                      )
                    : label("技能指令", "Skill instructions")}
          </DialogDescription>
          {editDialog && draft && (
            <form className={styles.form} onSubmit={submit}>
              {dialog === "add" && (
                <div className={styles.field}>
                  <Label htmlFor={`${prefix}-slug`}>
                    {label("目录名", "Slug")}
                  </Label>
                  <Input
                    id={`${prefix}-slug`}
                    value={draft.slug}
                    onChange={(event) =>
                      setState((previous) =>
                        updateSkillDraft(previous, {
                          slug: event.target.value,
                        }),
                      )
                    }
                    aria-invalid={
                      state.error === "slug" || state.error === "duplicate"
                    }
                  />
                  <p>
                    {label(
                      "唯一目录名，例如 release-review。",
                      "Unique directory name, such as release-review.",
                    )}
                  </p>
                </div>
              )}
              {dialog !== "instructions" ? (
                <>
                  <div className={styles.field}>
                    <Label htmlFor={`${prefix}-name`}>
                      {label("名称", "Name")}
                    </Label>
                    <Input
                      id={`${prefix}-name`}
                      value={draft.name}
                      onChange={(event) =>
                        setState((previous) =>
                          updateSkillDraft(previous, {
                            name: event.target.value,
                          }),
                        )
                      }
                    />
                  </div>
                  <div className={styles.field}>
                    <Label htmlFor={`${prefix}-description`}>
                      {label("描述", "Description")}
                    </Label>
                    <Textarea
                      id={`${prefix}-description`}
                      value={draft.description}
                      onChange={(event) =>
                        setState((previous) =>
                          updateSkillDraft(previous, {
                            description: event.target.value,
                          }),
                        )
                      }
                    />
                  </div>
                </>
              ) : (
                <div className={styles.field}>
                  <Label htmlFor={`${prefix}-instructions-editor`}>
                    {label("Markdown 指令", "Markdown instructions")}
                  </Label>
                  <Textarea
                    ref={setEditor}
                    id={`${prefix}-instructions-editor`}
                    className={styles.editor}
                    value={draft.instructions}
                    onChange={(event) =>
                      setState((previous) =>
                        updateSkillDraft(previous, {
                          instructions: event.target.value,
                        }),
                      )
                    }
                    onScroll={(event) => {
                      const element = event.currentTarget
                      cache.set(
                        `skill-library:${scenario}:editor:${state.selectedSlug}`,
                        {
                          top: element.scrollTop,
                          start: element.selectionStart,
                          end: element.selectionEnd,
                        },
                      )
                    }}
                    onSelect={(event) => {
                      const element = event.currentTarget
                      cache.set(
                        `skill-library:${scenario}:editor:${state.selectedSlug}`,
                        {
                          top: element.scrollTop,
                          start: element.selectionStart,
                          end: element.selectionEnd,
                        },
                      )
                    }}
                  />
                </div>
              )}
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setState(cancelSkillEdit)}
                >
                  {label("取消", "Cancel")}
                </Button>
                <Button type="submit">
                  {dialog === "add"
                    ? label("创建技能", "Create skill")
                    : label("保存更改", "Save changes")}
                </Button>
              </div>
            </form>
          )}
          {dialog === "upload" && draft && (
            <form className={styles.form} onSubmit={submit}>
              <div className={styles.field}>
                <Label htmlFor={`${prefix}-file`}>
                  {label("Markdown 文件", "Markdown file")}
                </Label>
                <Input
                  id={`${prefix}-file`}
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    try {
                      const text = await file.text()
                      setState((previous) => ({
                        ...previous,
                        upload: { filename: file.name, text },
                        error: parseSkillFile(text) ? null : "frontmatter",
                      }))
                    } catch {
                      setState((previous) => ({
                        ...previous,
                        error: "file",
                        upload: null,
                      }))
                    }
                  }}
                />
                <p>
                  {label(
                    "在 YAML frontmatter 中填写 name 和 description，后附 Markdown 指令。",
                    "Include name and description in YAML frontmatter, followed by Markdown instructions.",
                  )}
                </p>
              </div>
              <div className={styles.field}>
                <Label htmlFor={`${prefix}-upload-slug`}>
                  {label("技能目录名", "Skill slug")}
                </Label>
                <Input
                  id={`${prefix}-upload-slug`}
                  value={draft.slug}
                  onChange={(event) =>
                    setState((previous) =>
                      updateSkillDraft(previous, { slug: event.target.value }),
                    )
                  }
                />
              </div>
              {state.skills.find((item) => item.slug === draft.slug) && (
                <p className={styles.uploadVersion}>
                  {label(
                    `将为 ${draft.slug} 添加 v${(state.skills.find((item) => item.slug === draft.slug)?.version ?? 0) + 1}，当前版本保留在历史中。`,
                    `This adds v${(state.skills.find((item) => item.slug === draft.slug)?.version ?? 0) + 1} to ${draft.slug}. The current version remains in history.`,
                  )}
                </p>
              )}
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setState(cancelSkillEdit)}
                >
                  {label("取消", "Cancel")}
                </Button>
                <Button type="submit" disabled={!parsedUpload}>
                  {label("导入技能", "Import skill")}
                </Button>
              </div>
            </form>
          )}
          {dialog === "expanded" && skill && (
            <div className={styles.expandedBody} tabIndex={0}>
              <MessageContent
                content={skill.instructions}
                className={styles.markdown}
              />
            </div>
          )}
          {dialog === "file" && skill && (
            <div className={styles.filePreview}>
              <CodePreview
                identity={`skill-library:${scenario}:${skill.slug}`}
                revision={String(skill.version)}
                code={exportSkillFile(skill, locale)}
                language="plain"
                ariaLabel={label("技能文件预览", "Skill file preview")}
              />
            </div>
          )}
          {dialog === "history" && skill && (
            <div className={styles.history}>
              <div>
                <strong>
                  v{skill.version} · {label("当前", "Current")}
                </strong>
                <p>{skill.name}</p>
              </div>
              {skill.history.map((version) => (
                <div key={version.version}>
                  <div>
                    <strong>v{version.version}</strong>
                    <p>{version.name}</p>
                    <p>{version.description[locale]}</p>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!canEdit}
                    onClick={() =>
                      setState((previous) =>
                        restoreSkillVersion(previous, version.version),
                      )
                    }
                  >
                    {label("恢复", "Restore")}
                  </Button>
                </div>
              ))}
              {skill.history.length === 0 && (
                <p>
                  {label(
                    "编辑或上传新版本以开始记录历史。",
                    "Edit or upload a new version to start the history.",
                  )}
                </p>
              )}
              <div className={styles.actions}>
                <Button variant="outline" onClick={close}>
                  {label("关闭历史", "Close history")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
