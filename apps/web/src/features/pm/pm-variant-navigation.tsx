import { useNavigate } from "react-router"
import { useI18n } from "@/lib/i18n-provider"
import { Field } from "@/components/ui/field"
import { RadixSelect } from "@/components/ui/radix-select"

export function PmVariantSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const { locale } = useI18n()
  return (
    <Field
      label={locale === "en" ? "View" : "视图"}
      className="flex shrink-0 items-center gap-2 whitespace-nowrap"
    >
      {(control) => (
        <RadixSelect
          {...control}
          className="w-auto min-w-40 max-w-60"
          aria-label={locale === "en" ? "View variant" : "视图变体"}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </RadixSelect>
      )}
    </Field>
  )
}

export function PmVariantNavigation({
  baseHref,
  value,
  variants,
}: {
  baseHref: string
  value: string
  variants: readonly string[]
}) {
  const navigate = useNavigate()
  const { locale } = useI18n()
  const labels: Record<string, string> =
    locale === "en"
      ? {
          member1: "Member table",
          member2: "Member cards",
          member3: "People workspace",
          team1: "Team table",
          team2: "Team cards",
          team3: "Team workspace",
          inbox3: "Notification inbox",
          inbox4: "Notification collection",
          dashboard1: "Personal overview",
          dashboard2: "Project metrics",
          dashboard3: "Delivery console",
          dashboard4: "Dependency map",
        }
      : {
          member1: "成员表格",
          member2: "成员卡片",
          member3: "人员工作区",
          team1: "团队表格",
          team2: "团队卡片",
          team3: "团队工作区",
          inbox3: "通知收件箱",
          inbox4: "通知集合",
          dashboard1: "个人工作概览",
          dashboard2: "项目指标",
          dashboard3: "交付指挥台",
          dashboard4: "依赖地图",
        }
  return (
    <div className="shrink-0 border-b px-5 py-2">
      <PmVariantSelect
        value={value}
        options={variants.map((variant) => ({
          value: variant,
          label: labels[variant] ?? variant,
        }))}
        onChange={(variant) =>
          navigate(`${baseHref}?view=${encodeURIComponent(variant)}`)
        }
      />
    </div>
  )
}
