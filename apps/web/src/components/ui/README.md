# Web UI 门面层

`apps/web/src/components/ui` 是 `@pm/ui` 的转发门面，不是第二套组件库。

- 当前目录的 40 个 `.tsx` 文件中，35 个只有 `export * from "@pm/ui/..."` 形式的转发，用来保持现有导入路径稳定。
- 只有以下 5 个是本项目自有组件，包含实际实现：
  - `canvas-edge.tsx`
  - `canvas-node.tsx`
  - `canvas-port.tsx`
  - `chart.tsx`
  - `title-hint.tsx`
- 同目录的 `.module.css` 只服务上述本地组件。

## 新增组件

1. 优先把组件放在 `packages/ui` 的 `src/`，按现有 `radix` / `base` / `lib` 分层导出。
2. 如果调用方确实需要稳定路径，可在此新增一个只做 `export * from "@pm/ui/..."` 的转发文件，并在本页登记它对应的 `@pm/ui` 入口。
3. 不要把实现复制到这里。无说明的本地实现会让同一组件出现两份行为、样式和类型来源。
4. 本地专用组件应说明为什么不能进入 `@pm/ui`（例如依赖 `apps/web` 内部状态、图表运行时或画布协议），并补齐对应测试或变更说明。

`packages/ui` 是共享设计系统与主题层；`apps/web` 只负责路由、状态和业务呈现。授权判断、API 调用和任务完成规则不得放进任一层 UI。
