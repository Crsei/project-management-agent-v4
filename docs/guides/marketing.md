# 营销站构建与公开地址

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

`apps/marketing` 使用 Astro 静态构建，五个路由统一展示 Dovspace。首页与 `/download/` 保留 T3 Code 参考的黑底、悬浮 Agent 图标、紫色按钮及开源区布局；指南使用原有阅读布局。现行入门、安全、桌面文案已切换 v4 事实，主入口为“开始自托管”。真实界面截图未提供时保留明确空位，不使用其他产品截图或用户数据。图标与视觉参考来源为 `t3code/apps/marketing`，归属见 [LICENSE.t3code](../../LICENSE.t3code)；字体许可证随静态资源保留。

运行 `pnpm dev:marketing` 在 `http://127.0.0.1:4330/` 预览；`pnpm typecheck:marketing` 执行 Astro/TypeScript 检查；`pnpm build:marketing` 输出到 `apps/marketing/dist/`。在 `apps/marketing/.env` 配置公开构建变量：`PUBLIC_APP_URL` 为工作台入口（默认 `http://127.0.0.1:3224/pm`），旧 `PUBLIC_WORKSPACE_URL` 已移除，须迁移后重新构建。`PUBLIC_SOURCE_URL` 默认真实公开仓库 `https://github.com/Crsei/project-management-agent-v4`，可覆盖为合法 HTTPS 地址；仓库首页不是运行产物的对应源码证明。`PUBLIC_DESKTOP_RELEASE_URL` 仅配置实际 HTTPS 发行页，未配置时保持不可下载；配置发行页也不证明某平台安装包已验收。桌面卡片仅展示 Windows x64、macOS arm64/x64 构建目标。

宣传站没有确定的正式公网托管地址；4330 是本地开发／预览，不冒充正式部署。静态产物只部署到明确指定的宣传站入口，不覆盖 3224 工作台，也不因宣传页修改重启 PM／Agent。站点展示不构成全仓许可证授权；字体及素材的发布阻塞以[第三方说明](../../THIRD_PARTY_NOTICES.md#release-blockers)为准。营销产物随附 `/THIRD_PARTY_NOTICES.txt` 和原始第三方许可。

P0 产品事实已纠正：区分一次性首次设置与原账号登录、PM 与 Agent 身份、文件夹／Session 与 PM 目标、取消与未知结果，以及桌面本地模式／更新器的实际边界。后续真实产品截图、下载证据与响应式／可访问性工作见 [Dovspace 宣传站更新计划](marketing-update-plan.md) 的 P1／P2；计划不代表那些项目已经交付。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。
