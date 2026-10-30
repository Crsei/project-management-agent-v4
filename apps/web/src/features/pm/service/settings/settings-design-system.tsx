import { useId, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Command } from "cmdk"
import {
  Activity, Archive, ArrowDownUp, AtSign, Bell, CalendarDays, ChartGantt,
  Check, ChevronRight, CircleAlert, CircleCheck, Copy, Ellipsis, Eye,
  FolderKanban, GitBranch, House, Inbox, Info, LayoutGrid, Link as LinkIcon,
  List, ListChecks, ListFilter, Lock, MessageSquare, Monitor, Moon,
  Paperclip, Pencil, Plus, Repeat, Rows3, Search, Settings, Share2,
  Star, Sun, Table2, Tag, Timer, Trash2, TriangleAlert, Upload, Users, X,
} from "lucide-react"
import { WorkItemCard, WorkItemRow, WorkItemPriorityGlyph, WorkItemStateGlyph } from "@/components/blocks/work-item"
import { AvatarGroup, WorkItemLabelPicker, WorkItemStatePicker } from "@/components/blocks/work-item-properties"
import { Alert } from "@/components/ui/alert"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Avatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Segmented, SegmentedItem } from "@/components/ui/segmented"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkItemCatalog, WorkItemRecord } from "@/lib/work-items-model"
import { useWorkspaceStore } from "@/providers/app-providers"
import { RichTextEditor } from "../../components/rich-text-editor"
import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection } from "./settings-shared"
import styles from "./settings-design-system.module.css"

function GallerySection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId()
  return <section aria-labelledby={id} className={styles.section}>
    <div className={styles.sectionHeading}><h3 id={id}>{title}</h3>{description && <p>{description}</p>}</div>
    {children}
  </section>
}

function useExampleCatalog(): WorkItemCatalog {
  const t = useText()
  return {
    states: [
      { id: "draft", label: t("草稿", "Draft"), category: "backlog", color: "var(--text-muted)" },
      { id: "ready", label: t("就绪", "Ready"), category: "unstarted", color: "var(--text-secondary)" },
      { id: "in_progress", label: t("进行中", "In progress"), category: "started", color: "var(--info)" },
      { id: "in_review", label: t("审核中", "In review"), color: "var(--warning)" },
      { id: "done", label: t("已完成", "Done"), category: "completed", color: "var(--success)" },
      { id: "cancelled", label: t("已取消", "Cancelled"), category: "canceled", color: "var(--text-muted)" },
    ],
    priorities: [
      { id: "urgent", label: t("紧急", "Urgent"), color: "var(--destructive)" },
      { id: "high", label: t("高", "High"), color: "var(--warning)" },
      { id: "normal", label: t("普通", "Normal"), color: "var(--info)" },
      { id: "low", label: t("低", "Low"), color: "var(--text-secondary)" },
      { id: "none", label: t("未设优先级", "No priority"), color: "var(--text-muted)" },
    ],
    labels: [
      { id: "interface", label: t("界面示例", "Interface example"), color: "var(--agent)" },
      { id: "accessibility", label: t("无障碍", "Accessibility"), color: "var(--info)" },
      { id: "review", label: t("待讨论", "Discussion"), color: "var(--warning)" },
    ],
    assignees: [
      { id: "example-1", label: t("示例成员甲", "Example member A") },
      { id: "example-2", label: t("示例成员乙", "Example member B") },
      { id: "example-3", label: t("示例成员丙", "Example member C") },
      { id: "example-4", label: t("示例成员丁", "Example member D") },
      { id: "example-5", label: t("示例成员戊", "Example member E") },
    ],
  }
}

function ColorGallery() {
  const t = useText()
  const colors = [
    [t("背景", "Background"), "--background"], [t("表面", "Surface"), "--surface"],
    [t("抬升表面 / 侧栏", "Raised / sidebar"), "--surface-raised"], [t("悬停表面", "Hover surface"), "--surface-hover"],
    [t("按下表面", "Pressed surface"), "--surface-pressed"], [t("边框", "Border"), "--border"],
    [t("强调边框", "Strong border"), "--border-hover"], [t("文字", "Text"), "--foreground"],
    [t("次要文字", "Secondary text"), "--text-secondary"], [t("弱化文字", "Muted text"), "--text-muted"],
    [t("主操作", "Primary"), "--primary"], [t("强调色", "Accent"), "--accent"],
    [t("选中", "Selection"), "--selection"], [t("键盘焦点", "Keyboard focus"), "--ring"],
    [t("信息", "Information"), "--info"], [t("成功", "Success"), "--success"],
    [t("警告", "Warning"), "--warning"], [t("错误", "Error"), "--destructive"], ["Agent", "--agent"],
  ]
  return <GallerySection title={t("颜色", "Color")} description={t("当前 PM 语义令牌，随主题与既有强调色偏好变化", "Live PM semantic tokens, responding to theme and existing accent preferences")}>
    <div className={styles.tokens}>{colors.map(([label, token]) => <div key={token} className={styles.token}>
      <div aria-hidden="true" className={styles.swatch} style={{ background: `var(${token})` }} />
      <div className={styles.tokenLabel}><span>{label}</span><code>{token}</code></div>
    </div>)}</div>
  </GallerySection>
}

function StatusGallery({ catalog }: { catalog: WorkItemCatalog }) {
  const t = useText()
  return <GallerySection title={t("状态与优先级", "Status & priority")} description={t("真实状态图形与徽标组件；颜色始终配合文字。以下为本地样例，不代表当前工作区工作流。", "Real state glyphs and badges, always paired with text. Local examples, not the current workspace workflow.")}>
    <div className={styles.row}>{catalog.states.map(state => <span key={state.id} className={styles.status}><WorkItemStateGlyph state={state} />{state.label}</span>)}</div>
    <div className={styles.row}>{catalog.priorities.map(priority => <span key={priority.id} className={styles.status}><WorkItemPriorityGlyph priority={priority} />{priority.label}</span>)}</div>
    <div className={styles.row}>{catalog.labels.map((label, index) => <Badge key={label.id} tone={index === 0 ? "agent" : index === 1 ? "info" : "warning"}>{label.label}</Badge>)}</div>
  </GallerySection>
}

function TypographyGallery() {
  const t = useText()
  const specimens = [
    [t("页面标题", "Page title"), "--text-page", 600, t("界面设计示例", "Interface design example")],
    [t("区块标题", "Section title"), "--text-section", 600, t("即将到来的计划", "Upcoming plans")],
    [t("小标题", "Subsection"), "--text-body", 600, t("子任务", "Subtasks")],
    [t("正文", "Body"), "--text-body", 400, t("为新的页面准备低保真线框图。", "Prepare low-fidelity wireframes for the new page.")],
    [t("连续阅读", "Reading"), "--text-reading", 400, t("舒适的行高，适合较长的说明与内容。", "Comfortable line height for longer descriptions and content.")],
    [t("控件", "Control"), "--text-control", 500, t("筛选本地示例", "Filter local examples")],
    [t("元数据", "Metadata"), "--text-meta", 500, t("EXAMPLE-01 · 仅本页", "EXAMPLE-01 · This page only")],
  ] as const
  return <GallerySection title={t("字体", "Typography")} description={t("Inter · MiSans 中文回退 · 系统等宽字体；沿用 PM 字体与排版层级", "Inter · MiSans CJK fallback · system monospace; existing PM typography scale")}>
    <div className={styles.panel}>{specimens.map(([label, token, weight, text]) => <div key={label} className={styles.typeRow}>
      <span className={styles.caption}>{label}</span><span style={{ fontSize: `var(${token})`, lineHeight: `var(${token}--line-height)`, fontWeight: weight }}>{text}</span><code>{token} / {weight}</code>
    </div>)}<div className={styles.typeRow}><span className={styles.caption}>{t("等宽字体", "Monospace")}</span><code>const example = "PM"</code><code>--font-mono</code></div></div>
  </GallerySection>
}

function GeometryGallery() {
  const t = useText()
  return <GallerySection title={t("间距、圆角与阴影", "Spacing, radius, elevation")} description={t("直接展示现有间距单位、角色圆角与阴影；不新增基础令牌", "Existing spacing unit, role-based radii and shadows; no second token system")}>
    <div className={styles.twoColumns}>
      <div className={styles.panel}>{[1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => <div key={n} className={styles.spaceRow}><code>{n} × --spacing</code><span aria-hidden="true" style={{ width: `calc(var(--spacing) * ${n})` }} /><span className={styles.caption}>{n * 4}px</span></div>)}</div>
      <div className={`${styles.panel} ${styles.geometry}`}>
        {["--radius-inline-value", "--control-radius", "--radius-popover-value", "--radius-module-value", "--radius-panel-value", "--pill-radius"].map(token => <div key={token}><span aria-hidden="true" className={styles.radiusExample} style={{ borderRadius: `var(${token})` }} /><code>{token}</code></div>)}
        {["--shadow-composer", "--edge-shadow", "--shadow-floating"].map(token => <div key={token}><span aria-hidden="true" className={styles.shadowExample} style={{ boxShadow: `var(${token})` }} /><code>{token}</code></div>)}
      </div>
    </div>
  </GallerySection>
}

function ButtonGallery() {
  const t = useText()
  const [action, setAction] = useState({ label: "", count: 0 })
  const [starred, setStarred] = useState(false)
  const [menuAction, setMenuAction] = useState("")
  const record = (label: string) => setAction(previous => ({ label, count: previous.count + 1 }))
  const states = [["default", t("默认", "Default")], ["hover", t("悬停", "Hover")], ["active", t("按下", "Active")], ["focus", t("焦点", "Focus")], ["disabled", t("禁用", "Disabled")], ["loading", t("加载", "Loading")]] as const
  return <GallerySection title={t("按钮", "Buttons")} description={t("固定状态样本 + 真实可交互按钮；操作只更新本页示例回执", "State specimens plus interactive buttons; actions only update this page's example receipt")}>
    {([["primary", t("主按钮", "Primary"), t("创建示例", "Create example")], ["secondary", t("次按钮", "Secondary"), t("分享示例", "Share example")], ["ghost", t("轻按钮", "Ghost"), t("筛选示例", "Filter example")], ["destructive", t("危险按钮", "Destructive"), t("删除示例", "Delete example")]] as const).map(([variant, name, label]) => <div key={variant} className={styles.buttonRow}>
      <h4>{name}</h4><div className={styles.buttonStates}>{states.map(([state, caption]) => <div key={state}><span className={styles.caption}>{caption}</span><Button variant={variant} data-preview-state={state} data-preview-variant={variant} className={styles.stateButton} disabled={state === "disabled"} loading={state === "loading"} onClick={() => record(`${name} · ${caption}`)}>{label}</Button></div>)}</div>
    </div>)}
    <div className={styles.row}>
      <span className={styles.caption}>{t("图标", "Icon")}</span>
      <Button size="icon" variant="ghost" aria-label={t("添加本地示例", "Add local example")} onClick={() => record(t("添加", "Add"))}><Plus size={16} /></Button>
      <Button size="icon" variant="ghost" aria-label={t("收藏本地示例", "Star local example")} aria-pressed={starred} onClick={() => setStarred(value => !value)}><Star size={16} fill={starred ? "currentColor" : "none"} /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={t("本地示例菜单", "Local example menu")} />}><Ellipsis size={16} /></DropdownMenuTrigger><DropdownMenuContent>{[["copy", t("复制示例", "Copy example")], ["archive", t("归档示例", "Archive example")]].map(([id, label]) => <DropdownMenuItem key={id} onSelect={() => setMenuAction(label)}>{label}</DropdownMenuItem>)}<DropdownMenuItem disabled>{t("不可用操作", "Unavailable action")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <Button size="icon" variant="ghost" disabled aria-label={t("禁用删除示例", "Disabled delete example")}><Trash2 size={16} /></Button>
      <span className={styles.caption}>{t("尺寸", "Sizes")}</span>{([["sm", t("小", "Small")], ["default", t("中", "Medium")], ["lg", t("大", "Large")]] as const).map(([size, label]) => <Button key={size} variant="secondary" size={size} onClick={() => record(label)}>{label}</Button>)}
    </div>
    <p role="status" className={styles.receipt}>{action.count ? `${t("本地点击", "Local click")} ${action.count}: ${action.label}` : t("点击任意可用样本查看本地反馈。", "Activate any available specimen for local feedback.")}{menuAction && ` · ${menuAction}`}</p>
  </GallerySection>
}

function InputGallery({ catalog }: { catalog: WorkItemCatalog }) {
  const t = useText()
  const id = useId()
  const [text, setText] = useState("")
  const [focused, setFocused] = useState(t("页面线框图", "Page wireframes"))
  const [email, setEmail] = useState("example@")
  const [invalid, setInvalid] = useState(true)
  const [search, setSearch] = useState("")
  const [state, setState] = useState("in_progress")
  const [labels, setLabels] = useState(["interface", "accessibility"])
  const [date, setDate] = useState("2026-10-30")
  const [time, setTime] = useState("14:30")
  const [checked, setChecked] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [radio, setRadio] = useState("first")
  const [description, setDescription] = useState("")
  const [rich, setRich] = useState(t("**粗体**、*斜体*，以及列表。", "**Bold**, *italic*, and lists."))
  const matches = catalog.labels.filter(label => label.label.toLowerCase().includes(search.toLowerCase()))
  return <GallerySection title={t("输入", "Inputs")} description={t("所有字段仅在当前页面编辑；重新进入后重置", "All fields edit page-local state and reset when you return")}>
    <div className={styles.inputGrid}>
      <Field label={t("文字", "Text")}>{control => <Input {...control} value={text} onChange={event => setText(event.target.value)} placeholder={t("示例任务名称", "Example task name")} />}</Field>
      <Field label={t("焦点样本", "Focus specimen")} description={t("可用 Tab 或点击获得真实焦点", "Tab or click for actual focus")}>{control => <Input {...control} className={styles.focusInput} value={focused} onChange={event => setFocused(event.target.value)} />}</Field>
      <Field label={t("错误与校验", "Error & validation")} error={invalid ? t("请输入完整的示例邮箱，例如 name@example.com", "Enter a complete example email, such as name@example.com") : undefined}>{control => <Input {...control} type="email" required value={email} onChange={event => { setEmail(event.target.value); setInvalid(!event.target.validity.valid) }} />}</Field>
      <Field label={t("禁用", "Disabled")}>{control => <Input {...control} disabled value="example@example.com" />}</Field>
      <Field label={t("搜索本地标签", "Search local labels")} description={matches.map(label => label.label).join(" · ") || t("没有匹配标签", "No matching labels")}>{control => <div className={styles.searchInput}><Search aria-hidden="true" size={14} /><Input {...control} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("搜索示例", "Search examples")} /></div>}</Field>
      <Field label={t("选择状态", "Select state")}>{control => <WorkItemStatePicker {...control} label={t("本地示例状态", "Local example state")} value={state} options={catalog.states} onChange={setState} />}</Field>
      <div><p className={styles.fieldLabel}>{t("多选标签", "Multi-select labels")}</p><WorkItemLabelPicker label={t("选择本地示例标签", "Select local example labels")} value={labels} options={catalog.labels} onChange={setLabels} /><p className={styles.caption}>{labels.length} {t("个已选标签", "labels selected")}</p></div>
      <Field label={t("日期", "Date")}>{control => <Input {...control} type="date" value={date} onChange={event => setDate(event.target.value)} />}</Field>
      <Field label={t("时间", "Time")}>{control => <Input {...control} type="time" value={time} onChange={event => setTime(event.target.value)} />}</Field>
      <fieldset className={styles.choices}><legend>{t("复选、单选与开关", "Checkbox, radio & toggle")}</legend>
        <label className={styles.inline}><Checkbox checked={checked} onCheckedChange={setChecked} />{t("示例复选", "Example checkbox")}</label>
        <RadioGroup aria-label={t("本地单选示例", "Local radio example")} value={radio} onValueChange={setRadio} className={styles.inline}>{[["first", t("选项一", "Option one")], ["second", t("选项二", "Option two")]].map(([value, label]) => <label key={value} className={styles.inline}><RadioGroupItem value={value} aria-label={label} />{label}</label>)}</RadioGroup>
        <label className={styles.inline}><Switch checked={enabled} onCheckedChange={setEnabled} />{t("示例开关", "Example toggle")}</label>
      </fieldset>
      <Field label={t("多行文字", "Textarea")}>{control => <Textarea {...control} value={description} onChange={event => setDescription(event.target.value)} placeholder={t("添加本地示例描述…", "Add a local example description…")} />}</Field>
    </div>
    <div className={styles.richText}><RichTextEditor value={rich} onChange={setRich} label={t("富文本 · 本地示例", "Rich text · local example")} /><details><summary className={styles.caption}>{t("查看本地 Markdown", "View local Markdown")}</summary><pre id={`${id}-markdown`}>{rich}</pre></details></div>
  </GallerySection>
}

function NavigationGallery() {
  const t = useText()
  const [nav, setNav] = useState("inbox")
  const [tab, setTab] = useState("board")
  const [layout, setLayout] = useState("grid")
  const [filter, setFilter] = useState(true)
  const [crumb, setCrumb] = useState("")
  const tabs = [["overview", t("概览", "Overview")], ["board", t("看板", "Board")], ["list", t("列表", "List")], ["table", t("表格", "Table")]]
  return <GallerySection title={t("导航", "Navigation")} description={t("导航、标签页和筛选均限定在本地示例，不跳离当前设置", "Navigation, tabs and filters stay inside this local example")}>
    <div className={styles.navigation}>
      <div role="group" aria-label={t("侧栏导航示例", "Sidebar navigation example")} className={styles.sampleSidebar}>{([["home", t("首页", "Home"), House], ["inbox", t("收件箱", "Inbox"), Inbox], ["tasks", t("我的任务", "My tasks"), CircleCheck], ["project", t("示例项目", "Example project"), FolderKanban]] as const).map(([value, label, Icon]) => <Button key={value} variant="ghost" aria-pressed={nav === value} className={styles.navButton} onClick={() => setNav(value)}><Icon aria-hidden="true" size={16} /><span>{label}</span>{value === "inbox" && <Badge size="sm">3</Badge>}</Button>)}</div>
      <div className={styles.stack}>
        <nav aria-label={t("本地示例面包屑", "Local example breadcrumb")} className={styles.row}>{[t("示例工作区", "Example workspace"), t("项目", "Projects"), t("示例项目", "Example project")].map((label, index) => <span key={label} className={styles.inline}>{index > 0 && <ChevronRight aria-hidden="true" size={12} />}<Button variant="ghost" size="sm" onClick={() => setCrumb(label)}>{label}</Button></span>)}</nav>
        <Tabs value={tab} onValueChange={value => setTab(String(value))}><TabsList aria-label={t("本地视图标签页", "Local view tabs")} className={styles.tabs}>{tabs.map(([value, label]) => <TabsTab key={value} value={value}>{label}</TabsTab>)}</TabsList>{tabs.map(([value, label]) => <TabsPanel key={value} value={value}><p className={styles.caption}>{label} · {t("本地标签页面板", "local tab panel")}</p></TabsPanel>)}</Tabs>
        <div className={styles.wrap}><Segmented aria-label={t("本地布局", "Local layout")} value={layout} onValueChange={setLayout}>{([["grid", t("网格", "Grid"), LayoutGrid], ["list", t("列表", "List"), List], ["table", t("表格", "Table"), Table2]] as const).map(([value, label, Icon]) => <SegmentedItem key={value} value={value} data-value={value}><Icon aria-hidden="true" size={13} />{label}</SegmentedItem>)}</Segmented>{filter ? <span className={styles.filterChip}><ListFilter aria-hidden="true" size={13} />{t("状态：进行中", "Status: In progress")}<Button size="icon-sm" variant="ghost" aria-label={t("移除本地筛选", "Remove local filter")} onClick={() => setFilter(false)}><X size={12} /></Button></span> : <Button variant="secondary" size="sm" onClick={() => setFilter(true)}>{t("添加本地筛选", "Add local filter")}</Button>}</div>
        <p role="status" className={styles.caption}>{t("本地选择", "Local selection")}: {nav} · {layout}{crumb && ` · ${crumb}`}</p>
      </div>
    </div>
  </GallerySection>
}

function DataGallery({ catalog }: { catalog: WorkItemCatalog }) {
  const t = useText()
  const [selected, setSelected] = useState<string[]>([])
  const [opened, setOpened] = useState("")
  const [progress, setProgress] = useState(64)
  const examples: WorkItemRecord[] = [
    { id: "design-example-1", projectId: "design-example", identifier: "EXAMPLE-01", title: t("检查示例页面的无障碍体验", "Review accessibility of the example page"), stateId: "in_progress", priorityId: "high", assigneeIds: ["example-1", "example-2"], labelIds: ["interface", "accessibility"], dueDate: null, revision: 1, subtasks: { completed: 2, total: 3 } },
    { id: "design-example-2", projectId: "design-example", identifier: "EXAMPLE-02", title: t("整理组件使用说明", "Document component usage"), stateId: "ready", priorityId: "normal", assigneeIds: ["example-3"], labelIds: ["review"], dueDate: null, revision: 1 },
  ]
  return <GallerySection title={t("数据展示", "Data display")} description={t("使用真实 WorkItemCard / WorkItemRow，数据与选择仅属于本页示例", "Real WorkItemCard / WorkItemRow, with data and selection local to this example")}>
    <div className={styles.dataColumns}>
      <div className={styles.cardStage}>{examples.slice(0, 1).map(item => <WorkItemCard key={item.id} item={item} catalog={catalog} visibleProperties={["priority", "assignees", "labels"]} selected={selected.includes(item.id)} onSelect={value => setSelected(previous => value ? [...previous, item.id] : previous.filter(id => id !== item.id))} onOpen={value => setOpened(value.title)} />)}</div>
      <div className={styles.stack}>
        <div className={styles.row}><span className={styles.caption}>{t("头像", "Avatar")}</span>{([20, 24, 32, 36, 40] as const).map((size, index) => <Avatar key={size} name={catalog.assignees[index]?.label ?? t("示例成员", "Example member")} size={size} />)}<Avatar name={t("未分配示例", "Unassigned example")} initials="?" /><AvatarGroup people={catalog.assignees} limit={3} /></div>
        <div className={styles.row}><span className={styles.caption}>{t("徽标", "Badge")}</span>{([["neutral", t("默认", "Default")], ["info", t("信息", "Information")], ["success", t("活跃示例", "Active example")], ["warning", t("待处理示例", "Pending example")], ["danger", t("3 项逾期示例", "3 overdue examples")], ["agent", "Agent"]] as const).map(([tone, label]) => <Badge key={tone} tone={tone}>{label}</Badge>)}</div>
        <div className={styles.progressExamples}>
          {([[progress, t("本地进度", "Local progress"), "var(--primary)"], [100, t("完成示例", "Complete example"), "var(--success)"], [30, t("风险示例", "At-risk example"), "var(--destructive)"]] as const).map(([value, label, color]) => <Progress key={label} value={value} label={`${label} ${value}%`} aria-label={label} className={styles.progressSample} style={{ "--example-progress": `${value}%`, "--example-progress-color": color } as CSSProperties} />)}
          <Field label={t("调整示例进度", "Adjust example progress")}>{control => <input {...control} type="range" min={0} max={100} value={progress} onChange={event => setProgress(Number(event.target.value))} className={styles.range} />}</Field>
        </div>
      </div>
    </div>
    <div className={styles.exampleRows}>{examples.map(item => <WorkItemRow key={item.id} item={item} catalog={catalog} visibleProperties={["state", "priority", "assignees"]} selected={selected.includes(item.id)} onSelect={value => setSelected(previous => value ? [...previous, item.id] : previous.filter(id => id !== item.id))} onOpen={value => setOpened(value.title)} />)}</div>
    <p role="status" className={styles.receipt}>{selected.length} {t("个本地样例已选", "local examples selected")}{opened && ` · ${t("查看示例", "Viewed example")}: ${opened}`}</p>
    <Sheet open={!!opened} onOpenChange={open => { if (!open) setOpened("") }}><SheetContent><SheetHeader><SheetTitle>{opened}</SheetTitle><SheetDescription>{t("本地样例详情，不对应实际业务任务。", "Local example detail, not an actual business task.")}</SheetDescription></SheetHeader><SheetBody><Badge tone="info">{t("仅组件演示", "Component example only")}</Badge><p className={styles.receipt}>{t("卡片与列表行使用同一示例对象。选择只在此页有效，关闭抽屉不会修改业务数据。", "The card and list row share the same example record. Selection is page-local, and closing this drawer changes no business data.")}</p></SheetBody></SheetContent></Sheet>
  </GallerySection>
}

function FeedbackGallery() {
  const t = useText()
  const [toast, setToast] = useState<"success" | "error" | null>(null)
  const [archived, setArchived] = useState(true)
  const [retry, setRetry] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [command, setCommand] = useState("")
  const [modalName, setModalName] = useState("")
  return <GallerySection title={t("反馈", "Feedback")} description={t("提示、浮层与确认复用现有组件；不会创建、删除或发送业务数据", "Existing alerts, overlays and confirmations; no business creation, deletion or sending")}>
    <div className={styles.stack}>
      <Alert urgent={false}><div className={styles.inline}><Info aria-hidden="true" size={15} /><span>{t("信息示例：依赖关系可通过连线与说明共同表达。", "Information example: dependencies use both connectors and descriptions.")}</span></div></Alert>
      <Alert tone="success" urgent={false}><div className={styles.inline}><CircleCheck aria-hidden="true" size={15} /><span>{archived ? t("本地样例已归档。", "Local example archived.") : t("已撤销本地归档。", "Local archive undone.")}</span><Button variant="ghost" size="sm" onClick={() => setArchived(value => !value)}>{archived ? t("撤销", "Undo") : t("再次归档", "Archive again")}</Button></div></Alert>
      <Alert tone="warning" urgent={false}><div className={styles.inline}><TriangleAlert aria-hidden="true" size={15} /><span>{t("警告示例：3 个示例事项等待处理。", "Warning example: 3 example items need attention.")}</span></div></Alert>
      <Alert tone="error" urgent={false}><div className={styles.inline}><CircleAlert aria-hidden="true" size={15} /><span>{t("错误样式示例，不代表实际保存失败。", "Error styling example, not an actual save failure.")}</span><Button variant="ghost" size="sm" onClick={() => setRetry(value => value + 1)}>{t("本地重试", "Local retry")} {retry || ""}</Button></div></Alert>
    </div>
    <div className={styles.row}>
      <span className={styles.caption}>{t("触发示例", "Example triggers")}</span>
      <Button variant="secondary" onClick={() => setToast("success")}>{t("成功 Toast", "Success toast")}</Button><Button variant="secondary" onClick={() => setToast("error")}>{t("错误 Toast", "Error toast")}</Button>
      <Tooltip><TooltipTrigger asChild><Button variant="secondary">{t("工具提示", "Tooltip")}</Button></TooltipTrigger><TooltipContent>{t("工具提示补充说明；图标按钮仍有可访问名称。", "Tooltips add context; icon buttons retain accessible names.")}</TooltipContent></Tooltip>
      <Dialog><DialogTrigger render={<Button variant="secondary" />}>{t("对话框", "Modal")}</DialogTrigger><DialogContent><DialogTitle>{t("本地示例对话框", "Local example dialog")}</DialogTitle><DialogDescription>{t("输入仅留在此页，不创建任务或写入业务。", "Input stays on this page; no tasks or business writes.")}</DialogDescription><div className={styles.dialogForm}><Field label={t("示例名称", "Example name")}>{control => <Input {...control} value={modalName} onChange={event => setModalName(event.target.value)} />}</Field><DialogClose render={<Button variant="secondary" />}>{t("关闭示例", "Close example")}</DialogClose></div></DialogContent></Dialog>
      <Sheet><SheetTrigger render={<Button variant="secondary" />}>{t("抽屉", "Drawer")}</SheetTrigger><SheetContent><SheetHeader><SheetTitle>{t("本地示例抽屉", "Local example drawer")}</SheetTitle><SheetDescription>{t("复用 PM 抽屉组件；没有打开实际任务。", "Uses the PM drawer component, without opening a real task.")}</SheetDescription></SheetHeader><SheetBody><p className={styles.caption}>{t("抽屉可以通过关闭按钮或 Escape 关闭，内容独立滚动。", "Close with the close button or Escape; content scrolls independently.")}</p><Field label={t("抽屉里的示例输入", "Example input in drawer")}>{control => <Input {...control} defaultValue={t("仅本地演示", "Local demonstration only")} />}</Field></SheetBody></SheetContent></Sheet>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}><AlertDialogTrigger asChild><Button variant="secondary">{t("确认", "Confirmation")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogTitle>{t("确认本地示例操作？", "Confirm the local example action?")}</AlertDialogTitle><AlertDialogDescription>{t("只改变下面的本地回执，不删除任何任务或项目。", "Only changes the receipt below; no tasks or projects are deleted.")}</AlertDialogDescription><div className={styles.wrap}><AlertDialogCancel asChild><Button variant="secondary">{t("取消", "Cancel")}</Button></AlertDialogCancel><Button variant="destructive" onClick={() => { setConfirmed(true); setConfirmOpen(false) }}>{t("确认示例操作", "Confirm example action")}</Button></div></AlertDialogContent></AlertDialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogTrigger render={<Button variant="secondary" />}>{t("命令菜单", "Command menu")}</DialogTrigger>
        <DialogContent>
          <DialogTitle>{t("本地命令菜单", "Local command menu")}</DialogTitle>
          <DialogDescription>{t("输入筛选，方向键选择，Enter 执行本地示例。", "Type to filter, use arrows to choose and Enter to run a local example.")}</DialogDescription>
          <Command label={t("本地示例命令", "Local example commands")} className={styles.command}>
            <Command.Input aria-label={t("搜索本地命令", "Search local commands")} placeholder={t("搜索示例命令…", "Search example commands…")} />
            <Command.List>
              <Command.Empty>{t("没有匹配命令", "No matching commands")}</Command.Empty>
              {([["success", t("显示成功提示", "Show success toast")], ["error", t("显示错误提示", "Show error toast")], ["clear", t("清除本地回执", "Clear local receipt")]] as const).map(([action, label]) => <Command.Item key={action} onSelect={() => {
                if (action === "clear") {
                  setCommand("")
                  setConfirmed(false)
                  setRetry(0)
                  setToast(null)
                } else {
                  setToast(action)
                  setCommand(label)
                }
                setCommandOpen(false)
              }}>{label}</Command.Item>)}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
    <p role="status" className={styles.receipt}>{confirmed ? t("已确认本地示例操作；业务数据未改变。", "Local example action confirmed; business data is unchanged.") : t("尚未确认本地示例操作。", "No local example action confirmed.")}{command && ` · ${command}`}</p>
    {toast && createPortal(<div className={styles.toast}><Alert tone={toast}><div className={styles.inline}>{toast === "success" ? <CircleCheck size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}<span>{toast === "success" ? t("成功 Toast 示例 · 仅本页反馈", "Success toast example · feedback on this page only") : t("错误 Toast 示例 · 未发生业务请求", "Error toast example · no business request occurred")}</span><Button size="icon-sm" variant="ghost" aria-label={t("关闭示例 Toast", "Dismiss example toast")} onClick={() => setToast(null)}><X size={14} /></Button></div></Alert></div>, document.body)}
  </GallerySection>
}

const iconExamples = [
  ["house", House], ["inbox", Inbox], ["circle-check", CircleCheck], ["star", Star], ["search", Search], ["bell", Bell],
  ["folder-kanban", FolderKanban], ["list-checks", ListChecks], ["calendar", CalendarDays], ["chart-gantt", ChartGantt], ["users", Users], ["activity", Activity],
  ["settings", Settings], ["plus", Plus], ["list-filter", ListFilter], ["arrow-up-down", ArrowDownUp], ["rows-3", Rows3], ["share-2", Share2],
  ["ellipsis", Ellipsis], ["paperclip", Paperclip], ["message-square", MessageSquare], ["tag", Tag], ["link", LinkIcon], ["copy", Copy],
  ["pencil", Pencil], ["trash-2", Trash2], ["archive", Archive], ["upload", Upload], ["repeat", Repeat], ["timer", Timer],
  ["git-branch", GitBranch], ["lock", Lock], ["eye", Eye], ["at-sign", AtSign], ["sun", Sun], ["moon", Moon],
] as const

function IconGallery() {
  const t = useText()
  const [selected, setSelected] = useState("house")
  return <GallerySection title={t("图标", "Iconography")} description={t("Lucide · 1.8px 描边 · 12–18px；聚焦可读名称，点击选择本地图标", "Lucide · 1.8px stroke · 12–18px; focus for names, click to select locally")}>
    <div className={styles.icons}>{iconExamples.map(([name, Icon]) => <Button key={name} variant="ghost" size="icon" aria-label={`${t("选择示例图标", "Select example icon")}: ${name}`} aria-pressed={selected === name} onClick={() => setSelected(name)}><Icon size={17} strokeWidth={1.8} aria-hidden="true" /></Button>)}</div>
    <p role="status" className={styles.receipt}><Check size={13} aria-hidden="true" />{t("已选本地图标", "Selected local icon")}: <code>{selected}</code></p>
  </GallerySection>
}

export function SettingsDesignSystem() {
  const t = useText()
  const theme = useWorkspaceStore(state => state.theme)
  const setPreferences = useWorkspaceStore(state => state.setPreferences)
  const storage = useWorkspaceStore(state => state.preferenceStorage)
  const catalog = useExampleCatalog()
  return <SettingsSection title={t("设计系统", "Design System")} description={t("构成 Project Management 的真实令牌与组件。按参考设计系统的章节顺序展示，并适配本仓库组件。", "The real tokens and components behind Project Management, following the reference design system's section order with native PM components.")} wide>
    <div className={styles.gallery} data-pm-design-system>
      <div className={styles.themeBar}><span className={styles.fieldLabel}>{t("切换主题以查看两套真实配色", "Switch themes to inspect both real palettes")}</span><Segmented<"light" | "dark" | "system"> aria-label={t("PM 主题", "PM theme")} value={theme} onValueChange={value => setPreferences({ theme: value })}>{([["light", t("浅色", "Light"), Sun], ["dark", t("深色", "Dark"), Moon], ["system", t("系统", "System"), Monitor]] as const).map(([value, label, Icon]) => <SegmentedItem key={value} value={value} data-value={value}><Icon aria-hidden="true" size={13} />{label}</SegmentedItem>)}</Segmented></div>
      <SettingsNotice>{t("组件交互为本地示例：不会创建任务、删除项目、发送通知或保存业务数据；离开页面后重置。主题切换例外：使用既有 PM 外观偏好，立即应用到全站，并按现有机制尝试保存在本浏览器。", "Component interactions are local examples: no tasks, project deletion, notifications or business saves; they reset when you leave. Theme is the exception: the existing PM preference applies site-wide immediately and attempts to persist in this browser using the existing mechanism.")}{storage === "unavailable" && <p role="alert">{t("浏览器偏好存储不可用；主题仅在当前应用会话生效。", "Browser preference storage is unavailable; theme applies only in the current app session.")}</p>}</SettingsNotice>
      <ColorGallery /><StatusGallery catalog={catalog} /><TypographyGallery /><GeometryGallery /><ButtonGallery /><InputGallery catalog={catalog} /><NavigationGallery /><DataGallery catalog={catalog} /><FeedbackGallery /><IconGallery />
    </div>
  </SettingsSection>
}
