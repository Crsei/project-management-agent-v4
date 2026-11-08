param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare-install','prepare-uninstall','remove','upgrade','probe','runtime','restore','handoff')][string]$Stage,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [string]$StateFile,
  [string]$RequestFile,
  [string]$ResponseFile,
  [string]$RecoveryRecord,
  [string]$CandidateMigrationsSha256,
  [int]$ControllerPid,
  [ValidateSet('app-only','app+runtime','full','data-only')][string]$Mode = 'app+runtime',
  [string]$Confirm,
  [string]$InstallRegistryKey,
  [string]$UninstallRegistryKey
)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$runtimeKey = 'Software\Dovspace\DesktopRuntime\com.projectmanagementagent.v4'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DovspaceFileIdentity {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes, creationLow, creationHigh, accessLow, accessHigh, writeLow, writeHigh;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  public static string Read(string path) {
    using (var handle=CreateFile(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Info info; if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if((info.attributes & 0x400)!=0) throw new Exception("Reparse point rejected");
      if((info.attributes & 0x10)==0 && info.links!=1) throw new Exception("Hard-linked file rejected");
      return info.volume+":"+info.indexHigh+":"+info.indexLow+":"+info.creationHigh+":"+info.creationLow;
    }
  }
}
'@

function Assert-Path([string]$Path, [bool]$Directory = $false) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -cne $Path -or $full -eq [IO.Path]::GetPathRoot($full) -or $full.StartsWith('\\')) { throw 'Unsafe root/UNC/noncanonical maintenance path' }
  $cursor = $full
  while ($cursor) {
    if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
      $attributes = [IO.File]::GetAttributes($cursor)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Maintenance rejects every reparse point' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  if ($Directory -and -not [IO.Directory]::Exists($full)) { throw 'Required maintenance directory is missing' }
  return $full
}
function Protect-Private([string]$Path, [bool]$Directory) {
  $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', $inherit, 'None', 'Allow'))
  if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) } else { [IO.File]::SetAccessControl($Path, $acl) }
}
function Assert-Private([string]$Path, [bool]$Directory = $false) {
  [void](Assert-Path $Path $Directory)
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value -or -not $acl.AreAccessRulesProtected) { throw 'Maintenance request is not private to this user' }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and $sid -ne $me.Value -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') { throw 'Maintenance state grants another principal access' }
  }
}
function Read-Json([string]$Path) { return ConvertFrom-Json ([IO.File]::ReadAllText($Path)) }
function Write-Json([string]$Path, $Value) {
  if ([IO.File]::Exists($Path)) { throw 'Maintenance receipt already exists' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    Protect-Private $Path $false
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 100 -Compress))
    $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
  } finally { $stream.Dispose() }
}
function Hash([string]$Path) {
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose(); $stream.Dispose() }
}
function Safe-Child([string]$Root, [string]$Relative) {
  if (-not $Relative -or $Relative.Contains('\') -or $Relative.StartsWith('/') -or @($Relative.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' -or -not $_ -or $_ -match '[:<>"|?*]|[. ]$|^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' }).Count) { throw 'Unsafe cleanup relative path' }
  $path = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $Relative.Replace('/', '\')))
  if (-not $path.StartsWith($Root+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path escapes its authorized root' }
  [void](Assert-Path $path)
  return $path
}
function Get-Tree([string]$Root) {
  [void](Assert-Path $Root $true)
  $result = [Collections.Generic.List[object]]::new()
  $stack = [Collections.Generic.Stack[string]]::new(); $stack.Push($Root)
  while ($stack.Count) {
    $directory = $stack.Pop()
    foreach ($path in [IO.Directory]::GetFileSystemEntries($directory)) {
      [void](Assert-Path $path)
      $item = Get-Item -LiteralPath $path -Force
      if ($item.PSIsContainer) { $stack.Push($path) }
      else { $result.Add([pscustomobject]@{ path=$path.Substring($Root.Length+1).Replace('\','/'); bytes=$item.Length; sha256=(Hash $path); identity=[DovspaceFileIdentity]::Read($path) }) }
    }
  }
  if (-not $result.Count -or -not ($result | Where-Object { $_.bytes -gt 0 })) { throw 'Empty filesystem snapshot is not maintenance evidence' }
  return ,@($result.ToArray() | Sort-Object path)
}
function Matches-NodeIdentity([string]$Native, $Node) {
  if(-not $Node -or -not $Native){return $false}
  $parts=$Native.Split(':')
  if($parts.Length -ne 5){return $false}
  $inode=([UInt64]$parts[1]*[UInt64]4294967296+[UInt64]$parts[2]).ToString([Globalization.CultureInfo]::InvariantCulture)
  return $parts[0] -ceq [string]$Node.dev -and $inode -ceq [string]$Node.ino
}
function Assert-Registered {
  $runtime = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runtimeKey)
  try { if ($runtime -and $runtime.GetValue('InstallLocation') -ceq $InstallRoot -and $runtime.GetValue('SourceSha256') -ceq (Read-Json ($InstallRoot+'\resources\desktop-install-stamp.json')).source.sha256) { return } } finally { if ($runtime) { $runtime.Dispose() } }
  if (-not $InstallRegistryKey -or -not $UninstallRegistryKey) { throw 'Current installation registration is required' }
  $install = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($InstallRegistryKey)
  $uninstall = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($UninstallRegistryKey)
  try {
    if (-not $install -or -not $uninstall -or $install.GetValue('InstallLocation') -cne $InstallRoot -or $uninstall.GetValue('DisplayName') -notlike 'PM Agent v4*' -or $uninstall.GetValue('UninstallString') -notlike ('"'+$InstallRoot+'\Uninstall PM Agent v4.exe"*')) { throw 'Only this user registered Dovspace installation may be removed' }
  } finally { if ($install) { $install.Dispose() }; if ($uninstall) { $uninstall.Dispose() } }
}
function Get-Directories([string]$Root) {
  $result=[Collections.Generic.List[string]]::new()
  $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($Root)
  while($stack.Count) {
    $directory=$stack.Pop()
    foreach($path in [IO.Directory]::GetDirectories($directory)) {
      [void](Assert-Path $path $true)
      $result.Add($path.Substring($Root.Length+1).Replace('\','/'));$stack.Push($path)
    }
  }
  return ,@($result.ToArray() | Sort-Object)
}
function Assert-OwnedTree($Stamp) {
  $manifest = Read-Json ($InstallRoot+'\resources\desktop-install-files.json')
  if ($manifest.formatVersion -ne 1 -or $manifest.appId -cne 'com.projectmanagementagent.v4' -or $manifest.commit -cne $Stamp.commit -or $manifest.sourceSha256 -cne $Stamp.source.sha256) { throw 'Install ownership manifest mismatches the immutable stamp' }
  $expected = @{}
  foreach ($entry in $manifest.files) {
    [void](Safe-Child $InstallRoot $entry.path)
    if ($expected.ContainsKey($entry.path)) { throw 'Duplicate owned file' }
    $expected.Add($entry.path, $entry)
  }
  if(-not $manifest.directories -or ((Get-Directories $InstallRoot) | ConvertTo-Json -Compress) -cne (@($manifest.directories | Sort-Object) | ConvertTo-Json -Compress)) {throw 'Unknown or missing owned installation directories'}
  $tree = Get-Tree $InstallRoot
  foreach ($entry in $tree) {
    if ($entry.path -ceq 'resources/desktop-install-files.json' -or ($entry.path -ceq 'Uninstall PM Agent v4.exe' -and -not $expected.ContainsKey($entry.path))) { continue }
    $claim = $expected[$entry.path]
    if (-not $claim -or $claim.bytes -ne $entry.bytes -or $claim.sha256 -cne $entry.sha256) { throw 'Unknown or changed installation file; no tree deletion authorized' }
    $expected.Remove($entry.path)
  }
  if ($expected.Count) { throw 'Owned installation files are missing' }
  return ,$tree
}
function Assert-NoOwnedProcesses {
  # Observation only, never stop or kill by image name/port. The authenticated
  # installed controller performs normal shutdown before this exact-path gate.
  $processes = Get-CimInstance -ClassName Win32_Process
  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($InstallRoot+'\', [StringComparison]::OrdinalIgnoreCase) -and $process.ExecutablePath -cne ($InstallRoot+'\Uninstall PM Agent v4.exe')) { throw 'An installed process still owns files; cleanup fails closed' }
  }
}
function Wait-Controllers($Processes) {
  $deadline = [DateTime]::UtcNow.AddSeconds(150)
  foreach ($record in $Processes) {
    while ($true) {
      $live = Get-Process -Id $record.id -ErrorAction SilentlyContinue
      if (-not $live) { break }
      if ($live.StartTime.ToUniversalTime().Ticks -ne $record.started) { throw 'Controller PID was reused; cleanup cannot identify shutdown' }
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Controller shutdown timed out; no files deleted' }
      Start-Sleep -Milliseconds 100
    }
  }
}
function Get-Stamp {
  $stamp = Read-Json ($InstallRoot+'\resources\desktop-install-stamp.json')
  if ($stamp.formatVersion -ne 1 -or $stamp.appId -cne 'com.projectmanagementagent.v4' -or $stamp.ownership.installation -cne 'self' -or $stamp.ownership.scope -cne 'per-user' -or $stamp.platform -cne 'win32' -or $stamp.arch -cne 'x64' -or $stamp.updateMechanism -cne 'none' -or $stamp.payload -cne 'bundled' -or $stamp.commit -notmatch '^[a-f0-9]{40}$' -or $stamp.source.sha256 -notmatch '^[a-f0-9]{64}$' -or $stamp.compatibility.dataSchema -ne 1 -or $stamp.compatibility.postgresMajor -ne 16) { throw 'Unsupported, non-owned, or rollback-incompatible install stamp' }
  if($stamp.compatibility.migrationsSha256 -notmatch '^[a-f0-9]{64}$') {throw 'Missing exact data-mutation compatibility fingerprint'}
  return $stamp
}

try {
  [void](Assert-Path $InstallRoot)
  if ($Stage -eq 'probe') {
    [void](Assert-Path $InstallRoot $true)
    foreach ($binary in @('resources\desktop-runtime\node\node.exe','resources\desktop-runtime\postgres\bin\postgres.exe')) {
      $process = Start-Process -FilePath ($InstallRoot+'\'+$binary) -ArgumentList '--version' -PassThru -NoNewWindow
      if(-not $process.WaitForExit(30000)) {throw 'Pinned runtime dependency probe timed out; no application/data removal is authorized'}
      if ($process.ExitCode -ne 0) { throw 'Pinned bundled Node/PostgreSQL cannot load. Inspect windows-runtime-dependencies.json; install required OS dependencies offline through your administrator. Nothing is downloaded by this installer.' }
    }
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runtimeKey,$true)
    try {if($key){$pending=$key.GetValue('PendingRollbackRecord');if($pending){$key.SetValue('LastRollbackRecord',$pending);$key.DeleteValue('PendingRollbackRecord',$false)}}} finally {if($key){$key.Dispose()}}
    exit 0
  }
  Import-Module ($PSHOME+'\Modules\CimCmdlets\CimCmdlets.psd1')
  if ($Stage -eq 'handoff') {
    Assert-Private $RequestFile; Assert-Private $ResponseFile
    $request=Read-Json $RequestFile; $reply=Read-Json $ResponseFile
    if($request.operation -cne 'uninstall' -or $request.mode -cne $Mode -or $Confirm -cne $Mode -or $request.consent.mode -cne $Mode -or $request.consent.stopLocalServices -ne $true -or $reply.ok -ne $true -or $reply.requestId -cne $request.requestId -or $reply.result.status -cne 'prepared') {throw 'Direct uninstall handoff lacks authenticated prepared consent'}
    $controller=Get-Process -Id $ControllerPid -ErrorAction SilentlyContinue
    if($controller) {
      if($controller.Path -cne ($InstallRoot+'\PM Agent v4.exe')) {throw 'Direct controller PID no longer identifies the installed application'}
      Wait-Controllers @(@{id=$controller.Id;started=$controller.StartTime.ToUniversalTime().Ticks})
    }
    Assert-NoOwnedProcesses
    $nativeResponse=$ResponseFile+'.native-'+[Guid]::NewGuid().ToString('N')+'.json'
    $arguments='/S /DOVSPACE_MODE='+$Mode+' /DOVSPACE_CONFIRM='+$Mode+' /DOVSPACE_REQUEST="'+$RequestFile+'" /DOVSPACE_RESPONSE="'+$nativeResponse+'"'
    $uninstaller=Start-Process -FilePath ($InstallRoot+'\Uninstall PM Agent v4.exe') -ArgumentList $arguments -PassThru -Wait
    if([IO.File]::Exists($nativeResponse+'.cleanup.json')) {
      Assert-Private ($nativeResponse+'.cleanup.json')
      $cleanup=Read-Json ($nativeResponse+'.cleanup.json')
      if($cleanup.mode -cne $Mode -or $cleanup.sourceSha256 -cne $reply.installStamp.source.sha256){throw 'Native cleanup receipt does not bind this prepared request'}
      Write-Json ($ResponseFile+'.cleanup.json') $cleanup
    }
    if($uninstaller.ExitCode -ne 0) {throw 'Native NSIS uninstall did not complete'}
    if(-not [IO.File]::Exists($ResponseFile+'.cleanup.json')) {throw 'Native NSIS uninstall produced no final cleanup receipt'}
    exit 0
  }
  if ($Stage -eq 'prepare-install') {
    $key=if($InstallRegistryKey){[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($InstallRegistryKey)}else{$null}
    try {if($key -and $key.GetValue('InstallLocation') -and $key.GetValue('InstallLocation') -cne $InstallRoot){throw 'Changing the registered install root during upgrade is not supported; retain it or explicitly uninstall first'}} finally {if($key){$key.Dispose()}}
    if(-not [IO.Directory]::Exists($InstallRoot) -or [IO.Directory]::GetFileSystemEntries($InstallRoot).Length -eq 0){exit 0}
  }
  if ($Stage -eq 'runtime') {
    $temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'dovspace-maintenance-'+[Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($temp); Protect-Private $temp $true
    Copy-Item -LiteralPath $PSCommandPath -Destination ($temp+'\maintenance.ps1')
    # Continue from a helper outside the tree it will delete, with the same
    # explicit consent. The installed standalone Node controller is temporary.
    & ($PSHOME+'\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($temp+'\maintenance.ps1') -Stage prepare-uninstall -InstallRoot $InstallRoot -StateFile ($temp+'\state.json') -RequestFile $RequestFile -ResponseFile $ResponseFile -Mode $Mode -Confirm $Confirm
    if ($LASTEXITCODE -ne 0) { throw 'Retained runtime preparation failed' }
    & ($PSHOME+'\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($temp+'\maintenance.ps1') -Stage remove -InstallRoot $InstallRoot -StateFile ($temp+'\state.json') -Mode $Mode -Confirm $Confirm
    exit $LASTEXITCODE
  }
  if ($Stage.StartsWith('prepare-')) {
    Assert-Registered
    $stamp = Get-Stamp
    $initialRootIdentity=[DovspaceFileIdentity]::Read($InstallRoot)
    $initialTree=Assert-OwnedTree $stamp
    if (-not $StateFile) { throw 'Private native handoff state is required' }
    $directory = [IO.Path]::GetDirectoryName($StateFile)
    [void](Assert-Path $directory $true); Protect-Private $directory $true
    $operation = if ($Stage -eq 'prepare-install') { 'preinstall' } else { 'uninstall' }
    if ($operation -eq 'uninstall' -and $Confirm -cne $Mode) { throw 'Explicit mode-specific uninstall confirmation is required' }
    if($operation -eq 'preinstall' -and ($CandidateMigrationsSha256 -notmatch '^[a-f0-9]{64}$' -or $CandidateMigrationsSha256 -cne $stamp.compatibility.migrationsSha256)) {throw 'Candidate data-mutation code/migrations differ; old-app rollback is unproven. No process was stopped or data changed. Use an explicitly reviewed backup/migration path.'}
    if ($RequestFile) {
      Assert-Private $RequestFile; Assert-Private ([IO.Path]::GetDirectoryName($RequestFile)) $true
      $request = Read-Json $RequestFile
      if ($request.operation -cne $operation -or $request.expectedInstallRoot -cne $InstallRoot -or $request.expectedStamp.commit -cne $stamp.commit -or $request.expectedStamp.sourceSha256 -cne $stamp.source.sha256) { throw 'Request is not bound to this installation' }
      if ($operation -eq 'uninstall' -and ($request.mode -cne $Mode -or $request.consent.mode -cne $Mode -or (($Mode -eq 'full' -or $Mode -eq 'data-only') -and $request.consent.deleteData -ne $true))) { throw 'Request deletion consent disagrees with the selected native mode' }
    } else {
      $userData = [IO.Path]::Combine([Environment]::GetFolderPath('ApplicationData'), 'PM Agent v4')
      $dataDir = $userData+'\workspace'
      if ([IO.File]::Exists($userData+'\connection.json')) { $saved = Read-Json ($userData+'\connection.json'); if ($saved.dataDir) { $dataDir = $saved.dataDir } }
      $request = [pscustomobject]@{ formatVersion=1; requestId=[Guid]::NewGuid().ToString(); operation=$operation; expectedInstallRoot=$InstallRoot; expectedStamp=@{commit=$stamp.commit;sourceSha256=$stamp.source.sha256}; userDataDir=$userData; dataDir=$dataDir; mode=$Mode; consent=@{stopLocalServices=$true;mode=$Mode;deleteData=($Mode -eq 'full' -or $Mode -eq 'data-only')}; externalRoots=@(); deferInstallation=$true }
    }
    if($operation -eq 'preinstall') {$request | Add-Member -NotePropertyName candidateCompatibility -NotePropertyValue @{dataSchema=1;postgresMajor=16;migrationsSha256=$CandidateMigrationsSha256} -Force}
    $request | Add-Member -NotePropertyName deferInstallation -NotePropertyValue $true -Force
    if ($ResponseFile) {$requestDirectory=[IO.Path]::GetDirectoryName($ResponseFile)}
    elseif ($RequestFile) {$requestDirectory=[IO.Path]::GetDirectoryName($RequestFile)}
    else {
      $requestDirectory=[IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'Dovspace','DesktopLifecycle',[Guid]::NewGuid().ToString('N'))
      [void](Assert-Path $requestDirectory)
      if([IO.Directory]::Exists($requestDirectory)){throw 'Native lifecycle receipt directory already exists'}
      [void][IO.Directory]::CreateDirectory($requestDirectory);Protect-Private $requestDirectory $true
    }
    Assert-Private $requestDirectory $true
    $privateRequest = $requestDirectory+'\request-'+[Guid]::NewGuid().ToString('N')+'.json'
    $response = if ($ResponseFile) { $ResponseFile } else { $requestDirectory+'\response-'+[Guid]::NewGuid().ToString('N')+'.json' }
    if ([IO.File]::Exists($response)) { throw 'Response path already exists' }
    Write-Json $privateRequest $request
    $processes = @()
    foreach ($p in @(Get-Process -ErrorAction Stop | Where-Object { $_.Path -ceq ($InstallRoot+'\PM Agent v4.exe') })) { $processes += @{id=$p.Id;started=$p.StartTime.ToUniversalTime().Ticks} }
    if ([IO.File]::Exists($InstallRoot+'\PM Agent v4.exe')) {
      $arguments = '--desktop-lifecycle '+$operation+' --request-file "'+$privateRequest+'" --response-file "'+$response+'"'
      $controller = Start-Process -FilePath ($InstallRoot+'\PM Agent v4.exe') -ArgumentList $arguments -PassThru
    } else {
      Assert-NoOwnedProcesses
      if ($operation -ne 'uninstall') { throw 'Retained runtime must be explicitly cleaned before reinstalling the GUI' }
      $arguments = '"'+$InstallRoot+'\resources\desktop-maintenance\uninstall-cli.mjs" --request-file "'+$privateRequest+'" --response-file "'+$response+'"'
      $controller = Start-Process -FilePath ($InstallRoot+'\resources\desktop-runtime\node\node.exe') -ArgumentList $arguments -PassThru -NoNewWindow
    }
    try { $processes += @{id=$controller.Id;started=$controller.StartTime.ToUniversalTime().Ticks} } catch { if (-not [IO.File]::Exists($response)) { throw 'Controller exited without an authenticated response' } }
    Wait-Controllers $processes
    if (-not [IO.File]::Exists($response)) { throw 'Packaged lifecycle controller did not produce a response' }
    Assert-Private $response
    $reply = Read-Json $response
    if ($reply.ok -ne $true -or $reply.requestId -cne $request.requestId) { throw ('Installed controller refused lifecycle request: '+$reply.error) }
    Assert-NoOwnedProcesses
    $tree = Assert-OwnedTree $stamp
    if([DovspaceFileIdentity]::Read($InstallRoot) -cne $initialRootIdentity -or ($tree | ConvertTo-Json -Depth 10 -Compress) -cne ($initialTree | ConvertTo-Json -Depth 10 -Compress)) {throw 'Installation identity changed while the controller was stopping'}
    $nativeSnapshots=@{}
    if($operation -eq 'uninstall') {
      if($reply.result.roots.installation -cne $InstallRoot -or $reply.result.roots.instance -cne $request.dataDir -or $reply.result.roots.userData -cne $request.userDataDir){throw 'Prepared deletion roots differ from the authenticated request'}
      foreach($scope in @('installation','instance','userData')) {
        $snapshot=$reply.result.snapshots.$scope
        if(-not $snapshot.absent) {
          $nativeRoot=[DovspaceFileIdentity]::Read($snapshot.root)
          if(-not (Matches-NodeIdentity $nativeRoot $snapshot.identity.exact)){throw 'Prepared snapshot root identity was replaced'}
          $nativeFiles=Get-Tree $snapshot.root
          $expectedFiles=@{};foreach($entry in $snapshot.entries){if($entry.type -ceq 'file'){$expectedFiles[$entry.path]=$entry}}
          foreach($entry in $nativeFiles) {
            $expected=$expectedFiles[$entry.path]
            if(-not $expected -or -not (Matches-NodeIdentity $entry.identity $expected.fileIdentity)){throw 'Prepared snapshot file identity was replaced'}
          }
          $nativeDirectories=@{}
          foreach($entry in $snapshot.entries) {
            if($entry.type -ceq 'directory') {
              $identity=[DovspaceFileIdentity]::Read((Safe-Child $snapshot.root $entry.path))
              if(-not (Matches-NodeIdentity $identity $entry.fileIdentity)){throw 'Prepared snapshot directory identity was replaced'}
              $nativeDirectories[$entry.path]=$identity
            }
          }
          $nativeSnapshots[$scope]=@{rootIdentity=$nativeRoot;files=$nativeFiles;directories=$nativeDirectories}
        }
      }
    }
    $registry=@{}
    foreach($name in @($InstallRegistryKey,$UninstallRegistryKey)) {
      if(-not $name){continue}
      $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name)
      try {if($key){$values=@();foreach($value in $key.GetValueNames()){$values+=@{name=$value;value=$key.GetValue($value);kind=$key.GetValueKind($value).ToString()}};$registry[$name]=$values}} finally {if($key){$key.Dispose()}}
    }
    $state = @{formatVersion=1;root=$InstallRoot;stamp=$stamp;tree=$tree;plan=$reply.result;nativeSnapshots=$nativeSnapshots;registry=$registry;response=$response;operation=$operation;installRegistryKey=$InstallRegistryKey;uninstallRegistryKey=$UninstallRegistryKey;rootIdentity=[DovspaceFileIdentity]::Read($InstallRoot)}
    Write-Json $StateFile $state
    exit 0
  }
  if ($Stage -eq 'restore') {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runtimeKey)
    try {$record=if($key){$key.GetValue('PendingRollbackRecord')}else{$null}} finally {if($key){$key.Dispose()}}
    if($RecoveryRecord) {if($record -and $record -cne $RecoveryRecord){throw 'Recovery record disagrees with registered pending upgrade'};$record=$RecoveryRecord}
    if(-not $record) {exit 0}
    Assert-Private $record; $rollback=Read-Json $record; $state=$rollback.state
    if($rollback.originalRoot -cne $InstallRoot -or $rollback.dataMigrated -ne $false) {throw 'Rollback root/data compatibility mismatch'}
    Assert-NoOwnedProcesses
    [void](Assert-Path $rollback.path $true)
    if([DovspaceFileIdentity]::Read($rollback.path) -cne $state.rootIdentity) {throw 'Rollback tree identity changed'}
    $savedRoot=$InstallRoot
    try {$InstallRoot=$rollback.path;[void](Assert-OwnedTree $state.stamp)} finally {$InstallRoot=$savedRoot}
    if ([IO.Directory]::Exists($InstallRoot)) {
      # Preserve every partial candidate rather than recursively deleting it.
      $failed = $InstallRoot+'.failed-'+[Guid]::NewGuid().ToString('N')
      [IO.Directory]::Move($InstallRoot, $failed)
    }
    [IO.Directory]::Move($rollback.path, $InstallRoot)
    foreach($property in $state.registry.PSObject.Properties) {
      $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($property.Name)
      try {foreach($value in $property.Value){$kind=[Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind],$value.kind);$key.SetValue($value.name,$value.value,$kind)}} finally {$key.Dispose()}
    }
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runtimeKey,$true)
    try {if($key){$key.DeleteValue('PendingRollbackRecord',$false)}} finally {if($key){$key.Dispose()}}
    exit 0
  }
  Assert-Private $StateFile; $state = Read-Json $StateFile
  if ($state.formatVersion -ne 1 -or $state.root -cne $InstallRoot) { throw 'Native handoff root mismatch' }
  Assert-Registered; Assert-NoOwnedProcesses
  if ([DovspaceFileIdentity]::Read($InstallRoot) -cne $state.rootIdentity) { throw 'Installation root identity changed after stop' }
  $tree = Assert-OwnedTree $state.stamp
  if (($tree | ConvertTo-Json -Depth 10 -Compress) -cne ($state.tree | ConvertTo-Json -Depth 10 -Compress)) { throw 'Installation changed after lifecycle handoff' }
  if ($Stage -eq 'upgrade') {
    if ($state.operation -cne 'preinstall') { throw 'Upgrade lacks a preinstall handoff' }
    $rollback = $InstallRoot+'.rollback-'+[Guid]::NewGuid().ToString('N')
    if ([IO.File]::Exists($rollback) -or [IO.Directory]::Exists($rollback) -or [IO.Path]::GetPathRoot($rollback) -cne [IO.Path]::GetPathRoot($InstallRoot)) { throw 'Unsafe rollback destination' }
    $record=$rollback+'.json'
    Write-Json $record @{formatVersion=1;path=$rollback;originalRoot=$InstallRoot;stamp=$state.stamp;dataMigrated=$false;state=$state;instruction='Stop candidate normally; use the copied maintenance helper -Stage restore -InstallRoot originalRoot. Old code/runtime only; never a database downgrade.'}
    Copy-Item -LiteralPath $PSCommandPath -Destination ($rollback+'.ps1')
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runtimeKey)
    try {$key.SetValue('PendingRollbackRecord',$record)} finally {$key.Dispose()}
    [IO.Directory]::Move($InstallRoot, $rollback)
    [void][IO.Directory]::CreateDirectory($InstallRoot)
    exit 0
  }
  if ($Stage -ne 'remove' -or $state.operation -cne 'uninstall' -or $Confirm -cne $Mode -or $state.plan.mode -cne $Mode -or $state.plan.status -cne 'prepared' -or $state.plan.deletionExecuted -ne $false -or $state.plan.stopped.stopped -ne $true -or $state.plan.stopped.remainingProcesses -ne 0) { throw 'Native deletion lacks an explicit stopped/consented plan' }
  $plan = $state.plan
  $nativeLookups=@{}
  foreach ($scope in @('installation','instance','userData')) {
    $snapshot = $plan.snapshots.$scope
    if ($snapshot.absent) { if ([IO.Directory]::Exists($snapshot.root)) { throw 'Previously absent data appeared' }; continue }
    $actual = Get-Tree $snapshot.root
    $native=$state.nativeSnapshots.$scope
    if(-not $native -or [DovspaceFileIdentity]::Read($snapshot.root) -cne $native.rootIdentity -or ($actual | ConvertTo-Json -Depth 10 -Compress) -cne ($native.files | ConvertTo-Json -Depth 10 -Compress)) {throw 'A native root/file identity changed after the stopped handoff'}
    $expected = @($snapshot.entries | Where-Object { $_.type -eq 'file' })
    if (-not $expected.Count -or $actual.Count -ne $expected.Count) { throw 'Empty or changed deletion snapshot' }
    $byPath=@{}; foreach($entry in $expected) {$byPath[$entry.path]=$entry}
    $nativeLookups[$scope]=@{};foreach($entry in $native.files){$nativeLookups[$scope][$entry.path]=$entry}
    foreach($entry in $actual) { $claim=$byPath[$entry.path]; if(-not $claim -or $claim.bytes -ne $entry.bytes -or $claim.sha256 -cne $entry.sha256) {throw 'Deletion snapshot changed after shutdown'} }
  }
  $deleted = [Collections.Generic.List[object]]::new()
  foreach ($entry in $plan.delete) {
    $root = $plan.roots.($entry.scope)
    $path = Safe-Child $root $entry.path
    foreach($protected in $plan.protectedRoots) { if ($path -ieq $protected -or $path.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Protected project/Provider root in delete set'} }
    for($attempt=0;$attempt -lt 3;$attempt++) {
      [void](Assert-Path $path)
      $item=Get-Item -LiteralPath $path -Force
      $nativeFile=$nativeLookups[$entry.scope][$entry.path]
      if(-not $nativeFile -or [DovspaceFileIdentity]::Read($path) -cne $nativeFile.identity -or $item.PSIsContainer -or $item.Length -ne $entry.bytes -or (Hash $path) -cne $entry.sha256) {throw 'File changed before owned deletion'}
      try {[IO.File]::Delete($path); break} catch [IO.IOException] {if($attempt -eq 2){throw}; Start-Sleep -Milliseconds 150} catch [UnauthorizedAccessException] {if($attempt -eq 2){throw}; Start-Sleep -Milliseconds 150}
    }
    $deleted.Add(@{scope=$entry.scope;path=$entry.path})
  }
  $removedDirectories=[Collections.Generic.List[object]]::new()
  foreach($entry in @($plan.deleteDirectories | Sort-Object { $_.path.Length } -Descending)) {
    $root=$plan.roots.($entry.scope)
    $path=Safe-Child $root $entry.path
    foreach($protected in $plan.protectedRoots){if($path -ieq $protected -or $path.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase) -or $protected.StartsWith($path+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Protected root in directory deletion set'}}
    if([DovspaceFileIdentity]::Read($path) -cne $state.nativeSnapshots.($entry.scope).directories.($entry.path)){throw 'Owned directory identity changed before deletion'}
    [IO.Directory]::Delete($path,$false)
    $removedDirectories.Add(@{scope=$entry.scope;path=$entry.path})
  }
  if($Mode -eq 'app-only') {
    $retained=Get-Tree $InstallRoot
    $manifest=@{formatVersion=1;appId=$state.stamp.appId;commit=$state.stamp.commit;sourceSha256=$state.stamp.source.sha256;retainedRuntime=$true;directories=(Get-Directories $InstallRoot);files=@($retained | Where-Object {$_.path -cne 'resources/desktop-install-files.json'} | ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=$_.sha256}})}
    [IO.File]::WriteAllText($InstallRoot+'\resources\desktop-install-files.json',($manifest | ConvertTo-Json -Depth 20 -Compress),[Text.UTF8Encoding]::new($false))
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runtimeKey)
    try {$key.SetValue('InstallLocation',$InstallRoot);$key.SetValue('SourceSha256',$state.stamp.source.sha256);$key.SetValue('MaintenanceCommand','"'+$PSHOME+'\powershell.exe" -NoProfile -File "'+$InstallRoot+'\resources\desktop-maintenance\desktop-maintenance.ps1" -Stage runtime -InstallRoot "'+$InstallRoot+'" -Mode app+runtime -Confirm app+runtime')} finally {$key.Dispose()}
  } elseif($Mode -ne 'data-only') {
    if([DovspaceFileIdentity]::Read($InstallRoot) -cne $state.rootIdentity){throw 'Installation root was replaced before final empty removal'}
    [IO.Directory]::Delete($InstallRoot,$false)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($runtimeKey,$false)
  }
  Write-Json ($state.response+'.cleanup.json') @{formatVersion=1;mode=$Mode;status='complete';ok=$true;deletionExecuted=$true;deleted=$deleted;deletedDirectories=$removedDirectories;preserve=$plan.preserve;golden=$plan.golden;sourceSha256=$state.stamp.source.sha256;rollbackCompatibility=$plan.rollbackCompatibility}
  exit 0
} catch {
  $failureMessage=$_.Exception.Message
  if($Stage -eq 'remove' -and $state -and $state.response -and -not [IO.File]::Exists($state.response+'.cleanup.json')) {
    try {Write-Json ($state.response+'.cleanup.json') @{formatVersion=1;operation='uninstall';mode=$Mode;ok=$false;status='failed';deletionExecuted=($deleted.Count -gt 0 -or $removedDirectories.Count -gt 0);deleted=@($deleted);deletedDirectories=@($removedDirectories);sourceSha256=$state.stamp.source.sha256;error=$failureMessage}} catch {}
  }
  if($Stage -eq 'handoff' -and $ResponseFile -and -not [IO.File]::Exists($ResponseFile+'.cleanup.json')) {
    try {Write-Json ($ResponseFile+'.cleanup.json') @{formatVersion=1;operation='uninstall';mode=$Mode;ok=$false;status='failed';deletionExecuted=$false;error=$_.Exception.Message}} catch {}
  }
  [Console]::Error.WriteLine('Dovspace maintenance refused: '+$_.Exception.Message)
  exit 1
}
