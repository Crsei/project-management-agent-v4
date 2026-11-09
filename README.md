# Dovspace

Dovspace 将项目管理与 Agent Chat 放在同一工作台：项目、任务、Markdown 文档、依赖、成果与人工审核由 PM 管理；PM 详情侧栏与 `/agent/workspace` 共用同一个 Agent 界面、Provider、会话与运行时。

**当前定位：可信本机、单操作者的自托管工作台，不是生产多租户 Agent 平台。** PM 的账号/项目授权不能代替 Agent 会话所有权隔离；文件区域和 CLI 的 cwd 不是文件系统沙箱，Terminal 拥有服务进程的本机权限。不要直接开放到公网。会话与持久化仍暂沿用 Agent Chat，**统一设计尚未收口**。

## 能做什么

- **项目管理**：项目/任务/里程碑、列表/看板/表格/日历/时间线/关系图、成员与团队、项目规划与真实服务端授权。
- **Markdown 优先**：项目核心文件、共享配置与恢复台账；多文档工作台、授权的外部 Markdown 来源及显式文件操作。
- **统一 Agent**：按独立绝对路径文件夹组织 Sessions，不绑定 PM 工作区／项目；也可仅对话。Files/Git/Provider 使用当前 Session 的同一实际执行目录，PM 资料通过明确目标的工具与引用访问。Workspace／Session Terminal 共用视图且不跨服务重启存活；另有 Browser、原生 Provider、MCP、Skills、用量与离线备份。
- **任务代码交付**：独立 worktree、明确选择 Provider、验证/提交/推送/Draft PR、同提交 CI 核对、有限节点工作流与本机隔离 App 预览。
- **自动化与集成**：显式授权的执行定义、PM 分析候选、时间/事件触发及 Git Sync；邮件、私有 S3、受限出站 Webhook 均须独立配置与验收。

模型回复、CLI 退出 0、Run/工作流成功、CI 通过、审核通过和任务完成是不同事实。任务状态由当前 Markdown 配置工作流及原生授权动作决定；审核是独立附加流程，**不恢复历史 SQL“必须先审核才能完成”的规则**。未实现或未配置的能力明确禁用，不提供假回复、假完成或 fixture 回退。

## 本地快速开始

源码运行要求 Linux、Node **24.21.0**、pnpm **11.9.0**、原生编译工具及 Docker Compose；当前 TypeScript MCP/Skills host 不需要 Rust/Cargo。先阅读[工具链与构建边界](docs/guides/development.md)；以下仅用于**全新空数据库与空存储**，不要对已有实例使用 `--new`：

```sh
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:up
pnpm db:migrate
pnpm bootstrap
pnpm build:v4
pnpm storage bind --new --stopped --target-config .local/blob-target.json
pnpm services:start
pnpm services:status
```

打开 `http://127.0.0.1:3224/pm`。`bootstrap` 只在尚无账号/工作区的实例准备私有 `.local/setup-token`（0600），数据库只存摘要；通过 Web 输入令牌、姓名、邮箱、密码与工作区名称。不会生成默认明文密码，也不会读取或迁入旧访问文件。设置响应未知时先核对状态，不盲目重新初始化。令牌/目录祖先必须安全，具体见[首次设置与部署恢复](deploy/README.md#首次设置令牌与恢复)。

默认 PM API `4194`、Agent API `4325`、Web 开发上游 `4326`、PostgreSQL `55444`；本项目使用独立数据库、卷和 Agent 数据。启动前核对端口、PID、工作目录，不接管其他服务。`services:status`/健康响应不证明 Provider、账号、邮件或外部接收器可用。

开发使用 `pnpm dev:v4`；切换 built/dev 模式前先停止**本项目拥有的**服务。已有安装升级、存储绑定、账号/CLI、目录与完整备份均见[安装指南](docs/guides/getting-started.md)和[部署手册](deploy/README.md)。

## 使用指南

| 入口 | 内容 |
| --- | --- |
| [PM 与文档](docs/guides/project-management.md) | 页面/能力矩阵、Markdown 工作台、文件、成员、通知、明确未支持项 |
| [Agent Chat](docs/guides/agent-chat.md) | 会话、Provider 配置、原生 Home、MCP/Skills/Apps、输出、Usage、离线备份与安全边界 |
| [任务代码交付](docs/guides/task-code-delivery.md) | GitHub 前提、独立分支、验证/发布确认及未知结果核对 |
| [任务工作流](docs/guides/task-workflows.md) / [状态联动](docs/guides/workflow-task-state.md) | 预制模板、发布版本、节点授权、恢复及待审核边界 |
| [产品规划](docs/guides/product-roadmap.md) / [App 预览](docs/guides/app-preview.md) | PRD/Roadmap、真实任务与依赖、提交覆盖、本机 Linux 预览协议 |
| [自动化](docs/guides/automations.md) | 47 个模板、触发、集成、分析候选与旧报告能力边界 |
| [桌面](docs/guides/desktop.md) | Windows x64、macOS arm64/x64 目标、安装数据、备份与原生构建 |
| [发布流水线](docs/guides/release.md) | 标签触发、精确提交 CI 门禁、draft Release、未签名证据与限制 |
| [外部集成](docs/guides/integrations.md) | SMTP/可信恢复邮箱、私有S3配置/停写维护、出站Webhook接收协议 |
| [营销站](docs/guides/marketing.md) | 独立静态构建、公开地址配置、素材与许可边界 |
| [PM 分析 Skills](.agents/skills/README.md) | 需求审阅、计划草稿、证据审阅与项目摘要；不表示 Chat 自动加载 |
| [上游源码维护](docs/guides/upstream-source-maintenance.md) | t3code / cc-switch 隔离更新、来源重建、维护 Skill 与分阶段 Draft PR 授权 |

桌面原生 CI 在提交 `a063dc0` 的历史通过**不代表最新工作树通过**，也不代表正式签名/公证、真实安装卸载或 GUI 业务验收。没有已确认的正式下载/自动更新地址；unsigned 测试包不得宣传为正式签名版本。

## 架构与数据

- `apps/server/pm`、`worker`、`agent` 与 `gateway.ts`：PM API、后台处理、Agent 执行和同源网关；`apps/web` 是浏览器/桌面共用的唯一 Web 工程。
- PM 核心对象与正式关系以 **Markdown 文件**为权威；PostgreSQL 保存账号、授权、PM 附加事实、审核/证据、审计、收据与事件；附件字节使用明确绑定的 Local/S3 存储。
- **Agent SQLite** 保存 Chat、输出及执行附属记录，与 PM PostgreSQL/Markdown 不是跨存储原子事务。缓存索引可重建，但权威核心、恢复台账、私有会话和历史附件不能当缓存删除。私有恢复journal与备份可包含任务正文前后内容和自动化快照，不是脱敏审计日志。
- `packages/domain` / `application` 拥有业务规则；HTTP、Worker、Provider 工具和前端不能各自决定任务完成。

详见[系统上下文](docs/architecture/context.md)、[模块契约](docs/architecture/module-contracts.md)、[数据所有权](docs/architecture/data-ownership.md)、[已采纳 Markdown ADR](docs/architecture/adr/0003-markdown-core.md)及[领域规范的当前/历史边界](docs/domain-design/README.md)。API 以[生成 OpenAPI](docs/contracts/openapi.yaml)和[客户端](packages/contracts/src/client.ts)为准，不固定宣传某一历史命令/路径数量。

## 开发与验证

贡献流程与检查命令见 [CONTRIBUTING.md](CONTRIBUTING.md)。隔离总入口为 `pnpm check:ci`（`node scripts/check-ci.mjs`，Linux + Docker + Bubblewrap），默认 `all` 依次覆盖 static/build/host/backend/agent；`host` 是 TypeScript 宿主构建与真实协议/扩展集成测试，当前 CLI 不接受旧 `rust` / `rust-network` 阶段。分阶段成功不是完整通过，真实外部 Skill 下载另行验收。根 `pnpm check` 包含文档、导入边界、许可/素材完整性、PM 合同与后端检查，但不含完整 Web/Agent/真实数据库回归；许可完整性通过不是正式发布授权。详细范围见[测试说明](tests/README.md)。仅文档检查使用 `pnpm check:docs`，不需要内部计划/本机证据文件。历史通过仅覆盖原提交与运行环境，不是当前发布验收证明。

`pnpm check:turbo` 是共享的显式工程叶调度入口：默认六 lint，`--stage build` / `host-build` 保留原九个声明/完整类型/产品构建叶与独立 host，完整公共输入/输出可用时可缓存并恢复。默认 CI 复用调度，但文档/合同/边界/许可/来源门禁、真实夹具、完整回归与清理始终新鲜执行；`check-ci` 可用互斥 `--baseline` / `--cache-name NAME` 做相同完整范围对照。完整 agent/all 还须显式提供已认证固定 PUBLIC OpenHands source，不能把来源用例 skip 算成功。`--dry` 只看图；构建/恢复会写当前 checkout，运行中的实例须使用新的独立 worktree，不能覆盖 live dist。当前命令、linked-worktree 安全边界与 Actions trusted-only 本地 task-cache 见[开发指南](docs/guides/development.md#turbo-显式任务调度与本地-lint-缓存)；[完整任务表](docs/reference/turbo-rollout-plan.zh.md)已按本轮一次性交付授权更新，历史六 lint 提速不是当前全工程、完整 CI 或 hosted 成功证明。

本轮新 worktree 的 **16 工程叶**匹配实测每组 n=3，baseline/MISS/HIT 中位 **178.507 / 182.319 / 13.388 秒**（HIT 每次 16/16）；8 个输出根恢复 byte/mode 一致，恢复产物上的独立完整 Agent **1434/1434、0 skip**。这是本机工程反馈与独立回归证据，**不是完整 CI 提速**：默认 `all` 在 backend 的 MinIO Docker FROM 镜像域名 DNS 失败，未启动后端用例，该轮未运行 Agent。Actions 仅完成保守配置与本机真实 tar transport/native HIT 验证，未触发 hosted；真实 Provider、平台/生产及四项发行许可 blocker 仍未关闭。详细成功/失败与原始值见[本轮证据表](docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)。

需要完整禁止检查入口隐式安装时，使用 `node scripts/check-turbo.mjs ...`，或 `pnpm_config_verify_deps_before_run=error pnpm check:turbo ...`；runner 在其 pnpm 调用边界固定 `error` 策略，并在任务缓存前新鲜预检，但不能拦截普通外层 pnpm 在 Node 启动前的安装行为。依赖安装仍是单独步骤。

已知限制包括单 API/本地 Markdown 核心、同工作区写入串行、8 MiB 成果上限、外部 Markdown 正文 4 MiB、无自动孤立文件 GC、无通用业务 Runner/Session/Run 系统、无公开注册/MFA/SSO、无生产多实例/HA 保证。真实 Provider/额度、目标 SMTP/S3/Webhook、TLS/公网、容量、恢复及真实设备均须单独验证。详见[安全政策](SECURITY.md)和[变更记录](CHANGELOG.md)。

## 许可证与发布状态

本项目自有代码采用 **GNU AGPL v3（`AGPL-3.0-only`）**；完整授权条款见根 [LICENSE](LICENSE)。第三方源码、字体和素材保留各自原始许可，不能被根许可覆盖或统一推定为 MIT；清单及尚未闭合的发布授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#release-blockers)。根许可证确定不等于所有第三方分发门禁已关闭。

仓库地址、正式下载地址、安全私密报告渠道尚未确认时，不在文档中编造链接或宣称已启用。内部实施计划与历史验收保留在本地但不随公开树分发；公共使用指南、架构、领域设计、API 与第三方许可仍保留。
