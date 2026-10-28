"use client"
import { Check, CircleX, FileCode2 } from "lucide-react"
import { CodePreview } from "./resources"
import {
  Button,
  Progress,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui"
import { ThreadMessage, ThreadPanel, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation12Controller } from "./conversation-12-controller"
import styles from "./conversation-9-12.module.css"
export function Conversation12View({
  controller: c,
  host,
}: {
  controller: Conversation12Controller
  host: ComposerHost
}) {
  const { label, phase } = c
  const passed = phase === "completed"
  const unknown = phase === "unknown"
  const file = c.frame === "test" ? "bulk-actions.test.tsx" : "bulk-actions.tsx"
  return (
    <ThreadView
      page="conversation-12"
      controller={c}
      host={host}
      renderMessage={(message) => (
        <ThreadMessage
          message={message}
          controller={c}
          hideContent={message.id === "conversation-12-answer"}
          agentRole={
            message.role === "assistant"
              ? label("验证 Agent", "Verification agent")
              : undefined
          }
        >
          {message.id === "conversation-12-answer" && (
            <div className={styles.modules}>
              <p>
                {unknown
                  ? label(
                      "执行记录结果未知；必须先查询本地回执，不能直接重跑。",
                      "The execution record outcome is unknown; query the local receipt before rerun.",
                    )
                  : passed
                    ? label(
                        "修复后的本地记录显示两个用例通过。修复与重跑只切换快照，不执行 Vitest、Shell 或写入文件。",
                        "The fixed local record shows both tests passing. Fix and rerun switches snapshots only: no Vitest, Shell, or file writes.",
                      )
                    : c.copy(message.text)}
              </p>
              <ThreadPanel
                title={label(
                  "验证 bulk-actions.test.tsx",
                  "Verify bulk-actions.test.tsx",
                )}
                actions={
                  <strong role="status">
                    {unknown
                      ? label("结果未知", "Unknown outcome")
                      : passed
                        ? label("通过 · 本地记录", "Passed · Local record")
                        : label("错误 · 本地记录", "Error · Local record")}
                  </strong>
                }
              >
                <p className={styles.meta}>
                  Vitest ·{" "}
                  {unknown
                    ? label("先查询回执", "Query receipt first")
                    : passed
                      ? "2 passed · exit 0"
                      : "1 test failed · exit 1"}{" "}
                  ·{" "}
                  {label(
                    "固定执行记录，不是真实运行",
                    "Fixed execution record, not a real run",
                  )}
                </p>
                <Tabs
                  value={c.view}
                  onValueChange={(value) => c.setView(String(value))}
                >
                  <div className={styles.row}>
                    <TabsList>
                      <TabsTrigger value="code">
                        {label("代码", "Code")}
                      </TabsTrigger>
                      <TabsTrigger value="output">
                        {label("输出", "Output")}
                      </TabsTrigger>
                    </TabsList>
                    {unknown ? (
                      <Button variant="outline" size="sm" onClick={c.reconcile}>
                        {label("查询本地结果", "Query local outcome")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={passed}
                        onClick={c.rerun}
                      >
                        {passed
                          ? label("本地记录已通过", "Local record passed")
                          : label("修复并本地重跑", "Fix and rerun locally")}
                      </Button>
                    )}
                  </div>
                  <TabsContent value="code" forceMount>
                    <div className={styles.actions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => c.locate("test")}
                      >
                        {label("测试栈帧", "Test frame")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => c.locate("application")}
                      >
                        {label("应用栈帧", "Application frame")}
                      </Button>
                    </div>
                    <p className={styles.path}>
                      src/components/admin/{file}:
                      {c.frame === "test" ? "9:61" : "7:5"}
                    </p>
                    <CodePreview
                      identity={`conversation-12:${c.frame}`}
                      revision={passed ? "fixed" : "failed"}
                      code={c.frame === "test" ? c.testCode : c.code}
                      path={`src/components/admin/${file}`}
                      language="tsx"
                      highlightRange={
                        c.highlight
                          ? {
                              start: c.frame === "test" ? 9 : 7,
                              end: c.frame === "test" ? 9 : 7,
                            }
                          : undefined
                      }
                    />
                  </TabsContent>
                  <TabsContent value="output" forceMount>
                    <pre
                      className={styles.log}
                      aria-label={label(
                        "完整本地执行日志",
                        "Complete local execution log",
                      )}
                    >
                      {c.output}
                    </pre>
                  </TabsContent>
                </Tabs>
              </ThreadPanel>
              {!unknown && (
                <ThreadPanel
                  title={label(
                    "BulkActions 交互契约",
                    "BulkActions interaction contract",
                  )}
                  actions={
                    <span>
                      {passed
                        ? "2 passed · 0 failed · 396ms"
                        : "1 passed · 1 failed · 428ms"}
                    </span>
                  }
                >
                  <p className={styles.meta}>
                    {passed ? 2 : 1}/2 {label("测试通过", "tests passed")} ·{" "}
                    {passed ? 100 : 50}%
                  </p>
                  <Progress
                    value={passed ? 2 : 1}
                    max={2}
                    aria-label={label(
                      "本地记录测试通过比例",
                      "Local record test pass ratio",
                    )}
                    aria-valuetext={`${passed ? 2 : 1}/2 ${label("测试通过", "tests passed")} · ${passed ? 100 : 50}%`}
                  />
                  <div className={styles.testCase}>
                    {passed ? <Check size={16} /> : <CircleX size={16} />}
                    <div>
                      <strong>
                        {label(
                          "没有选择行时禁用操作",
                          "disables the action when no rows are selected",
                        )}
                      </strong>
                      <small>
                        {passed ? "219ms · Passed" : "251ms · Failed"}
                      </small>
                      {!passed && (
                        <p>
                          {label(
                            "selectedCount 为 0 时，预期 Apply 按钮禁用。",
                            "Expected Apply to be disabled when selectedCount is 0.",
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className={styles.testCase}>
                    <Check size={16} />
                    <div>
                      <strong>
                        {label(
                          "失败操作后提供重试",
                          "offers a retry after a failed action",
                        )}
                      </strong>
                      <small>177ms · Passed</small>
                    </div>
                  </div>
                </ThreadPanel>
              )}
              {phase === "failed" && (
                <Collapsible open={c.stackOpen} onOpenChange={c.setStackOpen}>
                  <ThreadPanel
                    title="AssertionError"
                    actions={
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm">
                          {label("错误栈", "Stack trace")}
                        </Button>
                      </CollapsibleTrigger>
                    }
                  >
                    <p>
                      {label(
                        "预期元素被禁用",
                        "expected element to be disabled",
                      )}
                    </p>
                    <CollapsibleContent forceMount>
                      <pre className={styles.log}>{c.stack}</pre>
                      <div className={styles.actions}>
                        <Button
                          variant="outline"
                          onClick={() => c.locate("test")}
                        >
                          <FileCode2 size={14} />
                          bulk-actions.test.tsx:9:61
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => c.locate("application")}
                        >
                          <FileCode2 size={14} />
                          bulk-actions.tsx:7:5
                        </Button>
                      </div>
                    </CollapsibleContent>
                  </ThreadPanel>
                </Collapsible>
              )}
              <p className={styles.meta}>
                {label(
                  "第一应用栈帧指向零选择断言；本地修复仅修改按钮 disabled 条件的快照。没有部署权限。",
                  "The first application frame points to the zero-selection assertion; the local fix only changes the button disabled-condition snapshot. No deployment access.",
                )}
              </p>
            </div>
          )}
        </ThreadMessage>
      )}
    />
  )
}
