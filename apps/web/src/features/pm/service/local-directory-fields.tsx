import { useEffect, useRef, useState } from 'react';
import type { LocalDirectory } from '../../../../../../packages/contracts/src/local-projects';
import { usePmService, usePrivateQuery } from './pm-service';
import { pmKeys } from './pm-data';
import { useText } from './pm-ui';
import { localProjectApi } from './local-project-api';
import './local-projects.css';
import { RadixSelect } from "@/components/ui/radix-select"

export function LocalDirectoryFields({ value, defaultParent, disabled, existingOnly = false, onChange }: {
  value?: LocalDirectory; defaultParent: string | null; disabled: boolean; existingOnly?: boolean; onChange: (directory: LocalDirectory) => void;
}) {
  const { actor, workspace } = usePmService();
  const t = useText();
  const initialDirectory = (): LocalDirectory => value ?? (existingOnly ? { mode: 'existing', path: defaultParent ?? '' } : { mode: 'new', parentPath: defaultParent ?? '', folderName: '' });
  const [directory, setDirectory] = useState<LocalDirectory>(initialDirectory);
  const editing = useRef(false);
  useEffect(() => {
    // Creation drafts persist under an asynchronous cross-tab lock. Do not let
    // delayed acknowledgements reset the native input between keystrokes.
    if (!editing.current || disabled) setDirectory(value ?? (existingOnly ? { mode: 'existing', path: defaultParent ?? '' } : { mode: 'new', parentPath: defaultParent ?? '', folderName: '' }));
  }, [value, defaultParent, existingOnly, disabled]);
  function change(directory: LocalDirectory) {
    setDirectory(directory);
    onChange(directory);
  }
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState<string>();
  const listing = usePrivateQuery([...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'local-projects', 'directories', browsePath ?? null], 'access.manage', undefined,
    (client, workspaceId, signal) => localProjectApi(client, workspaceId).directories(browsePath, signal), browsing && !disabled && workspace?.projectIds === null);
  const path = directory.mode === 'existing' ? directory.path : directory.parentPath;
  function choose(path: string) {
    change(directory.mode === 'existing' ? { mode: 'existing', path } : { ...directory, parentPath: path });
    setBrowsing(false);
  }
  return <fieldset className="local-directory-fields" disabled={disabled}>
    <legend>{t('服务器上的项目文件夹', 'Project folder on the server')}</legend>
    {!existingOnly && <label>{t('保存模式', 'Save mode')}<RadixSelect aria-label={t('保存模式', 'Save mode')} value={directory.mode} onChange={event => change(event.target.value === 'existing' ? { mode: 'existing', path } : { mode: 'new', parentPath: path, folderName: '' })}>
      <option value="new">{t('在父目录下新建文件夹', 'New subfolder in a parent directory')}</option>
      <option value="existing">{t('使用已有目录（保留原文件）', 'Use an existing directory (preserve files)')}</option>
    </RadixSelect></label>}
    <label>{directory.mode === 'existing' ? t('已有目录绝对路径', 'Existing directory absolute path') : t('父目录绝对路径', 'Parent directory absolute path')}
      <input aria-label={directory.mode === 'existing' ? t('已有目录绝对路径', 'Existing directory absolute path') : t('父目录绝对路径', 'Parent directory absolute path')} value={path} maxLength={4096} autoComplete="off" spellCheck={false} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={event => change(directory.mode === 'existing' ? { mode: 'existing', path: event.target.value } : { ...directory, parentPath: event.target.value })} />
    </label>
    {directory.mode === 'new' && <label>{t('新文件夹名称', 'New folder name')}<input aria-label={t('新文件夹名称', 'New folder name')} value={directory.folderName} maxLength={255} autoComplete="off" onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={event => change({ ...directory, folderName: event.target.value })} /></label>}
    <button type="button" className="secondary-button local-button" onClick={() => { setBrowsePath(undefined); setBrowsing(true); }}>{t('浏览已授权文件夹', 'Browse authorized folders')}</button>
    <p className="local-hint">{t('这是运行本地服务的主机路径，不是浏览器上传文件夹。输入路径不会扩大服务端授权根范围；符号链接和路径逃逸由服务端拒绝。', 'This is a path on the local service host, not a browser folder upload. Typing a path never expands server-authorized roots; the server rejects symlinks and escapes.')}</p>
    {browsing && <section className="local-directory-browser" aria-label={t('受限主机目录浏览器', 'Restricted host directory browser')}>
      <div className="local-actions"><strong>{t('文件夹', 'Folders')}</strong><button type="button" className="secondary-button local-button" onClick={() => setBrowsing(false)}>{t('关闭浏览', 'Close browser')}</button></div>
      {listing.isPending && <p role="status">{t('读取已授权目录…', 'Reading authorized directories…')}</p>}
      {listing.error && <div role="alert"><p>{listing.error.message}</p><button type="button" className="secondary-button local-button" onClick={() => { void listing.refetch(); }}>{t('重新读取', 'Read again')}</button></div>}
      {listing.data && <>
        <p className="local-path">{listing.data.path ?? t('允许的根目录', 'Allowed roots')}</p>
        <div className="local-actions"><button type="button" className="secondary-button local-button" onClick={() => setBrowsePath(undefined)}>{t('授权根目录', 'Authorized roots')}</button>{listing.data.parentPath && <button type="button" className="secondary-button local-button" onClick={() => setBrowsePath(listing.data!.parentPath!)}>{t('上一级', 'Parent folder')}</button>}{listing.data.path && <button type="button" className="secondary-button local-button" onClick={() => choose(listing.data!.path!)}>{t('选择当前文件夹', 'Select current folder')}</button>}</div>
        <ul>{(listing.data.path ? listing.data.directories : listing.data.roots.map(path => ({ name: path, path }))).map(item => <li key={item.path}><button type="button" className="secondary-button local-button local-folder" onClick={() => setBrowsePath(item.path)}>{item.name}</button></li>)}</ul>
        {listing.data.path && listing.data.directories.length === 0 && <p>{t('没有可浏览的子文件夹。', 'No browsable subfolders.')}</p>}
      </>}
    </section>}
  </fieldset>;
}
