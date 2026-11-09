import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertOwnedProcess, assertProcessIdentity, isOwnedProcess, ownedProcessIdentity, readProcessIdentity, rememberOwnedProcess, sameProcessIdentity } from "./process-identity.mjs";

// Windows crash containment is private to this supervisor's Job Object.
// A graceful-stop timeout never closes the supervisor or its Job Object; only
// a helper whose stdin channel is already consumed is terminated by handle.
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
  } else if (process.platform === "darwin") {
    // Capture birth identity while stopped, then exec in-place (same PID). A
    // short runtime probe must not outrun macOS's native identity inspection.
    command = "/bin/sh";
    executable = realpathSync(executable);
    arguments_ = ["-c", 'kill -STOP "$$"; exec "$@"', "desktop-owned-process", executable, ...args];
  }
  const child = spawn(command, arguments_, {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  rememberOwnedProcess(child, process.platform === "darwin" ? { suspendedExecutable: "/bin/sh", executable } : {});
  // Failure to deliver shutdown to an already-exited process is not a stream error.
  child.stdin.on("error", () => {});
  child.desktopSpawned = false;
  child.desktopClosed = false;
  child.once("spawn", () => { child.desktopSpawned = true; });
  child.once("close", () => { child.desktopClosed = true; });
  return child;
}

const observedGroups = new WeakMap();

function liveGroupMembers(child) {
  const owner = ownedProcessIdentity(child);
  if (!owner) return [];
  const liveOwner = assertOwnedProcess(child);
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null ? [owner] : [];
  const pids = process.platform === "linux"
    ? readdirSync("/proc").filter(name => {
      if (!/^\d+$/.test(name)) return false;
      try {
        const text = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        return Number(fields[2]) === owner.group && Number(fields[3]) === owner.session;
      } catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false; throw error; }
    }).map(Number)
    : execFileSync("/bin/ps", ["-axo", "pid=,pgid=,sess="], { encoding: "utf8", timeout: 5000 }).trim().split("\n").flatMap(line => {
      const [pid, group, session] = line.trim().split(/\s+/);
      return Number(group) === owner.group && session === owner.session ? [Number(pid)] : [];
    });
  const members = [];
  const observed = observedGroups.get(child) ?? new Map();
  for (const pid of pids) {
    const current = readProcessIdentity(pid);
    if (current?.group !== owner.group || current.session !== owner.session) continue;
    if (!liveOwner && !sameProcessIdentity(observed.get(pid), current)) throw new Error("An exited desktop root has an unverified or reused descendant identity; refusing to adopt or signal its process group.");
    members.push(current);
  }
  if (liveOwner) {
    if (assertOwnedProcess(child)) for (const identity of members) observed.set(identity.pid, identity);
    else for (const identity of members) {
      if (!sameProcessIdentity(observed.get(identity.pid), identity)) throw new Error("Desktop process ownership changed while inspecting descendants; no new process was adopted.");
    }
  }
  observedGroups.set(child, observed);
  return members;
}

export function ownsLiveProcess(child) {
  if (!child || !isOwnedProcess(child)) return false;
  // Identity failures are not evidence of exit: keep the ownership entry so
  // Stop can report the error and a caller cannot delete a possibly live tree.
  try {
    const owner = ownedProcessIdentity(child);
    if (!owner) return false;
    if (process.platform === "win32" && child.exitCode === null && child.signalCode === null) return true;
    return liveGroupMembers(child).length > 0;
  } catch { return true; }
}

export function signalOwned(child) {
  const members = liveGroupMembers(child); // Throws for an unowned/reused PID.
  if (process.platform === "win32") {
    if (!members.length) return;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) { child.stdin.write('{"type":"desktop-stop"}\n'); return; }
    // One-shot helpers consume stdin to EOF, so the line protocol is gone.
    // Terminate only the identity-verified supervisor handle we spawned; its
    // private kill-on-close Job Object ends the owned tree. No PID lookup and
    // no foreign process is signalled.
    assertOwnedProcess(child);
    if (!child.kill()) throw new Error("The owned desktop supervisor could not be terminated; ownership is retained.");
  } else {
    for (const identity of members) {
      if (!assertProcessIdentity(identity)) continue;
      try { process.kill(identity.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

const stops = new WeakMap();
export function stopOwned(child, { graceMs = 10_000, closeMs = 1500 } = {}) {
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
    // An error event before spawn has no native process to stop.
    if (!child.pid && child.desktopClosed) return;
    signalOwned(child);
    const deadline = Date.now() + graceMs;
    while (ownsLiveProcess(child) && Date.now() < deadline) await delay(25);
    if (ownsLiveProcess(child)) throw new Error("An owned desktop process did not exit before the shutdown deadline. Ownership is retained; retry Stop. No process was force-killed.");
    const closeDeadline = Date.now() + closeMs;
    while (!child.desktopClosed && Date.now() < closeDeadline) await delay(10);
    if (!child.desktopClosed) throw new Error("An owned desktop process did not close its output streams after shutdown; ownership is retained.");
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
