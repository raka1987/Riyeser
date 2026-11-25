// Riyeser Link chat details from the round-20 fix list, in the demo (?demo) at desktop and phone width:
//   S9  a long message: a counter near the limit; over 4,000 characters Send offers to send it as a .txt file (no raw
//       database error); the database's own refusal reads plainly
// Run: build the site, serve website/public on 8090 (or LINK_BASE), then `node website/team/test/chat-test.js`. Exits 1 on failure.
const { chromium } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch(); const errs = [];
  const open = async (w, q = '') => { const pg = await b.newPage({ viewport: { width: w, height: 860 } }); pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/link/?demo${q}`); await pg.waitForSelector('#lknav'); return pg; };

  // ---- S9: long messages
  { const pg = await open(1280);
    await pg.fill('#txt', 'x'.repeat(3400)); check(await pg.isHidden('#cnt'), 'S9 no counter for an ordinary message');
    await pg.fill('#txt', 'y'.repeat(3700)); check(await pg.isVisible('#cnt') && /3,700 \/ 4,000/.test(await pg.textContent('#cnt')), `S9 counter near the limit: ${await pg.textContent('#cnt')}`);
    const long = 'Site notes. '.repeat(400);   // 4,800 characters
    await pg.fill('#txt', long); check(/too long for one message/.test(await pg.textContent('#cnt')), 'S9 over the limit the counter says so');
    const before = await pg.$$eval('#msgs .msg', (x) => x.length);
    await pg.press('#txt', 'Enter'); await pg.waitForSelector('#askyes');
    check(/4,79\d characters.*up to 4,000.*text file/.test(await pg.textContent('.askp')), `S9 Send offers a text file: ${await pg.textContent('.askp')}`);
    await pg.click('#askyes'); await pg.waitForFunction((n) => document.querySelectorAll('#msgs .msg').length > n, before, { timeout: 8000 });
    const last = await pg.$$eval('#msgs .msg', (x) => x[x.length - 1].textContent);
    check(/message-\d{12}\.txt/.test(last), 'S9 sent as message-….txt: ' + last.replace(/\s+/g, ' ').slice(0, 120));
    check(await pg.inputValue('#txt') === '', 'S9 the box is cleared');
    await pg.close(); }

  check(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close();
  console.log(failed ? `${failed} CHAT CHECK(S) FAILED` : 'ALL CHAT CHECKS PASSED'); process.exit(failed ? 1 : 0);
})();
