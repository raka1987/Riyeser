#!/usr/bin/env node
// Windows check: "Update all" in an INSTALLED Riyeser Central, pressed the way a person presses it.
//
// Starts the installed Central with Chromium's remote debugging port, waits for Admin → Updates to show its banner,
// clicks its "Update all" button (#updall) in the real window and follows what the window says (the banner's text,
// the toasts, page errors) until Central restarts for its own update, the banner finishes, or time runs out.
// Writes <out>/update-all.json (every change of the banner's text, with times) and screenshots of each change.
//
//   node scripts/central-update-all-check.js --exe="C:\...\Riyeser Central.exe" --out=C:\riy\out\upd [--minutes=25]
//
// Plain Node 22 (fetch and WebSocket built in): nothing to install on the runner.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const exe = arg('exe'); const out = arg('out', path.join(process.cwd(), 'update-all'));
const minutes = Number(arg('minutes', '25')); const port = Number(arg('port', '9339'));
if (!exe) { console.error('--exe is required'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now(); const secs = () => Math.round((Date.now() - t0) / 1000);
const report = { exe, started: new Date().toISOString(), timeline: [], console: [], errors: [], result: null };
const save = () => fs.writeFileSync(path.join(out, 'update-all.json'), JSON.stringify(report, null, 2));
const note = (what, extra = {}) => { const e = { s: secs(), what, ...extra }; report.timeline.push(e); console.log(`[${e.s}s] ${what}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`); save(); };

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && /central\.html/i.test(t.url));
      if (p) return p;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return null;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); }
    else listeners.forEach((f) => f(msg));
  };
  let closed = false; ws.onclose = () => { closed = true; for (const w of waiting.values()) w.reject(new Error('closed')); waiting.clear(); };
  const ready = new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  return {
    ready, closed: () => closed, on: (f) => listeners.push(f),
    send: (method, params = {}) => new Promise((resolve, reject) => { if (closed) { reject(new Error('closed')); return; } const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }),
  };
}

(async () => {
  note('starting Central', { exe });
  // --attach: Central was started already (e.g. with the standard-user token through runas) with the same port
  if (!process.argv.includes('--attach')) spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
  const target = await pageTarget();
  if (!target) { report.result = { ok: false, why: 'Central\'s window never appeared on the debugging port' }; save(); process.exit(1); }
  const c = cdp(target.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable'); await c.send('Page.enable');
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') report.console.push({ s: secs(), type: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
    if (m.method === 'Runtime.exceptionThrown') report.errors.push({ s: secs(), text: String(m.params.exceptionDetails && (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text)).slice(0, 800) });
  });
  const ev = async (expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : undefined; };
  let shot = 0;
  const screenshot = async (name) => { try { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `${String(++shot).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); } catch { /* closed */ } };
  // Admin → Updates shows the banner once Central's own check has run (a few seconds after start)
  let ready = null;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(2000);
    ready = await ev(`(() => { const b = document.querySelector('#updall'); return b ? { button: b.textContent, banner: document.querySelector('#updates').innerText } : null; })()`).catch(() => null);
    if (!ready && i === 15) await ev('typeof checkForUpdates === "function" ? checkForUpdates(true).then(() => true) : false').catch(() => null);
  }
  if (!ready) {
    const upd = await ev('JSON.stringify(typeof upd !== "undefined" ? upd : null)').catch(() => null);
    report.result = { ok: false, why: 'No "Update all" button: Central found no updates', upd }; await screenshot('no-updates'); save(); process.exit(1);
  }
  note('updates offered', ready);
  // open Admin → Updates where the panel exists, so the screenshots show what the person sees
  await ev(`(() => { try { if (typeof openAdmin === 'function') openAdmin('updates'); } catch {} return true; })()`).catch(() => null);
  await screenshot('before');
  await ev(`document.querySelector('#updall').click(), true`);
  note('clicked Update all');
  let last = ''; let sameSince = Date.now(); let restarting = false;
  while (Date.now() - t0 < minutes * 60000) {
    await sleep(1000);
    if (c.closed()) { note('Central closed its window (restarting for its own update)'); restarting = true; break; }
    const s = await ev(`(() => ({ banner: (document.querySelector('#updates') || {}).innerText || '', toast: ((document.querySelector('#toast') || {}).textContent || ''),
      updating: typeof updating !== 'undefined' ? updating : null, updError: typeof updError !== 'undefined' ? updError : null }))()`).catch(() => null);
    if (!s) continue;
    // the percentage moves every second while downloading: record a change of step, not every percent
    const key = `${s.banner.replace(/\d+%/, '%')}|${s.toast}|${s.updError}`;
    if (key !== last) { note('window says', s); last = key; sameSince = Date.now(); await screenshot(String(s.banner.split('\n')[0] || 'banner').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)); }
    if (s.updating === false) { note('finished (the window is no longer updating)', s); break; }
    if (Date.now() - sameSince > 6 * 60000) { note('STUCK: the window has said the same for 6 minutes', s); await screenshot('stuck'); break; }
  }
  const final = report.timeline[report.timeline.length - 1];
  report.result = { ok: restarting || /finished/.test(final.what), restarting, last: final };
  save();
  process.exit(0);
})().catch((e) => { report.result = { ok: false, why: e.stack || e.message }; save(); console.error(e); process.exit(1); });
