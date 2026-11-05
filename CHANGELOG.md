# 变更记录

本文件记录公开产品与发布边界，不汇总私有机器路径、业务数据或内部验收流水。`Unreleased` 表示尚未正式发布，不代表以下代码已经通过最新工作树全量检查。

## Unreleased

### 产品与架构

- 统一 PM 与 Agent Chat 入口、Provider、会话和运行时；Markdown 核心拥有项目/任务/正式关系，PostgreSQL 保存 PM 附加事实，Agent SQLite 保存聊天及运行附属记录。
- 提供项目/任务多视图、Markdown 文档工作台、授权外部来源、成员/团队、人工交付、Files 版本管理与定向通知。
- 提供原生 Provider、MCP/Skills/交互 Apps、Usage、任务代码交付/工作流、产品规划、有限 Linux 本机预览及显式授权自动化；未配置与未支持能力明确禁用。

### 发布准备

- README 整理为公共入口，完整用法与限制移至 `docs/guides/`；内部计划和历史验收原件留在本地，公共安装/检查不依赖它们。
- 当前架构/领域文档明确 Markdown、PostgreSQL、Agent SQLite 的不同权威，保留历史 ADR 和 INV/SC 追踪语义。
- 提供贡献与安全政策、工具链 doctor 和隔离 CI 入口；文档检查不再绑定内部27步实施计划。
- 自有代码采用 `AGPL-3.0-only`；第三方保留原始许可，未闭合分发授权继续作为[发布阻塞](THIRD_PARTY_NOTICES.md#release-blockers)。
- 自动化目录与脚本资源迁至 `packages/automation-resources`，合同保留 DTO/schema；Provider 深层源码访问限制在明确适配器，纯筛选模型不再把 React 组件带入后端类型检查。
- 修复 Linux 预览对新版 Bubblewrap 参数、固定全局 Node 和合并 `/usr` 布局的隐含依赖；沿用空环境、只读代码、独立网络及有界 relay，不放宽隔离。
- Agent 文件区域上下文在应用服务与公开 schema 中统一携带已认证 `actorId`，不再依赖 HTTP 层补字段。
- Provider 配置映射改为纯投影，由 Host 读取持久化设置，消除驱动注册表的 ESM 初始化循环；隔离 CI 显式使用已校验的原生 sidecar 构建产物。
- 修复组合框的非受控默认选择，以及受控创建 Sheet 未使用显式关闭焦点目标的问题。
- 隔离 CI 的真实备份/恢复使用自有 PostgreSQL 容器内的同版本客户端，仅挂载本轮测试临时文件，不依赖宿主 PostgreSQL 客户端或开发者 Docker 配置；明确临时目录必须在 Git 工作树之外。测试数据库销毁使用独立有界清理期限，应用查询限制不变。

### 尚未作为发布保证的事项

- Agent 仍为本机单操作者，非多租户产品，cwd 不是文件沙箱；会话与持久化统一设计未收口。
- 单 API/本地 Markdown 核心、同工作区写入串行；无自动孤立文件 GC、通用业务 Runner、多实例/HA 或公网生产验收保证。
- Windows/macOS 为桌面交付目标；`a063dc0` 原生 CI 历史通过不代表当前树、正式签名/公证、安装卸载或 GUI 验收。没有确认的正式下载/自动更新地址。
- 真实 Provider/账号/额度、SMTP/S3/Webhook、私密漏洞报告渠道、生产恢复与真实设备仍须逐项配置并验证。文档、构建、fixture 或健康检查均不能替代这些结果。
