; Riyeser Accounting Basics / Riyeser Accounting Plus / Riyeser POS - Windows installers (Inno Setup 6).
; Three separate apps built from one code base. Each installs for the current Windows user (no admin needed), with its
; own desktop and Start menu shortcut, icon and "Installed apps" entry. Everything runs on this PC.
;
; Both apps open the same company files in %USERPROFILE%\.riyeser, which no installer or uninstaller ever touches.
; Only one of the two is installed at a time:
;   * Installing Plus replaces Basics (an upgrade): the books open in Plus exactly as they were.
;   * Installing Basics replaces Plus (a downgrade, after asking): payroll, journals, jobs and budgets are hidden but
;     kept in the company file, and come back if Plus is installed again.
; Plus keeps the AppId of the old single "Riyeser Accounting" app, so existing installs update in place to Plus.
;
; Build (on Windows, after packaging/build_desktop.py --edition basics|plus):
;   ISCC /DEdition=basics /DAppVersion=2.0.0 packaging\installer.iss -> dist\RiyeserAccountingBasics-Setup-2.0.0.exe
;   ISCC /DEdition=plus   /DAppVersion=2.0.0 packaging\installer.iss -> dist\RiyeserAccountingPlus-Setup-2.0.0.exe
;   ISCC /DEdition=pos    /DAppVersion=2.3.0 packaging\installer.iss -> dist\RiyeserPOS-Setup-2.3.0.exe
;   ISCC /DEdition=invoices /DAppVersion=2.4.0 packaging\installer.iss -> dist\RiyeserInvoices-Setup-2.4.0.exe
;   ISCC /DEdition=estimate /DAppVersion=2.11.0 packaging\installer.iss -> dist\RiyeserEstimate-Setup-2.11.0.exe
;
; Riyeser Invoices (free), Riyeser Bookings and Riyeser Estimate also install NEXT TO Accounting and open the same
; company files.
;
; Riyeser POS is the till on its own. It installs NEXT TO Accounting Basics or Plus (it never replaces either) and
; opens the same company files, so till sales show in Accounting as paid invoices.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Edition
  #define Edition "plus"
#endif

#define PlusId "6C0B3C9E-5B0E-4E4B-9F5D-52E1A7C3A1B7"
#define BasicsId "21C257C6-5CFC-4E4B-A13F-50206BF8970E"
#define PosId "63A56771-35A2-4A5D-9FA4-76DFC5FA74CF"
#define InvoicesId "9E4D2B57-7C1A-4F0E-B8A3-3D6F51C2E9A4"
#define BookingsId "4B7E9C21-0D3F-4A6B-9E58-C1A2F7D3B640"
#define EstimateId "D3A86F41-2C7B-4E19-A5D0-8B6E3F21C974"

#if Edition == "estimate"
  #define AppName "Riyeser Estimate"
  #define ShortName "Estimate"
  #define SetupBase "RiyeserEstimate-Setup"
  #define IconFile "estimate.ico"
  #define MyId EstimateId
#elif Edition == "bookings"
  #define AppName "Riyeser Bookings"
  #define ShortName "Bookings"
  #define SetupBase "RiyeserBookings-Setup"
  #define IconFile "bookings.ico"
  #define MyId BookingsId
#elif Edition == "invoices"
  #define AppName "Riyeser Invoices"
  #define ShortName "Invoices"
  #define SetupBase "RiyeserInvoices-Setup"
  #define IconFile "invoices.ico"
  #define MyId InvoicesId
#elif Edition == "pos"
  #define AppName "Riyeser POS"
  #define ShortName "POS"
  #define SetupBase "RiyeserPOS-Setup"
  #define IconFile "pos.ico"
  #define MyId PosId
#elif Edition == "basics"
  #define AppName "Riyeser Accounting Basics"
  #define ShortName "Accounting Basics"
  #define SetupBase "RiyeserAccountingBasics-Setup"
  #define IconFile "basics.ico"
  #define MyId BasicsId
  #define OtherId PlusId
  #define OtherName "Riyeser Accounting Plus"
#else
  #define AppName "Riyeser Accounting Plus"
  #define ShortName "Accounting Plus"
  #define SetupBase "RiyeserAccountingPlus-Setup"
  #define IconFile "plus.ico"
  #define MyId PlusId
  #define OtherId BasicsId
  #define OtherName "Riyeser Accounting Basics"
#endif

[Setup]
AppId={{{#MyId}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Riyeser Group
AppCopyright=Riyeser Group
DefaultDirName={localappdata}\Programs\{#AppName}
UsePreviousAppDir=no
DefaultGroupName=Riyeser Group
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename={#SetupBase}-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppName}.exe
UninstallDisplayName={#AppName} {#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

#if Edition != "pos" && Edition != "invoices" && Edition != "bookings" && Edition != "estimate"
[InstallDelete]
; The old single app (Riyeser Accounting 1.x): its program folder and shortcuts. Company files are elsewhere and kept.
Type: filesandordirs; Name: "{localappdata}\Programs\Riyeser Accounting"
Type: files; Name: "{userdesktop}\Riyeser Accounting.lnk"
Type: files; Name: "{userprograms}\Riyeser Group\Riyeser Accounting.lnk"
#endif

[Files]
Source: "..\dist\{#AppName}.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppName}.exe"
Name: "{userprograms}\Riyeser Group\{#AppName}"; Filename: "{app}\{#AppName}.exe"

[Run]
Filename: "{app}\{#AppName}.exe"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent

#if Edition != "pos" && Edition != "invoices" && Edition != "bookings" && Edition != "estimate"
[Code]
function OtherUninstaller(): String;
var
  OtherKey: String;
begin
  OtherKey := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + Chr(123) + '{#OtherId}' + Chr(125) + '_is1';
  Result := '';
  if not RegQueryStringValue(HKCU, OtherKey, 'UninstallString', Result) then
    RegQueryStringValue(HKLM, OtherKey, 'UninstallString', Result);
  Result := RemoveQuotes(Result);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
#if Edition == "basics"
  if (OtherUninstaller() <> '') and not WizardSilent() then
    Result := MsgBox('{#OtherName} is installed on this PC.' + #13#10 + #13#10 +
      'Installing Accounting Basics will replace it. Your books stay exactly as they are: customers, invoices, stock ' +
      'and reports carry straight over. Payroll, journals, jobs and budgets are hidden but kept safe, and come back ' +
      'if you install Accounting Plus again.' + #13#10 + #13#10 + 'Switch to Accounting Basics?',
      mbConfirmation, MB_YESNO) = IDYES;
#endif
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Uninst: String;
  Code: Integer;
begin
  if CurStep = ssInstall then
  begin
    Uninst := OtherUninstaller();
    if Uninst <> '' then
    begin
      // Close the other app if it's open, then remove it. Its uninstaller never touches the company files.
      Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "{#OtherName}.exe"', '', SW_HIDE, ewWaitUntilTerminated, Code);
      Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM "Riyeser Accounting.exe"', '', SW_HIDE, ewWaitUntilTerminated, Code);
      Exec(Uninst, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, Code);
    end;
  end;
end;
#endif
