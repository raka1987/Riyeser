// The relay's own dynamic DNS with Namecheap, against a fake Namecheap Dynamic DNS endpoint on this machine that
// answers the way dynamicdns.park-your-domain.com/update does (XML with <ErrCount> and <errors><Err1>…).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Ddns, parseNamecheap } = require('../lib/ddns');
const { config } = require('../server');
const { makeRelay, until, wait } = require('./helpers');

const PASSWORD = 'f3a9c0ddns-pass-7Q+&=';
const xml = (count, errs = [], ip = '') => `<?xml version="1.0" encoding="utf-16"?>\r\n<interface-response><Command>SETDNSHOST</Command><Language>eng</Language>${ip ? `<IP>${ip}</IP>` : ''}<ErrCount>${count}</ErrCount>`
  + `${errs.length ? `<errors>${errs.map((e, i) => `<Err${i + 1}>${e}</Err${i + 1}>`).join('')}</errors>` : '<errors />'}<ResponseCount>${errs.length}</ResponseCount>`
  + `${errs.length ? `<responses><response><ResponseNumber>304156</ResponseNumber><ResponseString>Validation error; invalid ; password</ResponseString></response></responses>` : '<responses />'}<Done>true</Done><debug><![CDATA[]]></debug></interface-response>\r\n`;

/** A fake Namecheap: riyeser.com with A + Dynamic DNS records for relay and relay2. */
async function fakeNamecheap({ utf16 = false } = {}) {
  const f = { calls: [], records: { relay: null, relay2: null }, down: 0 };
  f.server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams);
    f.calls.push(q);
    if (f.down > 0) { f.down--; res.writeHead(503); return res.end('busy'); }
    let body;
    if (u.pathname !== '/update' || req.method !== 'GET') body = xml(1, ['Invalid request']);
    else if (q.domain !== 'riyeser.com') body = xml(1, ['Domain name not found']);
    else if (q.password !== PASSWORD) body = xml(1, ['Passwords do not match']);
    else if (!(q.host in f.records)) body = xml(1, ['No Records updated. A record not Found;']);
    else { f.records[q.host] = q.ip; body = xml(0, [], q.ip); }
    const buf = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]) : Buffer.from(body);
    res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(buf);
  });
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  f.endpoint = `http://127.0.0.1:${f.server.address().port}/update`;
  f.close = () => new Promise((r) => f.server.close(r));
  return f;
}
const logger = () => { const lines = []; const log = (level, text) => lines.push(`${level} ${text}`); log.lines = lines; return log; };

test('Namecheap: sets relay.riyeser.com, skips an unchanged address, and sets it again when forced (the 30-minute safety net)', async () => {
  const f = await fakeNamecheap(); const log = logger();
  const d = new Ddns({ provider: 'namecheap', host: 'relay', domain: 'riyeser.com', password: PASSWORD, endpoint: f.endpoint, log });
  try {
    assert.equal(d.enabled, true); assert.equal(d.name, 'relay.riyeser.com');
    assert.equal(await d.update('198.51.100.9'), true);
    assert.deepEqual(f.calls[0], { host: 'relay', domain: 'riyeser.com', password: PASSWORD, ip: '198.51.100.9' }, 'password sent URL-encoded and arrives intact');
    assert.equal(f.records.relay, '198.51.100.9');
    assert.equal(d.state.ok, true); assert.equal(d.state.error, null);
    assert.equal(await d.update('198.51.100.9'), false); assert.equal(f.calls.length, 1, 'no call when nothing changed');
    assert.equal(await d.update('198.51.100.9', { force: true }), true); assert.equal(f.calls.length, 2);
    assert.equal(await d.update('198.51.100.10'), true); assert.equal(f.records.relay, '198.51.100.10');
    assert.equal(log.lines.filter((l) => /now points at/.test(l)).length, 2, 'logged on change, not on every safety-net update');
    assert.ok(!log.lines.join('\n').includes(PASSWORD));
  } finally { d.stop(); await f.close(); }
});

test('Namecheap: the backup relay (relay2) from its RELAY_HOST, and replies sent as UTF-16', async () => {
  const f = await fakeNamecheap({ utf16: true });
  const d = new Ddns({ provider: 'namecheap', name: 'relay2.riyeser.com', domain: 'riyeser.com', password: PASSWORD, endpoint: f.endpoint });
  try {
    assert.equal(d.host, 'relay2');
    assert.equal(await d.update('203.0.113.5'), true);
    assert.equal(f.records.relay2, '203.0.113.5'); assert.equal(f.records.relay, null);
  } finally { d.stop(); await f.close(); }
  const d2 = new Ddns({ provider: 'namecheap', name: 'relay2.riyeser.com', password: PASSWORD });
  assert.deepEqual([d2.host, d2.domain], ['relay2', 'riyeser.com'], 'host and domain from the name when not given');
});

test('Namecheap: a wrong Dynamic DNS password is a plain message in the log and status, never the password', async () => {
  const f = await fakeNamecheap(); const log = logger();
  const wrong = 'my-namecheap-ACCOUNT-password';
  const d = new Ddns({ provider: 'namecheap', host: 'relay', domain: 'riyeser.com', password: wrong, endpoint: f.endpoint, log, retryMs: 30 });
  try {
    assert.equal(await d.update('198.51.100.9'), false);
    assert.equal(d.state.ok, false);
    assert.match(d.state.error, /refused the Dynamic DNS password/);
    assert.match(d.state.error, /Advanced DNS → Dynamic DNS/);
    assert.match(d.state.error, /not your Namecheap account password/);
    assert.equal(log.lines.length, 1); assert.match(log.lines[0], /^warn DNS: couldn't point relay\.riyeser\.com at 198\.51\.100\.9: Namecheap refused/);
    assert.match(log.lines[0], /every 30 minutes/);
    await wait(120); assert.equal(f.calls.length, 1, 'a wrong password is not retried every minute (only the 30-minute safety net)');
    await d.update('198.51.100.9', { force: true });
    assert.equal(log.lines.length, 1, 'the same problem is logged once');
    const all = JSON.stringify(d.state) + log.lines.join('\n');
    assert.ok(!all.includes(wrong) && !all.includes(encodeURIComponent(wrong)));
  } finally { d.stop(); await f.close(); }
});

test('Namecheap: a host with no "A + Dynamic DNS Record", and a domain not in the account', async () => {
  const f = await fakeNamecheap();
  try {
    const d = new Ddns({ provider: 'namecheap', host: 'relay3', domain: 'riyeser.com', password: PASSWORD, endpoint: f.endpoint });
    assert.equal(await d.update('198.51.100.9'), false);
    assert.match(d.state.error, /no "A \+ Dynamic DNS Record" for relay3\.riyeser\.com\. Add one with host "relay3"/);
    const d2 = new Ddns({ provider: 'namecheap', host: 'relay', domain: 'riyeser.co', password: PASSWORD, endpoint: f.endpoint });
    assert.equal(await d2.update('198.51.100.9'), false);
    assert.match(d2.state.error, /doesn't know the domain riyeser\.co/);
    d.stop(); d2.stop();
  } finally { await f.close(); }
});

test('Namecheap: busy or unreachable is retried in a minute (here: 30 ms) until it works', async () => {
  const f = await fakeNamecheap(); f.down = 2; const log = logger();
  const d = new Ddns({ provider: 'namecheap', host: 'relay', domain: 'riyeser.com', password: PASSWORD, endpoint: f.endpoint, log, retryMs: 30 });
  try {
    assert.equal(await d.update('198.51.100.9'), false);
    assert.match(d.state.error, /Namecheap answered 503/);
    await until(() => d.state.ok === true, 3000);
    assert.equal(f.calls.length, 3); assert.equal(f.records.relay, '198.51.100.9');
  } finally { d.stop(); await f.close(); }
  const nowhere = new Ddns({ provider: 'namecheap', host: 'relay', domain: 'riyeser.com', password: PASSWORD, endpoint: 'http://127.0.0.1:9/update', retryMs: 0 });
  assert.equal(await nowhere.update('198.51.100.9'), false);
  assert.match(nowhere.state.error, /couldn't reach Namecheap/); assert.ok(!nowhere.state.error.includes(PASSWORD));
});

test('Namecheap: replies parsed (success, errors, unreadable)', () => {
  assert.deepEqual(parseNamecheap(xml(0, [], '1.2.3.4')), { ok: true, errors: [] });
  assert.deepEqual(parseNamecheap(xml(1, ['Passwords do not match'])), { ok: false, errors: ['Passwords do not match'] });
  assert.equal(parseNamecheap('<html>gateway timeout</html>').unreadable, true);
  assert.deepEqual(parseNamecheap(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml(0), 'utf16le')])), { ok: true, errors: [] });
});

test('relay.env settings for Namecheap, and the relay sets its name at start, every DDNS_EVERY_MINUTES, and shows it in /health', async () => {
  const c = config({ RELAY_HOST: 'relay2.riyeser.com', DDNS_PROVIDER: 'namecheap', DDNS_HOST: 'relay2', DDNS_DOMAIN: 'riyeser.com', DDNS_PASSWORD: PASSWORD, RELAY_SECRET: 'x'.repeat(40) });
  assert.deepEqual([c.ddns.provider, c.ddns.host, c.ddns.domain, c.ddns.password, c.ddnsEvery], ['namecheap', 'relay2', 'riyeser.com', PASSWORD, 30 * 60 * 1000]);
  const f = await fakeNamecheap();
  const s = await makeRelay({ id: 'dns1', turn: false, ddns: { provider: 'namecheap', host: 'relay2', domain: 'riyeser.com', password: PASSWORD, endpoint: f.endpoint }, ddnsEvery: 150 });
  try {
    await until(() => f.records.relay2 === '127.0.0.1');
    await until(() => f.calls.length >= 3, 3000);
    const h = await (await fetch(`http://127.0.0.1:${s.ports.http}/health`)).json();
    assert.deepEqual({ ...h.dns, at: undefined }, { provider: 'namecheap', name: 'relay2.riyeser.com', ok: true, at: undefined, error: null });
    assert.ok(!JSON.stringify(h).includes(PASSWORD) && !JSON.stringify(s.info()).includes(PASSWORD));
    assert.ok(s.logLines.some((l) => /DNS: relay2\.riyeser\.com now points at 127\.0\.0\.1 \(Namecheap\)/.test(l)));
    assert.ok(!s.logLines.join('\n').includes(PASSWORD));
  } finally { await s.close(); await f.close(); }
  const s2 = await makeRelay({ id: 'dns2', turn: false, ddns: { provider: 'namecheap', host: 'relay', domain: 'riyeser.com' } });
  try { assert.ok(s2.logLines.some((l) => /DDNS_PROVIDER is namecheap but .*DDNS_PASSWORD is missing/.test(l))); } finally { await s2.close(); }
});
