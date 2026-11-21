import { useMemo, useState } from "react";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { automationCatalog, automationTemplateRecommended, automationTemplateTags, automationTemplateTriggers } from "../../../../../../../../packages/automation-resources/catalog";
import { StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { isPmAutomationTemplateId } from "../../../../../../../../packages/contracts/src/automation-pm";
import { pmAutomationCatalogSource } from "../../../../../../../../packages/automation-resources/pm-catalog";
import { pmAutomationTemplateRequiresProvider } from "../../../../../../../../packages/contracts/src/automation-pm";
import { useAgentText } from "../../i18n";
import { useStudioConnections } from "./studio-setup-dependencies";
import { studioConnectionSupportsAction } from "./studio-setup";
import { useAutomationQuery } from "./query";
import { filterStudioTemplates } from "./studio-template-catalog";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select"

type Props = { workspaceId: string; projectId?: string; onSelect: (templateId: string) => void; onIntegrations?: () => void };
export function StudioTemplates({ workspaceId, projectId, onSelect, onIntegrations }: Props) {
  const t = useAgentText();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [trigger, setTrigger] = useState("");
  const api = useMemo(() => new StudioClient(workspaceId), [workspaceId]);
  const capabilities = useAutomationQuery(`template-capabilities:${workspaceId}:${projectId ?? ""}`, signal => api.capabilities(projectId!, { actionKind: "template", signal }), Boolean(projectId));
  const { connections, error, loading, refresh } = useStudioConnections(workspaceId, projectId);
  const verifiedByTemplate = new Map(automationCatalog.map(template => [template.id, new Set(connections.filter(connection => studioConnectionSupportsAction(connection, "template")).map(connection => connection.provider as string))]));
  const categories = [...new Set(automationCatalog.map(template => template.category))].sort();
  const matched = filterStudioTemplates(automationCatalog, { query, category, trigger });
  const suggestedIds = new Set(automationCatalog.filter(template => automationTemplateRecommended(template)).map(template => template.id));
  const sections = [{ name: t("推荐", "Suggested"), items: matched.filter(template => suggestedIds.has(template.id)) }, { name: t("更多模板", "More templates"), items: matched.filter(template => !suggestedIds.has(template.id)) }];
  const clear = () => { setQuery(""); setCategory(""); setTrigger(""); };
  return <section className={styles.templates} aria-label={t("自动化模板", "Automation templates")}>
    <header className={styles.heading}><div><h1>{t("模板", "Templates")}</h1><p>{t("项目内置的只读分析模板。打开后先看用途与产出，再明确配置、试运行或启用。仅浏览不会创建会话、保存定义或运行。", "Project-built read-only analysis templates. Open one to see its purpose and output before configuring, testing, or enabling. Browsing never creates a conversation, saves a definition, or starts a run.")}</p></div></header>
    <div className={styles.search}><Search size={16} aria-hidden="true" /><Input aria-label={t("搜索模板", "Search templates")} placeholder={t("搜索模板…", "Search templates…")} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className={styles.filters}><label>{t("分类", "Category")}<RadixSelect value={category} onChange={event => setCategory(event.target.value)}><option value="">{t("所有分类", "All categories")}</option>{categories.map(id => <option value={id} key={id}>{id}</option>)}</RadixSelect></label><label>{t("触发器", "Trigger")}<RadixSelect value={trigger} onChange={event => setTrigger(event.target.value)}><option value="">{t("所有触发器", "All triggers")}</option><option value="manual">{t("手动", "Manual")}</option><option value="cron">Cron</option><option value="event">{t("事件", "Event")}</option></RadixSelect></label><span>{matched.length} / {automationCatalog.length}</span></div>
    <div className={styles.connectionNotice}>{!projectId ? t("选择项目后可读取真实运行能力与连接状态。", "Choose a project to read actual runtime capabilities and connections.") : loading || capabilities.loading ? t("读取能力与连接状态…", "Loading capabilities and connections…") : t("模型能力与外部连接分别报告，读取状态不探测外部服务。", "Model readiness and external connections are reported separately; reading status does not probe external services.")}<Button size="sm" variant="ghost" onClick={() => { refresh(); capabilities.refetch(); }} disabled={!projectId || loading || capabilities.loading}>{t("刷新", "Refresh")}</Button>{onIntegrations && <Button size="sm" variant="ghost" onClick={onIntegrations}>{t("连接设置", "Connections")}</Button>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!!capabilities.error && <p className={styles.error} role="alert">{t("运行能力读取失败；未假定 Provider 已就绪。", "Could not read runtime capabilities; Provider readiness is not assumed.")}</p>}
    {!matched.length && <div className={styles.empty}><Search size={28} /><h2>{t("没有匹配的模板", "No matching templates")}</h2><Button variant="outline" onClick={clear}>{t("清除搜索与筛选", "Clear search and filters")}</Button></div>}
    {sections.filter(section => section.items.length > 0).map(section => <section key={section.name} className={styles.catalogSection}><h2><Sparkles size={16} aria-hidden="true" />{section.name}<span>{section.items.length}</span></h2><div className={styles.catalogGrid}>{section.items.map(template => {
      const pmTemplateId = isPmAutomationTemplateId(template.id) ? template.id : null;
      const needsProvider = pmTemplateId ? pmAutomationTemplateRequiresProvider(pmTemplateId) : false;
      const verified = verifiedByTemplate.get(template.id)!;
      const missing = [...new Set([...Object.entries(template.requires.integrations).filter(([, requirement]) => requirement.required !== false).map(([id]) => id), ...automationTemplateTags(template)])].filter(id => !verified.has(id));
      const feature = capabilities.data?.features?.find(item => item.id === `template:${template.id}`);
      return <article key={template.id} className={styles.templateCard}>
        <div className={styles.tags}><span>{t("PM 原生", "PM native")}</span>{template.scenario && <span>#{template.scenario}</span>}{automationTemplateTriggers(template).map(kind => <span key={kind}>{kind === "manual" ? t("手动", "Manual") : kind === "cron" ? "Cron" : "Event"}</span>)}</div>
        <h3>{template.name}</h3><p>{template.description}</p><small>{template.category}</small>
        <div className={styles.cardFooter}><span>{template.estimatedSetupMinutes} {t("分钟设置", "min setup")}</span><span>{needsProvider ? t("需要模型", "Needs a model") : t("无需模型", "No model")}</span></div>
        <p className={feature?.available ? styles.connected : styles.dependency}>{!projectId ? t("运行能力：待选择项目", "Runtime: choose a project") : feature?.available ? t("原生处理器可用；来源覆盖在运行时逐项报告", "Native handler available; source coverage is reported per run") : feature?.reason ?? t("尚无原生能力就绪证据", "Native runtime readiness is not established")}</p>
        {missing.length > 0 && <p className={styles.dependency}>{t("需要连接：", "Needs connection: ")}{missing.join(", ")}</p>}
        <Button variant="outline" onClick={() => onSelect(template.id)}>{t("查看用途与设置", "View purpose and set up")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </article>;
    })}</div></section>)}
    <footer className={styles.provenance}><p>{pmAutomationCatalogSource.name} {pmAutomationCatalogSource.version} · {pmAutomationCatalogSource.runtime}</p></footer>
  </section>;
}
