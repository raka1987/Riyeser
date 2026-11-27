// The relay's own dynamic DNS: when its public IP changes (own-hardware mode), it points its name (relay.riyeser.com)
// at the new address itself, through the DNS provider's own API. No separate DDNS service.
//   DDNS_PROVIDER=cloudflare   DDNS_TOKEN (an API token with Zone → DNS → Edit for that zone only), DDNS_ZONE (zone id)
//   DDNS_PROVIDER=digitalocean DDNS_TOKEN (a token with domain write), DDNS_ZONE (the domain, e.g. riyeser.com)
// The token stays in /etc/riyeser-relay/relay.env on the relay machine (chmod 600); it is never logged.
const API = { cloudflare: 'https://api.cloudflare.com/client/v4', digitalocean: 'https://api.digitalocean.com/v2' };

class Ddns {
  /** opts: { provider, token, zone, name (relay.riyeser.com), ttl = 60, fetch, log } */
  constructor(opts = {}) {
    Object.assign(this, { provider: opts.provider, token: opts.token, zone: opts.zone, name: opts.name, ttl: opts.ttl || 60 });
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.logFn = opts.log || (() => {}); this.last = null; this.state = { ok: null, at: null, error: null };
  }
  get enabled() { return !!(API[this.provider] && this.token && this.zone && this.name); }
  async call(path, method = 'GET', body) {
    const r = await this.fetch(`${API[this.provider]}${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${this.provider} said ${r.status}${j && j.errors && j.errors[0] ? `: ${j.errors[0].message}` : ''}`);
    return j;
  }
  /** Make the A record say ip. -> true when it changed something */
  async update(ip) {
    if (!this.enabled || !ip || ip === this.last) return false;
    try {
      if (this.provider === 'cloudflare') {
        const z = encodeURIComponent(this.zone);
        const found = await this.call(`/zones/${z}/dns_records?type=A&name=${encodeURIComponent(this.name)}`);
        const rec = found.result && found.result[0];
        if (rec && rec.content === ip) { this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null }; return false; }
        const body = { type: 'A', name: this.name, content: ip, ttl: this.ttl, proxied: false };
        if (rec) await this.call(`/zones/${z}/dns_records/${rec.id}`, 'PUT', body); else await this.call(`/zones/${z}/dns_records`, 'POST', body);
      } else {
        const sub = this.name.endsWith(`.${this.zone}`) ? this.name.slice(0, -(this.zone.length + 1)) : '@';
        const found = await this.call(`/domains/${encodeURIComponent(this.zone)}/records?type=A&name=${encodeURIComponent(this.name)}`);
        const rec = found.domain_records && found.domain_records[0];
        if (rec && rec.data === ip) { this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null }; return false; }
        if (rec) await this.call(`/domains/${encodeURIComponent(this.zone)}/records/${rec.id}`, 'PATCH', { data: ip, ttl: this.ttl });
        else await this.call(`/domains/${encodeURIComponent(this.zone)}/records`, 'POST', { type: 'A', name: sub, data: ip, ttl: this.ttl });
      }
      this.logFn('info', `DNS: ${this.name} now points at ${ip}.`);
      this.last = ip; this.state = { ok: true, at: new Date().toISOString(), error: null };
      return true;
    } catch (e) {
      this.state = { ok: false, at: new Date().toISOString(), error: String(e.message).slice(0, 200) };
      this.logFn('warn', `DNS: couldn't point ${this.name} at ${ip} (${this.state.error}). Trying again in a minute.`);
      return false;
    }
  }
}

module.exports = { Ddns };
