// Trunks and links: the seam where Riyeser Link: Office will reach beyond this office network. Nothing uses it yet.
//
// The next step is a Riyeser relay. The Office Link keeps one OUTGOING connection to it (so no router changes are
// needed), and remote Riyeser Team users and other branches' Links reach office extensions through it. Riyeser
// Link: Cloud will be the same idea with the phone system itself hosted by Riyeser.
//
// A trunk is an object with:
//   id, name
//   start({ pbx, log })        open its outgoing connection; SIP it receives is handed to pbx.receive(buf, src) with
//                              src = { proto: 'TRUNK', trunk: id, address, port } and trusted as coming from the trunk
//   stop()
//   status()                   -> { connected: bool, detail: 'plain words' }
//   route(number)              -> { dest, uri } when this trunk can reach a number that isn't on this PC, else null
//   send(buf, dest)            send SIP out over the trunk (dest.proto === 'TRUNK')
// The PBX asks route() only for numbers its own dial plan doesn't know, so office extensions always stay local.
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
  route(number) {
    for (const t of this.all()) { const r = t.route(number); if (r) return { trunk: t, ...r }; }
    return null;
  }
  status() { return this.all().map((t) => ({ id: t.id, name: t.name || t.id, ...t.status() })); }
}

module.exports = { Trunks };
