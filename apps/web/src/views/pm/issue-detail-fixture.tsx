import { useLayoutEffect, useRef, useState } from "react"

import { MessageContent } from "@/components/blocks/message-content"
import { useI18n } from "@/lib/i18n-provider"
import { IssueDetailView } from "./issue-detail"
import { useIssueDomain } from "./use-issue-domain"
import { usePmControlsReady, usePmDomainState, usePmNavigation } from "./domain-session"
import { usePmScenarioState } from "./shared"
import { createProjectList1Fixtures } from "./project-list-1-fixtures"
import { issueRecord, patchIssueDomain } from "./issue-domain"
import { createIssueListUi, issueCapabilities, issueToday, scenarioWritable, issueCommentState, submitIssueComment, type IssueCommentStore, type IssueOutcome } from "./issues-controller"
import { IssueActivityList, IssueCreateDialog, IssueAttachments, IssueChildCreate, IssueCommentsSection, IssueDescriptionField, IssueEditControls, IssueFacts, IssueIdentityNotice, IssueMutationStatus, IssueOutcomeSelect, IssuePropertiesPane, IssueSubissueList, IssueSubtasksSection, IssueTitleField, useIssueEntityEditor, type IssueActivityEntry } from "./issues-views"
import { fixtureCatalogProjection, fixtureIssueProjection, useFixtureReadState } from "./fixture-projections"
import type { IssueDetailViewProps } from "./controlled-contracts"
import type { PmPageProps } from "./model"
import d1 from "./issue-detail-1.module.css"
import d2 from "./issue-detail-2.module.css"

/** Fixture-only controller and local region adapters; both layouts share one View. */
export function FixtureIssueDetail({ scenario, variant }: PmPageProps & { variant: IssueDetailViewProps["variant"] }) {
  const { locale } = useI18n()
  const en = locale === "en"
  const interactive = usePmControlsReady()
  const { entityId, navigate, back } = usePmNavigation()
  const [domain, setDomain] = useIssueDomain(scenario)
  const [projects] = usePmDomainState("projects", () => createProjectList1Fixtures(scenario))
  const [comments, setComments] = usePmDomainState<IssueCommentStore>("issue-comments", () => ({}))
  const slug = variant === "detail1" ? "issue-detail-1" : "issue-detail-2"
  const [outcome, setOutcome] = usePmScenarioState<IssueOutcome>(`${slug}:outcome`, () => "confirmed")
  const [activityFilter, setActivityFilter] = usePmScenarioState<"all" | "comment" | "update">(`${slug}-activity-filter`, () => "all")
  const [readingPositions, setReadingPositions] = usePmScenarioState<Record<string, number>>(`${slug}:reading-positions`, () => ({}))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [create, setCreate] = usePmScenarioState(`${slug}:create`, createIssueListUi)
  const all = domain.items.map((item) => issueRecord(item, locale))
  const found = !!entityId && all.some((item) => item.id === entityId)
  const item = (entityId ? all.find((entry) => entry.id === entityId) : all[0]) ?? null
  const data = useFixtureReadState(scenario, slug)
  const detailData = entityId && !found && data.state === "success" ? { ...data, state: "empty" as const, emptyDescription: en ? `No issue matches ${entityId} in this scene.` : `当前场景没有与 ${entityId} 匹配的问题。` } : data
  const writable = scenarioWritable(scenario)
  const editor = useIssueEntityEditor({ item, domain, setDomain, outcome, writable })
  const editRef = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(editor.editing)
  useLayoutEffect(() => { if (wasEditing.current && !editor.editing) editRef.current?.focus(); wasEditing.current = editor.editing }, [editor.editing])
  const catalog = fixtureCatalogProjection(domain.items, projects, locale)
  const modelItem = item ? fixtureIssueProjection(item, locale) : null
  const project = item ? projects.find((entry) => entry.id === item.projectId) : undefined
  const children = item ? all.filter((entry) => entry.parentId === item.id && entry.projectId === item.projectId && entry.id !== item.id) : []
  const activities: IssueActivityEntry[] = item ? [...(comments[item.id]?.entries ?? []).map((entry) => ({ id: entry.id, kind: "comment" as const, actor: entry.author, text: entry.text, at: entry.at })), ...domain.activity.filter((entry) => entry.itemId === item.id).map((entry) => ({ id: entry.id, kind: "update" as const, actor: en ? "Local system" : "本地系统", text: entry.description[locale], at: entry.at }))] : []
  const capabilities = { ...issueCapabilities(writable, en ? "Read-only or loading scene." : "只读或加载中的场景。"), canEditRelation: () => false, comment: writable, attach: false, createChild: writable }
  const styles = variant === "detail1" ? d1 : d2
  const facts = item ? [{ label: en ? "Project" : "项目", value: project?.title[locale] ?? item.projectId }, { label: en ? "Module" : "模块", value: item.moduleId }, { label: en ? "Cycle" : "周期", value: item.cycleId }, { label: en ? "Estimate" : "估点", value: item.estimate === null ? "—" : `${item.estimate}h` }, { label: en ? "Time zone" : "时区", value: item.timeZone }, { label: en ? "Revision" : "修订", value: String(item.revision) }] : []
  const author = en ? "Local user" : "本地用户"
  const properties = item ? <IssuePropertiesPane item={item} catalog={catalog} visibleProperties={["state", "priority", "assignees", "labels", "startDate", "dueDate", "counts"]} editing={editor.editing} draft={editor.draft} onPatch={editor.patch} mutation={editor.mutation} capabilities={capabilities} facts={<IssueFacts rows={facts} />} /> : undefined
  return <IssueDetailView variant={variant} interactive={interactive} pageId={`pm-${slug}`} readingPosition={item ? readingPositions[item.id] ?? 0 : 0} onReadingPositionChange={(top) => { if (item) setReadingPositions((previous) => ({ ...previous, [item.id]: top })) }} readModel={{ item: scenario === "loading" ? null : modelItem, catalog, children: children.map((child) => fixtureIssueProjection(child, locale)), activity: activities.map((entry) => ({ ...entry, description: entry.text })), attachments: item?.attachments.map((entry) => ({ id: entry.id, name: entry.name, description: entry.status === "error" ? en ? "Fixture preview unavailable" : "fixture 预览不可用" : null, sizeLabel: null })) ?? [], data: detailData, mutation: editor.mutation, today: issueToday }} interaction={{ editing: editor.editing, draft: editor.draft && modelItem ? { ...editor.draft, projectId: modelItem.projectId, moduleIds: modelItem.moduleIds, cycleId: modelItem.cycleId, estimatePointId: modelItem.estimatePointId, parentId: modelItem.parentId ?? null } : null, commentDraft: item ? issueCommentState(comments, item.id).draft.text : "", activityFilter }} capabilities={capabilities} actions={{ back: () => back(variant === "detail1" ? "issue-list-1" : "issue-list-2"), edit: editor.open, setDraft: (draft) => editor.patch({ title: draft.title, description: draft.description, stateId: draft.stateId, priorityId: draft.priorityId, assigneeIds: [...draft.assigneeIds], labelIds: [...draft.labelIds], startDate: draft.startDate, dueDate: draft.dueDate }), save: editor.apply, cancel: editor.cancel, patch: (record, change) => { if (!writable) return; const { projectId: _project, parentId: _parent, moduleIds: _modules, cycleId: _cycle, estimatePointId: _estimate, ...fields } = change; setDomain((previous) => patchIssueDomain(previous, record.id, fields, outcome, record.revision)) }, open: (record) => navigate(slug, record.id), openProject: (projectId) => navigate("project-detail-1", projectId), createChild: (record) => setCreate((previous) => ({ ...previous, createOpen: true, createDraft: { ...previous.createDraft, parentId: record.id, projectId: record.projectId } })), setCommentDraft: (value) => { if (!item) return; setComments((previous) => { const current = issueCommentState(previous, item.id); return { ...previous, [item.id]: { ...current, draft: { ...current.draft, text: value } } } }) }, comment: () => { if (item && writable) setComments((previous) => submitIssueComment(previous, item.id, author).store) }, setActivityFilter, attach: () => { throw new Error("Fixture attachments are read-only") }, openAttachment: setPreviewId, reconcile: () => editor.reconcile("confirmed") }} feedback={<>{<IssueIdentityNotice entityId={entityId} resolved={item} found={found} />}{previewId && <p role="status">{item?.attachments.find((entry) => entry.id === previewId)?.name}</p>}</>} headerActions={<><IssueOutcomeSelect value={outcome} onChange={setOutcome} disabled={!item || !writable || editor.locked} label={en ? "Simulated submit result" : "模拟提交结果"} compact /><IssueEditControls editing={editor.editing} dirty={editor.dirty} disabled={!item || !writable || editor.locked} onEdit={editor.open} onApply={editor.apply} onCancel={editor.cancel} onDiscard={editor.discard} editRef={editRef} /></>} createDialog={<IssueCreateDialog open={create.createOpen} onOpenChange={(open) => setCreate((previous) => ({ ...previous, createOpen: open }))} ui={create} setUi={setCreate} domain={domain} setDomain={setDomain} catalog={catalog} projects={projects.filter((entry) => entry.id === item?.projectId)} writable={writable} finalFocus={editRef} />} regions={{
    editor: item && editor.draft ? <><div className={styles.identifierChip}><code>{item.identifier}</code></div>{editor.editing ? <IssueTitleField draft={editor.draft} editing onPatch={editor.patch} disabled={!writable || editor.locked} error={editor.mutation?.fieldErrors?.title} /> : <h1 className={styles.title}>{item.title}</h1>}{variant === "detail2" && properties}<section className={styles.section}><h2 className={styles.sectionTitle}>{en ? "Description" : "描述"}</h2>{editor.editing ? <IssueDescriptionField draft={editor.draft} editing onPatch={editor.patch} disabled={!writable || editor.locked} error={editor.mutation?.fieldErrors?.description} /> : <MessageContent content={item.description ?? ""} className={styles.prose} />}</section></> : undefined,
    properties,
    attachments: item ? <section><h2 className={styles.sectionTitle}>{en ? "Attachments" : "附件"}</h2><IssueAttachments attachments={item.attachments} variant={variant === "detail1" ? "panel" : "grid"} /></section> : undefined,
    mutation: <IssueMutationStatus mutation={editor.mutation} disabled={!writable} onConfirm={() => editor.reconcile("confirmed")} onReject={() => editor.reconcile("rejected")} />,
    subissues: item ? <section className={styles.section}><IssueChildCreate item={item} catalog={catalog} domain={domain} setDomain={setDomain} projects={projects} writable={writable} label={en ? "Add sub-issue" : "新建子问题"} mode={variant === "detail2" ? "inline" : "sheet"} />{variant === "detail2" ? <IssueSubtasksSection items={children} catalog={catalog} disabled={!writable} onToggle={(child, stateId) => setDomain((previous) => patchIssueDomain(previous, child.id, { stateId }, outcome, child.revision))} /> : <IssueSubissueList items={children} catalog={catalog} onOpen={(child) => navigate(slug, child.id)} />}</section> : undefined,
    activity: <IssueActivityList entries={activities.filter((entry) => activityFilter === "all" || entry.kind === activityFilter)} emptyText={en ? "No activity in this local scene." : "本地场景暂无动态。"} />,
    comments: item ? <IssueCommentsSection itemId={item.id} store={comments} setStore={setComments} disabled={!writable} author={author} /> : undefined,
  }} />
}
