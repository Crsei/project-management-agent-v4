import type { AnchorHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { LayoutGrid, MessageSquare } from "lucide-react";
import type { ComposerHost } from "@easyuse-ui/agent-workspace-views/composer";
import { useShowcasePreferences } from "./preferences";
import { pages } from "./catalog";

function HostLink({
  href,
  prefetch: _prefetch,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: false }) {
  return <Link to={href} {...props} />;
}

export function useComposerShowcaseHost(pageId: string): ComposerHost {
  const { theme, setTheme } = useShowcasePreferences();
  return {
    Link: HostLink,
    navigation: [
      {
        title: { "zh-CN": "工作区", en: "Workspace" },
        items: [
          {
            href: "/workspace",
            label: { "zh-CN": "真实 AI 对话", en: "Live AI chat" },
            icon: MessageSquare,
          },
          {
            href: "/showcase",
            label: { "zh-CN": "页面目录", en: "Page directory" },
            icon: LayoutGrid,
          },
        ],
      },
      ...Array.from(new Set(pages.filter((page) => !page.deferred).map((page) => page.group))).map(
        (group) => ({
          title: { "zh-CN": group, en: group },
          items: pages
            .filter((page) => page.group === group && !page.deferred)
            .map((page) => ({
              href: `/showcase/${page.id}`,
              label: page.title,
              icon: MessageSquare,
              active: pageId === page.id,
            })),
        }),
      ),
    ],
    homeHref: "/showcase",
    componentsHref: "/showcase",
    referenceHref: "/showcase",
    resolvedTheme: theme,
    setTheme,
  };
}
