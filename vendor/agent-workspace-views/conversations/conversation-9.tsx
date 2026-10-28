"use client"
import { Check, Circle, LoaderCircle, Pin } from "lucide-react"
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui"
import { ThreadMessage, ThreadPanel, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation9Controller } from "./conversation-9-controller"
import styles from "./conversation-9-12.module.css"
export function Conversation9View({
  controller: c,
  host,
}: {
  controller: Conversation9Controller
  host: ComposerHost
}) {
  const { label, copy, phase } = c
  const status =
    phase === "waiting"
      ? label("等待审批", "Waiting for approval")
      : phase === "running"
        ? label("本地演示执行中", "Local demonstration running")
        : phase === "completed"
          ? label("本地演示完成", "Local demonstration completed")
          : phase === "unknown"
            ? label("结果未知 · 必须先查询", "Unknown outcome · query first")
            : phase === "rejected"
              ? label("已拒绝", "Rejected")
              : label(
                  "已确认失败 · 重新审阅",
                  "Confirmed failure · review again",
                )
  const navigation = (
    <nav
      className={styles.navigation}
      aria-label={label("运行会话", "Runtime sessions")}
    >
      <Button variant="outline" onClick={() => c.newSession()}>
        {label("新会话", "New session")}
      </Button>
      <Button variant="ghost" onClick={() => c.setDialog("search")}>
        {label("搜索会话", "Search sessions")}
      </Button>
      <h3>
        <Pin size={14} />
        {label("固定会话", "Pinned")} · 2
      </h3>
      {c.chats.slice(0, 2).map((s, i) => (
        <Button
          key={s.id}
          variant="ghost"
          aria-current={c.selectedId === s.id ? "page" : undefined}
          onClick={() => c.selectSession(s)}
        >
          {copy(s.title)}
          <small>
            {i === 0 ? status : label("工作中 · 43 秒", "Working · 43s")}
          </small>
          <small>
            admin ·{" "}
            {i === 0
              ? "feat/billing-webhooks · #624"
              : "feat/repository · #619"}{" "}
            · {label("本地", "Local")}
          </small>
        </Button>
      ))}
      <h3>
        {label("会话", "Sessions")} · {Math.max(0, c.chats.length - 2)}
      </h3>
      {c.chats.slice(2).map((s, i) => (
        <Button
          key={s.id}
          variant="ghost"
          aria-current={c.selectedId === s.id ? "page" : undefined}
          onClick={() => c.selectSession(s)}
        >
          {copy(s.title)}
          <small>
            {label("工作中 · 4 分钟", "Working · 4m")} · {s.messages.length}{" "}
            {label("消息", "messages")}
          </small>
          <small>
            admin · fix/preview · #{617 - i} · {label("本地", "Local")}
          </small>
        </Button>
      ))}
      <p>
        {label(
          "运行状态来自固定本地演示；无部署或生产 API 权限。",
          "Runtime metadata is a local fixture; no deployment or production API access.",
        )}
      </p>
    </nav>
  )
  return (
    <ThreadView
      page="conversation-9"
      controller={c}
      host={host}
      workspaceNavigation={navigation}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={c}
          agentRole={
            message.role === "assistant"
              ? label("迁移 Agent", "Migration agent")
              : undefined
          }
        >
          {message.id === "conversation-9-answer" && (
            <div className={styles.modules}>
              <Collapsible open={c.planOpen} onOpenChange={c.setPlanOpen}>
                <ThreadPanel
                  title={label(
                    "安全迁移账单 webhooks",
                    "Migrate billing webhooks safely",
                  )}
                  actions={
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm">
                        {label("展开/收起计划", "Toggle plan")}
                      </Button>
                    </CollapsibleTrigger>
                  }
                >
                  <p className={styles.meta}>
                    {label(
                      "先检查、审批、回放签名事件，再保留可逆检查点。",
                      "Inspect first, request approval, replay signed events, and retain a reversible checkpoint.",
                    )}
                  </p>
                  <CollapsibleContent forceMount>
                    <ol className={styles.steps}>
                      {c.steps.map((s, i) => (
                        <li key={s.id}>
                          {i < c.step ? (
                            <Check size={16} />
                          ) : phase === "running" && i === c.step ? (
                            <LoaderCircle size={16} />
                          ) : (
                            <Circle size={16} />
                          )}
                          <div>
                            {copy(s.title)}
                            {(phase === "running" || phase === "completed") && (
                              <small>{copy(s.detail)}</small>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </CollapsibleContent>
                  <div className={styles.row}>
                    <span>4 {label("步骤", "steps")}</span>
                    <strong role="status">{status}</strong>
                  </div>
                </ThreadPanel>
              </Collapsible>
              {phase === "waiting" && (
                <ThreadPanel
                  title={label(
                    "允许更改三个账单 webhook 处理器？",
                    "Allow changes to three billing webhook handlers?",
                  )}
                >
                  <p>
                    {label(
                      "此审批只用于本地演示。可切换处理器与回放 fixture 快照；不能部署、轮换密钥、联系生产 API、编辑真实文件或运行 Shell。",
                      "Local demonstration approval only: switch handler and replay fixture snapshots. No deployment, secret rotation, production API, real file edits, or Shell execution.",
                    )}
                  </p>
                  <div className={styles.actions}>
                    <Button
                      variant="outline"
                      onClick={() => c.action("reject")}
                    >
                      {label("拒绝", "Reject")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => c.action("always")}
                    >
                      {label(
                        "始终允许（仅此本地会话）",
                        "Always allow (local session only)",
                      )}
                    </Button>
                    <Button onClick={() => c.action("accept")}>
                      {label("允许一次", "Approve once")}
                    </Button>
                  </div>
                </ThreadPanel>
              )}
              {phase === "unknown" && (
                <Button variant="outline" onClick={() => c.action("reconcile")}>
                  {label("查询本地回执", "Query local receipt")}
                </Button>
              )}
              {(phase === "failed" || phase === "rejected") && (
                <Button variant="outline" onClick={() => c.action("retry")}>
                  {label("重新审阅请求", "Review request again")}
                </Button>
              )}
              {phase === "running" && (
                <>
                  <p>
                    {label("授权范围：", "Approval scope: ")}
                    {c.approval === "session"
                      ? label("仅此本地会话", "This local session only")
                      : label("仅此演示一次", "This demonstration once")}
                  </p>
                  <Button onClick={c.advance}>
                    {label("推进演示步骤", "Advance example step")}
                  </Button>
                </>
              )}
              <div className={styles.actions}>
                <Button variant="outline" onClick={c.saveCheckpoint}>
                  {label("保存本地检查点", "Save local checkpoint")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!c.checkpoint}
                  onClick={c.restoreCheckpoint}
                >
                  {label("恢复本地检查点", "Restore local checkpoint")}
                </Button>
              </div>
              {c.checkpoint && (
                <p className={styles.meta} role="status">
                  {label("检查点已保留：", "Checkpoint retained: ")}
                  {c.checkpoint.step}/4 · {c.checkpoint.phase}
                </p>
              )}
            </div>
          )}
        </ThreadMessage>
      )}
    />
  )
}
