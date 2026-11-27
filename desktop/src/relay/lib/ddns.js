// The relay's own dynamic DNS: when its public IP changes (own-hardware mode), it points its name (relay.riyeser.com)
// at the new address itself, through the DNS provider's own API. No separate DDNS service.
//   DDNS_PROVIDER=cloudflare   DDNS_TOKEN (an API token with Zone → DNS → Edit for that zone only), DDNS_ZONE (the zone
//                              id, or since 1.1.0 the domain, e.g. riyeser.com). The record is kept "DNS only" (grey
//                              cloud): Cloudflare's proxy can't carry SIP, TURN or call sound.
//   DDNS_PROVIDER=digitalocean DDNS_TOKEN (a token with domain write), DDNS_ZONE (the domain, e.g. riyeser.com)
//   DDNS_PROVIDER=namecheap    DDNS_HOST (relay, or relay2 for the backup), DDNS_DOMAIN (riyeser.com), DDNS_PASSWORD
//                              (the Dynamic DNS password from Namecheap → Advanced DNS → Dynamic DNS; NOT the account
//                              password). Needs an "A + Dynamic DNS Record" for the host at Namecheap.
// The token / password stays in relay.env on the relay machine (readable only by the relay and administrators); it is
// never logged, never in /health and never in an error message.
const API = { cloudflare: 'https://api.cloudflare.com/client/v4', digitalocean: 'https://api.digitalocean.com/v2' };
const NAMECHEAP = 'https://dynamicdns.park-your-domain.com/update';
const RETRY = 60 * 1000; // after a passing problem (no internet, Namecheap busy)

/** Namecheap's reply (XML, sometimes declared or sent as UTF-16) -> { ok, errors: [text] } */
function parseNamecheap(raw) {
  let text = raw;
  if (Buffer.isBuffer(raw)) {
    const le = raw[0] === 0xff && raw[1] === 0xfe; const be = raw[0] === 0xfe && raw[1] === 0xff;
    const zeros = raw.length > 3 && raw[1] === 0 && raw[3] === 0;
    if (be) { const b = Buffer.from(raw.subarray(2)); b.swap16(); text = b.toString('utf16le'); } else if (le || zeros) text = raw.subarray(le ? 2 : 0).toString('utf16le');
    else text = raw.toString('utf8');
  }
  text = String(text || '').replace(/^﻿/, '');
  const tag = (t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i').exec(text); return m ? m[1].trim() : null; };
  const count = tag('ErrCount');
  if (count == null) return { ok: false, errors: [], unreadable: true };
  const errors = [];
  const block = tag('errors') || '';
  for (const m of block.matchAll(/<Err\d+>([\s\S]*?)<\/Err\d+>/gi)) errors.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  return { ok: Number(count) === 0, errors };
}

/** Namecheap's error text -> a plain message for the log and the status, and whether retrying soon can help. */
function namecheapMessage(errors, host, domain) {
  const all = errors.join('; ');
  const name = host === '@' ? domain : `${host}.${domain}`;
  if (/password/i.test(all)) return { text: `Namecheap refused the Dynamic DNS password. Copy it again from Namecheap: Domain List → Manage ${domain} → Advanced DNS → Dynamic DNS (it is not your Namecheap account password).`, lasting: true };
  if (/record not found|no records updated|host.*not found|invalid host/i.test(all)) return { text: `Namecheap has no "A + Dynamic DNS Record" for ${name}. Add one with host "${host}" on Advanced DNS (Domain List → Manage ${domain}).`, lasting: true };
  if (/domain name not found|invalid domain|domain.*not (found|exist)|not.*dynamic/i.test(all)) return { text: `Namecheap doesn't know the domain ${domain} for Dynamic DNS. Check the spelling, that it's in this Namecheap account and uses Namecheap's DNS, and that Dynamic DNS is turned on (Advanced DNS → Dynamic DNS).`, lasting: true };
  if (/ip/i.test(all) && /invalid/i.test(all)) return { text: `Namecheap didn't accept the address (${all.slice(0, 120)}).`, lasting: false };
  return { text: `Namecheap said: ${all.slice(0, 160) || 'there was a problem (no details)'}.`, lasting: false };
}

class Ddns {
  /** opts: { provider, token, zone, name (relay.riyeser.com), host, domain, password (namecheap), ttl = 60, fetch, log, endpoint, retryMs } */
  constructor(opts = {}) {
    Object.assign(this, { provider: opts.provider, token: opts.token, zone: opts.zone, name: opts.name, ttl: opts.ttl || 60 });
    if (this.provider === 'namecheap') {
      let host = opts.host || ''; let domain = opts.domain || opts.zone || '';
      const name = String(opts.name || '');
      if (!domain && name.includes('.')) { const p = name.split('.'); domain = p.slice(-2).join('.'); if (!host) host = p.length > 2 ? p.slice(0, -2).join('.') : '@'; }
      if (!host && domain) host = name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : '@';
      Object.assign(this, { host, domain, password: opts.password || '', name: host === '@' ? domain : `${host}.${domain}` });
    }
    this.endpoint = opts.endpoint || NAMECHEAP; this.retryMs = opts.retryMs == null ? RETRY : opts.retryMs;
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.logFn = opts.log || (() => {}); this.last = null; this.state = { ok: null, at: null, error: null, name: this.name || null };
    this.lastError = null; this.retryTimer = null;
  }
  get enabled() {
    if (this.provider === 'namecheap') return !!(this.host && this.domain && this.password);
    return !!(API[this.provider] && this.token && this.zone && this.name);
  }
  /** never let the password or token into a message */
  clean(s) {
    let t = String(s || '');
    for (const v of [this.password, this.token]) if (v && v.length >= 4) { t = t.split(v).join('***'); t = t.split(encodeURIComponent(v)).join('***'); }
    return t.slice(0, 300);
  }
  async call(path, method = 'GET', body) {
    const r = await this.fetch(`${API[this.provider]}${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${this.provider} said ${r.status}${j && j.errors && j.errors[0] ? `: ${j.errors[0].message}` : ''}`);
    return j;
  }
  /** Cloudflare: DDNS_ZONE as given if it's a zone id, else (a domain, like riyeser.com) the id of the zone with that name. */
  async zoneId() {
    if (!String(this.zone).includes('.')) return this.zone;
    if (this.zoneIdFound) return this.zoneIdFound;
    const j = await this.call(`/zones?name=${encodeURIComponent(String(this.zone).toLowerCase())}`);
    const z = j.result && j.result[0];
    if (!z || !z.id) { const e = new Error(`Cloudflare has no zone ${this.zone} for this token (make the token with "Edit zone DNS" for ${this.zone})`); e.lasting = true; throw e; }
    this.zoneIdFound = z.id; return z.id;
  }
  async namecheap(ip) {
    const q = new URLSearchParams({ host: this.host, domain: this.domain, password: this.password, ip });
    let r;
    try { r = await this.fetch(`${this.endpoint}?${q}`, { method: 'GET', signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined }); } catch (e) {
      const err = new Error(`couldn't reach Namecheap (${(e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timed out' : 'no connection')})`); err.lasting = false; throw err;
    }
    const raw = r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
    if (!r.ok) { const err = new Error(`Namecheap answered ${r.status}; trying again soon`); err.lasting = false; throw err; }
    const p = parseNamecheap(raw);
    if (p.ok) return;
    if (p.unreadable) { const err = new Error('Namecheap sent an answer the relay couldn\'t read'); err.lasting = false; throw err; }
    const m = namecheapMessage(p.errors, this.host, this.domain);
    const err = new Error(m.text); err.lasting = m.lasting; throw err;
  }
  /** Make the A record say ip (force: even if it was set to that already, e.g. the 30-minute safety net).
   *  -> true when it changed (or, for Namecheap, set) something */
  async update(ip, { force = false } = {}) {
    if (!this.enabled || !ip || (ip === this.last && !force)) return false;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    try {
      if (this.provider === 'namecheap') {
        await this.namecheap(ip);
        if (ip !== this.last || this.state.ok !== true) this.logFn('info', `DNS: ${this.name} now points at ${ip} (Namecheap).`);
        this.last = ip; this.lastError = null; this.state = { ok: true, at: new Date().toISOString(), error: null, name: this.name };
        return true;
      }
      if (this.provider === 'cloudflare') {
        const z = encodeURIComponent(await this.zoneId());
        const found = await this.call(`/zones/${z}/dns_records?type=A&name=${encodeURIComponent(this.name)}`);
        const rec = found.result && found.result[0];
        if (rec && rec.content === ip && !rec.proxied) { this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null, name: this.name }; return false; }
        if (rec && rec.proxied) this.logFn('warn', `DNS: ${this.name} was proxied through Cloudflare (orange cloud); setting it to DNS only, as the relay's calls can't go through Cloudflare's proxy.`);
        const body = { type: 'A', name: this.name, content: ip, ttl: this.ttl, proxied: false };
        if (rec) await this.call(`/zones/${z}/dns_records/${rec.id}`, 'PUT', body); else await this.call(`/zones/${z}/dns_records`, 'POST', body);
      } else {
        const sub = this.name.endsWith(`.${this.zone}`) ? this.name.slice(0, -(this.zone.length + 1)) : '@';
        const found = await this.call(`/domains/${encodeURIComponent(this.zone)}/records?type=A&name=${encodeURIComponent(this.name)}`);
        const rec = found.domain_records && found.domain_records[0];
        if (rec && rec.data === ip) { this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null, name: this.name }; return false; }
        if (rec) await this.call(`/domains/${encodeURIComponent(this.zone)}/records/${rec.id}`, 'PATCH', { data: ip, ttl: this.ttl });
        else await this.call(`/domains/${encodeURIComponent(this.zone)}/records`, 'POST', { type: 'A', name: sub, data: ip, ttl: this.ttl });
      }
      this.logFn('info', `DNS: ${this.name} now points at ${ip}.`);
      this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null, name: this.name };
      return true;
    } catch (e) {
      const error = this.clean(e && e.message);
      const lasting = !!(e && e.lasting);
      this.state = { ok: false, at: new Date().toISOString(), error, name: this.name };
      // the same lasting problem every 30 minutes: say it once, then quietly keep trying
      if (error !== this.lastError) this.logFn('warn', `DNS: couldn't point ${this.name} at ${ip}: ${error}${lasting ? ' The relay tries again every 30 minutes, and at once when it restarts.' : ' Trying again in a minute.'}`);
      this.lastError = error;
      if (!lasting && this.retryMs) { this.retryTimer = setTimeout(() => { this.retryTimer = null; this.update(ip, { force: true }).catch(() => {}); }, this.retryMs); this.retryTimer.unref(); }
      return false;
    }
  }
  stop() { clearTimeout(this.retryTimer); this.retryTimer = null; }
}

module.exports = { Ddns, parseNamecheap, namecheapMessage, NAMECHEAP };
