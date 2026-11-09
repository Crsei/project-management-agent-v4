import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, link, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, parse, join, basename } from "node:path";
import { execFile } from "node:child_process";

const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$p = $env:PM_DESKTOP_PRIVATE_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$me = $identity.User
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe private path' }
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $me.Value) {
  if ($env:PM_DESKTOP_PRIVATE_NEW -ne '1' -or $env:PM_DESKTOP_PRIVATE_SECURE -ne '1' -or $owner.Value -ne $identity.Owner.Value) { throw 'Private path has another owner' }
  $acl.SetOwner($me)
}
if ($env:PM_DESKTOP_PRIVATE_SECURE -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  # Set-Acl can attempt an Audit-section write on a protected DACL, requiring
  # SeSecurityPrivilege. Persist only this object's modified access/owner sections.
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $acl) }
  else { [IO.File]::SetAccessControl($p, $acl) }
  $acl = Get-Acl -LiteralPath $p
}
if (-not $acl.AreAccessRulesProtected) { throw 'Private path inherits access rules' }
$ownerAccess = $false
foreach ($rule in $acl.Access) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($rule.AccessControlType -eq 'Allow' -and $sid -eq $me.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $ownerAccess = $true }
  if ($rule.AccessControlType -eq 'Allow' -and $sid -ne $me.Value -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') { throw 'Private path grants another principal access' }
}
if (-not $ownerAccess) { throw 'Private path has no explicit owner access' }
`;

async function windowsAcl(path, secure, newlyCreated = false) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  await new Promise((done, reject) => execFile(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclScript], {
    windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PM_DESKTOP_PRIVATE_PATH: path, PM_DESKTOP_PRIVATE_SECURE: secure ? "1" : "0", PM_DESKTOP_PRIVATE_NEW: newlyCreated ? "1" : "0" },
  }, (error) => {
    if (!error) return done();
    const detail = [error.killed || error.signal ? "helper did not finish within its deadline" : "", error.code, String(error.stderr || "").trim().split(/\r?\n/).filter(Boolean).at(-1)].filter(Boolean).join("; ");
    reject(new Error(`Desktop private path ACL cannot be verified for ${path}${detail ? `: ${detail}` : ""}`));
  }));
}

export async function assertPrivatePath(path, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error("Unsafe desktop private state path");
  if (process.platform === "win32") await windowsAcl(path, false);
  else if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Desktop state must be private to its owner");
  return stat;
}

export async function ensurePrivateDirectory(input, { newlyCreated = false } = {}) {
  const path = resolve(input);
  if (path === parse(path).root) throw new Error("A filesystem root cannot be desktop data");
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe desktop private directory");
  if (process.platform === "win32") await windowsAcl(path, true, created !== undefined || newlyCreated);
  else {
    if (stat.uid !== process.getuid()) throw new Error("Desktop data has another owner");
    await chmod(path, 0o700);
  }
  return path;
}

export async function securePrivateFile(path, { newlyCreated = false } = {}) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe desktop private file");
  if (process.platform === "win32") await windowsAcl(path, true, newlyCreated);
  else {
    if (stat.uid !== process.getuid()) throw new Error("Desktop private file has another owner");
    await chmod(path, 0o600);
  }
}

async function recoverPublishedLink(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 2) return;
  await assertPrivatePath(dirname(path), true);
  if (process.platform === "win32") await windowsAcl(path, false);
  else if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe linked desktop metadata");
  const prefix = `${basename(path)}.`;
  const matches = [];
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    const candidate = join(dirname(path), name);
    const temporary = await lstat(candidate);
    if (temporary.isFile() && !temporary.isSymbolicLink() && temporary.ino === stat.ino && temporary.dev === stat.dev && temporary.nlink === 2) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error("Desktop metadata has an unknown hard link");
  // link()+unlink() is our exclusive atomic publication protocol. A crash may
  // retain the duplicate temporary name; preserve the committed bytes, not the alias.
  await unlink(matches[0]);
}

export async function readPrivateJson(path, maximum = 16_384) {
  let before;
  try { await recoverPublishedLink(path); before = await assertPrivatePath(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > maximum) throw new Error("Unsafe desktop private metadata");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error("Desktop private metadata changed while reading");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new Error("Corrupt desktop private metadata"); }
  } finally { await file.close(); }
}

export async function writePrivateJson(path, value, { exclusive = false } = {}) {
  await ensurePrivateDirectory(dirname(path));
  if (!exclusive) {
    try { await assertPrivatePath(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    if (process.platform === "win32") await windowsAcl(temporary, true, true);
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
    await file.close();
    if (exclusive) { await link(temporary, path); await unlink(temporary); }
    else await rename(temporary, path);
    // Windows does not expose a durable directory fsync through Node.
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
