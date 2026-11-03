import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ConversationSurface } from "@easyuse-ui/agent-workspace-views/conversations/surface";
import { pages } from "./catalog";
import { ShowcasePreferences, useShowcasePreferences } from "./preferences";
import { Provider as BusinessProvider } from "./business";
import { Provider as PlatformProvider } from "./platform";
import "./showcase.css";
import { RadixSelect } from "@/components/ui/radix-select"

class PageBoundary extends Component<
  { children: ReactNode; locale: "en" | "zh-CN" },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <section className="showcase-notice" role="alert">
        <h1>{this.props.locale === "en" ? "Page failed to load" : "页面加载失败"}</h1>
        <p>{this.state.error.message}</p>
        <button onClick={() => location.reload()}>
          {this.props.locale === "en" ? "Reload" : "重新加载"}
        </button>
        <Link to="/agent/showcase">{this.props.locale === "en" ? "Back to directory" : "返回目录"}</Link>
      </section>
    ) : (
      this.props.children
    );
  }
}

function ShowcaseContent() {
  const { pathname } = useLocation();
  const [query, setQuery] = useSearchParams();
  const { locale, setLocale, theme, setTheme } = useShowcasePreferences();
  const id = pathname.replace(/^\/agent\/showcase\/?/, "").replace(/\/$/, "");
  const page = pages.find((entry) => entry.id === id);
  const scenario = query.get("scenario") ?? page?.scenarios[0]?.id;
  const invalid =
    Boolean(id && (!page || !page.scenarios.some((item) => item.id === scenario))) ||
    query.getAll("scenario").length > 1 ||
    (id === "model-detail" && query.getAll("model").length > 1);
  useEffect(() => {
    document.title = page
      ? `${page.title[locale]} · Agent Workspace`
      : "页面目录 · Agent Workspace";
  }, [page, locale]);
  const [search, setSearch] = useState(() => query.get("q") ?? "");
  const group = query.get("group") ?? "";
  const listed = pages.filter((entry) => !entry.deferred);
  const visible = listed.filter(
    (entry) =>
      (!group || entry.group === group) &&
      `${entry.title["zh-CN"]} ${entry.title.en} ${entry.description[locale]} ${entry.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="showcase-app">
      <header className="showcase-topbar">
        <Link to="/agent/workspace">{locale === "en" ? "Live AI chat" : "真实 AI 对话"}</Link>
        <Link to="/agent/showcase">{locale === "en" ? "Page directory" : "页面目录"}</Link>
        <span className="showcase-disclosure">
          {locale === "en"
            ? "Local fixtures · no provider or business writes"
            : "本地交互场景 · 不调用 Provider，不写入业务服务"}
        </span>
        <button onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}>
          {locale === "en" ? "中文" : "English"}
        </button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {locale === "en"
            ? theme === "dark"
              ? "Light"
              : "Dark"
            : theme === "dark"
              ? "浅色"
              : "深色"}
        </button>
      </header>
      {invalid ? (
        <section className="showcase-notice">
          <h1>{locale === "en" ? "404 · Page or scenario not found" : "404 · 页面或场景不存在"}</h1>
          <p>
            {locale === "en"
              ? "Choose a page and a supported scenario from the directory."
              : "请从目录选择页面及其支持的场景。"}
          </p>
          <Link to="/agent/showcase">{locale === "en" ? "Back to directory" : "返回目录"}</Link>
        </section>
      ) : page && scenario ? (
        <PageBoundary key={id} locale={locale}>
          <Suspense
            fallback={
              <p role="status" className="showcase-notice">
                {locale === "en" ? "Loading page…" : "正在加载页面…"}
              </p>
            }
          >
            <div className="showcase-page" data-showcase-page={id}>
              {page.deferred && (
                <p className="showcase-deferred">
                  {locale === "en"
                    ? "Deferred example: direct access only, excluded from the directory."
                    : "延期示例：保留直接访问，不纳入正式目录。"}
                </p>
              )}
              {page.group === "Conversations" ? (
                <ConversationSurface>
                  <page.Component scenario={scenario} />
                </ConversationSurface>
              ) : (
                <page.Component scenario={scenario} />
              )}
            </div>
          </Suspense>
        </PageBoundary>
      ) : (
        <main className="showcase-directory">
          <h1>{locale === "en" ? "Workspace component showcase" : "工作台组件与页面展示"}</h1>
          <p>
            {locale === "en"
              ? `${listed.length} pages · Composers, Conversations, business workspaces and API Platform. All showcase actions use local fixtures; open Live AI chat for real model requests.`
              : `${listed.length} 个页面 · Composer、Conversation、业务工作区与 API Platform。所有展示操作使用本地固定数据；真实模型请求请进入 AI 对话。`}
          </p>
          <div className="showcase-filters">
            <label>
              {locale === "en" ? "Search pages" : "搜索页面"}
              <input
                type="search"
                value={search}
                placeholder={
                  locale === "en" ? "Search name, purpose or route" : "搜索名称、用途或路由"
                }
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              {locale === "en" ? "Page group" : "页面分组"}
              <RadixSelect
                value={group}
                onChange={(event) =>
                  setQuery(
                    (previous) => {
                      previous.set("group", event.target.value);
                      return previous;
                    },
                    { replace: true },
                  )
                }
              >
                <option value="">{locale === "en" ? "All groups" : "全部分组"}</option>
                {Array.from(new Set(listed.map((entry) => entry.group))).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </RadixSelect>
            </label>
            <span role="status">
              {visible.length} {locale === "en" ? "results" : "个结果"}
            </span>
          </div>
          {visible.length === 0 ? (
            <p>
              {locale === "en"
                ? "No matching pages. Change your search or group."
                : "没有匹配页面，请调整搜索或分组。"}
            </p>
          ) : (
            <div className="showcase-grid">
              {visible.map((entry) => (
                <Link className="showcase-card" key={entry.id} to={`/agent/showcase/${entry.id}`}>
                  <small>
                    {entry.group} · {entry.scenarios.length}{" "}
                    {locale === "en" ? "scenarios" : "场景"}
                  </small>
                  <h2>{entry.title[locale]}</h2>
                  <p>{entry.description[locale]}</p>
                  <code>/showcase/{entry.id}</code>
                </Link>
              ))}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

export default function ShowcaseApp() {
  return (
    <ShowcasePreferences>
      <BusinessProvider>
        <PlatformProvider>
          <ShowcaseContent />
        </PlatformProvider>
      </BusinessProvider>
    </ShowcasePreferences>
  );
}
