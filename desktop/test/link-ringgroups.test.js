// Riyeser Link Office ring groups: a group's number rings only the phones chosen for it (all at once, in order or
// rotating), skips Do not disturb and anyone on a call, and moves on to its fallback when nobody answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sip = require('../src/link/sip');
const dialplan = require('../src/link/dialplan');
const { plan, settings } = require('../src/link/ringgroups');
const { Store } = require('../src/core/store');
const { Directory, mapTeam } = require('../src/link/directory');
const { syncFromTeam } = require('../src/link/sync');
const { exportSettings, importSettings } = require('../src/link/portable');
const { setup, tmp, rmTmp, wait, until } = require('./link-helpers');

const phone = (ext) => [{ contact: `sip:${ext}@pc`, source: { address: '127.0.0.1', port: 5000 + Number(ext), proto: 'UDP' } }];
const contactsOf = (ext) => (['101', '102', '103', '104'].includes(ext) ? phone(ext) : []);
const order = (p) => p.steps.map((s) => s.map((t) => t.ext).join('+'));

test('plan: only the chosen members, never the caller; all at once, in order, or rotating', () => {
  const g = { ext: '200', members: ['102', '103', '101'] };
  const all = plan(g, { caller: '101', contactsOf });
  assert.deepStrictEqual(order(all), ['102+103'], 'everyone chosen rings together; the caller isn\'t rung');
  assert.strictEqual(all.totalMs, 120000);
  const inOrder = plan({ ...g, strategy: 'order', ringSeconds: 10, timeoutSeconds: 40 }, { caller: '104', contactsOf });
  assert.deepStrictEqual(order(inOrder), ['102', '103', '101'], 'one after another, in the order chosen');
  assert.strictEqual(inOrder.stepMs, 10000); assert.strictEqual(inOrder.totalMs, 40000);
  const rot = (turn) => order(plan({ ...g, strategy: 'rotate' }, { caller: '104', contactsOf, turn }))[0];
  assert.deepStrictEqual([0, 1, 2, 3].map(rot), ['102', '103', '101', '102'], 'rotate: the next person first each time');
});

test('plan: Do not disturb, on a call and not connected are skipped; nobody chosen rings nobody', () => {
  const g = { ext: '200', members: ['102', '103', '104', '150'], strategy: 'order' };
  const p = plan(g, { contactsOf, dnd: (e) => e === '102', busy: (e) => e === '103' });
  assert.deepStrictEqual(order(p), ['104']);
  assert.deepStrictEqual(p.skipped, [{ ext: '102', why: 'dnd' }, { ext: '103', why: 'on_call' }, { ext: '150', why: 'not_connected' }]);
  const none = plan({ ext: '300', members: [] }, { contactsOf });
  assert.deepStrictEqual(none.steps, []); assert.strictEqual(none.members, 0); assert.strictEqual(none.fallback, null);
  assert.deepStrictEqual(settings({ strategy: 'nope', fallback: { type: 'voicemail', ext: '1' } }), { strategy: 'all', ringSeconds: 15, timeoutSeconds: null, fallback: null });
});

test('dial plan: a group\'s own number (Sales 300) is a group', () => {
  const dir = { group: (n) => (n === '300' ? { ext: '300' } : null), user: () => null };
  assert.deepStrictEqual(dialplan.resolve('300', dir), { type: 'group', ext: '300' });
  assert.strictEqual(dialplan.resolve('301', dir).type, 'none');
});

test('Riyeser Link ring groups: only the chosen people and shared phones, with how they ring and the fallback', () => {
  const m = mapTeam({
    business: 'Sample Trading Co',
    members: [{ user_id: 'u1', display_name: 'Alex Sample', extension: 101 }, { user_id: 'u2', display_name: 'Bo Example', extension: 102 },
      { user_id: 'u3', display_name: 'Cam Test', extension: 103 }],
    ringGroups: [
      { id: 'g1', name: 'Head office', extension: 100, branch_id: 'b1', strategy: 'order', ring_seconds: 10, timeout_seconds: 30, fallback: 'group', fallback_group: 'g2',
        members: [{ user_id: 'u2' }, { phone_ext: '150' }, { user_id: 'u1' }] },
      { id: 'g2', name: 'Sales', extension: 300, strategy: 'rotate', fallback: 'person', fallback_user: 'u3', members: [{ user_id: 'u3' }] },
      { id: 'g3', name: 'Lautoka branch', extension: 200, branch_id: 'b2', strategy: 'all', fallback: 'missed', members: [] }],
  });
  assert.deepStrictEqual(m.groups.map((g) => [g.ext, g.name, g.members, g.strategy]),
    [['100', 'Head office', ['102', '150', '101'], 'order'], ['200', 'Lautoka branch', [], 'all'], ['300', 'Sales', ['103'], 'rotate']]);
  const h = m.groups[0];
  assert.strictEqual(h.ringSeconds, 10); assert.strictEqual(h.timeoutSeconds, 30);
  assert.deepStrictEqual(h.fallback, { type: 'group', ext: '300' });
  assert.deepStrictEqual(m.groups[2].fallback, { type: 'person', ext: '103' });
  assert.strictEqual(m.groups[1].fallback, null);
  assert.ok(!m.groups.some((g) => g.members.includes('103') && g.ext === '100'), 'Cam (not chosen) isn\'t in Head office');
});

test('sync: ring groups from Riyeser Link; an online database without them still brings in the branches', async () => {
  const appData = tmp('appdata'); const dir = tmp();
  fs.mkdirSync(path.join(appData, 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Riyeser', 'company.json'), JSON.stringify({ name: 'Sample Trading Co', mode: 'online', workspace_id: 'ws-1' }));
  const members = [{ user_id: 'u1', display_name: 'Alex Sample', extension: 101 }, { user_id: 'u2', display_name: 'Bo Example', extension: 102 }];
  const asked = [];
  const online = { session: { access_token: 'x' }, async call(p, o = {}) { asked.push([p, o.body]);
    if (p.includes('/members')) return members;
    if (p.includes('ring_groups_list')) return [{ id: 'g1', name: 'Head office', extension: 100, strategy: 'order', members: [{ user_id: 'u2' }] }];
    throw new Error('branches should not be asked for'); } };
  const older = { session: { access_token: 'x' }, async call(p) {
    if (p.includes('/members')) return members;
    if (p.includes('ring_groups_list')) throw new Error('Could not find the function public.ring_groups_list(ws) in the schema cache');
    return [{ id: 'b1', name: 'Head office', extension: 100, branch_members: [{ user_id: 'u1' }, { user_id: 'u2' }] }]; } };
  try {
    const directory = new Directory(new Store(dir));
    assert.strictEqual((await syncFromTeam({ clients: [online], appData, directory })).status, 'synced');
    assert.deepStrictEqual(asked.find(([p]) => p.includes('ring_groups_list'))[1], { ws: 'ws-1' });
    assert.deepStrictEqual(directory.group('100').members, ['102'], 'only the chosen person');
    assert.strictEqual(directory.group('100').strategy, 'order');
    assert.strictEqual((await syncFromTeam({ clients: [older], appData, directory })).status, 'synced');
    assert.deepStrictEqual(directory.group('100').members, ['101', '102'], 'older database: the branch as before');
    // and the settings file keeps how a group rings
    directory.addGroup({ name: 'Sales', ext: '300', members: ['101'], strategy: 'rotate', timeoutSeconds: 20, fallback: { type: 'group', ext: '100' } });
    const data = exportSettings({ directory, store: directory.store });
    const g = data.groups.find((x) => x.ext === '300');
    assert.strictEqual(g.strategy, 'rotate'); assert.strictEqual(g.timeoutSeconds, 20); assert.deepStrictEqual(g.fallback, { type: 'group', ext: '100' });
    const dir2 = tmp(); try { const d2 = new Directory(new Store(dir2)); importSettings({ directory: d2, store: d2.store, data }); assert.strictEqual(d2.group('300').strategy, 'rotate'); } finally { rmTmp(dir2); }
  } finally { rmTmp(appData); rmTmp(dir); }
});

// ---------- on the phone system itself ----------
const rings = (u) => { const got = []; u.on('invite', (m) => got.push(sip.getHeader(m, 'call-id'))); return got; };

test('a group rings only its chosen phones: someone not chosen never rings', async () => {
  const env = await setup();   // 200 Front desk: 102 and 103
  try {
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' }); const c = await env.ua('103', { mode: 'ring' });
    env.directory.addPerson({ name: 'Dee Other', ext: '104' });
    const o = await env.ua('104', { mode: 'ring' });
    await a.register(); await b.register(); await c.register(); await o.register();
    const oRang = rings(o);
    const p = a.dial('200');
    const [ib] = await Promise.all([b.waitFor('invite'), c.waitFor('invite')]);
    await wait(80);
    b.answer(sip.getHeader(ib, 'call-id'));
    assert.strictEqual((await p).final.status, 200);
    assert.deepStrictEqual(oRang, [], '104 is registered but not in the group: it never rang');
  } finally { await env.close(); }
});

test('ring in order: the first chosen rings, then the next after its seconds are up; Do not disturb is skipped', async () => {
  const env = await setup();
  try {
    env.directory.addPerson({ name: 'Dee Other', ext: '104' });
    env.directory.addGroup({ name: 'Sales', ext: '300', members: ['104', '102', '103'], strategy: 'order', ringSeconds: 0.4, timeoutSeconds: 5 });
    env.directory.setDnd('104', true);
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' }); const c = await env.ua('103', { mode: 'ring' }); const d = await env.ua('104', { mode: 'ring' });
    await a.register(); await b.register(); await c.register(); await d.register();
    const dRang = rings(d); const cRang = rings(c);
    const t0 = Date.now();
    const p = a.dial('300');
    await b.waitFor('invite');
    assert.deepStrictEqual(cRang, [], 'Cam waits his turn');
    const bCancel = b.waitFor('cancel', () => true, 3000);
    const ic = await c.waitFor('invite', () => true, 3000);
    await bCancel;
    assert.ok(Date.now() - t0 >= 350, 'Cam rang after Bo\'s 0.4 seconds');
    c.answer(sip.getHeader(ic, 'call-id'));
    assert.strictEqual((await p).final.status, 200);
    assert.deepStrictEqual(dRang, [], 'Dee is on Do not disturb: skipped');
    await until(() => env.pbx.snapshot().calls.some((x) => x.answeredBy === '103'));
  } finally { await env.close(); }
});

test('rotate: each call starts with the next person', async () => {
  const env = await setup();
  try {
    env.directory.addGroup({ name: 'Support', ext: '400', members: ['102', '103'], strategy: 'rotate', ringSeconds: 5, timeoutSeconds: 10 });
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' }); const c = await env.ua('103', { mode: 'ring' });
    await a.register(); await b.register(); await c.register();
    const first = [];
    for (let i = 0; i < 3; i++) {
      const p = a.dial('400');
      const who = await Promise.race([b.waitFor('invite').then((m) => ['102', b, m]), c.waitFor('invite').then((m) => ['103', c, m])]);
      first.push(who[0]);
      who[1].answer(sip.getHeader(who[2], 'call-id'));
      const { call } = await p; await who[1].waitFor('ack'); await a.bye(call); await wait(50);
    }
    assert.deepStrictEqual(first, ['102', '103', '102']);
  } finally { await env.close(); }
});

test('if nobody answers: on to another group, or to one person; nobody chosen is a missed call', async () => {
  const env = await setup();
  const ended = []; env.pbx.on('call-ended', (c) => ended.push(c));
  try {
    env.directory.addPerson({ name: 'Dee Other', ext: '104' });
    env.directory.addGroup({ name: 'Sales', ext: '300', members: ['102'], timeoutSeconds: 0.4, fallback: { type: 'group', ext: '200' } });
    env.directory.addGroup({ name: 'Empty', ext: '500', members: [] });
    env.directory.addGroup({ name: 'After hours', ext: '600', members: [], fallback: { type: 'person', ext: '104' } });
    const a = await env.ua('101'); const b = await env.ua('102', { mode: 'ring' }); const c = await env.ua('103', { mode: 'ring' }); const d = await env.ua('104', { mode: 'ring' });
    await a.register(); await b.register(); await c.register(); await d.register();
    // Sales (102) for 0.4 s, then Front desk (200: 102 and 103)
    const p = a.dial('300');
    await b.waitFor('invite');
    const ic = await c.waitFor('invite', () => true, 3000);
    c.answer(sip.getHeader(ic, 'call-id'));
    assert.strictEqual((await p).final.status, 200);
    // nobody chosen and no fallback: 480 and a missed call in recent calls
    const none = (await a.dial('500')).final;
    assert.strictEqual(none.status, 480); assert.match(none.reason, /nobody chosen/);
    await until(() => ended.some((x) => x.to === '500' && x.result === 'unavailable'));
    // nobody chosen, falls back to one person
    const q = a.dial('600');
    const idd = await d.waitFor('invite');
    d.answer(sip.getHeader(idd, 'call-id'));
    assert.strictEqual((await q).final.status, 200);
  } finally { await env.close(); }
});
