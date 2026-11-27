<#
  The Windows CI relay job (1.3.1): "move the relay to a new PC" on one runner. Uninstalls the relay the way Riyeser
  Link Office's "Stop using this PC as the relay" does (install-relay.ps1 -Uninstall), checks nothing is left (no task,
  no firewall rules, the router port forwarding it noted removed, no key or settings; the logs zipped), then installs it
  again as the "new PC" (a new id and key). Run as administrator from desktop\.
#>
$ErrorActionPreference = 'Stop'
$data = Join-Path $env:ProgramData 'Riyeser Relay'; $logs = Join-Path $env:ProgramData 'Riyeser Relay Logs'
$relay = (Resolve-Path src/relay).Path; $node = (Get-Command node).Source
# a pretend router that "forwarded" the relay's ports (the relay itself runs with -NoPortMap on CI)
$req = Join-Path $env:RUNNER_TEMP 'natpmp-requests.log'
$router = Start-Process -FilePath $node -ArgumentList 'test/e2e/fake-natpmp.js', "`"$data\portmaps.json`"", "`"$req`"" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
if (-not (Test-Path "$data\portmaps.json")) { Write-Host 'the pretend router did not start'; exit 1 }
$out = & ./src/relay/deploy/windows/install-relay.ps1 -Uninstall -RelayDir $relay *>&1 | Out-String
Write-Host $out
Stop-Process -Id $router.Id -Force -ErrorAction SilentlyContinue
$problems = @()
if (Get-ScheduledTask -TaskName 'Riyeser Relay' -ErrorAction SilentlyContinue) { $problems += 'the task is still there' }
if (Get-NetFirewallRule -DisplayName 'Riyeser Relay*' -ErrorAction SilentlyContinue) { $problems += 'firewall rules are still there' }
if (Test-Path $data) { $problems += "$data is still there" }
if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'relay\\server\.js' -and $_.CommandLine -notmatch 'fake-natpmp' }) { $problems += 'the relay is still running' }
$deleted = @(Get-Content $req -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.lifetime -eq 0 } | ForEach-Object { $_.port })
foreach ($p in 443, 3478, 40000) { if ($deleted -notcontains $p) { $problems += "the router wasn't asked to remove port $p" } }
if (-not (Get-ChildItem $logs -Filter 'relay-logs-*.zip' -ErrorAction SilentlyContinue)) { $problems += 'no zipped logs' }
foreach ($l in 443, 5061, 5349, 3478) { if (Get-NetTCPConnection -State Listen -LocalPort $l -ErrorAction SilentlyContinue | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'node' }) { $problems += "something still listens on $l" } }
if ($out -notmatch 'RESULT \{') { $problems += 'no RESULT line' }
if ($problems.Count) { Write-Host "After uninstalling: $($problems -join '; ')"; exit 1 }
Write-Host "Uninstalled cleanly: no task, no firewall rules, router asked to remove ports $($deleted -join ', '), no key or settings, logs zipped."
# the "new PC": a new id and a new key
& ./src/relay/deploy/windows/install-relay.ps1 -Node $node -RelayDir $relay -Domain relay.riyeser.com -Region 'Head office (new PC)' -Id suva2 -NoPortMap -PublicIp 127.0.0.1 -SupabaseUrl ''
if ($LASTEXITCODE) { Get-Content "$data\logs\relay.log" -ErrorAction SilentlyContinue; exit 1 }
Write-Host 'Installed again as suva2 (the new PC).'
