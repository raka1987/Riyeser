// Riyeser PDF: your saved signatures and initials, kept on this PC only.
// Each picture is stored sealed with Electron's safeStorage (on Windows that is DPAPI: locked to this Windows user
// account), the same way Riyeser Link Office keeps its passwords. Where the PC has no way to do that (some Linux
// desktops), it is kept as it is, and status().protected says so.
// A signature saved before 0.26.0 (in the clear) is sealed the first time the list is read.
//   { id, kind: 'signature' | 'initials', sealed: 'enc:...' | 'plain:...', default?: true, at }

const KINDS = ['signature', 'initials'];
const MAX_PER_KIND = 10;

/** seal/unseal: strings in, strings out (see makeSealer). */
function createSignatureStore({ store, seal, unseal, isProtected = () => true, key = 'signatures' }) {
  const read = () => store.get(key, []);
  const write = (list) => store.set(key, list);
  // older copies: { id, data } in the clear -> sealed signatures
  function migrate() {
    const list = read();
    if (!list.some((s) => typeof s.data === 'string')) return list;
    return write(list.map((s) => (typeof s.data === 'string'
      ? { id: s.id, kind: KINDS.includes(s.kind) ? s.kind : 'signature', sealed: seal(s.data), at: s.at || null }
      : s)));
  }
  const open = (s) => { try { return unseal(s.sealed); } catch { return null; } };
  return {
    /** Every saved one that can be opened on this PC (newest first): { id, kind, data, isDefault } */
    list(kind = null) {
      const all = migrate().filter((s) => !kind || s.kind === kind);
      const out = [];
      for (const s of all) { const data = open(s); if (data) out.push({ id: s.id, kind: s.kind, data, isDefault: !!s.default }); }
      // the first of each kind is the default when none is marked
      for (const k of KINDS) if (!out.some((s) => s.kind === k && s.isDefault)) { const f = out.find((s) => s.kind === k); if (f) f.isDefault = true; }
      return out;
    },
    /** The one "My signature" / "My initials" places with one click (null when there's none yet). */
    getDefault(kind = 'signature') { return this.list(kind).find((s) => s.isDefault) || null; },
    save({ kind = 'signature', data, makeDefault = true }) {
      if (!KINDS.includes(kind)) throw new Error('Unknown kind of signature.');
      if (!/^data:image\/(png|jpeg);base64,/.test(String(data || ''))) throw new Error('That isn\'t a signature picture.');
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const list = migrate().map((s) => (makeDefault && s.kind === kind ? { ...s, default: false } : s));
      const mine = list.filter((s) => s.kind === kind);
      const others = list.filter((s) => s.kind !== kind);
      write([{ id, kind, sealed: seal(data), default: !!makeDefault, at: new Date().toISOString() }, ...mine.slice(0, MAX_PER_KIND - 1), ...others]);
      return id;
    },
    setDefault(id) {
      const list = migrate(); const t = list.find((s) => s.id === id);
      if (!t) throw new Error('That signature isn\'t saved any more.');
      write(list.map((s) => (s.kind === t.kind ? { ...s, default: s.id === id } : s)));
      return true;
    },
    remove(id) { write(migrate().filter((s) => s.id !== id)); return true; },
    status() { return { protected: !!isProtected(), count: migrate().length }; },
  };
}

/** seal/unseal with Electron's safeStorage when the PC supports it (Windows: DPAPI), otherwise kept as is. */
function makeSealer(safeStorage) {
  const can = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };
  return {
    isProtected: can,
    seal: (s) => (can() ? `enc:${safeStorage.encryptString(String(s)).toString('base64')}` : `plain:${s}`),
    unseal: (v) => {
      const t = String(v || '');
      if (t.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(t.slice(4), 'base64'));
      if (t.startsWith('plain:')) return t.slice(6);
      return null;
    },
  };
}

module.exports = { createSignatureStore, makeSealer, KINDS };
