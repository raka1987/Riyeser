// Windows runner check: install every program from the latest Riyeser release the way Riyeser Central does, and see
// whether Windows lists it afterwards (installedFromRegistry, the same reading Central does).
//   node scripts/central-install-check.js --mode=new --out=report.json [--only=linkoffice,pos] [--dir=<downloads>]
//   --mode=old: start each installer like Central 1.8.10 did (spawn, no permission prompt, no retry)
//   --mode=new: Central's install-run.js (Link Office through the Windows permission prompt; retry when needed)
//   --dir: reuse installers already downloaded there (by release file name)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const updates = require('../src/central/updates');
const run = require('../src/central/install-run');
const check = require('../src/central/installer-check');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const mode = arg('mode', 'new');
const only = arg('only') ? arg('only').split(',') : null;
const outFile = arg('out', path.join(os.tmpdir(), `central-install-${mode}.json`));
const waitS = Number(arg('wait', '10'));   // how long to keep looking for the program after the installer returns
const dir = arg('dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-install-check-'));

const gh = (url, accept = 'application/vnd.github+json') => fetch(url, { headers: { 'User-Agent': 'Riyeser-Central-check', Accept: accept,
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });

function registry() {
  const q = (key) => { try { return execFileSync('reg', ['query', key, '/s', '/reg:64'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
  const user = q('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  const machine = q('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  const wow = q('HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  return { user: updates.installedFromRegistry(user), machine: updates.installedFromRegistry(machine), wow: updates.installedFromRegistry(wow),
    central: { ...updates.installedFromRegistry(machine), ...updates.installedFromRegistry(user) } };
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Riyeser-Central-check' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  // the same lookup Central makes: the downloads repository, the old code repository while that has no release yet
  const release = await updates.findRelease('stable', (url) => gh(url));
  if (!release) throw new Error('No release with installers in either repository');
  console.log(`Release from ${release.html_url || release.url || '?'}`);
  const vj = (release.assets || []).find((a) => a.name === 'versions.json');
  const versionsJson = vj ? await (await fetch(vj.browser_download_url)).json() : null;
  const latest = updates.latestFromRelease(release, versionsJson);
  const report = { mode, tag: latest.tag, user: os.userInfo().username, admin: null, results: [] };
  try { execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true }); report.admin = true; } catch { report.admin = false; }
  console.log(`Release ${latest.tag}; mode ${mode}; user ${report.user}; elevated ${report.admin}`);
  const before = registry();
  for (const p of updates.PRODUCTS) {
    if (p.self || (only && !only.includes(p.id))) continue;
    const item = latest.products[p.id];
    const row = { id: p.id, display: p.display, elevate: !!p.elevate, before: before.central[p.id] ?? null };
    report.results.push(row);
    if (!item) { row.error = 'not in the release'; console.log(`${p.id}: not in the release`); continue; }
    Object.assign(row, { asset: item.name, version: item.version });
    const file = path.join(dir, item.name);
    try {
      if (!fs.existsSync(file)) await download(item.url, file);
      const c = await check.checkInstaller({ file, name: item.name, manifest: null, digest: item.digest, publicKey: '' });
      row.check = c.how; if (!c.ok) { row.error = c.error; continue; }
      const r = await run.runInstaller({ file, args: p.args, elevate: mode === 'new' && !!p.elevate, retryElevated: mode === 'new', spawn, timeoutMs: 10 * 60 * 1000 });
      Object.assign(row, { code: r.code, startError: r.startError, elevated: r.elevated, retried: !!r.retried, firstError: r.firstError ?? null, ms: r.ms, detail: r.detail || null,
        output: (r.output || '').trim().slice(-400) || null });
      row.failure = run.installFailure(r, { name: p.display, args: p.args });
      // Give the installer's last registry writes a moment, then read Windows' installed-apps list like Central.
      let reg = registry();
      const t0 = Date.now(); row.trace = [];
      const snap = () => {
        let procs = '';
        try { procs = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter((l) => /riyeser|setup|un_|nsis|au_/i.test(l)).map((l) => l.split('","')[0].replace(/^"/, '')).join(' '); } catch { /* none */ }
        const pf = ['ProgramW6432', 'ProgramFiles', 'LOCALAPPDATA'].map((k) => process.env[k]).filter(Boolean)
          .flatMap((root) => fs.existsSync(root) ? fs.readdirSync(root === process.env.LOCALAPPDATA ? path.join(root, 'Programs') : root).filter((d) => /riyeser/i.test(d)).map((d) => d) : []);
        row.trace.push({ s: Math.round((Date.now() - t0) / 1000), listed: p.id in reg.central, procs, folders: [...new Set(pf)].join('|') });
      };
      snap();
      for (let i = 0; Date.now() - t0 < waitS * 1000 && !(p.id in reg.central) && row.failure.ok; i++) { await new Promise((ok) => setTimeout(ok, 1000)); reg = registry(); if (i % 5 === 4) snap(); }
      snap();
      if (waitS > 10) for (const t of row.trace) console.log(`  ${p.id} +${t.s}s listed=${t.listed} processes=[${t.procs}] folders=[${t.folders}]`);
      row.after = reg.central[p.id] ?? null;
      row.where = p.id in reg.user ? 'HKCU' : p.id in reg.machine ? 'HKLM' : p.id in reg.wow ? 'HKLM-WOW6432Node' : null;
      row.detected = p.id in reg.central;
    } catch (e) { row.error = e.message; }
    console.log(`${p.id}: ${row.failure ? row.failure.reason : 'error'} code=${row.code ?? '-'} startError=${row.startError ?? '-'} elevated=${row.elevated ?? '-'} detected=${row.detected ?? '-'} (${row.where || 'not listed'}) ${row.error || ''}`);
  }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`Report: ${outFile}`);
})().catch((e) => { console.error(e); process.exit(1); });
