"use client";
import { Link } from "react-router-dom";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Boxes,
  FlaskConical,
  Menu,
  Moon,
  PanelLeft,
  RotateCcw,
  Sun,
} from "lucide-react";
import { Button } from "@easyuse-ui/ui/components/ui/button";
import { ThemeBoundary } from "@easyuse-ui/ui/components/ui/theme-boundary";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@easyuse-ui/ui/lib/i18n-provider";
import { apScenarios, type ApScenario } from "@easyuse-ui/agent-workspace-views/api-platform/model";
import { useShowcasePreferences } from "../preferences";
import { apShowcases, type ApPageId } from "./api-platform-catalog";
import styles from "./api-platform-chrome.module.css";

export function ApiPlatformChrome({
  pageId,
  scenario,
  onScenario,
  onReset,
  children,
}: {
  pageId: ApPageId;
  scenario: ApScenario;
  onScenario: (scenario: ApScenario) => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const { locale } = useI18n(),
    en = locale === "en";
  const { setLocale, theme, setTheme } = useShowcasePreferences();
  const [collapsed, setCollapsed] = useState(false);
  const page = apShowcases.find((item) => item.id === pageId)!;
  const reference = ![
    "model-catalog",
    "model-detail",
    "model-pricing",
    "model-benchmarks",
  ].includes(pageId);
  return (
    <ThemeBoundary
      mode="host"
      className={styles.shell}
      data-ap-explorer
      data-ap-reference={reference ? "true" : undefined}
    >
      <aside
        className={styles.sidebar}
        style={{ width: collapsed ? 56 : 256 }}
        data-ap-navigation
        aria-label={en ? "API Platform navigation" : "API 平台导航"}
      >
        <div className={styles.brand}>
          <Link
            to="/agent/showcase"
            className={styles.brandLink}
            aria-label={collapsed ? `EasyuseUI · ${en ? "Page directory" : "页面目录"}` : undefined}
          >
            <Boxes size={20} aria-hidden="true" />
            {!collapsed && (
              <span>
                EasyuseUI
                <span className={styles.brandSubtitle}>API Platform · UI Lab</span>
              </span>
            )}
          </Link>
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={en ? "Collapse sidebar" : "收起侧栏"}
              onClick={() => setCollapsed(true)}
            >
              <PanelLeft size={16} />
            </Button>
          )}
        </div>
        <div className={styles.navigation}>
          {!collapsed && (
            <>
              <Link to="/agent/showcase" className={styles.directory}>
                <ArrowLeft size={14} aria-hidden="true" />
                {en ? "Page directory" : "页面目录"}
              </Link>
              <p className={styles.groupTitle}>API Platform</p>
            </>
          )}
          <nav aria-label={en ? "API Platform pages" : "API 平台页面"}>
            {apShowcases.map((item) => (
              <Link
                key={item.id}
                to={item.href}
                title={item.title[locale]}
                aria-label={collapsed ? item.title[locale] : undefined}
                aria-current={item.id === pageId ? "page" : undefined}
                className={styles.navLink}
              >
                <Boxes size={16} aria-hidden="true" />
                {!collapsed && <span>{item.title[locale]}</span>}
              </Link>
            ))}
          </nav>
        </div>
        {!collapsed && (
          <div className={styles.identity}>
            <span className={styles.avatar}>AM</span>
            <div>
              <strong>Alex Morgan</strong>
              <p>{en ? "Local fixture workspace" : "本地场景工作区"}</p>
            </div>
          </div>
        )}
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar} data-ap-workspace-header>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={en ? "Toggle sidebar" : "切换侧栏"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Menu size={16} />
          </Button>
          <span className={styles.pageTitle}>{page.title[locale]}</span>
          <div className={styles.tools}>
            <span className={styles.fixtureLabel}>{en ? "Demo workspace" : "演示工作区"}</span>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={en ? "Scenario explorer" : "场景浏览器"}
                  />
                }
              >
                <FlaskConical size={16} />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-64 p-3"
                aria-label={en ? "Local fixture scenarios" : "本地场景"}
              >
                <p className="mb-2 text-sm font-medium">
                  {en ? "Local fixture scenarios" : "本地场景"}
                </p>
                <div
                  className="grid gap-1"
                  role="group"
                  aria-label={en ? "Test scenarios" : "测试场景"}
                >
                  {apScenarios.map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      aria-pressed={scenario === item.id}
                      onClick={() => onScenario(item.id)}
                    >
                      {item.name[locale]}
                    </Button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {en
                    ? "Changes stay in each scenario. No service writes."
                    : "各场景保留编辑，不写入服务。"}
                </p>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={en ? "Reset scenario" : "重置当前场景"}
              onClick={onReset}
            >
              <RotateCcw size={16} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLocale(en ? "zh-CN" : "en")}>
              {en ? "中文" : "English"}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={en ? "Toggle preview theme" : "切换预览主题"}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
            </Button>
          </div>
        </header>
        <div className={styles.content} data-scenario={scenario}>
          {children}
        </div>
      </div>
    </ThemeBoundary>
  );
}
