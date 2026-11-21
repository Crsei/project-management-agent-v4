import { useWorkspaceStore } from "@/providers/app-providers"
import { RadixSelect } from "@/components/ui/radix-select"
import { useText } from "../pm-ui"

export function FontPreferenceControl({ id, describedBy }: { id: string; describedBy?: string | undefined }) {
  const t = useText()
  const font = useWorkspaceStore((state) => state.font)
  const setPreferences = useWorkspaceStore((state) => state.setPreferences)
  return <div className="space-y-2">
    <RadixSelect id={id} value={font} aria-describedby={[describedBy, `${id}-font-hint`].filter(Boolean).join(" ")} onChange={(event) => {
      const value = event.target.value
      if (value === "inter" || value === "system") setPreferences({ font: value })
    }}>
      <option value="inter">Inter</option>
      <option value="system">{t("系统字体", "System font")}</option>
    </RadixSelect>
    <p id={`${id}-font-hint`} className="text-sm leading-6 text-muted-foreground">{t("Inter 使用内置字体；系统字体使用操作系统 UI 字体。", "Inter uses the bundled font; System uses the operating-system UI font.")}</p>
  </div>
}
