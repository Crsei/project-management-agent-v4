; Presentation-only NSIS branding. This file must never perform filesystem,
; process or registry work: install ownership, shutdown and rollback gates stay
; in desktop-lifecycle.nsh and are compiled unchanged after these macros.

!define MUI_FINISHPAGE_TITLE "Dovspace 安装完成"
!define MUI_FINISHPAGE_TEXT "Dovspace 已安装到本机。首次启动会引导你创建或连接本地工作区；程序、数据与 Agent 状态分开保存，卸载默认保留工作区数据。"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Dovspace"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 Dovspace"
  !define MUI_WELCOMEPAGE_TEXT "Dovspace 把项目、任务、文档与 Agent 协作放在同一个本地工作区。$\r$\n$\r$\n安装程序只负责程序文件、快捷方式与卸载入口。账号、工作区和 Agent 设置会由 Dovspace 自己的首次启动界面完成。$\r$\n$\r$\n本地数据目录与程序安装目录相互独立；升级保留工作区数据。"
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_UNWELCOMEPAGE_TITLE "卸载 Dovspace"
  !define MUI_UNWELCOMEPAGE_TEXT "卸载只移除 Dovspace 程序文件与快捷方式。工作区、项目文件和 Agent 状态默认保留；删除本地数据需要显式选择删除模式并再次确认。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
