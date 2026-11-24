// Riyeser Link Office for Windows: the office phone system, on one PC.
// It registers the office's desk phones (and, next, the Riyeser Link app) and connects calls between them on the
// office network. It sits by the clock, starts with Windows and keeps the PC awake while it runs; closing the window
// keeps it running (Quit from the tray icon). Internal calls only: no outside numbers and no emergency calls.
// It works only while Link Plus is on (trial or paid); everything is kept on this PC, so it runs with no internet.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, powerSaveBlocker, safeStorage, net, Notification, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NAME = 'Riyeser Link Office';
const TEAM_URL = 'https://riyeser.com/link/';
app.setName(NAME);
// Its own data folder, %APPDATA%\Riyeser Link Office (Riyeser Central reads the desk phones from it). Never the
// chat app's: that one is called Riyeser Link now, but keeps its data in %APPDATA%\Riyeser Team.
app.setPath('userData', path.join(app.getPath('appData'), NAME));
if (process.platform === 'win32') app.setAppUserModelId('com.riyeser.linkoffice');
const selfTestArg = process.argv.find((a) => a.startsWith('--self-test='));
if (!selfTestArg && !app.requestSingleInstanceLock()) app.quit();

let win = null; let tray = null; let quitting = false; let toldAboutTray = false; let service = null; let store = null;
let sleepNote = null; let firewall = null; let blocker = null;
const startHidden = process.argv.includes('--hidden');
const icon = (file) => path.join(__dirname, 'renderer', file);

// ---------- start with Windows ----------
const LOGIN = { args: ['--hidden'] };
const startWithWindows = (on) => app.setLoginItemSettings({ openAtLogin: on, ...LOGIN });
const startsWithWindows = () => app.getLoginItemSettings(LOGIN).openAtLogin;

// ---------- log file (no passwords are ever written: the engine never logs them) ----------
function logLine(level, text) {
  try {
    const f = path.join(app.getPath('userData'), 'logs', 'link.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, `${f}.old`); } catch { /* new file */ }
    fs.appendFileSync(f, `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
  } catch { /* logging is a nice-to-have */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 800, minWidth: 420, minHeight: 520, title: NAME, show: !startHidden,
    icon: icon(process.platform === 'win32' ? 'icon-link.ico' : 'icon-link.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'link.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: NAME, body: 'Still running by the clock, so the office phones keep working. Quit from the tray icon.', silent: true }).show();
    }
  });
}
function createTray() {
  tray = new Tray(icon('icon-link.png'));
  tray.setToolTip(NAME);
  const menu = () => Menu.buildFromTemplate([
    { label: `Open ${NAME}`, click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (item) => { startWithWindows(item.checked); tray.setContextMenu(menu()); } },
    { type: 'separator' },
    { label: `Quit ${NAME} (the phones stop working)`, click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { if (win.isVisible() && win.isFocused()) win.hide(); else { win.show(); win.focus(); } });
}

// ---------- the engine ----------
function seal(s) { return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : s; }
function unseal(s) { return String(s).startsWith('enc:') ? safeStorage.decryptString(Buffer.from(String(s).slice(4), 'base64')) : s; }

function makeService() {
  const { Store } = require('./core/store');
  const { Online } = require('./core/online');
  const { centralOnline } = require('./link/sync');
  const { PhoneService } = require('./link/service');
  store = new Store(path.join(app.getPath('userData'), 'data'));
  const appData = app.getPath('appData');
  const fetchFn = (url, opts) => net.fetch(url, opts);
  const own = new Online({ store, fetchFn, appData, appVersion: app.getVersion(), deviceName: os.hostname(), platform: process.platform });
  const central = centralOnline({ appData, phoneStore: store, fetchFn });
  service = new PhoneService({ store, appData, clients: () => [own, central], seal, unseal, log: logLine });
  service.online = own;
  let pending = null;
  service.on('change', () => {   // tell the window, at most every 300 ms
    if (pending) return;
    pending = setTimeout(() => { pending = null; if (win && !win.isDestroyed()) win.webContents.send('link:changed', true); updateTray(); }, 300);
  });
  service.prevFound = 0;
  return service;
}
function updateTray() {
  if (!tray || !service) return;
  const s = service.status();
  tray.setToolTip(s.state === 'running' ? `${NAME} · ${s.counts.phones} phone${s.counts.phones === 1 ? '' : 's'} connected${s.counts.onCalls ? ` · ${s.counts.onCalls} on calls` : ''}` : `${NAME} · ${s.state === 'waiting-licence' ? 'waiting for Link Plus' : 'not running'}`);
  if (s.found.length > service.prevFound && Notification.isSupported()) new Notification({ title: NAME, body: 'New phone found. Open Riyeser Link Office to say who it\'s for.' }).show();
  service.prevFound = s.found.length;
}

async function checkPc() {
  const w = require('./link/windows');
  try { sleepNote = w.sleepWarning(await w.readSleep()); } catch { sleepNote = null; }
  try { firewall = await w.firewallRuleExists(); } catch { firewall = null; }
}

// ---------- what the window can ask for ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => { try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message } } });
}
function registerIpc() {
  handle('link:status', () => ({ ...service.status(), version: app.getVersion(), sleepNote, firewall, signedIn: !!service.online.session, startWithWindows: startsWithWindows(),
    adapters: service.adapters() }));
  handle('link:assign', (mac, ext, vendor) => service.assign(mac, ext, vendor));
  handle('link:unassign', (mac) => service.unassign(mac));
  handle('link:ignore', (mac) => service.ignore(mac));
  handle('link:addPerson', (name, ext) => service.addPerson({ name, ext }));
  handle('link:removePerson', (id) => service.removePerson(id));
  handle('link:manual', (ext) => service.manual(ext));
  handle('link:resetPassword', async (ext) => {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Make a new password', 'Cancel'], defaultId: 1, cancelId: 1, title: NAME,
      message: `Make a new password for extension ${ext}?`, detail: 'Phones using the old one stop working until they get the new one. Desk phones set up by Riyeser Link Office get it when they restart.' });
    return r.response === 0 ? service.resetPassword(ext) : null;
  });
  handle('link:dnd', (ext, on) => service.setDnd(ext, on));
  handle('link:copy', (text) => { clipboard.writeText(String(text || '')); return true; });
  handle('link:sync', () => service.sync());
  handle('link:signIn', async (email, password) => { await service.online.signIn(String(email || '').trim(), String(password || '')); return service.sync(); });
  handle('link:signOut', () => { service.online.signOut(); return true; });
  handle('link:openTeam', () => shell.openExternal(TEAM_URL).then(() => true));
  handle('link:recheck', async () => { await checkPc(); await service.sync().catch(() => null); return service.checkLicence(); });
  handle('link:firewall', async () => { firewall = await require('./link/windows').addFirewallRule(process.execPath, service.status().httpPort); return firewall; });
  handle('link:adapter', (name) => service.chooseAdapter(name));
  handle('link:dismissIp', () => service.dismissIpNotice());
  handle('link:startWithWindows', (on) => { startWithWindows(!!on); return startsWithWindows(); });
  handle('link:allowPublic', async (on) => { service.setSettings({ allowPublic: !!on }); if (service.pbx) { await service.stopPbx(); await service.checkLicence(); } return !!on; });
  handle('link:export', async () => {
    const { exportSettings } = require('./link/portable');
    const r = await dialog.showSaveDialog(win, { title: 'Export Riyeser Link Office settings', defaultPath: path.join(app.getPath('documents'), `Riyeser Link Office settings ${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Riyeser Link Office settings', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(exportSettings({ directory: service.directory, store }), null, 2));
    return r.filePath;
  });
  handle('link:import', async () => {
    const { importSettings } = require('./link/portable');
    const r = await dialog.showOpenDialog(win, { title: 'Import Riyeser Link Office settings', properties: ['openFile'], filters: [{ name: 'Riyeser Link Office settings', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const out = importSettings({ directory: service.directory, store, data: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) });
    service.emit('change');
    return out;
  });
  handle('link:openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')).then(() => true));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (blocker != null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); if (service) service.stop(); });
app.on('window-all-closed', () => { /* stays in the tray */ });

app.whenReady().then(async () => {
  if (selfTestArg) {
    // The Windows build check: SIP and phone set-up on spare ports on this PC only, with throwaway data.
    const { selfTest } = require('./link/selftest');
    const r = await selfTest();
    const firstRun = (() => { try { const { Store } = require('./core/store'); const s = new Store(path.join(app.getPath('userData'), 'data')); if (!s.get('setup', null)) { startWithWindows(true); s.set('setup', { startWithWindows: true, at: new Date().toISOString() }); } return true; } catch { return false; } })();
    fs.writeFileSync(selfTestArg.slice('--self-test='.length), JSON.stringify({ ok: r.sip && r.provisioning && firstRun, name: NAME, version: app.getVersion(), sip: r.sip, provisioning: r.provisioning, loginItem: startsWithWindows(), error: r.error || null }));
    app.exit(0);
    return;
  }
  makeService();
  // First run: start with Windows (it can be switched off from the tray icon or the screen).
  if (!store.get('setup', null)) { startWithWindows(true); store.set('setup', { startWithWindows: true, at: new Date().toISOString() }); }
  blocker = powerSaveBlocker.start('prevent-app-suspension');   // keep the PC awake while the phones need it (no settings are changed)
  registerIpc();
  createWindow();
  createTray();
  await service.start();
  checkPc().then(() => { if (win && !win.isDestroyed()) win.webContents.send('link:changed', true); });
  setTimeout(() => service.sync().catch(() => null), 3000);
  setInterval(() => service.sync().catch(() => null), 30 * 60 * 1000);
  setInterval(() => { service.checkLicence().catch(() => null); service.checkNetwork().catch(() => null); }, 60 * 1000);
  setInterval(() => checkPc(), 30 * 60 * 1000);
});
