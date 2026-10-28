import { useEffect, useRef, useState } from "react";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LocalDirectory, LocalProjectDirectoryListing } from "../../../../packages/contracts/src/local-projects";
import { agentFileAreaResponseSchema, agentStorageSettingsSchema, type AgentStorageSettings } from "../../../../packages/contracts/src/agent-file-areas";
import { acceptFileArea, pmJson, PmApiError, refreshCatalog, scopeContext, usePmChatState, type AgentScope, type AgentFileArea } from "./state";

export function FileAreaDialog({ scope, name, fileArea, onClose, onDraftStateChange, storageRoot = false, onStorageSaved }: {
  scope: AgentScope; name: string; fileArea: AgentFileArea; onClose: () => void;
  onDraftStateChange?: (state: "clean" | "dirty" | "busy") => void;
  storageRoot?: boolean;
  onStorageSaved?: (settings: AgentStorageSettings) => void;
}) {
  const [mode, setMode] = useState<LocalDirectory["mode"]>("existing");
  const [path, setPath] = useState(fileArea.path ?? "");
  const [parentPath, setParent] = useState("");
  const [folderName, setName] = useState("");
  const [revision, setRevision] = useState(fileArea.revision);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<LocalProjectDirectoryListing>();
  const [listingError, setListingError] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const initialPath = useRef(fileArea.path ?? "");
  const catalogState = usePmChatState();
  const current = scopeContext(catalogState.catalog, scope);
  const canManage = (storageRoot ? fileArea.canManage : !!current?.fileArea.canManage) && !catalogState.loading && !catalogState.error && !!current;
  const dirty = mode !== "existing" || path !== initialPath.current || !!parentPath || !!folderName;
  useEffect(() => {
    onDraftStateChange?.(busy ? "busy" : dirty ? "dirty" : "clean");
  }, [busy, dirty, onDraftStateChange]);
  useEffect(() => () => onDraftStateChange?.("clean"), [onDraftStateChange]);
  const close = () => {
    if (busy || (dirty && !window.confirm("目录修改尚未保存，确定放弃这些输入吗？"))) return;
    onClose();
  };
  const browse = async (directory?: string) => {
    setBrowsing(true);
    setListingError(undefined);
    try {
      const result = await pmJson<LocalProjectDirectoryListing>(
        `/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/local-projects/directories${directory ? `?path=${encodeURIComponent(directory)}` : ""}`,
      );
      setListing(result);
    } catch (reason) {
      setListingError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBrowsing(false); }
  };
  const save = async () => {
    if (busy || conflict || !canManage) return;
    setBusy(true);
    setError(undefined);
    const directory: LocalDirectory = mode === "existing"
      ? { mode, path: path.trim() }
      : { mode, parentPath: parentPath.trim(), folderName: folderName.trim() };
    const base = `/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}`;
    try {
      if (storageRoot) {
        const saved = agentStorageSettingsSchema.parse(await pmJson<unknown>(`${base}/agent-storage-settings`, {
          method: "PUT", body: JSON.stringify({ directory, expectedRevision: revision }),
        }));
        onStorageSaved?.(saved);
        void refreshCatalog().catch(() => {});
      } else {
        const saved = agentFileAreaResponseSchema.parse(await pmJson<unknown>(`${base}${scope.projectId ? `/projects/${encodeURIComponent(scope.projectId)}` : ""}/agent-file-area`, {
          method: "PUT", body: JSON.stringify({ directory, expectedRevision: revision }),
        }));
        acceptFileArea(scope, saved.fileArea);
      }
      onClose();
    } catch (reason) {
      setConflict(!(reason instanceof PmApiError) || reason.status === 409 || reason.status >= 500);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const reloadRevision = async () => {
    setBusy(true);
    try {
      if (storageRoot) {
        const saved = agentStorageSettingsSchema.parse(await pmJson<unknown>(`/api/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/agent-storage-settings`));
        onStorageSaved?.(saved);
        if (!saved.canManage) throw new Error("当前身份已无法管理默认保存根目录，目录输入已保留。");
        setRevision(saved.revision);
      } else {
        const context = scopeContext(await refreshCatalog(), scope);
        if (!context) throw new Error("此工作区或项目已不可用。");
        if (!context.fileArea.canManage) throw new Error("当前身份已无法管理此目录，目录输入已保留。");
        setRevision(context.fileArea.revision);
      }
      setConflict(false);
      setError("已读取最新版本；你的目录输入未修改。请核对后再次保存。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const valid = mode === "existing" ? !!path.trim() : !!parentPath.trim() && !!folderName.trim();
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="pm-agent-directory-dialog max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{storageRoot ? "工作区默认保存根目录" : `${scope.projectId ? "项目" : "工作区"}文件区域`}</DialogTitle>
        <DialogDescription>{name} · revision {revision}。{storageRoot ? "只影响此工作区将来首次分配的默认文件区域；已有目录、原生项目和保存文件不会移动。" : "后续聊天使用此目录；不会移动项目，也不会改变已接受执行的目录快照。"}</DialogDescription>
      </DialogHeader>
      <fieldset className="pm-agent-directory-form" disabled={busy || !canManage}>
        <legend className="sr-only">选择文件区域</legend>
        <div className="pm-agent-directory-modes">
          <label><input type="radio" name="directory-mode" checked={mode === "existing"} onChange={() => setMode("existing")} />使用已有目录</label>
          <label><input type="radio" name="directory-mode" checked={mode === "new"} onChange={() => setMode("new")} />新建文件夹</label>
        </div>
        {mode === "existing" ? <label>现有目录的绝对路径<Input value={path} onChange={(event) => setPath(event.target.value)} placeholder="输入服务端允许的目录" /></label>
          : <><label>父目录的绝对路径<Input value={parentPath} onChange={(event) => setParent(event.target.value)} placeholder="输入服务端允许的父目录" /></label>
            <label>新文件夹名称<Input value={folderName} onChange={(event) => setName(event.target.value)} placeholder="仅一个文件夹名称" /></label></>}
        <Button type="button" variant="outline" disabled={browsing} onClick={() => void browse()}><FolderIcon />{browsing ? "正在读取…" : "浏览已授权的本地项目目录"}</Button>
        <p className="text-muted-foreground text-xs">目录浏览器仅展示已启用的本地项目可信根目录。Chat Space 根目录可能不在列表中；可直接输入服务端允许的绝对路径，使用已有目录或在已有父目录下新建文件夹。</p>
        {listing && <div className="pm-agent-directory-browser" aria-label="服务端目录选择器">
          <div className="pm-agent-directory-current"><code>{listing.path ?? "允许的根目录"}</code>
            {listing.parentPath && <Button type="button" size="sm" variant="ghost" disabled={browsing} onClick={() => void browse(listing.parentPath!)} aria-label="上一级目录"><ArrowUpIcon /></Button>}
          </div>
          {listing.path && <Button type="button" size="sm" variant="outline" onClick={() => { if (mode === "existing") setPath(listing.path!); else setParent(listing.path!); }}>选择当前目录</Button>}
          {!listing.path && listing.roots.map((root) => <button type="button" key={root} disabled={browsing} onClick={() => void browse(root)}><FolderIcon /><span>{root}</span></button>)}
          {listing.directories.map((directory) => <button type="button" key={directory.path} disabled={browsing} onClick={() => void browse(directory.path)}><FolderIcon /><span>{directory.name}</span></button>)}
          {listing.path && !listing.directories.length && <p>此目录没有可浏览的子文件夹。</p>}
        </div>}
      </fieldset>
      {listingError && <p role="alert" className="text-destructive text-sm">{listingError}</p>}
      {!canManage && <p role="status">{catalogState.error ? `无法核验当前目录权限：${catalogState.error}` : catalogState.loading ? "正在核验目录权限…" : !current ? "此工作区或项目已不可访问。" : `当前身份无法管理此目录。${current.fileArea.reason ?? ""}`}</p>}
      <p className="text-muted-foreground text-xs">目录位置不是隔离沙箱或新的授权。只允许服务端已配置的路径，新文件夹仅在明确保存时创建。</p>
      {error && <div role="alert" className="text-destructive text-sm">保存未完成，目录输入已保留：{error}
        {conflict && <><p>版本冲突或保存结果未知。先重新读取服务端版本，再核对输入；不会自动重试写入。</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reloadRevision()}>读取最新版本（保留输入）</Button></>}
      </div>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>取消</Button>
        <Button type="button" disabled={busy || !valid || conflict || !canManage} onClick={() => void save()}>{busy ? "正在保存…" : storageRoot ? "保存默认根目录" : "保存文件区域"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
