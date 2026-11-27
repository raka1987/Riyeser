<#
  The Riyeser relay on Windows: the head office's always-on PC (or a mini PC) runs it as a background service that
  starts with Windows, before anyone signs in. Run in an elevated PowerShell (Run as administrator):

    .\install-relay.ps1 -Domain relay.riyeser.com -Region "Suva head office" -Id suva1
    .\install-relay.ps1 -Backup -Domain relay2.riyeser.com -Region Sydney -Id syd1     (asks for the main relay's secret)
    .\install-relay.ps1 -Uninstall        (removes it from this PC and from Riyeser: see "Uninstalling" below)
    .\install-relay.ps1 -LinkOffice -SecretFile <file> -Id r1a2b3c4 -NoDns   (Riyeser Link Office, with a set-up code)
    .\install-relay.ps1 -DdnsProvider namecheap -Domain relay.riyeser.com ...   (asks for the Namecheap Dynamic DNS password)

  It runs the relay with Node (node.exe on this PC), or, with -LinkOffice, with the copy of Node inside Riyeser Link
  Office (so nothing else needs installing). The service is a Windows scheduled task "Riyeser Relay" that starts at
  boot as SYSTEM and restarts itself if it stops. It adds Windows Firewall rules for its ports, asks the office
  router to forward them (UPnP / NAT-PMP, where the router allows it), and makes a self-signed certificate whose
  fingerprint Link Office checks (or use -CertPfx for your own). Settings and the secret are in
  C:\ProgramData\Riyeser Relay\ (readable only by Administrators and SYSTEM).

  Dynamic DNS (the relay keeps its name pointing at the office's public address itself):
    -DdnsProvider namecheap  host and domain from -Domain (relay.riyeser.com -> relay + riyeser.com; or -DdnsHost /
                             -DdnsDomain). The Dynamic DNS password (Namecheap: Domain List -> Manage -> Advanced DNS ->
                             Dynamic DNS; NOT the account password) is asked for, hidden, or read from -DdnsPasswordFile
                             (which is deleted after reading; Riyeser Link Office uses this). It is written only to
                             relay.env, never shown or logged.
    -DdnsProvider cloudflare|digitalocean -DdnsZone <zone id | domain>   (asks for the API token, hidden)
    Without -DdnsProvider, the dynamic DNS settings already in relay.env are kept. -DdnsTokenFile: the Cloudflare /
    DigitalOcean token in a file (deleted after reading), as Riyeser Link Office passes it.

  No web name (-NoDns, 1.3.1, the default from Riyeser Link Office): sites and phones connect to the address the relay
  reports to Riyeser online and check its certificate, so no DNS or dynamic DNS is needed. -SecretFile: the relay's own
  key, from a set-up code made on the website (Riyeser Link Office claims it; the file is deleted after reading).

  Uninstalling (-Uninstall): removes this relay from Riyeser (unless -KeepRegistration), stops and removes the task,
  removes the router port forwarding it made (UPnP / NAT-PMP, from portmaps.json) and its firewall rules, zips its
  logs into C:\ProgramData\Riyeser Relay Logs (for support), and deletes C:\ProgramData\Riyeser Relay with its key
  and settings (-KeepSettings keeps them). The last line is RESULT {json} with what was done.
#>
[CmdletBinding()]
param(
  [string]$Domain = 'relay.riyeser.com', [string]$Region = 'Suva head office', [string]$Id = 'suva1',
  [string]$RelayDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Node = '', [switch]$LinkOffice, [switch]$Backup, [int]$Priority = 0,
  [int]$HttpsPort = 443, [int]$MediaMin = 40002, [int]$MediaMax = 40201, [int]$TurnMin = 40202, [int]$TurnMax = 40301,
  [string]$CertFile = '', [string]$KeyFile = '', [switch]$NoPortMap, [switch]$Uninstall,
  [switch]$KeepSettings, [switch]$KeepRegistration, [string]$LogsDir = (Join-Path $env:ProgramData 'Riyeser Relay Logs'),
  [string]$SecretFile = '', [switch]$NoDns, [string]$DdnsTokenFile = '', [string]$PublicIp = '',
  [ValidateSet('namecheap', 'cloudflare', 'digitalocean')][string]$DdnsProvider = '', [string]$DdnsHost = '', [string]$DdnsDomain = '',
  [string]$DdnsZone = '', [string]$DdnsPasswordFile = '',
  [string]$SupabaseUrl = 'https://goaugynxeatzqzifpoes.supabase.co', [string]$SupabaseKey = 'sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL'
)
$ErrorActionPreference = 'Stop'
$Task = 'Riyeser Relay'; $Data = Join-Path $env:ProgramData 'Riyeser Relay'; $Rule = 'Riyeser Relay'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run this in PowerShell as administrator (right-click -> Run as administrator).'; exit 1 }

if ($Uninstall) {
  $res = [ordered]@{ ok = $true; left = $null; port_mappings = $null; task_removed = $false; firewall_removed = $false; logs_zip = $null; settings_removed = $false }
  $envFile = Join-Path $Data 'relay.env'; $cfg = @{}
  if (Test-Path $envFile) { foreach ($l in Get-Content $envFile) { if ($l -match '^([A-Z_]+)="(.*)"$') { $cfg[$Matches[1]] = $Matches[2] } } }
  $nodeExe = $cfg.RELAY_NODE; $srv = $cfg.RELAY_SERVER
  if (-not $nodeExe -or -not (Test-Path $nodeExe)) { $lo = Join-Path $env:ProgramFiles 'Riyeser Link Office\Riyeser Link Office.exe'; if (Test-Path $lo) { $nodeExe = $lo; $cfg.RELAY_AS_NODE = '1' } else { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $nodeExe = $c.Source; $cfg.RELAY_AS_NODE = '0' } } }
  if (-not $srv -or -not (Test-Path $srv)) { $srv = Join-Path $RelayDir 'server.js' }
  function Relay-Helper([string]$arg) {
    if (-not $nodeExe -or -not (Test-Path $srv) -or -not (Test-Path $envFile)) { return $null }
    $env:RELAY_ENV_FILE = $envFile; if ($cfg.RELAY_AS_NODE -eq '1') { $env:ELECTRON_RUN_AS_NODE = '1' }
    try { $o = & $nodeExe $srv $arg 2>$null | Select-Object -Last 1; if ($o) { return ($o | ConvertFrom-Json) } } catch { } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    return $null
  }
  # 1. out of Riyeser first (signed with its own key): sites move to the next relay
  if (-not $KeepRegistration) { $res.left = Relay-Helper '--leave' }
  # 2. stop it (the task, and the relay itself if it's still running)
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'relay\\server\.js' -and $_.CommandLine -notmatch '--leave|--remove-port-mappings' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # 3. the router port forwarding it made
  $res.port_mappings = Relay-Helper '--remove-port-mappings'
  # 4. the task and the firewall rules
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  $res.task_removed = -not (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue)
  Get-NetFirewallRule -DisplayName "$Rule*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  $res.firewall_removed = -not (Get-NetFirewallRule -DisplayName "$Rule*" -ErrorAction SilentlyContinue)
  # 5. the logs, zipped for support (never the key or settings)
  $logs = Join-Path $Data 'logs'
  if ((Test-Path $logs) -and (Get-ChildItem $logs -File -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    $zip = Join-Path $LogsDir ("relay-logs-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try { Compress-Archive -Path (Join-Path $logs '*') -DestinationPath $zip -Force; $res.logs_zip = $zip } catch { $res.logs_zip = $null }
  }
  # 6. the key, settings and certificate
  if (-not $KeepSettings -and (Test-Path $Data)) { Remove-Item -Recurse -Force $Data -ErrorAction SilentlyContinue }
  $res.settings_removed = $KeepSettings -or -not (Test-Path $Data)
  $res.ok = $res.task_removed -and $res.firewall_removed -and $res.settings_removed
  Write-Host ("The Riyeser relay is removed from this PC{0}.{1}" -f $(if ($res.left -and $res.left.left) { ' and from Riyeser' } else { '' }), $(if ($res.logs_zip) { " Its logs are in $($res.logs_zip)." } else { '' }))
  Write-Host ('RESULT ' + ($res | ConvertTo-Json -Compress -Depth 4))
  if ($res.ok) { exit 0 } else { exit 2 }
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
if ($SecretFile) {
  # the relay's own key from a set-up code (Riyeser Link Office claimed it): replaces any key this PC had
  $k = if (Test-Path $SecretFile) { (Get-Content $SecretFile -Raw).Trim() } else { '' }
  Remove-Item $SecretFile -Force -ErrorAction SilentlyContinue
  if ($k -notmatch '^[0-9a-f]{64}$') { Write-Host 'The relay key from the set-up code is missing. Make a new set-up code on the website and try again.'; exit 1 }
  [IO.File]::WriteAllText($secretFile, $k); $k = $null; $Enrolled = $true
} else { $Enrolled = $false }
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

# ---- dynamic DNS (kept from relay.env when not given now)
$dd = @{ DDNS_PROVIDER = ''; DDNS_ZONE = ''; DDNS_NAME = ''; DDNS_TOKEN = ''; DDNS_HOST = ''; DDNS_DOMAIN = ''; DDNS_PASSWORD = '' }
function Read-Hidden([string]$prompt) {
  $s = Read-Host $prompt -AsSecureString; $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
if (-not $DdnsProvider) {
  # no dynamic DNS asked for: keep what relay.env already has (a fresh install has none)
  if (Test-Path $envFile) {
    foreach ($l in Get-Content $envFile) { if ($l -match '^(DDNS_[A-Z_]+)="(.*)"$' -and $dd.ContainsKey($Matches[1])) { $dd[$Matches[1]] = $Matches[2] } }
    if ($dd.DDNS_PROVIDER) { Write-Host "Keeping the dynamic DNS settings ($($dd.DDNS_PROVIDER)) already in $envFile." }
  }
} elseif ($DdnsProvider -eq 'namecheap') {
  $labels = $Domain.Split('.')
  if (-not $DdnsDomain) { $DdnsDomain = ($labels | Select-Object -Last 2) -join '.' }
  if (-not $DdnsHost) { $DdnsHost = if ($Domain.EndsWith(".$DdnsDomain")) { $Domain.Substring(0, $Domain.Length - $DdnsDomain.Length - 1) } else { '@' } }
  if ($DdnsHost -notmatch '^(@|\*|[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?)$' -or $DdnsDomain -notmatch '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { Write-Host 'Check the Dynamic DNS host (like relay) and domain (like riyeser.com).'; exit 1 }
  if ($DdnsPasswordFile) {
    $pw = if (Test-Path $DdnsPasswordFile) { (Get-Content $DdnsPasswordFile -Raw).Trim() } else { '' }
    Remove-Item $DdnsPasswordFile -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Namecheap Dynamic DNS for $DdnsHost.$DdnsDomain. The password is on Namecheap: Domain List -> Manage $DdnsDomain -> Advanced DNS -> Dynamic DNS (turn it on, copy the password). It is NOT your Namecheap account password."
    $pw = (Read-Hidden 'Dynamic DNS password (hidden, kept only in relay.env)').Trim()
  }
  if ($pw -notmatch '^[^\s"$`\\]{8,200}$') { Write-Host 'That doesn''t look like a Namecheap Dynamic DNS password (copy it again from Advanced DNS -> Dynamic DNS).'; exit 1 }
  $dd.DDNS_PROVIDER = 'namecheap'; $dd.DDNS_HOST = $DdnsHost; $dd.DDNS_DOMAIN = $DdnsDomain; $dd.DDNS_NAME = $Domain; $dd.DDNS_PASSWORD = $pw; $pw = $null
} else {
  if (-not $DdnsZone) { Write-Host "-DdnsProvider $DdnsProvider needs -DdnsZone (Cloudflare: the zone id; DigitalOcean: the domain)."; exit 1 }
  if ($DdnsTokenFile) { $tok = if (Test-Path $DdnsTokenFile) { (Get-Content $DdnsTokenFile -Raw).Trim() } else { '' }; Remove-Item $DdnsTokenFile -Force -ErrorAction SilentlyContinue }
  else { $tok = (Read-Hidden "DNS API token for $DdnsProvider (hidden, kept only in relay.env)").Trim() }
  if ($tok -notmatch '^[^\s"$`\\]{8,500}$') { Write-Host 'That doesn''t look like an API token.'; exit 1 }
  $dd.DDNS_PROVIDER = $DdnsProvider; $dd.DDNS_ZONE = $DdnsZone; $dd.DDNS_NAME = $Domain; $dd.DDNS_TOKEN = $tok; $tok = $null
}

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
PORT_MAP_FILE="$(Join-Path $Data 'portmaps.json')"
RELAY_DNS="$(if ($NoDns) { '0' } else { '1' })"
RELAY_PUBLIC_IP="$PublicIp"
RELAY_NODE="$Node"
RELAY_SERVER="$Server"
RELAY_AS_NODE="$(if ($AsNode) { '1' } else { '0' })"
METRICS_TOKEN="$((Get-Content $metricsFile -Raw).Trim())"
DDNS_PROVIDER="$($dd.DDNS_PROVIDER)"
DDNS_ZONE="$($dd.DDNS_ZONE)"
DDNS_NAME="$($dd.DDNS_NAME)"
DDNS_TOKEN="$($dd.DDNS_TOKEN)"
DDNS_HOST="$($dd.DDNS_HOST)"
DDNS_DOMAIN="$($dd.DDNS_DOMAIN)"
DDNS_PASSWORD="$($dd.DDNS_PASSWORD)"
"@ | Set-Content -Path $envFile -Encoding ascii
$dd.DDNS_PASSWORD = $null; $dd.DDNS_TOKEN = $null

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
if ($h.dns) { foreach ($i in 1..20) { if ($null -ne $h.dns.ok) { break }; Start-Sleep -Seconds 1; try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2 } catch { } } }
$dnsNote = "an A record $Domain -> the office's public address (or let the relay keep it up to date itself: run this again with -DdnsProvider namecheap, see relay/README.md)."
if ($h.dns) { $dnsNote = if ($h.dns.ok -eq $false) { "the relay couldn't update $($h.dns.name): $($h.dns.error)" } else { "the relay keeps $($h.dns.name) pointing at this office itself ($($h.dns.provider)); see $Data\logs\relay.log (lines with DNS:)." } }
if ($Enrolled) {
  # set up with a code: it's registered with the business already; it shows as online once it has checked in
  $synced = $false; foreach ($i in 1..20) { try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; if ($h.sync -and $h.sync.ok) { $synced = $true; break } } catch { }; Start-Sleep -Seconds 1 }
  Write-Host $(if ($synced) { "Registered with your business: relay $Id ($Region)." } else { "The relay is running; it registers with your business when it reaches Riyeser online ($Data\logs\relay.log)." })
  Write-Host ('RESULT ' + (@{ ok = $true; relay = $Id; synced = $synced } | ConvertTo-Json -Compress))
  exit 0
}
$reg = Join-Path $Data 'REGISTER.sql'
$pr = if ($Priority) { $Priority } elseif ($Backup) { 2 } else { 1 }
"select relay_register('$Id', '$Domain', '$Region', '$((Get-Content $secretFile -Raw).Trim())', $pr);" | Set-Content -Path $reg -Encoding ascii
Write-Host @"

Left to do (see relay/README.md):
  1. DNS: $dnsNote
  2. Router: if it didn't accept automatic port forwarding (see $Data\logs\relay.log), forward to this PC:
     TCP $HttpsPort, 5061, 5349, 3478 and UDP 3478, 40000, $MediaMin-$MediaMax, $TurnMin-$TurnMax.
     And give this PC a fixed address in the router (a DHCP reservation).
  3. Riyeser online, once: in Supabase -> SQL editor, run the line in $reg (it holds the secret: paste it only there).
"@
