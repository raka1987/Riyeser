// Riyeser Link Office for Windows: the office phone system, on one PC.
// It registers the office's desk phones (and, next, the Riyeser Link app) and connects calls between them on the
// office network. It sits by the clock, starts with Windows and keeps the PC awake while it runs; closing the window
// keeps it running (Quit from the tray icon). Internal calls only: no outside numbers and no emergency calls.
// It works only while Riyeser Link is on (trial or paid); everything is kept on this PC, so it runs with no internet.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, powerSaveBlocker, powerMonitor, safeStorage, net, Notification, dialog, clipboard } = require('electron');
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
const quitArg = require('./core/quit-arg');
if (!selfTestArg && !app.requestSingleInstanceLock()) app.quit();
else if (!selfTestArg && quitArg.wantsQuit(process.argv)) app.exit(0);   // asked to quit, and no copy was running

let win = null; let tray = null; let quitting = false; let toldAboutTray = false; let service = null; let store = null;
let sleepNote = null; let firewall = null; let blocker = null; let cloud = null; let backups = null;
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
    ...backups.menuItems(),   // OWNER-BACKUP
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
  // mdns: answer riyeser-office.local on the office network; netConfig: routers and DNS suffixes from Windows (read only)
  service = new PhoneService({ store, appData, clients: () => [own, central], seal, unseal, log: logLine, mdns: {}, hostname: os.hostname(),
    netConfig: process.platform === 'win32' ? () => require('./link/windows').readNetConfig() : null });
  service.online = own;
  // The Phones page on riyeser.com/link: a heartbeat every 5 minutes, and changes from the website every 30 seconds.
  const { LinkCloud } = require('./link/cloud');
  cloud = new LinkCloud({ service, clients: () => [own, central], appData, version: app.getVersion(), pcName: os.hostname() });
  cloud.on('change', () => service.emit('change'));
  let pending = null;
  service.on('change', () => {   // tell the window, at most every 300 ms
    if (pending) return;
    pending = setTimeout(() => { pending = null; if (win && !win.isDestroyed()) win.webContents.send('link:changed', true); updateTray(); }, 300);
  });
  service.prevFound = 0;
  // the router gave this PC a new address: the phones have been moved to it; say so by the clock too
  service.on('address-changed', (c) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: NAME, body: `Your PC's address changed from ${c.from} to ${shortTo(c.from, c.to)} — phones updated.${c.unstable ? ' This keeps happening: reserve this PC\'s address in your router (Settings → This PC\'s address).' : ''}`, silent: true }).show();
  });
  return service;
}
/** "192.168.1.20" -> "192.168.1.35" shows as ".35" when only the last part changed. */
function shortTo(from, to) { const a = String(from).split('.'); const b = String(to).split('.'); return a.length === 4 && b.length === 4 && a.slice(0, 3).join('.') === b.slice(0, 3).join('.') ? `.${b[3]}` : to; }
function updateTray() {
  if (!tray || !service) return;
  const s = service.status();
  tray.setToolTip(s.state === 'running' ? `${NAME} · ${s.counts.phones} phone${s.counts.phones === 1 ? '' : 's'} connected${s.counts.onCalls ? ` · ${s.counts.onCalls} on calls` : ''}` : `${NAME} · ${s.state === 'waiting-licence' ? 'waiting for Riyeser Link' : 'not running'}`);
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
    adapters: service.adapters(), cloud: cloud ? cloud.state : null, platform: process.platform }));
  handle('link:assign', (mac, ext, vendor) => service.assign(mac, ext, vendor));
  handle('link:unassign', (mac) => service.unassign(mac));
  handle('link:label', (mac, fields) => service.label(mac, fields || {}));
  handle('link:replace', (oldMac, newMac, vendor) => service.replacePhone(oldMac, newMac, vendor));
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
  handle('link:signIn', async (email, password) => {
    const si = await service.online.signIn(String(email || '').trim(), String(password || ''));
    // S11: two-step sign-in needs its code; Riyeser Central asks for it, and this PC's plan follows from there
    if (si && si.needsCode) throw new Error('This account uses two-step sign-in. Sign in in Riyeser Central (Company page), which asks for your code, then open Riyeser Link Office again.');
    const r = await service.sync(); if (cloud) cloud.report('signed in').catch(() => null); return r; });
  handle('link:signOut', () => { service.online.signOut(); return true; });
  handle('link:openTeam', () => shell.openExternal(TEAM_URL).then(() => true));
  handle('link:openPhonesPage', () => shell.openExternal(`${TEAM_URL}?phones`).then(() => true));
  handle('link:report', () => (cloud ? cloud.report('button').then((r) => (cloud.poll().catch(() => 0), r)) : null));
  handle('link:recheck', async () => { await checkPc(); await service.sync().catch(() => null); return service.checkLicence(); });
  handle('link:firewall', async () => { firewall = await require('./link/windows').addFirewallRule(process.execPath, service.status().httpPort); return firewall; });
  handle('link:adapter', (name) => service.chooseAdapter(name));
  handle('link:phoneAddress', (mode) => service.setPhoneAddress(mode));
  handle('link:recheckAddress', async () => { await service.refreshNet(); await service.checkNetwork('check'); await service.refreshNames(); return service.names(); });
  // the router's own page (http://<router>/), only for a private address, for "Reserve this PC's address"
  handle('link:openRouter', (ip) => { if (!require('./link/netinfo').isPrivate(ip) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) throw new Error('That isn\'t a router on the office network.'); return shell.openExternal(`http://${ip}/`).then(() => true); });
  // "Use a fixed address" (optional): only when the owner chooses it, with Windows' permission prompt, a clear warning,
  // a check that the router can still be reached (else it goes back to automatic by itself), and an undo
  handle('link:fixedAddress', async (wanted) => {
    const w = require('./link/windows'); const { inCidr, isPrivate } = require('./link/netinfo');
    await service.refreshNet();
    const info = service.adapterInfo();
    if (!info || !info.gateway) throw new Error('Windows didn\'t say how this network adapter is set up, so Riyeser Link Office won\'t change it. Reserve the address in your router instead.');
    if (!info.dhcp) throw new Error('This adapter already has a fixed address.');
    const address = String(wanted || info.address).trim();
    if (!isPrivate(address) || !inCidr(address, `${info.address}/${info.prefix}`) || address === info.gateway) throw new Error(`Choose an address on this network (${info.address}/${info.prefix}), not the router's.`);
    const r0 = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Use a fixed address', 'Cancel'], defaultId: 1, cancelId: 1, title: NAME,
      message: `Give this PC the fixed address ${address} on "${info.alias}"?`,
      detail: 'A DHCP reservation in your router is better, and is what we recommend. A fixed address is set on this PC only, so the router doesn\'t know about it: if the router later gives the same address to another device, both stop working properly. Only do this if your router can\'t reserve addresses, and preferably with an address outside the range your router hands out.\n\nWindows asks for permission. If this PC can\'t reach the router afterwards, it goes back to automatic by itself within about 20 seconds. You can undo it any time under Settings → This PC\'s address.' });
    if (r0.response !== 0) return null;
    const r = await w.runElevatedScript((res) => w.fixedAddressScript({ alias: info.alias, address, prefix: info.prefix, gateway: info.gateway, dns: info.dns }, res));
    if (r.ok) { service.setSettings({ fixedAddress: { alias: info.alias, address, prefix: info.prefix, gateway: info.gateway, at: new Date().toISOString(), was: 'dhcp' } }); service.log('info', `This PC now has the fixed address ${address} on ${info.alias} (was automatic, from the router). Undo under Settings.`); }
    else service.log('warn', `The fixed address wasn't set: ${r.why === 'in-use' ? `another device already uses ${address}` : r.why === 'no-router' ? 'the router couldn\'t be reached with it, so it went back to automatic' : 'Windows\' permission wasn\'t given'}.`);
    await service.refreshNet(); await service.checkNetwork('fixed address');
    return r;
  });
  handle('link:undoFixed', async () => {
    const w = require('./link/windows'); const f = service.settings().fixedAddress;
    if (!f) return null;
    const r = await w.runElevatedScript((res) => w.dhcpScript(f.alias, res));
    if (r.ok) { service.setSettings({ fixedAddress: null }); service.log('info', `${f.alias} is back on automatic (the router gives this PC its address).`); }
    await service.refreshNet(); await service.checkNetwork('fixed address');
    return r;
  });
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
  handle('backup:now', async () => (await backups.backUpNow({ quiet: true })).file);   // OWNER-BACKUP
  handle('backup:restore', () => backups.restoreFromBackup());
  handle('backup:folder', () => backups.openFolder().then(() => true));
  handle('link:openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')).then(() => true));
}

// A second copy: brings this one forward, or with --quit (Riyeser Central's "Close them for me") quits this one properly.
app.on('second-instance', (_e, argv) => quitArg.onSecondInstance(argv, { quit: () => { quitting = true; app.quit(); }, show: () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } } }));
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (blocker != null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); if (cloud) cloud.stop(); if (service) service.stop(); });
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
  // OWNER-BACKUP: Documents\Riyeser\Link Office\Backups; a restore asked for before the restart is done before the data opens
  backups = require('./core/backup-ui').backupUi({ app, dialog, shell, name: NAME, win: () => win, beforeRestart: () => { quitting = true; if (service) service.stop(); },
    spec: require('./core/backup-specs').programSpec('linkoffice', { appData: app.getPath('appData') }) });
  await backups.applyPending().catch(() => null);
  const freshPc = !fs.existsSync(path.join(app.getPath('userData'), 'data', 'setup.json'));
  makeService();
  // First run: start with Windows (it can be switched off from the tray icon or the screen).
  if (!store.get('setup', null)) { startWithWindows(true); store.set('setup', { startWithWindows: true, at: new Date().toISOString() }); }
  blocker = powerSaveBlocker.start('prevent-app-suspension');   // keep the PC awake while the phones need it (no settings are changed)
  registerIpc();
  createWindow();
  createTray();
  await service.start();
  service.watch();   // address changes: checked every few seconds, and at once on Windows' own network-change events
  powerMonitor.on('resume', () => { if (service.watcher) service.watcher.check('resume'); service.checkNetwork('resume').catch(() => null); });
  checkPc().then(() => { if (win && !win.isDestroyed()) win.webContents.send('link:changed', true); });
  setTimeout(() => service.sync().catch(() => null), 3000);
  cloud.start();   // with no internet it just waits; the phones never depend on it
  setInterval(() => service.sync().catch(() => null), 30 * 60 * 1000);
  setInterval(() => { service.checkLicence().catch(() => null); service.checkNetwork().catch(() => null); }, 60 * 1000);
  setInterval(() => checkPc(), 30 * 60 * 1000);
  backups.startDaily();
  if (backups.pendingResult) setTimeout(() => backups.showPendingResult(), 1500);
  else if (freshPc && !startHidden) setTimeout(() => backups.firstRunOffer().catch(() => {}), 1500);   // a new PC: start fresh or restore
});
