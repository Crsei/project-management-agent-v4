# t3code 最新 Provider 配置与 v3 差异清单

当前 v4 配置流程与验证见[第15节](#v4-native-provider-flow)，新会话模型列表修复见[第16节](#v4-composer-model-picker-fix)，输入框思考程度与隐藏用量见[第17节](#v4-composer-effort)。第1—12节及“v4 迁入说明”保留调查 / 迁入时点的事实，第13—14节保留前两轮实施证据；其中强制独立 Home 和配置文件教程已由第15节替换，不再表示当前行为。

## v4 迁入说明

本文件由已交付的 v3 差异报告迁入 v4。**下方调查结论、V 标识和源码行号仍指原 v3 调查快照**，不是重新对 v4 或最新上游验收。原报告正文保留，原文件 SHA-256：`6591581a1701a23e9a4dc56d50093509b2a802e9855b1f31a66910c04aaf0d0e`。

本次将 v3 的全部未提交源码/README 改动迁入 v4；保留 v4 的统一 Web、服务目录、`@agent/` 导入别名、独立端口与已有修改。差异清单没有在本次迁移中实施，FX、Codex managed、完整模型选项等缺口仍然存在。

| 原报告 V 路径 | v4 对应路径 |
| --- | --- |
| `apps/agent-server/` | [apps/server/agent/](../../apps/server/agent/) |
| `apps/agent-web/` | [apps/web/src/features/agent/](../../apps/web/src/features/agent/) |
| `packages/agent-contracts/` | [packages/agent-contracts/](../../packages/agent-contracts/) |
| `packages/agent-client-runtime/` | [packages/agent-client-runtime/](../../packages/agent-client-runtime/) |

原先暂停的 `apps/agent-server/.provider-settings-smoke.ts` 逐字保存在 [禁用脚本归档](archive/provider-settings-smoke.v3.ts.disabled)，不作为 v4 可执行入口，不运行、不复制其旧临时数据或凭据。原报告中的“未修改源码/未运行测试”等描述属于当次只读调查，不代表本次迁入没有代码变更。

### 本次迁入检查

- 完整清单核对：v3 的 13 项未提交改动全部对应到 v4，其中 12 项源码/README/资源合并，1 项暂停脚本逐字归档；未恢复已删除的 `apps/agent-server`、`apps/agent-web` 旧目录。
- 定向 oxlint、Agent server 类型检查（含测试类型）、统一 Web 类型检查通过；文档检查覆盖 114 份 Markdown。
- 统一 Web Vite 构建和 Agent 三个入口的 esbuild 构建通过，输出仅在新建临时目录，不覆盖常驻产物；Web 仍提示大 chunk 和既有 workflow-canvas 静态/动态混合导入。
- 离线导入真实驱动注册表，确认八个原生默认配置位、ACP 非默认位；未调用驱动 check/auth/run/prepare。
- 离线 React SSR 执行九类品牌组件及停用状态渲染；停用状态不会显示过期认证标签。SSR 不加载样式，不代表完整页面交互或视觉验收；样式由完整 Vite 构建检查。临时构建与检查产物随后清理。
- 未启动浏览器或测试服务，未恢复真实供应商验证/安全调查，未重启任何服务，未提交或推送 Git。

---

## 比较基线与边界

- 上游 origin：https://github.com/pingdotgg/t3code.git。
- 已使用用户指定的 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY=http://127.0.0.1:17891 执行 git fetch origin。origin/main 从 d53873b6a4 更新到 **30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c**，提交时间 2026-10-28T10:53:11-07:00。
- 原 t3code 工作树有 pnpm-lock.yaml 未提交修改，未覆盖、未 stash、未 reset。最新源码位于独立 detached worktree：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/.tmp/t3code-provider-audit-30eb7e7bb1`。
- v3 对照的是当前工作树，基线提交 `2f21c0769de35f414d983fc3393e5b2feb44e03d`，**包括上一轮未发布的 Provider UI 修改**，不是 3223 常驻页面或 dist。
- 十个只读 subagent 分别负责十类 Provider，主任务核对公共流程及重要结论。未修改本项目源码，未运行测试、构建、浏览器、安装、认证、模型调用或安全审计。
- 下文 T 路径相对于上述最新 t3code 快照；V 路径相对于 `ui-examples/project-management-agent-v3`。所有“支持/缺失”均指源码与配置消费链，不代表真实供应商验收。

## 结论

当前不是 t3code Provider 配置的完整等价移植：既有缺失，也有额外功能，以及同名字段的不同语义。最大差异是 **FX 整个驱动缺失、Codex managed 模式缺失、多数驱动模型选项未接通、多个原生驱动多出了应用内登录入口、ACP 向导不等价**。

不是所有差异都应自动改掉。独立账号目录、PM 作用域、既有业务检查属于本项目既定边界；本报告只列事实，不授权取消这些边界。

## 1. 公共配置与流程

| 项目 | 最新 t3code | 当前 v3 | 差异性质 |
|---|---|---|---|
| 顶级驱动 | Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse、Pi、ACP Registry，共十类 | 九类，缺 FX | 整个适配缺失，不只是前端漏选项 |
| 默认列表 | Codex/Claude 默认可见；其他默认位仅在已配置、有效启用或定向访问时显示 | 八类原生默认配置位直接显示，未创建项显示停用 | 上一轮按截图实现，不等于最新源码行为 |
| 添加列表 | 原生提供商选择；FX `featured:false`，进入 Show more；ACP 为独立路径 | 八类原生 tile + ACP tile，无 FX/Show more 对应项 | 入口结构不同 |
| 新建额外实例 | 显式 `enabled:true` | 显式 `enabled:true` | **一致**。不能把 schema 的 enabled:false 当成新建后停用 |
| 实例身份 | `displayName` 可清空并回退驱动名；颜色、启停、固定 ID | `label` 必填；颜色、启停、固定 ID | 名称主要是改名，但空值行为不同 |
| 实例 ID | 字母开头、最多64字符，自动生成并去重，可覆盖 | 向导同样自动生成/去重/覆盖；后端仍允许数字开头、最多80字符 | 向导接近，API 合同不完全一致 |
| 作用范围 | Device/Environment；项目可覆盖启停并恢复设备设置 | 本机 Agent 配置，所有工作区/项目共用 | 产品范围差异，不自动引入新权限体系 |
| 默认实例重置 | 配置过的默认实例有整体重置入口 | 无等价整体重置；可逐字段修改、放弃未保存草稿 | UI 操作缺失 |
| 环境变量 | `{name,value,sensitive,valueRedacted}`；非敏感值可编辑回显；支持驱动专属 Setup 环境字段 | `env` 字典，全部只写，读取仅 envKeys；无 sensitive 切换或 environmentFields 元数据 | 数据合同、编辑交互不同 |
| 模型管理 | 隐藏、排序、收藏、自定义模型、能力选项；偏好保存于选定环境并跨设备共享 | 自定义模型只有 `{id,label}`；收藏仅模型选择器 localStorage；无设置页隐藏/排序 | 配置能力缺失 |
| 模型选项 | descriptor 可为 select/boolean，包含选项值、显示名、默认值，并进入执行参数 | ProviderModel 主要是 id/label/source/temperature/reasoning；reasoning 是布尔标记，不是档位 | **展示标记不等于参数接通** |
| 状态维护 | 版本兼容建议、更新操作/进度、可配置后台健康刷新间隔（0关闭） | 挂载/手动刷新、显式检查；登录过程轮询；无等价通用更新/健康间隔设置 | 部分缺失；Antigravity/ACP 的专属 prepare 不等于完整维护体系 |
| 详情布局 | 独立 Status 与 Display name 行；统一 Models 管理段 | 状态放身份行，自定义模型与只读模型目录分开 | 版式仍有差异 |

证据：T `packages/client-runtime/src/providerClients.ts:18-46`；`packages/contracts/src/providerInstance.ts:5-48`；`apps/web/src/components/settings/ProviderSettingsPanel.tsx:729-749,1013-1068,1081-1148,1375-1380`；`ProviderInstanceCard.tsx:306-470,487-539,1135-1257`；`CustomModelEditor.tsx:46-50,112-129,135-165`。V `packages/agent-contracts/src/provider.ts:1-45,90-132`；`apps/agent-web/src/settings/providers-page.tsx:56-63,88-138`；`provider-instance-dialog.tsx:76-89,373-402`；`settings-layout.tsx:67`；`apps/agent-web/components/assistant-ui/elements/composer-model-picker.aui.tsx:32-40,195-196`；`apps/agent-web/hooks/use-providers.ts:72-125`；`apps/agent-server/src/providers/instances.ts:156-159`。

### 共同存储差异

T 多数驱动的 config schema 带隐藏 `enabled` 和 `customModels`；V 将二者移到实例顶层，驱动 config 通常拒绝这些键。不能原样复制 T 的 config JSON，也不能把搬到实例层的字段误报为完全缺失。T 的 customModels 通常支持字符串或 `{slug,name?,capabilities?}`；V 只有 `{id,label}`，因此**搬家是结构差异，丢失 capabilities 才是能力缺口**。ACP 的 T schema 为字符串数组、Antigravity 的隐藏 customModels 不实际开放，见专项。

## 2. Codex

### 字段清单

| 字段 | T | V |
|---|---|---|
| `setupMode` | hidden，`managed` / `existing`；省略走 existing/local，由专属流程设置 | 不支持该键，仅已有本地 CLI 路径 |
| `binaryPath` | `codex` | `codex` |
| `homePath` | `""`；空值使用全局 `~/.codex` | `""`；空值使用本项目实例目录 |
| `shadowHomePath` | `""` | `""` |
| `launchArgs` | `""` | `""` |
| `enabled` / `customModels` | config 隐藏键，true / [] | 实例层；customModels 仅 id/label |

### 具体差异

1. **托管模式缺失**：T 有 CodexSetupSection、ChatGPT profile/多账号、token broker、托管运行时。V 没有 setupMode/账号 profile/broker，不是改个登录弹窗就等价。
2. **认证方式不一致**：T existing 模式依赖外部 `codex login`，无应用内登录/登出；T managed 提供 ChatGPT OAuth，未提供 API-key 方法。V 对本地 Codex 固定提供 device-code、browser、api-key 三种 `account/login/start` 方法及 `account/logout`。这是 V 额外实现，并非 t3code 同一配置流程。
3. **home/shadow 同名不同义**：T 空 home 使用全局目录；V 使用独立实例目录。T 可只填 shadow（基础 home 回退全局）；V 要求 shadow 同时有明确 home。V 的全局目录隔离是既定项目边界，本轮不改变。
4. **模型参数缺失**：T `reasoningEffort`、`serviceTier` 选项有默认值，并实际下发至 `turn/start`；V 只传模型名，`reasoning:true` 不提供档位。T 还会读取原生 `config/read` 的 `service_tier`，V 没有对应读取/选项同步。
5. **目录处理不同**：T 有推荐默认模型、别名、版本门禁、updateRequiredModels、ChatGPT 模型缓存刷新；V 主要使用 model/list，且过滤 hidden，未接对应偏好与兼容提示。
6. **安装维护缺失**：T managed 有固定版本资产、下载/校验/激活/进度/取消/移除，并可复用兼容本机版本；V 无 Codex prepare/安装器，仅探测已有 CLI。
7. **原生路由不是独立 API Provider**：两边都没有 model_provider/base_url 的专属表单，也没有 config.toml 编辑器；依赖原生配置/环境变量/启动参数。不能把 V 原生 app-server 的 API-key 登录当成“已复刻 T managed 认证”。

证据：T `packages/contracts/src/settings.ts:619-674`；`apps/server/src/provider/Drivers/CodexHomeLayout.ts:48-75`；`CodexManagedRuntime.ts:116-135`；`CodexChatGptAuth.ts:841-885`；`CodexProvider.ts:164-320,353-438,560-571`；`CodexInstallation.ts:56-99,373-423,457-613,690-740`；`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:746-797`。V `apps/agent-server/src/providers/drivers/codex.ts:14-17,108-116,137-188,191-231`；`codex-config.ts:89-113`；`instances.ts:59-63`。

## 3. Claude

### 字段清单

| 字段 | T（driver=claudeAgent） | V（driver=claude） |
|---|---|---|
| `binaryPath` | `claude` | `claude` |
| `homePath` | `""`，继承 CLAUDE_CONFIG_DIR，否则 ~/.claude | `""`，实例私有目录 |
| `autoCompactWindow` | `""`；100000–1000000 token 字符串 | 相同范围 |
| `idleCompaction` | `default/onReturn/beforeCacheExpires/off`，默认 default | 仅 `default/off`，默认 default |
| `launchArgs` | `""` | `""`，接受的参数集合更窄 |
| `enabled/customModels` | config 隐藏，true / [] | 实例层，模型能力缩水 |

### 具体差异

1. `claudeAgent`→`claude` 是标识改名，不是缺驱动。
2. **应用内认证多做了**：T 没有 Claude auth controller，要求外部 `claude auth login` 或原生环境凭据。V 有终端登录流和 `claude auth logout`。
3. **没有独立 Anthropic API Provider**：两边都没有专门的 apiKey/baseURL 字段；原生 SDK 可使用环境变量。T 可继承宿主环境；V 要在实例 env 显式配置。T 状态探测还识别 ANTHROPIC_BASE_URL 自定义端点，V 没有相同判定分支。
4. **homePath 消费不同**：T 设置 CLAUDE_CONFIG_DIR，不整体重定向 HOME；V 将其作为实例 home 并重定向 HOME/XDG。已有机器登录不能视为在 V 自动可用。
5. **空闲压缩不等价**：V 不接受 onReturn/beforeCacheExpires，也没有 T 的客户端返回时或服务端缓存到期前调度。V default 只是不给 SDK 覆盖；off 只写 SDK disable。autoCompactWindow 已下发 SDK，但不含 T 同样的本地阈值/调度。
6. **模型选项未接通**：T effort、fastMode、thinking、contextWindow 有目录、映射和执行消费；V 主要保留 SDK supportedModels 的名称及布尔能力，没有这些选择值和下发。T 还有别名、推荐模型、legacy/版本门禁；V 没有等价目录层。
7. **启动参数并非全兼容**：T 支持 --settings 等高级原生设置合并；V 明确拒绝部分原生参数。这里只登记配置接受范围不同，不展开或修改现有业务检查。
8. **更新入口缺失**：T 有 Claude npm/native update 维护与版本建议；V 只做安装/版本检查。

证据：T `packages/contracts/src/settings.ts:676-767,1377-1418`；`apps/server/src/provider/Drivers/ClaudeHome.ts:15-42`；`Drivers/ClaudeDriver.ts:387-410`；`ClaudeProvider.ts:604-624`；`ClaudeModelCatalog.ts:142-292`；`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1471-1540,1646-1670`。V `apps/agent-server/src/providers/drivers/claude.ts:17-42,76-101,118-186`；`instances.ts:226-240`。

## 4. Cursor

### 字段清单

- T schema：`enabled=false`、可选 binaryPath、可选 apiEndpoint、customModels=[]；全部 hidden，Runtime 表单 order=[]。
- T 另有 **Setup 专属 `CURSOR_API_KEY` 字段**，说明为覆盖浏览器登录。
- V：fields=[]，但 config API 允许 binaryPath/apiEndpoint；实例通用 env 可写 CURSOR_API_KEY，无专属 Setup 行。

### 具体差异

1. 两边都是 SDK 驱动，**binaryPath 不参与 Cursor 执行**。不能为了表单看起来完整而补一个误导性的 CLI 路径输入。
2. 浏览器登录和显式 CURSOR_API_KEY 覆盖两边都有；V 缺的是专属密钥字段、覆盖浏览器登录的清晰提示，而非整个 key 能力。
3. apiEndpoint 是用量端点，不是会话模型执行地址；两边都没有普通 Runtime 编辑入口。
4. T 将 SDK parameters 转为 contextWindow/fastMode/reasoning 等选项并回传 model.params；V 只保留 reasoning 布尔，执行只传 model.id。
5. T 有 plan/agent 交互模式；V 固定 agent。T 有默认模型/别名和目录缓存，V 未接等价机制。
6. 两边没有 Cursor 自动安装流程。T 使用宿主 credential store；V 使用实例 home 凭据及 worker。默认目录/原生账号使用范围不同。
7. Cursor Keychain 用量开关两边都有，但 T 位于 Provider 设置相关区，V 位于 Usage 设置，不能误报缺失。

证据：T `packages/provider-cursor/src/settings.ts:8-26`；`client.ts:12-19`；`server/status.ts:96-161`；`server/sdkModel.ts:5-34,57-66`；`server/adapter.ts:307-314,2311`。V `apps/agent-server/src/providers/drivers/cursor.ts:81-101`；`cursor-sdk.ts:194-219`；`apps/agent-web/src/usage/UsageSettings.tsx:53`。

## 5. Grok

### 字段清单

- T：binaryPath=`grok`（唯一可见专属字段）；隐藏 enabled=false、customModels=[]。
- V：binaryPath=`grok`；enabled/customModels 放实例层。没有专属 homePath/apiKey/launchArgs 字段。

### 具体差异

1. 二进制字段及清空回退基本一致。
2. **T 无应用内 Grok 登录/退出**：依赖外部 `grok login`、原生登录文件或实例环境变量 XAI_API_KEY。V 增加 ACP 登录、浏览器/终端/密钥交互与退出处理。
3. V 的 xai.api_key 仍是原生 Grok ACP 认证，不是独立 xAI API Provider；但这套应用内认证入口确实不是 T 的设置方式。
4. T 默认沿用机器 Grok home，可经环境改变；V 固定实例 home，原机器登录不自动继承。
5. T 将 ACP reasoningEfforts 转为 reasoningEffort 选项并在会话应用；V 只 setModel，没有推理档位下发。
6. 两边有 grok-build 与模型发现。T 目录/选项元信息更丰富；V 仍有运行期上下文遥测，**不能说 V 完全没有上下文显示**。
7. T 有版本建议、grok update/npm/Homebrew 维护；V 只有版本探测。两边都没有 Grok 托管安装器。V 正式运行也固定禁用 CLI 自更新，T 主要在探测中禁用。

证据：T `packages/provider-grok/src/settings.ts:9-31`；`server/status.ts:197-217,418-419,499-529,571-594`；`server/acpSupport.ts:191-231`；`server/driver.ts:51-91`；`apps/web/src/components/settings/ProviderSettingsPanel.tsx:1346-1367`。V `apps/agent-server/src/providers/drivers/grok.ts:24,35-100`；`drivers/acp.ts:310-315`。

## 6. OpenCode

### 字段清单

| 字段 | T | V |
|---|---|---|
| binaryPath | `opencode` | `opencode` |
| serverUrl | `""`；非空连接外部服务器 | 同 |
| serverPassword | `""`，密码控件 | 同，write-only |
| username | 无；内部固定 opencode | 无；同样固定 opencode |
| enabled/customModels | config 隐藏，false / [] | 实例层 |

### 具体差异

1. 三个主要 Runtime 字段已基本对齐，不能说 OpenCode 只是一个空壳选项。
2. **T 没有在应用内管理 OpenCode 底层供应商登录/退出**；V 实现了 API key/OAuth/命令/external 等认证及凭据移除。这是 V 额外流程，不应描述为原样复制 T。
3. T v2 自启服务器总是生成随机密码；配置 serverPassword 用于外部连接。V 自启也优先使用配置密码。T v1 与 v2 行为不同，不能混在一起比较。
4. T 模型是 providerID/modelID，可选 variant；v1 还有 agent=build/plan，v2 由交互模式映射。V 识别 model ID，但丢失 variant/agent 选择及下发。
5. T 自定义模型可带 capabilities；V 只有 id/label。只显示 reasoning:true 不能代替 low/high/xhigh 等 variant。
6. T 默认使用宿主 HOME/XDG 原生配置；V 每实例 home，所以机器已有 OpenCode 账号/配置不自动可见。
7. T 有 opencode upgrade、npm 包维护与版本建议；V 无对应 prepare/update 入口，仅版本/连接检查。

证据：T `packages/provider-opencode/src/settings.ts:14-55`；`server/driver.ts:70-90,209-230`；`server/v2/OpenCode2Server.ts:136-156`；`server/status.ts:229-283,582-603`；`server/v2/adapter.ts:598-614`。V `apps/agent-server/src/providers/drivers/opencode.ts:43-59,73-109,181-310,625-651`；`opencode-transport.ts:156-187`。

## 7. Antigravity

### 字段清单

两边五个可见字段基本一致：

- authMethod=`oauth-personal`：oauth-personal / oauth-business / gemini-api-key / agent-platform。
- apiKey=`""`。
- gcpProject=`""`。
- gcpLocation=`""`。
- binaryPath=`""`（允许保留空串，代表受管/默认运行时路径）。

T 还有隐藏 enabled=false/customModels=[]；但 **T 不开放 Antigravity 自定义模型编辑，驱动也不消费该隐藏 customModels**。

### 具体差异

1. Google 账号、企业、Gemini key、Agent Platform 四类认证及其配置要求基本对齐；这里的 API key 字段是 T 原本就有的，不应与独立 OpenAI/Anthropic API Provider 混淆。
2. **自定义模型入口不一致**：V 通用表单允许登记任意 id/label；运行时却只接受当前账号会话发现的模型。登记已发现 ID 可以执行；不可发现或拼错 ID 可以保存，但执行时拒绝。T 直接隐藏该入口。
3. T 有专门安装状态、下载字节、进度、取消、移除；V 是单次 prepare 请求，没有等价状态操作面。两边 pin 的运行时均为 1.3.0，并非任意版本选择字段。
4. 安装目录：T 服务端共享；V 每实例各一份。T 设置自定义 binaryPath 后拒绝托管安装；V 仍可下载，而执行继续优先使用自定义路径。
5. T 有模型 manifest、legacy 标记和推荐默认模型；V 主要使用实时发现及独立 antigravity-default 条目，默认语义为保留账号当前模型。
6. 配置缺 key/GCP 时，T 与 V 的错误/unknown 呈现不同；不是所有“已安装”都代表认证配置齐全。
7. **配额不是缺项**：V 已在独立 Usage 模块实现 OAuth token 刷新、cloudcode 配额、账号指纹及账号信息；不能因驱动目录里没有就误报未实现。

证据：T `packages/contracts/src/settings.ts:780-844`；`apps/web/src/components/settings/ProviderInstanceCard.tsx:703-706`；`apps/server/src/provider/AntigravityInstallation.ts:166-187,708-849`；`providerInstallation.ts:83-92`；`AntigravityProvider.ts:43-77`。V `apps/agent-server/src/providers/drivers/antigravity.ts:176-203,221-228,244-258`；`antigravity-installation.ts:25-68`；`apps/agent-server/src/usage/limits/other.ts:107-141`。

## 8. Muse Code

### 字段清单

- T：binaryPath=`muse`（唯一可见 Runtime 字段）；隐藏 enabled=false/customModels=[]。
- V：binaryPath=`muse`；enabled/customModels 移至实例层。
- META_API_KEY 是原生环境变量，不是独立顶级 API Provider 字段。

### 具体差异

1. **T 没有应用内 Muse 登录控制器**，要求宿主 `muse login`；V 提供 PTY `muse login` 流程并使用实例私有 home。两边都没有应用内 logout。
2. `~/` 路径语义不同：T 展开到宿主 home；V Muse 展开到实例 home。相同路径文本可能指向完全不同的文件。
3. T 会解析 variants、defaultReasoningEffort、reasoningEffortVariants，生成推理档位并在 turn/start 传 reasoningEffort。V 只折叠为 reasoning 布尔，未保存/下发档位。
4. T 有 provider default 模型选择语义。V runtime 认识 default，但目录未提供等价的默认条目，正常选择器主要要求显式模型。
5. T 有 MUSE_CHANNEL、launcher 更新、发布修订号比较和版本建议；V 没有对应维护链。
6. 两边默认抑制原生自动更新，但 T 实例环境可覆盖；V 在合并环境后强制 MUSE_NO_AUTO_UPDATE=1。
7. 两边的“模型目录可读”都不等于认证已核验，认证状态可保持 unknown；不能把这一点作为 V 独有缺陷。

证据：T `packages/provider-muse/src/settings.ts:10-30`；`server/sdk.ts:55-66`；`server/modelCatalog.ts:11-72`；`server/adapter.ts:1949-1954,2066-2076`；`server/maintenance.ts:20-131`；`docs/user/providers-muse.md:4-32`。V `apps/agent-server/src/providers/drivers/muse.ts:69-127,296-315`；`muse-sdk.ts:22-30`；`muse-protocol.ts:39-51`。

## 9. Pi

### 字段清单

| 字段 | T | V |
|---|---|---|
| binaryPath | `pi` | `pi` |
| launchArgs | `""`，普通可回显文本 | `""`，password/write-only，保存后不可回看 |
| enabled/customModels | config 隐藏，false / [] | 实例层 |
| homePath/agentDir | 无专属字段，可由原生环境决定 | 无专属字段，固定实例 home/PI_CODING_AGENT_DIR |

### 具体差异

1. **启动参数控件不同**：T 是普通文本；V 为密码型只写字段，即使只是普通参数也不回显。
2. **认证入口不同**：T 无应用内登录，提示用户进入 Pi 执行 /login 或配置原生账号；V 有 external-login 弹窗，给出私有目录命令，用户在外部登录后回到弹窗触发重新检查。V 不是内嵌执行完整 OAuth，也没有独立 API Key 表单。
3. T 默认复用用户 ~/.pi/agent（可由环境改变）；V 强制实例专属 PI_CODING_AGENT_DIR，不复用全局登录。
4. 两边模型都是 provider/model-id。这里的 anthropic/openai 等是 Pi 的底层供应商，不是本项目缺少的顶级 Provider。
5. T 支持逐模型 thinking 档位 off/minimal/low/medium/high/xhigh/max，并下发 set_thinking_level；V 只有 reasoning 布尔，run 仅 set_model。V 可通过原生 launchArgs 设置初始 thinking，但不等价逐模型/逐回合选项。
6. T 有 pi update --self/npm 维护和版本建议；V 无更新入口。两边最低版本检查面向0.80.5，但本报告不将“1.x被放行”误报为版本比较差异。

证据：T `packages/provider-pi/src/settings.ts:13-35`；`server/driver.ts:42-46`；`server/thinkingCapabilities.ts:5-73`；`server/adapter.ts:2245-2298`；`server/status.ts:449-455`。V `apps/agent-server/src/providers/drivers/pi.ts:21-33,60-91,150-160`；`pi-config.ts:66-87`；`instances.ts:226-239`。

## 10. ACP Registry

### 字段清单

| 字段 | T 默认与入口 | V 默认与入口 |
|---|---|---|
| source | registry；registry/local | 同 |
| agentId | `""`，registry可见 | 同 |
| commandPath | `""`，可执行覆盖/local命令 | 同 |
| commandArgs | []，schema hidden；local专用参数编辑器 | []，local string-list |
| authMethodId | `""`；local表单不显示，但后端能消费 | `""`；local表单也显示 |
| distribution | auto；auto/binary/npx/uvx，**hidden** | 同取值，**前端可见 select** |
| enabled | config hidden，true | 实例层 |
| customModels | config hidden，schema为string[] | 实例层id/label |
| registryIconUrl | 向导写入的UI元数据，不是运行配置schema字段 | 无对应字段/展示链 |

双方 registry URL 均为内置常量，没有用户可配 registryUrl。不能把“私有注册表 URL”列成 V 相对 T 的既有缺项。

### 具体差异

1. **向导不等价**：T 是搜索/预览/prepare后进入身份步骤，再到登录；local 路径更短。V 是固定“提供商→身份→配置”，搜索在配置步骤，保存后关闭，再去卡片准备或登录。
2. V 搜索结果也会填 agentId 和条件 label，ID 也会自动生成去重，**不是完全没有预填**。T additionally 写 registryIconUrl、明确 distribution:auto，并把prepare完成的agent放进专属向导状态；version/integrity是展示/搜索元信息，不是独立用户配置键。
3. T 搜索过滤已由原生驱动覆盖的agent及缺失包管理器的发行版；V 显示 distributions[]，没有相同过滤/完整性信息和流程。
4. **准备时机不同且服务端已接线**：T 创建前prepare，运行resolve也可自动安装；V 注册表安装必须显式prepare，服务端未找到准备收据会拒绝运行。不能误报为“V仅UI提示”。local/commandPath override不走下载。
5. T 隐藏 distribution、local下隐藏authMethodId；V把它们暴露。字段能保存，不代表设置方式与来源一致。
6. **env_var认证不同**：T 引导用户写实例environment；V 在认证弹窗收集字段，保存为实例凭据，再注入原生进程。默认方法选择也不同：V偏好browser，T通常遵循声明顺序/指定方法。
7. T 有同agent认证绑定、托管文件按agent共享/引用检查及卸载；V按实例凭据与安装目录，删除实例保留其原生目录。是生命周期差异，不在本轮改动。
8. T 暴露会话configOptions的能力描述、动态配置刷新及ACP会话管理段；V主要做模型发现和setModel，未接完整配置选项面。

证据：T `packages/provider-acp-registry/src/settings.ts:8-69`；`apps/web/src/components/settings/AddProviderInstanceDialog.tsx:297-323,375-403`；`AddProviderInstanceDialog.logic.ts:8-10`；`ProviderSettingsForm.tsx:110,171-235`；`packages/provider-acp-registry/src/server/auth.ts:305-351`；`server/AcpRegistrySupport.ts:1812-1893`。V `apps/agent-server/src/providers/drivers/acpRegistry.ts:57-68`；`acp-registry-support.ts:147-186,301-348`；`acp-auth.ts:113-140`；`apps/agent-web/src/settings/provider-instance-dialog.tsx:76-89,151-155,334-370`。

## 11. 新增 FX

### 上游配置

- driver=`fx`，客户端标记 featured=false，添加面板在 Show more 中出现。
- binaryPath=`fx`：唯一普通 Runtime 字段。
- enabled=false、customModels=[]：隐藏schema字段；额外实例创建仍显式enabled:true。
- 无homePath、serverUrl、API key、token、setupMode、authMethod专属字段。
- 外部 `fx login`；状态来自 `fx status --json`，模型来自 `fx models --json`，执行命令 `fx acp`。
- 默认模型 default；effort 可选 auto/low/medium/high/xhigh/max，默认medium，并按会话实际宣告能力应用。
- 无应用内自动安装/登录/登出；维护为manual-only。底层backend选择仍在外部 `fx provider`，不暴露为顶级配置字段。

### V 缺失层级

1. ProviderDriver 联合类型没有 fx。
2. driver-registry 无 Fx adapter。
3. 创建接口拒绝未知driver，providers目录不会返回FX。
4. UI 无FX品牌/类型条目，模型选项及专属status/models解析也没有。
5. 通用 ACP local 可以手填 commandPath=fx、commandArgs=[acp]，但没有FX专属状态、默认模型、effort兼容层，**不能计作已经接入FX驱动**。

证据：T `packages/client-runtime/src/providerClients.ts:12,35`；`packages/provider-fx/src/settings.ts:15-36`；`client.ts:12-17`；`server/status.ts:32-229`；`server/acpSupport.ts:27-56,107-190,228-232`；`server/driver.ts:37-43`。V `packages/agent-contracts/src/provider.ts:1-3`；`apps/agent-server/src/providers/driver-registry.ts:1-16`；`routes.ts:162-165,235-239`；`apps/agent-web/src/settings/provider-card.tsx:17-29`。

## 12. 对齐工作需要覆盖的准确范围（仅差异清单，不开始实施）

- **全驱动公共层**：模型options合同→偏好保存→Composer选项→原生执行消费；模型隐藏/排序/共享收藏；专属environmentFields；默认实例显示/重置；更新/安装状态操作面。
- **Codex**：明确existing与managed流程，托管安装/账号profile/broker不应伪装成已实现；现有额外API-key登录不是来源managed流程。
- **Claude**：idle模式及宿主调度；模型effort/fast/thinking/contextWindow；原生登录入口差异。
- **Cursor**：CURSOR_API_KEY专属Setup字段；SDK params完整建模与下发。
- **Grok**：reasoningEffort；按来源区分外部原生登录与V额外应用内认证；版本维护。
- **OpenCode**：variant/agent与执行消费；明确底层供应商认证是V额外实现；v2自启密码语义。
- **Antigravity**：隐藏/约束自定义模型入口；安装状态/取消/移除；custom binary与托管安装关系；默认模型目录语义。OAuth配额已经存在，不重复开发。
- **Muse**：reasoningEffort与default模型入口；路径解析、认证入口、更新通道。
- **Pi**：launchArgs控件、thinking下发、external-login流程、更新入口。
- **ACP**：专用搜索→准备→身份→登录流程、字段显隐、环境认证落点、完整会话配置项。
- **FX**：完整新增类型/驱动/目录/设置与模型配置接线，不能只加前端图标。

本轮仅完成更新源码与只读差异调查，没有恢复之前暂停的实际验证，也没有发布本轮Provider界面。

<a id="v4-provider-alignment"></a>

## 13. v4 Provider 配置对齐实施

### 基准与分工

- 以本计划指定的 `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` 为准，读取既有 audit worktree；用户给出的 `t3code` 主工作树仍是较早的 `d53873b6a4`，没有修改或切换其工作区。
- 使用14个 `gpt-6.1-terra / xhigh` 子代理，分别负责公共合同、会话执行链、Provider 设置、Composer 及10类驱动；仓库代理定义为 `.omp/agents/provider-terra.md`。主线程整合备份 / 诊断 / 依赖与回归、HTTP、原生进程及浏览器验证。
- 保留 v4 独立 home、PM 范围重新核验及既有命令 / 文件 / 权限审批边界。不复制 t3code 的全局 CLI 账号回退，不引入项目级权限或工作项完成规则。

### 已实现范围

| 范围 | v4 实现与落点 |
| --- | --- |
| 公共合同与存储 | `packages/agent-contracts/src/provider.ts`、`providers/instances.ts`、`catalog.ts`：select / boolean descriptors、模型选项、环境变量敏感标记与脱敏回传、可清空名称、固定 ID、隐藏 / 排序 / 服务端共享收藏 / 模型默认选项；旧环境变量默认保密 |
| 状态与维护 | `providers/checks.ts`、`maintenance.ts`、`auth.ts`、`routes.ts`：版本 / 认证 / 可用性分离、健康刷新间隔（默认300秒、0关闭）、支持驱动的显式安装 / 更新 / 取消 / 移除；账号变更与维护等待所有执行 / 检查结束，状态检查不阻止并行会话 |
| 默认实例 | 初始化仅创建 Codex / Claude；其他驱动显式创建或定向进入，FX 在“显示更多”。重置清除默认实例覆盖；可选实例回到未配置状态，独立账号目录不删除，再创建使用新 revision |
| 设置与会话 | `apps/web/src/features/agent/src/settings/`、`composer-model-picker.aui.tsx`、`chat.ts`、`durable/chat-runtime.ts`、`providers/runtime.ts`：统一模型管理，默认模型 / 当前会话 / 继续 / 分叉保留选项与交互模式，并由各原生协议消费 |
| Codex | existing 外部登录；managed 固定版本安装、完整性校验、进度 / 取消 / 移除、ChatGPT 多账号 OAuth、OIDC 校验、令牌轮换及私有 broker；reasoningEffort / serviceTier、别名 / 推荐模型 / 版本门禁 / 目录刷新。凭据位于实例 home 的 `.managed-codex/credentials.json`，不混入公开配置 |
| Claude | `claude-catalog.ts`、`claude-usage.ts` 及宿主调度：effort / fast / thinking / contextWindow、四种 idle compaction 模式、实际 `/compact` 轮次与 PM 范围复核；外部认证 / 自定义端点及原生维护 |
| Cursor | 专属 `CURSOR_API_KEY` Setup 环境字段；完整 SDK 模型参数 descriptors、别名、默认值及实际 `model.params` / agent-plan 消费 |
| Grok | ACP 实际声明的 reasoningEffort；外部登录、`XAI_API_KEY`、版本兼容建议及原生 / npm / Homebrew 更新 |
| OpenCode | variant、build / plan 消费；自启动服务随机密码，不把外部服务密码语义用于自启；外部供应商认证、原生 / npm 更新 |
| Antigravity | 禁止自定义模型，真实推荐 / 旧模型标记；固定运行时安装、进度 / 取消 / 移除，自定义 binary 不冒充托管安装；既有 OAuth、API key、GCP 与配额流程保留 |
| Muse | default 模型与 reasoningEffort，`~` 路径解析、外部登录；按 `MUSE_CHANNEL` 识别 revision 版本并更新官方 launcher，默认关闭自动更新但允许实例显式环境覆盖 |
| Pi | 文本 launchArgs、按模型声明的 thinking 与默认模型、实际 `set_thinking_level`；外部 `/login` 指引及原生 / npm 更新 |
| ACP Registry | 搜索 / 预览 / 显式准备后进入身份与认证，local 命令独立短流程；元数据过滤、受控准备凭据、按声明顺序认证、env_var 敏感值保存；模型与会话 configOptions 的发现、应用及动态更新 |
| FX | 独立 driver / 品牌 / 设置入口，`status --json`、`models --json` 与 `fx acp`；default 与声明的 effort 档位、恢复会话、强制受监督 ask 模式；外部登录与手工维护，不伪造应用内安装 / 登录 |
| 诊断与备份 | FX 纳入类型和安全诊断；模型偏好、健康刷新设置与环境敏感元数据保留。`--secrets exclude` 清空环境值 / 敏感元数据并排除 provider homes；managed 凭据沿既有显式 include 边界处理 |

真实供应商账号、生产 OAuth 回调、真实安装下载、商业模型与 macOS 专属流程没有在本轮实际验收。源码中的完整实现与受控协议验证，不等于这些外部条件已经通过。

### 验证证据与限制

- HTTP 使用独立 Agent 数据目录与临时端口，实际验证10类驱动目录、非敏感环境回显、敏感值遮蔽 / 保留、清空显示名称、非法 ID、过期 revision、模型偏好、健康刷新0关闭、默认模型选项及不支持的维护动作拒绝。
- 受控 `fx` 可执行进程经过真实 `resolveProviderRuntime` / `runNativeRuntime` 与 ACP stdin/stdout：设置页保存的 effort 从 `xhigh` 改为 `max` 后，原生 `session/set_config_option` 收到对应值，回复为 `Controlled FX execution completed.`；API 进程重启后偏好仍保留，所有子进程 HOME 均为临时实例私有目录。
- 浏览器实际打开设置页并保存 / 刷新：环境变量、模型 effort、默认 `low` + `plan`；验证 FX“显示更多”、ACP 独立搜索 / local 分支、Cursor Setup、Pi 文本参数、Antigravity 无自定义模型入口、Codex managed 停用状态不发起认证 / 安装。生产构建页面点击可选默认实例重置后，真实 API 不再返回该配置，原账号目录标记仍存在；390px无页面横向溢出，生产验证页面记录0个浏览器错误。
- 最终 Provider 与离线备份回归 **264通过、0失败、0取消、0跳过**；client-runtime **11通过、0失败、0跳过**。保留了并行执行 / 状态检查及默认实例重置的失败前、修复后行为回归；补齐受控 Codex 的 `config/read` 与模型缓存刷新握手，Claude 测试环境不再继承宿主认证变量。
- 在并行 PM 改动出现前，Agent 全量为 **478通过、0失败、0取消、0跳过**，Agent 类型检查通过。最后一次整包重跑受到同时新增的 `pm-core-changes` / `pm-tools` 阻断：405个记录中393通过、12失败，主要为 `pm-core-changes/index.ts:20` 的 Node strip-only 不支持参数属性；当次 Agent tsc 还报告新模块合同类型与 `HeadersInit`。这些无关改动未被改写，不能将此前全绿当作当前整包全绿。
- `pnpm test:backend` 未完成：清单118个文件，运行至第50个时 `tests/agent-chat-access.integration.test.ts` 已不存在；第51个 `agent-chat-tools.integration.test.ts` 在3600秒命令限时到达后由运行器停止所属测试进程组。49份有效摘要合计432通过、0失败 / 跳过，但缺失文件、被中断用例及未运行文件均不能计作通过。
- 最后一次 Web 类型检查、统一 Web 生产构建、Agent 三个入口 esbuild 和打包 API 启动通过。构建保留既有大 chunk / workflow-canvas 混合导入告警；最后一次 scoped oxlint 无错误，但并行新增的 `pm/pm-core-changes.tsx` 未使用变量及 `durable/chat-runtime.ts` 新行有11条告警。
- `pnpm check:docs` 报出未修改文档 `agent-access-and-edit-boundaries.zh.md` 的3条失效引用，指向已不存在的 `agent-chat-config.ts`、`agent-chat-routes.ts`、`agent-chat-model.ts`；本次未为消除告警而恢复已删除路径。本次修改的4份 Markdown 已单独检查，相对文件 / 目录链接、显式锚点和代码围栏均通过。
- 截图及脱敏 JSON 证据保存在 `.local/evidence/provider-alignment-30eb7e7bb1/`。临时脚本、运行数据与构建目录已删除，测试浏览器与自建服务已关闭；未重启既有 v4 / 其他副本服务，未向既有工作区写入数据，未提交或推送。

本轮核心检查命令（结果边界以上述记录为准）：

```bash
TMPDIR=/tmp NODE_OPTIONS=--conditions=development pnpm --filter @agent-workspace/server exec node --test --test-concurrency=4 'src/providers/**/*.test.ts' 'src/maintenance/*.test.ts'
NODE_OPTIONS=--conditions=development pnpm --filter @agent-workspace/client-runtime test
pnpm typecheck:agent
pnpm --filter @pm/web typecheck
CHOKIDAR_USEPOLLING=true pnpm test:backend
pnpm check:docs
```

<a id="v4-codex-native-configuration"></a>

## 14. Codex existing 原生配置与免 OpenAI 登录状态修正

- 使用两个 `gpt-6.1-sol / xhigh` 子代理分别完成后端合同 / 原生状态与设置页，定义见 `.omp/agents/codex-sol.md`。主线程集成前端手动检查的结果标准化、实际原生 CLI / HTTP / 浏览器与构建验证。
- 按来源 `CodexProvider.ts` 的 `accountProbeStatus` 区分就绪与身份：已识别 API Key / ChatGPT 账号为 authenticated；无账号且原生明确 `requiresOpenaiAuth=false` 时可就绪但身份仍 unknown，`credentialSource` 保持 null；要求认证且无账号时失败。缺失 / 非法报告、矛盾认证状态和未知安装不推断成功，managed 不绕过 ChatGPT profile。
- `requiresOpenaiAuth` 贯通原生状态、公开实例、检查结果、持久观察和手动检查前端标准化。执行入口沿用同一条件，其他驱动的未知身份语义不变。
- existing 的只读 `codexConfig` 路径来自实际实例 home，包含默认 / 显式 / shadow 情况；不读取 `config.toml` 或凭据，不进入安全诊断导出，也不能由请求体伪造。设置页保留来源字段，明确原生 `model_provider` / `env_key` 与敏感实例环境变量的使用方式，不新增 API 卡片、全局凭据导入或原生配置编辑器。
- 真实安装的 Codex `0.163.0` 在临时独立目录中读取原生第三方配置，`account/read` 返回无账号及 `requiresOpenaiAuth=false`；经过实际应用 `resolveProviderRuntime` / `runNativeRuntime`，向本地受控 Responses 接口发出一次请求并完成原生回复。接收端确认合成密钥和模型，状态检查阶段没有推理请求。此证据不是商业服务、真实账号或远端密钥验收。
- Provider、合同、存储 / 诊断、备份、Chat 与执行引擎的定向回归 **343通过、0失败、0取消、0跳过**；Agent / Web 类型检查、受影响 lint、Agent 三入口与 Web 生产构建通过。Web 构建仍有既有大 chunk / workflow-canvas 混合导入告警。文档检查通过121份 Markdown、27个计划步骤及领域引用；未运行本次无关的 PostgreSQL 全量回归。
- 生产构建浏览器实际点击“检查 Agent”，复现并修复 `use-providers.ts` 标准化丢弃 `requiresOpenaiAuth` 的问题；修复后手动检查保留“原生就绪 / 无需 OpenAI 登录 / 身份未知”。实际验证显示名称保存使旧检查失效、未配置实例保持失败、managed / existing 切换不绕过账号要求、敏感值空白回显及390px无横向溢出，浏览器错误0个。
- 脱敏结果和桌面 / 窄屏截图保存在 `.local/evidence/codex-native-config/`。验证使用临时服务、独立配置和本地合成密钥；源码交付不等同于既有服务已发布。
- 不读取或导入全局凭据、不猜测用户接口 / 密钥、不改既有实例。原实例缺少真实配置时仍应失败，不能用本地合成配置或代码修复宣称该实例已经可用。

<a id="v4-native-provider-flow"></a>

## 15. 按 t3code 原生用户流程切换

### 实现范围

- 按用户最新要求取消前两轮的 Home 隔离例外，使用两个 `gpt-6.1-sol / xhigh` 子代理分别完成后端原生环境与前端配置流程，主线程负责跨模块接线、回归、实际运行与发布。代理预设为 `.omp/agents/codex-sol.md`。
- 继续以计划固定的 `30eb7e7bb1` audit worktree 为准；另核对用户指定主仓。参考仓库未修改。Codex / Claude 的空 Home、显式 Home、shadow 和环境优先级来自原生 Home helper；Claude 空 Home 保留原始 `CLAUDE_CONFIG_DIR`，不把解析路径重新注入环境。
- `providers/instances.ts` 分离原生 `homeDirectory` 与应用自有 `stateDirectory`。继承服务环境后叠加实例变量，不清除宿主 Provider 密钥，不重写 HOME / XDG；保留 PM / 数据库秘密和原生 loader 注入变量的既有排除边界。`scripts/services.mjs` 与桌面启动器同步继承，桌面诊断对新增继承的敏感值脱敏。
- 环境 / Home 身份变化使旧观察和原生续聊 revision 失效；Claude SDK 首次查询写入的 `CLAUDE_AGENT_SDK_VERSION` 不作为账号变更。Usage 读取迁至各驱动实际原生目录；重置和删除不触碰外部 Home，备份仅保留外部路径引用，恢复不创建该目录。
- Codex 使用“使用现有 CLI”或“继续使用 ChatGPT”入口，删除常驻模式下拉框、公开 `codexConfig` 合同、额外文件路径展示及配置文件教程。existing 不显示冗余 Setup、不强制应用登录；managed 自动准备运行时后进入真实 OAuth，保留账号选择 / 重连 / 移除与折叠 Runtime。
- Cursor 专属密钥保存后隐藏浏览器登录，清除并保存后恢复；不显示空 Runtime。ACP Registry 保留搜索 / 准备 / 身份 / 认证顺序，local 命令不强行打开认证弹窗。原有 PM 作用域、安全检查和业务完成规则不变。

### 本轮实际验证

- Agent 全量 **534通过、0失败、0取消、0跳过**；客户端运行时 **11通过**；桌面启动 / 策略 **5通过、0失败、0跳过**。修正旧隔离断言与 fixture，删除配置文案 / 环境转发的实现细节断言；保留 SDK 元数据不能误撤销可用性、真实身份变化应撤销观察、外部目录生命周期及备份边界的行为回归。
- Agent / Web 类型检查、受影响文件 oxlint、Contracts / Agent / Web 构建通过；文档检查覆盖121份 Markdown。Web 构建保留既有大 chunk 与混合导入提示，未修改关联的其他页面。
- 原生宿主调用：独立 Agent 数据和临时端口，Codex Home、Shadow Home、Launch arguments 均空，实例环境变量为零；未人工读取或复制凭据文件，原生程序沿用既有宿主配置。实际 `gpt-6.1-sol` 回复 `NATIVE_HOST_PROVIDER_OK`，generation 为 completed。PM 身份 / 目录由本地 fixture 提供，此证据不宣称真实 PM 登录或业务工具验收。
- 生产 Web + 实际 Codex `0.163.0`：仅在界面配置 Launch arguments，未创建或修改 `config.toml`，本地 Responses 接口确认先使用宿主合成凭据、再使用界面保存的实例覆盖；两轮均 completed 并显示 `PROVIDER_FLOW_OK`。覆盖后使用 portable handoff，不继续复用旧原生账号会话。接口为受控协议服务，不冒充商业模型。
- 浏览器实际创建 existing Codex 后无强制认证弹窗 / 冗余 Setup；验证敏感变量空白脱敏回显、Cursor key 保存 / 清除、离页保留草稿、local ACP 未安装如实报错且不打开认证、390px无页面横向溢出。
- managed 实际准备运行时成功，版本 `0.163.0`；真实 OAuth discovery 返回 HTTP **403**。独立请求同一公开地址也返回403，上游 `CodexChatGptAuth.ts` 使用相同地址与失败边界。未连接真实 ChatGPT 账号，不把运行时准备当 OAuth / 付费模型成功，也不声称发生了网络安装下载。
- 脱敏记录和界面证据保留在 `.local/evidence/provider-native-flow/`。其他供应商真实账号、ChatGPT 授权完成、macOS Keychain 及容器 / 远端环境仍需各自验收。

### 发布与独立环境阻塞

- 2026-10-29 已发布生产 Web 至 `3224`，重新构建并启动 Agent API `4325`，新 PID 为 `20047`。PM API `23399`、Worker `23398`、网关 `23401` 的 PID / 启动身份均保持不变。
- 在实际 `3224` 设置页点击“检查 Agent”，`POST /agent/api/providers/codex/test` 返回200，`lastConnectionTest.ok=true`；Home / Shadow Home / Launch arguments 为空、实例变量为零，原生认证为 authenticated，模型列表包含 `gpt-6.1-sol`。桌面截图与脱敏响应保存在同一证据目录；390px 页面宽度与滚动宽度均为390，标题没有被挤成单字列。
- 统一启动命令曾因 PM `/health/ready` 返回503回滚新 Agent；随后按相同角色配置单独恢复并登记 Agent，没有绕过或修改 PM 的就绪判定。只读事务确认 v4 数据库已应用38项迁移、源码与生产目录期望39项，唯一缺项为 `0039_document_sources.sql`，无额外迁移或 checksum 差异。
- 该文档来源迁移不属于本次 Provider 修改，未擅自执行。当前 Provider 配置 / 原生调用证据不等于整套 PM 已就绪，真实 PM 登录 / 业务工具仍未在本轮验收；ChatGPT OAuth 也仍受上文403阻塞。

<a id="v4-composer-model-picker-fix"></a>

## 16. 新会话输入框模型列表修复

- 用户反馈设置页有模型，但输入框没有可用模型。真实目录返回8个已安装、已认证的 Codex 可见模型；全局默认为 unset。`composer-model-picker.aui.tsx` 把尚未选择模型的空 Provider ID 直接用于分区过滤，导致目录已有模型、弹窗却为空。
- 将弹窗浏览分区与实际模型选择分开：空 / 已移除的分区优先浏览当前 Provider 或有可选模型的 Provider；后到的目录同样重新解析。侧栏选中标记、列表和说明使用同一浏览 Provider，不自动写入会话或全局默认值。刷新未结束时不显示误导性的空目录提示。
- 2026-10-29 已仅发布 Web 至 `3224`，四个后台进程 PID 保持不变。真实聊天页面直接打开弹窗即可看到8个可选模型，无需先点 Provider 图标；取消后仍未选择、不创建会话、不修改默认值。
- 在真实工作区的新空会话中点选 `GPT-6.1-Sol`，服务端保存为 `codex / gpt-6.1-sol`、revision 1；刷新保留选择，输入文字后发送按钮可用。验收没有发送消息或执行模型；该空会话随后通过既有删除 API 清理，读回404，原会话均保留。
- 暂缓真实 `/agent/api/providers` 请求再放行，验证加载时仅显示加载状态、无假空列表；到达后显示8个模型，仍无自动选中。未伪造模型响应。390px 视口与文档滚动宽度均为390。
- 本轮受影响文件 oxlint、Web TypeScript 与生产 Vite 构建通过，保留既有大 chunk / 混合导入提示；未修改后端合同、权限或运行逻辑。截图、发布与行为证据见 `.local/evidence/model-picker-fix/`，不沿用上一轮534项后端测试冒充本轮回归。

<a id="v4-composer-effort"></a>

## 17. 输入框思考程度与用量展示调整

- 两个 `gpt-6.1-sol / xhigh` 子代理分别实现能力菜单与隔离原生验证服务，主线程完成用量隐藏、集成和浏览器验证。只读对照主参考仓库 `TraitsPicker.tsx`、`modelTraits.ts` 与共享 descriptor 解析，以及 `30eb7e7bb1` 的能力菜单 / EffortGlyph 语义，不修改参考仓库。
- 用 `composer-traits-picker.aui.tsx` 替换输入框泛化的“选项”弹窗：模型旁直接显示当前思考程度，分组单选菜单呈现 Provider 实际声明的档位、默认标记、描述和布尔选项；保留并行界面更新中的独立交互模式按钮。未选模型不伪造思考档位；失效值明确提示，不静默替换。
- 更改某项保留其他 `modelOptions`；沿用当前会话 revision 保存，不修改全局默认或原生配置文件。保存期间禁止重复选择和实际提交；成功关闭菜单，失败保留修改并提供显式重试。
- 按用户要求删除自动上下文 / token / 费用行和“本轮供应商用量”区域，同时删除会话用量轮询及失去用途的展示辅助函数 / 测试。后台用量采集、独立 Usage 页与显式 `/usage-limits` 保留。
- 生产 Web 构建的真实浏览器验证：选择 `Extra High` 后服务端保存 `reasoningEffort=xhigh`，刷新回读保持，修改思考程度保留 `serviceTier=priority`；受控503保存失败时提示明确、持久值未变，显式重试后成功；延迟保存时能力菜单不能重复选择。当前并行界面中实际点击错误状态的发送按钮，不创建新的原生 generation，草稿保留。另验证键盘导航、原生运行期间禁用和390px菜单无横向溢出。
- 使用实际安装的 Codex app-server、真实 Agent HTTP / SQLite / 原生续聊链路和受控本地 Responses 服务，完成两轮请求；两次出站请求均为 `gpt-6.1-sol`、`reasoning.effort=xhigh`，两次原生 generation 均 completed 并收到 `EFFORT_FLOW_OK`。第二轮保留服务档位和原生会话连续性。固定回复与 token 数属于受控协议数据，不是商业模型推理或账单验收。
- 隔离首轮调用曾在到达 fixture 前返回502；仅为临时 Provider 显式设置 loopback `NO_PROXY` / `no_proxy` 后完成上述两轮。未读取或改变生产凭据、Home、环境配置或 Provider 设置。
- 原生用量账本实际有 context、reportedTurn 和 totals 时，输入框仍不显示自动用量。`/usage-limits` 仅发出一次快照 GET，无线程用量轮询、额度刷新或新增模型请求。
- 本轮 Web 类型检查、受影响文件 oxlint、2项既有 Usage 行为测试与 Vite 生产构建通过；保留既有大 chunk / 混合导入提示。证据见 `.local/evidence/composer-effort/`，没有重跑或沿用历史后端测试冒充本轮验收。
- 2026-10-29 本轮只发布 Web，不重启既有服务。随后并行聊天 UI 继续发布，保留其新布局，不用旧构建覆盖。在当前实际 `3224` 页面创建独立空会话，保存 `codex / gpt-6.1-sol / xhigh` 后 revision 为2；刷新仍显示 `Extra High · Standard`，输入文字后可发送，390px无横向溢出，两块用量均隐藏。没有发送真实工作区消息；该验收空会话删除成功、读回404，原四个会话及全局默认均保留。
- 保留并行更改后，重新完成当前源码的类型检查、受影响 lint、2项 Usage 测试和临时生产构建，并再次用当前界面完成 `xhigh` / `priority` 保存、失败重试和一次真实 Codex 协议调用：请求为 `reasoning.effort=xhigh`、原生 generation completed，非空用量仍隐藏，额度命令不增加模型请求。该临时构建仅用于验证，没有再次覆盖并行发布；证据为 `current-source.json`。

## 18. OpenCode 版本识别修复与真实调用验证（2026-10-30）

- 本机 OpenCode `--version` 返回 `opencode v2.1.2`，原版本表达式要求数字前有单词边界，无法识别紧邻 `v` 的版本号；实例配置已保存，但检查在启动原生服务之前失败。检查 / 执行启动与更新入口均改为接受可选 `v` 前缀，继续支持裸版本号及原有最低版本检查。
- 既有原生进程与更新回归使用真实子进程覆盖带前缀的2.x输出和裸1.x输出；OpenCode 原生协议、输出及信息提问共 **51通过、0失败、0跳过**。受影响文件 oxlint、Agent 源码 / 测试类型检查及生产构建通过。
- 核验无活跃聊天及进程归属后，仅重启 v4 Agent API `4325` 并更新服务登记；PM API、Worker、网关保持原 PID，未重建或覆盖 Web。实际 `3224` 提供商页面点击“检查 Agent”成功，识别版本 `2.1.2`，返回157个原生模型；刷新页面后模型可见。目录检查不是全部模型的推理验收。
- 使用既有原生账号与环境，`opencode-go/minimax-m3.1-flash` 在临时目录通过实际驱动调用返回 `OPENCODE_SMOKE_OK 42`；再在真实授权工作区创建独立 Chat 会话，通过已发布 HTTP / SSE 调用返回 `OPENCODE_CHAT_OK 42`，generation 为 completed，流无错误。浏览器实际显示回复与“运行完成”，历史重读包含回复；随后仅删除本次临时 Chat 会话，读回404，原5个会话保留。
- 调用边界：`opencode/gpt-6.1-sol` 实测返回 `provider.quota` / HTTP 402，不能因连接检查成功宣称该模型可用；首次 `azure/gpt-6.1-sol` 返回原生执行失败，未确认其具体供应商原因。没有改写密钥、默认模型、账号、额度或业务完成规则，也未验收其他目录模型。
- 会话与持久化仍暂沿用 Agent Chat 保存方式，尚未经过统一设计收口；本次不改变该边界。

