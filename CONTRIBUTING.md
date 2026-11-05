# 贡献指南

感谢参与 Dovspace。提交代码前先阅读 [README](README.md)、[AGENTS.md](AGENTS.md)、[当前架构](docs/architecture/context.md)和[领域规范第七节](docs/domain-design/README.md#implementation-plan)。内部计划、机器路径与历史验收不作为贡献者安装依赖。

## 准备环境

工具链固定为 Node 24.21.0、pnpm 11.9.0、Rust 1.95.0。Linux 需要 C/C++ 编译器、链接器、make、pkg-config；macOS 需要 Xcode Command Line Tools 与 pkg-config；Windows 需要 Visual Studio 2022 C++ x64/x86 Build Tools、Windows SDK 和已加载的开发者环境。不要以临时跳过原生模块或替换依赖绕过缺少工具的问题。

```sh
node scripts/doctor.mjs
pnpm install --frozen-lockfile
```

`doctor` 只检查前提，不安装工具、不读取私有环境、不连接业务服务。运行本地服务前按[安装指南](docs/guides/getting-started.md)准备独立数据库和存储。不要重用其他项目的端口、数据卷、Provider Home 或账号凭据。

## 变更约定

- 先明确用户可观察行为与受影响合同，复用既有应用服务；同步更新调用方、测试、公开用法与 [CHANGELOG](CHANGELOG.md)。未实现能力应明确禁用，不返回假成功。
- PM 核心任务/项目/关系以 Markdown 为权威；PostgreSQL、附件存储和 Agent SQLite 的职责见[数据所有权](docs/architecture/data-ownership.md)。不可恢复旧 SQL 核心完成前置规则，也不可把模型/Run/CI 成功当作任务完成。
- 保留原 commandId/operationId、revision 与收据核对；响应未知先查原结果，不以新键盲目重试。停止/撤权不等于回滚已发生的外部动作。
- 不拓展权限或宣称新的多租户/沙箱能力。Agent 当前面向本机单操作者，会话与持久化尚未统一设计收口；涉及此处变更应明确保留提醒。
- 保留现有并行修改，不做广泛格式化、`reset`/`clean`、全仓暂存或按端口杀进程；只操作自己拥有的临时进程/文件。commit 与 push 分别需要授权。
- 不提交 `.env`、令牌、访问文件、数据库、私有日志/截图或用户目录。Bug 报告与测试夹具须去除真实账号、业务内容和凭据，参见 [SECURITY](SECURITY.md)。

## 检查范围

| 命令 | 实际范围 |
| --- | --- |
| `pnpm check:docs` | 公开 Markdown 链接/锚点/围栏与领域 INV/SC 定义引用；不需要内部27步计划或历史文件 |
| `pnpm check` | 文档、精确导入边界、第三方许可/素材完整性（`--integrity`）、合同漂移、PM 后端 lint/类型、无数据库单元测试及 PM 构建；不含完整 Web/Agent/真实 PG 回归，也不等于许可发布批准 |
| `pnpm check:web` | Web lint、完整 TypeScript 与 Vite 构建 |
| `pnpm typecheck:agent` / `pnpm lint:agent` / `pnpm test:agent` | Agent 合同、客户端与服务、桌面及对应受影响范围；各入口不能互相代替 |
| `pnpm test:backend` | 真实 PostgreSQL/文件/HTTP/Worker/SSE/恢复；要求隔离配置，跳过不算通过 |
| `pnpm build:v4` | PM、Agent 依赖与服务、统一 Web；不等于桌面打包或平台验收 |
| `pnpm check:ci` / `node scripts/check-ci.mjs` | 默认 `all`：static → build → rust → backend → agent；Linux、Docker、Bubblewrap，后端阶段自建 PostgreSQL/真实 MinIO，使用临时 HOME，不加载本机 `.env`；失败/非豁免跳过返回非零 |

聚合入口与后端资源/期限约束见[测试说明](tests/README.md)。同一机器不要重叠运行回归；不要在真实业务实例运行会写入的 smoke。真实 Provider 账号、付费推理、额度、签名、公证、Windows/macOS GUI、生产部署与恢复须分别提供真实证据，不能由 fixture 或初始化健康检查替代。

聚合入口接受 `--stage static`、`build`、`rust`、`backend`、`agent` 或 `all`，只运行所选范围；单阶段成功不能写成完整聚合通过。独立 backend/agent 阶段要求先在同一检出完成 build。默认 `all` 的 Rust 范围仅显式排除依赖外部 GitHub 的 Skill 冒烟；该项必须另行运行 `node scripts/check-ci.mjs --stage rust-network`，不把本机离线范围通过记为外部网络验收。`check:licenses` 的完整性通过也不能关闭第三方授权/对应源码发布阻塞。

文档变更要更新公开链接与适用性；历史 ADR 保留原决策语义，当前实现另列差异。不依赖开发机已有 dist、外部参考源码目录或被忽略的内部记录。报告运行命令、环境、通过/失败/跳过及未覆盖范围，不沿用修改前的通过结论。

## 提交与许可

仓库正式托管地址与贡献接收流程确定后，使用该平台实际提供的分支/PR 功能；本指南不提供虚构仓库地址。请在变更说明中列出行为、兼容/迁移影响、测试证据和已知限制。

自有代码使用 `AGPL-3.0-only`，完整条款见 [LICENSE](LICENSE)。引入第三方代码/字体/图片时保留原许可、来源、固定版本和本地补丁记录，并更新[第三方清单](THIRD_PARTY_NOTICES.md)。没有授权证明的素材不可因根许可证存在而假定可分发。对经网络提供修改版本涉及的对应源码义务，应按 AGPL 原文落实真实可用的获取方式，不用未配置的地址充数。
