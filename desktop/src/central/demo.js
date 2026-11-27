// Demo mode for the whole Riyeser suite. The choice is kept in %APPDATA%\Riyeser\demo.json (next to company.json and
// licence.json): {"on": true, "since": "<ISO>", "business": "Sample Trading Co"}. No file, or "on": false, is normal mode.
// While it's on, each program keeps its records in <its normal data folder>/demo/ and fills them with the made-up
// business itself, so real records are never touched. Leaving demo mode sets "on": false and renames each program's
// demo folder to demo-ended-<UTC stamp>/ (never deleted). Programs pick the change up the next time they start.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUSINESS = 'Sample Trading Co';
const demoFile = (appData) => path.join(appData, 'Riyeser', 'demo.json');
function read(appData) { try { return JSON.parse(fs.readFileSync(demoFile(appData), 'utf8')) || null; } catch { return null; } }
const isOn = (appData) => { const d = read(appData); return !!(d && d.on === true); };
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261124T031500Z

/** Write demo.json safely (a temp file, then swap), the same way company.json is written. */
function write(appData, data) {
  const file = demoFile(appData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return data;
}
/** Turn demo mode on. Nothing else is written: no company.json, so nothing is linked to a real online company. */
function start(appData, now = new Date()) { return write(appData, { on: true, since: now.toISOString(), business: BUSINESS }); }

/** Riyeser Accounting's data folder (the same rules as the accounting app: RIYESER_HOME, else ~/.riyeser). */
const accountingHome = (env = process.env, home = os.homedir()) => env.RIYESER_HOME || path.join(home, '.riyeser');

/**
 * Each program's demo folder. Accounting, Accounting Basics, POS, Invoices and Bookings all share one data folder
 * (~/.riyeser, so one demo folder); Payroll keeps its own (%APPDATA%\Riyeser Payroll\payroll).
 */
function programFolders({ appData, env = process.env, home = os.homedir() }) {
  return [
    { id: 'accounting', name: 'Riyeser Accounting (and POS, Invoices, Bookings, Estimate)', dir: path.join(accountingHome(env, home), 'demo') },
    { id: 'payroll', name: 'Riyeser Payroll', dir: path.join(appData, 'Riyeser Payroll', 'payroll', 'demo') },
  ];
}
/** Where Central reads the demo figures from, so its numbers match what each program's demo shows. */
const demoAccountingDb = (env = process.env, home = os.homedir()) => path.join(accountingHome(env, home), 'demo', 'company.db');
const demoPayrollDb = (appData) => path.join(appData, 'Riyeser Payroll', 'payroll', 'demo', 'payroll.db');

/**
 * Leave demo mode: demo.json says on:false first (so even if a folder can't be renamed now, every program goes back
 * to its normal folder next time it starts), then each demo folder is renamed to demo-ended-<stamp>.
 * Returns { ended: [{id, name, from, to}], busy: [{id, name, dir, error}] }. A busy folder is one a program still has open.
 */
function leave({ appData, folders = programFolders({ appData }), now = new Date(), rename = fs.renameSync }) {
  const prev = read(appData) || {};
  write(appData, { ...prev, on: false, since: prev.since || null, business: prev.business || BUSINESS, ended: now.toISOString() });
  return putAway(folders, now, rename);
}
/** Rename each demo folder that's still there to demo-ended-<stamp> (never deleted). */
function putAway(folders, now = new Date(), rename = fs.renameSync) {
  const ended = []; const busy = [];
  for (const f of folders) {
    if (!fs.existsSync(f.dir)) continue;
    const to = path.join(path.dirname(f.dir), `demo-ended-${stamp(now)}`);
    try { rename(f.dir, to); ended.push({ id: f.id, name: f.name, from: f.dir, to }); }
    catch (e) { busy.push({ id: f.id, name: f.name, dir: f.dir, error: e.code || e.message }); }
  }
  return { ended, busy };
}
/** Demo mode was left but a program had its folder open: put it away now (Central's next start). */
function tidy({ appData, folders = programFolders({ appData }), now = new Date(), rename = fs.renameSync }) {
  const d = read(appData);
  if (!d || d.on !== false) return { ended: [], busy: [] };
  return putAway(folders, now, rename);
}

// ---------- Central's own home screen in demo mode ----------
// To-dos and meetings belong to Desk Assistant, which has no demo records: Central shows a few made-up ones instead.
function sampleToday(now = new Date()) {
  const at = (days, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const ymd = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  const tasks = [
    { id: 'demo-1', text: 'Call Bayside Cafe Group about the overdue invoice', due: ymd(0), done: false },
    { id: 'demo-2', text: 'Order more water filter cartridges from Pacific Wholesale Supplies', due: ymd(1), done: false },
    { id: 'demo-3', text: 'Check the timesheets before the next pay run', due: ymd(3), done: false },
    { id: 'demo-4', text: 'Send the quote to Greenleaf Landscaping', due: null, done: false },
  ];
  const meetings = [
    { title: 'Stock check with the warehouse team', start: at(0, 10), end: at(0, 10, 30), location: 'Warehouse', allDay: false },
    { title: 'Northshore Fitness: maintenance visit', start: at(0, 14), end: at(0, 15), location: 'Northshore', allDay: false },
    { title: 'Supplier catch-up: Pacific Wholesale Supplies', start: at(1, 9, 30), end: at(1, 10), location: '', allDay: false },
  ];
  return { tasks, meetings };
}

module.exports = { BUSINESS, demoFile, read, isOn, write, start, leave, tidy, putAway, stamp, programFolders, accountingHome, demoAccountingDb, demoPayrollDb, sampleToday };
