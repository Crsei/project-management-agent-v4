import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Popover } from "@base-ui/react/popover";
import { ChevronsUpDown, Keyboard, LoaderCircle, LogOut, Monitor, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useTheme } from "@/hooks/use-theme";
import { pmJson, usePmChatState } from "./state";
import styles from "../../../web/src/features/pm/service/pm-user-menu.module.css";

const THEMES = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

type UserMenuProps = { workspaceId?: string; canLeave: () => boolean; onShortcuts: () => void };

/** Same sidebar account layout as PM: avatar, name, chevron, identity card, theme and sign out. */
export function UserMenu({ workspaceId, canLeave, onShortcuts }: UserMenuProps) {
  const state = usePmChatState();
  const actor = state.identity?.actor;
  const { preference, setTheme } = useTheme();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<{ workspaceId: string; name: string; avatarDataUrl: string | null }>();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    if (!open || !workspaceId || profile?.workspaceId === workspaceId) return;
    let cancelled = false;
    void pmJson<{ profile: { name: string; avatarDataUrl: string | null } }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dashboard/personal`)
      .then((data) => { if (!cancelled) setProfile({ workspaceId, name: data.profile.name, avatarDataUrl: data.profile.avatarDataUrl }); })
      .catch(() => { /* The account identity remains usable without the optional profile card. */ });
    return () => { cancelled = true; };
  }, [open, workspaceId, profile?.workspaceId]);

  if (!actor) return null;

  const displayName = profile?.name ?? actor.name;
  const avatarDataUrl = profile?.avatarDataUrl ?? undefined;
  const avatarInitials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase() || "?";

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

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger
      className={`${styles.trigger} pm-agent-user-trigger`}
      aria-label="账户菜单"
      title="账户菜单"
    >
      <Avatar size="sm" className="pm-agent-user-avatar">
        {avatarDataUrl ? <AvatarImage src={avatarDataUrl} alt={displayName} /> : <AvatarFallback>{avatarInitials}</AvatarFallback>}
      </Avatar>
      <span className={styles.name}>{displayName}</span>
      <ChevronsUpDown className={`${styles.chevron} pm-agent-user-chevron`} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={8}>
        <Popover.Popup className={`${styles.card} pm-agent-user-card`}>
          <Popover.Title className="sr-only">账户菜单</Popover.Title>
          <div className={styles.identity}>
            <Avatar className={`${styles.identityAvatar} size-9`}>
              {avatarDataUrl ? <AvatarImage src={avatarDataUrl} alt={displayName} /> : <AvatarFallback>{avatarInitials}</AvatarFallback>}
            </Avatar>
            <div className={styles.identityText}>
              <span className={styles.displayName}>{displayName}</span>
              <span className={styles.email} title={actor.email}>{actor.email}</span>
            </div>
          </div>
          <div className={styles.separator} />
          <Popover.Close
            render={<Link to="/settings/general" state={{ settingsReturnTo: `/workspace${location.search}` }} className={styles.item} onClick={(event) => { if (!canLeave()) event.preventDefault(); }} />}
          >
            <SettingsIcon aria-hidden="true" />设置
          </Popover.Close>
          <Popover.Close render={<button type="button" className={styles.item} />} onClick={onShortcuts}>
            <Keyboard aria-hidden="true" />对话快捷键
          </Popover.Close>
          <div className={styles.separator} />
          <div className={styles.sectionLabel}>主题</div>
          <div className={styles.theme} role="radiogroup" aria-label="主题">
            {THEMES.map(({ value, label, icon: Icon }) => <button
              key={value}
              type="button"
              role="radio"
              aria-checked={preference === value}
              data-checked={preference === value || undefined}
              className={styles.themeItem}
              onClick={() => setTheme(value)}
            >
              <Icon aria-hidden="true" />{label}
            </button>)}
          </div>
          <div className={styles.separator} />
          <button type="button" className={styles.item} disabled={signingOut} onClick={() => { void signOut(); }}>
            {signingOut ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <LogOut aria-hidden="true" />}
            {signingOut ? "正在退出…" : "退出登录"}
          </button>
          {logoutError && <p role="alert" className={styles.error}>{logoutError}</p>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
