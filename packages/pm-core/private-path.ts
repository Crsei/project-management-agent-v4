import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';

// Fixed code only: neither the path nor an account name is interpolated into a
// command. A protected DACL grants the current user's SID, not a localized name.
const windowsAcl = String.raw`
$ErrorActionPreference = 'Stop'
$item = Get-Item -Force -LiteralPath $env:PM_PRIVATE_PATH
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse path refused' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $env:PM_PRIVATE_PATH
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
# Elevated Windows tokens can create new paths owned by their default owner group.
# Only new-path restriction may adopt that exact token owner, never read/verify.
if ($owner.Value -ne $sid.Value -and -not ($env:PM_PRIVATE_ACTION -eq 'restrict' -and $owner.Value -eq $identity.Owner.Value)) { throw 'Foreign owner refused' }
if ($env:PM_PRIVATE_ACTION -eq 'restrict') {
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $env:PM_PRIVATE_PATH -AclObject $acl
  $acl = Get-Acl -LiteralPath $env:PM_PRIVATE_PATH
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Owner changed' }
$full = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Nonprivate ACL refused' }
  if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $full = $true }
}
if (-not $full) { throw 'Missing owner access' }
`;
function windowsPrivate(filename: string, restrict: boolean): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows ACL verification requires SystemRoot');
  try {
    execFileSync(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsAcl], {
        env: { ...process.env, PM_PRIVATE_PATH: filename, PM_PRIVATE_ACTION: restrict ? 'restrict' : 'verify' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      });
  } catch { throw new Error('Private storage requires a current-user-only Windows ACL'); }
}
export function assertPrivatePath(filename: string): void {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) throw new Error('Unsafe private storage path');
  if (process.platform === 'win32') windowsPrivate(filename, false);
  else if ((stat.mode & 0o077) !== 0) throw new Error('Private storage permissions must exclude group and other access');
}
/** Only call for newly created application-owned paths, never repair foreign data. */
export function makePrivatePath(filename: string): void {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) throw new Error('Unsafe private storage path');
  if (process.platform === 'win32') windowsPrivate(filename, true);
  else chmodSync(filename, stat.isDirectory() ? 0o700 : 0o600);
  assertPrivatePath(filename);
}
