import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makePrivatePath } from './private-path.ts';

// Node exposes junction/symlink mode, but not arbitrary Windows reparse tags.
// Read attributes and their timestamps from a non-following handle, bound to its file ID.
const attributeScript = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class PmNativePathAttributes {
  public string dev, ino, mtimeNs, ctimeNs;
  public bool reparse;
  [StructLayout(LayoutKind.Sequential)]
  struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation {
    public long Creation, Access, Write, Change;
    public uint Attributes;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out BasicInformation information, uint size);
  static string Nanoseconds(long fileTime) {
    return checked((fileTime - 116444736000000000L) * 100L).ToString(CultureInfo.InvariantCulture);
  }
  public static PmNativePathAttributes Read(string name) {
    // READ_ATTRIBUTES, shared read/write/delete, OPEN_EXISTING,
    // BACKUP_SEMANTICS for directories and OPEN_REPARSE_POINT to avoid following links.
    using (var handle = CreateFileW(name, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation file;
      BasicInformation basic;
      if (!GetFileInformationByHandle(handle, out file) ||
          !GetFileInformationByHandleEx(handle, 0, out basic, (uint)Marshal.SizeOf(typeof(BasicInformation))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return new PmNativePathAttributes {
        dev = file.Volume.ToString(CultureInfo.InvariantCulture),
        ino = (((ulong)file.IndexHigh << 32) | file.IndexLow).ToString(CultureInfo.InvariantCulture),
        mtimeNs = Nanoseconds(basic.Write), ctimeNs = Nanoseconds(basic.Change),
        reparse = (basic.Attributes & 0x400) != 0
      };
    }
  }
}
'@
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result = foreach ($item in $paths) {
  [PmNativePathAttributes]::Read([string]$item)
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))
`;
type NativeAttribute = { dev: string; ino: string; mtimeNs: string; ctimeNs: string; reparse: boolean };
type Attribute = { stamp: string; identity: string; reparse: boolean };
const attributes = new Map<string, Attribute>();
const nativeAttributeKeys = ['dev', 'ino', 'mtimeNs', 'ctimeNs'] as const;
const integerText = /^-?\d+$/;
const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.birthtimeNs}`;
const stamp = (stat: BigIntStats, times?: NativeAttribute): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${times?.mtimeNs ?? stat.mtimeNs}:${times?.ctimeNs ?? stat.ctimeNs}`;
function isNativeAttribute(value: unknown): value is NativeAttribute {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.reparse === 'boolean' && nativeAttributeKeys.every(key => typeof item[key] === 'string' && integerText.test(item[key] as string));
}

let helperScratch: string | undefined;
function helperEnvironment(): NodeJS.ProcessEnv {
  if (!helperScratch) {
    const scratch = mkdtempSync(path.join(tmpdir(), 'pm-native-attributes-'));
    try { makePrivatePath(scratch); }
    catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
    helperScratch = scratch;
    process.once('exit', () => {
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch { /* A crashed/terminating process may leave only private compiler scratch. */ }
    });
  }
  // PowerShell's compiler must not mutate the shared Temp ancestor on every query:
  // those self-induced timestamps would invalidate every checked storage lineage.
  return { ...process.env, TEMP: helperScratch, TMP: helperScratch };
}

/** Batch a directory listing so a Markdown scan never starts one PowerShell per
 * file. Cache entries remain valid only for that exact filesystem identity/stamp. */
export function cacheWindowsPathAttributes(filenames: readonly string[]): void {
  if (process.platform !== 'win32') return;
  const pending = new Map<string, { filename: string; stamp: string; identity: string; directory: boolean }>();
  for (const filename of filenames) {
    const stat = lstatSync(filename, { bigint: true });
    const key = path.resolve(filename).toLowerCase(), current = stamp(stat);
    if (attributes.get(key)?.stamp !== current) pending.set(key, { filename, stamp: current, identity: identity(stat), directory: stat.isDirectory() });
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
        env: helperEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
      }));
  } catch { throw new Error('Windows storage path attributes could not be verified'); }
  if (!Array.isArray(result) || result.length !== paths.length || !result.every(isNativeAttribute)) throw new Error('Invalid Windows storage path attribute result');
  // Bound long-lived server memory while preserving a complete 100,000-node scan.
  if (attributes.size + pending.size > 200_000) attributes.clear();
  let index = 0;
  for (const [key, item] of pending) {
    const native = result[index++] as NativeAttribute;
    const after = lstatSync(item.filename, { bigint: true });
    if (identity(after) !== item.identity || native.dev !== String(after.dev) || native.ino !== String(after.ino) || (!item.directory && stamp(after) !== item.stamp))
      throw new Error('Windows storage path changed during attribute verification');
    // Child creation changes directory mtime AND ctime without replacing the directory.
    // Cache the handle's actual attribute timestamp, never a later unrelated snapshot.
    attributes.set(key, { stamp: stamp(after, native), identity: item.identity, reparse: native.reparse });
  }
}
export function assertNoWindowsReparsePath(filename: string, stat: BigIntStats): void {
  if (process.platform !== 'win32') return;
  const key = path.resolve(filename).toLowerCase();
  const cached = attributes.get(key), suppliedStamp = stamp(stat);
  let currentStamp = suppliedStamp;
  if (cached?.stamp === suppliedStamp) {
    // A cache hit must not certify a path replaced after the caller took its stat.
    const current = lstatSync(filename, { bigint: true });
    currentStamp = stamp(current);
    if (identity(current) !== identity(stat) || (!stat.isDirectory() && currentStamp !== suppliedStamp))
      throw new Error('Windows storage path changed during attribute verification');
  }
  if (cached?.stamp !== currentStamp) cacheWindowsPathAttributes([filename]);
  const result = attributes.get(key);
  if (!result || (stat.isDirectory() ? result.identity !== identity(stat) : result.stamp !== suppliedStamp)) throw new Error('Windows storage path changed during attribute verification');
  if (result.reparse) throw Object.assign(new Error('Windows reparse points are not allowed in storage paths'), { code: 'EPERM' });
}
