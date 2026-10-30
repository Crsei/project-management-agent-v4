import { useEffect, useRef, useState } from "react";
import { FolderIcon, ArrowUpIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { Button } from "@agent/components/ui/button";
import { Input } from "@agent/components/ui/input";
import type { LocalDirectory, LocalProjectDirectoryListing } from "../../../../../../../packages/contracts/src/local-projects";
import { agentFileAreaResponseSchema, agentStorageSettingsSchema, type AgentStorageSettings } from "../../../../../../../packages/contracts/src/agent-file-areas";
import { acceptFileArea, pmJson, PmApiError, refreshCatalog, scopeContext, usePmChatState, type AgentScope, type AgentFileArea } from "./state";
import { useAgentText } from "../i18n";

export function FileAreaDialog({ scope, name, fileArea, onClose, onDraftStateChange, storageRoot = false, onStorageSaved }: {
  scope: AgentScope; name: string; fileArea: AgentFileArea; onClose: () => void;
  onDraftStateChange?: (state: "clean" | "dirty" | "busy") => void;
  storageRoot?: boolean;
  onStorageSaved?: (settings: AgentStorageSettings) => void;
}) {
  const t = useAgentText();
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
    if (busy || (dirty && !window.confirm(t("目录修改尚未保存，确定放弃这些输入吗？", "Directory changes are not saved yet. Discard these inputs?")))) return;
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
        if (!saved.canManage) throw new Error(t("当前身份已无法管理默认保存根目录，目录输入已保留。", "Your identity can no longer manage the default storage root; your directory inputs were kept."));
        setRevision(saved.revision);
      } else {
        const context = scopeContext(await refreshCatalog(), scope);
        if (!context) throw new Error(t("此工作区或项目已不可用。", "This workspace or project is no longer available."));
        if (!context.fileArea.canManage) throw new Error(t("当前身份已无法管理此目录，目录输入已保留。", "Your identity can no longer manage this directory; your directory inputs were kept."));
        setRevision(context.fileArea.revision);
      }
      setConflict(false);
      setError(t("已读取最新版本；你的目录输入未修改。请核对后再次保存。", "Loaded the latest revision; your directory inputs are unchanged. Review and save again."));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const valid = mode === "existing" ? !!path.trim() : !!parentPath.trim() && !!folderName.trim();
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="pm-agent-directory-dialog max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{storageRoot ? t("工作区默认保存根目录", "Workspace default storage root") : t(`${scope.projectId ? "项目" : "工作区"}文件区域`, `${scope.projectId ? "Project" : "Workspace"} file area`)}</DialogTitle>
        <DialogDescription>{name} · {t("修订版本", "Revision")} {revision}</DialogDescription>
      </DialogHeader>
      <fieldset className="pm-agent-directory-form" disabled={busy || !canManage}>
        <legend className="sr-only">{t("选择文件区域", "Select file area")}</legend>
        <div className="pm-agent-directory-modes">
          <label><input type="radio" name="directory-mode" checked={mode === "existing"} onChange={() => setMode("existing")} />{t("使用已有目录", "Use an existing directory")}</label>
          <label><input type="radio" name="directory-mode" checked={mode === "new"} onChange={() => setMode("new")} />{t("新建文件夹", "Create a new folder")}</label>
        </div>
        {mode === "existing" ? <label>{t("现有目录的绝对路径", "Absolute path of the existing directory")}<Input value={path} onChange={(event) => setPath(event.target.value)} placeholder={t("输入服务端允许的目录", "Enter a directory allowed by the server")} /></label>
          : <><label>{t("父目录的绝对路径", "Absolute path of the parent directory")}<Input value={parentPath} onChange={(event) => setParent(event.target.value)} placeholder={t("输入服务端允许的父目录", "Enter a parent directory allowed by the server")} /></label>
            <label>{t("新文件夹名称", "New folder name")}<Input value={folderName} onChange={(event) => setName(event.target.value)} placeholder={t("仅一个文件夹名称", "A single folder name")} /></label></>}
        <Button type="button" variant="outline" disabled={browsing} onClick={() => void browse()}><FolderIcon />{browsing ? t("正在读取…", "Loading…") : t("浏览已授权的本地项目目录", "Browse authorized local project directories")}</Button>
        {listing && <div className="pm-agent-directory-browser" aria-label={t("服务端目录选择器", "Server directory picker")}>
          <div className="pm-agent-directory-current"><code>{listing.path ?? t("允许的根目录", "Allowed roots")}</code>
            {listing.parentPath && <Button type="button" size="sm" variant="ghost" disabled={browsing} onClick={() => void browse(listing.parentPath!)} aria-label={t("上一级目录", "Parent directory")}><ArrowUpIcon /></Button>}
          </div>
          {listing.path && <Button type="button" size="sm" variant="outline" onClick={() => { if (mode === "existing") setPath(listing.path!); else setParent(listing.path!); }}>{t("选择当前目录", "Use this directory")}</Button>}
          {!listing.path && listing.roots.map((root) => <button type="button" key={root} disabled={browsing} onClick={() => void browse(root)}><FolderIcon /><span>{root}</span></button>)}
          {listing.directories.map((directory) => <button type="button" key={directory.path} disabled={browsing} onClick={() => void browse(directory.path)}><FolderIcon /><span>{directory.name}</span></button>)}
          {listing.path && !listing.directories.length && <p>{t("此目录没有可浏览的子文件夹。", "This directory has no subfolders to browse.")}</p>}
        </div>}
      </fieldset>
      {listingError && <p role="alert" className="text-destructive text-sm">{listingError}</p>}
      {!canManage && <p role="status">{catalogState.error ? t(`无法核验当前目录权限：${catalogState.error}`, `Cannot verify directory permissions: ${catalogState.error}`) : catalogState.loading ? t("正在核验目录权限…", "Verifying directory permissions…") : !current ? t("此工作区或项目已不可访问。", "This workspace or project is no longer accessible.") : t(`当前身份无法管理此目录。${current.fileArea.reason ?? ""}`, `Your identity cannot manage this directory. ${current.fileArea.reason ?? ""}`)}</p>}
      {error && <div role="alert" className="text-destructive text-sm">{t("保存未完成，目录输入已保留：", "Save did not complete; your directory inputs were kept: ")}{error}
        {conflict && <><p>{t("版本冲突或保存结果未知。", "Revision conflict or unknown save result.")}</p><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reloadRevision()}>{t("读取最新版本（保留输入）", "Load latest revision (keep inputs)")}</Button></>}
      </div>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button>
        <Button type="button" disabled={busy || !valid || conflict || !canManage} onClick={() => void save()}>{busy ? t("正在保存…", "Saving…") : storageRoot ? t("保存默认根目录", "Save default root") : t("保存文件区域", "Save file area")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
