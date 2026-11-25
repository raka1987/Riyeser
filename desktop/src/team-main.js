// Riyeser Link for Windows (formerly Riyeser Team): the chat and calls (riyeser.com/link) as its own desktop app.
// It sits by the clock and starts with Windows, so messages and calls reach people even when no other Riyeser
// program is open. Closing the window keeps it running (Quit from the tray icon closes it). The unread count shows
// on the taskbar icon, and an incoming call brings the window forward.
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, Notification } = require('electron');
const path = require('path');

const SITE = 'https://riyeser.com';
const TEAM = `${SITE}/link/`;
const NAME = 'Riyeser Link';
const ours = (url) => { try { return new URL(url).origin === SITE; } catch { return false; } };
// riyeser.com/link/ is the app; riyeser.com/team/ (its old address) still is too, so both stay in this window.
const inApp = (url) => { try { const u = new URL(url); return u.origin === SITE && (u.pathname.startsWith('/link/') || u.pathname.startsWith('/team/')); } catch { return false; } };
// The unread count from the page title: "(3) Riyeser Link", or "(3) Riyeser Team" from the page before the rename.
const unreadFrom = (title) => Number((/^\((\d+)\)\s*Riyeser (?:Link|Team)\b/.exec(title || '') || [])[1] || 0);

app.setName(NAME);
// Everything stays where it was when the app was called Riyeser Team: the sign-in and chats (persist:riyeser-team)
// and settings live in %APPDATA%\Riyeser Team, and Windows knows the app by com.riyeser.team.
{ const keep = path.join(app.getPath('appData'), 'Riyeser Team'); app.setPath('userData', keep); app.setPath('sessionData', keep); }
if (process.platform === 'win32') app.setAppUserModelId('com.riyeser.team');
const quitArg = require('./core/quit-arg');
if (!app.requestSingleInstanceLock()) app.quit();
else if (quitArg.wantsQuit(process.argv)) app.exit(0);   // asked to quit, and no copy was running: nothing to do

let win = null; let tray = null; let quitting = false; let toldAboutTray = false; let lastUnread = 0;
const startHidden = process.argv.includes('--hidden');
const icon = (file) => path.join(__dirname, 'renderer', file);

// A small red dot with the unread number, for the taskbar icon.
function badge(n) {
  if (!n) return null;
  const text = n > 99 ? '99+' : String(n);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e11d48"/>
    <text x="16" y="21" font-family="Segoe UI,Arial" font-size="${text.length > 2 ? 11 : 15}" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function offlinePage() {
  const html = `<!doctype html><meta charset="utf-8"><title>${NAME}</title><body style="font-family:Segoe UI,Arial,sans-serif;background:#f4f6fa;display:grid;place-items:center;height:100vh;margin:0;color:#0f1d3d">
    <div style="background:#fff;border:1px solid #e3e8f1;border-radius:16px;padding:28px;max-width:380px;text-align:center">
    <h2 style="margin:0 0 8px">Can't reach ${NAME}</h2><p style="color:#64708a;line-height:1.5">${NAME} needs the internet. Check your connection, then try again.
    It keeps trying by itself every 30 seconds.</p><button onclick="location.href='${TEAM}'" style="background:#a21caf;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-weight:700">Try again</button></div>
    <script>setTimeout(()=>location.href='${TEAM}',30000)</script></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1150, height: 780, minWidth: 380, minHeight: 500, title: NAME, show: !startHidden,
    icon: icon(process.platform === 'win32' ? 'icon-team.ico' : 'icon-team.png'),
    webPreferences: { partition: 'persist:riyeser-team', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  win.loadURL(TEAM);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!inApp(url) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => { if (isMain && code !== -3 && inApp(url)) win.loadURL(offlinePage()); });
  win.webContents.on('page-title-updated', (_e, title) => {
    const n = unreadFrom(title);
    if (n !== lastUnread) { lastUnread = n; if (process.platform === 'win32') win.setOverlayIcon(badge(n), n ? `${n} unread` : ''); if (tray) tray.setToolTip(n ? `${NAME} · ${n} unread` : NAME); }
    if (/^📞/.test(title)) {   // an incoming call: bring Riyeser Link forward
      if (win.isMinimized()) win.restore();
      win.show(); win.focus(); win.flashFrame(true);
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: NAME, body: 'Still running by the clock, so calls and messages reach you. Quit from the tray icon.', silent: true }).show();
    }
  });
}

// Windows matches the start-up entry by its arguments, so read it back with the same ones.
const LOGIN = { args: ['--hidden'] };
function startWithWindows(on) {
  app.setLoginItemSettings({ openAtLogin: on, ...LOGIN });
}
const startsWithWindows = () => app.getLoginItemSettings(LOGIN).openAtLogin;

function createTray() {
  tray = new Tray(icon('icon-team.png'));
  tray.setToolTip(NAME);
  const menu = () => Menu.buildFromTemplate([
    { label: `Open ${NAME}`, click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(),
      click: (item) => { startWithWindows(item.checked); tray.setContextMenu(menu()); } },
    { type: 'separator' },
    { label: `Quit ${NAME}`, click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { if (win.isVisible() && win.isFocused()) win.hide(); else { win.show(); win.focus(); } });
}

// A second copy: brings this one forward, or with --quit (Riyeser Central's "Close them for me") quits this one properly.
app.on('second-instance', (_e, argv) => quitArg.onSecondInstance(argv, { quit: () => { quitting = true; app.quit(); }, show: () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } } }));
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(() => {
  // Microphone, camera and notifications: only for riyeser.com.
  const ses = session.fromPartition('persist:riyeser-team');
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(perm) && ours(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((_wc, perm, origin) => ['media', 'notifications', 'clipboard-sanitized-write'].includes(perm) && ours(origin));
  // First run: start with Windows (it can be switched off from the tray icon).
  const { Store } = require('./core/store');
  const store = new Store(path.join(app.getPath('userData'), 'data'));
  if (!store.get('setup', null)) { startWithWindows(true); store.set('setup', { startWithWindows: true, at: new Date().toISOString() }); }
  createWindow();
  createTray();
  // Self-test for the Windows build check: write that it started, then quit.
  const selfTest = process.argv.find((a) => a.startsWith('--self-test='));
  if (selfTest) {
    require('fs').writeFileSync(selfTest.slice('--self-test='.length), JSON.stringify({ ok: true, name: NAME, version: app.getVersion(), loginItem: startsWithWindows(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), url: TEAM }));
    quitting = true; setTimeout(() => app.quit(), 500);
  }
});
app.on('window-all-closed', () => { /* stays in the tray */ });
