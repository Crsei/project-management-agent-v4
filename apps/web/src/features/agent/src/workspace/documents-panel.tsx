import { generateId } from "ai";
import { useEffect, useRef, useState } from "react";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import { Textarea } from "@agent/components/ui/textarea";
import type { WorkspaceDocument } from "@agent-workspace/contracts/workspace";
import { useWorkspace } from "./provider";
import { usePanelDraft } from "./use-panel-draft";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_CONTENT_LENGTH = 65536;
const TEXT_EXTENSION =
  /\.(txt|md|markdown|json|csv|js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|hpp|css|scss|html|xml|yaml|yml|toml|sh|sql|log)$/i;

export function DocumentsPanel() {
  const { state, threadId, update, captureConversation, quote } = useWorkspace();
  const [selectedId, setSelectedId] = usePanelDraft<string>(threadId, "selected-document");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const mounted = useRef(true);
  const selected =
    state.documents.find((document) => document.id === selectedId) ?? state.documents[0];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function addDocument(title: string, content: string) {
    if (content.length > MAX_CONTENT_LENGTH)
      throw new Error("文档超过 65,536 字符，未保存。请拆分为较小的文本后再导入。");
    const document: WorkspaceDocument = {
      id: generateId(),
      title: title.slice(0, 200),
      content,
      included: false,
      updatedAt: new Date().toISOString(),
    };
    update((current) => ({ ...current, documents: [...current.documents, document] }));
    setSelectedId(document.id);
    setError(null);
    setNotice(
      "文档已加入草稿，服务端保存状态见上方。默认不发送给模型，需要使用时请勾选加入上下文。",
    );
  }

  function changeDocument(id: string, patch: Partial<WorkspaceDocument>) {
    try {
      update((current) => ({
        ...current,
        documents: current.documents.map((document) =>
          document.id === id
            ? {
                ...document,
                ...patch,
                updatedAt: new Date().toISOString(),
              }
            : document,
        ),
      }));
      setError(null);
      setNotice(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存文档修改。");
    }
  }

  function capture() {
    try {
      const content = captureConversation();
      if (!content.trim()) throw new Error("当前会话还没有可保存的文字消息。");
      addDocument(`对话摘录 ${new Date().toLocaleString("zh-CN")}`, content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取当前对话。");
    }
  }

  async function importFile(file: File) {
    setError(null);
    setNotice(null);
    setImporting(true);
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new Error("文件超过 64 KB，未导入。请先拆分为较小的文本文件。");
      if (!TEXT_EXTENSION.test(file.name))
        throw new Error(
          "不支持此文件类型。请选择 .txt、.md、.json、.csv 或常见代码文本文件；不支持 PDF、Office、图片或压缩包。",
        );
      if (
        file.type &&
        !file.type.startsWith("text/") &&
        !/^(application\/(json|ld\+json|javascript|x-javascript|xml|yaml|x-yaml|toml|x-sh|x-shellscript|octet-stream))$/i.test(
          file.type,
        )
      ) {
        throw new Error("文件被识别为不支持的二进制格式，未导入。请导出 UTF-8 纯文本后重试。");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!mounted.current) return;
      if (
        bytes.some(
          (byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127,
        )
      ) {
        throw new Error("检测到二进制控制字节，未导入。仅支持 UTF-8 纯文本，不支持二进制文档。");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("文件不是有效的 UTF-8 文本，未导入。请转换编码后重试。");
      }
      addDocument(file.name, content);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "读取文件失败，请检查文件后重试。");
    } finally {
      if (mounted.current) setImporting(false);
    }
  }

  function exportDocument(document: WorkspaceDocument) {
    try {
      const url = URL.createObjectURL(
        new Blob([document.content], { type: "text/plain;charset=utf-8" }),
      );
      try {
        const link = window.document.createElement("a");
        link.href = url;
        const title = document.title.trim().replace(/[\\/:*?"<>|]/g, "_") || "未命名文档";
        link.download = TEXT_EXTENSION.test(title) ? title : `${title}.md`;
        window.document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setError(null);
      setNotice("已发起文本下载，请在浏览器下载列表中查看。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法导出文档。");
    }
  }

  function quoteDocument(document: WorkspaceDocument) {
    try {
      quote(`文档：${document.title || "未命名文档"}\n\n${document.content}`);
      setError(null);
      setNotice("文档已加入聊天输入框草稿；尚未发送，可编辑后自行发送。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加入聊天草稿。");
    }
  }

  function deleteDocument(document: WorkspaceDocument) {
    if (
      !window.confirm(
        `删除「${document.title || "未命名文档"}」？这也会将其从后续聊天和运行的上下文中移除，无法撤销。`,
      )
    )
      return;
    update((current) => ({
      ...current,
      documents: current.documents.filter((item) => item.id !== document.id),
    }));
    setSelectedId(null);
    setError(null);
    setNotice(null);
  }

  return (
    <div className="live-panel-section">
      <div className="live-panel-toolbar">
        <h2 className="text-base font-medium">会话文档</h2>
        <Button onClick={() => addDocument("未命名文档", "")}>新建文档</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        编辑纯文本或
        Markdown，自动保存到当前会话的服务端资源；失败保留草稿。仅勾选的文档会随后续聊天与 Agent /
        工作流请求发送给模型。
      </p>
      <div className="live-panel-actions">
        <Button variant="outline" onClick={capture}>
          保存当前对话
        </Button>
      </div>
      <label className="live-panel-field">
        <span>导入 UTF-8 文本（单文件最多 64 KB）</span>
        <Input
          type="file"
          disabled={importing}
          accept=".txt,.md,.markdown,.json,.csv,.js,.jsx,.ts,.tsx,.py,.rs,.go,.java,.c,.h,.cpp,.hpp,.css,.scss,.html,.xml,.yaml,.yml,.toml,.sh,.sql,.log"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <span className="text-xs text-muted-foreground">
          支持文本、Markdown、JSON、CSV 与常见代码；不解析或执行内容。不支持
          PDF、Office、图片、压缩包。单篇正文最多 65,536 字符。
        </span>
      </label>
      {importing && (
        <p className="live-panel-status" role="status">
          正在读取文本文件…
        </p>
      )}
      {error && (
        <p className="live-panel-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="live-panel-status" role="status">
          {notice}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        已选 {state.documents.filter((document) => document.included).length}{" "}
        篇文档。发送上下文总量上限为 64,000 字符（含标题与分隔），超限时请取消部分勾选或缩短正文。
      </p>
      {state.documents.length === 0 ? (
        <p className="live-panel-empty">
          当前会话还没有文档。新建、导入文本，或保存当前实际对话作为文档。
        </p>
      ) : (
        <>
          <div className="live-panel-list" aria-label="当前会话的文档">
            {state.documents.map((document) => (
              <div
                key={document.id}
                className={`live-panel-item flex min-h-11 items-center gap-2 ${selected?.id === document.id ? "border-l-2 border-l-primary bg-muted" : ""}`}
              >
                <input
                  type="checkbox"
                  className="ml-2"
                  aria-label={`将「${document.title || "未命名文档"}」加入聊天与运行上下文`}
                  checked={document.included}
                  onChange={(event) =>
                    changeDocument(document.id, { included: event.target.checked })
                  }
                />
                <Button
                  variant="ghost"
                  className="h-auto min-h-11 min-w-0 flex-1 justify-start whitespace-normal text-left"
                  aria-pressed={selected?.id === document.id}
                  onClick={() => {
                    setSelectedId(document.id);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  <span className="min-w-0 break-words">{document.title || "未命名文档"}</span>
                </Button>
                <span className="shrink-0 pr-2 text-xs text-muted-foreground">
                  {document.included ? "已加入" : "未加入"}
                </span>
              </div>
            ))}
          </div>
          {selected && (
            <section className="live-panel-section" aria-label="编辑文档">
              <label className="live-panel-field">
                <span>标题（最多 200 字符）</span>
                <Input
                  value={selected.title}
                  maxLength={200}
                  onChange={(event) => changeDocument(selected.id, { title: event.target.value })}
                />
              </label>
              <label className="flex min-h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.included}
                  onChange={(event) =>
                    changeDocument(selected.id, { included: event.target.checked })
                  }
                />
                将此文档加入后续聊天与运行的上下文
              </label>
              <label className="live-panel-field">
                <span>正文（纯文本 / Markdown）</span>
                <Textarea
                  className="min-h-64 max-h-[36rem] overflow-y-auto font-mono text-sm"
                  value={selected.content}
                  maxLength={MAX_CONTENT_LENGTH}
                  placeholder="输入或粘贴文档内容"
                  onChange={(event) => changeDocument(selected.id, { content: event.target.value })}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {selected.content.length.toLocaleString("zh-CN")} / 65,536 字符 · 修改于{" "}
                {new Date(selected.updatedAt).toLocaleString("zh-CN")}
              </p>
              <div className="live-panel-actions">
                <Button
                  variant="outline"
                  disabled={!selected.content.trim()}
                  onClick={() => quoteDocument(selected)}
                >
                  引用到聊天草稿
                </Button>
                <Button variant="outline" onClick={() => exportDocument(selected)}>
                  导出文本
                </Button>
                <Button variant="destructive" onClick={() => deleteDocument(selected)}>
                  删除文档
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
