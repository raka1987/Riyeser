// The relay and Riyeser online (Supabase): every 30 seconds the relay calls relay_sync with the public key and a
// signature made with the relay secret. It reports its version, public IP and counts (never call details) and gets
// the plan back: for each business with the relay switched on, its offices (pass generation, revoked), remote phones
// (username, extension, HA1 — never a password), ring groups; and the other relays of the cluster.
// With no answer it carries on with the last plan.
const { syncSig } = require('./tokens');

class CloudSync {
  /** opts: { url (Supabase), key (publishable key), relayId, secret, fetch, every = 30 s, info: () => object, log } */
  constructor(opts = {}) {
    Object.assign(this, { url: String(opts.url || '').replace(/\/+$/, ''), key: opts.key, relayId: opts.relayId, secret: opts.secret, every: opts.every || 30000 });
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.info = opts.info || (() => ({})); this.logFn = opts.log || (() => {});
    this.state = { ok: null, at: null, error: null, yourIp: null }; this.timer = null;
  }
  get enabled() { return !!(this.url && this.key && this.relayId && this.secret); }
  async sync() {
    const ts = Math.floor(Date.now() / 1000);
    const body = { relay: this.relayId, ts, sig: syncSig(this.secret, this.relayId, ts), info: this.info() };
    const r = await this.fetch(`${this.url}/rest/v1/rpc/relay_sync`, { method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) throw new Error((j && (j.message || j.error)) || `Riyeser online said ${r.status}`);
    this.state = { ok: true, at: new Date().toISOString(), error: null, yourIp: j.your_ip || null };
    return j;
  }
  /** Sync now and then every 30 s; onPlan(result) for each answer. */
  start(onPlan) {
    const run = async () => {
      try { const j = await this.sync(); await onPlan(j); }
      catch (e) {
        const was = this.state.error; this.state = { ...this.state, ok: false, error: String(e.message).slice(0, 200) };
        if (was !== this.state.error) this.logFn('warn', `Riyeser online: ${this.state.error}. Carrying on with the last plan.`);
      }
    };
    this.timer = setInterval(run, this.every); this.timer.unref && this.timer.unref();
    return run();
  }
  stop() { clearInterval(this.timer); }
}

module.exports = { CloudSync };
