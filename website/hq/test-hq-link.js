// Riyeser HQ: a business's Riyeser Link Office in the customer page's #cpLink (hq-link.js), in demo mode.
// Fills any #cpLink with data-ws; checks the one-line summary, the phones table, "Customer allowed help until…",
// no Show password, Set a new password (Link Office makes it; nobody at Riyeser sees it), and "not set up". Exits 1 on failure.
// Run: build the site, serve website/public on port 8090, then `node website/hq/test-hq-link.js <screenshot folder>`.
const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.'; let failed = false;
  try {
    const pg = await b.newPage({ viewport: { width: 1200, height: 900 } }); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
    await pg.goto('http://127.0.0.1:8090/hq/?demo'); await pg.waitForFunction(() => window.RiyeserHQLink);
    // the summary wording, straight from the function
    const line = await pg.evaluate(() => window.RiyeserHQLink.summary({ now: new Date().toISOString(), offices: [{ pc_name: 'OFFICE-PC', version: '1.1.0', state: 'running', last_seen: new Date(Date.now() - 120000).toISOString(),
      addresses: ['192.168.1.20'], sip_port: 5060, address_stable: true, phones: [...Array(6)].map((_, i) => ({ assigned: true, registered: i < 5 })) }] }));
    console.log('summary:', line);
    assert.strictEqual(line, 'Link Office: running on OFFICE-PC · v1.1.0 · last seen 2 min ago · 6 phones (5 connected) · address 192.168.1.20 (stable)');
    assert.strictEqual(await pg.evaluate(() => window.RiyeserHQLink.summary({ offices: [] })), 'Link Office: not set up');
    assert.strictEqual(await pg.evaluate(() => window.RiyeserHQLink.helpLine({ support: null })), 'Ask the customer to press \'Let Riyeser help\' on their Phones page');
    assert.match(await pg.evaluate(() => window.RiyeserHQLink.helpLine({ support: { until: new Date(Date.now() + 3e6).toISOString() } })), /^Customer allowed help until \d{1,2}:\d\d(am|pm)$/);
    // a #cpLink appearing in the page is filled by itself
    await pg.evaluate(() => { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = '<h3>Riyeser Link Office</h3><div id="cpLink" data-ws="w1">Link Office: not set up</div>';
      d.style.cssText = 'position:relative;z-index:99;margin:20px;background:#fff'; document.body.prepend(d); });
    await pg.waitForSelector('#cpLink .lnk-sum');
    console.log('#cpLink:', await pg.textContent('#cpLink .lnk-sum'), '|', await pg.textContent('#cpLink .lnk-help'));
    assert.match(await pg.textContent('#cpLink .lnk-sum'), /^Link Office: running on OFFICE-PC · v1\.1\.0 · last seen 2 min ago · 6 phones \(5 connected\) · 1 new phone found · address 192\.168\.1\.20 \(stable\)$/);
    assert.strictEqual(await pg.$$eval('#cpLink table.lnk', (t) => t[0].querySelectorAll('tr').length - 1), 7);
    // SEC-009: no Show password for Riyeser support; Set a new password asks Link Office to make one (nobody at Riyeser sees it)
    assert.strictEqual(await pg.$$eval('#cpLink [data-show]', (x) => x.length), 0, 'no Show password button');
    assert.ok(!/show password/i.test(await pg.textContent('#cpLink')), 'no Show password anywhere');
    await pg.click('#cpLink [data-lk="new_password"][data-ext="102"]');
    await pg.waitForSelector('#cpLink .lnk-stat.ok', { timeout: 8000 });
    const said = (await pg.textContent('#cpLink .lnk-stat')).replace(/\s+/g, ' ').trim(); console.log('set a new password:', said);
    assert.match(said, /^Done: Riyeser Link Office made a new password for extension 102 .* Nobody at Riyeser sees it/);
    assert.strictEqual(await pg.$$eval('#cpLink .lnk-pw, #cpLink code', (x) => x.length), 0, 'no password shown');
    await pg.screenshot({ path: out + '/hq-cplink.png' });
    // a business without one
    await pg.evaluate(() => { const el = document.getElementById('cpLink'); el.remove(); const d = document.createElement('div'); d.id = 'cpLink'; d.dataset.ws = 'none'; document.body.prepend(d); });
    await pg.waitForFunction(() => /not set up/.test((document.querySelector('#cpLink .lnk-sum') || {}).textContent || ''));
    console.log('no Link Office:', await pg.textContent('#cpLink .lnk-sum'));
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('HQ LINK TESTS PASSED');
})();
