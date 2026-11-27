// How Riyeser Central reaches the program that holds the company file (Riyeser Accounting, Bookings, POS or
// Invoices: one Flask app, five builds) to file what websites send and to read what websites show.
//
// When one of those programs is running it writes local-api.json next to the company file (~/.riyeser, or
// RIYESER_HOME / RIYESER_DB, the same rules as sources.accountingDbPath): {port, token, pid, program, version}.
// Central calls http://127.0.0.1:<port>/online/api/... with the X-Riyeser-Token header. The program answers only on
// this PC, only with that token, and never to a web page.
//
// When none is running, Central starts one quietly (no window: `--no-window`), waits for local-api.json and uses it.
// A copy Central started is closed again when Central quits. If none is installed (or it won't start), the items stay
// in the online post box and come in next time.
const fs = require('fs');
const path = require('path');

const ORDER = ['accounting', 'accounting-basics', 'bookings', 'pos', 'invoices'];   // which program to start, first found

function discoveryFile(dbPath) { return path.join(path.dirname(dbPath), 'local-api.json'); }

class LocalApp {
  /**
   * dbPath: the company file (sources.accountingDbPath()); fetchFn: fetch; findExe: (id) => path or null;
   * spawnFn: (exe, args) => child process; env: extra environment for a started copy.
   */
  constructor({ dbPath, fetchFn = (u, o) => fetch(u, o), findExe = () => null, spawnFn = null, waitMs = 45000, pollMs = 500, sleep = null }) {
    Object.assign(this, { dbPath, fetchFn, findExe, spawnFn, waitMs, pollMs });
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.child = null; this.started = null;
  }
  info() {
    try {
      const d = JSON.parse(fs.readFileSync(discoveryFile(this.dbPath), 'utf8'));
      return d && Number.isInteger(d.port) && d.port > 0 && typeof d.token === 'string' && d.token ? d : null;
    } catch { return null; }
  }
  hasCompanyFile() { try { return fs.statSync(this.dbPath).isFile(); } catch { return false; } }
  /** The program to start, or null when none of them is installed. */
  program() { for (const id of ORDER) { const exe = this.findExe(id); if (exe) return { id, exe }; } return null; }

  async request(pathname, { method = 'GET', body, timeoutMs = 60000, info = null } = {}) {
    const i = info || this.info();
    if (!i) { const e = new Error('not running'); e.code = 'NOT_RUNNING'; throw e; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let r;
    try {
      r = await this.fetchFn(`http://127.0.0.1:${i.port}/online/api/${pathname}`, {
        method, headers: { 'X-Riyeser-Token': i.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
      });
    } catch { const e = new Error('not running'); e.code = 'NOT_RUNNING'; throw e; } finally { if (t) clearTimeout(t); }
    const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!r.ok) {
      const e = new Error((data && data.message) || `The program answered ${r.status}.`);
      e.status = r.status; e.code = (data && data.error) || `HTTP_${r.status}`; throw e;
    }
    return data;
  }

  /** {ok, ...status} when a program is answering (starting one if needed); throws with a plain message otherwise. */
  async ensure() {
    try { return await this.request('status', { timeoutMs: 8000 }); } catch (e) { if (e.code !== 'NOT_RUNNING' && e.code !== 'bad_token') throw e; }
    const prog = this.program();
    if (!prog) { const e = new Error('Riyeser Accounting, Bookings, POS or Invoices isn\'t installed on this PC.'); e.code = 'NO_PROGRAM'; throw e; }
    if (!this.spawnFn) { const e = new Error('Open Riyeser Accounting (or Bookings, POS, Invoices) on this PC.'); e.code = 'NOT_RUNNING'; throw e; }
    if (!this.child || this.child.exitCode != null || this.child.killed) {
      const before = (this.info() || {}).pid;
      this.child = this.spawnFn(prog.exe, ['--no-window']);
      this.started = { id: prog.id, at: Date.now(), before };
      if (this.child && typeof this.child.on === 'function') this.child.on('exit', () => { this.child = null; });
    }
    const end = Date.now() + this.waitMs;
    while (Date.now() < end) {
      await this.sleep(this.pollMs);
      try { return await this.request('status', { timeoutMs: 5000 }); } catch (e) { if (e.code !== 'NOT_RUNNING' && e.code !== 'bad_token') throw e; }
    }
    const e = new Error('Riyeser Accounting didn\'t start in time. It will be tried again in a minute.'); e.code = 'NOT_RUNNING'; throw e;
  }
  /** Close a copy Central started (never one a person opened). */
  stop() { if (this.child && this.child.exitCode == null) { try { this.child.kill(); } catch { /* already gone */ } } this.child = null; }

  status() { return this.request('status'); }
  importItems(items) { return this.request('import', { method: 'POST', body: { items }, timeoutMs: 5 * 60000 }); }
  catalog() { return this.request('catalog'); }
  stock() { return this.request('stock'); }
  availability() { return this.request('availability'); }
  outbox() { return this.request('outbox'); }
  outboxDone(sent, errors) { return this.request('outbox/done', { method: 'POST', body: { sent, errors } }); }
  report(r) { return this.request('sync-report', { method: 'POST', body: r }).catch(() => null); }
}

module.exports = { LocalApp, discoveryFile, ORDER };
