import { execFileSync } from 'node:child_process';
import { lstatSync, type BigIntStats } from 'node:fs';
import path from 'node:path';

// Node exposes junction/symlink mode, but not arbitrary Windows reparse tags.
// Query the native attribute without evaluating caller-controlled PowerShell code.
const attributeScript = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result = foreach ($item in $paths) {
  (([IO.File]::GetAttributes([string]$item) -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))
`;
type Attribute = { stamp: string; reparse: boolean };
const attributes = new Map<string, Attribute>();
const stamp = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** Batch a directory listing so a Markdown scan never starts one PowerShell per
 * file. Cache entries remain valid only for that exact filesystem identity/stamp. */
export function cacheWindowsPathAttributes(filenames: readonly string[]): void {
  if (process.platform !== 'win32') return;
  const pending = new Map<string, { filename: string; stamp: string }>();
  for (const filename of filenames) {
    const key = path.resolve(filename).toLowerCase(), current = stamp(lstatSync(filename, { bigint: true }));
    if (attributes.get(key)?.stamp !== current) pending.set(key, { filename, stamp: current });
  }
  if (!pending.size) return;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows storage path verification requires SystemRoot');
  const paths = [...pending.values()];
  let result: unknown;
  try {
    result = JSON.parse(execFileSync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', attributeScript], {
        input: JSON.stringify(paths.map(item => item.filename)), encoding: 'utf8', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      }));
  } catch { throw new Error('Windows storage path attributes could not be verified'); }
  if (!Array.isArray(result) || result.length !== paths.length || result.some(value => typeof value !== 'boolean')) throw new Error('Invalid Windows storage path attribute result');
  // Bound long-lived server memory while preserving a complete 100,000-node scan.
  if (attributes.size + pending.size > 200_000) attributes.clear();
  let index = 0;
  for (const [key, item] of pending) {
    if (stamp(lstatSync(item.filename, { bigint: true })) !== item.stamp) throw new Error('Windows storage path changed during attribute verification');
    attributes.set(key, { stamp: item.stamp, reparse: result[index++] as boolean });
  }
}
export function assertNoWindowsReparsePath(filename: string, stat: BigIntStats): void {
  if (process.platform !== 'win32') return;
  const key = path.resolve(filename).toLowerCase();
  if (attributes.get(key)?.stamp !== stamp(stat)) cacheWindowsPathAttributes([filename]);
  const result = attributes.get(key);
  if (!result || result.stamp !== stamp(stat)) throw new Error('Windows storage path changed during attribute verification');
  if (result.reparse) throw Object.assign(new Error('Windows reparse points are not allowed in storage paths'), { code: 'EPERM' });
}
