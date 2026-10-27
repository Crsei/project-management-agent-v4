import { ArrowLeft, Paperclip, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DataRegion } from "@/components/ui/data-region"
import { MessageContent } from "@/components/blocks/message-content"
import { WorkItemProperties } from "@/components/blocks/work-item-properties"
import { WorkItemRow } from "@/components/blocks/work-item"
import { isMutationLocked } from "@/lib/work-items-model"
import { useI18n } from "@/lib/i18n-provider"
import { PmPage } from "./presentation-page"
import {
  ControlledActivity,
  ControlledAttachments,
  ControlledFeedback,
  ControlledFocus,
  ControlledMutation,
} from "./controlled-presentation"
import { IssueDraftForm } from "./issue-draft-form"
import { IssueRelationFields } from "./issue-relations"
import type { IssueDetailViewProps } from "./controlled-contracts"
import detail1Styles from "./issue-detail-1.module.css"
import detail2Styles from "./issue-detail-2.module.css"
import familyStyles from "./issues-views.module.css"

export function IssueDetailView(props: IssueDetailViewProps) {
  const { readModel: model, interaction, capabilities, actions } = props
  const { locale } = useI18n()
  const en = locale === "en"
  const item = model.item
  const styles = props.variant === "detail1" ? detail1Styles : detail2Styles
  const locked =
    isMutationLocked(model.mutation) ||
    (model.data.state === "loading" && !item)
  const properties =
    props.regions?.properties ??
    (item ? (
      <section data-pm-issue-properties>
        <h2 className="text-base font-medium">{en ? "Properties" : "属性"}</h2>
        <WorkItemProperties
          item={item}
          catalog={model.catalog}
          capabilities={capabilities}
          mutation={model.mutation}
          today={model.today}
          layout="detail"
          visibleProperties={[
            "state",
            "priority",
            "assignees",
            "labels",
            "startDate",
            "dueDate",
            "counts",
          ]}
          onPatchItem={(_record, patch) => actions.patch(item, patch)}
        />
        <IssueRelationFields
          item={item}
          catalog={model.catalog}
          capabilities={capabilities}
          mutation={model.mutation}
          onPatch={actions.patch}
        />
        <dl className="mt-4 grid gap-3 text-xs">
          <div>
            <dt className="text-muted-foreground">
              {en ? "Identifier" : "编号"}
            </dt>
            <dd className="break-all">{item.identifier}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {en ? "Revision" : "修订"}
            </dt>
            <dd>{item.sourceRevision === null ? (en ? "Not provided" : "未提供") : item.sourceRevision ?? item.revision}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {en ? "Parent" : "父任务"}
            </dt>
            <dd className="break-all">{item.parentId ?? "—"}</dd>
          </div>
        </dl>
      </section>
    ) : null)
  const attachments = props.regions?.attachments !== undefined ? props.regions.attachments : (
    <section className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className={styles.sectionTitle}>{en ? "Attachments" : "附件"}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={en ? "Attach file" : "上传附件"}
          disabled={!item || !capabilities.attach || locked}
          onClick={(event) => actions.attach(event.currentTarget)}
        >
          <Paperclip aria-hidden="true" />
        </Button>
      </div>
      <ControlledAttachments
        entries={model.attachments}
        onOpen={actions.openAttachment}
      />
    </section>
  )
  const body = item ? (
    <div className={styles.body}>
      <nav
        className={styles.breadcrumb}
        aria-label={en ? "Issue location" : "任务位置"}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => actions.openProject(item.projectId)}
        >
          {model.catalog.projects.find((entry) => entry.id === item.projectId)
            ?.label ?? item.projectId}
        </Button>
        <span aria-hidden="true">/</span>
        <code>{item.identifier}</code>
      </nav>
      {props.regions?.editor ??
        (interaction.editing && interaction.draft ? (
          <IssueDraftForm
            id={`pm-${item.id}`}
            draft={interaction.draft}
            catalog={model.catalog}
            parentOptions={model.parentOptions ?? []}
            disabled={locked}
            canEdit={(field) =>
              field === "projectId" ||
              field === "moduleIds" ||
              field === "cycleId" ||
              field === "estimatePointId" ||
              field === "parentId"
                ? capabilities.canEditRelation(item, field)
                : capabilities.canEditField(item, field)
            }
            fieldErrors={props.fieldErrors}
            onChange={actions.setDraft}
            onSubmit={actions.save}
            onCancel={actions.cancel}
          />
        ) : (
          <>
            <h1 className={styles.title}>{item.title}</h1>
            {props.variant === "detail2" && properties}
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>
                {en ? "Description" : "描述"}
              </h2>
              {item.description ? (
                <MessageContent
                  content={item.description}
                  className={styles.prose}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {en ? "No description." : "暂无描述。"}
                </p>
              )}
            </section>
          </>
        ))}
      {props.variant === "detail1" && attachments}
      {props.regions?.mutation ?? (
        <ControlledMutation
          mutation={model.mutation}
          reconcile={actions.reconcile}
        />
      )}
      {props.regions?.subissues !== undefined ? props.regions.subissues : (
        <section
          className={`${styles.section} ${props.variant === "detail2" ? detail2Styles.subtaskSection : ""}`}
          data-pm-subissues
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className={styles.sectionTitle}>
              {en ? "Sub-issues" : "子任务"}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={!capabilities.createChild || locked}
              onClick={(event) =>
                actions.createChild(item, event.currentTarget)
              }
            >
              <Plus aria-hidden="true" />
              {en ? "Add sub-issue" : "新建子任务"}
            </Button>
          </div>
          {model.children.length ? (
            model.children.map((child) => (
              <WorkItemRow
                key={child.id}
                item={child}
                catalog={model.catalog}
                visibleProperties={["state", "priority", "assignees"]}
                capabilities={capabilities}
                onOpen={() => actions.open(child)}
                onPatchItem={(_record, patch) => actions.patch(child, patch)}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {en ? "No linked sub-issues." : "暂无关联子任务。"}
            </p>
          )}
        </section>
      )}
      <section className={styles.section}>
        <div className="flex items-center justify-between">
          <h2 className={styles.sectionTitle}>{en ? "Activity" : "动态"}</h2>
          {props.regions?.activity === undefined && <div className="flex gap-1">
            {(["all", "comment", "update"] as const).map((filter) => (
              <Button
                key={filter}
                variant="ghost"
                size="sm"
                aria-pressed={interaction.activityFilter === filter}
                onClick={() => actions.setActivityFilter(filter)}
              >
                {filter === "all"
                  ? en
                    ? "All"
                    : "全部"
                  : filter === "comment"
                    ? en
                      ? "Comments"
                      : "评论"
                    : en
                      ? "Updates"
                      : "更新"}
              </Button>
            ))}
          </div>}
        </div>
        {props.regions?.activity ?? (
          <ControlledActivity
            entries={model.activity.filter(
              (entry) =>
                interaction.activityFilter === "all" ||
                entry.kind === interaction.activityFilter,
            )}
          />
        )}
        {props.regions?.comments !== undefined ? props.regions.comments : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (
                capabilities.comment &&
                interaction.commentDraft.trim() &&
                !isMutationLocked(props.commentMutation)
              )
                actions.comment()
            }}
          >
            <Textarea
              id={`pm-${item.id}-comment`}
              aria-label={en ? "Comment" : "评论"}
              placeholder={en ? "Write a comment…" : "撰写评论…"}
              value={interaction.commentDraft}
              disabled={!capabilities.comment}
              onChange={(event) => actions.setCommentDraft(event.target.value)}
            />
            <ControlledMutation
              mutation={props.commentMutation}
              reconcile={actions.reconcile}
            />
            <Button
              type="submit"
              className="justify-self-end"
              disabled={
                !capabilities.comment ||
                !interaction.commentDraft.trim() ||
                isMutationLocked(props.commentMutation)
              }
            >
              {en ? "Post comment" : "发表评论"}
            </Button>
          </form>
        )}
      </section>
    </div>
  ) : null
  return (
    <ControlledFocus surface={props}>
      <PmPage interactive={props.interactive} pageId={props.pageId ?? `pm-controlled-issue-${props.variant}`}
      title={item?.title ?? (en ? "Issue detail" : "任务详情")}
      headerMode="hidden"
      className={`${styles.page} ${familyStyles.detailPage}`}
      readingPosition={props.readingPosition}
      onReadingPositionChange={props.onReadingPositionChange}
      sidebarPlacement="right"
      sidebar={
        props.variant === "detail1" && item ? (
          <aside
            tabIndex={0}
            className={`${styles.panel} outline-none focus-visible:ring-2 focus-visible:ring-ring`}
            aria-label={en ? "Issue metadata" : "任务元数据"}
          >
            {properties}
          </aside>
        ) : undefined
      }
      toolbar={
        <header className={styles.actions} data-pm-header>
          <Button
            data-pm-return
            id="pm-issue-back"
            variant="ghost"
            onClick={actions.back}
          >
            <ArrowLeft aria-hidden="true" />
            {en ? "Return" : "返回"}
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {item?.identifier}
          </span>
          {props.headerActions ?? (
            <Button
              id="pm-issue-edit"
              variant="secondary"
              disabled={
                !item ||
                locked ||
                !capabilities.canEditField(item, "title") ||
                interaction.editing
              }
              title={capabilities.reason}
              onClick={(event) => actions.edit(event.currentTarget)}
            >
              {en ? "Edit issue" : "编辑任务"}
            </Button>
          )}
        </header>
      }>
        <ControlledFeedback surface={props} />
        <DataRegion
          {...model.data}
          hasContent={!!item}
          emptyDescription={
            model.data.emptyDescription ??
            (en
              ? "This issue is unavailable in the current scope."
              : "当前范围内此任务不可用。")
          }
        >
          {props.variant === "detail2" && attachments ? (
            <div className={detail2Styles.detailLayout}>
              {body}
              <aside className={styles.panel}>{attachments}</aside>
            </div>
          ) : (
            body
          )}
        </DataRegion>
        {props.createDialog}
      </PmPage>
    </ControlledFocus>
  )
}
