import { useMemo, useState } from "react";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { automationCatalog, automationCatalogSource, automationTemplateMaturity, automationTemplateRecommended, automationTemplateSource, automationTemplateTags, automationTemplateTriggers } from "../../../../../../../../packages/contracts/src/automation-catalog";
import { StudioClient } from "../../../../../../../../packages/contracts/src/automation-studio-client";
import { isPmAutomationTemplateId } from "../../../../../../../../packages/contracts/src/automation-pm";
import { pmAutomationCatalogSource, pmAutomationTemplateRequiresProvider } from "../../../../../../../../packages/contracts/src/automation-pm-catalog";
import { useAgentText } from "../../i18n";
import type { StudioAssistCallback } from "./studio-editor";
import { useStudioConnections } from "./studio-setup-dependencies";
import { studioConnectionSupportsAction } from "./studio-setup";
import { useAutomationQuery } from "./query";
import { filterStudioTemplates } from "./studio-template-catalog";
import styles from "./studio-setup.module.css";
import { RadixSelect } from "@/components/ui/radix-select"

type Props = { workspaceId: string; projectId?: string; onSelect: (templateId: string) => void; onAssist?: StudioAssistCallback; onIntegrations?: () => void };
export function StudioTemplates({ workspaceId, projectId, onSelect, onIntegrations }: Props) {
  const t = useAgentText();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("");
  const [integration, setIntegration] = useState("");
  const [trigger, setTrigger] = useState("");
  const api = useMemo(() => new StudioClient(workspaceId), [workspaceId]);
  const capabilities = useAutomationQuery(`template-capabilities:${workspaceId}:${projectId ?? ""}`, signal => api.capabilities(projectId!, { actionKind: "template", signal }), Boolean(projectId));
  const { connections, error, loading, refresh } = useStudioConnections(workspaceId, projectId);
  const verifiedByTemplate = new Map(automationCatalog.map(template => [template.id, new Set(connections.filter(connection => studioConnectionSupportsAction(connection, template.setup?.bundle || template.setup?.native ? "template" : "prompt")).map(connection => connection.provider as string))]));
  const tags = [...new Set(automationCatalog.flatMap(automationTemplateTags))].sort();
  const categories = [...new Set(automationCatalog.filter(template => !source || automationTemplateSource(template) === source).map(template => template.category))].sort();
  const matched = filterStudioTemplates(automationCatalog, { query, source, category, integration, trigger });
  const suggestedIds = new Set(automationCatalog.filter(template => automationTemplateRecommended(template) || automationTemplateTags(template).some(id => verifiedByTemplate.get(template.id)?.has(id))).map(template => template.id));
  const sections = [{ name: t("推荐", "Suggested"), items: matched.filter(template => suggestedIds.has(template.id)) }, { name: t("更多模板", "More templates"), items: matched.filter(template => !suggestedIds.has(template.id)) }];
  function clear() { setQuery(""); setSource(""); setCategory(""); setIntegration(""); setTrigger(""); }
  return <section className={styles.templates} aria-label={t("自动化模板", "Automation templates")}>
    <header className={styles.heading}><div><h1>{t("模板", "Templates")}</h1><p>{t("浏览 OpenHands 来源模板与 PM 原生只读分析，再明确配置与试运行。仅浏览不会创建会话、保存定义或运行。", "Browse OpenHands templates and PM-native read-only analysis before explicitly configuring or testing. Browsing never creates a conversation, saves a definition, or starts a run.")}</p></div></header>
    <div className={styles.search}><Search size={16} aria-hidden="true" /><Input aria-label={t("搜索模板", "Search templates")} placeholder={t("搜索模板…", "Search templates…")} value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className={styles.filters}><label>{t("来源", "Source")}<RadixSelect value={source} onChange={event => { setSource(event.target.value); setCategory(""); }}><option value="">{t("所有来源", "All sources")}</option><option value="openhands">OpenHands</option><option value="pm">{t("PM 原生", "PM native")}</option></RadixSelect></label><label>{t("分类", "Category")}<RadixSelect value={category} onChange={event => setCategory(event.target.value)}><option value="">{t("所有分类", "All categories")}</option>{categories.map(id => <option value={id} key={id}>{id}</option>)}</RadixSelect></label><label>{t("连接器", "Integration")}<RadixSelect value={integration} onChange={event => setIntegration(event.target.value)}><option value="">{t("所有连接器", "All integrations")}</option>{tags.map(id => <option value={id} key={id}>{id}</option>)}</RadixSelect></label><label>{t("触发", "Trigger")}<RadixSelect value={trigger} onChange={event => setTrigger(event.target.value)}><option value="">{t("所有触发", "All triggers")}</option><option value="manual">{t("手动", "Manual")}</option><option value="cron">Cron</option><option value="event">Event</option></RadixSelect></label>{(query || source || category || integration || trigger) && <Button variant="ghost" onClick={clear}>{t("清除", "Clear")}</Button>}<span>{matched.length} / {automationCatalog.length}</span></div>
    <div className={styles.connectionNotice}>{!projectId ? t("选择项目后可读取真实运行能力与连接状态。", "Choose a project to read actual runtime capabilities and connections.") : loading || capabilities.loading ? t("读取能力与连接状态…", "Loading capabilities and connections…") : t("PM 来源不要求外部连接；语义模板另需明确的只读 Provider。外部仓库来源需单独验证 API。读取状态不探测外部服务。", "PM-only sources require no external connection; semantic templates also require an explicit read-only Provider. External repository sources need separately verified API access. Reading status does not probe external services.")}<Button size="sm" variant="ghost" onClick={() => { refresh(); capabilities.refetch(); }} disabled={!projectId || loading || capabilities.loading}>{t("刷新", "Refresh")}</Button>{onIntegrations && <Button size="sm" variant="ghost" onClick={onIntegrations}>{t("管理连接", "Manage integrations")}</Button>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!!capabilities.error && <p className={styles.error} role="alert">{t("运行能力读取失败；未假定 Provider 或来源已就绪。", "Could not read runtime capabilities; Provider and source readiness are not assumed.")}</p>}
    {!matched.length && <div className={styles.empty}><Search size={28} /><h2>{t("没有匹配的模板", "No matching templates")}</h2><Button variant="outline" onClick={clear}>{t("清除搜索与筛选", "Clear search and filters")}</Button></div>}
    {sections.filter(section => section.items.length > 0).map(section => <section key={section.name} className={styles.catalogSection}><h2><Sparkles size={16} aria-hidden="true" />{section.name}<span>{section.items.length}</span></h2><div className={styles.catalogGrid}>{section.items.map(template => {
      const required = [...new Set([...Object.entries(template.requires.integrations).filter(([, requirement]) => requirement.required !== false).map(([id]) => id), ...(template.setup?.bundle ? automationTemplateTags(template) : [])])];
      const verified = verifiedByTemplate.get(template.id)!;
      const missing = required.filter(id => !verified.has(id));
      const mode = template.setup?.mode ?? "launch";
      const pmTemplateId = isPmAutomationTemplateId(template.id) ? template.id : null;
      const feature = capabilities.data?.features?.find(item => item.id === `template:${template.id}`);
      return <article key={template.id} className={styles.templateCard}>
        <div className={styles.tags}><span>{automationTemplateSource(template) === "pm" ? t("PM 原生", "PM native") : "OpenHands"}</span>{template.scenario && <span>#{template.scenario}</span>}{automationTemplateTags(template).map(id => <span key={id} title={verified.has(id) ? template.setup?.bundle ? t("已验证原生 API 访问", "Verified native API access") : t("已验证 MCP 访问", "Verified MCP access") : t("此执行类型尚未验证", "Not verified for this execution type")} className={verified.has(id) ? styles.connected : undefined}>{id}</span>)}{automationTemplateMaturity(template) === "beta" && <span>Beta</span>}{automationTemplateTriggers(template).map(kind => <span key={kind}>{kind === "manual" ? t("手动", "Manual") : kind === "cron" ? "Cron" : "Event"}</span>)}</div>
        <h3>{template.name}</h3><p>{template.description}</p><small>{template.category}</small><div className={styles.cardFooter}><span>{template.estimatedSetupMinutes} {t("分钟设置", "min setup")}</span><span>{mode === "direct" ? t("直接配置", "Direct setup") : mode === "assisted" ? t("辅助配置", "Assisted setup") : t("对话引导", "Launch prompt")}</span></div>
        {pmTemplateId && <><p>{pmAutomationTemplateRequiresProvider(pmTemplateId) ? t("模型：需明确选择支持无工具只读分析的 Provider", "Model: explicitly select a Provider supporting no-tools read-only analysis") : t("模型：不需要，使用真实来源的确定性检查", "Model: not required; deterministic checks use real source facts")}</p><p className={feature?.available ? styles.connected : styles.dependency}>{!projectId ? t("运行能力：待选择项目", "Runtime: choose a project") : feature?.available ? t("原生处理器可用；来源覆盖在运行时逐项报告", "Native handler available; source coverage is reported per run") : feature?.reason ?? t("尚无原生能力就绪证据", "Native runtime readiness is not established")}</p></>}
        {missing.length > 0 && <p className={styles.dependency}>{t("需要连接：", "Needs connection: ")}{missing.join(", ")}</p>}<Button variant="outline" onClick={() => onSelect(template.id)}>{t("查看与设置", "View and set up")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </article>;
    })}</div></section>)}
    <footer className={styles.provenance}><p>OpenHands Agent Canvas {automationCatalogSource.agentCanvasVersion} · extensions {automationCatalogSource.extensionsVersion} · MIT · {automationCatalogSource.commit.slice(0, 12)}</p><p>{pmAutomationCatalogSource.name} {pmAutomationCatalogSource.version} · agent-pm-studio · {pmAutomationCatalogSource.runtime}</p></footer>
  </section>;
}
