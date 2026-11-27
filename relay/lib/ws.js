// A small WebSocket (RFC 6455) server and client with no dependencies: text and binary frames, ping/pong, close,
// client masking, a size limit. Enough for the relay's control messages and SIP frames, nothing more (no
// extensions, no compression). The same file is in desktop/src/link/ws.js (keep them in step).
const crypto = require('crypto');
const net = require('net');
const tlsMod = require('tls');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 256 * 1024;
const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

class WsConn extends EventEmitter {
  /** sock: a connected socket after the HTTP upgrade. client: true masks what it sends (as clients must). */
  constructor(sock, { client = false, head = null, maxFrame = MAX_FRAME } = {}) {
    super();
    this.sock = sock; this.client = client; this.maxFrame = maxFrame; this.open = true;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0); this.frags = null;
    this.remoteAddress = sock.remoteAddress; this.remotePort = sock.remotePort;
    sock.setNoDelay && sock.setNoDelay(true);
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.closed(1006, 'connection lost'));
    sock.on('error', (e) => this.emit('error', e));
    if (this.buf.length) setImmediate(() => this.parse());
  }
  parse() {
    for (;;) {
      if (!this.open) return;
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80); const op = b[0] & 0x0f; const masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f; let i = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); i = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); len = b.readUInt32BE(6); if (hi) return this.fail(1009, 'too big'); i = 10; }
      if (len > this.maxFrame) return this.fail(1009, 'too big');
      if (masked === this.client) return this.fail(1002, 'masking');   // servers get masked frames, clients unmasked
      const mask = masked ? b.slice(i, i + 4) : null; if (masked) i += 4;
      if (b.length < i + len) return;
      let data = b.slice(i, i + len); this.buf = b.slice(i + len);
      if (mask) { data = Buffer.from(data); for (let k = 0; k < data.length; k++) data[k] ^= mask[k & 3]; }
      if (op >= 8) {   // control frames
        if (op === 8) { const code = data.length >= 2 ? data.readUInt16BE(0) : 1005; this.send(Buffer.from(data.slice(0, 2)), 8); this.closed(code, data.slice(2).toString()); this.sock.end(); return; }
        if (op === 9) this.send(data, 10);
        else if (op === 10) this.emit('pong', data);
        continue;
      }
      if (op === 0) { if (!this.frags) return this.fail(1002, 'continuation'); this.frags.parts.push(data); }
      else this.frags = { op, parts: [data] };
      if (this.frags.parts.reduce((n, p) => n + p.length, 0) > this.maxFrame) return this.fail(1009, 'too big');
      if (fin) { const f = this.frags; this.frags = null; const all = Buffer.concat(f.parts); this.emit('message', f.op === 1 ? all.toString('utf8') : all, f.op === 2); }
    }
  }
  send(data, op) {
    if (!this.open || this.sock.destroyed) return false;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (op == null) op = Buffer.isBuffer(data) ? 2 : 1;
    const len = body.length; const head = [0x80 | op];
    const m = this.client ? 0x80 : 0;
    if (len < 126) head.push(m | len); else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
    else head.push(m | 127, 0, 0, 0, 0, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
    let payload = body;
    if (this.client) { const mask = crypto.randomBytes(4); payload = Buffer.from(body); for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k & 3]; head.push(...mask); }
    this.sock.write(Buffer.concat([Buffer.from(head), payload]));
    return true;
  }
  sendJson(o) { return this.send(JSON.stringify(o)); }
  ping(data = Buffer.alloc(0)) { return this.send(data, 9); }
  fail(code, why) { try { const b = Buffer.alloc(2); b.writeUInt16BE(code); this.send(Buffer.concat([b, Buffer.from(why)]), 8); } catch { /* closing anyway */ } this.closed(code, why); this.sock.destroy(); }
  close(code = 1000, why = '') {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code); this.send(Buffer.concat([b, Buffer.from(String(why).slice(0, 100))]), 8);
    this.closed(code, why); const s = this.sock; setTimeout(() => s.destroy(), 1000).unref();
  }
  terminate() { this.closed(1006, 'terminated'); this.sock.destroy(); }
  closed(code, why) { if (!this.open) return; this.open = false; this.emit('close', code, why); }
}

/** Accept an HTTP upgrade request (req, socket, head from the 'upgrade' event). -> WsConn, or null after refusing. */
function accept(req, socket, head, { maxFrame } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { refuse(socket, 400, 'Bad Request'); return null; }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  return new WsConn(socket, { client: false, head, maxFrame });
}
function refuse(socket, status, text, body = '') {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch { /* gone */ }
}

/**
 * Connect to ws:// or wss:// url. opts: { headers, timeout = 10 s, ca, lookupAddress (connect to this IP instead of
 * resolving the name, keeping the name for TLS), rejectUnauthorized, pin: 'AB:CD:…' or [..] (accept exactly the
 * certificate with this SHA-256 fingerprint, e.g. a relay's self-signed one, whatever signed it) }.
 * The upgrade request (with its Authorization header) is only sent once the certificate checks out.
 * -> Promise<WsConn>. A refusal rejects with err.status and err.body (the server's JSON reason).
 */
function connect(url, opts = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  const port = Number(u.port || (secure ? 443 : 80));
  const host = opts.lookupAddress || u.hostname;
  const key = crypto.randomBytes(16).toString('base64');
  const pins = [].concat(opts.pin || []).filter(Boolean).map((p) => String(p).toUpperCase());
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* gone */ } reject(e); };
    const sock = secure
      ? tlsMod.connect({ host, port, servername: net.isIP(u.hostname) ? undefined : u.hostname, ca: opts.ca, rejectUnauthorized: pins.length ? false : opts.rejectUnauthorized !== false })
      : net.connect(port, host);
    const timer = setTimeout(() => fail(Object.assign(new Error('The relay didn\'t answer in time'), { code: 'ETIMEDOUT' })), opts.timeout || 10000);
    sock.on('error', (e) => fail(e));
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      if (secure && pins.length) {
        const fp = String((sock.getPeerCertificate() || {}).fingerprint256 || '').toUpperCase();
        if (!pins.includes(fp)) return fail(Object.assign(new Error('The relay\'s certificate isn\'t the one Riyeser online expects'), { code: 'PIN' }));
      }
      const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`];
      for (const [k, v] of Object.entries(opts.headers || {})) lines.push(`${k}: ${String(v).replace(/[\r\n]/g, '')}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = Buffer.alloc(0); let head = null;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!head) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) { if (buf.length > 16384) fail(new Error('The relay\'s answer was too long')); return; }
        const text = buf.slice(0, end).toString('latin1'); buf = buf.slice(end + 4);
        const [first, ...rest] = text.split('\r\n');
        const h = {}; for (const l of rest) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        head = { status: Number((/^HTTP\/1\.[01] (\d{3})/.exec(first) || [])[1] || 0), headers: h };
        if (head.status === 101) {
          if (h['sec-websocket-accept'] !== acceptKey(key)) return fail(new Error('The relay\'s answer wasn\'t a proper WebSocket'));
          done = true; clearTimeout(timer); sock.off('data', onData);
          return resolve(new WsConn(sock, { client: true, head: buf, maxFrame: opts.maxFrame }));
        }
      }
      const want = Number(head.headers['content-length'] || 0);
      if (buf.length >= want || buf.length > 4096) {
        let j = null; try { j = JSON.parse(buf.slice(0, want || buf.length).toString()); } catch { /* not JSON */ }
        fail(Object.assign(new Error((j && j.error) || `The relay said ${head.status}`), { status: head.status, body: j }));
      }
    };
    sock.on('data', onData);
    sock.on('end', () => { if (head && head.status !== 101) onData(Buffer.alloc(0)); fail(new Error('The relay closed the connection')); });
  });
}

module.exports = { WsConn, accept, refuse, connect, acceptKey, MAX_FRAME };
