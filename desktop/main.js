// Riyeser Payroll: Windows desktop program. Opens straight into Payroll (the hub is the separate Riyeser Central app).
// Records stay on this computer (%APPDATA%\Riyeser Payroll\payroll\payroll.db). Payslip PDFs and daily backups go in
// Documents\Riyeser\Payroll, so Riyeser Desk Assistant can file them.
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('com.riyeser.payroll');

const BASE = path.join(app.getPath('userData'), 'payroll');
// Demo mode (%APPDATA%\Riyeser\demo.json, set from Riyeser Central): practice records in payroll\demo, and their
// payslips and backups in Documents\Riyeser\Payroll\Demo, so nothing real is touched.
const DEMO = require('./demo').isOn();
const DATA = DEMO ? path.join(BASE, 'demo') : BASE;
const HOME_DIR = path.join(app.getPath('documents'), 'Riyeser');
const PAY_HOME = DEMO ? path.join(HOME_DIR, 'Payroll', 'Demo') : path.join(HOME_DIR, 'Payroll');
const BACKUPS = path.join(PAY_HOME, 'Backups');
const PAYSLIPS = path.join(PAY_HOME, 'Payslips');
for (const d of [DATA, BACKUPS, PAYSLIPS]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { DESKTOP: '1', DATA_DIR: BASE, BACKUP_DIR: BACKUPS, NODE_ENV: 'production', RIYESER_DOCS: process.env.RIYESER_DOCS || HOME_DIR }); // db.js adds \demo itself
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// ---------------------------------------------------------------- records from other files
// checking, copying and describing records files, and finding records put away by a fresh start: restore.js
const R = require('./restore');
const payrollCopy = (src, dest) => R.payrollCopy(src, dest, app.getPath('temp')), summary = R.summary;
const CUR = path.join(DATA, 'payroll.db');
// this program's records from before the file was renamed (ark.db) carry on as payroll.db
{ const OLD = path.join(DATA, 'ark.db');
  if (!fs.existsSync(CUR) && fs.existsSync(OLD)) { try { payrollCopy(OLD, CUR); for (const f of ['ark.db', 'ark.db-wal', 'ark.db-shm']) { try { fs.renameSync(path.join(DATA, f), path.join(DATA, f.replace('ark.db', 'ark.db.before-rename'))); } catch { } } } catch (e) { console.warn('Records not renamed:', e.message); } } }
const isEmpty = () => { const s = fs.existsSync(CUR) ? summary(CUR) : null; return !s || (s.staff <= 1 && !s.shifts && !s.runs && !s.history); };
// Earlier names of this program, newest first: their records are brought in the first time, as long as this program's
// own payroll is still empty. The earlier files are never deleted (they stay as a spare copy).
const EARLIER = [
  { name: 'Riyser', data: path.join(app.getPath('appData'), 'Riyser', 'payroll', 'ark.db'), docs: path.join(app.getPath('documents'), 'Riyser', 'Payroll') },
];
const MOVED = path.join(DATA, 'brought-in.txt');
function bringIn(from) {
  if (fs.existsSync(CUR)) fs.copyFileSync(CUR, path.join(BACKUPS, `payroll-before-${from.name.toLowerCase().replace(/\s+/g, '-')}-${stamp()}.db`));
  for (const f of ['payroll.db-wal', 'payroll.db-shm']) fs.rmSync(path.join(DATA, f), { force: true });
  payrollCopy(from.data, CUR);
  copyFolder(from);
  fs.appendFileSync(MOVED, `Payroll records brought in from ${from.name} (${from.data}) on ${new Date().toISOString()}\n`);
}
// the earlier program's payslip PDFs and backups, copied (nothing overwritten, nothing removed)
function copyFolder(from) {
  if (!fs.existsSync(from.docs)) return;
  if (from.backupsOnly) fs.cpSync(from.docs, path.join(BACKUPS, `From ${from.name}`), { recursive: true, force: false, errorOnExist: false });
  else for (const sub of ['Payslips', 'Backups']) if (fs.existsSync(path.join(from.docs, sub))) fs.cpSync(path.join(from.docs, sub), path.join(HOME_DIR, 'Payroll', sub), { recursive: true, force: false, errorOnExist: false });
}
if (!DEMO && !fs.existsSync(MOVED)) { // (demo records never bring in anything)
  try {
    const from = EARLIER.find(e => fs.existsSync(e.data));
    if (from && isEmpty()) bringIn(from);
    else { for (const e of EARLIER) if (!e.backupsOnly) copyFolder(e); fs.appendFileSync(MOVED, `Checked for earlier records on ${new Date().toISOString()}: ${from ? 'this program already had payroll records, so they were left where they are (Payroll → Bring in records from an earlier version)' : 'none found'}.\n`); }
  } catch (e) { console.warn('Earlier records not brought in:', e.message); }
}

// a backup chosen under Payroll → Restore is swapped in here, before the records are opened
const PENDING = path.join(DATA, 'restore-pending.db');
if (fs.existsSync(PENDING)) {
  if (fs.existsSync(CUR)) fs.copyFileSync(CUR, path.join(BACKUPS, `payroll-before-restore-${stamp()}.db`));
  for (const f of ['payroll.db', 'payroll.db-wal', 'payroll.db-shm']) fs.rmSync(path.join(DATA, f), { force: true });
  fs.renameSync(PENDING, CUR);
}

let win = null, base = '';
const portFree = p => new Promise(ok => { const s = net.createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true))).listen(p, '127.0.0.1'); });

// payslips / timesheets as a PDF: in Documents\Riyeser\Payroll\Payslips, or a folder the person chose this time
const chosenFolders = new Set();
async function savePdf(html, title, folder) {
  const dir = folder && chosenFolders.has(folder) ? folder : PAYSLIPS;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base href="${base}/"><title>${String(title || 'Payslip').replace(/</g, '')}</title>
    <link rel="stylesheet" href="${base}/style.css"><link rel="stylesheet" href="${base}/staff.css">
    <style>body{background:#fff;padding:24px;font-family:Arial,sans-serif;color:#111}.payslip{page-break-after:always;max-width:680px;margin:0 auto 30px}.no-print,button{display:none!important}</style></head><body>${html}</body></html>`;
  const tmp = path.join(app.getPath('temp'), `riyeser-print-${Date.now()}.html`);
  fs.writeFileSync(tmp, doc);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    const name = String(title || 'Payslip').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Payslip';
    let file = path.join(dir, `${name}.pdf`), n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${name} (${n++}).pdf`);
    fs.writeFileSync(file, pdf);
    return file;
  } finally { w.destroy(); fs.rmSync(tmp, { force: true }); }
}
const allowed = file => !!file && fs.existsSync(file) && (file.startsWith(HOME_DIR) || [...chosenFolders].some(f => file.startsWith(f)));

ipcMain.handle('riyser:pdf', async (e, html, title, folder) => ({ file: await savePdf(String(html || ''), title, folder) }));
ipcMain.handle('riyser:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Save the payslips in…', defaultPath: PAYSLIPS, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  chosenFolders.add(r.filePaths[0]); return r.filePaths[0];
});
ipcMain.handle('riyser:payslipsFolder', () => PAYSLIPS);
ipcMain.handle('riyser:openFolder', (e, folder) => { if (folder === PAYSLIPS || chosenFolders.has(folder)) shell.openPath(folder); });
ipcMain.handle('riyser:openFile', async (e, file) => { if (!allowed(file)) return { ok: false }; const err = await shell.openPath(file); return { ok: !err }; });
ipcMain.handle('riyser:show', (e, file) => { if (allowed(file)) shell.showItemInFolder(file); });

async function start() {
  // the free trial's registry copy (HKCU\Software\Riyeser\Trial, trial-guard.js): Windows only, the app itself
  try { require('./trial-guard').useWindowsDefaults(); } catch { /* the other places still count */ }
  const { server, app: web } = require('./server');
  const port = (await portFree(37421)) ? 37421 : 0;          // the same address each time if it's free
  await new Promise(ok => server.listen(port, '127.0.0.1', ok));  // only this computer can reach payroll
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ width: 1300, height: 880, minWidth: 380, minHeight: 500, title: DEMO ? 'Riyeser Payroll (demo mode)' : 'Riyeser Payroll', icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f3f5f8', webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') } });
  // payslips and timesheets open in a print window; web links open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url === '' || url.startsWith(base)) return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 1000, title: 'Riyeser Payroll — print', autoHideMenuBar: true } };
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); } });
  win.loadURL(`${base}/staff`);
  menu(web);
}

// Restore (menu, Settings → Backups, or the first-run screen): pick a records file, see what's in it, then the current
// records are backed up and the chosen ones are swapped in on restart. `file` is a backup chosen from the Settings list.
// Records put away by Riyeser Central's fresh start (%APPDATA%\Riyeser Payroll (before fresh start …)) are offered too.
async function restore(file) {
  let src = file || null;
  if (!src) {
    const fresh = DEMO ? [] : R.freshStartRecords(app.getPath('userData'));
    if (fresh.length) {
      const pick = (await dialog.showMessageBox(win, { type: 'question', message: 'Restore payroll records', cancelId: fresh.length + 1,
        detail: `Records put away by a fresh start were found on this computer:\n${fresh.map(f => `• ${f.when}: ${R.describe(f.sum)}`).join('\n')}`,
        buttons: [...fresh.map(f => `From before the fresh start on ${f.when}`), 'Choose a backup file…', 'Cancel'] })).response;
      if (pick < fresh.length) src = fresh[pick].file; else if (pick > fresh.length) return;
    }
  }
  if (!src) {
    const r = await dialog.showOpenDialog(win, { title: 'Restore payroll from a backup', defaultPath: BACKUPS, properties: ['openFile'],
      filters: [{ name: 'Payroll records (payroll-….db backups, or payroll.db)', extensions: ['db'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return;
    src = r.filePaths[0];
  }
  if (path.resolve(src).toLowerCase() === path.resolve(CUR).toLowerCase()) return dialog.showErrorBox("Can't restore that file", 'That is the records file Payroll is using now. Choose a backup.');
  const sum = summary(src);
  const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Restore and restart', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Restore this payroll backup?',
    detail: `Payroll will go back to how it was in:\n${src}${sum ? `\n(${R.describe(sum)})` : ''}\n\nA copy of the records as they are now is saved in the backups folder first. Riyeser Payroll restarts.` });
  if (ok.response !== 0) return;
  try { payrollCopy(src, PENDING); } catch (e) { return dialog.showErrorBox("Can't restore that file", e.message); }
  app.relaunch(); app.exit(0);
}
ipcMain.handle('riyser:restore', async (e, name) => {
  try { await restore(name ? R.backupFile(BACKUPS, name) : null); return { ok: true }; }
  catch (err) { dialog.showErrorBox("Can't restore that backup", err.message); return { ok: false }; }
});

function menu(web) {
  const backupNow = async () => {
    try { const f = web.locals.backup('manual'); await dialog.showMessageBox(win, { type: 'info', message: 'Payroll backed up', detail: `Saved ${f} in\n${BACKUPS}` }); }
    catch (e) { dialog.showErrorBox('Backup failed', e.message); }
  };

  const fromEarlier = async () => {
    const found = EARLIER.filter(e => fs.existsSync(e.data));
    if (!found.length) return dialog.showMessageBox(win, { type: 'info', message: 'No records from an earlier version on this computer', detail: `Looked in:\n${EARLIER.map(e => e.data).join('\n')}\n\nIf you have a backup file instead, use Payroll → Restore from a backup… and choose it.` });
    const pick = found.length === 1 ? 0 : (await dialog.showMessageBox(win, { type: 'question', buttons: [...found.map(e => e.name), 'Cancel'], cancelId: found.length, message: 'Bring in the records from which earlier version?' })).response;
    const from = found[pick]; if (!from) return;
    const sum = summary(from.data);
    const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Bring them in and restart', 'Cancel'], defaultId: 1, cancelId: 1, message: `Bring in the ${from.name} payroll records?`,
      detail: `${sum ? `${sum.staff} staff, ${sum.shifts} shifts, ${sum.runs} pay runs, ${sum.history} weeks of pay history.\n\n` : ''}This payroll will be replaced by them. A copy of it as it is now is saved in the backups folder first. Riyeser Payroll restarts.` });
    if (ok.response !== 0) return;
    try { payrollCopy(from.data, PENDING); } catch (e) { return dialog.showErrorBox("Can't bring them in", e.message); }
    copyFolder(from);
    fs.appendFileSync(MOVED, `Brought in ${from.name} by hand on ${new Date().toISOString()}\n`);
    app.relaunch(); app.exit(0);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Payroll', submenu: [
      { label: 'Back up now', accelerator: 'CmdOrCtrl+B', click: backupNow },
      { label: 'Open the backups folder', click: () => shell.openPath(BACKUPS) },
      { label: 'Restore from a backup…', click: () => restore() },
      { label: 'Bring in records from an earlier version…', click: fromEarlier },
      { label: 'Open the payslips folder', click: () => shell.openPath(PAYSLIPS) },
      { type: 'separator' },
      { label: 'Print', accelerator: 'CmdOrCtrl+P', click: () => win.webContents.print() },
      { type: 'separator' },
      { role: 'quit', label: 'Exit' } ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload', label: 'Refresh' }, { type: 'separator' }, { role: 'zoomIn', label: 'Bigger text' }, { role: 'zoomOut', label: 'Smaller text' }, { role: 'resetZoom', label: 'Normal size' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      { label: 'Payroll help guide', accelerator: 'F1', click: () => shell.openExternal('https://riyeser.com/help/payroll.html') },
      { label: 'Email support', click: () => shell.openExternal('mailto:info@riyeser.com?subject=' + encodeURIComponent(`Riyeser Payroll ${app.getVersion()}`)) },
      { type: 'separator' },
      { label: 'Where are my records?', click: () => dialog.showMessageBox(win, { type: 'info', message: 'Your records', detail: `Payroll records:\n${CUR}\n\nPayslip PDFs and daily backups:\n${PAY_HOME}\n\nCopy that folder to a USB stick or cloud drive now and then.` }) },
      { label: `About Riyeser Payroll (version ${app.getVersion()})`, click: () => dialog.showMessageBox(win, { type: 'info', message: 'Riyeser Payroll', detail: `Version ${app.getVersion()}\nRiyeser Group\nTime clock, timesheets, pay runs, payslips, leave and pay history.` }) } ] },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(start).catch(e => { dialog.showErrorBox('Riyeser Payroll could not start', String(e && e.stack || e)); app.exit(1); });
app.on('window-all-closed', () => app.quit());
