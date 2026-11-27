<#
  The Riyeser relay on Windows: the head office's always-on PC (or a mini PC) runs it as a background service that
  starts with Windows, before anyone signs in. Run in an elevated PowerShell (Run as administrator):

    .\install-relay.ps1 -Domain relay.riyeser.com -Region "Suva head office" -Id suva1
    .\install-relay.ps1 -Backup -Domain relay2.riyeser.com -Region Sydney -Id syd1     (asks for the main relay's secret)
    .\install-relay.ps1 -Uninstall

  It runs the relay with Node (node.exe on this PC), or, with -LinkOffice, with the copy of Node inside Riyeser Link
  Office (so nothing else needs installing). The service is a Windows scheduled task "Riyeser Relay" that starts at
  boot as SYSTEM and restarts itself if it stops. It adds Windows Firewall rules for its ports, asks the office
  router to forward them (UPnP / NAT-PMP, where the router allows it), and makes a self-signed certificate whose
  fingerprint Link Office checks (or use -CertPfx for your own). Settings and the secret are in
  C:\ProgramData\Riyeser Relay\ (readable only by Administrators and SYSTEM).
#>
[CmdletBinding()]
param(
  [string]$Domain = 'relay.riyeser.com', [string]$Region = 'Suva head office', [string]$Id = 'suva1',
  [string]$RelayDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Node = '', [switch]$LinkOffice, [switch]$Backup, [int]$Priority = 0,
  [int]$HttpsPort = 443, [int]$MediaMin = 40002, [int]$MediaMax = 40201, [int]$TurnMin = 40202, [int]$TurnMax = 40301,
  [string]$CertFile = '', [string]$KeyFile = '', [switch]$NoPortMap, [switch]$Uninstall,
  [string]$SupabaseUrl = 'https://goaugynxeatzqzifpoes.supabase.co', [string]$SupabaseKey = 'sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL'
)
$ErrorActionPreference = 'Stop'
$Task = 'Riyeser Relay'; $Data = Join-Path $env:ProgramData 'Riyeser Relay'; $Rule = 'Riyeser Relay'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run this in PowerShell as administrator (right-click -> Run as administrator).'; exit 1 }

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Get-NetFirewallRule -DisplayName "$Rule*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Host "The Riyeser relay is removed. Its settings and secret are kept in $Data (delete the folder to remove them too)."; exit 0
}

# ---- what runs it
if ($LinkOffice) {
  $lo = Join-Path $env:ProgramFiles 'Riyeser Link Office\Riyeser Link Office.exe'
  if (-not (Test-Path $lo)) { Write-Host 'Riyeser Link Office isn''t installed on this PC. Install it, or install Node and leave out -LinkOffice.'; exit 1 }
  $Node = $lo; $AsNode = $true
} else {
  if (-not $Node) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $Node = $c.Source } }
  if (-not $Node -or -not (Test-Path $Node)) { Write-Host 'Node isn''t installed. Use -LinkOffice (the Node inside Riyeser Link Office), or install Node 18 or later.'; exit 1 }
  $AsNode = $false
}
$Server = Join-Path $RelayDir 'server.js'
if (-not (Test-Path $Server)) { Write-Host "No server.js in $RelayDir"; exit 1 }

# ---- the settings folder: only Administrators and SYSTEM
New-Item -ItemType Directory -Force -Path $Data, (Join-Path $Data 'tls'), (Join-Path $Data 'logs') | Out-Null
& icacls $Data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

$secretFile = Join-Path $Data 'secret'
if (-not (Test-Path $secretFile) -or (Get-Item $secretFile).Length -lt 32) {
  if ($Backup) {
    $s = Read-Host 'Paste the main relay''s secret (on the main relay: type the file C:\ProgramData\Riyeser Relay\secret, or sudo cat /etc/riyeser-relay/secret)' -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  } else { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $plain = ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
  [IO.File]::WriteAllText($secretFile, $plain.Trim())
}
if ((Get-Item $secretFile).Length -lt 32) { Write-Host 'The secret is too short.'; Remove-Item $secretFile; exit 1 }
$metricsFile = Join-Path $Data 'metrics-token'
if (-not (Test-Path $metricsFile)) { $b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [IO.File]::WriteAllText($metricsFile, (($b | ForEach-Object { $_.ToString('x2') }) -join '')) }

$tlsCert = ''; $tlsKey = ''; $self = '1'
if ($CertFile -and $KeyFile) { Copy-Item $CertFile (Join-Path $Data 'tls\fullchain.pem') -Force; Copy-Item $KeyFile (Join-Path $Data 'tls\privkey.pem') -Force
  $tlsCert = Join-Path $Data 'tls\fullchain.pem'; $tlsKey = Join-Path $Data 'tls\privkey.pem'; $self = '0' }
$envFile = Join-Path $Data 'relay.env'
@"
# Riyeser relay settings (made by install-relay.ps1). Keep private.
RELAY_ID="$Id"
RELAY_REGION="$Region"
RELAY_HOST="$Domain"
RELAY_SECRET_FILE="$secretFile"
SUPABASE_URL="$SupabaseUrl"
SUPABASE_KEY="$SupabaseKey"
HTTP_PORT="8080"
HTTP_BIND="127.0.0.1"
HTTPS_PORT="$HttpsPort"
SIP_TLS_PORT="5061"
TLS_CERT="$tlsCert"
TLS_KEY="$tlsKey"
SELF_SIGNED="$self"
CERT_DIR="$Data"
MEDIA_MIN="$MediaMin"
MEDIA_MAX="$MediaMax"
PROBE_PORT="40000"
TURN_PORT="3478"
TURNS_PORT="5349"
TURN_MIN="$TurnMin"
TURN_MAX="$TurnMax"
PORT_MAP="$(if ($NoPortMap) { '0' } else { '1' })"
METRICS_TOKEN="$((Get-Content $metricsFile -Raw).Trim())"
"@ | Set-Content -Path $envFile -Encoding ascii

# ---- the service: a scheduled task at boot, as SYSTEM, restarting itself
$cmd = Join-Path $Data 'run-relay.cmd'
@"
@echo off
rem Starts the Riyeser relay (made by install-relay.ps1).
set RELAY_ENV_FILE=$envFile
$(if ($AsNode) { 'set ELECTRON_RUN_AS_NODE=1' })
"$Node" "$Server" >> "$Data\logs\relay.log" 2>&1
"@ | Set-Content -Path $cmd -Encoding ascii
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Riyeser relay: joins Riyeser Link Office sites and phones at home (SIP, call sound, STUN/TURN).' -Force | Out-Null

# ---- Windows Firewall: only the relay's ports
Get-NetFirewallRule -DisplayName "$Rule*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "$Rule (TCP)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort @($HttpsPort, 5061, 5349, 3478) -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "$Rule (UDP)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort @('3478', '40000', "$MediaMin-$MediaMax", "$TurnMin-$TurnMax") -Profile Any | Out-Null

Start-ScheduledTask -TaskName $Task
$ok = $false; foreach ($i in 1..30) { try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; $ok = $true; break } catch { Start-Sleep -Seconds 1 } }
if (-not $ok) { Write-Host "The relay didn't start. See $Data\logs\relay.log"; exit 1 }
Write-Host "The Riyeser relay is running: $($h | ConvertTo-Json -Compress)"
$reg = Join-Path $Data 'REGISTER.sql'
$pr = if ($Priority) { $Priority } elseif ($Backup) { 2 } else { 1 }
"select relay_register('$Id', '$Domain', '$Region', '$((Get-Content $secretFile -Raw).Trim())', $pr);" | Set-Content -Path $reg -Encoding ascii
Write-Host @"

Left to do (see relay/README.md):
  1. DNS: an A record $Domain -> the office's public address (the relay keeps it up to date itself if you give it a
     DNS token: add DDNS_PROVIDER, DDNS_ZONE and DDNS_TOKEN to $envFile).
  2. Router: if it didn't accept automatic port forwarding (see $Data\logs\relay.log), forward to this PC:
     TCP $HttpsPort, 5061, 5349, 3478 and UDP 3478, 40000, $MediaMin-$MediaMax, $TurnMin-$TurnMax.
     And give this PC a fixed address in the router (a DHCP reservation).
  3. Riyeser online, once: in Supabase -> SQL editor, run the line in $reg (it holds the secret: paste it only there).
"@
