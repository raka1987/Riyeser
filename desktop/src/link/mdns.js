// A tiny mDNS responder (RFC 6762) so the office network can find this PC by name, whatever address the router gave
// it today: riyeser-office.local -> this PC's office address. It answers A (and ANY) questions for that one name only,
// announces the new address straight away when it changes (twice, with the cache-flush bit, so everyone listening
// forgets the old one), and also answers "legacy unicast" questions sent straight to port 5353 (a plain DNS lookup,
// e.g. `nslookup riyeser-office.local <this PC> -port=5353` or a phone/app pointed at it).
// If another PC on the network already answers for the name, it moves to riyeser-office-2.local (and so on) and says so.
// Nothing else is answered or sent: no services, no other names, nothing about the phones.
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { localAddresses } = require('./netinfo');

const GROUP = '224.0.0.251'; const PORT = 5353;
const NAME = 'riyeser-office.local';
const TYPE_A = 1; const TYPE_ANY = 255; const CLASS_IN = 1;
const TTL = 120;            // seconds; legacy unicast answers use 10 (RFC 6762 §6.7)

// ---------- DNS messages ----------
function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => { const b = Buffer.from(p, 'utf8'); if (b.length > 63) throw new Error('label too long'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}
/** Read a (possibly compressed) name at offset -> { name, next } */
function readName(buf, offset) {
  const labels = []; let next = -1; let jumps = 0; let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('name runs off the end');
    const len = buf[i];
    if (len === 0) { i++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= buf.length || ++jumps > 20) throw new Error('bad pointer');
      if (next < 0) next = i + 2;
      i = ((len & 0x3f) << 8) | buf[i + 1];
      continue;
    }
    if (len > 63 || i + 1 + len > buf.length) throw new Error('bad label');
    labels.push(buf.toString('utf8', i + 1, i + 1 + len)); i += 1 + len;
    if (labels.length > 128) throw new Error('too many labels');
  }
  return { name: labels.join('.'), next: next < 0 ? i : next };
}
/** -> { id, flags, response, questions: [{ name, type, cls, unicast }], answers: [{ name, type, cls, ttl, data }] } */
function parseMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('too short');
  const id = buf.readUInt16BE(0); const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4); const an = buf.readUInt16BE(6);
  if (qd > 64 || an > 64) throw new Error('too many records');
  let i = 12; const questions = []; const answers = [];
  for (let n = 0; n < qd; n++) {
    const r = readName(buf, i); i = r.next;
    if (i + 4 > buf.length) throw new Error('short question');
    const type = buf.readUInt16BE(i); const c = buf.readUInt16BE(i + 2); i += 4;
    questions.push({ name: r.name, type, cls: c & 0x7fff, unicast: !!(c & 0x8000) });
  }
  for (let n = 0; n < an; n++) {
    const r = readName(buf, i); i = r.next;
    if (i + 10 > buf.length) throw new Error('short answer');
    const type = buf.readUInt16BE(i); const cls = buf.readUInt16BE(i + 2) & 0x7fff; const ttl = buf.readUInt32BE(i + 4); const len = buf.readUInt16BE(i + 8); i += 10;
    if (i + len > buf.length) throw new Error('short data');
    const data = buf.slice(i, i + len); i += len;
    answers.push({ name: r.name, type, cls, ttl, data, address: type === TYPE_A && len === 4 ? [...data].join('.') : null });
  }
  return { id, flags, response: !!(flags & 0x8000), questions, answers };
}
/** An answer: name -> address (A record). opts: { id, question (echo it back, legacy unicast), ttl, flush } */
function answerMessage(name, address, { id = 0, question = null, ttl = TTL, flush = true } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0); head.writeUInt16BE(0x8400, 2);   // a response, authoritative
  head.writeUInt16BE(question ? 1 : 0, 4); head.writeUInt16BE(1, 6);
  const parts = [head];
  if (question) { const q = Buffer.alloc(4); q.writeUInt16BE(question.type, 0); q.writeUInt16BE(CLASS_IN, 2); parts.push(encodeName(question.name), q); }
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(TYPE_A, 0); rr.writeUInt16BE((flush ? 0x8000 : 0) | CLASS_IN, 2); rr.writeUInt32BE(ttl, 4); rr.writeUInt16BE(4, 8);
  parts.push(encodeName(name), rr, Buffer.from(String(address).split('.').map(Number)));
  return Buffer.concat(parts);
}
/** A question (for the tests, and to check nobody else has the name). */
function queryMessage(name, { id = 0, type = TYPE_A, unicast = false } = {}) {
  const head = Buffer.alloc(12); head.writeUInt16BE(id, 0); head.writeUInt16BE(1, 4);
  const q = Buffer.alloc(4); q.writeUInt16BE(type, 0); q.writeUInt16BE((unicast ? 0x8000 : 0) | CLASS_IN, 2);
  return Buffer.concat([head, encodeName(name), q]);
}

class MdnsResponder extends EventEmitter {
  /**
   * opts: { name = 'riyeser-office.local', address, port = 5353, bind = '0.0.0.0', multicast = true, ifaces, log,
   *         ownAddresses: () => [this PC's addresses] (answers from these are our own echo, not a conflict) }
   */
  constructor(opts = {}) {
    super();
    this.base = (opts.name || NAME).toLowerCase();
    this.name = this.base; this.address = opts.address || '127.0.0.1';
    this.port = opts.port == null ? PORT : opts.port; this.bind = opts.bind || '0.0.0.0';
    this.multicast = opts.multicast !== false; this.ifaces = opts.ifaces; this.logFn = opts.log || (() => {});
    this.ownFn = opts.ownAddresses || (() => localAddresses(typeof this.ifaces === 'function' ? this.ifaces() : this.ifaces).map((a) => a.address));
    this.stats = { questions: 0, answered: 0, malformed: 0 };
    this.joined = new Set(); this.timers = new Set();
  }
  log(level, text) { try { this.logFn(level, text); } catch { /* never mind */ } }
  async start() {
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('message', (buf, rinfo) => this.receive(buf, rinfo));
    this.sock.on('error', (e) => this.log('warn', `Name lookup (mDNS): ${e.message}`));
    await new Promise((resolve, reject) => { this.sock.once('error', reject); this.sock.bind(this.port, this.bind, () => { this.sock.off('error', reject); resolve(); }); });
    this.port = this.sock.address().port;
    if (this.multicast) { try { this.sock.setMulticastTTL(255); this.sock.setMulticastLoopback(true); } catch { /* fine */ } this.join(); }
    this.running = true;
    this.announce();
    return this;
  }
  async stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t); this.timers.clear();
    if (this.sock) await new Promise((r) => { try { this.sock.close(() => r()); } catch { r(); } });
    this.sock = null; this.joined.clear();
  }
  /** Listen on every office adapter (again, after the addresses changed). */
  join() {
    if (!this.sock || !this.multicast) return;
    const now = new Set(localAddresses(typeof this.ifaces === 'function' ? this.ifaces() : this.ifaces).map((a) => a.address));
    for (const a of this.joined) if (!now.has(a)) { try { this.sock.dropMembership(GROUP, a); } catch { /* that address is gone already */ } this.joined.delete(a); }
    for (const a of now) if (!this.joined.has(a)) { try { this.sock.addMembership(GROUP, a); this.joined.add(a); } catch { /* that adapter can't */ } }
    if (!this.joined.size) { try { this.sock.addMembership(GROUP); this.joined.add('*'); } catch { /* no multicast here */ } }
    try { if (this.address && this.address !== '127.0.0.1') this.sock.setMulticastInterface(this.address); } catch { /* the default one */ }
  }
  /** This PC has a new address: answer with it, and tell the network now. */
  setAddress(address) {
    if (!address || address === this.address) return false;
    this.address = address;
    if (this.running) { this.join(); this.announce(); }
    return true;
  }
  /** Tell everyone listening (twice, a second apart; RFC 6762 §8.3). */
  announce() {
    if (!this.running || !this.multicast || !this.address || this.address === '127.0.0.1') return;
    const send = () => this.send(answerMessage(this.name, this.address), GROUP, PORT);
    send();
    const t = setTimeout(() => { this.timers.delete(t); send(); }, 1000); if (t.unref) t.unref(); this.timers.add(t);
  }
  send(buf, address, port) { if (this.sock) { try { this.sock.send(buf, port, address, () => {}); } catch { /* best effort */ } } }
  receive(buf, rinfo) {
    if (!this.running) return;
    let m;
    try { m = parseMessage(buf); } catch { this.stats.malformed++; return; }
    if (m.response) return this.checkConflict(m, rinfo);
    for (const q of m.questions) {
      if (q.name.toLowerCase() !== this.name || q.cls !== CLASS_IN || (q.type !== TYPE_A && q.type !== TYPE_ANY)) continue;
      this.stats.questions++;
      if (!this.address || this.address === '127.0.0.1') continue;
      this.stats.answered++;
      if (rinfo.port !== PORT) {
        // legacy unicast (a plain DNS lookup sent to port 5353): reply to it directly, echoing its id and question
        this.send(answerMessage(this.name, this.address, { id: m.id, question: q, ttl: 10, flush: false }), rinfo.address, rinfo.port);
      } else if (q.unicast || !this.multicast) this.send(answerMessage(this.name, this.address), rinfo.address, rinfo.port);
      else this.send(answerMessage(this.name, this.address), GROUP, PORT);
    }
  }
  /** Someone else answered for our name with another address: take the next name (riyeser-office-2.local…). */
  checkConflict(m, rinfo) {
    const own = new Set([...this.ownFn(), this.address, '127.0.0.1']);
    if (own.has(rinfo.address)) return;
    const theirs = m.answers.find((a) => a.name.toLowerCase() === this.name && a.type === TYPE_A && a.address && !own.has(a.address));
    if (!theirs) return;
    const n = Number((/-(\d+)\.local$/.exec(this.name) || [])[1] || 1) + 1;
    const was = this.name;
    this.name = this.base.replace(/\.local$/, `-${n}.local`);
    this.log('warn', `Another computer (${rinfo.address}) already answers to ${was}. This PC is now ${this.name}.`);
    this.emit('name', this.name);
    this.announce();
  }
}

module.exports = { MdnsResponder, parseMessage, answerMessage, queryMessage, encodeName, NAME, GROUP, PORT };
