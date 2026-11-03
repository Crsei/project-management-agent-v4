import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Windows has no POSIX process groups. A private kill-on-close Job Object keeps
// every descendant owned even when its Node parent exits before desktop does.
const windowsJob = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet;
    public uint activeProcesses;
    public UIntPtr affinity;
    public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits basic;
    public Io io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public uint size;
    public string reserved, desktop, title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize;
    public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup startup;
    public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread;
    public uint processId, threadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string executable, string command, string directory) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    ProcessInfo process = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero;
    bool initializedAttributes = false;
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.basic.flags = 0x2000;
      int length = Marshal.SizeOf(limits);
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        Marshal.StructureToPtr(limits, buffer, false);
        Check(SetInformationJobObject(job, 9, buffer, (uint)length));
      } finally { Marshal.FreeHGlobal(buffer); }
      StartupEx startup = new StartupEx();
      startup.startup.size = (uint)Marshal.SizeOf(startup);
      startup.startup.flags = 0x100;
      startup.startup.input = GetStdHandle(-10); startup.startup.output = GetStdHandle(-11); startup.startup.error = GetStdHandle(-12);
      Check(SetHandleInformation(startup.startup.input, 1, 1));
      Check(SetHandleInformation(startup.startup.output, 1, 1));
      Check(SetHandleInformation(startup.startup.error, 1, 1));
      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      attributes = Marshal.AllocHGlobal(attributeSize);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize));
      initializedAttributes = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobValue, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns ownership atomically at create;
      // killing desktop cannot leave an unassigned suspended child behind.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      startup.attributes = attributes;
      Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, directory, ref startup, out process));
      Check(WaitForSingleObject(process.process, 0xffffffff) == 0);
      uint code; Check(GetExitCodeProcess(process.process, out code));
      return unchecked((int)code);
    } finally {
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (initializedAttributes) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
      CloseHandle(job);
    }
  }
}
`;

function windowsArgument(value) {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export function spawnOwned(executable, args, { cwd, env }) {
  let command = executable;
  let arguments_ = args;
  if (process.platform === "win32") {
    command = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const encode = (value) => Buffer.from(value, "utf8").toString("base64");
    const decode = (value) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(value)}'))`;
    const script = `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; try { Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); Add-Type -TypeDefinition (${decode(windowsJob)}); $result=[DesktopProcessJob]::Run((${decode(executable)}),(${decode([executable, ...args].map(windowsArgument).join(" "))}),(${decode(cwd)})); exit $result } catch { [Console]::Error.WriteLine('Cannot start owned desktop process: '+$_.Exception.Message); exit 1 }`;
    arguments_ = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  }
  const child = spawn(command, arguments_, {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  // Failure to deliver shutdown to an already-exited process is not a stream error.
  child.stdin.on("error", () => {});
  child.desktopSpawned = false;
  child.desktopClosed = false;
  child.once("spawn", () => { child.desktopSpawned = true; });
  child.once("close", () => { child.desktopClosed = true; });
  return child;
}

export function ownsLiveProcess(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    if (process.platform === "linux" && (child.exitCode !== null || child.signalCode !== null)) {
      // Linux containers can retain adopted zombies. They own no resources and
      // cannot receive signals; do not report them as running descendants.
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const info = readFileSync(`/proc/${name}/stat`, "utf8");
          const fields = info.slice(info.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === child.pid && fields[0] !== "Z" && fields[0] !== "X") return true;
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") return true; }
      }
      return false;
    }
    return true;
  }
  catch (error) { return error.code !== "ESRCH"; }
}

export function signalOwned(child, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Closing only this supervisor's handle closes its Job Object, not a process
    // selected by port/name and never an existing development service.
    if (force && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    else if (!force && !child.stdin.destroyed) child.stdin.write('{"type":"desktop-stop"}\n');
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

const stops = new WeakMap();
export function stopOwned(child, { graceMs = 2500, forceMs = 1500, force = false } = {}) {
  if (stops.has(child)) return stops.get(child);
  const stopping = (async () => {
    if (!child.pid && !child.desktopClosed) {
      await new Promise((resolve) => {
        child.once("spawn", resolve);
        child.once("error", resolve);
        child.once("close", resolve);
        if (child.pid || child.desktopClosed) resolve();
      });
    }
    if (ownsLiveProcess(child)) {
      signalOwned(child, force);
      const deadline = Date.now() + (force ? forceMs : graceMs);
      while (ownsLiveProcess(child) && Date.now() < deadline) await delay(25);
      if (ownsLiveProcess(child)) {
        signalOwned(child, true);
        const forcedDeadline = Date.now() + forceMs;
        while (ownsLiveProcess(child) && Date.now() < forcedDeadline) await delay(25);
      }
    }
    if (ownsLiveProcess(child)) throw new Error("An owned desktop process did not exit after forced shutdown.");
    const closeDeadline = Date.now() + forceMs;
    while (!child.desktopClosed && Date.now() < closeDeadline) await delay(10);
    if (!child.desktopClosed) throw new Error("An owned desktop process did not close its output streams after shutdown.");
  })();
  stops.set(child, stopping);
  void stopping.catch(() => { stops.delete(child); });
  return stopping;
}

// Existing service signal handlers stay authoritative on Windows too. The pipe
// is not an event-loop keepalive and its input is exclusively the owning host.
export const serviceEntry = `
import { pathToFileURL } from 'node:url';
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let boundary;
  while ((boundary = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
    if (line === '{"type":"desktop-stop"}') process.emit('SIGTERM');
  }
});
process.stdin.on('error', () => {});
process.stdin.unref?.();
await import(pathToFileURL(process.argv[1]).href);
`;
