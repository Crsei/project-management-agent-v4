import { useText } from "../pm-ui"
import { SettingsNotice, SettingsSection, type SettingsPageProps } from "./settings-shared"

type Shortcut = { label: string; keys: string[]; scope: string; availability: "service" | "unbound"; sequence?: boolean; alternatives?: boolean }
type ShortcutGroup = { title: string; description: string; rows: Shortcut[] }

export function SettingsShortcuts({ mode }: SettingsPageProps) {
  const t = useText()
  const groups: ShortcutGroup[] = [
    {
      title: t("通用", "General"),
      description: t("只有标明的页面或组件接入了对应按键，不代表所有设置表单都支持。", "Bindings apply only to the listed pages or components, not to every settings form."),
      rows: [
        { label: t("打开 / 关闭命令菜单", "Toggle command menu"), keys: ["⌘ / Ctrl", "K"], scope: t("已登录的正式工作区外壳，包括表单输入框；搜索真实授权项目、任务和页面。Lab 不挂载此菜单。", "Signed-in service workspace shell, including form inputs. Searches authorized projects, tasks and pages. This menu is not mounted in Lab."), availability: "service" },
        { label: t("聚焦当前集合搜索", "Focus collection search"), keys: ["/"], scope: t("Markdown 原生集合中存在搜索框时生效；输入框、文本域、选择框和可编辑内容中不触发。不是全局搜索。", "Only where the native Markdown collection search input is present. Does not trigger in inputs, textareas, selects or editable content. Not global search."), availability: "service" },
        { label: t("打开快捷键帮助", "Open shortcut help"), keys: ["?"], scope: t("参考设计按键，未绑定。请从设置导航打开此页。", "Reference-design key, not bound. Open this page from settings navigation."), availability: "unbound" },
        { label: t("折叠 / 展开侧栏", "Toggle sidebar"), keys: ["["], scope: t("参考设计按键，未绑定；使用页面的导航控件。", "Reference-design key, not bound. Use the page navigation controls."), availability: "unbound" },
        { label: t("切换深色模式", "Toggle dark mode"), keys: ["⌘ / Ctrl", "Shift", "L"], scope: t("参考设计按键，未绑定；在外观设置选择浅色、深色或跟随系统。", "Reference-design key, not bound. Choose light, dark or system in Appearance."), availability: "unbound" },
        { label: t("关闭支持的弹窗", "Dismiss supported dialogs"), keys: ["Esc"], scope: t("命令菜单和支持 Escape 的弹窗打开时。不是关闭所有详情面板的全局绑定；受保护操作仍遵守原确认规则。", "While the command menu or an Escape-enabled dialog is open. Not a global close-all-details binding; protected actions keep their confirmation rules."), availability: "service" },
      ],
    },
    {
      title: t("创建与提交 · 参考未绑定", "Create and submit · reference only"),
      description: t("以下参考按键均未注册；不会因为此页列出了按键就触发写入。", "These reference bindings are not registered. Listing a key here does not enable a write action."),
      rows: [
        { label: t("新建任务", "New task"), keys: ["N"], scope: t("未绑定。使用“新建任务”按钮或正式命令菜单；仍需真实创建权限。", "Not bound. Use New task or the service command menu; actual creation permission is still required."), availability: "unbound" },
        { label: t("新建项目", "New project"), keys: ["P"], scope: t("未绑定。使用有权限页面上的项目创建入口。", "Not bound. Use project creation on an authorized page."), availability: "unbound" },
        { label: t("提交表单", "Submit form"), keys: ["⌘ / Ctrl", "Enter"], scope: t("未提供统一绑定；请使用当前表单的保存按钮。普通 Enter 的浏览器表单行为不等于此组合键。", "No shared binding. Use the current form's Save button. Native Enter submission is not this modified shortcut."), availability: "unbound" },
        { label: t("发送评论", "Send comment"), keys: ["⌘ / Ctrl", "Enter"], scope: t("参考设计按键，未绑定；使用评论或消息表单的提交按钮。", "Reference-design key, not bound. Use the comment or message form's submit button."), availability: "unbound" },
      ],
    },
    {
      title: t("页面导航 · 参考未绑定", "Navigation · reference only"),
      description: t("G 后接另一个键的序列均未接入；不拦截输入，不新增全局单键冲突。", "G-then-key sequences are not implemented. They do not intercept typing or add global single-key conflicts."),
      rows: [
        { label: t("前往首页", "Go to Home"), keys: ["G", "H"], sequence: true, scope: t("未绑定；使用个人分组中的首页导航或命令菜单。", "Not bound; use Home under Personal navigation or the command menu."), availability: "unbound" },
        { label: t("前往我的任务", "Go to My Tasks"), keys: ["G", "T"], sequence: true, scope: t("未绑定；使用任务导航与已有任务范围筛选。", "Not bound; use task navigation and the existing scope filters."), availability: "unbound" },
        { label: t("前往项目", "Go to Projects"), keys: ["G", "P"], sequence: true, scope: t("未绑定；使用项目导航或命令菜单。", "Not bound; use project navigation or the command menu."), availability: "unbound" },
        { label: t("前往收件箱", "Go to Inbox"), keys: ["G", "I"], sequence: true, scope: t("未绑定；本项目提供真实活动页，不提供邮件收件箱。", "Not bound. This project provides a real activity page, not an email inbox."), availability: "unbound" },
        { label: t("前往日历", "Go to Calendar"), keys: ["G", "C"], sequence: true, scope: t("未绑定；从任务集合或项目中选择日历布局。", "Not bound; choose the calendar layout in a task collection or project."), availability: "unbound" },
        { label: t("前往设置", "Go to Settings"), keys: ["G", "S"], sequence: true, scope: t("未绑定；使用设置导航或命令菜单。", "Not bound; use settings navigation or the command menu."), availability: "unbound" },
      ],
    },
    {
      title: t("命令菜单", "Command menu"),
      description: t("正式命令菜单打开后，由现有菜单组件处理选择和执行。", "The existing command-menu component handles selection and execution while open in the service workspace."),
      rows: [
        { label: t("移动选中项", "Move selection"), keys: ["↑", "↓"], alternatives: true, scope: t("仅已打开的正式命令菜单内。", "Only inside the open service command menu."), availability: "service" },
        { label: t("执行选中命令", "Run selected command"), keys: ["Enter"], scope: t("仅已打开的正式命令菜单内；原权限与路由边界保持不变。", "Only inside the open service command menu; permissions and route boundaries remain unchanged."), availability: "service" },
        { label: t("切换搜索模式", "Switch search mode"), keys: ["Tab"], scope: t("参考设计功能，未实现；Tab 保留正常焦点导航，不是搜索模式切换。", "Reference feature, not implemented. Tab retains normal focus navigation, not search-mode switching."), availability: "unbound" },
      ],
    },
    {
      title: t("Markdown 编辑 · 局部绑定", "Markdown editing · scoped binding"),
      description: t("原生 Markdown 编辑工作区挂载时有效，不用于保存个人资料或其他设置。", "Available while the native Markdown editor workspace is mounted. Does not save profiles or other settings."),
      rows: [
        { label: t("保存当前 Markdown 草稿", "Save current Markdown draft"), keys: ["⌘ / Ctrl", "S"], scope: t("已选中的可写 Markdown 对象及有效源码草稿；在编辑输入框内也会接管浏览器保存。冲突、只读、待定或未知写入会阻止保存。", "The selected writable Markdown entity with a valid source draft. Also overrides browser Save inside editor inputs. Conflicts, read-only state, pending or unknown writes block saving."), availability: "service" },
      ],
    },
    {
      title: t("个人本地白板 · 局部绑定", "Personal local whiteboard · scoped bindings"),
      description: t("仅正式个人白板获得焦点时；跳过输入框、选择框和可编辑文本。仅撤销/重做也允许焦点在白板按钮上，其余按键不处理按钮事件。", "Only while focus is inside the service's personal whiteboard. Inputs, selects and editable text are excluded. Undo/redo also work on whiteboard buttons; the other keys ignore button events."),
      rows: [
        { label: t("撤销", "Undo"), keys: ["⌘ / Ctrl", "Z"], scope: t("撤销此浏览器白板的本地形状编辑，不撤销服务端业务命令。", "Undoes local shape edits in this browser, not server business commands."), availability: "service" },
        { label: t("重做", "Redo"), keys: ["⌘ / Ctrl", "Shift", "Z"], scope: t("也支持 ⌘ / Ctrl + Y；仅白板本地历史。", "Also supports ⌘ / Ctrl + Y; local whiteboard history only."), availability: "service" },
        { label: t("取消手势与选中", "Cancel gesture and selection"), keys: ["Esc"], scope: t("取消当前白板手势，清除选中并返回选择工具。", "Cancels the current whiteboard gesture, clears selection and returns to the selection tool."), availability: "service" },
        { label: t("移动选中形状", "Move selected shape"), keys: ["↑", "↓", "←", "→"], alternatives: true, scope: t("每次移动 1 个画布单位；按住 Shift 每次移动 10 个单位。", "Moves by one canvas unit, or ten units while holding Shift."), availability: "service" },
        { label: t("编辑选中形状文本", "Edit selected shape text"), keys: ["Enter"], scope: t("白板内已有选中形状时，聚焦文本输入框。", "Focuses the text input when a whiteboard shape is selected."), availability: "service" },
        { label: t("删除选中形状", "Delete selected shape"), keys: ["Delete / Backspace"], scope: t("仅删除白板本地形状；不删除项目、任务或服务端成果。", "Deletes only the local whiteboard shape, not a project, task or server artifact."), availability: "service" },
      ],
    },
  ]
  return <SettingsSection wide title={t("键盘快捷键", "Keyboard shortcuts")} description={t("已接入按键、准确作用域与完整参考对照。此页仅提供说明，不注册新的快捷键。", "Implemented bindings, their exact scopes and the complete reference comparison. This page documents keys; it does not register new shortcuts.")}>
    <SettingsNotice>
      {t("⌘ 对应 macOS Command，其他系统使用 Ctrl。按键受当前页面、焦点、权限与草稿状态约束；输入法组合输入和浏览器 / 操作系统快捷键不应当作应用命令。当前不支持自定义、重新绑定或一键启用参考快捷键。", "⌘ means Command on macOS; use Ctrl on other systems. Keys depend on the current page, focus, permissions and draft state. IME composition and browser or OS shortcuts are not application commands. Customization, rebinding and enabling the reference shortcuts are not supported.")}
      {mode === "lab" && <p className="mt-2">{t("当前是 Lab：下面的“仅正式工作区”描述正式产品已有实现，不代表本 Lab 页面绑定了它们。", "You are in Lab. Entries marked Service workspace only describe existing product behavior, not bindings on this Lab page.")}</p>}
    </SettingsNotice>
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      {groups.map(group => <section key={group.title} className="min-w-0 rounded-module border bg-surface p-4">
        <h3 className="font-medium">{group.title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{group.description}</p>
        <dl className="mt-3 divide-y">
          {group.rows.map(row => <div key={row.label} className="min-w-0 space-y-2 py-3">
            <dt className="flex flex-wrap items-start justify-between gap-2">
              <span className="text-sm font-medium">{row.label}</span>
              <span className="flex max-w-full flex-wrap items-center gap-1 text-xs">
                {row.keys.map((key, index) => <span key={`${index}:${key}`} className="inline-flex items-center gap-1">{index > 0 && <span className="text-muted-foreground">{row.sequence ? t("然后", "then") : row.alternatives ? "/" : "+"}</span>}<kbd className="rounded border bg-surface-raised px-1.5 py-0.5 font-mono">{key}</kbd></span>)}
              </span>
            </dt>
            <dd className="space-y-1 text-xs leading-5 text-muted-foreground">
              <span className="inline-flex rounded-full border px-2 py-0.5 text-[11px]">{row.availability === "unbound" ? t("参考 · 未绑定", "Reference · not bound") : mode === "lab" ? t("仅正式工作区", "Service workspace only") : t("已接入 · 按作用域", "Implemented · scoped")}</span>
              <p>{row.scope}</p>
            </dd>
          </div>)}
        </dl>
      </section>)}
    </div>
    <SettingsNotice>{t("输入区冲突说明：/ 搜索会避开文本输入；⌘ / Ctrl + K 在正式工作区的表单输入中仍可打开命令菜单；⌘ / Ctrl + S 仅在 Markdown 编辑工作区接管保存。普通 Tab / Shift + Tab 用于焦点移动，Enter / Space 按当前控件语义操作，不会自动启用 N、P、? 或 G 序列。", "Input conflicts: / search skips text entry, while ⌘ / Ctrl + K can still open the service command menu in form inputs. ⌘ / Ctrl + S overrides Save only in a Markdown editor workspace. Tab / Shift + Tab move focus and Enter / Space follow the current control's semantics; they do not enable N, P, ? or G sequences.")}</SettingsNotice>
  </SettingsSection>
}
