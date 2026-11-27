// Riyeser online connections: the activity trail on the sync PC. Every sync run that did something, every item that
// came in (when, from where, what it became), every publish, test and problem, so the owner can see it's working
// rather than assume it. Quiet runs ("checked, nothing new") are merged into one line per stretch, with a count.
// Kept 90 days (and at most 20 000 lines) in online-trail.json in Central's data folder; the newest lines are also
// sent to the program that holds the company file (its Online → Activity page) with each sync report.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAYS = 90;
const MAX = 20000;
const TYPES = ['run', 'item', 'publish', 'test', 'problem', 'setup'];
const STATUS = ['ok', 'done', 'rejected', 'retry', 'waiting', 'error', 'info'];
const LABEL = { ok: 'OK', done: 'Filed', rejected: 'Turned down', retry: 'Trying again', waiting: 'Waiting', error: 'Problem', info: 'Note' };

const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

class Trail {
  constructor({ file, now = () => Date.now(), days = DAYS, max = MAX }) {
    Object.assign(this, { file, now, days, max });
    this.rows = []; this.unsent = new Set(); this.changed = false;
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d)) this.rows = d.filter((r) => r && r.uid && r.at); } catch { /* none yet */ }
    this.prune();
  }
  prune() {
    const cut = this.now() - this.days * 86400e3;
    const n = this.rows.length;
    this.rows = this.rows.filter((r) => r.at >= cut);
    if (this.rows.length > this.max) this.rows = this.rows.slice(-this.max);
    if (this.rows.length !== n) this.changed = true;
  }
  /** Add a line: {type, status, what, source?, detail?, ref?}. Returns it. */
  add(e) {
    const r = { uid: crypto.randomUUID(), at: this.now(), n: 1, type: TYPES.includes(e.type) ? e.type : 'run', status: STATUS.includes(e.status) ? e.status : 'info',
      what: String(e.what || '').slice(0, 300), source: e.source ? String(e.source).slice(0, 120) : '', detail: e.detail ? String(e.detail).slice(0, 500) : '',
      ref: e.ref ? String(e.ref).slice(0, 64) : '', pc: e.pc ? String(e.pc).slice(0, 80) : '' };
    this.rows.push(r); this.unsent.add(r.uid); this.changed = true;
    return r;
  }
  /** A quiet run: merged into the last line when that's a quiet run of the same day with the same words. */
  quiet(what, pc = '') {
    const last = this.rows[this.rows.length - 1];
    if (last && last.type === 'run' && last.quiet && last.what === what && localDay(last.at) === localDay(this.now())) {
      last.n += 1; last.at = this.now(); this.unsent.add(last.uid); this.changed = true; return last;
    }
    const r = this.add({ type: 'run', status: 'ok', what, pc }); r.quiet = true; r.first = r.at; return r;
  }
  /** The lines not yet given to the program (for its Online → Activity page), oldest first. */
  pending(limit = 200) { return this.rows.filter((r) => this.unsent.has(r.uid)).slice(-limit).map(Trail.wire); }
  sent(list) { for (const r of list || []) this.unsent.delete(r.uid); }
  static wire(r) { return { uid: r.uid, at: new Date(r.at).toISOString(), type: r.type, status: r.status, what: r.what, source: r.source || null, detail: r.detail || null, ref: r.ref || null, pc: r.pc || null, n: r.n }; }
  save(force = false) {
    if (!this.changed && !force) return;
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows));
      fs.renameSync(tmp, this.file);
      this.changed = false;
    } catch { /* tried again next run */ }
  }
  /** Newest first. day: 'YYYY-MM-DD' (this PC's day); status: one of STATUS or 'problems'; type: one of TYPES. */
  list({ day = '', status = '', type = '', limit = 1000 } = {}) {
    let out = this.rows.slice().reverse().sort((a, b) => b.at - a.at);   // a merged quiet line moves up as it's checked again
    if (day) out = out.filter((r) => localDay(r.at) === day);
    if (status === 'problems') out = out.filter((r) => ['error', 'rejected', 'retry'].includes(r.status));
    else if (STATUS.includes(status)) out = out.filter((r) => r.status === status);
    if (TYPES.includes(type)) out = out.filter((r) => r.type === type);
    return out.slice(0, limit);
  }
  /** Days that have lines, newest first (for the day filter). */
  days_() { return [...new Set(this.rows.map((r) => localDay(r.at)))].sort().reverse(); }
  static csv(rows) {
    const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['When (this PC)', 'When (UTC)', 'Kind', 'Status', 'Source', 'What happened', 'Details', 'Reference', 'PC', 'Times'];
    const fmt = (t) => { const d = new Date(t); return `${localDay(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    return `﻿${[head, ...rows.map((r) => [fmt(r.at), new Date(r.at).toISOString(), r.type, LABEL[r.status] || r.status, r.source, r.what, r.detail, r.ref, r.pc, r.n])]
      .map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
  }
}

module.exports = { Trail, TYPES, STATUS, LABEL, DAYS, localDay };
