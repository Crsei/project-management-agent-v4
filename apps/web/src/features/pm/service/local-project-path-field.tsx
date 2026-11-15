import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { LocalDirectory, LocalProjectProbe } from '../../../../../../packages/contracts/src/local-projects';
import { usePmService, usePrivateQuery } from './pm-service';
import { pmKeys } from './pm-data';
import { useText } from './pm-ui';
import { localProjectApi } from './local-project-api';
import './local-projects.css';

function directoryPath(directory?: LocalDirectory): string {
  if (!directory) return '';
  if (directory.mode === 'new') return `${directory.parentPath}/${directory.folderName}`;
  return directory.path;
}
function folderName(value: string): string {
  const name = value.trim().replace(/^['"]+|['"]+$/g, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return name && name !== '.' && name !== '..' ? name : '';
}

/** One absolute path is the whole storage choice: missing means create, existing means adopt,
 * and a project marker means recover the registered project instead of creating another. */
export function LocalProjectPathField({ value, suggestedPath, disabled, projectRoot, onChange, onRecover, onFolderName }: {
  value?: LocalDirectory;
  suggestedPath: string;
  disabled: boolean;
  projectRoot: string;
  onChange: (directory: LocalDirectory | undefined) => void;
  onRecover: (projectId: string, path: string) => void;
  onFolderName: (name: string) => void;
}) {
  const service = usePmService();
  const { actor, workspace } = service;
  const t = useText();
  const api = useMemo(() => workspace ? localProjectApi(service.client, workspace.id) : null, [service.client, workspace]);
  const initial = directoryPath(value) || suggestedPath;
  const [text, setText] = useState(initial);
  const edited = useRef(false);
  const hadValue = useRef(Boolean(value));
  const lastSuggestion = useRef(initial);
  const [probe, setProbe] = useState<LocalProjectProbe>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState<string>();
  const listing = usePrivateQuery([...pmKeys.workspace(window.location.origin, actor?.id ?? 'anonymous', workspace?.id ?? 'none'), 'local-projects', 'directories', browsePath ?? null], 'access.manage', undefined,
    (client, workspaceId, signal) => localProjectApi(client, workspaceId).directories(browsePath, signal), browsing && !disabled && workspace?.projectIds === null);
  const current = directoryPath(value);

  useEffect(() => {
    if (hadValue.current) edited.current = true;
  }, []);
  useEffect(() => {
    if (disabled) return;
    if (!current && suggestedPath) { lastSuggestion.current = suggestedPath; onChange({ mode: 'auto', path: suggestedPath }); }
  }, []);
  useEffect(() => {
    if (disabled || edited.current) return;
    if (current && current !== lastSuggestion.current) { setText(current); return; }
    if (suggestedPath && suggestedPath !== lastSuggestion.current) {
      lastSuggestion.current = suggestedPath;
      setText(suggestedPath);
      onChange({ mode: 'auto', path: suggestedPath });
    }
  }, [suggestedPath]);
  useEffect(() => {
    if (edited.current || !current) return;
    lastSuggestion.current = current;
    setText(current);
  }, [current]);

  useEffect(() => {
    if (disabled || !api || !text.trim() || !(text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(text))) { setProbe(undefined); setProbeError(''); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setProbing(true);
      api.probe(text.trim(), controller.signal)
        .then(result => { if (!controller.signal.aborted) { setProbe(result); setProbeError(''); } })
        .catch(error => { if (!controller.signal.aborted) { setProbe(undefined); setProbeError(error instanceof Error ? error.message : String(error)); } })
        .finally(() => { if (!controller.signal.aborted) setProbing(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, disabled, text]);

  function change(next: string) {
    edited.current = true;
    setText(next);
    onChange(next.trim() ? { mode: 'auto', path: next } : undefined);
  }
  function choose(path: string) {
    edited.current = true;
    setText(path);
    onChange({ mode: 'auto', path });
    const name = folderName(path);
    if (name) onFolderName(name);
    setBrowsing(false);
  }
  return <fieldset className="local-directory-fields" disabled={disabled}>
    <legend>{t('服务器上的项目文件夹', 'Project folder on the server')}</legend>
    <label>{t('项目目录绝对路径（必填）', 'Project directory absolute path (required)')}
      <input aria-label={t('项目目录绝对路径', 'Project directory absolute path')} value={text} required disabled={disabled} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event => change(event.target.value)} onPaste={event => { const name = folderName(event.clipboardData.getData('text')); if (name) onFolderName(name); }} onBlur={() => { if (edited.current) { const name = folderName(text); if (name) onFolderName(name); } }} />
    </label>
    <button type="button" className="secondary-button local-button" disabled={disabled} onClick={() => { setBrowsePath(undefined); setBrowsing(true); }}>{t('浏览文件夹', 'Browse folders')}</button>
    <p className="local-hint">{t('路径不存在会新建；已存在则接管并保留原文件。这是服务主机路径，不是浏览器上传；服务端仍拒绝符号链接、系统目录和路径逃逸。', 'A missing path is created; an existing directory is adopted and its files preserved. This is a host path, not a browser upload; the server still rejects symlinks, system directories and escapes.')}</p>
    {probing && <p role="status">{t('正在检查路径…', 'Checking path…')}</p>}
    {probeError && <p role="alert">{probeError}</p>}
    {probe?.markerProblem && <p role="alert">{t('该目录包含不完整或无效的项目标记，不能接管。', 'This directory contains an incomplete or invalid project marker and cannot be adopted.')}</p>}
    {probe?.problem === 'foreign_workspace' && <p role="alert">{t('该目录属于其他工作区，不能在当前工作区导入。', 'This directory belongs to another workspace and cannot be imported here.')}</p>}
    {probe?.problem === 'unknown_project' && <p role="alert">{t('标记中的项目不在当前工作区，不能作为新项目创建。', 'The marked project is not in this workspace and cannot be created as a new project.')}</p>}
    {probe?.project && <div className="local-notice" role="status">
      <p>{t('检测到已有项目', 'Existing project detected')}: <strong>{probe.project.title}</strong> · <code>{probe.project.projectId}</code></p>
      {probe.project.locationStatus === 'available'
        ? <Link className="secondary-button local-button" to={`${projectRoot}/projects/${encodeURIComponent(probe.project.projectId)}`}>{t('打开项目', 'Open project')}</Link>
        : <button type="button" className="secondary-button local-button" onClick={() => onRecover(probe.project!.projectId, probe.path)}>{t('找回并打开', 'Recover and open')}</button>}
    </div>}
    {browsing && <section className="local-directory-browser" aria-label={t('服务主机目录浏览器', 'Host directory browser')}>
      <div className="local-actions"><strong>{t('文件夹', 'Folders')}</strong><button type="button" className="secondary-button local-button" onClick={() => setBrowsing(false)}>{t('关闭浏览', 'Close browser')}</button></div>
      {listing.isPending && <p role="status">{t('读取目录…', 'Reading directories…')}</p>}
      {listing.error && <div role="alert"><p>{listing.error.message}</p><button type="button" className="secondary-button local-button" onClick={() => { void listing.refetch(); }}>{t('重新读取', 'Read again')}</button></div>}
      {listing.data && <>
        <p className="local-path">{listing.data.path ?? t('文件系统根目录', 'Filesystem root')}</p>
        <div className="local-actions"><button type="button" className="secondary-button local-button" onClick={() => setBrowsePath(undefined)}>{t('文件系统根目录', 'Filesystem root')}</button>{listing.data.parentPath && <button type="button" className="secondary-button local-button" onClick={() => setBrowsePath(listing.data!.parentPath!)}>{t('上一级', 'Parent folder')}</button>}{listing.data.path && listing.data.path !== listing.data.roots[0] && <button type="button" className="secondary-button local-button" onClick={() => choose(listing.data!.path!)}>{t('选择当前文件夹', 'Select current folder')}</button>}</div>
        <ul>{(listing.data.path ? listing.data.directories : listing.data.roots.map(path => ({ name: path, path }))).map(item => <li key={item.path}><button type="button" className="secondary-button local-button local-folder" onClick={() => setBrowsePath(item.path)}>{item.name}</button></li>)}</ul>
        {listing.data.path && listing.data.directories.length === 0 && <p>{t('没有可浏览的子文件夹。', 'No browsable subfolders.')}</p>}
      </>}
    </section>}
  </fieldset>;
}
