; Riyeser Link Office: the Windows Firewall rule, the only system change Riyeser Link Office makes.
; The installer is per-machine (perMachine: true), so it runs with the permission Windows asked for once, and can add
; an inbound rule for this program only: UDP 5060 and 5353 (riyeser-office.local), TCP 5060 and 5080 (phone set-up), from office (private) addresses only.
; The uninstaller removes it. (An update runs the old uninstaller, then this again, so the rule follows the new copy.)
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Riyeser Link Office"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Riyeser Link Office" dir=in action=allow program="$INSTDIR\Riyeser Link Office.exe" enable=yes profile=any remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 protocol=UDP localport=5060,5353 description="Desk phones on the office network (SIP, and finding this PC by name)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Riyeser Link Office" dir=in action=allow program="$INSTDIR\Riyeser Link Office.exe" enable=yes profile=any remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 protocol=TCP localport=5060,5080 description="Desk phones on the office network (SIP and phone set-up)"'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Riyeser Link Office"'
  Pop $0
!macroend

!macro customUnInit
  ; 1.3.1: if this PC is the Riyeser relay (it runs with this program's copy of Node), remove the relay too: out of
  ; Riyeser, its task, firewall rules, router port forwarding and its key (logs zipped in C:\ProgramData\Riyeser Relay Logs).
  ; Not on an update (the old uninstaller runs before the new version installs): the relay keeps running then.
  ; In un.onInit, so it runs while the program's files (and the relay's uninstaller) are still there.
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\app.asar.unpacked\src\relay\deploy\windows\install-relay.ps1" 0 noRelay
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -Command "if (Get-ScheduledTask -TaskName ''Riyeser Relay'' -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }"'
      Pop $0
      StrCmp $0 "0" 0 noRelay
        nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app.asar.unpacked\src\relay\deploy\windows\install-relay.ps1" -Uninstall -RelayDir "$INSTDIR\resources\app.asar.unpacked\src\relay"'
        Pop $0
    noRelay:
  ${endIf}
!macroend
