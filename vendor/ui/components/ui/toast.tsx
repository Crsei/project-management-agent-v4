"use client"
import { Toast as Base } from "@base-ui/react/toast"
import { useI18n } from "../../lib/i18n-provider"
import { cn } from "../../lib/utils"
import { useThemePortalContainer } from "./theme-boundary"
import { Button } from "./button"
export const ToastProvider = Base.Provider
export const useToastManager = Base.useToastManager
export const createToastManager = Base.createToastManager
export type ToasterProps = { className?: string; label?: string }
/** One viewport per provider. Notifications do not confirm runtime outcomes. */
export function Toaster({ className, label }: ToasterProps) {
  const { t } = useI18n()
  const { toasts } = Base.useToastManager()
  const container = useThemePortalContainer()
  return (
    <Base.Portal container={container}>
      <Base.Viewport
        aria-label={label ?? t("feedback.notifications")}
        className={cn(
          "fixed bottom-4 right-4 z-[100] flex max-h-[calc(100dvh-2rem)] w-[min(360px,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto outline-none",
          className,
        )}
      >
        {toasts.map((toast) => (
          <Base.Root
            key={toast.id}
            toast={toast}
            swipeDirection={["right", "down"]}
            className="relative grid gap-2 rounded-panel border bg-surface p-3 text-foreground shadow-[var(--shadow-floating)] data-limited:hidden"
          >
            <Base.Content className="grid gap-1 pr-8">
              <Base.Title className="text-sm font-medium" />
              <Base.Description className="text-[13px] leading-5 text-muted-foreground" />
              {toast.actionProps && (
                <Base.Action
                  {...toast.actionProps}
                  render={<Button variant="secondary" />}
                />
              )}
            </Base.Content>
            <Base.Close
              aria-hidden={false}
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("feedback.close")}
                />
              }
              className="absolute right-1 top-1"
            >
              ×
            </Base.Close>
          </Base.Root>
        ))}
      </Base.Viewport>
    </Base.Portal>
  )
}
