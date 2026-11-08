import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const records = new WeakMap();
let bootIdentity;

// PID alone is never authority. Read creation identity from the native process
// table, not a pid file, image-name search, listening port, or caller's claim.
export function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid desktop process PID.");
  try {
    if (process.platform === "linux") {
      let text, executable;
      try {
        text = readFileSync(`/proc/${pid}/stat`, "utf8");
        executable = readlinkSync(`/proc/${pid}/exe`);
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        try { process.kill(pid, 0); }
        catch (failure) { if (failure.code === "ESRCH") return null; throw failure; }
        // A zombie has no executable but its stat still proves it has exited.
        if (text && ["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2).split(" ")[0])) return null;
        throw new Error("The live process has no accessible native /proc identity.");
      }
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (["Z", "X"].includes(fields[0])) return null;
      bootIdentity ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return Object.freeze({ pid, creationTime: `${bootIdentity}:${fields[19]}`, executable, group: Number(fields[2]), session: Number(fields[3]) });
    }
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'); $p=$null; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $v=[ordered]@{pid=$p.Id;creationTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();executable=$p.MainModule.FileName}; ConvertTo-Json -InputObject $v -Compress } catch { if ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException] -or ($p -and $p.HasExited)) { exit 3 }; throw }`;
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      return Object.freeze(JSON.parse(execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { SystemRoot: process.env.SystemRoot || "C:\\Windows" }, maxBuffer: 8192 }).trim()));
    }
    if (process.platform === "darwin") {
      // ps lstart is only second-resolution and can accept a reused same-image
      // PID. libproc's native BSD record includes the microsecond birth time.
      // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
      const script = `ObjC.import('Foundation'); ObjC.bindFunction('proc_pidinfo',['int',['int','int','unsigned long long','void *','int']]); ObjC.bindFunction('proc_pidpath',['int',['int','void *','unsigned int']]); const info=$.NSMutableData.dataWithLength(136), after=$.NSMutableData.dataWithLength(136), path=$.NSMutableData.dataWithLength(4096); if($.proc_pidinfo(${pid},3,0,info.mutableBytes,136)!==136) { JSON.stringify({missing:true}); } else { const length=$.proc_pidpath(${pid},path.mutableBytes,4096); if(length<=0 || $.proc_pidinfo(${pid},3,0,after.mutableBytes,136)!==136) throw Error('Unverifiable native process identity'); JSON.stringify({before:ObjC.unwrap(info.base64EncodedStringWithOptions(0)),after:ObjC.unwrap(after.base64EncodedStringWithOptions(0)),path:ObjC.unwrap(path.base64EncodedStringWithOptions(0))}); }`;
      const result = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 16_384 }).trim());
      if (result.missing) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return null; throw error; }
        throw new Error("macOS process creation identity is inaccessible.");
      }
      const before = Buffer.from(result.before, "base64"), after = Buffer.from(result.after, "base64");
      if (before.length !== 136 || after.length !== 136 || before.readUInt32LE(12) !== pid || after.readUInt32LE(12) !== pid || !before.subarray(120, 136).equals(after.subarray(120, 136))) throw new Error("macOS process creation identity changed during inspection.");
      if (after.readUInt32LE(4) === 5) return null;
      const path = Buffer.from(result.path, "base64");
      const boundary = path.indexOf(0);
      if (boundary <= 0) throw new Error("Missing macOS process executable identity.");
      const session = execFileSync("/bin/ps", ["-p", String(pid), "-o", "sess="], { encoding: "utf8", timeout: 5000 }).trim();
      return Object.freeze({ pid, creationTime: `${before.readBigUInt64LE(120)}:${before.readBigUInt64LE(128)}`, executable: path.subarray(0, boundary).toString("utf8"), group: before.readUInt32LE(100), session, state: after.readUInt32LE(4) });
    }
    throw new Error("Native desktop process identities are unsupported on this OS.");
  } catch (error) {
    if (process.platform === "win32" && error.status === 3) return null;
    throw new Error("Cannot verify native desktop process creation identity.", { cause: error });
  }
}

export function sameProcessIdentity(expected, actual) {
  if (!expected || !actual || expected.pid !== actual.pid || expected.creationTime !== actual.creationTime) return false;
  const left = resolve(expected.executable), right = resolve(actual.executable);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function assertProcessIdentity(expected) {
  if (!expected || !Number.isSafeInteger(expected.pid) || typeof expected.creationTime !== "string" || !expected.creationTime || typeof expected.executable !== "string") throw new Error("Desktop process ownership identity is missing.");
  const current = readProcessIdentity(expected.pid);
  if (current && !sameProcessIdentity(expected, current)) throw new Error("Desktop process PID was reused or its executable identity changed; refusing shutdown.");
  return current;
}

export function rememberOwnedProcess(child, { suspendedExecutable, executable } = {}) {
  if (records.has(child)) return child;
  const record = { identity: null, error: null };
  records.set(child, record);
  const capture = () => {
    try {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("The spawned desktop process exited before its creation identity was captured. Descendant ownership is unknown and retained; cleanup is refused.");
      const identity = readProcessIdentity(child.pid);
      if (!identity) throw new Error("A spawned desktop process exited before its creation identity was captured. Ownership of any descendants is unknown and retained; cleanup is refused.");
      if (suspendedExecutable) {
        if (process.platform !== "darwin" || identity.state !== 4 || identity.executable !== realpathSync(suspendedExecutable)) throw new Error("The desktop stop-before-exec handshake could not be verified; ownership is retained.");
        // The shell has not executed user code and is stopped. Authorize this
        // one same-birth exec to the exact requested binary, not any image.
        record.identity = Object.freeze({ ...identity, executable: realpathSync(executable) });
        if (!assertProcessIdentity(identity)) throw new Error("The stopped desktop launcher exited before exec.");
        process.kill(identity.pid, "SIGCONT");
      } else record.identity = identity;
    }
    catch (error) { record.error = error; }
  };
  if (child.pid) capture();
  else child.once("spawn", capture);
  return child;
}

export function isOwnedProcess(child) { return records.has(child); }

export function ownedProcessIdentity(child) {
  const record = records.get(child);
  if (!record) throw new Error("Refusing an unowned desktop process.");
  if (record.error) throw record.error;
  return record.identity;
}

export function assertOwnedProcess(child) {
  const identity = ownedProcessIdentity(child);
  if (!identity && child.exitCode === null && child.signalCode === null) throw new Error("Desktop process creation identity was not captured; ownership is retained.");
  return identity ? assertProcessIdentity(identity) : null;
}
