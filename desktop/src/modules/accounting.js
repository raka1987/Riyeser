// Riyeser Accounting as a module of Riyeser Desk Assistant.
// The accounting app (Python, in ../riyeser at the repository root) runs privately on this PC with the Python that ships
// inside the installer, and its screens are shown inside the main window. It uses the same company file as the
// stand-alone Riyeser Accounting app (~/.riyeser/company.db), so both see the same books.
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { app, WebContentsView, BrowserWindow, shell } = require('electron');

const START_TIMEOUT_MS = 60_000;

/** Which Python to run, and where the riyeser package is. */
function runtime() {
  const res = process.resourcesPath || '';
  // Installed app: resources\python\python.exe finds resources\accounting through its ._pth file.
  const bundled = path.join(res, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (app.isPackaged && fs.existsSync(bundled)) return { python: bundled, env: {} };
  // Development: the prepared Windows Python (on Windows), or RIYESER_PYTHON / python3 with the repo on PYTHONPATH.
  const devWin = path.join(__dirname, '..', '..', 'build', 'python-win', 'python.exe');
  if (process.platform === 'win32' && fs.existsSync(devWin)) return { python: devWin, env: {} };
  const repo = path.join(__dirname, '..', '..', '..');
  return { python: process.env.RIYESER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), env: { PYTHONPATH: repo } };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const isUp = (url) => new Promise((resolve) => {
  const req = http.get(`${url}/login`, (res) => { res.resume(); resolve(res.statusCode < 500); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});

function createAccountingModule({ getWindow, log = () => {} }) {
  let child = null; let url = null; let starting = null; let view = null; let lastError = null; let output = '';

  async function start() {
    if (url && child && child.exitCode === null) return url;
    if (starting) return starting;
    starting = (async () => {
      const { python, env } = runtime();
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      output = '';
      log(`starting accounting: ${python}`);
      child = spawn(python, ['-m', 'riyeser.desktop', '--no-window', '--port', String(port)], {
        env: { ...process.env, ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true,
      });
      child.stdout.on('data', (d) => { output = (output + d).slice(-4000); });
      child.stderr.on('data', (d) => { output = (output + d).slice(-4000); });
      const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      child.once('error', (e) => { output += `\n${e.message}`; });
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.killed) break;
        if (await isUp(base)) { url = base; lastError = null; return url; }
        await Promise.race([new Promise((r) => setTimeout(r, 300)), exited]);
      }
      const why = output.trim().split('\n').slice(-3).join(' ') || 'it did not start in time';
      stop();
      throw new Error(`Riyeser Accounting couldn't start: ${why}`);
    })().catch((e) => { lastError = e.message; throw e; }).finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    if (view) { try { getWindow()?.contentView.removeChildView(view); } catch { /* window gone */ } view.webContents.close(); view = null; }
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
    child = null; url = null;
  }

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({ webPreferences: { partition: 'persist:riyeser-accounting', contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const wc = view.webContents;
    // Payslips and "Print / PDF" open in their own window; anything outside the app opens in the browser.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (url && target.startsWith(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 1000, title: 'Riyeser Accounting', autoHideMenuBar: true, webPreferences: { partition: 'persist:riyeser-accounting', contextIsolation: true, sandbox: true } } };
      }
      if (/^https?:/i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, target) => { if (url && !target.startsWith(url)) { e.preventDefault(); if (/^https?:/i.test(target)) shell.openExternal(target); } });
    return view;
  }

  return {
    /** Show the accounting screens in the given area of the main window (CSS pixels from the page). */
    async show(bounds) {
      const base = await start();
      const win = getWindow();
      if (!win) return null;
      const v = ensureView();
      if (!win.contentView.children.includes(v)) win.contentView.addChildView(v);
      v.setBounds(roundBounds(bounds, win));
      if (!v.webContents.getURL().startsWith(base)) await v.webContents.loadURL(base);
      return { url: base };
    },
    setBounds(bounds) { const win = getWindow(); if (view && win && win.contentView.children.includes(view)) view.setBounds(roundBounds(bounds, win)); },
    hide() { const win = getWindow(); if (view && win) { try { win.contentView.removeChildView(view); } catch { /* not shown */ } } },
    back() { if (view && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); },
    reload() { if (view) view.webContents.reload(); },
    home() { if (view && url) view.webContents.loadURL(url); },
    /** The same screens in a window of their own. */
    async popOut() {
      const base = await start();
      const w = new BrowserWindow({ width: 1360, height: 860, minWidth: 1000, minHeight: 650, title: 'Riyeser Accounting', autoHideMenuBar: true,
        webPreferences: { partition: 'persist:riyeser-accounting', contextIsolation: true, sandbox: true } });
      w.loadURL(base);
      return true;
    },
    status: () => ({ running: !!url, starting: !!starting, error: lastError }),
    stop,
  };
}

// The page reports CSS pixels; the window's content may be zoomed.
function roundBounds(b, win) {
  const z = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
  return { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.max(0, Math.round(b.width * z)), height: Math.max(0, Math.round(b.height * z)) };
}

module.exports = { createAccountingModule, runtime };
