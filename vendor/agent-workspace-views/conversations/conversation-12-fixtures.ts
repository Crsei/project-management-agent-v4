import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
import type { ComposerDemoSource } from "../demo-source"
export const conversation12Scenarios = [
  ...commonScenarios,
  { id: "passed", name: { "zh-CN": "验证通过", en: "Verified" } },
  { id: "unknown", name: { "zh-CN": "结果未知", en: "Unknown" } },
] as const
export type Conversation12Scenario = CommonScenario | "passed" | "unknown"
export interface Conversation12Fixture {
  source: ComposerDemoSource
  phase: "completed" | "unknown" | "failed"
  code: string
  fixed: string
  testCode: string
  stack: string
  failedLog: string
  passedLog: string
}
export function createConversation12Fixture(
  scenario: Conversation12Scenario,
): Conversation12Fixture {
  return {
    source: createThreadFixture(
      "conversation-12",
      scenario,
      {
        "zh-CN":
          "查看批量操作测试的隔离执行记录。失败时先显示准确用例和应用栈帧，再更改产物。",
        en: "Run the generated bulk-actions tests in an isolated environment. If anything fails, show me the exact test and application frame before changing the artifact.",
      },
      {
        "zh-CN":
          "隔离执行 fixture 显示一项失败：重试行为通过，但零选择操作仍可用。修复与重跑只切换本地快照，不执行 Vitest、Shell 或修改文件。",
        en: "The isolated run fixture completed with one focused failure. The retry behavior passes, but the zero-selection action is still enabled. Fix and rerun switches local snapshots only: no Vitest, Shell, or file edits.",
      },
    ),
    phase:
      scenario === "passed"
        ? "completed"
        : scenario === "unknown"
          ? "unknown"
          : "failed",
    code: `import { Button } from "@/components/ui/button"
export function BulkActions({ selectedCount, onApply }: {
  selectedCount: number
  onApply: () => void
}) {
  return (
    <Button onClick={onApply}>
      Apply
    </Button>
  )
}
`,
    fixed: `import { Button } from "@/components/ui/button"
export function BulkActions({ selectedCount, onApply }: {
  selectedCount: number
  onApply: () => void
}) {
  return (
    <Button disabled={selectedCount === 0} onClick={onApply}>
      Apply
    </Button>
  )
}
`,
    testCode: `import { expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { BulkActions } from "./bulk-actions"

it("disables the action when no rows are selected", () => {
  render(<BulkActions selectedCount={0} onApply={vi.fn()} />)
  const apply = screen.getByRole("button", { name: "Apply" })
  // Zero-selection contract
  expect(apply).toBeDisabled()
})
`,
    stack:
      "AssertionError: expected element to be disabled\n  at BulkActionsTest (src/components/admin/bulk-actions.test.tsx:9:61)\n  at BulkActions (src/components/admin/bulk-actions.tsx:7:5)\n  at fixture test runner",
    failedLog:
      "RUN  v3.2.4 /workspace · LOCAL FIXTURE\n\n❯ src/components/admin/bulk-actions.test.tsx (2 tests | 1 failed) 428ms\n  × disables the action when no rows are selected 251ms\n    → expected element to be disabled\n  ✓ offers a retry after a failed action 177ms\n\nTest Files  1 failed (1)\nTests       1 failed | 1 passed (2)\nDuration    428ms\nExit code   1",
    passedLog:
      "RUN  v3.2.4 /workspace · LOCAL FIXTURE\n\n✓ src/components/admin/bulk-actions.test.tsx (2 tests) 396ms\n  ✓ disables the action when no rows are selected 219ms\n  ✓ offers a retry after a failed action 177ms\n\nTest Files  1 passed (1)\nTests       2 passed (2)\nDuration    396ms\nExit code   0",
  }
}
