// Makes the app show up in Windows "Settings > Apps > Installed apps" (and Control Panel > Programs),
// with a working Uninstall button - even though it's distributed as a zip rather than an installer.
// Uninstalling removes the app, its settings and its Windows registrations. Your own files are never touched.
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const reg = (...args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true }, () => resolve()));
const regKey = (id) => `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`;

/** Files Electron ships with. If the app folder contains anything else, we don't delete the folder automatically. */
const EXPECTED = new Set(['locales', 'resources', 'license.electron.txt', 'licenses.chromium.html', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat', 'libegl.dll', 'libglesv2.dll', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'desk assistant.exe', 'desk pdf.exe']);

function installDir() { return path.dirname(process.execPath); }

/** Installed with the Setup.exe installer? Then Windows already knows about the app and has a proper uninstaller. */
function installerUninstaller(name) {
  const u = path.join(installDir(), `Uninstall ${name}.exe`);
  return fs.existsSync(u) ? u : null;
}

/** Is it safe to delete the whole app folder? Only if it clearly is just this app. */
function safeToDeleteDir(dir) {
  const r = path.resolve(dir);
  const forbidden = [os.homedir(), path.parse(r).root, ...['desktop', 'downloads', 'documents', 'appData'].map((n) => { try { return app.getPath(n); } catch { return ''; } })]
    .filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  if (forbidden.includes(r.toLowerCase())) return false;
  if (!fs.existsSync(path.join(r, 'resources', 'app.asar')) || !fs.existsSync(process.execPath)) return false;
  return fs.readdirSync(r).every((n) => EXPECTED.has(n.toLowerCase()));
}

/** Called on every start (Windows, packaged): keep the "Installed apps" entry up to date. */
async function registerInstalledApp({ id, name, description }) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  if (installerUninstaller(name)) { await reg('delete', regKey(id), '/f'); return; } // the installer's own entry is used
  const key = regKey(id);
  const exe = process.execPath;
  let sizeKb = 150000;
  try { sizeKb = Math.round(fs.readdirSync(installDir()).reduce((n, f) => { try { return n + fs.statSync(path.join(installDir(), f)).size; } catch { return n; } }, 0) / 1024) + 140000; } catch { /* estimate */ }
  const values = [
    ['DisplayName', 'REG_SZ', name], ['DisplayIcon', 'REG_SZ', `${exe},0`], ['DisplayVersion', 'REG_SZ', app.getVersion()],
    ['Publisher', 'REG_SZ', name], ['Comments', 'REG_SZ', description], ['InstallLocation', 'REG_SZ', installDir()],
    ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`], ['NoModify', 'REG_DWORD', '1'], ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(sizeKb)],
  ];
  for (const [n, t, v] of values) await reg('add', key, '/v', n, '/t', t, '/d', v, '/f');
}

/**
 * Full uninstall. Asks first. Removes: start-at-login, PDF-app registration, the Installed-apps entry,
 * the app's own data (settings, search index, saved signatures, PDF backups if chosen) and the program folder.
 */
async function runUninstall({ id, name, pdfProgId }) {
  const official = process.platform === 'win32' && installerUninstaller(name);
  if (official) {
    // Clean up our extra Windows registrations, then hand over to the installer's uninstaller.
    if (pdfProgId) {
      await reg('delete', `HKCU\\Software\\Classes\\${pdfProgId}`, '/f');
      await reg('delete', 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', '/v', pdfProgId, '/f');
      await reg('delete', `HKCU\\Software\\${name}`, '/f');
      await reg('delete', 'HKCU\\Software\\RegisteredApplications', '/v', name, '/f');
    }
    app.setLoginItemSettings({ openAtLogin: false });
    spawn(official, [], { detached: true, stdio: 'ignore' }).unref();
    app.exit(0);
    return true;
  }
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question', buttons: ['Cancel', 'Uninstall'], defaultId: 1, cancelId: 0, title: `Uninstall ${name}`,
    message: `Uninstall ${name}?`,
    detail: `This removes ${name} and its settings from this PC.\n\nYour own files — including everything in your Organised folder — are NOT deleted.`,
    checkboxLabel: 'Also delete saved signatures and PDF backups', checkboxChecked: false,
  });
  if (response !== 1) return false;

  app.setLoginItemSettings({ openAtLogin: false });
  if (process.platform === 'win32') {
    if (pdfProgId) {
      await reg('delete', `HKCU\\Software\\Classes\\${pdfProgId}`, '/f');
      await reg('delete', 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', '/v', pdfProgId, '/f');
      await reg('delete', `HKCU\\Software\\Classes\\Applications\\${path.basename(process.execPath)}`, '/f');
      await reg('delete', `HKCU\\Software\\${name}`, '/f');
      await reg('delete', 'HKCU\\Software\\RegisteredApplications', '/v', name, '/f');
    }
    await reg('delete', regKey(id), '/f');
  }

  // App data: keep signatures/backups unless the box was ticked.
  const data = app.getPath('userData');
  try {
    if (checkboxChecked) fs.rmSync(data, { recursive: true, force: true });
    else for (const n of fs.readdirSync(data)) if (!['pdf-backups'].includes(n)) fs.rmSync(path.join(data, n), { recursive: true, force: true });
  } catch { /* some files may be in use; harmless */ }

  // The program folder can only be removed after we exit.
  const dir = installDir();
  if (process.platform === 'win32' && app.isPackaged && safeToDeleteDir(dir)) {
    spawn('cmd.exe', ['/c', `ping 127.0.0.1 -n 3 > nul & rmdir /s /q "${dir}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await dialog.showMessageBox({ type: 'info', message: `${name} has been uninstalled.`, detail: 'The program folder will be removed in a moment.' });
  } else {
    await dialog.showMessageBox({ type: 'info', message: `${name} has been uninstalled.`, detail: `To finish, delete this folder:\n${dir}` });
    shell.showItemInFolder(process.execPath);
  }
  app.exit(0);
  return true;
}

module.exports = { registerInstalledApp, runUninstall };
