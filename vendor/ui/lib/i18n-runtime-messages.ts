import type { Locale } from "./i18n-core"
type RuntimePanelText = {
  labels: Record<"output" | "tests" | "problems" | "events" | "logs" | "metrics" | "terminal", string>
  records: string
  noTests: string
  unknown: string
  failure: string
  noProblems: string
  noMetrics: string
  noTerminal: string
}
export const runtimePanelMessages = {
  "zh-CN": {
    labels: { output: "输出", tests: "测试", problems: "问题", events: "事件", logs: "日志", metrics: "指标", terminal: "终端" },
    records: "运行记录",
    noTests: "来源未提供结构化测试报告。命令输出及来源退出码可在输出页查看。",
    unknown: "结果未知",
    failure: "来源失败",
    noProblems: "来源未报告问题。",
    noMetrics: "来源未提供结构化指标。",
    noTerminal: "尚未连接 PTY 服务。只读命令输出可在输出页查看。",
  },
  en: {
    labels: { output: "Output", tests: "Tests", problems: "Problems", events: "Events", logs: "Logs", metrics: "Metrics", terminal: "Terminal" },
    records: "Runtime records",
    noTests: "No structured test report supplied. Command output and its exit code remain available under Output.",
    unknown: "Outcome unknown",
    failure: "Source failure",
    noProblems: "No reported problems.",
    noMetrics: "The source does not supply structured metrics.",
    noTerminal: "No PTY service connected. Read-only command output is available under Output.",
  },
} satisfies Record<Locale, RuntimePanelText>
