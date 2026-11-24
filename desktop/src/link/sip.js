// A small, careful SIP message parser and writer (RFC 3261), written for Riyeser Link Office.
// It only does what an office phone system needs: requests and responses, the common headers, compact header
// names, folded lines, Via / Route / Contact lists, name-addr and URI parsing, and digest authentication.
// Anything it can't make sense of throws, so the caller can drop the packet without crashing.
const crypto = require('crypto');

const MAX_SIZE = 65535;
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported',
  e: 'content-encoding', s: 'subject', o: 'event', u: 'allow-events', r: 'refer-to', b: 'referred-by', x: 'session-expires', a: 'accept-contact', j: 'reject-contact', d: 'request-disposition', y: 'identity', n: 'identity-info' };
// Headers that may hold several comma-separated values on one line, which we split into one value each.
const LISTS = new Set(['via', 'route', 'record-route', 'contact']);
// How headers are written out (anything not listed is written in Title-Case).
const CANON = { 'call-id': 'Call-ID', cseq: 'CSeq', 'www-authenticate': 'WWW-Authenticate', 'mime-version': 'MIME-Version', 'rseq': 'RSeq', 'rack': 'RAck' };
const canonName = (n) => CANON[n] || n.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase());
const TOKEN = /^[A-Za-z0-9.!%*_+`'~-]+$/;
const REASONS = { 100: 'Trying', 180: 'Ringing', 181: 'Call Is Being Forwarded', 182: 'Queued', 183: 'Session Progress', 200: 'OK', 202: 'Accepted',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 407: 'Proxy Authentication Required',
  408: 'Request Timeout', 415: 'Unsupported Media Type', 416: 'Unsupported URI Scheme', 420: 'Bad Extension', 423: 'Interval Too Brief',
  480: 'Temporarily Unavailable', 481: 'Call/Transaction Does Not Exist', 482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete',
  486: 'Busy Here', 487: 'Request Terminated', 488: 'Not Acceptable Here', 489: 'Bad Event', 491: 'Request Pending', 500: 'Server Internal Error',
  501: 'Not Implemented', 503: 'Service Unavailable', 600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere' };

class SipError extends Error {}
const fail = (why) => { throw new SipError(why); };

/** Split "a, b, <c,d>, "x,y" <e>" on top-level commas (not inside quotes or angle brackets). */
function splitList(value) {
  const out = []; let cur = ''; let q = false; let ang = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (q) { cur += ch; if (ch === '\\' && i + 1 < value.length) cur += value[++i]; else if (ch === '"') q = false; continue; }
    if (ch === '"') q = true;
    else if (ch === '<') ang++;
    else if (ch === '>') ang = Math.max(0, ang - 1);
    else if (ch === ',' && !ang) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (q) fail('unclosed quote');
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Parse one SIP message from a Buffer or string.
 * { method, uri, version } for requests or { status, reason } for responses, plus headers [[name, value]] and body (Buffer).
 * stream: true when the bytes came over TCP (Content-Length is then required to know where the body ends).
 */
function parse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (buf.length > MAX_SIZE) fail('too big');
  let end = buf.indexOf('\r\n\r\n'); let sep = 4;
  if (end < 0) { end = buf.indexOf('\n\n'); sep = 2; }
  if (end < 0) { end = buf.length; sep = 0; }
  const head = buf.slice(0, end).toString('utf8');
  if (/[\x00]/.test(head)) fail('NUL in headers');
  const lines = head.split(/\r?\n/);
  while (lines.length && lines[0] === '') lines.shift();   // stray CRLFs before a message (keep-alives)
  if (!lines.length) fail('empty');
  const first = lines.shift();
  const msg = { headers: [] };
  let m;
  if ((m = /^SIP\/2\.0 ([1-6]\d\d)(?: (.*))?$/.exec(first))) { msg.status = Number(m[1]); msg.reason = (m[2] || '').trim(); }
  else if ((m = /^([A-Za-z]+) (\S+) SIP\/2\.0$/.exec(first))) {
    msg.method = m[1].toUpperCase(); msg.uri = m[2];
    if (msg.method.length > 20 || !TOKEN.test(msg.method)) fail('bad method');
    if (!/^(sips?|tel):/i.test(msg.uri)) fail('bad request-uri');
  } else fail('bad start line');
  // unfold continuation lines
  const raw = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) { if (!raw.length) fail('continuation before any header'); raw[raw.length - 1] += ' ' + line.trim(); }
    else raw.push(line);
  }
  if (raw.length > 200) fail('too many headers');
  for (const line of raw) {
    const i = line.indexOf(':');
    if (i <= 0) fail('header without a colon');
    let name = line.slice(0, i).trim().toLowerCase();
    if (!TOKEN.test(name)) fail('bad header name');
    name = COMPACT[name] || name;
    const value = line.slice(i + 1).trim();
    if (LISTS.has(name) && !(name === 'contact' && value === '*')) for (const v of splitList(value)) msg.headers.push([name, v]);
    else msg.headers.push([name, value]);
  }
  let body = sep ? buf.slice(end + sep) : Buffer.alloc(0);
  const cl = getHeader(msg, 'content-length');
  if (cl != null) {
    if (!/^\d+$/.test(cl)) fail('bad content-length');
    const n = Number(cl);
    if (n > body.length) fail('body shorter than content-length');
    body = body.slice(0, n);
  }
  msg.body = body;
  // The headers every message must have
  for (const h of ['via', 'from', 'to', 'call-id', 'cseq']) if (getHeader(msg, h) == null) fail(`missing ${h}`);
  const cseq = parseCSeq(getHeader(msg, 'cseq'));
  if (msg.method && cseq.method !== msg.method && !(msg.method === 'ACK' && cseq.method === 'ACK')) fail('cseq method mismatch');
  parseVia(getHeader(msg, 'via'));
  parseNameAddr(getHeader(msg, 'from')); parseNameAddr(getHeader(msg, 'to'));
  if (msg.method) parseUri(msg.uri);
  return msg;
}

/** Write a message out. Content-Length is always set from the body. */
function serialize(msg) {
  const body = msg.body ? (Buffer.isBuffer(msg.body) ? msg.body : Buffer.from(String(msg.body), 'utf8')) : Buffer.alloc(0);
  const first = msg.method ? `${msg.method} ${msg.uri} SIP/2.0` : `SIP/2.0 ${msg.status} ${msg.reason || REASONS[msg.status] || ''}`;
  const lines = [first];
  for (const [n, v] of msg.headers) if (n !== 'content-length') lines.push(`${canonName(n)}: ${v}`);
  lines.push(`Content-Length: ${body.length}`);
  return Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8'), body]);
}

// ---------- headers ----------
function getHeader(msg, name) { const h = msg.headers.find((x) => x[0] === name); return h ? h[1] : null; }
const getAll = (msg, name) => msg.headers.filter((x) => x[0] === name).map((x) => x[1]);
function setHeader(msg, name, value) {
  const i = msg.headers.findIndex((x) => x[0] === name);
  if (i < 0) msg.headers.push([name, value]); else { msg.headers[i][1] = value; msg.headers = msg.headers.filter((x, j) => x[0] !== name || j === i); }
}
function removeHeader(msg, name) { msg.headers = msg.headers.filter((x) => x[0] !== name); }
/** Put a header value first among its kind (a new Via or Record-Route goes on top). */
function prependHeader(msg, name, value) {
  const i = msg.headers.findIndex((x) => x[0] === name);
  msg.headers.splice(i < 0 ? 0 : i, 0, [name, value]);
}
function removeFirst(msg, name) { const i = msg.headers.findIndex((x) => x[0] === name); if (i >= 0) msg.headers.splice(i, 1); }
const clone = (msg) => ({ ...msg, headers: msg.headers.map((h) => [h[0], h[1]]), body: msg.body ? Buffer.from(msg.body) : Buffer.alloc(0) });

// ---------- parameters, URIs, name-addr ----------
function parseParams(text) {
  const params = {};
  for (const part of String(text || '').split(';')) {
    const p = part.trim(); if (!p) continue;
    const i = p.indexOf('=');
    const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    if (!k) continue;
    let v = i < 0 ? '' : p.slice(i + 1).trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    params[k] = v;
  }
  return params;
}
const formatParams = (params) => Object.entries(params || {}).map(([k, v]) => (v === '' || v == null ? `;${k}` : `;${k}=${v}`)).join('');

/** sip:user:pass@host:port;params?headers */
function parseUri(text) {
  const s = String(text || '').trim();
  const m = /^(sips?|tel):(.*)$/i.exec(s);
  if (!m) fail('bad uri');
  const scheme = m[1].toLowerCase(); let rest = m[2];
  let headers = '';
  const q = rest.indexOf('?'); if (q >= 0) { headers = rest.slice(q + 1); rest = rest.slice(0, q); }
  if (scheme === 'tel') { const [num, ...ps] = rest.split(';'); return { scheme, user: num, host: '', port: null, params: parseParams(ps.join(';')), headers }; }
  let user = null; let password = null;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const ui = rest.slice(0, at); rest = rest.slice(at + 1);
    const c = ui.indexOf(':');
    user = c < 0 ? ui : ui.slice(0, c); password = c < 0 ? null : ui.slice(c + 1);
  }
  const semi = rest.indexOf(';');
  const hp = semi < 0 ? rest : rest.slice(0, semi);
  const params = parseParams(semi < 0 ? '' : rest.slice(semi + 1));
  let host; let port = null;
  const v6 = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(hp);
  if (v6) { host = v6[1]; port = v6[2] ? Number(v6[2]) : null; }
  else {
    const hm = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(hp);
    if (!hm) fail('bad uri host');
    host = hm[1].toLowerCase(); port = hm[2] ? Number(hm[2]) : null;
  }
  if (port != null && (port < 1 || port > 65535)) fail('bad uri port');
  if (user != null && user.length > 128) fail('bad uri user');
  return { scheme, user, password, host, port, params, headers };
}
function formatUri(u) {
  if (u.scheme === 'tel') return `tel:${u.user}${formatParams(u.params)}`;
  const host = u.host.includes(':') ? `[${u.host}]` : u.host;
  return `${u.scheme}:${u.user != null ? `${u.user}${u.password != null ? `:${u.password}` : ''}@` : ''}${host}${u.port ? `:${u.port}` : ''}${formatParams(u.params)}${u.headers ? `?${u.headers}` : ''}`;
}
/** Decode %xx in a URI user part (e.g. MAC%3a0015…). */
const userOf = (u) => { try { return decodeURIComponent(u.user || ''); } catch { return u.user || ''; } };

/** "Name" <sip:…>;tag=x   or   sip:…;tag=x */
function parseNameAddr(text) {
  const s = String(text || '').trim();
  let display = ''; let uri; let rest;
  const lt = s.indexOf('<');
  if (lt >= 0) {
    const gt = s.indexOf('>', lt);
    if (gt < 0) fail('unclosed <');
    display = s.slice(0, lt).trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
    uri = s.slice(lt + 1, gt).trim(); rest = s.slice(gt + 1);
  } else {
    const semi = s.indexOf(';');
    uri = semi < 0 ? s : s.slice(0, semi); rest = semi < 0 ? '' : s.slice(semi);
  }
  if (display.length > 200) fail('display name too long');
  return { display, uri, parsed: parseUri(uri), params: parseParams(rest) };
}
function formatNameAddr(na) {
  const d = na.display ? `"${String(na.display).replace(/["\\]/g, '')}" ` : '';
  return `${d}<${na.uri}>${formatParams(na.params)}`;
}

/** SIP/2.0/UDP host:port;branch=…;received=…;rport=… */
function parseVia(text) {
  const m = /^SIP\s*\/\s*2\.0\s*\/\s*([A-Za-z]+)\s+([^;\s]+)\s*(.*)$/i.exec(String(text || '').trim());
  if (!m) fail('bad via');
  let host = m[2]; let port = null;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (v6) { host = v6[1]; port = v6[2] ? Number(v6[2]) : null; }
  else { const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host); if (!hp) fail('bad via host'); host = hp[1]; port = hp[2] ? Number(hp[2]) : null; }
  return { transport: m[1].toUpperCase(), host, port, params: parseParams(m[3]) };
}
const formatVia = (v) => `SIP/2.0/${v.transport} ${v.host.includes(':') ? `[${v.host}]` : v.host}${v.port ? `:${v.port}` : ''}${formatParams(v.params)}`;

function parseCSeq(text) {
  const m = /^(\d{1,10})\s+([A-Za-z]+)$/.exec(String(text || '').trim());
  if (!m || Number(m[1]) > 2 ** 31) fail('bad cseq');
  return { seq: Number(m[1]), method: m[2].toUpperCase() };
}

// ---------- making messages ----------
const rand = (n = 8) => crypto.randomBytes(n).toString('hex');
const newBranch = () => `z9hG4bK${rand(8)}`;
const newTag = () => rand(6);
const newCallId = (host) => `${rand(12)}@${host || 'riyeser'}`;

/** A response to a request: copies Via, From, To, Call-ID and CSeq (and adds a To tag when there's none). */
function response(req, status, reason, { toTag, headers = [], body } = {}) {
  const res = { status, reason: reason || REASONS[status] || '', headers: [] };
  for (const v of getAll(req, 'via')) res.headers.push(['via', v]);
  if (status !== 100) for (const rr of getAll(req, 'record-route')) res.headers.push(['record-route', rr]);
  res.headers.push(['from', getHeader(req, 'from')]);
  let to = getHeader(req, 'to');
  if (status !== 100 && toTag && !parseNameAddr(to).params.tag) to += `;tag=${toTag}`;
  res.headers.push(['to', to]);
  res.headers.push(['call-id', getHeader(req, 'call-id')]);
  res.headers.push(['cseq', getHeader(req, 'cseq')]);
  for (const h of headers) res.headers.push(h);
  res.body = body ? Buffer.from(body) : Buffer.alloc(0);
  return res;
}

// ---------- digest authentication (RFC 2617 / 8760, MD5) ----------
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
function parseAuth(text) {
  const m = /^\s*(\w+)\s+(.*)$/s.exec(String(text || ''));
  if (!m) return null;
  const params = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g; let x;
  while ((x = re.exec(m[2]))) params[x[1].toLowerCase()] = x[2] != null ? x[2].replace(/\\(.)/g, '$1') : x[3];
  return { scheme: m[1], params };
}
function digestResponse({ username, realm, password, method, uri, nonce, qop, nc, cnonce }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
}
/** Check an Authorization / Proxy-Authorization header against the password (constant-time compare). */
function digestOk(auth, method, password) {
  const p = auth && auth.params;
  if (!p || !/^digest$/i.test(auth.scheme) || !p.username || !p.nonce || !p.uri || !p.response) return false;
  if (p.algorithm && !/^md5$/i.test(p.algorithm)) return false;
  if (p.qop && (p.qop !== 'auth' || !p.nc || !p.cnonce)) return false;
  const want = digestResponse({ username: p.username, realm: p.realm || '', password, method, uri: p.uri, nonce: p.nonce, qop: p.qop, nc: p.nc, cnonce: p.cnonce });
  const a = Buffer.from(want); const b = Buffer.from(String(p.response).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** The header a client sends after a 401/407 challenge. */
function authorize(challenge, { username, password, method, uri }) {
  const c = parseAuth(challenge).params;
  const qop = c.qop && c.qop.split(',').map((x) => x.trim()).includes('auth') ? 'auth' : null;
  const nc = '00000001'; const cnonce = rand(8);
  const resp = digestResponse({ username, realm: c.realm, password, method, uri, nonce: c.nonce, qop, nc, cnonce });
  return `Digest username="${username}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", response="${resp}", algorithm=MD5${qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${c.opaque ? `, opaque="${c.opaque}"` : ''}`;
}

module.exports = { parse, serialize, getHeader, getAll, setHeader, removeHeader, prependHeader, removeFirst, clone, parseParams, formatParams,
  parseUri, formatUri, userOf, parseNameAddr, formatNameAddr, parseVia, formatVia, parseCSeq, splitList, response, newBranch, newTag, newCallId,
  parseAuth, digestOk, digestResponse, authorize, md5, SipError, REASONS, MAX_SIZE };
