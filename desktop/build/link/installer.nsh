; Riyeser Link: the Windows Firewall rule, the only system change Riyeser Link makes.
; The installer is per-machine (perMachine: true), so it runs with the permission Windows asked for once, and can add
; an inbound rule for this program only: UDP 5060, TCP 5060 and 5080 (phone set-up), from office (private) addresses only.
; The uninstaller removes it. (An update runs the old uninstaller, then this again, so the rule follows the new copy.)
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Riyeser Link"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Riyeser Link" dir=in action=allow program="$INSTDIR\Riyeser Link.exe" enable=yes profile=any remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 protocol=UDP localport=5060 description="Desk phones on the office network (SIP)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Riyeser Link" dir=in action=allow program="$INSTDIR\Riyeser Link.exe" enable=yes profile=any remoteip=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16 protocol=TCP localport=5060,5080 description="Desk phones on the office network (SIP and phone set-up)"'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Riyeser Link"'
  Pop $0
!macroend
