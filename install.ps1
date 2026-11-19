# Riyeser Accounting installer (Windows PowerShell)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = if ($env:RIYESER_PREFIX) { $env:RIYESER_PREFIX } else { Join-Path $env:USERPROFILE ".riyeser\app" }
if (-not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Error "Python 3.10+ is required: https://www.python.org/downloads/"; exit 1 }
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
Write-Host "Installing Riyeser Accounting into $prefix ..."
& $py -m venv $prefix
& "$prefix\Scripts\pip.exe" install --quiet --upgrade pip
& "$prefix\Scripts\pip.exe" install --quiet $here
$desktop = [Environment]::GetFolderPath("Desktop")
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop "Riyeser Accounting.lnk"))
$lnk.TargetPath = "$prefix\Scripts\riyeser-accounting.exe"; $lnk.Save()
Write-Host "Done. A 'Riyeser Accounting' shortcut is on your desktop, or run: $prefix\Scripts\riyeser-accounting.exe"
