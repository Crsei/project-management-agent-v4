param(
  [Parameter(Mandatory=$true)][switch]$ExecuteInstallerLifecycle,
  [Parameter(Mandatory=$true)][string]$Delivery,
  [Parameter(Mandatory=$true)][string]$Baseline,
  [Parameter(Mandatory=$true)][string]$BaselineSha256,
  [Parameter(Mandatory=$true)][string]$BaselineRunId,
  [Parameter(Mandatory=$true)][string]$BaselineRunAttempt,
  [Parameter(Mandatory=$true)][string]$ExportParent
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteInstallerLifecycle -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or -not [Environment]::Is64BitProcess) { throw 'Installer lifecycle requires explicit opt-in on an ephemeral hosted native Windows x64 runner' }
if ($BaselineSha256 -notmatch '^[a-f0-9]{64}$' -or $BaselineRunId -notmatch '^\d+$' -or $BaselineRunAttempt -notmatch '^[1-9]\d*$') { throw 'BLOCKED: exact older baseline artifact SHA256 and run/attempt are required; overwrite is not upgrade' }
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9]\d*$') { throw 'Missing exact workflow run/attempt' }
$node=(Get-Command node.exe -ErrorAction Stop).Source
$nonce=[Guid]::NewGuid().ToString('N').Substring(0,8)
$name='dov-e2e-'+$nonce
$container=Join-Path $env:SystemDrive ('dovspace-e2e-'+$nonce)
$work=Join-Path $container 'work'
$tools=Join-Path $container 'tools'
$export=Join-Path $ExportParent 'diagnostics'
if ((Test-Path -LiteralPath $container) -or (Test-Path -LiteralPath $ExportParent)) { throw 'Never reuse an account work root or diagnostic export root' }
$raw=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')+'aA1!'
$password=ConvertTo-SecureString $raw -AsPlainText -Force
$raw=$null
$user=New-LocalUser -Name $name -Password $password -Description 'Ephemeral Dovspace installer E2E standard account' -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
$credential=[Management.Automation.PSCredential]::new(('.\'+$name),$password)
$sid=$user.SID
$groups=@(Get-LocalGroupMember -SID 'S-1-5-32-544')
if ($groups.SID.Value -contains $sid.Value) { throw 'E2E account must not be Administrator' }
# Grant only this dedicated account, SYSTEM and Administrators access. The
# worker creates all actual lifecycle roots itself and becomes their owner.
function GrantRoot([string]$Path,[string]$Rights) {
  [void](New-Item -ItemType Directory -Path $Path)
  $acl=Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
  foreach($entry in @(@($sid.Value,$Rights),@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'))){
    $principal=[Security.Principal.SecurityIdentifier]::new($entry[0])
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,$entry[1],'ContainerInherit,ObjectInherit','None','Allow'))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function GrantInputRead([string]$Path) {
  $item=Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { throw 'Installer input must be a real delivery directory' }
  $acl=Get-Acl -LiteralPath $Path
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
try {
  GrantRoot $container 'Modify'
  GrantRoot $ExportParent 'Modify'
  GrantInputRead $Delivery
  GrantInputRead $Baseline
  $scriptRoot=Join-Path $tools 'apps\desktop\scripts\install-e2e'
  [void](New-Item -ItemType Directory -Path $scriptRoot -Force)
  $sourceRoot=Join-Path $tools 'apps\desktop\src'
  [void](New-Item -ItemType Directory -Path $sourceRoot -Force)
  foreach($file in @('windows.mjs','evidence.mjs','native-evidence.ps1','provision-windows.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $scriptRoot $file) }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\src\private-state.mjs') -Destination (Join-Path $sourceRoot 'private-state.mjs')
  $arguments=@((Join-Path $scriptRoot 'windows.mjs'),'--delivery',$Delivery,'--baseline',$Baseline,'--baseline-sha256',$BaselineSha256,'--baseline-run-id',$BaselineRunId,'--baseline-run-attempt',$BaselineRunAttempt,'--root',$work,'--account-sid',$sid.Value,'--run-id',$env:GITHUB_RUN_ID,'--run-attempt',$env:GITHUB_RUN_ATTEMPT,'--repository',$env:GITHUB_REPOSITORY,'--export-dir',$export)
  # Windows command line quoting: all values are paths/identities, never secrets.
  # Reject embedded quote/newline instead of interpolating a shell expression.
  foreach($argument in $arguments){ if($argument -match '["\r\n]'){throw 'Unsafe native argument'} }
  $argumentLine=($arguments | ForEach-Object {'"'+$_+'"'}) -join ' '
  $process=Start-Process -FilePath $node -ArgumentList $argumentLine -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $container -PassThru -RedirectStandardOutput (Join-Path $ExportParent 'driver.stdout.log') -RedirectStandardError (Join-Path $ExportParent 'driver.stderr.log')
  # Wait only for the driver, not an entire descendant tree: a failed graceful
  # shutdown must still export diagnostics instead of hanging account teardown.
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw ('Native installer lifecycle failed/blocked with exit '+$process.ExitCode+'; preserve exported diagnostics and isolated account roots') }
  if (-not (Test-Path -LiteralPath (Join-Path $export 'install-e2e-receipt.json'))) { throw 'Native lifecycle exited without receipt' }
} finally {
  # No process sweep, profile deletion, or data teardown on failure. Hosted VM
  # disposal owns account cleanup; disabling prevents later interactive login.
  Disable-LocalUser -SID $sid
  $credential=$null; $password=$null
}
