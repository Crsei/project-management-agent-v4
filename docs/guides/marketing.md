# 营销站构建与公开地址

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

`tools/marketing` 使用 Astro 静态构建，首页与 `/download/` 参考 T3 Code 的黑底、悬浮 Agent 图标、紫色按钮及开源区布局。首页仅保留产品展示、多 Agent、项目交付、开源与下载介绍；真实界面截图未提供时保留空位，不使用 T3 Code 的产品截图或用户数据。图标与视觉参考来源为 `t3code/apps/marketing`，归属见 [LICENSE.t3code](../../LICENSE.t3code)；字体许可证随静态资源保留。

运行 `pnpm dev:marketing` 在 `http://127.0.0.1:4330/` 预览；`pnpm build:marketing` 输出到 `tools/marketing/dist/`。在 `tools/marketing/.env` 配置公开构建变量：`PUBLIC_APP_URL` 为工作台入口，`PUBLIC_SOURCE_URL` 为源码仓库 HTTPS 地址，`PUBLIC_DESKTOP_RELEASE_URL` 为桌面发布页 HTTPS 地址。源码或发布地址未配置时对应入口保持待补充，不生成假下载链接；配置后需重新构建。桌面卡片仅展示当前 Windows x64、macOS arm64/x64 构建目标，实际平台以发布页为准。

源码仓库、正式下载/更新地址尚未确定时不得虚构。站点自身的“开源”展示不构成全仓许可证授权；字体及素材的发布阻塞以[第三方说明](../../THIRD_PARTY_NOTICES.md#release-blockers)为准。营销产物随附 `/THIRD_PARTY_NOTICES.txt` 和原始第三方许可。
