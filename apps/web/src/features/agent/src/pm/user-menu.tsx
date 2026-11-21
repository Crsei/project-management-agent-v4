import { useEffect, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { ChevronsUpDown, Keyboard, LoaderCircle, LogOut, Monitor, Moon, Settings as SettingsIcon, Sun, UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@agent/components/ui/avatar";
import { useTheme } from "@agent/hooks/use-theme";
import { useWorkspaceStore } from "@/providers/app-providers";
import { pmJson, refreshIdentity, usePmChatState } from "./state";
import { useAgentText } from "../i18n";
import styles from "@/features/pm/service/pm-user-menu.module.css";

const THEMES = [
  { value: "light", zh: "浅色", en: "Light", icon: Sun },
  { value: "dark", zh: "深色", en: "Dark", icon: Moon },
  { value: "system", zh: "跟随系统", en: "System", icon: Monitor },
] as const;

type UserMenuProps = { workspaceId?: string; canLeave: () => boolean };

/** Same sidebar account layout as PM: avatar, name, chevron, identity card, theme and sign out. */
export function UserMenu({ workspaceId, canLeave }: UserMenuProps) {
  const t = useAgentText();
  const state = usePmChatState();
  const actor = state.identity?.actor;
  const productWorkspaceId = useWorkspaceStore((workspace) => workspace.productWorkspaceId);
  const identityWorkspaceId = state.identity?.workspaces.length === 1 ? state.identity.workspaces[0].id : undefined;
  const menuWorkspaceId = workspaceId ?? (state.identity?.workspaces.some((workspace) => workspace.id === productWorkspaceId) ? productWorkspaceId ?? undefined : identityWorkspaceId);
  const { preference, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<{ workspaceId: string; name: string; avatarDataUrl: string | null }>();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => { if (open) void refreshIdentity(); }, [open]);
  useEffect(() => {
    if (!open || !menuWorkspaceId || profile?.workspaceId === menuWorkspaceId) return;
    let cancelled = false;
    void pmJson<{ profile: { name: string; avatarDataUrl: string | null } }>(`/api/v1/workspaces/${encodeURIComponent(menuWorkspaceId)}/dashboard/personal`)
      .then((data) => { if (!cancelled) setProfile({ workspaceId: menuWorkspaceId, name: data.profile.name, avatarDataUrl: data.profile.avatarDataUrl }); })
      .catch(() => { /* The account identity remains usable without the optional profile card. */ });
    return () => { cancelled = true; };
  }, [open, menuWorkspaceId, profile?.workspaceId]);


  const displayName = profile?.name ?? actor?.name ?? t("本机 Agent", "Local Agent");
  const avatarDataUrl = profile?.avatarDataUrl ?? undefined;
  const avatarInitials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase() || "?";
  const base = menuWorkspaceId ? `/pm/${encodeURIComponent(menuWorkspaceId)}` : null;
  const navigateAway = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!canLeave()) { event.preventDefault(); return; }
    setOpen(false);
  };

  const signOut = async () => {
    if (signingOut) return;
    setLogoutError("");
    setSigningOut(true);
    try {
      await pmJson("/api/v1/auth/logout", { method: "POST", body: "{}" });
      window.location.assign("/pm");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : String(error));
      setSigningOut(false);
    }
  };

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      className={`${styles.trigger} pm-agent-user-trigger`}
      aria-label={t("账户菜单", "Account menu")}
      title={t("账户菜单", "Account menu")}
    >
      <Avatar size="sm" className="pm-agent-user-avatar">
        {avatarDataUrl ? <AvatarImage src={avatarDataUrl} alt={displayName} /> : <AvatarFallback>{avatarInitials}</AvatarFallback>}
      </Avatar>
      <span className={styles.name}>{displayName}</span>
      <ChevronsUpDown className={`${styles.chevron} pm-agent-user-chevron`} aria-hidden="true" />
    </PopoverTrigger>
    <PopoverContent side="top" align="start" sideOffset={8} className={`${styles.card} pm-agent-user-card`}>
          <PopoverTitle className="sr-only">{t("账户菜单", "Account menu")}</PopoverTitle>
          <div className={styles.identity}>
            <Avatar className={`${styles.identityAvatar} size-9`}>
              {avatarDataUrl ? <AvatarImage src={avatarDataUrl} alt={displayName} /> : <AvatarFallback>{avatarInitials}</AvatarFallback>}
            </Avatar>
            <div className={styles.identityText}>
              <span className={styles.displayName}>{displayName}</span>
              {actor && <span className={styles.email} title={actor.email}>{actor.email}</span>}
            </div>
          </div>
          <div className={styles.separator} />
          {base && <>
            <Link className={styles.item} to={`${base}/members?tab=members&profile=me`} onClick={navigateAway}>
              <UserRound aria-hidden="true" />
              {t("查看个人资料", "View profile")}
            </Link>
            <Link className={styles.item} to={`${base}/onboarding`} onClick={navigateAway}>
              <UserRound aria-hidden="true" />
              {t("开始使用引导", "Getting started guide")}
            </Link>
          </>}
          <div className={styles.separator} />
          <Link className={styles.item} to="/pm/account/security" onClick={navigateAway}>
            <SettingsIcon aria-hidden="true" />
            {t("账号安全", "Account security")}
          </Link>
          <div className={styles.separator} />
          <div className={styles.sectionLabel}>{t("主题", "Theme")}</div>
          <Segmented className={styles.theme} value={preference} onValueChange={setTheme} aria-label={t("主题", "Theme")}>
            {THEMES.map(({ value, zh, en, icon: Icon }) => <SegmentedItem key={value} value={value} className={styles.themeItem}>
              <Icon aria-hidden="true" />{t(zh, en)}
            </SegmentedItem>)}
          </Segmented>
          {base && <>
            <div className={styles.separator} />
            <Link className={styles.item} to={`${base}/settings/shortcuts`} onClick={navigateAway}>
              <Keyboard aria-hidden="true" />
              {t("键盘快捷键", "Keyboard shortcuts")}
            </Link>
          </>}
          <div className={styles.separator} />
          {actor ? <button type="button" className={styles.item} disabled={signingOut} onClick={() => { if (canLeave()) void signOut(); }}>
            {signingOut ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <LogOut aria-hidden="true" />}
            {signingOut ? t("正在退出…", "Signing out…") : t("退出登录", "Sign out")}
          </button> : <Link className={styles.item} to="/pm" onClick={navigateAway}>{t("前往 PM 登录", "Sign in to PM")}</Link>}
          {logoutError && <p role="alert" className={styles.error}>{logoutError}</p>}
    </PopoverContent>
  </Popover>;
}
