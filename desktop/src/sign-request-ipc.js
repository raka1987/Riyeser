// Riyeser PDF "Ask someone to sign": the main-process side (IPC channels signreq:*), kept in its own file.
// The window's part is renderer/sign-request.js (loaded by the editor's Sign menu, or by this file when the editor has
// no hook for it yet). Signing in uses the same Riyeser account and code as Riyeser Central and Link Office
// (core/online.js): this app's own sign-in, or Riyeser Central's while its access is current (read only).
// Every few minutes, while someone is signed in and requests are waiting, it checks them and shows a desktop
// notification when someone signs, declines or a request expires.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SignClient, changes, statusOf, keepText } = require('./core/sign-client');

function makeClient({ store, appData, fetchFn }) {
  const { Online } = require('./core/online');
  const { centralOnline } = require('./link/sync');
  const own = new Online({ store, fetchFn, appData, appVersion: '', deviceName: os.hostname() });
  const central = centralOnline({ appData, phoneStore: store, fetchFn });
  return { own, client: new SignClient({ clients: () => [own, central], own }) };
}

/**
 * handle: the app's IPC helper (name, fn) -> {ok, data|error}. electron: { app, BrowserWindow, dialog, Notification, net }.
 * openEditor(file): opens a PDF in a new editor window.
 */
function registerSignRequest({ handle, store, electron, openEditor, fetchFn }) {
  const { app, BrowserWindow, dialog, Notification } = electron;
  const appData = app.getPath('appData');
  const { own, client } = makeClient({ store, appData, fetchFn: fetchFn || ((u, o) => electron.net.fetch(u, o)) });
  const win = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const chosen = () => (store.get('sign-request', {}) || {}).ws || null;

  handle('signreq:status', async () => ({ ...(await client.status()), chosen: chosen() }));
  handle('signreq:signIn', async (email, password) => own.signIn(String(email || '').trim(), String(password || '')));
  handle('signreq:code', async (code) => own.verifyCode(code));
  handle('signreq:signOut', async () => { own.signOut(); return true; });
  handle('signreq:forgot', async (email) => own.recover(email));
  handle('signreq:choose', async (ws) => { store.update('sign-request', {}, (o) => ({ ...(o || {}), ws })); return ws; });
  handle('signreq:settings', () => client.settings());
  handle('signreq:quota', (ws) => client.quota(ws));
  handle('signreq:list', async (ws) => { const l = await client.list(ws); remember(ws, l); return l.map((r) => ({ ...r, _status: statusOf(r), _keep: keepText(r) })); });
  handle('signreq:history', (id) => client.history(id));
  handle('signreq:remind', (id) => client.remind(id));
  handle('signreq:cancel', (id) => client.cancel(id));
  handle('signreq:keep', (id, days) => client.keep(id, Number(days)));
  handle('signreq:deleteFiles', (id) => client.deleteFiles(id));
  // The PDF is read here, from the saved file, so exactly what's on disk is sent (and its SHA-256 recorded).
  handle('signreq:send', async (req) => {
    const file = String(req && req.file || '');
    if (!file || !/\.pdf$/i.test(file) || !fs.existsSync(file)) throw new Error('Save the PDF first, then try again.');
    const bytes = fs.readFileSync(file);
    const out = await client.send({ ...req, bytes, ws: req.ws || chosen() });
    store.update('sign-request', {}, (o) => ({ ...(o || {}), ws: req.ws || chosen(), lastSent: Date.now() }));
    watch();
    return out;
  });
  // Download the signed copy: Save as…, then open it here.
  handle('signreq:download', async (id, title) => {
    const { bytes } = await client.download(id, 'signed');
    const name = `${String(title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'document'} (signed).pdf`;
    const r = await dialog.showSaveDialog(win(), { title: 'Save the signed copy', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    const target = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
    fs.writeFileSync(target, bytes);
    if (openEditor) openEditor(target);
    return target;
  });

  // ---- desktop notifications when something changes (only while there's something to wait for)
  let timer = null;
  function remember(ws, list) { store.update('sign-request', {}, (o) => ({ ...(o || {}), seen: { ws, list: (list || []).map(slim) } })); }
  const slim = (r) => ({ id: r.id, title: r.title, status: r.status, signers: (r.signers || []).map((s) => ({ position: s.position, name: s.name, status: s.status, decline_reason: s.decline_reason })) });
  async function check() {
    const ws = chosen(); const seen = (store.get('sign-request', {}) || {}).seen;
    if (!ws || !seen || seen.ws !== ws) return;
    let list; try { list = await client.list(ws); } catch { return; }
    for (const n of changes(seen.list, list)) {
      if (Notification.isSupported()) {
        const note = new Notification({ title: `Riyeser PDF · ${n.title}`, body: n.text, silent: false });
        note.on('click', () => { const w = win(); if (w) { w.show(); w.webContents.executeJavaScript('window.RiyeserSignRequest && window.RiyeserSignRequest.openStatus()').catch(() => {}); } });
        note.show();
      }
    }
    remember(ws, list);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('signreq:changed', true);
    if (!list.some((r) => r.status === 'sent')) { clearInterval(timer); timer = null; }
  }
  function watch() { if (!timer) { timer = setInterval(() => check().catch(() => {}), 3 * 60 * 1000); if (timer.unref) timer.unref(); } }
  if (((store.get('sign-request', {}) || {}).seen || {}).list) watch();

  // The editor loads renderer/sign-request.js from its Sign menu. If this editor has no such hook yet, load it here.
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('did-finish-load', () => {
      if (!/editor\.html/.test(w.webContents.getURL())) return;
      w.webContents.executeJavaScript("window.__signRequestLoaded || window.__signMenuHook || import('./sign-request.js').then((m) => m.init && m.init({})).catch(() => {})").catch(() => {});
    });
  });
  return { client, check, watch };
}

module.exports = { registerSignRequest, makeClient };
