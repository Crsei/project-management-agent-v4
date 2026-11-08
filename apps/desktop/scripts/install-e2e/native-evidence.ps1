param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module ($PSHOME+'\Modules\CimCmdlets\CimCmdlets.psd1')
$request = [IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$sid = $identity.User.Value
if ($sid -ne $request.accountSid -or $identity.Name.Split('\')[-1] -notmatch '^dov-e2e-[a-f0-9]{8}$' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installer lifecycle requires the dedicated standard E2E account' }
function Inside([string]$Root, [string]$Path) {
  if ([string]::IsNullOrEmpty($Path)) { return $false }
  $r = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $p = [IO.Path]::GetFullPath($Path)
  return $p.Equals($r,[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($r+'\',[StringComparison]::OrdinalIgnoreCase)
}
function PrivateAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid) { throw 'E2E path has another owner' }
  $access = $false
  foreach ($rule in $acl.Access) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow') {
      if ($ruleSid -notin @($sid,'S-1-5-18','S-1-5-32-544')) { throw 'E2E path permits another principal' }
      if ($ruleSid -eq $sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -ne 0) { $access = $true }
    }
  }
  if (-not $access) { throw 'E2E account cannot read its own path' }
  return $acl.Sddl
}
function InspectPath([string]$Label,[string]$Path,[bool]$Recurse=$true) {
  if (-not (Inside $request.root $Path)) { throw 'E2E path escapes its owned root' }
  $ancestor=$Path
  while ($ancestor) {
    if ([IO.File]::Exists($ancestor) -or [IO.Directory]::Exists($ancestor)) {
      $item=Get-Item -LiteralPath $ancestor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse ancestor in installer evidence' }
    }
    $parent=[IO.Path]::GetDirectoryName($ancestor)
    if ($parent -eq $ancestor) { break }
    $ancestor=$parent
  }
  if (-not [IO.File]::Exists($Path) -and -not [IO.Directory]::Exists($Path)) {
    return [ordered]@{label=$Label;path=$Path;exists=$false;reparse=$false;aclVerified=$true;files=0;bytes=0;acl=@()}
  }
  $count=0; [long]$bytes=0; $acls = [Collections.Generic.List[object]]::new()
  $pending=[Collections.Generic.Stack[string]]::new(); $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $p=$pending.Pop(); $item=Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in installer evidence tree' }
    if ($p -eq $Path) { $acls.Add([ordered]@{path=$p;sddl=(PrivateAcl $p)}) }
    if ($item.PSIsContainer) {
      if ($Recurse) { foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($p)) { $pending.Push($child) } }
    } else { $count++; $bytes += $item.Length }
  }
  $reparseScope=if($Recurse){'recursive'}else{'root'}
  return [ordered]@{label=$Label;path=$Path;exists=$true;reparse=$false;reparseScope=$reparseScope;aclVerified=$true;aclScope='root';files=$count;bytes=$bytes;acl=@($acls)}
}
$processes = @()
foreach ($process in Get-CimInstance Win32_Process) {
  $exe=[string]$process.ExecutablePath; $command=[string]$process.CommandLine
  if ((Inside $request.installRoot $exe) -or ($command -and $command.IndexOf($request.userDataDir,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $process.ProcessId -ne $PID)) {
    $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($owner.Sid -ne $sid) { throw 'Foreign process references the E2E install/data root' }
    $processes += [ordered]@{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;creationTime=$process.CreationDate.ToUniversalTime().ToString('o');executable=$exe;ownerSid=$owner.Sid}
  }
}
function ProcessRecord($Process) {
  $owner=Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid
  if ($owner.Sid -ne $sid -or -not $Process.ExecutablePath) { throw 'Installer descendant identity cannot be established' }
  return [ordered]@{pid=[int]$Process.ProcessId;parentPid=[int]$Process.ParentProcessId;creationTime=$Process.CreationDate.ToUniversalTime().ToString('o');executable=$Process.ExecutablePath;ownerSid=$owner.Sid}
}
function ExtendTree($Known,$Snapshot) {
  do {
    $added=$false
    foreach($child in $Snapshot) {
      $parent=$Known[[string]$child.ParentProcessId]
      if ($parent -and -not $Known.ContainsKey([string]$child.ProcessId) -and $child.CreationDate.ToUniversalTime() -ge [DateTime]::Parse($parent.creationTime).ToUniversalTime()) {
        $Known[[string]$child.ProcessId]=ProcessRecord $child
        $added=$true
      }
    }
  } while($added)
}
if ($request.operation -eq 'wait-installer-tree') {
  $known=@{}
  foreach($record in $request.tree) {
    if ($record.ownerSid -ne $sid -or -not $record.creationTime -or -not $record.executable) { throw 'Unbound installer descendant wait' }
    $known[[string]$record.pid]=$record
  }
  if(-not $known.ContainsKey([string]$request.rootPid)) {throw 'Installer root identity is missing'}
  $deadline=[DateTime]::UtcNow.AddMinutes(2); $quiet=0
  while([DateTime]::UtcNow -lt $deadline) {
    $snapshot=@(Get-CimInstance Win32_Process)
    ExtendTree $known $snapshot
    $live=@($snapshot | Where-Object {
      $record=$known[[string]$_.ProcessId]
      $record -and $_.CreationDate.ToUniversalTime().ToString('o') -ceq $record.creationTime -and $_.ExecutablePath -ceq $record.executable
    })
    if($live.Count -eq 0){$quiet++}else{$quiet=0}
    if($quiet -ge 2){
      [ordered]@{schemaVersion=1;kind='installer-tree-quiescence';rootPid=[int]$request.rootPid;identityVerified=$true;stopped=$true;remainingProcesses=0;processes=@($known.Values)} | ConvertTo-Json -Depth 10 -Compress
      exit 0
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Owned installer descendants did not exit; do not restore registry/application over a live uninstaller'
}
if ($request.operation -eq 'capture-installer-tree') {
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$request.pid)
  if (-not $process -or $process.ExecutablePath -ne $request.executable -or $process.CreationDate.ToUniversalTime().ToString('o') -ne $request.creationTime) { throw 'Interrupted installer PID identity changed' }
  $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
  if ($owner.Sid -ne $sid) { throw 'Cannot interrupt another account process' }
  $tree=@{}; $tree[[string]$process.ProcessId]=ProcessRecord $process
  ExtendTree $tree @(Get-CimInstance Win32_Process)
  [ordered]@{schemaVersion=1;kind='installer-fault-target';pid=[int]$request.pid;creationTime=$request.creationTime;executable=$request.executable;identityVerified=$true;tree=@($tree.Values)} | ConvertTo-Json -Depth 10 -Compress
  exit 0
}
if ($request.operation -eq 'process-identity') {
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$request.pid)
  if (-not $process -or $process.ExecutablePath -ne $request.executable) { throw 'Cannot identify exact spawned installer' }
  $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
  if ($owner.Sid -ne $sid) { throw 'Installer process has another owner' }
  [ordered]@{pid=[int]$process.ProcessId;creationTime=$process.CreationDate.ToUniversalTime().ToString('o');executable=$process.ExecutablePath} | ConvertTo-Json -Compress
  exit 0
}
$registry=@()
foreach ($base in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path -LiteralPath $base) {
    foreach ($key in Get-ChildItem -LiteralPath $base) {
      $value=Get-ItemProperty -LiteralPath $key.PSPath
      if ($value.DisplayName -eq 'PM Agent v4' -or (Inside $request.installRoot ([string]$value.InstallLocation))) {
        if ($base.StartsWith('HKLM:')) { throw 'Per-machine Dovspace installation is outside isolated E2E ownership' }
        $registry += [ordered]@{key=$key.Name;displayName=$value.DisplayName;version=$value.DisplayVersion;installLocation=$value.InstallLocation;uninstallString=$value.UninstallString}
      }
    }
  }
}
$runtimeRegistry=@()
$runtimeKey='HKCU:\Software\Dovspace\DesktopRuntime\com.projectmanagementagent.v4'
if (Test-Path -LiteralPath $runtimeKey) {
  $value=Get-ItemProperty -LiteralPath $runtimeKey
  $runtimeRegistry += [ordered]@{key=$runtimeKey;installLocation=$value.InstallLocation;sourceSha256=$value.SourceSha256;maintenanceCommand=$value.MaintenanceCommand}
}
$shortcuts=@(); $shell=New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))) {
  if ([IO.Directory]::Exists($folder)) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -Force) {
      if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked shortcut path' }
      $shortcut=$shell.CreateShortcut($file.FullName)
      if ($file.BaseName -eq 'PM Agent v4' -or (Inside $request.installRoot $shortcut.TargetPath)) {
        $shortcuts += [ordered]@{path=$file.FullName;target=$shortcut.TargetPath;arguments=$shortcut.Arguments}
      }
    }
  }
}
$paths=@()
foreach ($property in $request.paths.PSObject.Properties) { $paths += InspectPath $property.Name ([string]$property.Value) ($property.Name -ne 'installation') }
[ordered]@{schemaVersion=1;kind='native-state';root=$request.root;installRoot=$request.installRoot;userDataDir=$request.userDataDir;accountSid=$sid;accountName=$identity.Name;administrator=$false;registry=@($registry);runtimeRegistry=@($runtimeRegistry);shortcuts=@($shortcuts);processes=@($processes);paths=@($paths);capturedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 12 -Compress
