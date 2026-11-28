// Riyeser Link Office and the website's Phones page: the heartbeat (and that it never carries call details or
// passwords), changes from the website (give a phone, add one, new password, Do not disturb), Show password
// (encrypted to the browser's one-off key), and carrying on as normal with no internet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../src/core/store');
const { PhoneService } = require('../src/link/service');
const { LinkCloud, buildPayload, applyCommand, sealFor } = require('../src/link/cloud');
const { SimUA } = require('../src/link/simua');
const { tmp, rmTmp, until } = require('./link-helpers');

const on = () => ({ active: true, state: 'trial', text: 'Free trial · 40 days left' });
function make({ company = true } = {}) {
  const dir = tmp(); const appData = tmp('appdata');
  if (company) {
    fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Sample Trading Co', mode: 'online', workspace_id: 'ws-1' }));
  }
  const store = new Store(dir);
  const svc = new PhoneService({ store, appData, host: '127.0.0.1', sipPort: 0, httpPort: 0, bind: '127.0.0.1', tcp: false, multicast: false, licence: on });
  svc.addPerson({ name: 'Alex Sample', ext: '101' });
  svc.addPerson({ name: 'Bo Example', ext: '102' });
  svc.directory.addGroup({ name: 'Front desk', ext: '200', members: ['101', '102'] });
  return { dir, appData, store, svc, close: async () => { await svc.stop(); rmTmp(dir); rmTmp(appData); } };
}
/** A pretend Riyeser Link online: records what's sent, hands out waiting changes. */
function fakeOnline() {
  const f = { session: { access_token: 'x' }, sent: [], pending: [], done: [], down: false };
  f.rpc = async (name, args) => {
    if (f.down) throw new Error('Can\'t reach Riyeser Online. Check the internet connection.');
    f.sent.push({ name, args });
    if (name === 'link_office_report') return { ok: true, pending: f.pending.length };
    if (name === 'link_office_pending') { const p = f.pending; f.pending = []; return p; }
    if (name === 'link_office_done') { f.done.push(args); return null; }
    throw new Error(`unexpected ${name}`);
  };
  return f;
}

test('the heartbeat: address, licence, counts, phones and extensions, and never call details or passwords', async () => {
  const t = make();
  try {
    await t.svc.start();
    t.svc.assign('001565aabbcc', '101');
    t.svc.devices().seen('000b82112233', { vendor: 'grandstream', model: 'GRP2601P', ip: '192.168.1.40' });   // a new phone found
    const ua = await new SimUA({ ext: '101', password: t.svc.directory.password('101'), server: { host: '127.0.0.1', port: t.svc.pbx.port } }).start();
    await ua.register();
    const ub = await new SimUA({ ext: '102', password: t.svc.directory.password('102'), server: { host: '127.0.0.1', port: t.svc.pbx.port }, userAgent: 'Riyeser Link 1.2' }).start();
    await ub.register();
    try {
      const st = t.svc.status();
      const p = buildPayload({ ...st, inProgress: [{ from: '101', fromName: 'Alex Sample', to: '102', toName: 'Bo Example', state: 'talking', start: '2026-11-24T09:00:00Z' }],
        recent: [{ from: '101', to: '0412345678', result: 'answered' }] }, { officeId: 'lo-test-0001', pcName: 'OFFICE-PC', version: '1.1.0', adapters: t.svc.adapters() });
      assert.strictEqual(p.office_id, 'lo-test-0001');
      assert.strictEqual(p.pc_name, 'OFFICE-PC'); assert.strictEqual(p.version, '1.1.0');
      assert.strictEqual(p.addresses[0], '127.0.0.1', 'the address phones use comes first (other office adapters follow)');
      assert.strictEqual(p.sip_port, t.svc.pbx.port);
      assert.strictEqual(p.address_stable, true);
      assert.deepStrictEqual(p.licence, { active: true, state: 'trial', text: 'Free trial · 40 days left' });
      assert.strictEqual(p.counts.people, 2); assert.strictEqual(p.counts.groups, 1);
      assert.strictEqual(p.counts.phones_assigned, 1); assert.strictEqual(p.counts.new_phones, 1);
      assert.strictEqual(p.counts.calls_in_progress, 1, 'calls: a count only');
      assert.strictEqual(p.counts.app_users, 1);
      const found = p.phones.find((x) => x.mac === '000b82112233');
      assert.deepStrictEqual([found.assigned, found.vendor, found.model, found.ip], [false, 'Grandstream', 'GRP2601P', '192.168.1.40']);
      const desk = p.phones.find((x) => x.mac === '001565aabbcc');
      assert.deepStrictEqual([desk.assigned, desk.extension, desk.vendor], [true, '101', 'Yealink']);
      const e101 = p.extensions.find((x) => x.extension === '101');
      assert.deepStrictEqual([e101.name, e101.type, e101.registered, e101.desk_phones, e101.app_users], ['Alex Sample', 'person', 1, 1, 0]);
      assert.strictEqual(p.extensions.find((x) => x.extension === '102').app_users, 1);
      assert.deepStrictEqual(p.extensions.filter((x) => x.type === 'person').map((x) => [x.extension, x.in_call]), [['101', true], ['102', true]], 'On a call: yes or no per extension');
      assert.strictEqual(buildPayload({ ...st, inProgress: [{ from: '101', to: '102', state: 'ringing' }] }, { officeId: 'lo-test-0001' }).extensions.find((x) => x.extension === '102').in_call, false, 'ringing isn\'t on a call yet');
      assert.deepStrictEqual(p.extensions.find((x) => x.extension === '200'), { extension: '200', name: 'Front desk', type: 'group', members: 2 });
      // nothing about calls (who, whom, numbers dialled), recordings, the log or passwords
      const text = JSON.stringify(p);
      for (const pw of [t.svc.directory.password('101'), t.svc.directory.password('102')]) assert.ok(!text.includes(pw), 'no password');
      for (const bad of ['0412345678', 'talking', 'answered', 'inProgress', 'recent', 'logs', 'password', 'userAgent', 'start"']) assert.ok(!text.includes(bad), bad);
      assert.deepStrictEqual(Object.keys(p).sort(), ['address_changes', 'address_stable', 'addresses', 'counts', 'extensions', 'licence', 'mdns_name', 'office_id', 'pc_mac', 'pc_name', 'phone_server', 'phones', 'router_name', 'sip_port', 'state', 'version']);
    } finally { await ua.stop(); await ub.stop(); }
  } finally { await t.close(); }
});

test('changes from the website: give a phone, add one by MAC, take it off, new password, Do not disturb', () => {
  const t = make();
  try {
    t.svc.devices().seen('000b82112233', { vendor: 'grandstream', model: 'GRP2601P', ip: '192.168.1.40' });
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c1', kind: 'assign_phone', data: { mac: '000b82112233', extension: '102' } }), { ok: true });
    assert.strictEqual(t.svc.provisionerData().phones.find((p) => p.mac === '000b82112233').ext, '102');
    assert.strictEqual(t.svc.provisionerData().found.length, 0, 'no longer a new phone');
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c2', kind: 'add_phone', data: { mac: '000413445566', vendor: 'snom', extension: '101' } }), { ok: true });
    assert.strictEqual(t.svc.provisionerData().phones.find((p) => p.mac === '000413445566').vendor, 'snom');
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c3', kind: 'unassign_phone', data: { mac: '000413445566' } }), { ok: true });
    assert.ok(!t.svc.provisionerData().phones.some((p) => p.mac === '000413445566'));
    const before = t.svc.directory.password('101');
    const r = applyCommand(t.svc, { id: 'c4', kind: 'new_password', data: { extension: '101' } });
    assert.deepStrictEqual(r, { ok: true }, 'the new password is never sent back');
    assert.notStrictEqual(t.svc.directory.password('101'), before);
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c5', kind: 'set_dnd', data: { extension: '102', on: true } }), { ok: true });
    assert.strictEqual(t.svc.directory.dnd('102'), true);
    applyCommand(t.svc, { id: 'c6', kind: 'set_dnd', data: { extension: '102', on: false } });
    assert.strictEqual(t.svc.directory.dnd('102'), false);
    // plain reasons when it can't
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c7', kind: 'assign_phone', data: { mac: '000b82112233', extension: '555' } }), { ok: false, error: 'No one has extension 555 on Riyeser Link Office.' });
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'c8', kind: 'unassign_phone', data: { mac: '001565999999' } }), { ok: false, error: 'That phone isn\'t given to anyone.' });
    assert.match(applyCommand(t.svc, { id: 'c9', kind: 'format_disk', data: {} }).error, /doesn't know how to do that yet/);
    assert.ok(!JSON.stringify(t.svc.logs).includes(t.svc.directory.password('101')), 'the log never has a password');
  } finally { t.close(); }
});

test('Desk phones list: name_phone (name, location, note), provisioned_at and calls_made in the heartbeat, and Replace phone', () => {
  const t = make();
  try {
    t.svc.assign('001565aabbcc', '101');
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'n1', kind: 'name_phone', data: { mac: '00:15:65:AA:BB:CC', name: ' Reception<b> ', branch: 'Head office', note: 'S/N BP78459236' } }), { ok: true });
    const ph = t.svc.provisionerData().phones.find((p) => p.mac === '001565aabbcc');
    assert.deepStrictEqual([ph.label, ph.location, ph.note], ['Receptionb', 'Head office', 'S/N BP78459236'], 'kept in phone-devices.json, tidied');
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'n2', kind: 'name_phone', data: { mac: '001565999999', name: 'Nope' } }), { ok: false, error: 'That phone isn\'t given to anyone yet.' });
    assert.strictEqual(applyCommand(t.svc, { id: 'n3', kind: 'name_phone', data: { mac: 'nonsense', name: 'Nope' } }).ok, false);
    // giving the phone again (e.g. to someone else) keeps its name
    t.svc.assign('001565aabbcc', '102');
    assert.strictEqual(t.svc.provisionerData().phones.find((p) => p.mac === '001565aabbcc').label, 'Receptionb');
    // the phone fetched its settings: provisioned_at in the heartbeat
    t.svc.devices().logFetch({ mac: '001565aabbcc', ip: '192.168.1.31', file: '001565aabbcc.cfg', ok: true });
    const p = buildPayload({ ...t.svc.status(), recent: [{ result: 'answered' }, { result: 'missed' }, { result: 'answered' }] }, { officeId: 'lo-test-0001' });
    const row = p.phones.find((x) => x.mac === '001565aabbcc');
    assert.deepStrictEqual([row.name, row.location, row.note], ['Receptionb', 'Head office', 'S/N BP78459236']);
    assert.ok(row.provisioned_at && Date.now() - Date.parse(row.provisioned_at) < 60000, 'last settings fetch');
    assert.strictEqual(p.counts.calls_made, 2, 'answered calls: a count only');
    assert.ok(!JSON.stringify(p).includes('missed'), 'no call details');
    // Replace phone (on the office PC): same extension, name and location; the old one stops getting settings
    const r = t.svc.replacePhone('001565aabbcc', '00:15:65:12:34:56');
    assert.deepStrictEqual([r.ext, r.label, r.location], ['102', 'Receptionb', 'Head office']);
    assert.ok(!t.svc.provisionerData().phones.some((x) => x.mac === '001565aabbcc'), 'old phone off');
    assert.strictEqual(t.svc.provisionerData().phones.find((x) => x.mac === '001565123456').ext, '102');
    assert.throws(() => t.svc.replacePhone('001565123456', '001565123456'), /same phone/);
    assert.throws(() => t.svc.replacePhone('001565123456', 'bad'), /isn't a MAC address/);
    // from the website, Replace phone is two changes in a row: take the old one off, give the new one the same extension
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'x1', kind: 'unassign_phone', data: { mac: '001565123456' } }), { ok: true });
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'x2', kind: 'add_phone', data: { mac: '000b82112233', extension: '102' } }), { ok: true });
    assert.deepStrictEqual(applyCommand(t.svc, { id: 'x3', kind: 'name_phone', data: { mac: '000b82112233', name: 'Receptionb', branch: 'Head office' } }), { ok: true });
    assert.strictEqual(t.svc.status().phones.find((x) => x.mac === '000b82112233').label, 'Receptionb');
  } finally { t.close(); }
});

test('Show password: encrypted to the browser\'s one-off key, so only that browser can read it', () => {
  const t = make();
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const r = applyCommand(t.svc, { id: 'r1', kind: 'reveal_password', data: { extension: '101', key: { kty: 'RSA', alg: 'RSA-OAEP-256', n: jwk.n, e: jwk.e } } });
    assert.strictEqual(r.ok, true);
    const pw = t.svc.directory.password('101');
    assert.ok(!r.sealed.includes(pw) && !Buffer.from(r.sealed, 'base64').toString('latin1').includes(pw), 'not readable as sent');
    const plain = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(r.sealed, 'base64')).toString('utf8');
    assert.strictEqual(plain, pw);
    assert.ok(!JSON.stringify(t.svc.logs).includes(pw), 'not in the log');
    // no key, or a weak one: refused
    assert.strictEqual(applyCommand(t.svc, { id: 'r2', kind: 'reveal_password', data: { extension: '101' } }).ok, false);
    const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
    assert.match(applyCommand(t.svc, { id: 'r3', kind: 'reveal_password', data: { extension: '101', key: weak } }).error, /too weak/);
    assert.throws(() => sealFor({ kty: 'EC' }, 'x'), /didn't send a key/);
  } finally { t.close(); }
});

test('heartbeat and changes through Riyeser Link online; no internet: the phones carry on and it waits', async () => {
  const t = make();
  const online = fakeOnline();
  const cloud = new LinkCloud({ service: t.svc, clients: () => [online], appData: t.appData, version: '1.1.0', pcName: 'OFFICE-PC' });
  try {
    await t.svc.start();
    const r = await cloud.report('test');
    assert.deepStrictEqual(r, { ok: true, pending: 0 });
    const sent = online.sent[0];
    assert.strictEqual(sent.name, 'link_office_report');
    assert.strictEqual(sent.args.ws, 'ws-1');
    assert.match(sent.args.office_id, /^lo-[0-9a-f-]{36}$/);
    assert.strictEqual(sent.args.office_id, t.svc.officeId(), 'the same id every time');
    assert.strictEqual(cloud.state.status, 'online');
    // a change waiting on the website: done, marked done, then reported again
    t.svc.devices().seen('000b82112233', { vendor: 'grandstream', model: '', ip: '192.168.1.40' });
    online.pending = [{ id: 'c1', kind: 'assign_phone', data: { mac: '000b82112233', extension: '101' } }, { id: 'c2', kind: 'set_dnd', data: { extension: '999', on: true } }];
    assert.strictEqual(await cloud.poll(), 2);
    assert.deepStrictEqual(online.done, [{ command: 'c1', ok: true, error: null, sealed: null }, { command: 'c2', ok: false, error: 'No one has extension 999 on Riyeser Link Office.', sealed: null }]);
    assert.strictEqual(online.sent.filter((x) => x.name === 'link_office_report').length, 2, 'reported again after the changes');
    assert.ok(online.sent[online.sent.length - 1].args.payload.phones.some((p) => p.mac === '000b82112233' && p.assigned));
    // no internet: nothing throws, the state says so, the phone system keeps running and the next try works
    online.down = true;
    const off = await cloud.report('test');
    assert.strictEqual(off.ok, false); assert.strictEqual(cloud.state.status, 'offline');
    assert.strictEqual(await cloud.poll(), 0);
    assert.strictEqual(t.svc.status().state, 'running');
    const ua = await new SimUA({ ext: '101', password: t.svc.directory.password('101'), server: { host: '127.0.0.1', port: t.svc.pbx.port } }).start();
    try { await ua.register(); assert.ok(t.svc.status().people.find((p) => p.ext === '101').connected, 'phones still connect offline'); } finally { await ua.stop(); }
    online.down = false;
    assert.strictEqual((await cloud.report('test')).ok, true);
    assert.strictEqual(cloud.state.status, 'online');
    // an older online database (no link_ functions yet): it backs off quietly
    const old = { session: {}, rpc: async () => { throw new Error('Could not find the function public.link_office_report(office_id, payload, ws) in the schema cache'); } };
    const c2 = new LinkCloud({ service: t.svc, clients: () => [old], appData: t.appData });
    assert.strictEqual((await c2.report()).ok, false);
    assert.strictEqual(c2.state.status, 'not-yet');
  } finally { cloud.stop(); await t.close(); }
});

test('not linked to a business, or not signed in: the phones only show on this PC', async () => {
  const t = make({ company: false });
  try {
    const online = fakeOnline();
    const cloud = new LinkCloud({ service: t.svc, clients: () => [online], appData: t.appData });
    assert.strictEqual((await cloud.report()).ok, false);
    assert.strictEqual(cloud.state.status, 'local');
    assert.strictEqual(online.sent.length, 0);
  } finally { await t.close(); }
  const u = make();
  try {
    const cloud = new LinkCloud({ service: u.svc, clients: () => [{ session: null, rpc: async () => { throw new Error('should not be called'); } }], appData: u.appData });
    const r = await cloud.report();
    assert.strictEqual(r.ok, false); assert.match(r.error, /Sign in to your Riyeser account/);
  } finally { await u.close(); }
});

test('a change on this PC (a phone given to someone) is reported within seconds', async () => {
  const t = make();
  const online = fakeOnline();
  const cloud = new LinkCloud({ service: t.svc, clients: () => [online], appData: t.appData });
  try {
    await cloud.report('start');
    cloud.lastReportAt = 0;
    cloud.start();
    t.svc.assign('001565aabbcc', '102');
    await until(() => online.sent.filter((x) => x.name === 'link_office_report').length >= 2, 9000);
  } finally { cloud.stop(); await t.close(); }
});

test('SEC-004: refused by Riyeser online (not the owner/admin, or not the PC that reports) says so plainly; phones carry on', async () => {
  const { isRefusal } = require('../src/link/cloud');
  const T = require('../src/renderer/link-text');
  const t = make();
  const DB_MSG = 'Sign in to Riyeser Link Office as the business\'s owner or an admin, or link this PC to the business in Riyeser Central.';
  const mk = (msg, status = 400) => ({ session: { access_token: 'x' }, rpc: async () => { const e = new Error(msg); e.status = status; throw e; } });
  try {
    await t.svc.start();
    for (const [client, want] of [[mk(DB_MSG), DB_MSG], [mk('permission denied for function link_office_report', 403), /isn't allowed to run the phones for this business\. Sign in .* owner or an admin/],
      [mk('That change isn\'t for this business.'), 'That change isn\'t for this business.']]) {
      const cloud = new LinkCloud({ service: t.svc, clients: () => [client], appData: t.appData });
      const r = await cloud.report('test');                     // link_office_report
      assert.strictEqual(r.ok, false); assert.strictEqual(cloud.state.status, 'refused');
      if (typeof want === 'string') assert.strictEqual(cloud.state.error, want); else assert.match(cloud.state.error, want);
      assert.strictEqual(await cloud.poll(), 0);                // link_office_pending / done
      assert.strictEqual(cloud.state.status, 'refused');
      const line = T.cloud(cloud.state);
      assert.match(line, /^This PC can't update the Phones page on riyeser\.com\/link: .+\. The phones here work as normal\.$/);
      assert.doesNotMatch(line, /Can't reach|undefined|\.\./);
      assert.strictEqual(await cloud.relayReport(true), false);  // link_relay_report: quietly not sent, never throws
      cloud.stop();
    }
    // link_relay_token refused: a plain error marked refused, and an old saved pass is NOT used instead
    t.svc.store.set('phone-relay', { enabled: true, relays: [{ id: 'r1', host: 'relay.example' }], tokens: { r1: 'old' }, exp: Math.floor(Date.now() / 1000) + 3600 });
    const relayClient = { session: { access_token: 'x' }, rpc: async (name) => { if (name === 'link_relay_config') return { enabled: true, relays: [{ id: 'r1' }] }; const e = new Error(DB_MSG); e.status = 400; throw e; } };
    const c3 = new LinkCloud({ service: t.svc, clients: () => [relayClient], appData: t.appData });
    await assert.rejects(c3.relayConfig(), (e) => e.refused === true && e.message === DB_MSG);
    assert.ok(isRefusal({ status: 403, message: '' })); assert.ok(!isRefusal(new Error('Can\'t reach Riyeser Online. Check the internet connection.')));
    // the relay card shows it as refused with the reason (not "Not used")
    const tile = T.relayTile({ state: 'refused', error: DB_MSG.replace(/\.$/, '') });
    assert.strictEqual(tile.big, 'Refused by the relay'); assert.ok(tile.text.includes('owner or an admin'));
    assert.strictEqual(t.svc.status().state, 'running', 'the phone system keeps running');
  } finally { await t.close(); }
});
