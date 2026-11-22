// Riyeser Services for Windows: the Riyeser Services app (riyeser.com/app/) in its own window, with its own
// Start menu and desktop icon. Projects are kept online with the user's Riyeser Services account as before;
// the app's offline mode keeps working when the internet drops.
const { app, BrowserWindow, shell, session, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const HOME = process.env.RIYESER_SERVICES_URL || 'https://riyeser.com/app/';
const ORIGIN = new URL(HOME).origin;
// Pages that belong in this window: the app itself and its client share page. Everything else opens in the browser.
const inApp = (url) => {
  try { const u = new URL(url); return u.origin === ORIGIN && (u.pathname.startsWith('/app/') || u.pathname === '/app' || u.pathname === '/share.html'); } catch { return false; }
};

app.setName('Riyeser Services');
app.setPath('userData', path.join(app.getPath('appData'), 'Riyeser Services'));
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };

function offlinePage(reason) {
  const html = `<!doctype html><meta charset="utf-8"><title>Riyeser Services</title><style>body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:#172326;color:#e8f0f0;display:grid;place-items:center;height:100vh;margin:0}div{max-width:420px;text-align:center}a.b{display:inline-block;margin-top:14px;padding:9px 18px;border-radius:8px;background:#e8a33d;color:#172326;font-weight:600;text-decoration:none}small{opacity:.6}</style><div><h2>Can't reach Riyeser Services</h2><p>Check your internet connection, then try again. Once you've opened your projects here online, they also open without internet.</p><a class="b" href="${HOME}">Try again</a><p><small>${String(reason || '').replace(/[<>&]/g, '')}</small></p></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  const s = readState();
  win = new BrowserWindow({
    width: s.width || 1360, height: s.height || 880, x: s.x, y: s.y, minWidth: 380, minHeight: 500,
    title: 'Riyeser Services', backgroundColor: '#172326', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-services.ico' : 'icon-services.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const save = () => { if (!win || win.isDestroyed()) return; try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ } };
  win.on('close', save);

  // Links to anything outside the app (the website, email, maps, documents) open in the normal browser / mail program.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: win.getIcon?.() } };
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (inApp(url) || url.startsWith('data:')) return;
    e.preventDefault();
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !String(url).startsWith('data:')) win.loadURL(offlinePage(desc));
  });
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('Riyeser Services'); });
  win.loadURL(HOME);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  // Camera (site photos), clipboard and full screen for the app; nothing else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    let ok = false; try { ok = new URL(details.requestingUrl || wc.getURL()).origin === ORIGIN; } catch { ok = false; }
    cb(ok && ['media', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'].includes(permission));
  });
  session.defaultSession.on('will-download', (e, item) => {
    item.once('done', (ev, state) => { if (state === 'completed') shell.showItemInFolder(item.getSavePath()); });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Riyeser Services', submenu: [
      { label: 'Home', accelerator: 'Alt+Home', click: () => win && win.loadURL(HOME) },
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, { type: 'separator' },
      { label: 'About', click: () => dialog.showMessageBox(win, { title: 'Riyeser Services', message: `Riyeser Services ${app.getVersion()}`, detail: 'Riyeser Group · riyeser.com\nYour projects are kept with your Riyeser Services account.' }) },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
  ]));
  if (process.argv.some((a) => a.startsWith('--self-test='))) {
    // CI: start, report, quit (no network needed).
    const out = process.argv.find((a) => a.startsWith('--self-test=')).slice(12);
    fs.writeFileSync(out, JSON.stringify({ name: app.getName(), version: app.getVersion(), home: HOME, userData: app.getPath('userData') }));
    app.quit(); return;
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());
