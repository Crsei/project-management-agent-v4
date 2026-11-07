# CI / 原生构建耗时记录（2026-11-06）

## 范围与可比性

本次任务测量仓库检查与原生安装包构建，保留全部类型、测试、来源完整性、签名和隔离门禁，不以减少验证范围换取速度。

- 仓库基准 HEAD：`19919b28ce33582941f9b2f8f700101575151010`。测量对象是包含既有并行修改的工作树，**不是该提交的干净检出**。
- 本机：Linux x64，64 个逻辑 CPU；Node 24.21.0、pnpm 11.9.0、Rust/Cargo 1.95.0，Docker 24.0.2。工具链 doctor 与真实 Bubblewrap 命名空间探针通过。
- `TMPDIR` 使用 Git 工作树外的独立 `/var/tmp` 目录；默认临时目录的祖先存在 `.git`，不能用于本轮隔离测试。
- 本机已有依赖与构建缓存；每次隔离入口仍创建私有 HOME/Cargo 目录。未清理共享缓存、业务服务或其他操作者的进程。这些时间不能代表 GitHub 托管 runner 冷启动。
- `.github/workflows/ci.yml` 执行 Linux 仓库检查；`.github/workflows/desktop.yml` 执行 Windows x64、macOS x64/arm64 的原生安装包构建。默认 unsigned 仅是测试包，正式签名、公证与发布授权不能由构建成功替代。
- `check-ci` 默认 `all` 包含 static/build/rust/backend/agent，不包含独立的 `rust-network` 外部 GitHub Skill 验收、真实付费 Provider、原生 GUI 和生产验收。

## 运行记录

耗时为单次墙钟时间。失败记录只表示“到失败为止”，**不是完成该阶段或全量测试所需的时间**。独立阶段不能汇总冒充一次成功的 `all`。

| 测量 | 优化前秒数 | 优化后秒数 | 结果 / 边界 |
| --- | ---: | ---: | --- |
| 默认 `node scripts/check-ci.mjs` | 15.279 | 18.022 | 两轮均失败：来源清单与 `apps/web/src/features/agent/src/app.tsx` 不一致；build/rust/backend/agent 尚未运行 |
| 独立 `--stage build` | 86.551 | 81.982 | 两轮均失败：Agent 打包前发现 `apps/server/agent/src/extensions/provider-bindings.test.ts` 来源漂移；Web/marketing 尚未运行 |
| 独立 `--stage rust` | 134.260 | 103.786 | 两轮均通过：384 单元 + 18 集成测试；1 个外部网络用例按合同单列排除 |
| 独立 `--stage backend` | 26.868 | 26.772 | 两轮均失败：MinIO 构建所用固定 Go 镜像无法经宿主 Docker 镜像站解析；后端测试尚未启动 |
| 独立 `--stage agent` | 2.015 | 2.085 | 两轮均失败：构建失败后缺少 `apps/server/agent/dist/cc-switch`，未启动 Agent 测试 |

原始日志、阶段起始事件、120 秒进程采样和 JSON 退出摘要在本轮私有证据目录保存；公开记录不包含凭据、原始业务日志或机器私有路径。首轮外层监督脚本在写完 JSON 摘要后发生重复关键字异常，已修正；上述 15.279 秒和退出码来自异常前已持久化的被测子进程结果，不将监督脚本异常算作仓库失败原因。

“优化后”表示执行本次改动后的入口，不表示变快由本次改动造成。Rust 第二轮 Cargo 准备时间为 `1m 14s`，没有第一轮那次约 30 秒的网络超时，测试本体为 `20.68s` 与 `0.71s`；不能把总时间减少 `30.474s` 归因于本次缓存配置（本机根本未运行 Actions 缓存步骤）。各轮 n=1，不给出具有因果含义的提速百分比。

### GitHub Actions 证据可用性

尚未获得真实 run ID、job/step 时间或 cache-hit 记录：环境没有 `gh`、`GH_TOKEN` 或 `GITHUB_TOKEN`；代理请求返回 403 限流，直连且仍有 API 配额的请求返回 404，仓库网页也返回 404。用户选择提供已认证环境。仓库规则禁止读取凭据文件，因此未读取用户提供的 token 文件，也未将 token 写入源码、日志或命令参数。

本地代码尚未提交、推送或触发远端工作流；这些动作需要相应授权。**没有原生构建优化前后耗时，也没有已证实的缓存提速比例。**

## 优化决策

1. 工作流只缓存 pnpm 内容仓，使用精确 key，不使用前缀回退；key 覆盖 OS/架构、托管镜像、Node/Rust pin、package manifest、lock/workspace 配置及补丁。每次仍执行 `pnpm install --frozen-lockfile`，不缓存 `node_modules` 或产品构建结果。
2. 桌面额外缓存 Node/PostgreSQL 下载归档；signed/unsigned 使用独立 namespace。每次仍进行固定 SHA256、官方 Node checksum、重新解压/清单验证与原生 runtime smoke，不缓存私有 Home、证书、keychain 或安装后的运行时目录。
3. 隔离检查增加可持久化的命令/阶段计时与定期活动诊断，失败保留证据；不把单纯心跳解释成业务进展，也不因短暂静默自动杀死慢任务。
4. 不删除看似重复但范围不同的验证：client declarations 与完整类型图、PM 生产 emit 与含测试的 noEmit、Rust release sidecar 与 debug tests 均不是相同检查。
5. 不复用宿主 Cargo 配置/凭据。默认 `all` 内 Agent build 与 Rust tests 已共享同一个私有 CARGO_HOME，不存在本轮内重复创建 Cargo Home 的问题。

实现文件：

- `.github/workflows/ci.yml`、`.github/workflows/desktop.yml`：精确缓存及失败后计时工件上传。
- `scripts/check-ci.mjs`、`scripts/check-ci-process.mjs`：命令监督、嵌套阶段计时、120 秒诊断和安全 JSONL。
- `scripts/check-ci-process.test.mjs`：9 项行为回归，覆盖退出失败、无法启动、中断/强制结束、遗留自有子进程、捕获上限、秘密不落盘、符号链接拒绝和计时写入失败仍执行清理。

上述两个独立实现切片由 `openai-codex/gpt-6.1-sol:xhigh` subagents 完成，主线程统一执行测量与验证。9 项回归全部通过，未 skip/cancel/todo；受影响三份脚本的 oxlint 通过。工作流 YAML 已解析并与基线结构比较：ci 的 8 个原步骤、桌面两模式各 17 个原步骤原样保序，触发方式和权限未变；实际 `pnpm store path --silent` 返回单行内容仓路径。这些本机检查不等于在 GitHub 成功保存/恢复过缓存。

优化后默认 `all` 的真实失败运行已生成独立 JSONL：命令退出 1、static 失败、cleanup 成功、run 失败均已记录，没有把失败运行标为成功。

公开文档检查通过：114 份 Markdown 的链接、锚点、围栏及 INV/SC 引用已检查。10 次本机执行的墙钟摘要和退出码汇总保存在 `.local/evidence/ci-performance-2026-11-06.json`，优化后五次运行的细粒度记录位于 `.local/ci-runs/`；临时基线执行脚本和外层测量脚本已移除，原始运行证据保留。

### 已观测的瓶颈与未实施项

- Rust 基线中 Cargo 报告构建准备共 `1m 46s`；测试本体分别为 `18.79s` 与 `0.72s`。日志包含 crates.io 索引连接一次约 `30s` 超时及随后依赖下载。优先评估**只含公开 registry/index/source、与配置及凭据分离**的 CI 缓存；本次没有为此引入第二套 Cargo Home 或取消隔离，不能宣称该优化已实现。
- 后端等待不是测试卡死：固定 Go 镜像解析在宿主镜像站 `hub-mirror.c.163.com` 发生 DNS 失败。另用相同摘要向官方 `registry-1.docker.io` 拉取也在 `10.077s` 后 TLS handshake timeout；没有重启/改写共享 Docker daemon、改镜像 pin 或连接既有数据库绕过。
- 当前来源漂移与缺少 Agent sidecar 会阻断有效全量样本，必须由对应并行修改的拥有者先完成来源记录与构建；本次没有替他们改业务代码或重写来源清单。
- 工作树未冻结、两轮缓存/网络状态不同，且样本数均为 1。失败路径变快或变慢不等于优化收益；当前可交付的是真实阻塞记录、诊断能力和保留验证范围的缓存配置。

## 后续真实托管对比方法

取得已认证 GitHub 访问并授权本次改动的提交/推送后：

- 记录每轮 run ID、attempt、完整 SHA、workflow、distribution、OS/arch、runner image、工具链、cache hit/miss、开始/结束和 conclusion。
- 从 Actions 的 jobs API 分页读取所有 job 和 step；分别记录排队时间、job 执行时间、step 时间及整个矩阵墙钟时间。并行 job 耗时相加不等于用户等待时间。
- 对优化前版本、优化后冷缓存、优化后暖缓存分别运行；同一版本至少重复测量，报告样本数和中位数。不要把热缓存与冷缓存或不同托管镜像的差值全部归因于源码优化。
- 每约两分钟检查 run 当前 step、日志推进和 runner 活动；超时按现有所有权/工作流机制处理。无输出不等于死锁；取消、超时、失败和跳过不能计入成功样本。
- Windows/macOS 必须完成现有 runtime smoke、原生回归、打包、成品初始化/登录/关闭/重连；signed 必须保留受保护环境和真实签名/公证，不以 unsigned 代替。

正式发布仍受 [第三方发布门禁](../../THIRD_PARTY_NOTICES.md#release-blockers) 约束。本次不改变业务、会话或持久化设计；会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。
