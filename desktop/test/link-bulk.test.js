// Riyeser Link Office 1.2.1: many desk phones at once, and each phone's own page.
//   link-bulk.js   MAC addresses in any format, makers from the MAC's OUI prefix, pasted lists and CSV files, the preview
//                  (valid, duplicate, already added, maker, extension, person), extension auto-numbering, the summary
//   service.js     Add several phones; Give to… (to people, or numbered in order); Add as shared; Ignore / Bring back;
//                  Take back; Remove; Move location; Restart / Re-send settings; Find this phone; each phone's settings;
//                  the change history
//   provision.js   each maker's settings file carries only what it supports
//   cloud.js       the same from the website (bulk_phones, phone_action, phone_settings) with a summary back
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../src/renderer/link-bulk');
const { Store } = require('../src/core/store');
const { PhoneService } = require('../src/link/service');
const { Pbx } = require('../src/link/pbx');
const { yealinkConfig, snomConfig, polycomConfig, grandstreamConfig } = require('../src/link/provision');
const { applyCommand, buildPayload } = require('../src/link/cloud');
const { tmp, rmTmp, until } = require('./link-helpers');

// ---------- MAC addresses and makers
test('MAC addresses: any format in, 12 lower-case hex digits out; anything else is not a MAC', () => {
  for (const s of ['001565aabbcc', '00:15:65:AA:BB:CC', '00-15-65-aa-bb-cc', '0015.65aa.bbcc', ' 00 15 65 AA BB CC ', '00_15_65_aa_bb_cc'])
    assert.strictEqual(B.normaliseMac(s), '001565aabbcc', s);
  for (const s of ['', null, '001565aabbc', '001565aabbccd', '00:15:65:AA:BB:CG', 'not-a-mac']) assert.strictEqual(B.normaliseMac(s), null, String(s));
  assert.strictEqual(B.prettyMac('001565aabbcc'), '00:15:65:AA:BB:CC');
});

test('makers: from the MAC\'s OUI prefix where known, or from the words on the label', () => {
  assert.strictEqual(B.ouiVendor('00:15:65:12:34:56'), 'yealink');
  assert.strictEqual(B.ouiVendor('805EC0112201'), 'yealink');
  assert.strictEqual(B.ouiVendor('000B82123457'), 'grandstream');
  assert.strictEqual(B.ouiVendor('00-04-13-11-22-33'), 'snom');
  assert.strictEqual(B.ouiVendor('0004f2aabbcc'), 'polycom');
  assert.strictEqual(B.ouiVendor('0c383e010203'), 'fanvil');
  assert.strictEqual(B.ouiVendor('123456789abc'), '');
  assert.strictEqual(B.ouiVendor('nope'), '');
  assert.strictEqual(B.vendorFromText('Yealink T31P'), 'yealink');
  assert.strictEqual(B.vendorFromText('Poly VVX 250'), 'polycom');
  assert.strictEqual(B.vendorFromText('GRP2601P'), 'grandstream');
  assert.strictEqual(B.vendorFromText('SIP-T46U'), 'yealink');
  assert.strictEqual(B.vendorFromText('D735'), 'snom');
  assert.strictEqual(B.vendorFromText('Cisco SPA504G'), 'cisco');
  assert.strictEqual(B.vendorFromText(''), '');
  assert.ok(B.supported('yealink') && !B.supported('cisco') && !B.supported(''));
});

// ---------- pasted lists and CSV files
test('a pasted list: one MAC per line, any format, blank lines and # notes skipped, words after the MAC kept as the model', () => {
  const { rows, csv } = B.parseInput('001565aabbcc\n\n# the new ones\n00:15:65:AA:BB:CD Yealink T31P\r\n00-0b-82-11-22-33\nnonsense');
  assert.strictEqual(csv, false);
  assert.deepStrictEqual(rows.map((r) => [r.line, r.macText, r.model]), [[1, '001565aabbcc', ''], [4, '00:15:65:AA:BB:CD', 'Yealink T31P'], [5, '00-0b-82-11-22-33', ''], [6, 'nonsense', '']]);
});

test('a CSV: with the template\'s header (columns in any order), without a header, semicolons or tabs, quoted cells', () => {
  const tpl = B.parseInput(B.csvTemplate());
  assert.strictEqual(tpl.csv, true);
  assert.deepStrictEqual(tpl.rows[0], { line: 2, macText: '00:15:65:12:34:56', model: 'Yealink T31P', ext: '101', person: 'Alex Sample', name: 'Front desk', location: 'Head office' });
  assert.deepStrictEqual(B.TEMPLATE_HEAD, ['MAC address', 'Model or maker', 'Extension', 'Person (name or email)', 'Phone name', 'Location']);
  const odd = B.parseInput('Location;MAC;Email;Ext\n"Head office; level 2";00:15:65:12:34:57;bo@sample.test;102\n');
  assert.deepStrictEqual(odd.rows, [{ line: 2, macText: '00:15:65:12:34:57', model: '', ext: '102', person: 'bo@sample.test', name: '', location: 'Head office; level 2' }]);
  const bare = B.parseInput('000B82123457,Grandstream GRP2601P,,"Sample, Alex",Kitchen,Nadi');
  assert.deepStrictEqual(bare.rows[0], { line: 1, macText: '000B82123457', model: 'Grandstream GRP2601P', ext: '', person: 'Sample, Alex', name: 'Kitchen', location: 'Nadi' });
  const tabs = B.parseInput('MAC\tName\n0004f2aabbcc\tReception\n');
  assert.deepStrictEqual([tabs.rows[0].macText, tabs.rows[0].name], ['0004f2aabbcc', 'Reception']);
  assert.deepStrictEqual(B.parseCsv('a,"b ""quoted""",c\n\n1,2,3'), [['a', 'b "quoted"', 'c'], ['1', '2', '3']]);
});

// ---------- extensions
test('extension auto-numbering: from the chosen number up, skipping used numbers, x00 group numbers and emergency numbers', () => {
  assert.deepStrictEqual(B.nextFree(101, ['101', '103'], 3), ['102', '104', '105']);
  assert.deepStrictEqual(B.nextFree(198, [], 3), ['198', '199', '201'], 'never 200 (a group number)');
  assert.deepStrictEqual(B.nextFree(110, [], 3), ['110', '113', '114'], '111 and 112 are emergency numbers');
  assert.deepStrictEqual(B.nextFree(898, ['898'], 3), ['899'], 'stops at 899');
  assert.deepStrictEqual(B.nextFree('abc', [], 1), ['101']);
});

const people = [{ ext: '101', name: 'Alex Sample', email: 'alex@sample.test' }, { ext: '102', name: 'Bo Example' }, { ext: '103', name: 'Bo Other' }];
test('the preview: valid or not, duplicates, already added, maker, the extension it gets and who it\'s for', () => {
  const rows = B.parseInput([
    'MAC,Model,Extension,Person,Phone name,Location',
    '00:15:65:12:34:56,,,alex@sample.test,Front desk,Head office',   // 1 person by email
    '000B82123457,,105,,Kitchen,',                                    // 2 a typed new extension, named after the phone
    '00-04-F2-11-22-33,,,,Meeting room,',                             // 3 auto-numbered
    '001565aabbcc,,,,,',                                              // 4 already given to someone
    '00:15:65:12:34:56,,,,,',                                         // 5 twice in the list
    'not-a-mac,,,,,',                                                 // 6 not a MAC
    '0c383e010203,Fanvil X3U,,Alex Sample,,',                         // 7 a maker set up by hand; person by name
    '123456789abc,,100,,,',                                           // 8 100 is a ring group
    '123456789abd,,111,,,',                                           // 9 an emergency number
    '123456789abe,,1234,,,',                                          // 10 not 3 digits
    '123456789abf,,,Bo,,',                                            // 11 "Bo" means two people: not matched
    '0004f2000001,,,102,,',                                           // 12 person by extension
  ].join('\n')).rows;
  const ctx = { people, phones: [{ mac: '001565aabbcc', ext: '101' }], found: [{ mac: '0004f2112233' }], used: ['100', '200'], start: '201', auto: true };
  const p = B.preview(rows, ctx);
  const r = (i) => p.rows[i - 1];
  assert.deepStrictEqual([r(1).state, r(1).ext, r(1).person.name, r(1).vendor], ['ok', '101', 'Alex Sample', 'yealink']);
  assert.deepStrictEqual([r(2).state, r(2).ext, r(2).newExt, r(2).extName, r(2).vendor], ['ok', '105', true, 'Kitchen', 'grandstream']);
  assert.deepStrictEqual([r(3).state, r(3).ext, r(3).extName, r(3).vendor], ['ok', '201', 'Meeting room', 'polycom']);
  assert.match(r(3).notes.join(), /Already found on the network/);
  assert.deepStrictEqual([r(4).state, r(4).notes[0]], ['skip', 'Already added (extension 101)']);
  assert.deepStrictEqual([r(5).state, r(5).dup, r(5).notes[0]], ['skip', true, 'Twice in this list (line 2)']);
  assert.deepStrictEqual([r(6).state, r(6).notes[0]], ['error', 'not-a-mac isn\'t a MAC address (12 letters and numbers)']);
  assert.deepStrictEqual([r(7).state, r(7).vendorName, r(7).supported, r(7).ext], ['warn', 'Fanvil', false, '101']);
  assert.match(r(7).notes[0], /Fanvil phones are set up by hand/);
  assert.deepStrictEqual([r(8).state, r(8).notes[0]], ['error', '100 is a ring group number']);
  assert.deepStrictEqual([r(9).state, r(9).notes[0]], ['error', '111 is an emergency number']);
  assert.deepStrictEqual([r(10).state, r(10).notes[0]], ['error', 'Extension 1234 isn\'t 3 digits from 100 to 899']);
  assert.deepStrictEqual([r(11).state, r(11).ext], ['warn', '202'], 'an unclear person: a new extension, said so');
  assert.match(r(11).notes.join(), /No one called "Bo"/);
  assert.deepStrictEqual([r(12).state, r(12).ext, r(12).person.name], ['ok', '102', 'Bo Example']);
  assert.deepStrictEqual(p.counts, { add: 6, skip: 2, error: 4, warn: 2 });
  // without auto-numbering, a phone with no person waits under New
  const wait = B.preview([{ line: 1, macText: '0004f2000002' }], { people, used: [] });
  assert.deepStrictEqual([wait.rows[0].state, wait.rows[0].ext], ['ok', '']);
  assert.match(wait.rows[0].notes[0], /waits under New phones/);
  // a person whose extension differs from the one typed: the person wins, said so
  const mix = B.preview([{ line: 1, macText: '0004f2000003', ext: '150', person: 'Bo Example' }], { people });
  assert.deepStrictEqual([mix.rows[0].ext, mix.rows[0].state], ['102', 'warn']);
  // two phones typed with the same new extension share it (one new extension, two phones)
  const share = B.preview([{ line: 1, macText: '0004f2000004', ext: '150' }, { line: 2, macText: '0004f2000005', ext: '150' }], { people });
  assert.deepStrictEqual(share.rows.map((x) => [x.state, x.ext]), [['ok', '150'], ['ok', '150']]);
});

test('the summary afterwards reads plainly', () => {
  assert.strictEqual(B.summary({ added: 12, skipped: [{ why: 'duplicates' }, { why: 'duplicates' }] }), 'Added 12 phones, 2 skipped: duplicates.');
  assert.strictEqual(B.summary({ added: 1, skipped: [], failed: [{ why: 'not a MAC address' }] }), 'Added 1 phone, 1 didn\'t work: not a MAC address.');
  assert.strictEqual(B.summary({ verb: 'Restarted', done: 3, skipped: [{ why: 'not on the network now' }] }), 'Restarted 3 phones, 1 skipped: not on the network now.');
});

test('each phone\'s settings: only what its maker supports, each checked', () => {
  const s = { label: 'Front', displayName: 'Reception <desk>', timezone: '+12', timeFormat: '24', language: 'French', ringtone: '3', ringVolume: 20, dnd: 'person',
    lineKeys: [{ value: '102', label: 'Bo' }, { value: '1; rm', label: 'x' }, { value: '' }], admin: 'x' };
  assert.deepStrictEqual(B.cleanSettings('yealink', s).settings, { label: 'Front', displayName: 'Reception desk', timezone: '+12', timeFormat: '24', language: 'French', ringtone: 3, dnd: 'person',
    lineKeys: [{ type: 'speed', value: '102', label: 'Bo' }, { type: 'speed', value: '1', label: 'x' }] });
  assert.deepStrictEqual(B.cleanSettings('yealink', s).dropped.sort(), ['admin', 'ringVolume']);
  assert.deepStrictEqual(Object.keys(B.cleanSettings('grandstream', s).settings).sort(), ['displayName', 'label', 'language', 'timeFormat'], 'Grandstream: what its file can carry');
  assert.deepStrictEqual(B.cleanSettings('cisco', s).settings, {}, 'a maker Riyeser Link Office doesn\'t set up: nothing');
  assert.strictEqual(B.cleanSettings('yealink', { timezone: '+25' }).settings.timezone, undefined);
  assert.strictEqual(B.cleanSettings('snom', { lineKeys: Array.from({ length: 20 }, (_, i) => ({ value: String(200 + i) })) }).settings.lineKeys.length, 12);
});

test('website/team/link-bulk.js is the very same file as Link Office\'s', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'link-bulk.js'), 'utf8');
  const web = path.join(__dirname, '..', '..', 'website', 'team', 'link-bulk.js');
  if (!fs.existsSync(web)) return;   // the desktop folder on its own
  assert.strictEqual(fs.readFileSync(web, 'utf8'), a);
});

// ---------- the phone system: many at once
function make() {
  const dir = tmp(); const appData = tmp('appdata'); const store = new Store(dir);
  const svc = new PhoneService({ store, appData, host: '127.0.0.1', sipPort: 0, httpPort: 0, bind: '127.0.0.1', tcp: false, multicast: false, licence: () => ({ active: true, state: 'paid' }) });
  svc.addPerson({ name: 'Alex Sample', ext: '101' }); svc.addPerson({ name: 'Bo Example', ext: '102' });
  svc.directory.addGroup({ name: 'Front desk', ext: '200', members: ['101', '102'] });
  return { svc, store, close: async () => { await svc.stop(); rmTmp(dir); rmTmp(appData); } };
}

test('Add several phones: given to people, new shared extensions, waiting under New; duplicates and bad rows skipped; one line in the history', async () => {
  const { svc, store, close } = make();
  try {
    svc.assign('001565aabbcc', '101');
    const rows = B.parseInput([
      'MAC,Model,Extension,Person,Phone name,Location',
      '000B82123457,Grandstream GRP2601P,,Bo Example,Bo desk,Head office',
      '00-04-F2-11-22-33,,,,Meeting room,Nadi branch',
      '001565aabbcc,,,,,', '000b82123457,,,,,', 'not-a-mac,,,,,',
    ].join('\n')).rows;
    const r = svc.bulkAdd(rows, { start: '201', auto: true, shared: true });
    assert.strictEqual(r.summary, 'Added 2 phones, 2 skipped: already added, duplicates, 1 didn\'t work: not-a-mac isn\'t a MAC address (12 letters and numbers).');
    const d = store.get('phone-devices');
    const bo = d.phones.find((p) => p.mac === '000b82123457');
    assert.deepStrictEqual([bo.ext, bo.vendor, bo.model, bo.label, bo.location], ['102', 'grandstream', 'GRP2601P', 'Bo desk', 'Head office']);
    const room = d.phones.find((p) => p.mac === '0004f2112233');
    assert.deepStrictEqual([room.ext, room.vendor, room.label, room.location], ['201', 'polycom', 'Meeting room', 'Nadi branch']);
    assert.deepStrictEqual(svc.directory.person('201'), { ...svc.directory.person('201'), name: 'Meeting room', shared: true }, 'a new shared extension, named after the phone');
    const h = svc.history();
    assert.strictEqual(h[0].by, 'This PC'); assert.match(h[0].what, /^Added several phones: Added 2 phones, 2 skipped/); assert.match(h[0].what, /new extensions 201/);
    // without auto-numbering: phones wait under New, with their name and location
    const w = svc.bulkAdd([{ macText: '00:04:13:44:55:66', name: 'Store room', location: 'Workshop' }]);
    assert.strictEqual(w.summary, 'Added 1 phone.');
    const f = store.get('phone-devices').found.find((x) => x.mac === '000413445566');
    assert.deepStrictEqual([f.vendor, f.label, f.location, f.added], ['snom', 'Store room', 'Workshop', true]);
    assert.strictEqual(svc.status().found.length, 1);
    assert.throws(() => svc.bulkAdd([]), /at least one MAC/);
    assert.throws(() => svc.bulkAdd(Array.from({ length: 501 }, () => ({ macText: '001565aabbcc' }))), /up to 500/);
  } finally { await close(); }
});

test('Give to…, Add as shared, Ignore / Bring back, Take back, Move location, Remove: each with a summary and in the history', async () => {
  const { svc, store, close } = make();
  try {
    const pr = svc.devices();
    for (const [mac, vendor] of [['001565ddeeff', 'yealink'], ['000b82445566', 'grandstream'], ['000413aabb01', 'snom'], ['0004f2000009', 'polycom']]) pr.seen(mac, { vendor, model: 'X', ip: '192.168.1.5' });
    pr.label('000b82445566', { name: 'Kitchen', location: 'Head office' });
    // to people
    let r = svc.bulk('give', ['00:15:65:DD:EE:FF', '000b82445566'], { to: { '001565ddeeff': '101' } });
    assert.strictEqual(r.summary, 'Gave out 1 phone, 1 skipped: no person chosen.');
    assert.strictEqual(store.get('phone-devices').phones.find((p) => p.mac === '001565ddeeff').ext, '101');
    // numbered in order, named after each phone
    r = svc.bulk('give', ['000b82445566', '000413aabb01'], { auto: true, start: '199' });
    assert.strictEqual(r.summary, 'Gave out 2 phones.');
    const ph = store.get('phone-devices').phones;
    assert.deepStrictEqual(['000b82445566', '000413aabb01'].map((m) => ph.find((p) => p.mac === m).ext), ['199', '201'], 'in order, skipping 200');
    assert.deepStrictEqual([svc.directory.person('199').name, svc.directory.person('201').name], ['Kitchen', 'Phone 201']);
    assert.strictEqual(store.get('phone-devices').phones.find((p) => p.mac === '000b82445566').label, 'Kitchen', 'the name stays with the phone');
    r = svc.bulk('give', ['001565ddeeff'], { to: { '001565ddeeff': '102' } });
    assert.strictEqual(r.summary, 'Gave out 0 phones, 1 skipped: already given to someone.');
    // shared
    pr.seen('0004f2000010', { vendor: 'polycom', ip: '192.168.1.6' }); pr.label('0004f2000010', { name: 'Reception' });
    r = svc.bulk('shared', ['0004f2000010'], { start: '110' });
    assert.strictEqual(r.summary, 'Added as shared 1 phone.');
    assert.deepStrictEqual([svc.directory.person('110').name, svc.directory.person('110').shared], ['Reception', true]);
    // ignore and bring back
    r = svc.bulk('ignore', ['0004f2000009', '001565ddeeff']);
    assert.strictEqual(r.summary, 'Ignored 1 phone, 1 skipped: given to someone (take it back first).');
    assert.deepStrictEqual(svc.status().ignored.map((x) => x.mac), ['0004f2000009']);
    assert.strictEqual(svc.status().found.length, 0);
    r = svc.bulk('unignore', ['0004f2000009']); assert.strictEqual(svc.status().found.length, 1);
    // move location (given or new)
    r = svc.bulk('location', ['001565ddeeff', '0004f2000009'], { location: 'Nadi branch' });
    assert.strictEqual(r.summary, 'Moved 2 phones to Nadi branch.');
    assert.strictEqual(svc.status().found[0].location, 'Nadi branch');
    // take back, then remove
    r = svc.bulk('unassign', ['001565ddeeff', '0004f2000009']);
    assert.strictEqual(r.summary, 'Took back 1 phone, 1 skipped: not given to anyone.');
    r = svc.bulk('remove', ['0004f2000009', '000b82445566', 'aaaaaaaaaaaa']);
    assert.strictEqual(r.summary, 'Removed 2 phones, 1 skipped: not on the list.');
    const left = store.get('phone-devices');
    assert.ok(!left.phones.some((p) => p.mac === '000b82445566') && !left.found.some((p) => p.mac === '0004f2000009'));
    assert.throws(() => svc.bulk('remove', []), /Tick at least one/);
    assert.match(svc.bulk('explode', ['001565ddeeff']).failed[0].why, /doesn't know how/);
    const whats = svc.history(20).map((x) => x.what);
    for (const w of ['Gave out 2 phones', 'Added as shared 1 phone', 'Ignored 1 phone', 'Moved 2 phones to Nadi branch', 'Took back 1 phone', 'Removed 2 phones']) assert.ok(whats.some((x) => x.startsWith(w)), w);
  } finally { await close(); }
});

test('Restart and Re-send settings ask each phone in its maker\'s words; a phone not on the network is skipped, said so', async () => {
  const { svc, close } = make(); const orig = Pbx.prototype.checkSync; const asked = [];
  Pbx.prototype.checkSync = function (ip, port, ev) { asked.push([ip, port, ev]); };
  try {
    await svc.start();
    svc.assign('001565aabbcc', '101'); svc.assign('000413778899', '102');
    const d = svc.store.get('phone-devices'); d.phones[0].ip = '192.168.1.31'; svc.store.set('phone-devices', d);
    let r = svc.bulk('restart', ['001565aabbcc', '000413778899']);
    assert.strictEqual(r.summary, 'Restarted 1 phone, 1 skipped: not on the network now.');
    assert.deepStrictEqual(asked, [['192.168.1.31', 5060, 'check-sync;reboot=true']]);
    r = svc.bulk('resync', ['001565aabbcc']); assert.deepStrictEqual(asked[1], ['192.168.1.31', 5060, 'check-sync;reboot=false']);
    assert.throws(() => svc.restartPhone('000413778899'), /isn't on the network right now/);
    assert.ok(svc.restartPhone('001565aabbcc', { reboot: false }));
    assert.match(svc.history(1)[0].what, /^Re-sent settings to 00:15:65:AA:BB:CC/);
  } finally { Pbx.prototype.checkSync = orig; await close(); }
});

test('Find this phone: it rings for a few seconds as "Find this phone", then stops (or hangs up if someone answers)', async () => {
  const { svc, close } = make(); const { SimUA } = require('../src/link/simua');
  const uas = [];
  try {
    await svc.start();
    const ua = await new SimUA({ ext: '101', password: svc.directory.password('101'), server: { host: '127.0.0.1', port: svc.pbx.port }, mode: 'ring', userAgent: 'Yealink SIP-T31P 124.86.0.40' }).start(); uas.push(ua);
    assert.strictEqual((await ua.register()).status, 200);
    svc.assign('001565aabbcc', '101');
    const d = svc.store.get('phone-devices'); d.phones[0].ip = '127.0.0.1'; svc.store.set('phone-devices', d);
    const st = svc.status().phones[0];
    assert.strictEqual(st.firmware, '124.86.0.40', 'the firmware from what the phone says it is');
    assert.ok(st.registeredSince, 'when it connected');
    const rang = ua.waitFor('invite');
    assert.ok(svc.findPhone('001565aabbcc'));
    const inv = await rang;
    assert.match(require('../src/link/sip').getHeader(inv, 'from'), /"Find this phone"/);
    await ua.waitFor('cancel', () => true, 8000);
    assert.match(svc.history(1)[0].what, /^Rang 00:15:65:AA:BB:CC to find it/);
    // someone picks it up: hung up straight away
    const ans = await new SimUA({ ext: '102', password: svc.directory.password('102'), server: { host: '127.0.0.1', port: svc.pbx.port }, mode: 'answer' }).start(); uas.push(ans);
    await ans.register();
    assert.ok(svc.pbx.ring('102', { seconds: 5 }));
    await ans.waitFor('bye', () => true, 4000);
    // not connected: said so
    assert.throws(() => svc.findPhone('nope'), /Give the phone to someone first/);
    svc.assign('000413778899', '102'); const d2 = svc.store.get('phone-devices'); d2.phones.find((p) => p.mac === '000413778899').ip = '10.9.9.9'; svc.store.set('phone-devices', d2);
    assert.throws(() => svc.findPhone('000413778899'), /isn't connected right now/);
  } finally { for (const u of uas) await u.stop(); await close(); }
});

test('each phone\'s settings go into its maker\'s settings file (Do not disturb following its person); Move to a shared phone', async () => {
  const { svc, store, close } = make();
  try {
    svc.assign('001565aabbcc', '101'); svc.assign('000413778899', '102'); svc.assign('0004f2aabbcc', '101'); svc.assign('000b82112233', '102');
    svc.setDnd('101', true);
    const r = svc.phoneSettings('001565aabbcc', { label: 'Front', timezone: '+12', timeFormat: '24', language: 'French', ringtone: '3', ringVolume: '9', dnd: 'person', lineKeys: [{ value: '102', label: 'Bo' }], evil: 'x' });
    assert.deepStrictEqual(r.dropped, ['evil']);
    const p = store.get('phone-devices').phones.find((x) => x.mac === '001565aabbcc');
    const a = { mac: p.mac, ext: '101', name: 'Alex Sample', password: 'pw', server: '192.168.1.20', sipPort: 5060, provisionUrl: 'http://192.168.1.20:5080/yealink/', settings: p.settings, dnd: true };
    const y = yealinkConfig(a);
    for (const l of ['account.1.label = Front', 'account.1.display_name = Alex Sample', 'local_time.time_zone = +12', 'local_time.time_format = 1', 'lang.gui = French', 'account.1.ringtone.ring_type = Ring3.wav',
      'voice.ring_vol = 9', 'linekey.2.type = 13', 'linekey.2.value = 102', 'linekey.2.label = Bo', 'features.dnd.enable = 1']) assert.ok(y.includes(l), l);
    const sn = snomConfig({ ...a, settings: { displayName: 'Desk', timezone: '+5:30', timeFormat: '12', ringVolume: 4, dnd: 'person', lineKeys: [{ value: '200', label: 'Front desk' }] }, dnd: false });
    for (const l of ['<user_realname idx="1" perm="">Desk</user_realname>', '<utc_offset perm="">19800</utc_offset>', '<time_24_format perm="">off</time_24_format>', '<vol_ringer perm="">4</vol_ringer>',
      '<dnd_mode perm="">off</dnd_mode>', '<fkey idx="0" context="active" label="Front desk" perm="">speed 200</fkey>']) assert.ok(sn.includes(l), l);
    const po = polycomConfig({ ...a, settings: { label: 'Front', timezone: '-5', lineKeys: [{ value: '102', label: 'Bo' }] } });
    for (const l of ['reg.1.label="Front"', 'tcpIpApp.sntp.gmtOffset="-18000"', 'attendant.resourceList.1.address="102"']) assert.ok(po.includes(l), l);
    const gs = grandstreamConfig({ ...a, settings: { label: 'Front', timeFormat: '24', language: 'German' } });
    for (const l of ['<P270>Front</P270>', '<P122>1</P122>', '<P1362>de</P1362>']) assert.ok(gs.includes(l), l);
    assert.ok(!yealinkConfig({ ...a, settings: {} }).includes('local_time'), 'nothing chosen: the phone keeps its own');
    // the settings the phone fetches carry them
    const s = svc.devices().settingsFor({ vendor: 'yealink', mac: '001565aabbcc', kind: 'phone' });
    assert.ok(s.body.includes('voice.ring_vol = 9') && s.body.includes('features.dnd.enable = 1'));
    assert.throws(() => svc.phoneSettings('aaaaaaaaaaaa', {}), /Give the phone to someone first/);
    // a phone moved to a new shared extension (Reception)
    const m = svc.movePhone('000413778899', { sharedName: 'Reception' });
    assert.deepStrictEqual([svc.directory.person(m.ext).name, svc.directory.person(m.ext).shared], ['Reception', true]);
    assert.strictEqual(svc.status().phones.find((x) => x.mac === '000413778899').shared, true);
    assert.throws(() => svc.movePhone('000413778899', {}), /Choose who the phone is for/);
    assert.match(svc.history(1)[0].what, /is now extension \d{3} \(Reception\)/);
  } finally { await close(); }
});

test('from the website: many phones at once, each phone\'s page, with a summary back; the heartbeat carries ignored and shared phones', async () => {
  const { svc, store, close } = make();
  try {
    const add = applyCommand(svc, { id: 'c1', kind: 'bulk_phones', data: { action: 'add', auto: true, shared: true, start: '201', rows: [{ macText: '00:15:65:12:34:56', name: 'Front' }, { macText: '00:15:65:12:34:56' }, { macText: 'x' }] } });
    assert.deepStrictEqual([add.ok, add.result.summary, add.result.added], [true, 'Added 1 phone, 1 skipped: duplicates, 1 didn\'t work: x isn\'t a MAC address (12 letters and numbers).', 1]);
    svc.devices().seen('000b82445566', { vendor: 'grandstream', ip: '192.168.1.9' });
    const give = applyCommand(svc, { id: 'c2', kind: 'bulk_phones', data: { action: 'give', macs: ['000b82445566'], to: { '000b82445566': '102' } } });
    assert.strictEqual(give.result.summary, 'Gave out 1 phone.');
    const bad = applyCommand(svc, { id: 'c3', kind: 'bulk_phones', data: { action: 'give', macs: ['000b82445566'], to: { '000b82445566': '555' } } });
    assert.deepStrictEqual([bad.ok, bad.error], [false, 'No one has extension 555 on Riyeser Link Office.']);
    svc.devices().seen('0004f2000009', { vendor: 'polycom' });
    assert.ok(applyCommand(svc, { id: 'c4', kind: 'phone_action', data: { mac: '0004f2000009', action: 'ignore' } }).ok);
    const st = applyCommand(svc, { id: 'c5', kind: 'phone_settings', data: { mac: '001565123456', settings: { ringVolume: 7, password: 'x' } } });
    assert.deepStrictEqual(st.result, { applied: ['ringVolume'], dropped: ['password'] });
    const mv = applyCommand(svc, { id: 'c6', kind: 'phone_action', data: { mac: '000b82445566', action: 'move', shared_name: 'Kitchen' } });
    assert.ok(mv.ok);
    const nf = applyCommand(svc, { id: 'c7', kind: 'phone_action', data: { mac: '001565123456', action: 'find' } });
    assert.deepStrictEqual([nf.ok, nf.error], [false, 'That phone isn\'t connected right now, so it can\'t ring.']);
    assert.deepStrictEqual(applyCommand(svc, { id: 'c8', kind: 'phone_action', data: { mac: '001565123456', action: 'explode' } }).ok, false);
    const h = svc.history(10);
    assert.ok(h.every((x) => x.by === 'Riyeser Link (website)'), 'website changes say so in the history');
    assert.ok(h.some((x) => x.what.startsWith('Gave out 1 phone')));
    const pl = buildPayload(svc.status(), { officeId: 'lo-1' });
    const ig = pl.phones.find((p) => p.mac === '0004f2000009');
    assert.deepStrictEqual([ig.assigned, ig.ignored], [false, true]);
    const kit = pl.phones.find((p) => p.mac === '000b82445566');
    assert.strictEqual(kit.shared, true);
    assert.deepStrictEqual(pl.phones.find((p) => p.mac === '001565123456').settings, { ringVolume: 7 });
    assert.strictEqual(pl.counts.ignored_phones, 1);
    assert.ok(!JSON.stringify(pl).includes(svc.directory.password('101')), 'never a password');
  } finally { await close(); }
});
