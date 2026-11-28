// QA pass (independent checks) for Riyeser Link Office: SIP passwords are never written to the log or kept in plain
// text when the PC can seal them, extension numbers can't be used twice, and a ring group rings only its members.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/core/store');
const { Directory, mapTeam } = require('../src/link/directory');
const { Pbx } = require('../src/link/pbx');
const { SimUA } = require('../src/link/simua');
const { tmp, rmTmp, wait, until } = require('./link-helpers');

const seal = (s) => `enc:${Buffer.from(s).toString('base64').split('').reverse().join('')}`;
const unseal = (s) => Buffer.from(String(s).slice(4).split('').reverse().join(''), 'base64').toString();

test('QA-LO-01 SIP passwords: sealed at rest, never in the log (right or wrong password), the wrong one is not echoed back', async () => {
  const dir = tmp('qa-lo'); const lines = [];
  try {
    const directory = new Directory(new Store(dir), { seal, unseal });
    directory.addPerson({ name: 'Ana Sample', ext: '101' });
    const pw = directory.password('101');
    assert.match(pw, /^.{16}$/);
    const onDisk = fs.readdirSync(dir).map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } }).join('\n');
    assert.ok(!onDisk.includes(pw), 'the password is not stored in plain text');
    const pbx = await new Pbx({ directory, host: '127.0.0.1', port: 0, bind: '127.0.0.1', tcp: false, multicast: false, log: (l, t) => lines.push(`${l} ${t}`) }).start();
    const good = await new SimUA({ ext: '101', password: pw, server: { host: '127.0.0.1', port: pbx.port } }).start();
    const bad = await new SimUA({ ext: '101', password: 'Wr0ngGuess-777', server: { host: '127.0.0.1', port: pbx.port } }).start();
    try {
      assert.strictEqual((await good.register()).status, 200);
      const r = await bad.register();
      assert.strictEqual(r.status, 403);
      assert.ok(!JSON.stringify(r).includes('Wr0ngGuess-777'));
      await wait(50);
      const log = lines.join('\n');
      assert.ok(lines.length > 0);
      assert.ok(!log.includes(pw) && !log.includes('Wr0ngGuess-777'), log);
      assert.ok(!JSON.stringify(pbx.snapshot()).includes(pw), 'the status sent to the screen has no passwords');
    } finally { await good.stop(); await bad.stop(); await pbx.stop(); }
  } finally { rmTmp(dir); }
});

test('QA-LO-02 extension duplicates: by hand, from Riyeser Link (people and ring groups), emergency numbers', () => {
  const dir = tmp('qa-lo');
  try {
    const d = new Directory(new Store(dir));
    d.addPerson({ name: 'Ana Sample', ext: '101' });
    assert.throws(() => d.addPerson({ name: 'Ben Sample', ext: '101' }), /already used/);
    d.addGroup({ name: 'Sales', ext: '300', members: ['101'] });
    assert.throws(() => d.addPerson({ name: 'Cy Sample', ext: '300' }), /already used/);
    assert.throws(() => d.addGroup({ name: 'Sales 2', ext: '300' }), /already used/);
    assert.throws(() => d.addPerson({ name: 'Dee Sample', ext: '000' }), /emergency|3 digits/);
    assert.strictEqual(d.addPerson({ name: 'Eve Sample' }).ext, '102'); // next free
    const m = mapTeam({ members: [{ user_id: 'u1', display_name: 'One', extension: 105 }, { user_id: 'u2', display_name: 'Two', extension: 105 }, { user_id: 'u3', display_name: 'Three', extension: 300 }],
      ringGroups: [{ id: 'g1', name: 'Sales', extension: 300, members: [{ user_id: 'u1' }] }] });
    assert.deepStrictEqual(m.people.map((p) => p.ext), ['105']);
    assert.ok(m.skipped.some((s) => s.name === 'Two' && /already used/.test(s.why)));
    assert.ok(m.skipped.some((s) => s.name === 'Three' && /already used/.test(s.why)));
    // two ring groups with one number can't come from Riyeser Link: the online database refuses it
    // (unique index ring_groups_extension in website/team/team-chat.sql)
  } finally { rmTmp(dir); }
});

test('QA-LO-03 a ring group rings only its members (not other people, not the caller)', async () => {
  const dir = tmp('qa-lo');
  const directory = new Directory(new Store(dir));
  for (const [n, e] of [['Ana', '101'], ['Ben', '102'], ['Cy', '103'], ['Dee', '104']]) directory.addPerson({ name: n, ext: e });
  directory.addGroup({ name: 'Front desk', ext: '200', members: ['101', '102', '103'] });
  const pbx = await new Pbx({ directory, host: '127.0.0.1', port: 0, bind: '127.0.0.1', tcp: false, multicast: false }).start();
  const uas = {};
  try {
    for (const e of ['101', '102', '103', '104']) { uas[e] = await new SimUA({ ext: e, password: directory.password(e), server: { host: '127.0.0.1', port: pbx.port }, mode: 'ring' }).start(); await uas[e].register(); }
    const rang = new Set();
    for (const e of ['101', '102', '103', '104']) uas[e].on('invite', () => rang.add(e));
    const call = uas['101'].dial('200');
    await until(() => rang.has('102') && rang.has('103'));
    await wait(300);
    assert.deepStrictEqual([...rang].sort(), ['102', '103'], 'the caller (101) and non-member (104) do not ring');
    const inv = await uas['103'].waitFor('invite').catch(() => null);
    void inv; call.catch(() => {});
  } finally { for (const u of Object.values(uas)) await u.stop(); await pbx.stop(); rmTmp(dir); }
});
