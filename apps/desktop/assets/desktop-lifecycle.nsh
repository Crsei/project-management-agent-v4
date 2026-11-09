!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Self-managed Dovspace is deliberately CURRENT USER ONLY. No elevation, service
; takeover, image-name taskkill, recursive RMDir, or remotely fetched VC installer.
!define DOVSPACE_HELPER "${__FILEDIR__}\desktop-maintenance.ps1"
Var DovspaceMode
Var DovspaceConfirm
Var DovspaceRequest
Var DovspaceResponse
Var DovspaceState
Var DovspaceHelper
Var DovspacePrepared
Var DovspaceStage

!ifdef BUILD_UNINSTALLER
  !define DOVSPACE_PREFIX "un."
!else
  !define DOVSPACE_PREFIX ""
  !define MUI_CUSTOMFUNCTION_ABORT DovspaceAbort
!endif

; The builder loads this include concurrently with its plugin resources.
; Expand functions only after all plugin directories and registry definitions
; are available, including StdUtils used by the updated-install flag.
!macro customHeader
!ifndef BUILD_UNINSTALLER
Function DovspaceRestore
  ${If} $DovspacePrepared == "yes"
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DovspaceHelper" -Stage restore -InstallRoot "$INSTDIR" -StateFile "$DovspaceState" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"' $R2
    ${If} $R2 != 0
      MessageBox MB_ICONSTOP "Automatic application rollback could not be completed safely. Do not start the candidate. Preserve the .rollback-* tree and matching .json recovery receipt next to the installation; user data has not been migrated." /SD IDOK
    ${EndIf}
  ${EndIf}
FunctionEnd
Function .onInstFailed
  Call DovspaceRestore
FunctionEnd
Function DovspaceAbort
  Call DovspaceRestore
FunctionEnd
!endif
Function ${DOVSPACE_PREFIX}DovspacePrepare
  ${If} $DovspacePrepared == "yes"
    Return
  ${EndIf}
  InitPluginsDir
  StrCpy $DovspaceState "$PLUGINSDIR\dovspace-state.json"
  StrCpy $DovspaceHelper "$PLUGINSDIR\desktop-maintenance.ps1"
  File /oname=$PLUGINSDIR\desktop-maintenance.ps1 "${DOVSPACE_HELPER}"
  StrCpy $DovspaceMode "app+runtime"
  StrCpy $DovspaceConfirm ""
  StrCpy $DovspaceRequest ""
  StrCpy $DovspaceResponse ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    MessageBox MB_ICONSTOP "Dovspace supports per-user installation only. Per-machine installation/removal requires the owning administrator and is not supported by this package." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    MessageBox MB_ICONSTOP "Use the explicit full or data-only Dovspace mode. Generic electron-builder app-data deletion is disabled." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DOVSPACE_MODE=" $R1
  ${IfNot} ${Errors}
    StrCpy $DovspaceMode $R1
  ${EndIf}
  ${GetOptions} $R0 "/DOVSPACE_CONFIRM=" $DovspaceConfirm
  ${GetOptions} $R0 "/DOVSPACE_REQUEST=" $DovspaceRequest
  ${GetOptions} $R0 "/DOVSPACE_RESPONSE=" $DovspaceResponse
  !ifdef BUILD_UNINSTALLER
    ${If} ${isUpdated}
      StrCpy $DovspaceStage "prepare-install"
      StrCpy $DovspaceMode "app+runtime"
      StrCpy $DovspaceConfirm ""
    ${Else}
      StrCpy $DovspaceStage "prepare-uninstall"
      ${If} $DovspaceConfirm != $DovspaceMode
        ${If} ${Silent}
          SetErrorLevel 2
          Quit
        ${Else}
          MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Uninstall mode: $DovspaceMode. app-only retains standalone managed runtimes; app+runtime preserves all workspace data; full and data-only permanently delete the selected owned instance and browser state. Project source trees and native Provider homes are always preserved. Continue with this exact mode?" IDOK +3
          SetErrorLevel 2
          Quit
          StrCpy $DovspaceConfirm $DovspaceMode
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !else
    StrCpy $DovspaceStage "prepare-install"
  !endif
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DovspaceHelper" -Stage $DovspaceStage -InstallRoot "$INSTDIR" -StateFile "$DovspaceState" -RequestFile "$DovspaceRequest" -ResponseFile "$DovspaceResponse" -Mode "$DovspaceMode" -Confirm "$DovspaceConfirm" -CandidateMigrationsSha256 "${DOVSPACE_MIGRATIONS_SHA256}" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"' $R2
  ${If} $R2 != 0
    MessageBox MB_ICONSTOP "Dovspace could not verify ownership, consent, normal shutdown, or nonempty preservation snapshots. Nothing may be removed. Review the maintenance diagnostic and retry only after resolving it." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $DovspacePrepared "yes"
FunctionEnd
!macroend

; This replaces electron-builder's image-name process sweep. It is an actual
; authenticated lifecycle gate, including when the silent uninstaller calls it
; BEFORE customUnInit. A refused/timeout/dirty-window response hard fails.
!macro customCheckAppRunning
  Call ${DOVSPACE_PREFIX}DovspacePrepare
!macroend

!macro customInit
  ${If} $installMode == "all"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInit
  Call un.DovspacePrepare
!macroend

!macro customRemoveFiles
  Call un.DovspacePrepare
  SetOutPath $TEMP
  ${If} ${isUpdated}
    StrCpy $DovspaceStage "upgrade"
  ${Else}
    StrCpy $DovspaceStage "remove"
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DovspaceHelper" -Stage $DovspaceStage -InstallRoot "$INSTDIR" -StateFile "$DovspaceState" -Mode "$DovspaceMode" -Confirm "$DovspaceConfirm" -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"' $R2
  ${If} $R2 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $DovspaceMode == "data-only"
    SetErrorLevel 0
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$DovspaceHelper" -Stage probe -InstallRoot "$INSTDIR"' $R2
  ${If} $R2 != 0
    Call DovspaceRestore
    Abort "Pinned Node/PostgreSQL dependency preflight failed. No network installer was run."
  ${EndIf}
!macroend
