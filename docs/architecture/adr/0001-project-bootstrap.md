# ADR-0001：项目位置与初始化边界

> 历史决策记录：以下保留原日期、范围和决策含义，不是当前布局/依赖/功能验收声明。当前架构见[系统上下文](../context.md)，Markdown核心权威切换见[ADR-0003](0003-markdown-core.md)。

日期：2026-10-16。状态：采用，用于用户要求的新项目初始化。

本页记录初始化时的选择；后续第一阶段实现、兼容工具版本和能力以 [ADR-0002](0002-first-stage-backend.md) 为准。

## 决策

实现项目位于 `ui-examples/project-management`，初始化独立 Git 仓库，避免继承数据盘顶层 Git 范围。采用 pnpm workspace、Node.js 24 和 TypeScript。首个可执行包为 Fastify API；领域、应用、契约、基础设施与 Worker 先记录职责，业务实现按三阶段计划推进。

初始化依赖固定为 Fastify 5.12.7、TypeScript 7.0.2、@types/node 24.19.2、pnpm 11.9.0，将对应锁文件纳入工程文件。开发入口使用 Node 24 的类型擦除运行，生产入口使用 TypeScript 编译后的 JavaScript。

当前接口只提供 liveness、明确不就绪的 readiness 和未启用能力。业务实现尚未建立时不返回虚假 ready，也不提供模拟 Run 成功。运维接口有独立的 bootstrap OpenAPI；B03 再制定正式业务契约及 schema 生成链路。

## 备选方案与原因

- 继续在 `project-management-book` 编码：不符合用户最新指定的项目位置。
- 将本项目并入 EasyuseUI：会提前耦合第一阶段后端与第二阶段展示，也会影响已有 Plane/Agent 接入边界。
- 立即创建完整微服务、前端或 Runner：超出当前新建项目和已确定的分期。

## 后果与剩余工作

设计规范从原项目带入，本项目成为后续实施和状态记录的权威目录。EasyuseUI 源码链接仅供本机参考，不是构建依赖。

B01 尚需补齐认证库、数据库版本、事务/锁实现、存储和事件保留策略等 ADR；B02 尚需补齐真实数据库依赖、Worker 入口、完整配置和部署环境。当前初始化不代表 B01/B02 或 G1 已完成。
