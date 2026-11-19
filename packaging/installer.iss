; Riyeser Accounting - Windows installer (Inno Setup 6).
; Installs for the current Windows user (no admin needed), adds desktop and Start menu shortcuts and an
; "Installed apps" entry. Everything runs on this PC: no internet is needed to install or use it.
; The company file lives in %USERPROFILE%\.riyeser and is kept when the app is uninstalled.
;
; Build (on Windows, after packaging/build_desktop.py):
;   ISCC /DAppVersion=1.0.0 packaging\installer.iss   ->  dist\RiyeserAccounting-Setup-1.0.0.exe

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6C0B3C9E-5B0E-4E4B-9F5D-52E1A7C3A1B7}
AppName=Riyeser Accounting
AppVersion={#AppVersion}
AppVerName=Riyeser Accounting {#AppVersion}
AppPublisher=Riyeser Group
AppCopyright=Riyeser Group
DefaultDirName={localappdata}\Programs\Riyeser Accounting
DefaultGroupName=Riyeser Group
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=RiyeserAccounting-Setup-{#AppVersion}
SetupIconFile=riyeser.ico
UninstallDisplayIcon={app}\Riyeser Accounting.exe
UninstallDisplayName=Riyeser Accounting {#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\dist\Riyeser Accounting.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\Riyeser Accounting"; Filename: "{app}\Riyeser Accounting.exe"
Name: "{userprograms}\Riyeser Group\Riyeser Accounting"; Filename: "{app}\Riyeser Accounting.exe"

[Run]
Filename: "{app}\Riyeser Accounting.exe"; Description: "Open Riyeser Accounting"; Flags: nowait postinstall skipifsilent
