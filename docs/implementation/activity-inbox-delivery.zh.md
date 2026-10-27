# 站内定向通知与历史活动状态：实现与客户端合同

## 当前范围

正式 `/pm/<workspace>/notifications?view=inbox3|inbox4` 默认读取**定向通知**，同页可切换**历史活动状态**。它不是邮件／Push，既不自动关注，也不授予任务访问权。项目／任务／里程碑仍以 Markdown 为权威；通知不决定任务完成。

批准矩阵与 N01–N10 见[通知合同](service-notification-routing-plan.zh.md)。当前源码/共享接线、真实数据库/文件/独立 Worker 回归和已读/归档/取消归档浏览器已执行，见[五包交付](service-completion-and-acceptance.zh.md#five-package-delivery)；业务实例未迁移。下方旧版浏览器记录仍为历史，不代替新路由证明。

- 共用 `service_fact_events` 只含安全事实身份／范围／revision／类别／真实时间；站内与 Webhook 独立消费，评论、legacy、提及／关注者及认证私密内容不外发。
- 任务受控保存、有效外部观测和 SQL 评论按批准矩阵路由：冻结显式关注候选与本次新增个人提及，取并集，同事实同人一条；可信操作者本人排除。创建／指派／评论／被提及不自动关注。
- 受控文件保存先在核心串行队列内 fsync durable fact；SQL 事实／原收据／审计失败由独立 API importer 按原身份恢复，不重写文件。普通 prepared 更新不能仅凭今天相同字节推定已提交；只有精确创建台账可证明的 prepared 创建可恢复。命令不是原生 HTTP 结果的替代收据。
- `.pm/state/service-observations.json` 存安全摘要／基线／真实观测，不存正文。首次只建基线，离线 A→B→C 只能记录实际 A→C；无可信作者不展开提及。无效源保留 gap，不以 cache 重建或 watcher 触发次数制造历史。
- Worker 的只读 core port 实读当前源文件／关系／身份，检查重复 ID、墓碑、扫描稳定性和原项目；不初始化 Workspace／cache／state、不建立 watcher。SQL 工作区锁先于受控核心队列；捕获回调用原 SQL executor，不在队列内另取数据库锁。
- 路由使用独立有界 lease／epoch、候选 checkpoint 和失败退避；个人 recipient、deliveryCursor 与私有失效在同一 SQL 事务。取消关注只撤销尚未送达且仅依赖同一 watch 版本的候选，不删除已送达历史；提及不是长期订阅。
- 列表／状态写入／原收据重读都重查当前本人、成员与项目／任务绑定；移动／删除后失败关闭，不把旧历史移给新项目。legacy 非任务独立按原范围／私有 audience 裁剪，允许空任务 target，不丢其个人状态。

## HTTP、CAS 与正式前端

`GET /api/v1/workspaces/{workspaceId}/notification-inbox?origin=routed|legacy_activity&after=...&through=...` 只从本人真实 recipients 扫描；每页最多 200 个位置。空隐藏页仍前移 cursor；固定首屏 head，membershipVersion／会话变化丢弃整个合并快照。deliveryCursor 与 factSequence、SSE cursor 不混用。返回 `sourceCoverage`、激活／旧 implicit-unread 边界和真实 processing `current|pending|error`，不冒用 SSE retention。

| commandType | payload | scope／CAS |
| --- | --- | --- |
| `SetNotificationRead` | `{read:boolean}` | `targetId=factId`，不传 recipientId／projectId；`expectedVersions[factId]=本人 state.version` |
| `SetNotificationArchived` | `{archived:boolean}` | 同上；read/archive 独立 |

同值核对 CAS 不增版本，实际改变递增。原 commandId 同参恢复、改参冲突；unknown 用原 IndexedDB journal 查收据，不换类型／ID重发。打开目标不标已读。`NotificationInboxChanged` outbox 只含接收 actor 聚合与空 payload，不成为新通知事实。

正文与评论共同使用 `[@显示名](pm-user:规范小写UUID)` AST 协议；代码、引用、HTML、图片、数学、隐藏评论、转义、引用式链接不激活。仅校验本次新增集合，历史撤权 token 不阻塞无关编辑；50 个唯一 ID 上限整体拒绝。真实候选接口要求 `domain.read` 与 `directory.read`，只返 `{userId,name}`，无 email。渲染是非外联中性成员 chip，不把作者输入标签当可信姓名。

实现位于 `packages/application/src/notifications.ts`、`notification-routing.ts`、`notification-mentions.ts`，严格 DTO 位于 `packages/contracts/src/notifications.ts`；正式 hooks 为 `pm-notification-hooks.ts`。页面复用现有私有 Query、CommandNotice、SSE、命令协调器；评论以所属 taskId＋真实 `#comment-ID` 跳转，不把 commentId 当任务 ID。

## 一次性旧状态迁移与运维

迁移 `0026_service_facts_notifications.sql` 在停旧写／暂停 retention 的部署窗口内，持有工作区锁：

1. 只复制仍保留且已有真实 `activity_states` 的事件；factId 沿用原 eventId，逐 actor 保留版本与 read/archive 原时间，包括回到未读／未归档的高版本。
2. 未操作的旧 implicit unread 不全成员扇出；已被旧 retention 清掉的事件不伪造。未知或无法确认私有 audience 的 legacy 行内部保留并隔离。
3. 保存迁移 manifest／激活边界，删除旧状态表和旧新写入口。`events` 继续 changes/SSE 原职，prune 不再级联删除新通知。
4. 旧 SetActivity* 原收据仍可按原 ID 查询，但不提供旧命令写入别名。激活后修复优先暂停新路由，保留事实／状态／原 job；不降库重置 CAS。

SQL、Markdown 与全部 `.pm/state` 要求同一停写检查点备份。独立恢复一边不等于一致恢复；checkpoint 超前明确报错，不重置游标。物理保留／删除／法律策略未由用户选择前不自动 GC，归档不等于删除，也不承诺无限保留 SLA。

运维命令（由部署环境提供 DATABASE_URL，不打印连接串）：

```bash
node --env-file=.env scripts/notification-admin.ts status --workspace UUID
node --env-file=.env scripts/notification-admin.ts retry --workspace UUID --fact UUID
```

重试只接受 failed 原 factId，增加 epoch，原候选 checkpoint／已送达 state 不重置；OS operator UID、factId、epoch 维护审计与重试事务一并持久化。

## 本轮待统一运行的回归源码

- `tests/personal-mentions.test.ts`：canonical UUID／AST 字面上下文／集合差／上限／中性非外联渲染。
- `packages/pm-core/tests/service-facts.test.ts`：真实文件基线／观测／错误 gap、串行实际提交边界、语义分类及只读 port 不创建 `.pm`。
- `tests/core-fact-recovery.test.ts`：真实文件在 completed fsync 前中断；精确创建证明在首次观测前恢复，普通 prepared 更新即使字节相同也不伪造可信归属。
- `tests/notification-inbox-model.test.ts`：安全 DTO、来源／双理由、可信时间 fallback、数值 delivery cursor／筛选／CAS映射。
- `tests/notification-routing.integration.test.ts`：真实 PG／HTTP／文件／Worker 应用路径、当前权限／移动删除后收据拒绝、候选冻结／自排除、SQL故障及原事实恢复、离线观测、页回滚／lease／重复送达。
- `tests/notification-migration.integration.test.ts`：真实0024库升级、原 ID／版本／时间／私有非任务状态无损及 prune 独立性。

没有执行 build、lint、tests、formatter、真实浏览器或服务冒烟；上述是源码覆盖，不是通过报告。当前工具没有 LSP 引用设备，导出调用者使用仓库 grep 定位，不伪造 LSP 证据。

### 旧版活动入口的历史服务与浏览器观察（不适用于新路由验收）

真实 HTTP 专项使用独立随机 PostgreSQL schema、临时 Markdown/Blob 根目录和自有 API，5 组场景实际通过：两 actor 状态/收据隔离、重复键与旧 CAS；跨工作区/任意 ID/私有事件与非递归失效；撤权后事件和收据拒绝；真实 outbox 插入故障原子回滚；过期级联和原收据不复活事件。该独立夹具已清理，机器结果为 `.local/evidence/activity-inbox/http-results.json`，不是 node:test 的通过声明。

真实浏览器使用父线程 production 构建、临时 preview `3372` / API `33713`，owner 与另一 owner 标签页使用 `pm-inbox.localhost`，reader 使用 `pm-inbox-reader.localhost`，避免与其他专项跨端口 Cookie 串扰：

| 场景 | 实际观察 |
| --- | --- |
| inbox3 / inbox4 写入 | inbox3 实际标已读按钮提交后，inbox4 第二标签页由 SSE 收敛；inbox4 实际归档、归档文件夹、恢复按钮可用，已读不被改变，刷新仍保留 |
| 两用户 | reader 的同一事件仍未读；reader 归档不影响 owner 的收件箱与已读状态；双方只看到自己的私有便签事件 |
| 丢响应核对 | CDP 在真实 200 响应阶段丢弃一次已提交命令响应；unknown 原 commandId 跨刷新保留，实际“查询原命令收据”按钮恢复；状态仅从 v4 到 v5，没有重发副作用 |
| 旧版本冲突 | 暂缓真实刷新响应而保留 v5 快照，另一真实请求提交 v6；旧 UI 按钮收到服务真实 409 `version_conflict`，不覆盖 v6 |
| 筛选/批量 | 搜索真实缩小结果；菜单最早排序与未读优先组合正确；inbox3 本页标已读串行完成多个实际命令，无 pending 碰撞 |
| 撤权 | 实际成员命令移除 reader 项目范围，浏览器刷新不再显示已归档事件及关联对象元数据 |
| 窄屏/运行时 | 390px viewport / scrollWidth 均为390；三页 JavaScript pageerror 为0。不是物理触屏/完整设备验证 |

截图 `unknown-receipt.png`、`inbox4-desktop.png`（保留真实冲突提示）、`inbox4-mobile.png`、`reader-revoked.png` 与服务状态/收据摘要保存在 `.local/evidence/activity-inbox/`。HTTP 夹具 setup 与浏览器实际按钮操作分开记录；没有固定成功响应拦截，也未读取凭据文件、修改默认业务数据或重启默认服务。父线程重建后的最终 production 产物已在 inbox3 / inbox4 实际重载核对常显历史边界，补充截图为 `inbox3-final-notice.png`、`inbox4-final-notice-mobile.png`，后者仍为390px无横向溢出。

清理：HTTP 夹具与浏览器夹具均已完成自己的 schema/临时 Markdown 与 Blob 根目录删除；浏览器夹具输出 `ACTIVITY_INBOX_SMOKE_CLEANED`。自有 API、开发/preview 服务及3个浏览器标签页已停止/关闭，一次性脚本已删除。保留必要机器 JSON 与截图，不保留 Cookie、令牌、密码或数据库 URL。未触碰既有业务数据和默认服务。

## 仍需用户／运营输入

已批准的个人提及、显式关注、自排除和当前权限矩阵不再作为未决项。尚未替用户选择的扩展只有：

1. 通知／迁入历史的物理保留、个人删除及法律／备份保留；任何 GC 或对外保留 SLA 之前需明确。
2. 扩大事件矩阵、受派即通知、项目／团队关注、本人操作、团队提及、邮件／Push、摘要／静默或到期调度；本批均未擅自启用。
3. 外部文件保存当时的历史关注或完整离线中间历史；现有真实观测不能承诺这些信息。
4. 跨项目历史受众迁移；保留原项目失败关闭，需显式产品决定。
5. 业务库激活的停写窗口、一致备份位置及恢复责任人；本实施者未操作用户服务。
