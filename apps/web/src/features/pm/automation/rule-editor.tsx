import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { ChevronDown, FileText, FlaskConical, LockKeyhole, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect } from "@/components/ui/native-select"
import type { Entity } from "@contracts"
import { automationConfigSchema, type AutomationCapabilities, type AutomationConfig, type AutomationPreview, type AutomationRule } from "../../../../../../packages/contracts/src/automation"
import { useText, string } from "../service/pm-ui"
import { useDisplayDateTime } from "@/features/workspace/preference-format"
import { EvidenceList, RuleStatus } from "./run-details"
import { isDirty, type RuleDraft } from "./journal"
import styles from "./automation.module.css"

type Props = {
  draft: RuleDraft
  rule: AutomationRule | null
  projects: Entity[]
  capabilities: AutomationCapabilities | undefined
  writable: boolean
  readable: boolean
  locked: boolean
  root: string
  actions?: ReactNode
  onClose?: () => void
  onChange: (draft: RuleDraft) => void
  onSave: (config: AutomationConfig) => void
  onReset: () => void
  onRebase: () => void
  test: (config: AutomationConfig, signal: AbortSignal) => Promise<AutomationPreview>
}
function EditorField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{children(id)}</div>
}
export function RuleEditor({ draft, rule, projects, capabilities, writable, readable, locked, root, actions, onClose, onChange, onSave, onReset, onRebase, test }: Props) {
  const t = useText()
  const display = useDisplayDateTime()
  const nameId = useId()
  const descriptionId = useId()
  const projectId = useId()
  const reportHeadingId = useId()
  const triggerHeadingId = useId()
  const [validation, setValidation] = useState("")
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState("")
  const [preview, setPreview] = useState<AutomationPreview | null>(null)
  const [testedConfig, setTestedConfig] = useState("")
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(false)
  const config = draft.config
  const configKey = JSON.stringify(config)
  const dirty = isDirty(draft)
  const stale = !!rule && rule.revision !== draft.expectedRevision
  const reportAvailable = capabilities?.actions.some(action => action.id === "report" && action.available) === true
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  function change(patch: Partial<AutomationConfig>) { setValidation(""); onChange({ ...draft, config: { ...config, ...patch } }) }
  function validated(): AutomationConfig | null {
    const parsed = automationConfigSchema.safeParse(config)
    if (!parsed.success || !projects.some(project => project.id === config.projectId)) {
      setValidation(t("请检查名称、项目、时间与 IANA 时区。每日上限 1–100，冷却 0–10080 分钟。", "Check name, project, time and IANA time zone. Daily limit: 1–100; cooldown: 0–10080 minutes."))
      return null
    }
    setValidation("")
    return parsed.data
  }
  async function previewDraft() {
    if (testing || locked || !readable || !reportAvailable) return
    const value = validated()
    if (!value) return
    const request = new AbortController()
    controller.current = request
    setTesting(true); setTestError(""); setPreview(null)
    try {
      const result = await test(value, request.signal)
      if (!alive.current || request.signal.aborted) return
      setPreview(result); setTestedConfig(configKey)
    } catch {
      if (alive.current && !request.signal.aborted) setTestError(t("测试未完成，请检查权限或服务后重试。", "Test incomplete. Check access or service availability and retry."))
    } finally { if (alive.current && !request.signal.aborted) setTesting(false) }
  }
  return <article className={styles.editor} aria-label={t("自动化规则编辑器", "Automation rule editor")}>
    <form onSubmit={event => { event.preventDefault(); if (!writable || locked || stale || testing) return; const value = validated(); if (value) onSave(value) }}>
      <header className={styles.editorHeading}>
        <h1 className={styles.srOnly}>{config.name || t("新建自动化", "New automation")}</h1>
        <label htmlFor={nameId} className={styles.srOnly}>{t("规则名称", "Rule name")}</label>
        <Input id={nameId} className={styles.titleInput} value={config.name} maxLength={160} required disabled={locked || testing} placeholder={t("新建自动化", "New automation")} onChange={event => change({ name: event.target.value })} />
        <div className={styles.headingActions}>
          <Button type="button" variant="ghost" size="sm" disabled={locked || testing} onClick={onClose ?? onReset}>{t("取消", "Cancel")}</Button>
          <Button type="submit" size="sm" disabled={!writable || locked || testing || stale || (!!rule && !dirty)}>{rule ? t("保存", "Save") : t("创建草稿", "Create draft")}</Button>
        </div>
      </header>
      <div className={styles.editorMetadata}>
        {rule ? <RuleStatus value={rule.status} /> : <span className={styles.badge}>{t("未保存", "Unsaved")}</span>}
        <label htmlFor={projectId} className={styles.srOnly}>{t("项目", "Project")}</label>
        <NativeSelect id={projectId} className={styles.projectSelect} value={config.projectId} required disabled={locked || testing} onChange={event => change({ projectId: event.target.value })}>
          <option value="">{t("选择项目", "Select project")}</option>
          {config.projectId && !projects.some(project => project.id === config.projectId) && <option value={config.projectId} disabled>{t("原项目不可用", "Original project unavailable")}</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{string(project.data.name) || project.id} ({project.id})</option>)}
        </NativeSelect>
        <span className={styles.muted}>{dirty ? t("未保存修改", "Unsaved changes") : rule ? `v${draft.expectedRevision}` : t("只读报告", "Read-only report")}</span>
        {actions && <div className={styles.ruleActions}>{actions}</div>}
      </div>
      {stale && <section className={styles.warning} role="status">
        <strong>{t("规则已有新版本，草稿已保留。", "A newer revision is available. Your draft is retained.")}</strong>
        <p>{t("草稿版本", "Draft revision")} {draft.expectedRevision} / {t("当前版本", "Current revision")} {rule?.revision}</p>
        <details><summary>{t("比较已保存配置", "Compare saved configuration")}</summary><pre className={styles.code}>{JSON.stringify(rule?.config, null, 2)}</pre></details>
        <div className={styles.actions}><Button type="button" variant="outline" size="sm" disabled={locked || testing} onClick={onRebase}>{t("保留草稿，采用当前版本", "Keep draft, adopt current revision")}</Button><Button type="button" variant="ghost" size="sm" disabled={locked || testing} onClick={onReset}>{t("载入已保存版本", "Load saved revision")}</Button></div>
      </section>}
      {!writable && !!config.projectId && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />{t("项目只读或已结束，无法保存或运行。", "Project is read-only or closed. Saving and running are unavailable.")}</p>}
      <fieldset disabled={locked || testing} className={styles.formBody}>
        <section className={styles.editorSection} aria-labelledby={reportHeadingId}>
          <h2 id={reportHeadingId} className={styles.sectionTitle}><span aria-hidden="true">1</span>{t("报告内容", "Report content")}</h2>
          <div className={styles.reportSurface}>
            <label htmlFor={descriptionId} className={styles.descriptionLabel}>{t("规则说明", "Rule description")}</label>
            <Textarea id={descriptionId} className={styles.descriptionInput} value={config.description} maxLength={4000} rows={5} placeholder={t("记录这条规则要观察的内容…", "Describe what this rule observes…")} onChange={event => change({ description: event.target.value })} />
            <div className={styles.reportToolbar}>
              <FileText size={14} aria-hidden="true" /><span>{t("只读报告", "Read-only report")}</span>
              <label className={styles.srOnly} htmlFor={`${descriptionId}-condition`}>{t("观测条件", "Observation condition")}</label>
              <NativeSelect id={`${descriptionId}-condition`} className={styles.conditionSelect} value={config.condition} onChange={event => change({ condition: event.target.value as AutomationConfig["condition"] })}>
                <option value="all_open">{t("全部未完成任务", "All open tasks")}</option><option value="overdue">{t("逾期未完成任务", "Overdue tasks")}</option><option value="blocked">{t("受阻任务", "Blocked tasks")}</option>
              </NativeSelect>
              <Button type="button" variant="ghost" size="sm" disabled={locked || testing || !readable || !reportAvailable} onClick={() => { void previewDraft() }}><FlaskConical size={14} aria-hidden="true" />{testing ? t("测试中…", "Testing…") : t("只读测试", "Read-only test")}</Button>
            </div>
          </div>
          {!reportAvailable && <p className={styles.reason}>{capabilities?.actions.find(action => action.id === "report")?.reason || t("报告暂不可用。", "Reports unavailable.")}</p>}
        </section>
        <section className={styles.editorSection} aria-labelledby={triggerHeadingId}>
          <h2 id={triggerHeadingId} className={styles.sectionTitle}><span aria-hidden="true">2</span>{t("运行时间", "When it should run")}</h2>
          <div className={styles.triggerSurface}>
            <EditorField label={t("触发方式", "Trigger")}>{id => <NativeSelect id={id} value={config.trigger.kind} onChange={event => change({ trigger: { ...config.trigger, kind: event.target.value === "daily" ? "daily" : "manual" } })}><option value="manual">{t("仅手动运行", "Manual only")}</option><option value="daily">{t("每日定时", "Daily schedule")}</option></NativeSelect>}</EditorField>
            {config.trigger.kind === "daily" && <EditorField label={t("本地时间", "Local time")}>{id => <Input id={id} type="time" required value={config.trigger.time} onChange={event => change({ trigger: { ...config.trigger, time: event.target.value } })} />}</EditorField>}
            <EditorField label={t("IANA 时区", "IANA time zone")}>{id => <Input id={id} value={config.trigger.timezone} maxLength={100} required placeholder="Asia/Shanghai" onChange={event => change({ trigger: { ...config.trigger, timezone: event.target.value } })} />}</EditorField>
          </div>
          {config.trigger.kind === "daily" && capabilities?.scheduler.ready !== true && <p className={styles.reason}>{t("后台调度未就绪，暂不能启用。", "Scheduler not ready. Enabling is unavailable.")}</p>}
        </section>
        <details className={styles.settings}>
          <summary><Settings2 size={14} aria-hidden="true" /><span>{t("设置", "Settings")}</span><span className={styles.settingsSummary}>{t("每日上限", "Daily limit")} {config.dailyLimit} / {t("冷却", "Cooldown")} {config.cooldownMinutes} {t("分钟", "min")}</span><ChevronDown size={14} aria-hidden="true" /></summary>
          <div className={styles.formGrid}>
            <EditorField label={t("每日运行上限", "Daily run limit")}>{id => <Input id={id} type="number" min={1} max={100} step={1} required value={config.dailyLimit} onChange={event => change({ dailyLimit: Number(event.target.value) })} />}</EditorField>
            <EditorField label={t("冷却时间（分钟）", "Cooldown (minutes)")}>{id => <Input id={id} type="number" min={0} max={10080} step={1} required value={config.cooldownMinutes} onChange={event => change({ cooldownMinutes: Number(event.target.value) })} />}</EditorField>
          </div>
        </details>
      </fieldset>
      {validation && <p role="alert" className={styles.error}>{validation}</p>}
      {dirty && rule && <Button type="button" variant="ghost" size="sm" className={styles.resetDraft} disabled={locked || testing} onClick={onReset}>{t("放弃修改", "Discard changes")}</Button>}
    </form>
    {testError && <p role="alert" className={styles.error}>{testError}</p>}
    {preview && <section className={styles.preview} aria-label={t("只读测试结果", "Read-only test result")}>
      <h2><FlaskConical size={14} aria-hidden="true" />{t("测试结果", "Test result")}</h2>
      {testedConfig !== configKey && <p className={styles.warning}>{t("配置已修改，以下是上次测试结果。", "Configuration changed. Results are from the previous test.")}</p>}
      <time dateTime={preview.observedAt}>{display.date(preview.observedAt)} {display.time(preview.observedAt)}</time>
      <p className={styles.prose}>{t(`匹配 ${preview.evidence.length} 条任务`, `${preview.evidence.length} matching tasks`)}</p><EvidenceList items={preview.evidence} root={root} />
    </section>}
  </article>
}
