# Provider → PM 宿主合同

合同标识 `pm-provider-host/1`，固定配置/协议来源 `t3code@30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`。本页提炼仍有效的宿主规范；不把历史任务编号、冻结声明或测试数当作当前实现通过证明。可执行类型以[宿主声明](../../apps/server/agent/src/providers/t3code/contract.ts)与[固定上游来源/补丁](../../vendor/t3code/SYNC.md)为准。

## 唯一所有权

- `@agent-workspace/contracts` 与现有 HTTP/SSE 是本地外层 API；协议、SDK、驱动、模型schema和原生事件实际使用固定上游模块，不再保留另一套手写Provider协议。
- 上游 RunId/RunAttemptId/NodeId 仅映射Chat generation的技术身份，不创建PM业务Execution/Run、t3 Orchestrator、投影库或新的恢复引擎。
- PM工具共享原注册表、当前认证/scope、能力、revision、审批与原operationId收据；Provider turn completed、CLI退出0和模型回复都不是业务完成收据。
- Chat仍使用原Agent SQLite records/输出journal；只增加必要Provider continuation附属记录。**会话与持久化统一设计尚未收口。**

## 租约、Scope 与环境

每次租约绑定dataDirectory、instanceId、单调revision、有效cwd、原生Home、环境身份。resolve、acquire、fork、startTurn及迟到callback均核对当前绑定；旧租约不能静默升级为新配置。认证/维护与执行共享既有互斥，credential/installation binding相同的实例也需联锁；释放幂等并覆盖所有失败路径。

原driver Scope覆盖实例使用期，原session Scope覆盖订阅、ensure/resume/startTurn、交互、真实终态、最终持久化和清理。订阅先于启动，仅一个事件consumer；等待信息答案不能阻塞主事件处理。浏览器SSE断开只释放listener，不自动取消后台generation。只停止本应用拥有的原生进程/连接，不停止外部OpenCode服务或删除原生Home。

配置/账号/Home/环境变化经过CAS和单调revision，失效检查、模型、限额、租约和续聊；中断/取消维护不能重新信任旧revision。服务重启把在途Chat标interrupted、在途PM调用标unknown，不自动startTurn或重放prompt。

实例环境由受信context生成，排除PM/数据库等保留变量，不修改全局process.env来伪造实例隔离。HOME/USERPROFILE/XDG_*遵循原生语义，不统一重指应用state；Codex existing使用原配置，managed显式使用应用私有状态。应用凭据端口只读写本应用拥有记录，0700/0600、原子发布；不导入外部全局账号。模型必须显式有效，不静默fallback。历史usage租约可读取已禁用实例，但不得取得执行实例。

## PM transport 与权限

受信Chat execution identity绑定thread/generation/message/scope。存在PM bridge而缺少identity时在startTurn前失败；非Chat无工具调用仅分配技术身份，不伪造PM授权。runtime binding在openSession前建立，冲突不得覆盖live binding；finalizer只清自己拥有的token。

原生MCP/ACP/SDK/Host Tools只承载同一generation的PM桥，不注入t3业务/browser/device授权。原生permission请求默认拒绝；信息问题回答不能转成权限accept。允许匹配本session的PM transport admission不代表批准业务动作；后者仍由PM能力/审批/revision判断。标题、探测、用量刷新和技术性压缩不获得业务工具，不提供acceptAlways。

目录/cwd是执行定位，不是文件系统沙箱。Agent仍面向可信本机单操作者，尚无按PM成员隔离的会话所有权。

## 续聊、分支与结果

NativeSessionRef.sessionId是原生会话/thread ID，不是上游providerSessionId或本地generation。continuation附属记录校验实例/revision/cwd/Home/精确dialect、原生session、所属Chat thread与实际turn边界；不持久化认证头、凭据、MCP连接URL或live响应closure。

- 续聊只发送当前新消息，不重发完整历史；模型切换服从实际能力，不隐式换模型/新会话。
- Fork只使用原生强边界；不能退到live head。Fork已开始但目标或持久化无法确认时保留未知，不自动再fork。
- 旧历史缺sidecar不直接删除或统一拒绝；只用零prompt的原生metadata核对接纳，可证明不兼容时返回session_mismatch并保留历史供显式portable handoff。
- 原生回调/Schema/清理失败必须向上失败，不吞成成功或空结果。成功要有匹配root turn终态、最终条目/usage/session回调与清理；EOF、HTTP200或进程退出0不能替代。
- completed/failed/cancelled/interrupted分别保存；取消请求不等于原生已停止。未知PM副作用只查原operationId，不因为上游retryable而自动重放。

## 输出、交互与 Usage

上游事件唯一映射到generation作用域的累积item；正文、message与turn item不双写，命令实时tail与最终完整结果不重复追加。root/child终态不能混用。现有snapshot/sequence、背压reset和有界队列继续使用，不新建event store。迟到/重复/原生已关闭或重启后丢closure的交互不可回答。

Usage按真实turn分类去重，context不当本轮计费，reasoning不重复加到output；缺值不补零。历史原生来源优先，缓存按实例/环境/Home/cwd/revision绑定；刷新不触发推理、兑换额度或自动重试，stale/partial/unsupported/失败分别报告。

认证、安装/维护、模型目录、原生可运行、付费推理与正式部署是不同验收层次；真实账号/平台未验收不得由模块测试替代。打包必须包含实际SDK worker、扩展、资源与单一Effect运行时，不依赖来源仓库路径或开发机dist缓存。
