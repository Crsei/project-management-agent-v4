import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makePrivatePath } from './private-path.ts';

const maxBatchPaths = 256;
const maxBatchBytes = 128 * 1024;
// Node exposes junction/symlink mode, but not arbitrary Windows reparse tags.
// Compile once; each one-shot query still reads a non-following handle and its file ID.
const attributeProgram = String.raw`
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using Microsoft.Win32.SafeHandles;
[DataContract]
public class PmNativePathAttributes {
  [DataMember] public string dev, ino, mtimeNs, ctimeNs;
  [DataMember] public bool reparse;
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
  public static int Main() {
    try {
      var input = new byte[${maxBatchBytes + 1}];
      int length = 0;
      using (var stream = Console.OpenStandardInput()) {
        while (length < input.Length) {
          int count = stream.Read(input, length, input.Length - length);
          if (count == 0) break;
          length += count;
        }
      }
      if (length > ${maxBatchBytes}) throw new InvalidDataException();
      string[] paths;
      using (var stream = new MemoryStream(input, 0, length)) {
        paths = (string[])new DataContractJsonSerializer(typeof(string[])).ReadObject(stream);
      }
      if (paths == null || paths.Length > ${maxBatchPaths}) throw new InvalidDataException();
      var result = new PmNativePathAttributes[paths.Length];
      for (int index = 0; index < paths.Length; index++) result[index] = Read(paths[index]);
      new DataContractJsonSerializer(typeof(PmNativePathAttributes[])).WriteObject(Console.OpenStandardOutput(), result);
      return 0;
    } catch {
      Console.Error.Write("Windows storage path attributes could not be verified");
      return 1;
    }
  }
}
`;
const attributeCompiler = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
$program = @'
${attributeProgram}
'@
Add-Type -TypeDefinition $program -ReferencedAssemblies @('System.dll','System.Runtime.Serialization.dll','System.Xml.dll') -OutputAssembly $env:PM_NATIVE_ATTRIBUTE_HELPER -OutputType ConsoleApplication
`;
type NativeAttribute = { dev: string; ino: string; mtimeNs: string; ctimeNs: string; reparse: boolean };
type Attribute = { stamp: string; identity: string; reparse: boolean };
const attributes = new Map<string, Attribute>();
const nativeAttributeKeys = ['dev', 'ino', 'mtimeNs', 'ctimeNs'] as const;
const integerText = /^-?\d+$/;
const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.birthtimeNs}`;
const stamp = (stat: BigIntStats, times?: NativeAttribute): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${times?.mtimeNs ?? stat.mtimeNs}:${times?.ctimeNs ?? stat.ctimeNs}`;
const metrics = { helperCompilations: 0, helperCompileElapsedMs: 0, nativeCalls: 0, nativePaths: 0, nativeElapsedMs: 0, cacheHits: 0, cacheMisses: 0, cacheInvalidations: 0 };

/** Process-local counters for helper compilation and attribute queries, not private-path ACL setup.
 * Reading metrics never clears or relaxes the identity/stamp cache. */
export function getWindowsPathAttributeMetrics(): Readonly<typeof metrics> { return { ...metrics }; }
function isNativeAttribute(value: unknown): value is NativeAttribute {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.reparse === 'boolean' && nativeAttributeKeys.every(key => typeof item[key] === 'string' && integerText.test(item[key] as string));
}

let helperScratch: string | undefined;
let helper: { filename: string; stamp: string; identity: string } | undefined;
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

function helperProgram(): { filename: string; env: NodeJS.ProcessEnv } {
  const env = helperEnvironment();
  if (!helper) {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows storage path verification requires SystemRoot');
    const filename = path.join(helperScratch!, 'pm-native-attributes.exe');
    try {
      lstatSync(filename);
      throw new Error('Unexpected Windows storage path attribute helper output');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const started = performance.now();
    metrics.helperCompilations++;
    try {
      execFileSync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', attributeCompiler], {
          cwd: helperScratch, env: { ...env, PM_NATIVE_ATTRIBUTE_HELPER: filename }, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024,
        });
      const stat = lstatSync(filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Unsafe Windows attribute helper');
      helper = { filename, stamp: stamp(stat), identity: identity(stat) };
    } catch { throw new Error('Windows storage path attribute helper could not be compiled'); }
    finally { metrics.helperCompileElapsedMs += performance.now() - started; }
  }
  assertHelperUnchanged();
  return { filename: helper.filename, env };
}

function assertHelperUnchanged(): void {
  const stat = lstatSync(helper!.filename, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stamp(stat) !== helper!.stamp || identity(stat) !== helper!.identity)
    throw new Error('Windows storage path attribute helper changed');
}

/** Batch a directory listing so a Markdown scan never starts one helper per file.
 * Cache entries remain valid only for that exact filesystem identity/stamp.
 * Bound both request bytes and handles queried per process, including for callers
 * that pass a complete source inventory rather than one directory listing. */
export function cacheWindowsPathAttributes(filenames: readonly string[]): void {
  if (process.platform !== 'win32') return;
  const pending = new Map<string, { filename: string; stamp: string; identity: string; directory: boolean }>();
  let requestBytes = 2;
  const flush = (): void => {
    if (!pending.size) return;
    const paths = [...pending.values()];
    const program = helperProgram();
    let output: string;
    const started = performance.now();
    metrics.nativeCalls++;
    metrics.nativePaths += paths.length;
    try {
      output = execFileSync(program.filename, [], {
        input: JSON.stringify(paths.map(item => item.filename)), encoding: 'utf8', windowsHide: true,
        env: program.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
      });
      assertHelperUnchanged();
    } catch { throw new Error('Windows storage path attributes could not be verified'); }
    finally { metrics.nativeElapsedMs += performance.now() - started; }
    let result: unknown;
    try { result = JSON.parse(output); }
    catch { throw new Error('Invalid Windows storage path attribute result'); }
    if (!Array.isArray(result) || result.length !== paths.length || !result.every(isNativeAttribute)) throw new Error('Invalid Windows storage path attribute result');
    const verified: [string, Attribute][] = [];
    let index = 0;
    for (const [key, item] of pending) {
      const native = result[index++] as NativeAttribute;
      const after = lstatSync(item.filename, { bigint: true });
      if (identity(after) !== item.identity || native.dev !== String(after.dev) || native.ino !== String(after.ino) || (!item.directory && stamp(after) !== item.stamp))
        throw new Error('Windows storage path changed during attribute verification');
      // Child creation changes directory mtime AND ctime without replacing the directory.
      // Cache the handle's actual attribute timestamp, never a later unrelated snapshot.
      verified.push([key, { stamp: stamp(after, native), identity: item.identity, reparse: native.reparse }]);
    }
    // Do not publish any entries from a partially verified batch.
    // Bound long-lived server memory while preserving a complete 100,000-node scan.
    if (attributes.size + pending.size > 200_000) attributes.clear();
    for (const [key, value] of verified) attributes.set(key, value);
    pending.clear();
    requestBytes = 2;
  };
  for (const filename of filenames) {
    const stat = lstatSync(filename, { bigint: true });
    const key = path.resolve(filename).toLowerCase(), current = stamp(stat);
    const cached = attributes.get(key);
    if (cached?.stamp === current && cached.identity === identity(stat)) { metrics.cacheHits++; continue; }
    if (pending.has(key)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(filename), 'utf8') + 1;
    if (bytes + 2 > maxBatchBytes) throw new Error('Windows storage path exceeds the bounded attribute request size');
    if (pending.size >= maxBatchPaths || requestBytes + bytes > maxBatchBytes) flush();
    metrics.cacheMisses++;
    if (cached) { metrics.cacheInvalidations++; attributes.delete(key); }
    pending.set(key, { filename, stamp: current, identity: identity(stat), directory: stat.isDirectory() });
    requestBytes += bytes;
  }
  flush();
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
    if (cached.stamp === currentStamp) metrics.cacheHits++;
  }
  if (cached?.stamp !== currentStamp) cacheWindowsPathAttributes([filename]);
  const result = attributes.get(key);
  if (!result || (stat.isDirectory() ? result.identity !== identity(stat) : result.stamp !== suppliedStamp)) throw new Error('Windows storage path changed during attribute verification');
  if (result.reparse) throw Object.assign(new Error('Windows reparse points are not allowed in storage paths'), { code: 'EPERM' });
}
