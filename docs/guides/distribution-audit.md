# Dovspace 发布材料核对

## 素材处置（2026-11-17）

- **MiSans**：不推定取得字体文件的再分发许可。不再打包 Regular、Medium、Semibold 三个 WOFF2，也不从网络加载；Web/Agent 使用已有 Inter OFL，加系统中文字体栈。发行打包从新目录构建，按[已移除素材指纹](../../scripts/retired-release-assets.json)检查，即使 Vite 改名也不能将旧文件混回成品。历史包／Git 历史没有被改写，也没有追认授权。
- **装饰与品牌**：十张无可核来源的 WebP 改为 CSS 封面；数据库 artwork 选项和用户上传图片不变。营销站六个厂商品牌 SVG 改为普通文字标识。保留 OFL 字体来源与原文。Dovspace 参考板与重建标志的权利人于 2026-11-17 明确同意随公开源码和安装包分发；[权属与母版记录](../../apps/desktop/assets/brand-source.json)不声称取得商标注册或他人品牌授权。
- **参考演示文字**：追溯至历史提交 `19be07a0` 的 audio-playground 合成录音生成器，其输入是当时 vendor 目录的两段英文脚本与西语／英语翻译对。生成器、输入、录音及 conversation-8 示例媒体均已退出当前分发树；核对了四段脚本正文在当前源码中无匹配。这不是对旧版文本的权属声明。当前产品截图的隔离采集证据另见[截图来源](../../apps/marketing/public/screenshots/SOURCE.json)。

## 对应源码

PM 登录页、账号菜单与 Agent 常规设置中的「许可与对应源码」打开无需登录的法律声明。营销站页脚也有同一入口。发行页面同时提供 AGPL 全文、第三方声明及**同源**可下载的本构建源码；不要求访问者有 GitHub 账号。开发预览没有绑定源码时明确显示这一点，不伪造版本。

- Desktop 将同一份已捕获的公开源码归档随 App 和 Release 材料分发，包含构建／安装脚本；展开**最终 DMG、ZIP 或 Windows 成品**后校验页面提交、下载字节与发行材料 SHA-256。含本地修改的测试包不把干净提交链接当作对应源码。
- 发布自托管 Web 或营销站，先提交并审阅全部本地修改，使用下列干净构建。不在 live dist 上覆盖或删除旧资源。将输出整目录作为一个部署单元，并实际访问 `/legal.html`、下载归档、核对页面上的摘要；普通 dev/build、未配置源码提供的 Docker 开发镜像不是这个发布步骤。若独立部署后端和 Web，其版本必须一致或另提供每个修改组件的源码。

```sh
node scripts/build-public-site.mjs web /absolute/new/web-dist
node scripts/build-public-site.mjs marketing /absolute/new/marketing-dist
```

## 最终产物 notices（不能只数 LICENSE 文件）

```sh
node apps/desktop/scripts/audit-notices.mjs /absolute/verified-delivery
```

该只读审计先对照桌面清单核验 legal tar 和 SBOM 的大小及哈希，再按 tar 内真实非空成员核对索引。2026-11-17 的旧 arm64 测试包（提交 `ef81c264`）含 887 个 SBOM 组件，desktop-web 索引共 790 项、63 项缺许可字段或非空原文；Node、PostgreSQL、Electron／Chromium 和根声明在归档中存在。未匹配项可能由 Agent bundled、宿主来源或单独的原生 notices 覆盖，不能一律称为无许可。OSV 与签名均不能替代这项审阅。

[补件清单](../../apps/desktop/assets/dependency-notices/index.json)按准确 npm 版本的 registry gitHead 绑定上游原文。例如 Redis、Connect、Statsig、UIW；不同版本不共用一个未经核对的授权。收集器核验原文哈希，复用已审阅的 react-remove-scroll-bar 补件，也保留部分 npm README 中随版本实际发布的完整 MIT 声明。补件不推定依赖兼容或厂商签署批准。

特别需要复核 Cursor 1.0.38：SDK 原许可指向 [Cursor 服务条款](https://cursor.com/terms-of-service)，并非 MIT；权利人材料须明确覆盖 SDK 及对应原生包随 Dovspace 安装包公开再分发。维护者已选择提供厂商依据，目前尚未取得。Anthropic 通信 SDK 也附其[专用条款](https://code.claude.com/docs/en/legal-and-compliance)，与已排除的 Claude CLI 二进制分开核对。不得用普通订阅、用户自己的 API Key 或其他组件的 MIT 补足此类授权。

每个请求的签名目标均需以自己的真实最终材料核对 Agent、Web、依赖闭包、嵌套原生组件与任何缺项。签名测试可先通过 `release_action=none` 构建；未完成授权审阅不创建 draft 或公开 Release。
