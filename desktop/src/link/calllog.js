// Recent calls, kept on this PC for 90 days (phone-calls.json, written the same way as every other Riyeser file).
const KEEP_DAYS = 90;
const MAX_CALLS = 20000;
const DAY = 86400000;

class CallLog {
  constructor(store) { this.store = store; }
  list({ limit = 200, now = Date.now() } = {}) {
    return (this.store.get('phone-calls', []) || []).filter((c) => now - Date.parse(c.start) < KEEP_DAYS * DAY).slice(-limit).reverse();
  }
  /** { from, fromName, to, toName, kind, start, answeredAt, end, result } */
  add(call, now = Date.now()) {
    const rec = { ...call, duration: call.answeredAt && call.end ? Math.max(0, Math.round((Date.parse(call.end) - Date.parse(call.answeredAt)) / 1000)) : 0 };
    this.store.update('phone-calls', [], (all) => [...(all || []).filter((c) => now - Date.parse(c.start) < KEEP_DAYS * DAY), rec].slice(-MAX_CALLS));
    return rec;
  }
}

module.exports = { CallLog, KEEP_DAYS };
