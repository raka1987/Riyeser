// As Built for Windows.
// The As Built app ships inside this program, so it opens with no internet at all. Two ways to work,
// chosen on first start and changeable from the menu:
//   On this PC              - no account; projects are saved on this computer (works fully offline)
//   With my online account  - sign in; projects sync with phones, the website and the team
// "Sync to my online account" moves the projects made on this PC into the online account (the PC copy is kept).
//
// How: the window shows https://riyeser.com/app/, but every riyeser.com file the app has a copy of is served from
// inside this program; the internet is only used for the online account (Supabase) and things like web fonts.
const { app, BrowserWindow, shell, session, Menu, dialog, net } = require('electron');
const path = require('path');
const fs = require('fs');

const SITE = 'https://riyeser.com';
const START = `${SITE}/app/start.html`;
const APP = `${SITE}/app/`;
// Pages that belong in this window: the app itself and its client share page. Everything else opens in the browser.
const inApp = (url) => {
  try { const u = new URL(url); return u.origin === SITE && (u.pathname.startsWith('/app/') || u.pathname === '/app' || u.pathname === '/share.html'); } catch { return false; }
};

app.setName('As Built');
// Projects stay in the folder from when the app was called Riyeser Services, so nothing is lost after the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Riyeser Services'));
if (!app.requestSingleInstanceLock()) app.quit();

// ---------- the app's files, inside this program ----------
function webRoot() {
  const candidates = [
    process.env.RIYESER_SERVICES_WEB,
    process.resourcesPath && path.join(process.resourcesPath, 'services-web'),
    path.join(__dirname, '..', 'build', 'services-web'),
    path.join(__dirname, '..', '..', 'website', 'public'),
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'app', 'index.html'))) || null;
}
const ROOT = webRoot();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
// The service worker isn't needed here (the files are already on this PC): replace it with one that removes itself.
const NO_SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.registration.unregister()));";

function localFile(url) {
  if (url.origin !== SITE) return null;
  let p = decodeURIComponent(url.pathname);
  if (p === '/app/start.html') return path.join(__dirname, 'renderer', 'services-start.html');
  if (!ROOT) return null;
  if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT + path.sep)) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

function serveLocalCopy(ses) {
  ses.protocol.handle('https', async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.origin === SITE) {
      if (url.pathname === '/sw.js') return new Response(NO_SW, { headers: { 'content-type': 'text/javascript' } });
      const f = localFile(url);
      if (f) return new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

// ---------- the window ----------
let win = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };
const js = (code) => (win ? win.webContents.executeJavaScript(code, true).catch(() => null) : Promise.resolve(null));
const getMode = () => js("(()=>{try{return localStorage.getItem('riyeser.mode')}catch(e){return null}})()");

function createWindow() {
  const s = readState();
  win = new BrowserWindow({
    width: s.width || 1360, height: s.height || 880, x: s.x, y: s.y, minWidth: 380, minHeight: 500,
    title: 'As Built', backgroundColor: '#172326', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'renderer', process.platform === 'win32' ? 'icon-services.ico' : 'icon-services.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', () => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* not important */ } });

  // Links to anything outside the app (the website, email, maps) open in the normal browser / mail program.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (inApp(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (inApp(url)) return;
    e.preventDefault();
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('As Built'); });
  win.loadURL(START);
}

// ---------- menu ----------
async function syncToOnline() {
  const mode = await getMode();
  if (mode !== 'local') {
    await dialog.showMessageBox(win, { type: 'info', title: 'As Built', message: 'You are already using your online account.', detail: 'Your projects sync automatically whenever you have internet.' });
    return;
  }
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Sign in and move my projects', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Sync to my online account',
    message: 'Move the projects on this PC to your online As Built account?',
    detail: 'You\'ll sign in (or ask info@riyeser.com for an account). Your projects and photos are then uploaded and stay in sync with phones, the website and your team.\n\nThe copy on this PC is kept as a backup.',
  });
  if (r.response !== 0) return;
  await js("try{localStorage.setItem('riyeser.mode','online');localStorage.setItem('riyeser.importLocal','1')}catch(e){}");
  win.loadURL(`${APP}?signin`);
}
async function workOnThisPc() {
  const mode = await getMode();
  if (mode === 'local') return;
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Work on this PC', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Work on this PC only',
    message: 'Switch to working on this PC only?',
    detail: 'You\'ll see the projects saved on this PC (not your online ones). Your online account isn\'t changed; you can switch back any time.',
  });
  if (r.response !== 0) return;
  await js("try{localStorage.setItem('riyeser.mode','local')}catch(e){}");
  win.loadURL(APP);
}
async function useOnlineAccount() {
  await js("try{localStorage.setItem('riyeser.mode','online')}catch(e){}");
  win.loadURL(`${APP}?signin`);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'As Built', submenu: [
      { label: 'Home', accelerator: 'Alt+Home', click: () => win && win.loadURL(APP) },
      { type: 'separator' },
      { label: 'Sync to my online account…', click: () => syncToOnline() },
      { label: 'Use my online account', click: () => useOnlineAccount() },
      { label: 'Work on this PC only…', click: () => workOnThisPc() },
      { label: 'How I work…', click: () => win && win.loadURL(`${START}?choose`) },
      { type: 'separator' },
      { role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, { type: 'separator' },
      { label: 'About', click: () => dialog.showMessageBox(win, { title: 'As Built', message: `As Built ${app.getVersion()}`, detail: `Riyeser Group · riyeser.com\nProjects on this PC are kept in:\n${app.getPath('userData')}` }) },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
  ]));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  serveLocalCopy(session.defaultSession);
  // Camera (site photos), clipboard and full screen for the app; nothing else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    let ok = false; try { ok = new URL(details.requestingUrl || wc.getURL()).origin === SITE; } catch { ok = false; }
    cb(ok && ['media', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'].includes(permission));
  });
  session.defaultSession.on('will-download', (e, item) => {
    item.once('done', (ev, state) => { if (state === 'completed') shell.showItemInFolder(item.getSavePath()); });
  });
  if (process.argv.some((a) => a.startsWith('--self-test='))) {
    // CI: report and quit (no network needed).
    const out = process.argv.find((a) => a.startsWith('--self-test=')).slice(12);
    fs.writeFileSync(out, JSON.stringify({ name: app.getName(), version: app.getVersion(), bundled: !!ROOT, appPage: !!localFile(new URL(APP)), start: !!localFile(new URL(START)) }));
    app.quit(); return;
  }
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
