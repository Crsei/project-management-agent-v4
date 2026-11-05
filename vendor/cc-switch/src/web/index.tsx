import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { Toaster } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { TooltipProvider } from "../components/ui/tooltip";
import { hasUnsavedChanges, subscribeUnsavedChanges } from "../lib/unsavedChanges";
import i18n from "../i18n";
import { MCP_APP_IDS } from "../config/appConfig";
import { APP_DISPLAY_NAME } from "../components/shell/AppGlyph";
import { disposeChannels, mountWebPlatform, type DirectoryListing, type DirectoryRequest, type ManagementContext, type ManagementEvent, type WebPlatform } from "./bridge";
import "./management.css";

export type { ManagementContext, ManagementEvent, DirectoryListing } from "./bridge";
export const MANAGED_APPS = MCP_APP_IDS.map(id => ({ id, label: APP_DISPLAY_NAME[id] }));
export interface CcSwitchManagementProps {
  context: ManagementContext;
  children: ReactNode;
  locale?: string;
  contexts?: readonly ManagementContext[];
  onContextChange?(contextId: string): Promise<boolean>;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  upload(file: File): Promise<string>;
  subscribe(listener: (event: ManagementEvent) => void): () => void;
  onDirtyChange?(dirty: boolean): void;
}

/** Hosts source extension pages inside the existing platform and singleton providers. */
export function CcSwitchManagement(props: CcSwitchManagementProps) {
  useLayoutEffect(() => { if (props.locale) void i18n.changeLanguage(props.locale.startsWith("zh") ? "zh" : "en"); }, [props.locale]);
  const latest = useRef(props);
  latest.current = props;
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  const content = useRef<HTMLDivElement>(null);
  const [portal] = useState(() => { const node = document.createElement("div"); node.className = "cc-switch-web"; node.dataset.ccSwitchPortal = ""; return node; });
  const [mounted, setMounted] = useState(false);
  const [directory, setDirectory] = useState<{ request: DirectoryRequest; listing: DirectoryListing }>();
  const [file, setFile] = useState<{ name: string; content: string }>();
  const [error, setError] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const openDirectory = useCallback(async (request: DirectoryRequest) => {
    setBrowsing(true); setError(undefined); setFile(undefined);
    try { const listing = await props.invoke<DirectoryListing>("browse_directory", { ...request }); setDirectory({ request, listing }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setBrowsing(false); }
  }, [props.invoke]);
  const platform = useMemo<WebPlatform>(() => ({
    get context() { return latest.current.context; },
    get contexts() { return latest.current.contexts; },
    get selectContext() {
      return latest.current.onContextChange ? async (contextId: string) => {
        if (hasUnsavedChanges() || !latest.current.contexts?.some(context => context.id === contextId)) return false;
        return latest.current.onContextChange?.(contextId) ?? false;
      } : undefined;
    },
    invoke: <T,>(command: string, args?: Record<string, unknown>) => latest.current.invoke<T>(command, args),
    upload: file => latest.current.upload(file),
    subscribe: listener => latest.current.subscribe(listener),
    openDirectory, portal,
    get content() { if (!content.current) throw new Error("Management content is not mounted."); return content.current; },
  }), [openDirectory, portal]);
  useLayoutEffect(() => {
    document.body.append(portal);
    const release = mountWebPlatform(platform);
    setMounted(true);
    return () => { disposeChannels(); release(); portal.remove(); client.clear(); };
  }, [platform, portal, client]);
  useEffect(() => props.subscribe(({ event, data }) => {
    if (event === "reconnected") {
      void client.invalidateQueries();
      setNotice("事件连接已恢复；正在重新读取权威状态，原表单草稿未丢弃，不会自动重放写入。");
    } else if (event === "changed") {
      void client.invalidateQueries();
      const synchronized = data && typeof data === "object" && "filesSynchronized" in data ? data.filesSynchronized : undefined;
      const importedWithoutWrites = data && typeof data === "object" && "command" in data && data.command === "apply_mcp_import" && "nativeFilesWritten" in data && data.nativeFilesWritten === false;
      setNotice(props.context.kind === "project" ? "项目私有 MCP 定义已保存；未写入原生 Home，PM 执行授权仍单独核验。" : importedWithoutWrites ? "审阅导入已保存；本次未改写原生文件。请核对逐应用同步状态，需要时再显式同步；运行会话保持不变。" : synchronized === false ? "配置已保存，但原生文件同步存在失败；请查看逐应用结果并核对后再重载。活跃执行保持不变。" : `配置已保存；文件同步：${synchronized === true ? "宿主未报告失败，请核对逐应用结果" : "尚无同步结果"}。运行会话未重载；请刷新原生目录，并按需显式重启原生会话或新建对话。`);
    } else if ((event === "operation" || event === "warning") && data && typeof data === "object") {
      const message = "message" in data && typeof data.message === "string" ? data.message : "state" in data && data.state === "partial" ? "配置操作部分成功；至少一个原生目标同步失败。请检查逐应用结果，不要将保存视为全部同步或会话重载。" : "error" in data && data.error && typeof data.error === "object" && "message" in data.error && typeof data.error.message === "string" ? data.error.message : undefined;
      if (message) setWarnings(previous => previous.includes(message) ? previous : [...previous, message]);
    }
  }), [props.subscribe, client]);
  useEffect(() => {
    const report = () => props.onDirtyChange?.(hasUnsavedChanges());
    report();
    return subscribeUnsavedChanges(report);
  }, [props.onDirtyChange]);
  useEffect(() => () => { props.onDirtyChange?.(false); }, [props.onDirtyChange]);
  const readFile = async (name: string) => {
    if (!directory?.request.directory) return;
    setBrowsing(true); setError(undefined);
    try {
      const relative = [directory.request.subdirectory, name].filter(Boolean).join("/");
      const value = await props.invoke<{ content: string }>("read_skill_file", { directory: directory.request.directory, file: relative });
      setFile({ name: relative, content: value.content });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBrowsing(false); }
  };
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = file.name.split("/").at(-1) ?? "SKILL.md"; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="cc-switch-web">
    {notice && <p role="status" className="border-b border-border bg-warning-soft px-4 py-2 text-body text-fg-1">{notice}</p>}
    {warnings.map(message => <div key={message} role="alert" className="flex items-center gap-2 border-b border-border bg-warning-soft px-4 py-2 text-body text-warning-text"><span className="flex-1">{message}</span><button type="button" onClick={() => setWarnings(previous => previous.filter(item => item !== message))}>关闭警告</button></div>)}
    {error && <p role="alert" className="px-4 py-2 text-danger-text">{error}</p>}
    <div ref={content} className="cc-switch-management-content relative flex flex-col bg-app text-fg-1">
      {mounted && <I18nextProvider i18n={i18n}><QueryClientProvider client={client}><TooltipProvider>
        {props.children}
        <Toaster richColors closeButton position="bottom-right" duration={6000} />
        <Dialog open={!!directory} onOpenChange={open => { if (!open && !browsing) { setDirectory(undefined); setFile(undefined); } }}><DialogContent className="gap-3 overflow-y-auto p-5">
          <DialogTitle>Agent 主机上的 Skills 文件</DialogTitle><DialogDescription>这是经授权的远端只读目录，不是浏览器本机目录。{directory?.listing.label}</DialogDescription>
          {directory?.request.kind === "skill" && !file && <Button variant="neutral" disabled={browsing} onClick={() => void openDirectory(directory.request.subdirectory ? { ...directory.request, subdirectory: directory.request.subdirectory.split("/").slice(0, -1).join("/") || undefined } : { kind: "skills" }).catch(() => undefined)}>上一级</Button>}
          {browsing && <p role="status">正在读取…</p>}
          {file ? <><h3>{file.name}</h3><pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3">{file.content}</pre><Button onClick={download}>下载此文件</Button><Button variant="neutral" onClick={() => setFile(undefined)}>返回目录</Button></> : <ul className="max-h-[55dvh] overflow-auto">{directory?.listing.entries.map(entry => <li key={entry.name}><Button variant="quiet" disabled={browsing || entry.kind === "file" && !directory?.request.directory} title={entry.kind === "file" && !directory?.request.directory ? "仅可查看已安装 Skill 内的文本文件；管理根文件不在此读取范围。" : undefined} onClick={() => {
            if (!directory) return;
            if (entry.kind === "file") void readFile(entry.name);
            else void openDirectory(directory.request.kind === "skills" ? { kind: "skill", directory: entry.name } : { ...directory.request, subdirectory: [directory.request.subdirectory, entry.name].filter(Boolean).join("/") }).catch(() => undefined);
          }}>{entry.kind === "directory" ? "[目录]" : "[文件]"} {entry.name}{entry.size === undefined ? "" : ` · ${entry.size} bytes`}</Button></li>)}</ul>}
          <Button variant="neutral" disabled={browsing} onClick={() => { setDirectory(undefined); setFile(undefined); }}>关闭</Button>
        </DialogContent></Dialog>
      </TooltipProvider></QueryClientProvider></I18nextProvider>}
    </div>
  </div>;
}
