import type { RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Camera,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Monitor,
  MousePointerClick,
  PictureInPicture2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentText } from "../../i18n";
import { isBrowserViewport, type BrowserViewport } from "./browser-history";

function viewportOptions(t: (zh: string, en: string) => string) {
  return [
    { value: "fit" as const, label: t("自适应", "Fit") },
    { value: "desktop" as const, label: t("桌面", "Desktop") },
    { value: "tablet" as const, label: t("平板（834）", "Tablet (834)") },
    { value: "mobile" as const, label: t("手机（390）", "Mobile (390)") },
  ];
}

export type BrowserChromeProps = {
  address: string;
  onAddressChange: (value: string) => void;
  onAddressSubmit: () => void;
  onAddressEscape: () => void;
  addressRef?: RefObject<HTMLInputElement | null>;
  addressInvalid?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  hasUrl: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenInNewTab: () => void;
  onCopyUrl: () => void;
  onClearRecents: () => void;
  hasRecents: boolean;
  viewport: BrowserViewport;
  onViewportChange: (viewport: BrowserViewport) => void;
  onPick?: () => void;
  pickActive?: boolean;
  pickDisabledReason?: string;
  onCapture?: () => void;
  captureBusy?: boolean;
  captureDisabledReason?: string;
  onTogglePiP?: () => void;
  pipOpen?: boolean;
  pipDisabledReason?: string;
  onDevTools?: () => void;
};

export function BrowserChrome(props: BrowserChromeProps) {
  const t = useAgentText();
  const desktopOnly = t("仅桌面版可用", "Available in the desktop app");
  const pickTitle = props.pickDisabledReason ?? (props.onPick ? t("选择页面元素并加入消息", "Pick an element and add it to the message") : desktopOnly);
  const captureTitle = props.captureDisabledReason ?? (props.onCapture ? t("截图并加入消息", "Capture a screenshot and add it to the message") : desktopOnly);
  const pipTitle = props.pipDisabledReason ?? (props.onTogglePiP ? (props.pipOpen ? t("关闭浮动预览", "Close floating preview") : t("浮动预览", "Float preview")) : desktopOnly);
  return <div className="inspector-browser-chrome-wrap">
    <form
      className="inspector-browser-chrome"
      aria-label={t("浏览器", "Browser")}
      onSubmit={(event) => { event.preventDefault(); props.onAddressSubmit(); }}
    >
      <div className="inspector-browser-nav" role="group" aria-label={t("导航", "Navigation")}>
        <button type="button" className="inspector-browser-action" aria-label={t("后退", "Back")} title={t("后退", "Back")} disabled={!props.canGoBack} onClick={props.onBack}><ArrowLeft /></button>
        <button type="button" className="inspector-browser-action" aria-label={t("前进", "Forward")} title={t("前进", "Forward")} disabled={!props.canGoForward} onClick={props.onForward}><ArrowRight /></button>
        <button type="button" className="inspector-browser-action" aria-label={props.loading ? t("正在加载", "Loading") : t("刷新", "Reload")} title={props.loading ? t("正在加载", "Loading") : t("刷新", "Reload")} disabled={!props.hasUrl} onClick={props.onReload}><RefreshCw className={props.loading ? "animate-spin" : undefined} /></button>
      </div>
      <label className="inspector-browser-address-wrap">
        <span className="sr-only">{t("地址栏", "Address bar")}</span>
        <input
          ref={props.addressRef}
          className="inspector-browser-address"
          value={props.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            props.onAddressEscape();
            event.currentTarget.blur();
          }}
          placeholder={t("搜索或输入网址", "Search or enter URL")}
          aria-label={t("地址栏", "Address bar")}
          aria-invalid={props.addressInvalid || undefined}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button type="button" className="inspector-browser-action" data-active={props.pickActive || undefined} aria-label={t("选择页面元素", "Pick an element")} aria-pressed={props.pickActive} title={pickTitle} disabled={!props.onPick || props.pickActive} onClick={props.onPick}><MousePointerClick /></button>
      <button type="button" className="inspector-browser-action" aria-label={t("截图", "Capture screenshot")} title={captureTitle} disabled={!props.onCapture || props.captureBusy} onClick={props.onCapture}><Camera /></button>
      <button type="button" className="inspector-browser-action" data-active={props.pipOpen || undefined} aria-label={t("浮动预览", "Float preview")} aria-pressed={props.pipOpen} title={pipTitle} disabled={!props.onTogglePiP} onClick={props.onTogglePiP}><PictureInPicture2 /></button>
      <DropdownMenu>
        <DropdownMenuTrigger className="inspector-browser-action" aria-label={t("浏览器菜单", "Browser menu")} title={t("浏览器菜单", "Browser menu")}><EllipsisVertical /></DropdownMenuTrigger>
        <DropdownMenuContent className="inspector-browser-menu" align="end" side="bottom" sideOffset={12}>
          <DropdownMenuLabel className="pm-right-panel-menu-label">{t("浏览器", "Browser")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!props.hasUrl} onSelect={props.onOpenInNewTab}><ExternalLink />{t("在新标签打开", "Open in new tab")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!props.hasUrl} onSelect={props.onCopyUrl}><Copy />{t("复制网址", "Copy URL")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Monitor />{t("视口", "Viewport")}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={props.viewport} onValueChange={(value) => { if (isBrowserViewport(value)) props.onViewportChange(value); }}>
                {viewportOptions(t).map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {props.onDevTools ? <DropdownMenuItem disabled={!props.hasUrl} onSelect={props.onDevTools}><Bug />{t("打开开发者工具", "Open developer tools")}</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!props.hasRecents} onSelect={props.onClearRecents}><Trash2 />{t("清空最近记录", "Clear recent history")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </form>
    {props.loading && <span className="inspector-browser-progress" role="progressbar" aria-label={t("页面正在加载", "Page loading")} />}
  </div>;
}
