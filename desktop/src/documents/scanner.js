// Riyeser Documents: scanning from a scanner connected to this PC (USB or network), through Windows' own scanning
// system (WIA). A small PowerShell script shows Windows' "Scan" dialog (pick the scanner, colour, then Scan) and saves
// the page. The page is then turned into a PDF and goes to the Inbox.
// If Windows can't find a WIA scanner (some only come with their maker's own app), the app opens Windows Fax and Scan
// and explains where to save the scan so it lands in the Inbox.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

// WIA format ids: JPEG. Device type 1 = scanner. ShowAcquireImage(DeviceType, Intent, Bias, FormatID, AlwaysSelectDevice,
// UseCommonUI, CancelError). Exit codes: 0 saved, 2 cancelled, 3 no WIA on this PC, 4 no scanner / scanner error.
const WIA_SCRIPT = `$ErrorActionPreference = 'Stop'
$out = $args[0]
try { $dialog = New-Object -ComObject WIA.CommonDialog } catch { Write-Output 'NO_WIA'; exit 3 }
try {
  $image = $dialog.ShowAcquireImage(1, 1, 131072, '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}', $false, $true, $false)
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message); exit 4
}
if ($null -eq $image) { Write-Output 'CANCELLED'; exit 2 }
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
$image.SaveFile($out)
Write-Output 'OK'
exit 0
`;

/** Write the script somewhere PowerShell can read it (it can't read inside the program's app.asar). */
function scriptFile(dir = os.tmpdir()) {
  const f = path.join(dir, 'riyeser-documents-scan.ps1');
  fs.writeFileSync(f, WIA_SCRIPT);
  return f;
}

/**
 * Scan one page with Windows' scan dialog. Returns { ok: true, file } | { ok: false, reason: 'cancelled'|'no-scanner'|'no-wia'|'not-windows', message }.
 * exec: for tests.
 */
function scanWithWia({ outDir = os.tmpdir(), exec = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') return Promise.resolve({ ok: false, reason: 'not-windows', message: 'Scanning from here works on Windows.' });
  const out = path.join(outDir, `Scan ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg`);
  const script = scriptFile(outDir);
  return new Promise((resolve) => {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, out], { windowsHide: true, timeout: 10 * 60_000 }, (err, stdout) => {
      const said = String(stdout || '').trim();
      if (/^OK/m.test(said) && fs.existsSync(out)) return resolve({ ok: true, file: out });
      if (/CANCELLED/.test(said)) return resolve({ ok: false, reason: 'cancelled', message: 'Scan cancelled.' });
      if (/NO_WIA/.test(said)) return resolve({ ok: false, reason: 'no-wia', message: 'Windows\' scanning service isn\'t available on this PC.' });
      resolve({ ok: false, reason: 'no-scanner', message: said.replace(/^ERROR:\s*/, '') || (err && err.message) || 'No scanner answered.' });
    });
  });
}

/** Turn a scanned picture into a one-page PDF (A4-ish, the picture's own shape). */
async function imageToPdf(imageFile, pdfFile) {
  const { PDFDocument } = require('pdf-lib');
  const bytes = fs.readFileSync(imageFile);
  const doc = await PDFDocument.create();
  const img = /\.png$/i.test(imageFile) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const w = 595; const h = Math.round((img.height / img.width) * w);
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  fs.writeFileSync(pdfFile, await doc.save());
  return pdfFile;
}

/** Open Windows Fax and Scan (built into Windows 10 and 11 Pro; an optional feature on some Home PCs). */
function openFaxAndScan({ platform = process.platform, run = spawn } = {}) {
  if (platform !== 'win32') return false;
  try { run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WFS.exe'), [], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
}

module.exports = { WIA_SCRIPT, scriptFile, scanWithWia, imageToPdf, openFaxAndScan };
