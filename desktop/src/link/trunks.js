// Trunks and links: the seam where Riyeser Link Office reaches beyond this office network. Since 1.3.0 the Riyeser
// relay (relay.js) is one: the Office Link keeps one OUTGOING connection to it (so no router changes are needed), and
// the business's other sites and phones at home reach office extensions through it.
//
// A trunk is an object with:
//   id, name
//   start({ pbx, log })        open its outgoing connection; SIP it receives is handed to pbx.receive(buf, src) with
//                              src = { proto: 'TRUNK', trunk: id, address, port } and trusted as coming from the trunk
//   stop()
//   status()                   -> { connected: bool, detail: 'plain words' }
//   route(number, { members }) -> { dest, uri } when this trunk can reach a number (or, for a group, one of its
//                              members) that has a phone somewhere else, else null
//   send(buf, dest)            send SIP out over the trunk (dest.proto === 'TRUNK')
//   owns(uri)                  (optional) -> dest when a Route / Request-URI points at this trunk (calls in progress)
//   wasRemote(number)          (optional) the number was reachable through it before it went away
// Phones here always ring here; the trunk is asked as well (a person may have a phone at another site or at home).
// Calls that came in over a trunk are never sent back out (no loops).
class Trunks {
  constructor() { this.list = new Map(); }
  add(trunk) {
    for (const k of ['id', 'start', 'stop', 'status', 'route', 'send']) if (!(k in trunk)) throw new Error(`A trunk needs ${k}`);
    this.list.set(trunk.id, trunk);
    return trunk;
  }
  remove(id) { const t = this.list.get(id); if (t) { this.list.delete(id); return Promise.resolve(t.stop()); } return Promise.resolve(); }
  all() { return [...this.list.values()]; }
  async startAll(ctx) { for (const t of this.all()) { try { await t.start(ctx); } catch (e) { ctx.log && ctx.log('warn', `${t.name || t.id}: ${e.message}`); } } }
  async stopAll() { for (const t of this.all()) { try { await t.stop(); } catch { /* closing anyway */ } } }
  /** The first trunk that can reach this number: { trunk, dest, uri } or null. */
  route(number, opts = {}) {
    for (const t of this.all()) { const r = t.route(number, opts); if (r) return { trunk: t, ...r }; }
    return null;
  }
  status() { return this.all().map((t) => ({ id: t.id, name: t.name || t.id, ...t.status() })); }
}

module.exports = { Trunks };
