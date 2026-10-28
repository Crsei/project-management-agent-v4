"use client"
import {
  Braces,
  Copy,
  Download,
  FileCode2,
  FlaskConical,
  RotateCcw,
  X,
} from "lucide-react"
import { Tree, CodePreview, inferResourceLanguage } from "./resources"
import { Button } from "./ui"
import { neutralResourceKey } from "./resource-model"
import { ThreadMessage, ThreadPanel, ThreadView } from "./shared"
import type { ComposerHost } from "../composer-workspace-view"
import type { Conversation11Controller } from "./conversation-11-controller"
import styles from "./conversation-9-12.module.css"
export function Conversation11View({
  controller: c,
  host,
}: {
  controller: Conversation11Controller
  host: ComposerHost
}) {
  const { label } = c
  return (
    <div className={styles.wide}>
      <ThreadView
        page="conversation-11"
        controller={c}
        host={host}
        renderMessage={(message) => (
          <ThreadMessage
            message={message}
            controller={c}
            agentRole={
              message.role === "assistant"
                ? label("代码生成 Agent", "Code generator")
                : undefined
            }
          >
            {message.id === "conversation-11-answer" && (
              <div className={styles.modules}>
                <div hidden={!c.cardOpen}>
                  <ThreadPanel
                    title={label("管理批量操作", "Admin bulk actions")}
                    actions={
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={label(
                            "复制所选产物",
                            "Copy selected artifact",
                          )}
                          disabled={!c.selectedResource}
                          onClick={c.copyArtifact}
                        >
                          <Copy size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={label(
                            "重新生成所选产物",
                            "Regenerate selected artifact",
                          )}
                          disabled={!c.selectedResource}
                          onClick={c.regenerate}
                        >
                          <RotateCcw size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={label(
                            "下载所选产物",
                            "Download selected artifact",
                          )}
                          disabled={!c.selectedResource}
                          onClick={c.download}
                        >
                          <Download size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={label("关闭产物", "Close artifact")}
                          onClick={c.closeArtifact}
                        >
                          <X size={16} />
                        </Button>
                      </>
                    }
                  >
                    <div className={styles.row}>
                      <strong>
                        {label(
                          "已生成 · 本地快照",
                          "Generated · Local snapshot",
                        )}
                      </strong>
                      <span className={styles.meta}>
                        3{" "}
                        {label(
                          "个生成文件 · 更新于",
                          "generated files · Updated",
                        )}{" "}
                        <time dateTime={c.updatedAt}>
                          {new Date(c.updatedAt).toLocaleTimeString(c.locale, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                      </span>
                    </div>
                    <div className={styles.artifact}>
                      <aside>
                        <h4>3 {label("个文件", "FILES")}</h4>
                        <Tree
                          label={label("生成文件", "Generated files")}
                          nodes={[
                            {
                              id: "src",
                              label: "src",
                              children: [
                                {
                                  id: "components",
                                  label: "components",
                                  children: [
                                    {
                                      id: "admin",
                                      label: "admin",
                                      children: c.files.map((f) => ({
                                        id: f.resourceId,
                                        label: f.name,
                                        icon: f.name.includes(".test.") ? (
                                          <FlaskConical aria-hidden="true" />
                                        ) : f.name.startsWith("use-") ? (
                                          <Braces aria-hidden="true" />
                                        ) : (
                                          <FileCode2 aria-hidden="true" />
                                        ),
                                      })),
                                    },
                                  ],
                                },
                              ],
                            },
                          ]}
                          defaultExpandedIds={["src", "components", "admin"]}
                          selectedId={c.selectedResource?.resourceId}
                          onSelect={(node) => c.selectFile(node.id)}
                        />
                      </aside>
                      <div className={styles.source}>
                        <div
                          className={styles.documentTabs}
                          role="group"
                          aria-label={label("已打开版本", "Open revisions")}
                        >
                          {c.documents.documents.map((doc) => (
                            <div key={neutralResourceKey(doc.resource)}>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-pressed={
                                  c.documents.activeKey ===
                                  neutralResourceKey(doc.resource)
                                }
                                onClick={() =>
                                  c.selectDocument(
                                    neutralResourceKey(doc.resource),
                                  )
                                }
                              >
                                {doc.resource.name} · {doc.resource.revision}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={doc.pinned}
                                onClick={() => c.pinDocument(doc.resource)}
                              >
                                {doc.pinned
                                  ? label("已固定", "Pinned")
                                  : label("固定版本", "Pin revision")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`${label("关闭版本", "Close revision")} ${doc.resource.revision}`}
                                onClick={() =>
                                  c.closeDocument(
                                    neutralResourceKey(doc.resource),
                                  )
                                }
                              >
                                <X size={14} />
                              </Button>
                            </div>
                          ))}
                        </div>
                        {c.documents.documents.map((doc) => (
                          <div
                            key={neutralResourceKey(doc.resource)}
                            hidden={
                              c.documents.activeKey !==
                              neutralResourceKey(doc.resource)
                            }
                          >
                            <p className={styles.path}>
                              {doc.resource.path} · {doc.resource.revision}
                            </p>
                            <CodePreview
                              identity={neutralResourceKey(doc.resource)}
                              revision={doc.resource.revision}
                              code={doc.resource.text ?? ""}
                              path={doc.resource.path}
                              language={inferResourceLanguage(
                                doc.resource.path,
                              )}
                            />
                          </div>
                        ))}
                        {!c.selectedResource && (
                          <p>
                            {label(
                              "选择文件查看源码。",
                              "Select a file to review source.",
                            )}
                          </p>
                        )}
                      </div>
                    </div>
                  </ThreadPanel>
                </div>
                {!c.cardOpen && (
                  <Button variant="outline" onClick={c.reopenArtifact}>
                    {label("重新打开产物", "Reopen artifact")}
                  </Button>
                )}
                <p>
                  {label(
                    "组件只负责展示，hook 管理异步生命周期。它可在产品、客户与订单表格之间复用，不绑定单一数据客户端。",
                    "The component stays presentation-focused, while the hook owns the async lifecycle. It can be reused across product, customer, and order tables without coupling to one data client.",
                  )}
                </p>
                {c.notice && (
                  <p role="status" className={styles.meta}>
                    {c.copy(c.notice)}
                  </p>
                )}
              </div>
            )}
          </ThreadMessage>
        )}
      />
    </div>
  )
}
