// Windows runner check: Riyeser Central's first run ("One installer") end to end, with the real installers from the
// latest release and the same first-run.js and install-run.js Central uses:
//   1. a business's plan installs one program after another; the network "drops" after --offline-after programs, so the
//      rest pause, then carry on when it's back (resume); the whole-PC programs go through ONE elevated batch
//   2. a second PC of the same business, "What is this PC for?" = Till: only the till's programs; what's there is skipped
//   node scripts/central-firstrun-check.js --plan=plus,payroll,pos,calls --offline-after=2 --dir=<downloads> --out=report.json
//   --batch-extra=pdf: also put Riyeser PDF in the elevated batch (two installers, still one permission prompt)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const updates = require('../src/central/updates');
const run = require('../src/central/install-run');
const check = require('../src/central/installer-check');
const fr = require('../src/central/first-run');

const arg = (k, d = null) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const mods = (arg('plan', 'plus,payroll,pos,calls')).split(',').filter(Boolean);
const offlineAfter = Number(arg('offline-after', '2'));
const batchExtra = (arg('batch-extra', '') || '').split(',').filter(Boolean);
const outFile = arg('out', path.join(os.tmpdir(), 'central-firstrun.json'));
const dir = arg('dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-firstrun-check-'));

const gh = (url) => fetch(url, { headers: { 'User-Agent': 'Riyeser-Central-check', Accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
function installed() {
  const q = (key) => { try { return execFileSync('reg', ['query', key, '/s', '/reg:64'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }); } catch (e) { return e.stdout || ''; } };
  return { ...updates.installedFromRegistry(q('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')), ...updates.installedFromRegistry(q('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) };
}
// every Windows permission prompt Central would show = every elevated start (powershell -EncodedCommand ... -Verb RunAs)
const prompts = [];
const countingSpawn = (cmd, args, opts) => {
  if (/powershell/i.test(cmd) && (args || []).includes('-EncodedCommand')) {
    const s = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    if (/-Verb RunAs/.test(s)) prompts.push(s.slice(0, 300));
  }
  return spawn(cmd, args, opts);
};

(async () => {
  const release = await (await gh(updates.RELEASE_API)).json();
  const vj = (release.assets || []).find((a) => a.name === 'versions.json');
  const latest = updates.latestFromRelease(release, vj ? await (await fetch(vj.browser_download_url)).json() : null);
  const lic = { online: { modules: Object.fromEntries(mods.map((m) => [m, { active: true, status: 'trial' }])) } };
  const products = updates.PRODUCTS.map((p) => (batchExtra.includes(p.id) ? { ...p, elevate: true } : p));
  const report = { tag: latest.tag, plan: mods, admin: null, phases: [], prompts: 0, ok: false, problems: [] };
  try { execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true }); report.admin = true; } catch { report.admin = false; }
  let online = true; let fetched = 0; let cutAfter = offlineAfter;
  const driver = {
    isOnline: () => online,
    async fetch(it, onPct, onChecking) {
      if (fetched >= cutAfter) online = false;   // the network "drops" here
      if (!online) throw new Error('net::ERR_INTERNET_DISCONNECTED');
      const item = latest.products[it.id];
      if (!item) throw Object.assign(new Error(`${it.id} isn't in the release`), { failure: { reason: 'not-in-release', message: `${it.name} isn't in the latest release yet.` } });
      const file = path.join(dir, item.name);
      if (!fs.existsSync(file)) { const res = await fetch(item.url, { redirect: 'follow' }); if (!res.ok) throw Object.assign(new Error(`download ${res.status}`), { failure: { reason: 'download', message: `download ${res.status}` } }); fs.writeFileSync(file, Buffer.from(await res.arrayBuffer())); }
      onPct(1); onChecking();
      const c = await check.checkInstaller({ file, name: item.name, manifest: null, digest: item.digest, publicKey: '' });
      if (!c.ok) throw Object.assign(new Error(c.error), { failure: { reason: 'check', message: c.error } });
      fetched++;
      return { file, version: item.version };
    },
    async install(it, got) {
      const p = products.find((x) => x.id === it.id);
      const r = await run.runInstaller({ file: got.file, args: p.args, elevate: false, spawn: countingSpawn, timeoutMs: 10 * 60 * 1000 });
      const f = run.installFailure(r, { name: it.name, args: p.args });
      console.log(`  ${it.id}: code=${r.code} startError=${r.startError} elevated=${r.elevated} ${f.reason}`);
      if (!f.ok) throw Object.assign(new Error(f.message), { failure: f });
    },
    async installBatch(list) {
      const items = list.map(({ item, got }) => ({ id: item.id, file: got.file, args: products.find((x) => x.id === item.id).args }));
      const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'riyeser-batch-'));
      const { results, prompt } = await run.runElevatedBatch({ items, spawn: countingSpawn, dir: bdir });
      console.log(`  batch of ${items.length} (${items.map((i) => i.id).join(', ')}): prompt code=${prompt.code} startError=${prompt.startError}`, JSON.stringify(results));
      return Object.fromEntries(list.map(({ item }) => { const f = run.installFailure(results[item.id], { name: item.name, args: products.find((x) => x.id === item.id).args }); return [item.id, f.ok ? null : f]; }));
    },
    async verify(it) {
      for (let i = 0; i < 30; i++) { if (it.id in installed()) return true; await new Promise((ok) => setTimeout(ok, 1000)); }
      return false;
    },
  };
  const phase = async (name, r) => {
    const t0 = Date.now(); const p0 = prompts.length;
    const s = await fr.runQueue(r, driver);
    const row = { name, role: r.role, ms: Date.now() - t0, prompts: prompts.length - p0, summary: s,
      items: r.items.map(({ id, stage, reason, message, code, elevate }) => ({ id, stage, reason: reason || null, message: message || null, code: code ?? null, elevate })) };
    report.phases.push(row);
    console.log(`${name}: installed=${s.installed.join(',') || '-'} skipped=${s.skipped.join(',') || '-'} paused=${s.paused.join(',') || '-'} failed=${s.failed.join(',') || '-'} prompts=${row.prompts}`);
    return s;
  };
  const expect = (cond, what) => { if (!cond) report.problems.push(what); };

  // 1. the business's first PC: everything on the plan
  const ids = fr.forRole(fr.planPrograms(lic), 'everything');
  const before = installed();
  let r = fr.newRun({ ids, role: 'everything', installed: Object.keys(before), products });
  console.log(`Release ${latest.tag}; plan ${mods.join(',')} -> ${ids.join(', ')}; queue ${r.items.map((i) => `${i.id}${i.elevate ? '*' : ''}`).join(' ')}; admin ${report.admin}`);
  const s1 = await phase('first PC, network drops', r);
  expect(s1.paused.length > 0, 'the network drop should pause the rest');
  expect(!s1.failed.length, `failed before the drop: ${s1.failed.join(', ')}`);
  online = true; cutAfter = Infinity;
  r = JSON.parse(JSON.stringify(r));   // saved and read back, like Central's store across a restart
  r = fr.retry(r);
  const s2 = await phase('first PC, back online (resume)', r);
  expect(s2.allDone, `not all installed after resuming: failed ${s2.failed.join(', ')} paused ${s2.paused.join(', ')}`);
  const elevatedIds = r.items.filter((i) => i.elevate).map((i) => i.id);
  const batchPrompts = report.phases.reduce((n, p) => n + p.prompts, 0);
  expect(!elevatedIds.length || batchPrompts === 1, `expected one permission prompt for ${elevatedIds.join(', ')}, got ${batchPrompts}`);
  const now = installed();
  for (const id of ids) expect(id in now, `${id} isn't in Windows' installed-apps list`);

  // 2. a second PC of the same business, the till: the till's programs only, already-installed ones skipped
  const till = fr.forRole(fr.planPrograms(lic), 'till');
  const r2 = fr.newRun({ ids: till, role: 'till', installed: Object.keys(installed()), products });
  const s3 = await phase('second PC (Till)', r2);
  expect(s3.allDone && s3.installed.length === 0 && s3.skipped.length === till.length, 'the till PC should skip what is already there');
  expect(report.phases[2].prompts === 0, 'the till PC should not ask for permission');

  report.prompts = prompts.length;
  report.ok = !report.problems.length;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(report.ok ? 'First run installed the plan end to end.' : `Problems: ${report.problems.join(' | ')}`);
  console.log(`Report: ${outFile}`);
  process.exit(report.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
