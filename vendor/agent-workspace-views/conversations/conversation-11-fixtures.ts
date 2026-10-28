import type { WorkbenchResource } from "./resource-model"
import type { ComposerDemoSource } from "../demo-source"
import {
  commonScenarios,
  createThreadFixture,
  type CommonScenario,
} from "./fixtures.ts"
export const conversation11Scenarios = commonScenarios
export type Conversation11Scenario = CommonScenario
export interface Conversation11Fixture {
  source: ComposerDemoSource
  files: WorkbenchResource[]
}
export function createConversation11Fixture(
  scenario: Conversation11Scenario,
): Conversation11Fixture {
  const contents = [
    {
      name: "bulk-actions.tsx",
      text: `import { Button } from "@/components/ui/button"
import type { BulkActionState } from "./use-bulk-actions"

type BulkActionsProps = {
  selectedCount: number
  state: BulkActionState
  onApply: () => void
  onRetry: () => void
}

export function BulkActions({ selectedCount, state, onApply, onRetry }: BulkActionsProps) {
  const busy = state === "queued" || state === "running"
  return (
    <section aria-label="Bulk actions" aria-busy={busy}>
      <span>{selectedCount} selected</span>
      <Button disabled={selectedCount === 0 || busy} onClick={onApply}>
        {busy ? "Applying…" : "Apply"}
      </Button>
      <span role="status">{state}</span>
      {state === "failed" && <Button variant="outline" onClick={onRetry}>Retry</Button>}
    </section>
  )
}
`,
    },
    {
      name: "use-bulk-actions.ts",
      text: `import { useRef, useState } from "react"
export type BulkActionState = "idle" | "queued" | "running" | "succeeded" | "failed"

export function useBulkActions(mutate: () => Promise<void>) {
  const [state, setState] = useState<BulkActionState>("idle")
  const pending = useRef(false)
  const run = async () => {
    if (pending.current) return
    pending.current = true
    setState("queued")
    await Promise.resolve()
    setState("running")
    try {
      await mutate()
      setState("succeeded")
    } catch {
      setState("failed")
    } finally {
      pending.current = false
    }
  }
  return { state, run, retry: run }
}
`,
    },
    {
      name: "bulk-actions.test.tsx",
      text: `import { expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { BulkActions } from "./bulk-actions"

it("disables the action when no rows are selected", () => {
  render(<BulkActions selectedCount={0} state="idle"
    onApply={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled()
})

it("offers a retry after a failed action", () => {
  render(<BulkActions selectedCount={3} state="failed"
    onApply={vi.fn()} onRetry={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()
})
`,
    },
  ]
  return {
    source: createThreadFixture(
      "conversation-11",
      scenario,
      {
        "zh-CN":
          "为管理表格生成可复用批量操作组件。提供排队、运行、成功和失败状态，复用已有按钮，包含独立 hook 与测试。",
        en: "Generate a reusable bulk-actions component for our admin tables. It should expose queued, running, succeeded, and failed states, use our existing buttons, and include a focused hook and tests.",
      },
      {
        "zh-CN":
          "我将状态契约与表格实现分离，整理为三个聚焦文件。选择文件查看，或使用产物操作复制、重新生成、下载和关闭。所有源码均为本地快照，不写入仓库。",
        en: "I kept the state contract separate from the table implementation and packaged the result as three focused files. Select a file to review it, or use the artifact actions to copy, regenerate, download, or close the output. All source is a local snapshot; no repository writes.",
      },
    ),
    files: contents.map((file) => ({
      projectId: "admin",
      sessionId: "conversation-11",
      resourceId: file.name,
      revision: "v1",
      name: file.name,
      path: `src/components/admin/${file.name}`,
      renderer: "text",
      mediaType: "text/typescript",
      availability: "available",
      dataState: "success",
      complete: true,
      text: file.text,
      source: {
        messageId: "conversation-11-answer",
        artifactId: file.name,
        label: "Local generated artifact",
      },
    })),
  }
}
