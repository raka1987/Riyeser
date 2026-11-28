// Riyeser PDF: what to do when it's started from File Explorer's right-click menu (or "Open with").
//
// The installer (build/pdf/installer.nsh) adds a "Riyeser PDF" sub-menu to PDFs and pictures, for this Windows user
// only (HKCU, no administrator needed). Each entry starts Riyeser PDF with a task and the file:
//   "Riyeser PDF.exe" --task=compress "C:\Invoices\INV-1001.pdf"
// When several files are selected, Windows starts the program once per file, almost at the same time. Only the first
// copy keeps running (single-instance lock); the others hand their command line over to it, and the gatherer below
// collects them into one job ("Combine selected" combines all of them, not one at a time).
const fs = require('fs');
const path = require('path');

/** The tasks the right-click menu can ask for. */
const TASKS = ['open', 'sign', 'compress', 'combine', 'toimages', 'topdf'];
const PDF = /\.pdf$/i;
const PICTURE = /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i;
const OPENABLE = /\.(pdf|jpe?g|png|webp|bmp|gif|heic|heif)$/i;

/**
 * The right-click menu entries, in the order Windows shows them. The installer script must match these
 * (test/pdf-handy.test.js checks it does).
 *   key: the registry sub-key; label: what people see; task: --task=...; types: which files show it
 */
const MENU = [
  { key: '1open', label: 'Open', task: 'open', types: ['pdf'] },
  { key: '2sign', label: 'Sign', task: 'sign', types: ['pdf'] },
  { key: '3compress', label: 'Compress', task: 'compress', types: ['pdf'] },
  { key: '4combine', label: 'Combine selected', task: 'combine', types: ['pdf', 'picture'] },
  { key: '5toimages', label: 'Convert to images', task: 'toimages', types: ['pdf'] },
  { key: '6topdf', label: 'Convert to PDF', task: 'topdf', types: ['picture'] },
];
const MENU_EXTS = { pdf: ['.pdf'], picture: ['.jpg', '.jpeg', '.png'] };

/**
 * Read a command line: { task, files }. task is null when none was given (a plain "Open with" or double-click: open).
 * argv: process.argv or the argv Electron passes to 'second-instance'. exists: for tests.
 */
function parseArgs(argv, { exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } } } = {}) {
  const list = (argv || []).slice(1).map(String);
  let task = null;
  const files = [];
  for (const a of list) {
    const m = /^--task=([a-z]+)$/i.exec(a);
    if (m) { const t = m[1].toLowerCase(); if (TASKS.includes(t)) task = t; continue; }
    if (a.startsWith('-')) continue;               // Chromium and Electron switches
    if (!OPENABLE.test(a)) continue;               // the app's own folder when run from source, and anything else
    const f = path.resolve(a);
    if (exists(f) && !files.includes(f)) files.push(f);
  }
  if (!files.length) return { task: null, files: [] };
  // A picture can only be opened by turning it into a PDF first.
  if (!task || task === 'open') task = files.every((f) => PICTURE.test(f)) ? 'topdf' : 'open';
  return { task, files };
}

/**
 * Collect the command lines that arrive within a short time of each other into one job per task.
 * run({ task, files }) is called once things go quiet (quiet ms after the last one; never later than max ms).
 */
function createGatherer({ run, quiet = 700, max = 4000, timers = { setTimeout, clearTimeout } } = {}) {
  let pending = new Map(); let timer = null; let first = 0;
  const flush = () => {
    timer = null; first = 0;
    const jobs = [...pending.entries()].map(([task, files]) => ({ task, files }));
    pending = new Map();
    for (const j of jobs) run(j);
  };
  return {
    add({ task, files }, now = Date.now()) {
      if (!files || !files.length) return false;
      const list = pending.get(task) || [];
      for (const f of files) if (!list.includes(f)) list.push(f);
      pending.set(task, list);
      if (!first) first = now;
      if (timer) timers.clearTimeout(timer);
      timer = timers.setTimeout(flush, now - first >= max ? 0 : quiet);
      return true;
    },
    flush,
    get size() { return [...pending.values()].reduce((n, l) => n + l.length, 0); },
  };
}

/** The command a right-click entry runs (as the installer writes it). exe: the full path of Riyeser PDF.exe. */
const menuCommand = (exe, task) => `"${exe}" --task=${task} "%1"`;

/** Split a Windows command line the way the C runtime does for "quoted" arguments (enough for the menu's commands). */
function splitCommandLine(cmd) {
  const out = []; let cur = ''; let quoted = false; let any = false;
  for (const ch of String(cmd)) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (any || cur) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

module.exports = { TASKS, MENU, MENU_EXTS, PDF, PICTURE, parseArgs, createGatherer, menuCommand, splitCommandLine };
