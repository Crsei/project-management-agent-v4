import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileText, FlaskConical, LockKeyhole, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Entity } from "../../../../../packages/contracts/src/client";
import { automationConfigSchema, type AutomationCapabilities, type AutomationConfig, type AutomationPreview, type AutomationRule } from "../../../../../packages/contracts/src/automation";
import { automationDateTime } from "./format";
import { EvidenceList, RuleStatus } from "./run-details";
import { isDirty, type RuleDraft } from "./journal";
import styles from "./automation.module.css";

type Props = {
  draft: RuleDraft;
  rule: AutomationRule | null;
  projects: Entity[];
  capabilities: AutomationCapabilities | undefined;
  writable: boolean;
  readable: boolean;
  locked: boolean;
  root: string;
  actions?: ReactNode;
  onClose?: () => void;
  onChange: (draft: RuleDraft) => void;
  onSave: (config: AutomationConfig) => void;
  onReset: () => void;
  onRebase: () => void;
  test: (config: AutomationConfig, signal: AbortSignal) => Promise<AutomationPreview>;
};
function projectName(project: Entity) {
  return typeof project.data.name === "string" && project.data.name ? project.data.name : project.id;
}
function EditorField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{children(id)}</div>;
}

export function RuleEditor({ draft, rule, projects, capabilities, writable, readable, locked, root, actions, onClose, onChange, onSave, onReset, onRebase, test }: Props) {
  const nameId = useId();
  const descriptionId = useId();
  const projectId = useId();
  const reportHeadingId = useId();
  const triggerHeadingId = useId();
  const [validation, setValidation] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [testedConfig, setTestedConfig] = useState("");
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const config = draft.config;
  const configKey = JSON.stringify(config);
  const dirty = isDirty(draft);
  const stale = !!rule && rule.revision !== draft.expectedRevision;
  const reportAvailable = capabilities?.actions.some(action => action.id === "report" && action.available) === true;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  function change(patch: Partial<AutomationConfig>) { setValidation(""); onChange({ ...draft, config: { ...config, ...patch } }); }
  function validated(): AutomationConfig | null {
    const parsed = automationConfigSchema.safeParse(config);
    if (!parsed.success || !projects.some(project => project.id === config.projectId)) {
      setValidation("请检查名称、项目、时间与 IANA 时区。每日上限 1–100，冷却 0–10080 分钟。");
      return null;
    }
    setValidation("");
    return parsed.data;
  }
  async function previewDraft() {
    if (testing || locked || !readable || !reportAvailable) return;
    const value = validated();
    if (!value) return;
    const request = new AbortController();
    controller.current = request;
    setTesting(true); setTestError(""); setPreview(null);
    try {
      const result = await test(value, request.signal);
      if (!alive.current || request.signal.aborted) return;
      setPreview(result); setTestedConfig(configKey);
    } catch {
      if (alive.current && !request.signal.aborted) setTestError("测试未完成，请检查权限或服务后重试。");
    } finally { if (alive.current && !request.signal.aborted) setTesting(false); }
  }
  return <article className={styles.editor} aria-label="自动化规则编辑器">
    <form onSubmit={event => { event.preventDefault(); if (!writable || locked || stale || testing) return; const value = validated(); if (value) onSave(value); }}>
      <header className={styles.editorHeading}>
        <h1 className={styles.srOnly}>{config.name || "新建自动化"}</h1>
        <label htmlFor={nameId} className={styles.srOnly}>规则名称</label>
        <input id={nameId} className={styles.titleInput} value={config.name} maxLength={160} required disabled={locked || testing} placeholder="新建自动化" onChange={event => change({ name: event.target.value })} />
        <div className={styles.headingActions}>
          <Button type="button" variant="ghost" size="sm" disabled={locked || testing} onClick={onClose ?? onReset}>取消</Button>
          <Button type="submit" size="sm" disabled={!writable || locked || testing || stale || (!!rule && !dirty)}>{rule ? "保存" : "创建草稿"}</Button>
        </div>
      </header>
      <div className={styles.editorMetadata}>
        {rule ? <RuleStatus value={rule.status} /> : <span className={styles.badge}>未保存</span>}
        <label htmlFor={projectId} className={styles.srOnly}>项目</label>
        <select id={projectId} className={styles.projectSelect} value={config.projectId} required disabled={locked || testing} onChange={event => change({ projectId: event.target.value })}>
          <option value="">选择项目</option>
          {config.projectId && !projects.some(project => project.id === config.projectId) && <option value={config.projectId} disabled>原项目不可用</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{projectName(project)} ({project.id})</option>)}
        </select>
        <span className={styles.muted}>{dirty ? "未保存修改" : rule ? `v${draft.expectedRevision}` : "只读报告"}</span>
        {actions && <div className={styles.ruleActions}>{actions}</div>}
      </div>
      {stale && <section className={styles.warning} role="status">
        <strong>规则已有新版本，草稿已保留。</strong>
        <p>草稿版本 {draft.expectedRevision} / 当前版本 {rule?.revision}</p>
        <details><summary>比较已保存配置</summary><pre className={styles.code}>{JSON.stringify(rule?.config, null, 2)}</pre></details>
        <div className={styles.actions}><Button type="button" variant="outline" size="sm" disabled={locked || testing} onClick={onRebase}>保留草稿，采用当前版本</Button><Button type="button" variant="ghost" size="sm" disabled={locked || testing} onClick={onReset}>载入已保存版本</Button></div>
      </section>}
      {!writable && !!config.projectId && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />项目只读或已结束，无法保存或运行。</p>}
      <fieldset disabled={locked || testing} className={styles.formBody}>
        <section className={styles.editorSection} aria-labelledby={reportHeadingId}>
          <h2 id={reportHeadingId} className={styles.sectionTitle}><span aria-hidden="true">1</span>报告内容</h2>
          <div className={styles.reportSurface}>
            <label htmlFor={descriptionId} className={styles.descriptionLabel}>规则说明</label>
            <textarea id={descriptionId} className={styles.descriptionInput} value={config.description} maxLength={4000} rows={5} placeholder="记录这条规则要观察的内容…" onChange={event => change({ description: event.target.value })} />
            <div className={styles.reportToolbar}>
              <FileText size={14} aria-hidden="true" /><span>只读报告</span>
              <label className={styles.srOnly} htmlFor={`${descriptionId}-condition`}>观测条件</label>
              <select id={`${descriptionId}-condition`} className={styles.conditionSelect} value={config.condition} onChange={event => change({ condition: event.target.value as AutomationConfig["condition"] })}>
                <option value="all_open">全部未完成任务</option><option value="overdue">逾期未完成任务</option><option value="blocked">受阻任务</option>
              </select>
              <Button type="button" variant="ghost" size="sm" disabled={locked || testing || !readable || !reportAvailable} onClick={() => { void previewDraft(); }}><FlaskConical size={14} aria-hidden="true" />{testing ? "测试中…" : "只读测试"}</Button>
            </div>
          </div>
          {!reportAvailable && <p className={styles.reason}>{capabilities?.actions.find(action => action.id === "report")?.reason || "报告暂不可用。"}</p>}
        </section>
        <section className={styles.editorSection} aria-labelledby={triggerHeadingId}>
          <h2 id={triggerHeadingId} className={styles.sectionTitle}><span aria-hidden="true">2</span>运行时间</h2>
          <div className={styles.triggerSurface}>
            <EditorField label="触发方式">{id => <select id={id} value={config.trigger.kind} onChange={event => change({ trigger: { ...config.trigger, kind: event.target.value === "daily" ? "daily" : "manual" } })}><option value="manual">仅手动运行</option><option value="daily">每日定时</option></select>}</EditorField>
            {config.trigger.kind === "daily" && <EditorField label="本地时间">{id => <Input id={id} type="time" required value={config.trigger.time} onChange={event => change({ trigger: { ...config.trigger, time: event.target.value } })} />}</EditorField>}
            <EditorField label="IANA 时区">{id => <Input id={id} value={config.trigger.timezone} maxLength={100} required placeholder="Asia/Shanghai" onChange={event => change({ trigger: { ...config.trigger, timezone: event.target.value } })} />}</EditorField>
          </div>
          {config.trigger.kind === "daily" && capabilities?.scheduler.ready !== true && <p className={styles.reason}>后台调度未就绪，暂不能启用。</p>}
        </section>
        <details className={styles.settings}>
          <summary><Settings2 size={14} aria-hidden="true" /><span>设置</span><span className={styles.settingsSummary}>每日上限 {config.dailyLimit} / 冷却 {config.cooldownMinutes} 分钟</span><ChevronDown size={14} aria-hidden="true" /></summary>
          <div className={styles.formGrid}>
            <EditorField label="每日运行上限">{id => <Input id={id} type="number" min={1} max={100} step={1} required value={config.dailyLimit} onChange={event => change({ dailyLimit: Number(event.target.value) })} />}</EditorField>
            <EditorField label="冷却时间（分钟）">{id => <Input id={id} type="number" min={0} max={10080} step={1} required value={config.cooldownMinutes} onChange={event => change({ cooldownMinutes: Number(event.target.value) })} />}</EditorField>
          </div>
        </details>
      </fieldset>
      {validation && <p role="alert" className={styles.error}>{validation}</p>}
      {dirty && rule && <Button type="button" variant="ghost" size="sm" className={styles.resetDraft} disabled={locked || testing} onClick={onReset}>放弃修改</Button>}
    </form>
    {testError && <p role="alert" className={styles.error}>{testError}</p>}
    {preview && <section className={styles.preview} aria-label="只读测试结果">
      <h2><FlaskConical size={14} aria-hidden="true" />测试结果</h2>
      {testedConfig !== configKey && <p className={styles.warning}>配置已修改，以下是上次测试结果。</p>}
      <time dateTime={preview.observedAt}>{automationDateTime(preview.observedAt)}</time>
      <p className={styles.prose}>匹配 {preview.evidence.length} 条任务</p><EvidenceList items={preview.evidence} root={root} />
    </section>}
  </article>;
}
