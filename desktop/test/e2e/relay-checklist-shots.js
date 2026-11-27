// Link Office 1.3.1: pictures of Settings → Connect your branches (the guided checklist) in a real browser, with the
// window's bridge answered here: all good on the relay PC, a router port closed, the web name wrong (proxied through
// Cloudflare), UDP blocked at a site, the Overview with "This PC is the relay", one office with no branches, the
// "Stop using this PC as the relay" choices, and a phone-width window. It also checks nothing scrolls sideways.
// Run: node test/e2e/relay-checklist-shots.js <folder>   (needs playwright; exits 1 on a problem)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const C = require('../../src/renderer/link-relaycheck');

const OUT = process.argv[2] || 'relay-shots';
const PAGE = `file://${path.join(__dirname, '..', '..', 'src', 'renderer', 'link.html')}`;
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const BASE = { state: 'running', host: '192.168.1.20', sipPort: 5060, httpPort: 5080, version: '1.3.1', business: 'Sample Plumbing', licence: { active: true, text: 'Riyeser Link' },
  counts: { phones: 4, onCalls: 0, connected: 4 }, addressStable: true, cloud: { status: 'online', at: ago(1) }, source: 'team', siteName: 'Suva head office',
  people: [['101', 'Alex Sample'], ['102', 'Bo Sample'], ['103', 'Cam Sample'], ['104', 'Dee Sample']].map(([ext, name], i) => ({ id: `p${i}`, name, ext, device: 'desk phone', state: 'ready', dnd: false })),
  groups: [], phones: [], found: [], inProgress: [], recent: [], blocked: [], skipped: [], logs: [], names: { mdns: 'riyeser-office.local', router: null, useName: false, mode: 'address', server: '192.168.1.20' },
  addressChanges: [], adapters: { current: { name: 'Ethernet', address: '192.168.1.20', mac: '3C:52:82:1A:2B:3C', dhcp: false }, list: [] }, signedIn: true, platform: 'win32', startWithWindows: true, firewall: true,
  registrations: [{ ext: '101', ip: '192.168.1.50', device: 'desk phone' }] };
const RELAY = { state: 'connected', connected: true, relay: 'suva1', region: 'Suva head office', host: 'suva1.relay.invalid', rtt: 3, backup: false, primary: { id: 'suva1', region: 'Suva head office' },
  sites: [{ name: 'Nadi', exts: 2, via: 'here' }, { name: 'Lautoka', exts: 1, via: 'here' }], remote: 3, remoteExts: ['201', '202', '301'], phones: 1, udp: 'ok', since: ago(90), error: null, reconnects: 0, draining: [],
  relays: [{ id: 'suva1', region: 'Suva head office', pin: 'AB:CD', managed: true, online: true }, { id: 'mel1', region: 'Sydney (Riyeser)', online: true }], exp: Math.floor(Date.now() / 1000) + 5 * 3600,
  test: { ok: true, rtt_ms: 4, loss: 0, at: ago(2) } };
const HEALTH = { ok: true, relay: 'suva1', region: 'Suva head office', version: '1.1.0', uptime: 3 * 3600, sites: 3, cert_sha256: 'AB:CD', public_ip: '203.0.113.9', dns_name: null, sync: { ok: true }, removed: false };
const host = (over = {}) => ({ installed: true, health: { ...HEALTH, ...(over.health || {}) }, check: { port_map: { method: 'UPnP', mapped: 8, failed: 0 }, outside: { ok: true, via: 'mel1', results: [] }, ports: { https: 443, sipTls: 5061, turn: 3478, probe: 40000 }, ...(over.check || {}) },
  pc: { windows: 'ok', admin: true, diskFreeGb: 112, onBattery: false }, adapter: { address: '192.168.1.20', dhcp: false }, ...(over.rest || {}) });
const list = (facts, admin = null) => ({ ...C.build({ cloud: { status: 'online' }, exts: ['101', '102', '103', '104'], muted: [], ...facts }), facts, admin });

const STATES = {
  'allgood': { relay: RELAY, host: host() },
  'port-closed': { relay: RELAY, host: host({ check: { port_map: { method: null, mapped: 0, failed: 8, error: 'The router doesn\'t allow automatic port forwarding' }, outside: { ok: false, via: 'mel1', results: [{ proto: 'tcp', port: 443, open: true }, { proto: 'tcp', port: 5061, open: true }, { proto: 'udp', port: 3478, open: false }, { proto: 'udp', port: 40000, open: true }] } } }) },
  'dns-wrong': { relay: RELAY, host: { ...host({ health: { dns_name: 'relay.riyeser.com' } }), dns: { name: 'relay.riyeser.com', ips: ['104.21.33.7'], host: 'cloudflare' } } },
  'udp-blocked': { relay: { ...RELAY, region: 'Suva head office', rtt: 48, udp: 'blocked', test: { ok: false, sent: 50, received: 0, loss: 100, error: 'No sound came back: UDP to the relay seems blocked by this office\'s firewall or router.', at: ago(1) } }, host: null, site: 'Nadi' },
  'unused': { relay: { state: 'off', connected: false }, host: null },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch(); const problems = [];
  const shot = async (name, st, { width = 1280, height = 900, tab = 'settings', then } = {}) => {
    const l = list({ relay: st.relay, host: st.host }, st.admin || null);
    const status = { ...BASE, relay: st.relay, siteName: st.site || BASE.siteName, relayHost: st.host ? { installed: true, running: true, relay: 'suva1', region: 'Suva head office' } : null };
    const pg = await b.newPage({ viewport: { width, height } });
    pg.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
    await pg.addInitScript(({ status, l }) => {
      Object.defineProperty(window, 'api', { value: Object.freeze({ call: async (c) => (c === 'link:status' ? status : c === 'link:relay-checks' ? l : c === 'link:relay-admin' ? { code: 'RLY-7K3M-Q2XZ-WP4D', replaces: 'suva1' } : true), on() {} }), configurable: false });
      try { localStorage.setItem('link.tab', 'settings'); } catch { /* fine */ }
    }, { status, l });
    await pg.goto(PAGE); await pg.waitForTimeout(600);
    if (tab === 'overview') await pg.click('.tabs button[data-tab="overview"]').catch(() => {});
    else { const el = await pg.$('#relaypanel'); if (el) await el.scrollIntoViewIfNeeded(); }
    await pg.waitForTimeout(300);
    if (then) await then(pg);
    if (await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problems.push(`${name}: scrolls sideways`);
    const el = tab === 'overview' ? null : await pg.$('#relaypanel');
    if (el) await el.screenshot({ path: path.join(OUT, `linkoffice-${name}.png`) }); else await pg.screenshot({ path: path.join(OUT, `linkoffice-${name}.png`), fullPage: false });
    const txt = await pg.evaluate(() => (document.querySelector('#relay') || {}).innerText || '');
    await pg.close();
    return txt;
  };
  try {
    const good = await shot('checklist-allgood', STATES.allgood);
    if (!/All good — 3 sites connected/.test(good)) problems.push(`all good: ${good.slice(0, 200)}`);
    const port = await shot('checklist-port-closed', STATES['port-closed'], { then: (pg) => pg.click('#chk-ports details.how summary').catch(() => {}) });
    if (!/Closed from the internet: 3478\/UDP/.test(port)) problems.push('port closed not shown');
    const dns = await shot('checklist-dns-wrong', STATES['dns-wrong']);
    if (!/proxied through Cloudflare \(orange cloud\)/.test(dns)) problems.push('dns wrong not shown');
    const udp = await shot('checklist-udp-blocked', STATES['udp-blocked'], { then: (pg) => pg.click('#chk-sound details.how summary').catch(() => {}) });
    if (!/UDP blocked/.test(udp)) problems.push('udp blocked not shown');
    await shot('overview-this-pc-is-the-relay', STATES['port-closed'], { tab: 'overview' });
    await shot('overview-no-branches', STATES.unused, { tab: 'overview' });
    await shot('checklist-phone-width', STATES['udp-blocked'], { width: 390, height: 1400 });
    // the relay PC's card and "Stop using this PC as the relay" (an unlocked admin): the impact and the two choices
    await shot('stop-using-this-pc', { ...STATES.allgood, admin: { email: 'owner@sample.test', until: Date.now() + 15 * 60000 } }, { then: async (pg) => {
      await pg.click('[data-r="stop"]'); await pg.waitForSelector('dialog.stopflow');
      await pg.click('dialog.stopflow input[value="move"]'); await pg.click('dialog.stopflow button[value="code"]'); await pg.waitForTimeout(300);
      await pg.screenshot({ path: path.join(OUT, 'linkoffice-stop-move.png') });
      await pg.click('dialog.stopflow input[value="remove"]'); await pg.waitForTimeout(100);
      await pg.screenshot({ path: path.join(OUT, 'linkoffice-stop-remove.png') });
      const t = await pg.evaluate(() => document.querySelector('dialog.stopflow').innerText);
      if (!/move to Sydney \(Riyeser\) by themselves/.test(t)) problems.push(`stop flow impact: ${t.slice(0, 200)}`);
      await pg.click('dialog.stopflow button[value="close"]');
    } });
  } finally { await b.close(); }
  if (problems.length) { console.error(`PROBLEMS:\n${problems.join('\n')}`); process.exit(1); }
  console.log(`relay checklist pictures in ${OUT}`);
})();
