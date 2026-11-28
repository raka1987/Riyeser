; Riyeser Central: counts how many times it has been installed on this Windows account, in
; HKCU\Software\Riyeser\Trial "Installs" (shown to Riyeser Support in a ticket's Trial history: src/core/trial-guard.js).
; Not on an update. Nothing here (or in the uninstaller) removes HKCU\Software\Riyeser\Trial, so reinstalling Riyeser
; keeps the free trial's start date.
!macro customInstall
  ${ifNot} ${isUpdated}
    ClearErrors
    ReadRegDWORD $0 HKCU "Software\Riyeser\Trial" "Installs"
    IfErrors 0 +2
      StrCpy $0 0
    IntOp $0 $0 + 1
    WriteRegDWORD HKCU "Software\Riyeser\Trial" "Installs" $0
  ${endIf}
!macroend
