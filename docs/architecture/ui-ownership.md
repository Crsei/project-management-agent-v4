# UI 归属与维护

日期：2026-11-06
状态：生效

## 范围

本说明覆盖 `apps/web` 中作为本项目产品界面维护的代码：

- [`apps/web/src/components/ui`](../../apps/web/src/components/ui)
- [`apps/web/src/components/blocks`](../../apps/web/src/components/blocks)
- [`apps/web/src/lib`](../../apps/web/src/lib)
- [`apps/web/src/views/pm`](../../apps/web/src/views/pm)
- [`apps/web/src/features/agent/components/ui`](../../apps/web/src/features/agent/components/ui)
- `apps/web/src/features/pm/service` 中的页面壳、表单与展示适配

## 归属

这些文件作为**本项目自有 UI 代码**维护。项目所有者确认历史 UI 移植代码由其本人创作并归本项目所有；当前实现不再依赖或引用外部 UI 展示源码包。

后续修改按根 [LICENSE](../../LICENSE) 的 `AGPL-3.0-only` 发布；其中来自第三方库的部分保留各自许可证，不因本项目声明而改变。

## 第三方许可

本项目 UI 使用的第三方代码按实际依赖和实际进入产物的范围保留许可证：

- shadcn/ui：MIT，[许可证副本](../../apps/web/public/licenses/shadcn/LICENSE)
- Radix UI：MIT
- Base UI：MIT
- Tailwind CSS：MIT
- Lucide：ISC
- 其他依赖：见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)

`apps/web/public/licenses/shadcn/LICENSE` 只覆盖 shadcn/ui 原始代码，不把整个项目 UI 重新声明为 MIT。

## 维护规则

1. 新组件优先复用现有 `components/ui` 基础件、`components/blocks` 复合块和现有设计 token。
2. 不整页或整组件复制未登记来源的 UI 代码；确需引入第三方代码时必须更新 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 和 `scripts/check-third-party-notices.mjs`。
3. 组件公开 API、键盘/焦点/ARIA 和移动端布局属于受控契约；修改时同步更新 Storybook、测试和受影响页面。
4. 不重新引入已删除的展示实验室、外部 UI 源码包或对应构建开关；由 `scripts/check-no-easyuse.mjs` 守卫。
5. UI 变更至少运行受影响 lint、类型检查、构建和浏览器烟测；数据库/事务/流变更按仓库约定另跑隔离回归。
