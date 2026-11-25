// The Riyeser Link workspace (phase 1), in the demo and against a pretend Supabase:
//  1. The three panels (nav, list, conversation) and the right panel (People / Info), header and Admin / Settings.
//  2. The status picker (Busy, Do not disturb, a status message, back to Available) and Away after 10 minutes idle.
//  3. Reactions: add and take back. 4. Pin and unpin a chat. 5. New chat: one person (a DM), and a few (a private chat).
//  6. The People panel: presence and extensions. 7. Quick dial. 8. The floating call bar between two tabs: mute, hold, end,
//     and chat while calling. 9. An incoming call: Answer and Decline, the 📞 title. 10. Themes: dark, light, match my
//     computer, accents, contrast spot checks, saved with the account; Riyeser home stays light and blue.
// 11. Admin / Settings is hidden for members. 12. Phone width (390px): one panel at a time, back buttons, no sideways scroll.
// 13. Files: send one, see the card, the 25 MB limit; against the pretend server the upload goes to the private link-files store.
// 14. A database that hasn't had this release's team-chat.sql: nothing breaks, reactions hide, pins fall back to the account.
// Screenshots (dark and light, desktop and phone) go to the folder given. Exits 1 on any failure.
// Run: build the site, serve website/public (LINK_BASE=http://127.0.0.1:8091 for another port), then
//   node website/team/test/link-ui-test.js <screenshots folder>
const { chromium, devices } = require('playwright');
const assert = require('assert');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const DEMO = BASE + '/link/?demo';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// WCAG contrast of two computed CSS colours (rgb/rgba; alpha is blended over the background given)
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
async function contrast(pg, sel) {
  return pg.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const bgOf = (e) => { let stack = []; for (let n = e; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 4 && c[3] === 0) continue; stack.push(c); if (c.length < 4 || c[3] >= 1) break; }
      let out = [255, 255, 255]; for (const c of stack.reverse()) { const a = c.length === 4 ? c[3] : 1; out = out.map((v, i) => Math.round(c[i] * a + v * (1 - a))); } return out; };
    return { fg: rgb(getComputedStyle(el).color).slice(0, 3), bg: bgOf(el) };
  }, sel).then((r) => (r ? Math.round(ratio(r.fg, r.bg) * 100) / 100 : null));
}

(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const errs = []; const out = process.argv[2] || '.'; let failed = false;
  const watch = (p, as) => { p.on('pageerror', (e) => errs.push(`${as}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|realtime/i.test(m.text())) errs.push(`${as}: ${m.text()}`); }); };
  const text = (p, sel) => p.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const itext = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim());
  const status = (p) => p.evaluate(() => { const c = window.RiyeserTeam.calls.current; return c ? c.status : 'none'; });
  const until = async (p, want, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await status(p)) === want) return true; await p.waitForTimeout(100); } return false; };
  const over = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  try {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
    const pg = await ctx.newPage(); watch(pg, 'me');
    await pg.goto(DEMO); await pg.waitForSelector('#lknav [data-nav]');

    // 1. the layout
    const box = async (sel) => pg.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; });
    const [nav, list, main, right] = [await box('#lknav'), await box('#side'), await box('#main'), await box('#lkright')];
    console.log('panels:', { nav, list, main, right });
    assert.ok(nav.w > 150 && list.w > 250 && main.w > 400 && right.w > 250, 'four columns showing');
    assert.ok(nav.x < list.x && list.x < main.x && main.x < right.x, 'nav | list | conversation | people, left to right');
    assert.match(await pg.$eval('.lk-logo', (e) => e.innerText.replace(/\s+/g, ' ')), /Li\. Riyeser Link Business Communications/);
    assert.strictEqual(await pg.getAttribute('#q', 'placeholder'), 'Search chats, people, calls…');
    assert.deepStrictEqual(await pg.$$eval('#lknav [data-nav] span:first-of-type', (x) => x.map((y) => y.textContent)), ['Home', 'Chat', 'Calls', 'Contacts', 'Teams / Channels', 'Devices']);
    assert.ok(await pg.$('#lknav #cophones'), 'Desk Phones for the owner'); assert.ok(await pg.$('#adming #coppl') && await pg.$('#adming #coplan') && !(await pg.$('#cobill')), 'Admin / Settings for the owner, with Plan & billing and no Billing & Subscription');
    assert.match(await text(pg, '#side .lk-tabs'), /^Chats \d+ Calls \d+ Voicemail 0$/);
    assert.deepStrictEqual(await pg.$$eval('#side .sec', (x) => x.map((y) => y.firstChild.textContent.trim())), ['Pinned', 'Channels', 'Direct messages']);
    assert.match(await text(pg, '#mhead h2'), /# general/); assert.match(await pg.getAttribute('#txt', 'placeholder'), /^Type a message in #general…$/);
    for (const id of ['#ppl', '#infobtn', '#morebtn', '#attach', '#emo', '#send']) assert.ok(await pg.$(id), id);
    for (const id of ['#vidbtn', '#callch']) assert.ok(!(await pg.$(id)), id + ' hidden in a channel until group calls exist (M9)');
    const day = await pg.$$eval('#msgs .day', (x) => x.map((y) => y.textContent)); assert.ok(day.includes('Today'), 'Today divider');
    assert.ok(await pg.$('#msgs .msg.cont'), 'grouped by author');
    await pg.screenshot({ path: out + '/link-dark-desktop.png' });
    // the voicemail tab and the calls tab
    await pg.click('[data-tab=voicemail]'); assert.match(await text(pg, '.lk-vm'), /Coming with Riyeser Link Office voicemail/);
    await pg.click('[data-tab=calls]'); assert.ok((await pg.$$('.lk-callrow')).length >= 3, 'call history'); await pg.click('[data-tab=chats]');
    // Home: the six cards (Requests for owners/admins)
    await pg.click('[data-nav=home]'); await pg.waitForSelector('#hdevices .mi, #hdevices .muted');
    assert.deepStrictEqual(await pg.$$eval('.lk-card h3', (x) => x.map((y) => y.textContent.trim())), ['Recent conversations', 'Quick call', 'Missed calls', 'Team channels', 'Requests', 'My devices']);
    await pg.waitForFunction(() => /T31P|desk phone/i.test(document.querySelector('#hdevices').textContent));
    console.log('home my devices:', await text(pg, '#hdevices'));
    await pg.screenshot({ path: out + '/link-dark-home.png' });
    await pg.click('[data-nav=chat]');

    // 6. People panel: presence and extensions
    const people = await pg.$$eval('#plist .lk-person', (x) => x.map((r) => [r.querySelector('.lk-pn b').textContent.trim(), r.querySelector('.lk-pst').textContent.trim(), r.querySelector('.lk-ext').textContent.trim(), r.querySelector('.pd').className]));
    console.log('people:', people.map((p) => p.slice(0, 3).join(' / ')));
    const P = Object.fromEntries(people.map((p) => [p[0], p]));
    assert.deepStrictEqual(P['Sam Taylor'].slice(1), ['Available', 'Ext. 102', 'pd st-available']);
    assert.deepStrictEqual(P['Jordan Lee'].slice(1), ['On a call', 'Ext. 201', 'pd st-call']);
    assert.match(P['Alex Nguyen'][1], /^Away \(1\dm\)$/); assert.strictEqual(P['Alex Nguyen'][3], 'pd st-away');
    assert.deepStrictEqual(P['Ana Ruiz'].slice(1), ['Offline', 'Ext. 103', 'pd st-offline']);
    assert.match(await text(pg, '[data-rt=people]'), /^People \(5\)$/);
    await pg.fill('#psearch', '20'); assert.deepStrictEqual(await pg.$$eval('#plist .lk-pn b', (x) => x.map((y) => y.textContent)), ['Jordan Lee', 'Alex Nguyen']); await pg.fill('#psearch', '');
    assert.strictEqual((await pg.$$('#plist [data-callp]')).length, 4, 'a call button for each other person (Link Plus)');

    // 2. status picker, and Away after 10 minutes idle
    const myStatus = () => text(pg, '#stbtn');
    await pg.click('#stbtn'); await pg.click('[data-st=busy]'); assert.strictEqual(await myStatus(), 'In the office today');
    await pg.click('#stbtn'); await pg.fill('#stf input', ''); await pg.click('#stf .btn'); assert.strictEqual(await myStatus(), 'Busy');
    assert.strictEqual(await pg.$eval('#stbtn .pd', (x) => x.className), 'pd st-busy');
    await pg.click('#stbtn'); await pg.click('[data-st=dnd]'); assert.strictEqual(await myStatus(), 'Do not disturb');
    await pg.click('#stbtn'); await pg.fill('#stf input', 'At the Elm St job'); await pg.click('#stf .btn'); assert.strictEqual(await myStatus(), 'At the Elm St job');
    await pg.click('#stbtn'); await pg.fill('#stf input', ''); await pg.click('#stf .btn');
    await pg.click('#stbtn'); await pg.click('[data-st=available]'); assert.strictEqual(await myStatus(), 'Available');
    await pg.evaluate(() => window.RiyeserTeam.presence.tick(Date.now() + 11 * 60000));
    assert.match(await myStatus(), /^Away \(1\dm\)$/); assert.strictEqual(await pg.$eval('#stbtn .pd', (x) => x.className), 'pd st-away');
    console.log('after 11 idle minutes:', await myStatus());
    await pg.mouse.move(400, 400); await pg.mouse.move(420, 420); await pg.keyboard.press('Shift');
    assert.strictEqual(await myStatus(), 'Available'); console.log('status picker and auto-away: ok');

    // 3. reactions: add and take back
    const chip = (id, e) => pg.$eval(`.msg[data-id="${id}"] [data-rx="${e}"]`, (x) => [x.querySelector('span').textContent, x.getAttribute('aria-pressed')]).catch(() => null);
    assert.deepStrictEqual(await chip('m1', '👍'), ['2', 'false']);
    await pg.click('.msg[data-id="m1"] [data-rx="👍"]'); assert.deepStrictEqual(await chip('m1', '👍'), ['3', 'true']);
    await pg.click('.msg[data-id="m1"] [data-rx="👍"]'); assert.deepStrictEqual(await chip('m1', '👍'), ['2', 'false']);
    await pg.hover('.msg[data-id="m2"] .mb'); await pg.click('.msg[data-id="m2"] [data-act=react]'); await pg.click('[data-rxp="😂"]');
    assert.deepStrictEqual(await chip('m2', '😂'), ['1', 'true']);
    await pg.click('.msg[data-id="m2"] [data-rx="😂"]'); assert.strictEqual(await chip('m2', '😂'), null);
    console.log('reactions add and remove: ok');

    // 4. pin and unpin
    const section = (id) => pg.evaluate((cid) => { let sec = ''; for (const n of document.querySelector('#lscroll').children) { if (n.classList.contains('sec')) sec = n.firstChild.textContent.trim(); if (n.querySelector && n.querySelector(`[data-ch="${cid}"]`)) return sec; } return null; }, id);
    assert.strictEqual(await section('c-office'), 'Channels');
    await pg.hover('[data-ch="c-office"]'); await pg.click('[data-pin="c-office"]'); assert.strictEqual(await section('c-office'), 'Pinned');
    await pg.hover('[data-ch="c-office"]'); await pg.click('[data-pin="c-office"]'); assert.strictEqual(await section('c-office'), 'Channels');
    await pg.click('[data-ch="c-office"]'); await pg.click('#morebtn'); await pg.click('#mpin'); assert.strictEqual(await section('c-office'), 'Pinned');
    await pg.click('#morebtn'); assert.match(await text(pg, '#mpin'), /Unpin this chat/); await pg.click('#mpin'); assert.strictEqual(await section('c-office'), 'Channels');
    console.log('pin and unpin: ok');

    // 5. New chat: one person, then a few
    await pg.click('#newchat'); await pg.waitForSelector('#ncf'); await pg.check('#ncf input[value="u-ana"]'); await pg.click('#ncgo');
    await pg.waitForFunction(() => /Ana Ruiz/.test(document.querySelector('#mhead h2').textContent)); assert.ok(await pg.$('#calldm'));
    await pg.click('#newchat'); await pg.fill('#ncq', 'a'); await pg.check('#ncf input[value="u-sam"]'); await pg.check('#ncf input[value="u-alex"]');
    assert.strictEqual(await text(pg, '#ncgo'), 'Start group chat (3)'); await pg.fill('#ncf input[name=name]', 'Yard crew'); await pg.click('#ncgo');
    await pg.waitForFunction(() => /yard-crew/.test(document.querySelector('#mhead h2').textContent));
    assert.match(await text(pg, '#mhead small'), /^Private · 3 people/); console.log('new chat: DM and group: ok');

    // 13. files (demo): send one, see the card; over 25 MB is refused
    await pg.click('[data-ch="c-jobs"]');
    await pg.setInputFiles('#file', { name: 'Site plan v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') });
    await pg.waitForFunction(() => [...document.querySelectorAll('.fcard b')].some((x) => x.textContent === 'Site_plan_v2.pdf'));
    assert.match(await pg.$$eval('.fcard', (x) => x.map((y) => y.textContent.replace(/\s+/g, ' ')).pop()), /Site_plan_v2\.pdf ?15 B/);
    const dl = pg.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await pg.click('.msg:last-child [data-file="0"]'); const d1 = await dl; assert.ok(d1 && d1.suggestedFilename() === 'Site_plan_v2.pdf', 'download');
    await pg.setInputFiles('#file', { name: 'huge.zip', mimeType: 'application/zip', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
    await pg.waitForSelector('#phmsg:not([hidden])'); assert.match(await text(pg, '#phmsg'), /huge\.zip is over 25 MB/);
    await pg.click('#infobtn'); assert.match(await text(pg, '.lk-info'), /Site_plan_v2\.pdf/); await pg.click('[data-rt=people]');
    console.log('files: ok');

    // 7. Quick dial
    for (const k of ['2', '0', '2']) await pg.click(`[data-qdk="${k}"]`);
    assert.match(await text(pg, '#qdw'), /^Alex Nguyen · Away/);
    await pg.fill('#qdn', '200'); await pg.dispatchEvent('#qdn', 'input'); assert.strictEqual(await text(pg, '#qdw'), 'Lautoka branch (everyone)');
    await pg.fill('#qdn', '999'); await pg.dispatchEvent('#qdn', 'input'); assert.strictEqual(await text(pg, '#qdw'), 'No one on that number');
    assert.ok(await pg.$('#qdcall.lk-green') && await pg.$('#qdvid'), 'green call and video buttons');

    // 8 and 9: two tabs (you, and Sam with ?as=u-sam): the floating call bar, and the incoming call
    const sam = await ctx.newPage(); watch(sam, 'sam'); await sam.goto(DEMO + '&as=u-sam'); await sam.waitForSelector('#lknav'); await pg.waitForTimeout(400);
    await pg.fill('#qdn', '102'); await pg.dispatchEvent('#qdn', 'input'); assert.match(await text(pg, '#qdw'), /^Sam Taylor/); await pg.click('#qdcall');
    assert.ok(await until(sam, 'incoming'), 'Sam rings');
    await sam.waitForSelector('#callbox.ringing'); console.log('incoming card:', await itext(sam, '#callbox .cwho > div'), '| title:', await sam.title());
    assert.match(await itext(sam, '#callbox .cwho > div'), /^You Ext\. 101 · Incoming call$/); assert.match(await sam.title(), /^📞 Incoming call from You \(ext\. 101\)/);
    assert.ok(await sam.$('#c-ans') && await sam.$('#c-dec'));
    await sam.screenshot({ path: out + '/link-incoming.png' });
    await sam.click('#c-ans'); assert.ok(await until(pg, 'live') && await until(sam, 'live'), 'both live');
    await pg.waitForSelector('#callbox.bar #ctime');
    assert.match(await itext(pg, '#callbox .cwho > div'), /^Sam Taylor Ext\. 102 · \d:\d\d$/);
    assert.deepStrictEqual(await pg.$$eval('#callbox .cb', (x) => x.map((y) => y.querySelector('span').textContent + (y.disabled ? ' (off)' : ''))), ['Mute', 'Hold', 'Audio', 'Camera', 'Transfer (off)', 'Conference (off)', 'End call']);
    await pg.click('#c-mute'); assert.deepStrictEqual(await pg.evaluate(() => { const c = window.RiyeserTeam.calls.current; return [c.muted, c.local.getAudioTracks()[0].enabled]; }), [true, false]);
    assert.strictEqual(await text(pg, '#c-mute span'), 'Unmute'); await pg.click('#c-mute');
    await pg.click('#c-hold'); assert.deepStrictEqual(await pg.evaluate(() => { const c = window.RiyeserTeam.calls.current; return [c.held, c.local.getAudioTracks()[0].enabled, document.getElementById('ra').muted]; }), [true, false, true]);
    assert.match(await text(pg, '#callbox .cwho small'), /On hold/); await sam.waitForFunction(() => /They put you on hold/.test(document.querySelector('#callbox .cwho small').textContent));
    await pg.screenshot({ path: out + '/link-callbar-hold.png' });
    await pg.click('#c-hold'); assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.calls.current.held), false);
    await pg.click('#c-audio'); await pg.waitForSelector('#ain'); assert.ok((await pg.$$('#ain option')).length >= 1, 'microphones listed'); await pg.keyboard.press('Escape');
    // chat while calling: the bar stays on every view
    await pg.fill('#txt', 'Talking to Sam now'); await pg.press('#txt', 'Enter'); await pg.click('[data-nav=contacts]'); assert.ok(await pg.isVisible('#callbox.bar'), 'bar stays on Contacts');
    await sam.waitForFunction(() => document.querySelector('#plist .lk-person[data-person="u-me"] .lk-pst').textContent === 'On a call', null, { timeout: 8000 });
    assert.strictEqual(await text(pg, '#stbtn'), 'On a call'); console.log('Sam sees me: On a call');
    await pg.click('#c-end'); assert.ok(await until(sam, 'ended'), 'Sam sees it end');
    await pg.click('[data-nav=chat]'); await pg.click('[data-tab=calls]');
    assert.match(await itext(pg, '.lk-callrow'), /Sam Taylor .* Outgoing · \d:\d\d · Ext\. 102$/); await pg.click('[data-tab=chats]');
    await pg.waitForTimeout(2700);
    // Sam calls you; you decline
    await sam.click('[data-dm="u-me"]'); await sam.click('#calldm'); assert.ok(await until(pg, 'incoming'));
    assert.match(await pg.title(), /^📞 Incoming call from Sam Taylor \(ext\. 102\)/);
    await pg.click('#c-dec'); assert.ok(await until(sam, 'ended')); assert.match(await sam.evaluate(() => window.RiyeserTeam.calls.current.note), /declined the call/);
    await pg.waitForTimeout(2700); assert.match(await pg.title(), /Riyeser Link$/);
    await pg.click('[data-tab=calls]'); assert.match(await itext(pg, '.lk-callrow'), /Sam Taylor .* Declined/); await pg.click('[data-tab=chats]');
    // Do not disturb: a call doesn't ring you; Sam hears you can't take it, you see it as missed
    await pg.click('#stbtn'); await pg.click('[data-st=dnd]'); await sam.waitForTimeout(2700); await sam.click('#calldm');
    assert.ok(await until(sam, 'ended')); assert.strictEqual(await status(pg), 'none', 'no ringing in DND');
    await pg.click('#stbtn'); await pg.click('[data-st=available]');
    console.log('call bar (mute, hold, audio, end), incoming answer/decline, DND: ok');
    await sam.close();

    // 10. themes
    const html = () => pg.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent, document.documentElement.dataset.scope]);
    assert.deepStrictEqual(await html(), ['dark', 'purple', 'link'], 'dark navy/purple by default');
    const checks = async (label) => {
      await pg.click('[data-nav=chat]'); await pg.click('[data-ch="c-general"]');
      const r = { text: await contrast(pg, '.msg:not(.cont) .mb'), muted: await contrast(pg, '.lk-r2 .pv'), button: await contrast(pg, '.lk-new'), nav: await contrast(pg, '.lk-ni.on span'),
        heading: await contrast(pg, '#mhead h2'), pill: await contrast(pg, '.rxc span'), badge: await contrast(pg, '#side .badge'), tab: await contrast(pg, '.lk-tabs button.on') };
      console.log(`contrast ${label}:`, JSON.stringify(r));
      for (const [k, v] of Object.entries(r)) assert.ok(v >= 4.5, `${label}: ${k} contrast ${v} is below 4.5`);
    };
    await checks('dark/purple');
    for (const a of ['blue', 'teal', 'green', 'orange', 'pink']) { await pg.evaluate((x) => window.RiyeserTeam.theme.set({ accent: x }, false), a); await checks('dark/' + a); }
    // through Settings → Appearance
    await pg.click('#coset'); await pg.click('[data-s=look]'); await pg.waitForSelector('.tpick');
    await pg.click('.tcard:has(input[value=light])'); await pg.click('.acc:has(input[value=teal])');
    assert.deepStrictEqual(await html(), ['light', 'teal', 'link']); await pg.screenshot({ path: out + '/link-appearance.png' }); await pg.click('.mcard #cl');
    for (const a of ['purple', 'blue', 'teal', 'green', 'orange', 'pink']) { await pg.evaluate((x) => window.RiyeserTeam.theme.set({ accent: x }, false), a); await checks('light/' + a); }
    await pg.evaluate(() => window.RiyeserTeam.theme.set({ accent: 'purple' }));
    await pg.screenshot({ path: out + '/link-light-desktop.png' });
    // match my computer
    await pg.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'system' })); await pg.emulateMedia({ colorScheme: 'dark' }); await pg.waitForTimeout(100);
    assert.strictEqual((await html())[0], 'dark'); await pg.emulateMedia({ colorScheme: 'light' }); await pg.waitForTimeout(100); assert.strictEqual((await html())[0], 'light');
    // kept in this browser for next time, and with the account
    await pg.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'light', accent: 'orange' }));
    assert.deepStrictEqual(await pg.evaluate(() => window.RiyeserTeam.state.user.user_metadata.riyeser_prefs), { theme: 'light', accent: 'orange' });
    await pg.reload(); await pg.waitForSelector('#lknav'); assert.deepStrictEqual(await html(), ['light', 'orange', 'link']);
    console.log('themes: ok');
    await pg.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'dark', accent: 'purple' }));

    // 11. Admin / Settings hidden for members
    const jo = await ctx.newPage(); watch(jo, 'jordan'); await jo.goto(DEMO + '&as=u-jordan'); await jo.waitForSelector('#lknav');
    assert.ok(!(await jo.$('#adming')) && !(await jo.$('#coppl')) && !(await jo.$('#cophones')) && !(await jo.$('#cobill')) && !(await jo.$('#coplan')), 'no admin group (and no Plan & billing) for a member');
    assert.ok(await jo.$('#comyphone'), 'members get My phone'); assert.strictEqual(await text(jo, '#umr'), 'Staff');
    await jo.click('[data-nav=home]'); await jo.waitForSelector('.lk-card'); assert.ok(!(await jo.$('#hrequests')), 'no Requests card for a member');
    console.log('admin group hidden for members: ok'); await jo.close();
    await ctx.close();

    // 12. phone width: one panel at a time, with back buttons, no sideways scroll
    for (const theme of ['dark', 'light']) {
      const mc = await b.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
      await mc.addInitScript((t) => { try { localStorage.setItem('riyeser.link.look', JSON.stringify({ theme: t, accent: 'purple' })); } catch { /* */ } }, theme);
      const ph = await mc.newPage(); watch(ph, 'phone-' + theme); await ph.goto(DEMO); await ph.waitForSelector('#side .item');
      assert.strictEqual(await ph.viewportSize().width, 390);
      const vis = () => ph.evaluate(() => ['#lknav', '#side', '#main', '#lkright'].filter((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth; }));
      assert.deepStrictEqual(await vis(), ['#side'], 'starts on the list'); assert.strictEqual(await over(ph), 0);
      await ph.screenshot({ path: out + `/link-${theme}-phone-list.png` });
      await ph.tap('[data-ch="c-general"]'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#main']); assert.strictEqual(await over(ph), 0);
      await ph.screenshot({ path: out + `/link-${theme}-phone-chat.png` });
      await ph.tap('#infobtn'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#lkright']); assert.strictEqual(await over(ph), 0);
      await ph.tap('#lkright .back'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#main']);
      await ph.tap('#mhead .back'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#side']);
      await ph.tap('#burger'); await ph.waitForTimeout(300); assert.ok((await vis()).includes('#lknav'), 'the nav opens over the list'); assert.strictEqual(await over(ph), 0);
      await ph.screenshot({ path: out + `/link-${theme}-phone-nav.png` });
      await ph.tap('[data-nav=contacts]'); await ph.waitForTimeout(250); assert.deepStrictEqual(await vis(), ['#main']); assert.strictEqual(await over(ph), 0);
      await ph.tap('.lk-vback'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#side']);
      if (theme === 'dark') {
        await ph.tap('[data-dm="u-sam"]'); await ph.tap('#calldm'); const t0 = Date.now(); while (Date.now() - t0 < 6000 && (await status(ph)) !== 'live') await ph.waitForTimeout(150);
        assert.strictEqual(await over(ph), 0); await ph.screenshot({ path: out + '/link-dark-phone-call.png' }); await ph.click('#c-end');
      }
      await mc.close();
    }
    console.log('phone width: ok');

    // 13/14. against a pretend Supabase: presence, reactions, pins, files and your look go to the right places;
    // and a database without this release's team-chat.sql: nothing breaks
    const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }], user_metadata: { riyeser_prefs: { theme: 'light', accent: 'teal' } } };
    const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
    const W = '11111111-2222-4333-8444-555555555555'; const G = '22222222-3333-4444-8555-666666666666';
    const fake = async (page, old) => {
      const st = { rpc: [], rest: [], storage: [], userPut: [] }; let mid = 0;
      const msgs = [{ id: 'aaaa0000-0000-4000-8000-000000000001', channel_id: G, workspace_id: W, user_id: 'bbbbbbbb-0000-4000-8000-000000000002', body: 'Morning all', created_at: new Date(Date.now() - 600000).toISOString(), edited_at: null, deleted: false }];
      await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
      await page.route('https://fake.supabase.test/**', async (r) => {
        const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', ''); const body = (() => { try { return JSON.parse(r.request().postData() || '{}'); } catch { return {}; } })();
        const json = (x, s = 200) => r.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(x) });
        if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (u.pathname.startsWith('/rest/v1/rpc/')) st.rpc.push([fn, body]); else if (u.pathname.startsWith('/rest/v1/')) st.rest.push([m, u.pathname.slice(9), u.search, body]);
        if (old && /^link_presence/.test(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
        if (old && /message_reactions|channel_pins/.test(u.pathname)) return json({ code: 'PGRST205', message: `Could not find the table 'public.${u.pathname.split('/').pop()}' in the schema cache` }, 404);
        if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
        if (u.pathname === '/auth/v1/user' && m === 'PUT') { st.userPut.push(body); user.user_metadata = { ...user.user_metadata, ...body.data }; return json(user); }
        if (u.pathname === '/auth/v1/user') return json(user);
        if (u.pathname.startsWith('/storage/v1/object/sign/')) { st.storage.push(['sign', u.pathname]); return json({ signedURL: '/object/sign/link-files/x?token=t' }); }
        if (u.pathname.startsWith('/storage/v1/object/')) { st.storage.push([m, decodeURIComponent(u.pathname)]); return json({ Key: u.pathname.slice(19), Id: 'f1' }); }
        if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: W, name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
        if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }, { user_id: 'bbbbbbbb-0000-4000-8000-000000000002', display_name: 'Bo Example', role: 'member', job_role: 'staff', extension: 102 }]);
        if (u.pathname === '/rest/v1/channels') return json([{ id: G, kind: 'channel', name: 'general', topic: 'Everyone' }]);
        if (u.pathname === '/rest/v1/messages' && m === 'POST') { const x = { id: `aaaa0000-0000-4000-8000-00000000010${++mid}`, user_id: user.id, created_at: new Date().toISOString(), edited_at: null, deleted: false, ...body }; msgs.push(x); return json(x); }
        if (u.pathname === '/rest/v1/messages') return json(u.search.includes('order=created_at.desc') ? [...msgs].reverse() : msgs);
        if (fn === 'team_features') return json({ calls: true });
        if (fn === 'link_presence') return json([{ user_id: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'dnd', manual: null, custom_text: '', on_call: false, away_since: null, fresh: true },
          { user_id: user.id, status: 'busy', manual: 'busy', custom_text: 'Back at 2', on_call: false, fresh: true }]);
        if (u.pathname === '/rest/v1/message_reactions' && m === 'GET') return json([{ message_id: msgs[0].id, user_id: 'bbbbbbbb-0000-4000-8000-000000000002', emoji: '🎉' }]);
        if (u.pathname === '/rest/v1/channel_pins' && m === 'GET') return json([]);
        if (u.pathname === '/rest/v1/message_reactions' || u.pathname === '/rest/v1/channel_pins') return json([], 201);
        return json([]);
      });
      return st;
    };
    const fp = await b.newPage({ viewport: { width: 1366, height: 860 } }); watch(fp, 'server');
    const fs = await fake(fp, false);
    await fp.goto(BASE + '/link/'); await fp.waitForSelector('#gf');
    assert.deepStrictEqual(await fp.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.scope]), ['light', 'acct'], 'sign-in stays light');
    await fp.fill('input[name=email]', user.email); await fp.fill('input[name=password]', 'a-good-password'); await fp.click('button[type=submit]');
    await fp.waitForSelector('.hco');
    // Riyeser home keeps Riyeser blue even when the workspace is dark
    await fp.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'dark', accent: 'pink' }, false));
    assert.deepStrictEqual(await fp.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.querySelector('.btn.p, .hco .cid') || document.body).getPropertyValue('--brand').trim()]), ['light', '#1f62f0']);
    await fp.click('#hchat'); await fp.waitForSelector('#txt');
    assert.deepStrictEqual(await fp.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent]), ['dark', 'pink'], 'the workspace takes your look');
    await fp.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'light', accent: 'teal' }, false));
    assert.strictEqual(await text(fp, '#stbtn'), 'Back at 2', 'my saved status comes back');
    assert.strictEqual(await text(fp, '#plist .lk-person[data-person="bbbbbbbb-0000-4000-8000-000000000002"] .lk-pst'), 'Do not disturb');
    const pres = fs.rpc.filter(([f]) => f === 'link_presence_set').pop(); console.log('presence sent:', JSON.stringify(pres[1]));
    assert.deepStrictEqual(pres[1], { ws: W, st: 'busy', manual_choice: 'busy', custom: 'Back at 2', on_a_call: false });
    // reactions
    assert.strictEqual(await text(fp, '.rxc'), '🎉 1'); await fp.click('.rxc');
    const rxPost = fs.rest.find(([m, p]) => m === 'POST' && p === 'message_reactions'); assert.deepStrictEqual(rxPost[3], { message_id: 'aaaa0000-0000-4000-8000-000000000001', emoji: '🎉' });
    await fp.click('.rxc.me'); const rxDel = fs.rest.find(([m, p]) => m === 'DELETE' && p === 'message_reactions');
    assert.match(rxDel[2], /message_id=eq\.aaaa0000.*user_id=eq\.aaaaaaaa.*emoji=eq\./);
    // pins
    await fp.hover(`[data-ch="${G}"]`); await fp.click(`[data-pin="${G}"]`); const pinPost = fs.rest.find(([m, p]) => m === 'POST' && p === 'channel_pins');
    assert.deepStrictEqual(pinPost[3], { channel_id: G, user_id: user.id });
    // a file: into link-files/<business>/<chat>/<random>/<name>, then the message lists it
    await fp.setInputFiles('#file', { name: 'Quote 12.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF sample') });
    await fp.waitForFunction(() => [...document.querySelectorAll('.fcard b')].some((x) => x.textContent === 'Quote_12.pdf'));
    const up = fs.storage.find(([m]) => m === 'POST'); console.log('uploaded to:', up[1]);
    assert.match(up[1], new RegExp(`^/storage/v1/object/link-files/${W}/${G}/[0-9a-f]{20}/Quote_12\\.pdf$`));
    const sent = fs.rest.filter(([m, p]) => m === 'POST' && p === 'messages').pop()[3];
    assert.deepStrictEqual(sent.files, [{ path: up[1].replace('/storage/v1/object/link-files/', ''), name: 'Quote_12.pdf', size: 11, type: 'application/pdf' }]);
    assert.strictEqual(sent.body, '📎 Quote_12.pdf');
    await fp.click('.fcard [data-file]'); await fp.waitForTimeout(300); assert.ok(fs.storage.some(([m]) => m === 'sign'), 'a short-lived download link');
    // your look goes with your account
    await fp.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'light', accent: 'green' })); await fp.waitForTimeout(300);
    assert.deepStrictEqual(fs.userPut.pop().data.riyeser_prefs, { theme: 'light', accent: 'green' });
    await fp.screenshot({ path: out + '/link-server.png' });
    console.log('pretend server: presence, reactions, pins, files, look: ok');

    const op = await b.newPage({ viewport: { width: 1280, height: 860 } }); watch(op, 'old db');
    const os = await fake(op, true); user.user_metadata = {};
    await op.goto(BASE + '/link/?chat'); await op.waitForSelector('#gf'); await op.fill('input[name=email]', user.email); await op.fill('input[name=password]', 'a-good-password'); await op.click('button[type=submit]');
    await op.waitForSelector('#txt');
    assert.ok(!(await op.$('[data-act=react]')) && !(await op.$('.rxc')), 'no reactions before the database update');
    assert.strictEqual(await text(op, '#plist .lk-person[data-person="bbbbbbbb-0000-4000-8000-000000000002"] .lk-pst'), 'Offline');
    await op.hover(`[data-ch="${G}"]`); await op.click(`[data-pin="${G}"]`); await op.waitForTimeout(300);
    assert.deepStrictEqual(os.userPut.pop().data.riyeser_prefs.pinned, [G], 'pins kept with the account instead');
    await op.click('#stbtn'); await op.click('[data-st=busy]'); assert.strictEqual(await text(op, '#stbtn'), 'Busy');
    assert.strictEqual(os.rpc.filter(([f]) => f === 'link_presence_set').length, 0, 'no presence writes to a database without them');
    console.log('older database: ok');
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('LINK WORKSPACE TESTS PASSED');
})();
