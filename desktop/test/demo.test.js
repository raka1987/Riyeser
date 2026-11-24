// Demo mode in Riyeser Central: demo.json, the first-run choice, the banner, and leaving (folders renamed, never deleted).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const demo = require('../src/central/demo');
const ui = require('../src/renderer/demo-ui');
const online = require('../src/core/online');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'central-demo-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('demo: no file, or on:false, is normal mode', () => {
  const appData = tmp();
  assert.equal(demo.isOn(appData), false);
  assert.equal(demo.demoFile(appData), path.join(appData, 'Riyeser', 'demo.json'));   // next to company.json and licence.json
  assert.equal(path.dirname(demo.demoFile(appData)), path.dirname(online.companyFile(appData)));
  demo.write(appData, { on: false });
  assert.equal(demo.isOn(appData), false);
});

test('demo: choosing "Explore with demo data" writes demo.json and no company.json', () => {
  const appData = tmp();
  const now = new Date('2026-11-24T03:15:00.000Z');
  demo.start(appData, now);
  assert.deepEqual(readJson(demo.demoFile(appData)), { on: true, since: '2026-11-24T03:15:00.000Z', business: 'Sample Trading Co' });
  assert.equal(demo.isOn(appData), true);
  assert.equal(fs.existsSync(online.companyFile(appData)), false);   // nothing linked to a real online company
  assert.equal(online.readCompany(appData), null);
});

test('demo: the first-run wizard asks how to start; someone already set up is never asked again', () => {
  assert.equal(ui.firstScreen({ company: null, skipped: false }, { on: false }), 'start');
  assert.equal(ui.firstScreen({ company: null, skipped: false }, null), 'start');
  assert.equal(ui.firstScreen({ company: { name: 'My Business', mode: 'local' } }, { on: false }), 'none');
  assert.equal(ui.firstScreen({ company: { name: 'My Business', mode: 'online' } }, null), 'none');
  assert.equal(ui.firstScreen({ company: null, skipped: true }, { on: false }), 'none');      // chose "Set up later"
  assert.equal(ui.firstScreen({ company: null, skipped: false }, { on: true }), 'none');     // exploring the demo
  assert.equal(ui.firstScreen({ company: null, pendingJoin: { company_name: 'X' } }, null), 'waiting');
  const html = ui.startHtml();
  assert.match(html, /How would you like to start\?/);
  assert.match(html, /Start blank \(recommended\)/);
  assert.match(html, /Explore with demo data/);
  assert.match(html, /Sample Trading Co/);
  assert.match(html, /data-w="blank"/); assert.match(html, /data-w="demo"/);
});

test('demo: the yellow banner shows only while demo mode is on', () => {
  assert.equal(ui.bannerHtml({ on: false }), '');
  assert.equal(ui.bannerHtml(null), '');
  const b = ui.bannerHtml({ on: true });
  assert.match(b, /<b>Demo mode<\/b>: everything you see is practice data for Sample Trading Co\./);
  assert.match(b, /data-demo="leave">Leave demo mode</);
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.html'), 'utf8');
  assert.match(page, /id="demobar"/);
  assert.ok(page.indexOf('demo-ui.js') < page.indexOf('central.js') && page.indexOf('central.js') < page.indexOf('company.js'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'central.css'), 'utf8'), /\.demobar \{[^}]*background: #ffd84d/);
  assert.equal(ui.TEXT.confirmLeave, 'Leave demo mode? The practice data is put away (not deleted), and Riyeser goes back to your own setup. Close any open Riyeser programs first.');
});

test('demo: the programs\' demo folders (Accounting: RIYESER_HOME or ~/.riyeser; Payroll: %APPDATA%\\Riyeser Payroll\\payroll)', () => {
  const appData = tmp(); const home = tmp();
  const f = demo.programFolders({ appData, env: {}, home });
  assert.deepEqual(f.map((x) => x.dir), [path.join(home, '.riyeser', 'demo'), path.join(appData, 'Riyeser Payroll', 'payroll', 'demo')]);
  assert.equal(demo.programFolders({ appData, env: { RIYESER_HOME: '/books' }, home })[0].dir, path.join('/books', 'demo'));
  assert.equal(demo.demoAccountingDb({}, home), path.join(home, '.riyeser', 'demo', 'company.db'));
  assert.equal(demo.demoPayrollDb(appData), path.join(appData, 'Riyeser Payroll', 'payroll', 'demo', 'payroll.db'));
});

function demoFolders() {
  const appData = tmp(); const home = tmp();
  const folders = demo.programFolders({ appData, env: {}, home });
  for (const f of folders) { fs.mkdirSync(f.dir, { recursive: true }); fs.writeFileSync(path.join(f.dir, 'practice.db'), 'practice'); }
  // the real records next to them
  fs.writeFileSync(path.join(home, '.riyeser', 'company.db'), 'real books');
  fs.writeFileSync(path.join(appData, 'Riyeser Payroll', 'payroll', 'payroll.db'), 'real payroll');
  demo.start(appData, new Date('2026-11-20T00:00:00Z'));
  return { appData, home, folders };
}

test('demo: leaving sets on:false and renames each demo folder to demo-ended-<UTC stamp> (nothing deleted)', () => {
  const { appData, home, folders } = demoFolders();
  const now = new Date('2026-11-24T03:15:09.123Z');
  const r = demo.leave({ appData, folders, now });
  assert.equal(demo.isOn(appData), false);
  const d = readJson(demo.demoFile(appData));
  assert.equal(d.on, false); assert.equal(d.business, 'Sample Trading Co');
  assert.equal(r.busy.length, 0); assert.equal(r.ended.length, 2);
  for (const f of folders) {
    assert.equal(fs.existsSync(f.dir), false);
    const ended = path.join(path.dirname(f.dir), 'demo-ended-20261124T031509Z');
    assert.equal(fs.readFileSync(path.join(ended, 'practice.db'), 'utf8'), 'practice');
  }
  assert.equal(fs.readFileSync(path.join(home, '.riyeser', 'company.db'), 'utf8'), 'real books');
  assert.equal(fs.readFileSync(path.join(appData, 'Riyeser Payroll', 'payroll', 'payroll.db'), 'utf8'), 'real payroll');
  assert.equal(ui.leaveMessage(r).ok, true);
  // a program that was never opened in demo mode has no folder: nothing to do
  assert.deepEqual(demo.leave({ appData, folders }), { ended: [], busy: [] });
});

test('demo: a program still open -> told which one to close; demo.json is on:false anyway; put away later', () => {
  const { appData, folders } = demoFolders();
  const payroll = folders.find((f) => f.id === 'payroll');
  const rename = (from, to) => { if (from === payroll.dir) { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; } fs.renameSync(from, to); };
  const r = demo.leave({ appData, folders, rename });
  assert.equal(demo.isOn(appData), false);
  assert.deepEqual(r.busy.map((b) => b.id), ['payroll']); assert.equal(r.busy[0].error, 'EBUSY');
  assert.ok(fs.existsSync(payroll.dir));                       // left as it was, not deleted
  const m = ui.leaveMessage(r);
  assert.equal(m.ok, false); assert.match(m.text, /Riyeser Payroll is still open/); assert.match(m.text, /close Riyeser Payroll/);
  // Central's next start (or "Try again"): put away now that it's closed
  const t = demo.tidy({ appData, folders });
  assert.equal(t.ended.length, 1); assert.equal(fs.existsSync(payroll.dir), false);
  assert.ok(fs.readdirSync(path.dirname(payroll.dir)).some((n) => /^demo-ended-\d{8}T\d{6}Z$/.test(n)));
  // tidy never touches anything while demo mode is on
  demo.start(appData); fs.mkdirSync(payroll.dir, { recursive: true });
  assert.deepEqual(demo.tidy({ appData, folders }), { ended: [], busy: [] }); assert.ok(fs.existsSync(payroll.dir));
});

test('demo: Central\'s home shows made-up to-dos and meetings', () => {
  const s = demo.sampleToday(new Date('2026-11-24T08:00:00'));
  assert.ok(s.tasks.length >= 3 && s.tasks.every((t) => t.text && !t.done));
  assert.ok(s.meetings.length >= 2 && s.meetings.every((m) => m.title && !Number.isNaN(Date.parse(m.start))));
});
