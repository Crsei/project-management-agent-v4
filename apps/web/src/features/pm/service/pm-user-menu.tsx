import { useState } from "react"
import { Link, useNavigate } from "react-router"
import {
  ChevronsUpDown,
  Keyboard,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  UserRound,
} from "lucide-react"
import { Avatar } from "@/components/ui/avatar"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Segmented, SegmentedItem } from "@/components/ui/segmented"
import { useI18n } from "@/lib/i18n-provider"
import { useWorkspaceStore } from "@/providers/app-providers"
import { useText } from "./pm-ui"
import { pmErrorMessage, usePersonalDashboard, usePmService } from "./pm-service"
import styles from "./pm-user-menu.module.css"

/**
 * Sidebar account menu. The personal dashboard query stays disabled until the
 * card is first opened; after that its cached profile feeds both the card and
 * the trigger without another request.
 */
export function PmUserMenu() {
  const { actor, workspace, logout } = usePmService()
  const navigate = useNavigate()
  const { locale } = useI18n()
  const t = useText()
  const theme = useWorkspaceStore((state) => state.theme)
  const setTheme = useWorkspaceStore((state) => state.setTheme)
  const [open, setOpen] = useState(false)
  const [openedOnce, setOpenedOnce] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState("")
  const personal = usePersonalDashboard(openedOnce)

  if (!actor) return null

  const displayName = personal.data?.profile.name ?? actor.name
  const avatarDataUrl = personal.data?.profile.avatarDataUrl ?? undefined
  const base = workspace ? `/pm/${encodeURIComponent(workspace.id)}` : null

  const signOut = async () => {
    if (signingOut) return
    setLogoutError("")
    setSigningOut(true)
    try {
      await logout()
      navigate("/pm")
    } catch (error) {
      setLogoutError(pmErrorMessage(error, locale === "en" ? "en" : "zh"))
      setSigningOut(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setOpenedOnce(true)
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={styles.trigger}
            aria-label={t("账户菜单", "Account menu")}
            title={t("账户菜单", "Account menu")}
          />
        }
      >
        <Avatar name={displayName} src={avatarDataUrl} size={24} />
        <span className={styles.name}>{displayName}</span>
        <ChevronsUpDown className={styles.chevron} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className={styles.card}
      >
        <PopoverTitle className="sr-only">
          {t("账户菜单", "Account menu")}
        </PopoverTitle>
        <div className={styles.identity}>
          <Avatar
            name={displayName}
            src={avatarDataUrl}
            size={36}
            className={styles.identityAvatar}
          />
          <div className={styles.identityText}>
            <span className={styles.displayName}>{displayName}</span>
            <span className={styles.email} title={actor.email}>
              {actor.email}
            </span>
          </div>
        </div>
        {base && (
          <>
            <div className={styles.separator} />
            <PopoverClose
              render={
                <Link
                  to={`${base}/members?tab=members&profile=me`}
                  data-navigation-close
                  className={styles.item}
                />
              }
            >
              <UserRound aria-hidden="true" />
              {t("查看个人资料", "View profile")}
            </PopoverClose>
            <PopoverClose
              render={
                <Link
                  to="/pm/account/security"
                  data-navigation-close
                  className={styles.item}
                />
              }
            >
              <SettingsIcon aria-hidden="true" />
              {t("账号安全", "Account security")}
            </PopoverClose>
          </>
        )}
        <div className={styles.separator} />
        <div className={styles.sectionLabel}>{t("主题", "Theme")}</div>
        <Segmented
          className={styles.theme}
          value={theme}
          onValueChange={setTheme}
          aria-label={t("主题", "Theme")}
        >
          <SegmentedItem value="light" className={styles.themeItem}>
            <Sun aria-hidden="true" />
            {t("浅色", "Light")}
          </SegmentedItem>
          <SegmentedItem value="dark" className={styles.themeItem}>
            <Moon aria-hidden="true" />
            {t("深色", "Dark")}
          </SegmentedItem>
          <SegmentedItem value="system" className={styles.themeItem}>
            <Monitor aria-hidden="true" />
            {t("跟随系统", "System")}
          </SegmentedItem>
        </Segmented>
        {base && (
          <>
            <div className={styles.separator} />
            <PopoverClose
              render={
                <Link
                  to={`${base}/settings/shortcuts`}
                  data-navigation-close
                  className={styles.item}
                />
              }
            >
              <Keyboard aria-hidden="true" />
              {t("键盘快捷键", "Keyboard shortcuts")}
            </PopoverClose>
          </>
        )}
        <div className={styles.separator} />
        <button
          type="button"
          className={styles.item}
          disabled={signingOut}
          onClick={() => {
            void signOut()
          }}
        >
          {signingOut ? (
            <LoaderCircle className={styles.spinner} aria-hidden="true" />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          {signingOut ? t("正在退出…", "Signing out…") : t("退出登录", "Sign out")}
        </button>
        {logoutError && (
          <p role="alert" className={styles.error}>
            {logoutError}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
