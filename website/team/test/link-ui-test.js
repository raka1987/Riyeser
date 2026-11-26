// The Riyeser Link workspace (phase 1), in the demo and against a pretend Supabase:
//  1. Concept A: a slim top bar, one list (All · Channels · People · Unread) and the chat; Calls and People as views.
//  2. Your status: Available, Busy / Do not disturb, At lunch, Away, Unavailable, "for how long", back to Available when
//     the time is up, and Away after 10 minutes idle. On a call and Offline can't be chosen.
//  3. Reactions: add and take back. 4. Pin and unpin a chat. 5. New chat: one person (a DM), and a few (a private chat).
//  6. Status next to names (details ⓘ, list). 7. The keypad only when asked for. 8. The call pill between two tabs: mute,
//     hold, end, chat while calling, "On a call" by itself. 9. An incoming call: Answer and Decline, the 📞 title; Busy,
//     At lunch and Unavailable don't ring (the caller is told; the database refuses too). 10. Themes: dark, light, match my
//     computer, accents, contrast spot checks, saved with the account; Riyeser home stays light and blue.
// 11. Management: locked, a fresh code each time, locks again after 15 idle minutes; staff never see it or any admin item.
// 12. Phone width (390px): Chats · Calls · People · Settings along the bottom, a chat full screen, no sideways scroll.
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
    await pg.goto(DEMO); await pg.waitForSelector('#lkshell .item');

    // 1. the layout (concept A): a slim top bar, then two panels (one list, one chat); details only on demand
    const box = async (sel) => pg.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; });
    const [list, main] = [await box('#side'), await box('#main')];
    console.log('panels:', { list, main });
    assert.ok(list.w > 250 && main.w > 800 && list.x < main.x, 'two panels: the list, then the chat filling the rest');
    assert.ok(!(await pg.isVisible('#lkright')) && !(await pg.isVisible('#lknav')), 'no details panel and no tab bar until asked for');
    assert.strictEqual(await text(pg, '#lkbiz'), 'Sample Plumbing');
    assert.strictEqual(await pg.getAttribute('#q', 'placeholder'), 'Search chats and people');
    for (const id of ['#tbcalls', '#tbpeople', '#stbtn', '#umenu']) assert.ok(await pg.isVisible(id), id + ' in the top bar');
    for (const id of ['#bell', '#helpbtn', '#adming', '#coppl', '#cophones', '#qd', '#rtog', '#ppl']) assert.ok(!(await pg.$(id)), id + ' is gone (no clutter)');
    assert.deepStrictEqual(await pg.$$eval('#side [data-filter]', (x) => x.map((y) => y.textContent)), ['All', 'Channels', 'People', 'Unread']);
    assert.strictEqual(await text(pg, '#newchat'), 'New');
    assert.deepStrictEqual(await pg.$$eval('#side .sec', (x) => x.length), 0, 'one list: channels and people together');
    const [order, pinnedIds] = await pg.evaluate(() => { const S = window.RiyeserTeam.state;
      return [[...document.querySelectorAll('#lscroll .item')].map((el) => el.dataset.ch || (S.chans.find((c) => c.kind === 'dm' && c.people.includes(el.dataset.dm)) || {}).id), S.pinned]; });
    assert.ok(pinnedIds.length >= 1); assert.deepStrictEqual(order.slice(0, pinnedIds.length), pinnedIds, 'pinned at the top');
    assert.ok(await pg.evaluate(() => [...document.querySelectorAll('#lscroll .lk-row')].every((r) => r.querySelectorAll('.badge').length <= 1)), 'at most one badge on each row');
    assert.match(await text(pg, '#mhead h2'), /# general/); assert.strictEqual(await pg.getAttribute('#txt', 'placeholder'), 'Message #general');
    for (const id of ['#callbtn', '#infobtn', '#morebtn', '#attach', '#emo', '#send']) assert.ok(await pg.$(id), id);
    assert.strictEqual(await text(pg, '#callbtn'), 'Call');
    const day = await pg.$$eval('#msgs .day', (x) => x.map((y) => y.textContent)); assert.ok(day.includes('Today'), 'Today divider');
    assert.ok(await pg.$('#msgs .msg.cont'), 'grouped by author');
    await pg.screenshot({ path: out + '/link-dark-desktop.png' });
    // Calls (with Voicemail) and People are views, not columns
    await pg.click('#tbcalls'); await pg.waitForSelector('#mview[data-view=calls]');
    assert.ok((await pg.$$('.lk-callrow')).length >= 3, 'call history'); assert.match(await text(pg, '#vmcard'), /Coming with Riyeser Link Office voicemail/);
    assert.ok(await pg.isVisible('#side'), 'the list stays beside a view');
    await pg.click('#tbpeople'); await pg.waitForSelector('#cdir'); await pg.click('#vclose'); await pg.waitForSelector('#mhead');

    // 6. status shows next to names: the details (ⓘ) list members with status and extension
    await pg.click('#infobtn'); await pg.waitForSelector('#plist');
    const people = await pg.$$eval('#plist .lk-person', (x) => x.map((r) => [r.querySelector('.lk-pn b').textContent.trim(), r.querySelector('.lk-pst').textContent.trim(), r.querySelector('.lk-ext').textContent.trim(), r.querySelector('.pd').className]));
    console.log('people:', people.map((p) => p.slice(0, 3).join(' / ')));
    const P = Object.fromEntries(people.map((p) => [p[0], p]));
    assert.deepStrictEqual(P['Sam Taylor'].slice(1), ['Available', 'Ext. 102', 'pd st-available']);
    assert.deepStrictEqual(P['Jordan Lee'].slice(1), ['On a call', 'Ext. 201', 'pd st-call'], 'On a call (a desk phone call) shows by itself');
    assert.match(P['Alex Nguyen'][1], /^Away \(1\dm\)$/); assert.strictEqual(P['Alex Nguyen'][3], 'pd st-away');
    assert.match(P['Ana Ruiz'][1], /^At lunch 🍽 until \d{1,2}:\d\d/); assert.strictEqual(P['Ana Ruiz'][3], 'pd st-lunch');
    await pg.fill('#psearch', '20'); assert.deepStrictEqual(await pg.$$eval('#plist .lk-pn b', (x) => x.map((y) => y.textContent)), ['Alex Nguyen', 'Jordan Lee']); await pg.fill('#psearch', '');
    assert.strictEqual((await pg.$$('#plist [data-callp]')).length, 4, 'a call button for each other person (Riyeser Link on)');
    assert.match(await text(pg, '[data-dm="u-ana"] .pv'), /At lunch/, 'status in the list too');
    await pg.click('#rclose'); assert.ok(!(await pg.$('#lkshell.details')));

    // 2. the status menu: the five choices, "for how long", a note; Away after 10 minutes idle
    const myStatus = () => text(pg, '#stbtn');
    await pg.click('#stbtn'); await pg.waitForSelector('.stmenu');
    assert.deepStrictEqual(await pg.$$eval('.stmenu [data-st]', (x) => x.map((y) => y.dataset.st)), ['available', 'dnd', 'lunch', 'away', 'unavailable'], 'Available, Busy / Do not disturb, At lunch, Away, Unavailable');
    assert.ok(!(await pg.$('.stmenu [data-st=offline]')) && !(await pg.$('.stmenu [data-st=call]')), 'On a call and Offline can\'t be chosen');
    await pg.click('[data-st=dnd]'); assert.strictEqual(await myStatus(), 'Busy · Do not disturb'); assert.strictEqual(await pg.$eval('#stbtn .pd', (x) => x.className), 'pd st-dnd');
    await pg.click('[data-st=lunch]'); assert.strictEqual(await myStatus(), 'At lunch 🍽');
    await pg.click('[data-until="60"]'); assert.match(await myStatus(), /^At lunch 🍽 until \d{1,2}:\d\d/, 'At lunch for 1 hour');
    await pg.screenshot({ path: out + '/link-status-menu.png' });
    await pg.selectOption('#sttime', { index: 3 }); assert.match(await myStatus(), /until/, 'until a time');
    await pg.fill('#stf input', 'At the Elm St job'); await pg.click('#stf .btn'); assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.state.myText), 'At the Elm St job');
    // the time is up: back to Available by itself
    await pg.evaluate(() => window.RiyeserTeam.presence.tick(Date.parse(window.RiyeserTeam.state.myUntil) + 60000));
    assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.state.myManual), null, 'the chosen status ends when its time is up'); assert.doesNotMatch(await myStatus(), /lunch/);
    await pg.mouse.move(400, 400); await pg.mouse.move(410, 410); await pg.keyboard.press('Shift'); assert.strictEqual(await myStatus(), 'Available', 'back to Available');
    await pg.click('#stbtn'); await pg.click('[data-st=unavailable]'); assert.strictEqual(await myStatus(), 'Unavailable'); assert.strictEqual(await pg.$eval('#stbtn .pd', (x) => x.className), 'pd st-unavailable');
    await pg.click('[data-st=away]'); assert.strictEqual(await myStatus(), 'Away');
    await pg.click('[data-st=available]'); assert.strictEqual(await myStatus(), 'Available'); assert.ok(!(await pg.$('.stmenu')), 'Available closes the menu');
    // one tap on your picture: status first, then the rest
    await pg.click('#umenu'); await pg.waitForSelector('.usermenu [data-st]');
    assert.deepStrictEqual(await pg.$$eval('.usermenu .mi:not([data-st])', (x) => x.map((y) => y.id)), ['um-phone', 'coset', 'um-mgmt', 'um-help', 'out']);
    await pg.click('.usermenu [data-st=dnd]'); assert.strictEqual(await myStatus(), 'Busy · Do not disturb'); await pg.click('.usermenu [data-st=available]');
    await pg.keyboard.press('Escape');
    await pg.evaluate(() => window.RiyeserTeam.presence.tick(Date.now() + 11 * 60000));
    assert.match(await myStatus(), /^Away \(1\dm\)$/); assert.strictEqual(await pg.$eval('#stbtn .pd', (x) => x.className), 'pd st-away');
    console.log('after 11 idle minutes:', await myStatus());
    await pg.mouse.move(400, 400); await pg.mouse.move(420, 420); await pg.keyboard.press('Shift');
    assert.strictEqual(await myStatus(), 'Available'); console.log('status menu, until, and auto-away: ok');

    // 3. reactions: add and take back
    const chip = (id, e) => pg.$eval(`.msg[data-id="${id}"] [data-rx="${e}"]`, (x) => [x.querySelector('span').textContent, x.getAttribute('aria-pressed')]).catch(() => null);
    assert.deepStrictEqual(await chip('m1', '👍'), ['2', 'false']);
    await pg.click('.msg[data-id="m1"] [data-rx="👍"]'); assert.deepStrictEqual(await chip('m1', '👍'), ['3', 'true']);
    await pg.click('.msg[data-id="m1"] [data-rx="👍"]'); assert.deepStrictEqual(await chip('m1', '👍'), ['2', 'false']);
    await pg.hover('.msg[data-id="m2"] .mb'); await pg.click('.msg[data-id="m2"] [data-act=react]'); await pg.click('[data-rxp="😂"]');
    assert.deepStrictEqual(await chip('m2', '😂'), ['1', 'true']);
    await pg.click('.msg[data-id="m2"] [data-rx="😂"]'); assert.strictEqual(await chip('m2', '😂'), null);
    console.log('reactions add and remove: ok');

    // 4. pin and unpin: pinned chats go to the top, with a pin mark
    const first = () => pg.evaluate(() => { const ids = [...document.querySelectorAll('#lscroll .item')].map((e) => e.dataset.ch); const n = window.RiyeserTeam.state.pinned.length; return ids.indexOf('c-office') > -1 && ids.indexOf('c-office') < n ? 'c-office' : 'not pinned'; });   // up with the pinned chats
    await pg.click('[data-ch="c-office"]'); await pg.click('#morebtn'); await pg.click('#mpin'); assert.strictEqual(await first(), 'c-office');
    assert.ok(await pg.$('[data-ch="c-office"] .pinmark'));
    await pg.click('#morebtn'); assert.match(await text(pg, '#mpin'), /Unpin this chat/); await pg.click('#mpin'); assert.ok(!(await pg.$('[data-ch="c-office"] .pinmark')));
    await pg.click('#infobtn'); await pg.click('#ipin'); assert.strictEqual(await first(), 'c-office', 'Pin from the details too'); await pg.click('#ipin'); await pg.click('#rclose');
    console.log('pin and unpin: ok');

    // 5. New chat: one person, then a few
    await pg.click('#newchat'); await pg.waitForSelector('#ncf'); await pg.check('#ncf input[value="u-ana"]'); await pg.click('#ncgo');
    await pg.waitForFunction(() => /Ana Ruiz/.test(document.querySelector('#mhead h2').textContent)); assert.ok(await pg.$('#callbtn'));
    await pg.click('#newchat'); await pg.fill('#ncq', 'a'); await pg.check('#ncf input[value="u-sam"]'); await pg.check('#ncf input[value="u-alex"]');
    assert.strictEqual(await text(pg, '#ncgo'), 'Start group chat (3)'); await pg.fill('#ncf input[name=name]', 'Yard crew'); await pg.click('#ncgo');
    await pg.waitForFunction(() => /yard-crew/.test(document.querySelector('#mhead h2').textContent));
    assert.match(await text(pg, '#mhead small'), /^3 people/); console.log('new chat: DM and group: ok');

    // 13. files (demo): send one, see the card; over 25 MB is refused
    await pg.click('[data-ch="c-jobs"]');
    await pg.setInputFiles('#file', { name: 'Site plan v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') });
    await pg.waitForFunction(() => [...document.querySelectorAll('.fcard b')].some((x) => x.textContent === 'Site_plan_v2.pdf'));
    assert.match(await pg.$$eval('.fcard', (x) => x.map((y) => y.textContent.replace(/\s+/g, ' ')).pop()), /Site_plan_v2\.pdf ?15 B/);
    const dl = pg.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await pg.click('.msg:last-child [data-file="0"]'); const d1 = await dl; assert.ok(d1 && d1.suggestedFilename() === 'Site_plan_v2.pdf', 'download');
    await pg.setInputFiles('#file', { name: 'huge.zip', mimeType: 'application/zip', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
    await pg.waitForSelector('#phmsg:not([hidden])'); assert.match(await text(pg, '#phmsg'), /huge\.zip is over 25 MB/);
    await pg.click('#infobtn'); assert.match(await text(pg, '.lk-info'), /Site_plan_v2\.pdf/); await pg.click('#rclose');
    console.log('files: ok');

    // 7. the keypad only when asked for: Call → Keypad, and on Calls
    await pg.click('#callbtn'); await pg.waitForSelector('.callmenu'); assert.ok(await pg.$('.callmenu [data-cw]') && !(await pg.$('.callmenu #vidbtn')), 'a channel: call one person');
    await pg.click('#callkeys'); await pg.waitForSelector('#dpn'); await pg.click('.modal #cl');
    await pg.click('#tbcalls'); await pg.waitForSelector('#vdn');
    for (const k of ['2', '0', '2']) await pg.click(`[data-vdk="${k}"]`);
    assert.match(await text(pg, '#vdw'), /^Alex Nguyen · Away/);
    await pg.fill('#vdn', '200'); await pg.dispatchEvent('#vdn', 'input'); assert.strictEqual(await text(pg, '#vdw'), 'Lautoka branch (everyone)');
    await pg.fill('#vdn', '999'); await pg.dispatchEvent('#vdn', 'input'); assert.strictEqual(await text(pg, '#vdw'), 'No one on that number');
    assert.ok(await pg.$('#vdcall.lk-green') && await pg.$('#vdvid'), 'green call and video buttons');
    await pg.click('#vclose');

    // 8 and 9: two tabs (you, and Sam with ?as=u-sam): the call pill, and the incoming call
    const sam = await ctx.newPage(); watch(sam, 'sam'); await sam.goto(DEMO + '&as=u-sam'); await sam.waitForSelector('#lkshell .item'); await pg.waitForTimeout(400);
    await pg.click('[data-dm="u-sam"]'); await pg.click('#callbtn'); await pg.waitForSelector('#calldm'); assert.match(await text(pg, '#calldm'), /Voice call/); await pg.click('#calldm');
    assert.ok(await until(sam, 'incoming'), 'Sam rings');
    await sam.waitForSelector('#callbox.ringing'); console.log('incoming card:', await itext(sam, '#callbox .cwho > div'), '| title:', await sam.title());
    assert.match(await itext(sam, '#callbox .cwho > div'), /^You Ext\. 101 · Incoming call$/); assert.match(await sam.title(), /^📞 Incoming call from You \(ext\. 101\)/);
    assert.ok(await sam.$('#c-ans') && await sam.$('#c-dec'));
    await sam.screenshot({ path: out + '/link-incoming.png' });
    await sam.click('#c-ans'); assert.ok(await until(pg, 'live') && await until(sam, 'live'), 'both live');
    await pg.waitForSelector('#callbox.pill #ctime');
    assert.match(await itext(pg, '#callbox .cwho'), /^ST Sam Taylor Ext\. 102 · \d:\d\d$/);
    // the pill sits above the page: the chat moves down, nothing is covered
    const pill = await box('#callbox .cpill'); const head = await box('#lktop');
    const tops = await pg.evaluate(() => [document.querySelector('#callbox').getBoundingClientRect().bottom, document.querySelector('#app').getBoundingClientRect().top + parseFloat(getComputedStyle(document.querySelector('#app')).paddingTop)]);
    assert.ok(tops[0] <= tops[1] + 1 && pill.h <= 48, `the call pill doesn't cover the page (${JSON.stringify(tops)}, ${JSON.stringify(head)})`);
    assert.deepStrictEqual(await pg.$$eval('#callbox .cb', (x) => x.map((y) => y.querySelector('span').textContent + (y.disabled ? ' (off)' : ''))), ['Mute', 'Hold', 'Audio', 'Camera', 'End']);
    await pg.click('#c-mute'); assert.deepStrictEqual(await pg.evaluate(() => { const c = window.RiyeserTeam.calls.current; return [c.muted, c.local.getAudioTracks()[0].enabled]; }), [true, false]);
    assert.strictEqual(await text(pg, '#c-mute span'), 'Unmute'); await pg.click('#c-mute');
    await pg.click('#c-hold'); assert.deepStrictEqual(await pg.evaluate(() => { const c = window.RiyeserTeam.calls.current; return [c.held, c.local.getAudioTracks()[0].enabled, document.getElementById('ra').muted]; }), [true, false, true]);
    assert.match(await text(pg, '#callbox .cwho small'), /On hold/); await sam.waitForFunction(() => /They put you on hold/.test(document.querySelector('#callbox .cwho small').textContent));
    await pg.screenshot({ path: out + '/link-callbar-hold.png' });
    await pg.click('#c-hold'); assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.calls.current.held), false);
    await pg.click('#c-audio'); await pg.waitForSelector('#ain'); assert.ok((await pg.$$('#ain option')).length >= 1, 'microphones listed'); await pg.keyboard.press('Escape');
    // chat while calling; "On a call" is automatic (and can't be chosen), then back to what you had
    await pg.fill('#txt', 'Talking to Sam now'); await pg.press('#txt', 'Enter'); await pg.click('#tbpeople'); assert.ok(await pg.isVisible('#callbox.pill'), 'the pill stays on People');
    await sam.click('#infobtn');
    await sam.waitForFunction(() => /^On a call/.test(document.querySelector('#plist .lk-person[data-person="u-me"] .lk-pst').textContent), null, { timeout: 8000 });
    assert.strictEqual(await text(pg, '#stbtn'), 'On a call'); console.log('Sam sees me: On a call');
    await pg.click('#c-end'); assert.ok(await until(sam, 'ended'), 'Sam sees it end');
    await pg.waitForFunction(() => document.querySelector('#stbtn').textContent.trim() === 'Available'); console.log('after the call: back to Available');
    await pg.click('#tbcalls');
    assert.match(await itext(pg, '.lk-callrow'), /Sam Taylor .* Outgoing( · \d:\d\d)? · Ext\. 102$/); await pg.click('#vclose');
    await pg.waitForTimeout(2700);
    // Sam calls you; you decline
    await sam.click('[data-dm="u-me"]'); await sam.click('#callbtn'); await sam.click('#calldm'); assert.ok(await until(pg, 'incoming'));
    assert.match(await pg.title(), /^📞 Incoming call from Sam Taylor \(ext\. 102\)/);
    await pg.click('#c-dec'); assert.ok(await until(sam, 'ended')); assert.match(await sam.evaluate(() => window.RiyeserTeam.calls.current.note), /declined the call/);
    await pg.waitForTimeout(2700); assert.match(await pg.title(), /Riyeser Link$/);
    await pg.click('#tbcalls'); assert.match(await itext(pg, '.lk-callrow'), /Sam Taylor .* Declined/); await pg.click('#vclose');
    // Busy / Do not disturb, At lunch, Unavailable: calls don't ring you; Sam is told before it rings, and nothing rings here
    for (const st of ['dnd', 'lunch', 'unavailable']) {
      await pg.click('#stbtn'); await pg.click(`[data-st=${st}]`); await pg.keyboard.press('Escape'); await sam.waitForTimeout(600);
      await sam.click('#callbtn'); assert.match(await text(sam, '#calldm small'), /won't ring/, 'the Call menu already says so');
      await sam.click('#calldm'); await sam.waitForSelector('#callbox.ended');
      assert.match(await text(sam, '#callbox'), /You is (busy \(Do not disturb\)|at lunch|unavailable), so the call didn't ring/);
      assert.strictEqual(await status(pg), 'none', 'no ringing on ' + st); await sam.waitForTimeout(4800);
    }
    // and if it rings anyway (Sam's screen hadn't caught up), the database refuses it and you don't ring
    await pg.click('#stbtn'); await pg.click('[data-st=dnd]'); await pg.keyboard.press('Escape'); await sam.waitForTimeout(600);
    await sam.evaluate(() => { const p = window.RiyeserTeam.state.presence['u-me']; p.manual = null; p.status = 'available'; });
    await sam.evaluate(() => window.RiyeserTeam.calls.start({ user: 'u-me' })); assert.ok(await until(sam, 'ended'), 'Sam\'s call ends');
    assert.match(await sam.evaluate(() => window.RiyeserTeam.calls.current.note), /can't take calls right now/); assert.strictEqual(await status(pg), 'none', 'still no ringing');
    await sam.screenshot({ path: out + '/link-dnd-caller.png' });
    await pg.click('#stbtn'); await pg.click('[data-st=available]');
    console.log('call pill (mute, hold, audio, end), On a call, incoming answer/decline, Busy / At lunch / Unavailable don\'t ring: ok');
    await sam.close();

    // 11. Management: locked; a fresh code every time; locks again after 15 minutes without use
    await pg.click('#umenu'); assert.match(await text(pg, '#um-mgmt'), /Locked/); await pg.click('#um-mgmt'); await pg.waitForSelector('#mglocked');
    assert.ok(!(await pg.$('#coppl')), 'nothing in Management before the code'); assert.match(await text(pg, '.mghint'), /123456/, 'the demo shows its code');
    await pg.screenshot({ path: out + '/link-manage-locked.png' });
    await pg.fill('#mgcode', '000000'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgerr:not([hidden])'); assert.match(await text(pg, '#mgerr'), /isn't right/);
    await pg.fill('#mgcode', '123456'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgopen');
    assert.deepStrictEqual(await pg.$$eval('.lk-tile', (x) => x.map((y) => y.id)), ['coppl', 'coreq', 'coinfo', 'mgbr', 'cophones', 'cosec', 'cohist', 'coplan']);
    assert.match(await text(pg, '#coreq'), /1 waiting/);
    await pg.screenshot({ path: out + '/link-manage-open.png' });
    await pg.click('#coppl'); await pg.waitForSelector('details.brm');
    // 15 minutes without use: it locks, and the open tool closes
    await pg.evaluate(() => window.RiyeserTeam.management.tick(Date.now() + 16 * 60000)); await pg.waitForSelector('#mglocked');
    assert.ok(!(await pg.$('.modal')) && !(await pg.$('#coppl')), 'locked again after 15 idle minutes; People & access closed');
    // using it keeps it open; Lock now; and a reload locks it
    await pg.fill('#mgcode', '123456'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgopen');
    await pg.evaluate(() => window.RiyeserTeam.management.tick(Date.now() + 10 * 60000)); await pg.click('#mgopen span');
    await pg.evaluate(() => window.RiyeserTeam.management.tick(Date.now() + 20 * 60000)); assert.ok(await pg.$('#mgopen'), 'still open: used 10 minutes ago');
    await pg.click('#mglock'); await pg.waitForSelector('#mglocked');
    await pg.fill('#mgcode', '123456'); await pg.click('#mgunlock'); await pg.waitForSelector('#mgopen');
    await pg.reload(); await pg.waitForSelector('#lkshell .item'); assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.management.open), false, 'a reload locks it');
    await pg.evaluate(() => window.RiyeserTeam.setNav('chat'));
    console.log('Management lock: ok');

    // 10. themes
    const html = () => pg.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent, document.documentElement.dataset.scope]);
    assert.deepStrictEqual(await html(), ['dark', 'purple', 'link'], 'dark navy/purple by default');
    const checks = async (label) => {
      await pg.evaluate(() => window.RiyeserTeam.setNav('chat')); await pg.click('[data-ch="c-general"]');
      const r = { text: await contrast(pg, '.msg:not(.cont) .mb'), muted: await contrast(pg, '.lk-r2 .pv'), button: await contrast(pg, '.lk-new'), business: await contrast(pg, '#lkbiz b'),
        heading: await contrast(pg, '#mhead h2'), pill: await contrast(pg, '.rxc span'), badge: await contrast(pg, '#side .badge'), chip: await contrast(pg, '.chip.on'), call: await contrast(pg, '#callbtn span') };
      console.log(`contrast ${label}:`, JSON.stringify(r));
      for (const [k, v] of Object.entries(r)) assert.ok(v >= 4.5, `${label}: ${k} contrast ${v} is below 4.5`);
    };
    await checks('dark/purple');
    for (const a of ['blue', 'teal', 'green', 'orange', 'pink']) { await pg.evaluate((x) => window.RiyeserTeam.theme.set({ accent: x }, false), a); await checks('dark/' + a); }
    // through Settings → Appearance
    await pg.click('#umenu'); await pg.click('#coset'); await pg.click('#set-look'); await pg.waitForSelector('.tpick');
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
    await pg.reload(); await pg.waitForSelector('#lkshell'); assert.deepStrictEqual(await html(), ['light', 'orange', 'link']);
    console.log('themes: ok');
    await pg.evaluate(() => window.RiyeserTeam.theme.set({ theme: 'dark', accent: 'purple' }));

    // 11b. staff never see Management or anything for admins: not in the menu, Settings, the top bar or a badge
    const jo = await ctx.newPage(); watch(jo, 'jordan'); await jo.goto(DEMO + '&as=u-jordan'); await jo.waitForSelector('#lkshell .item');
    await jo.click('#umenu'); const jm = await text(jo, '.usermenu');
    assert.ok(!/Management|Join request|People & access|Billing/.test(jm) && !(await jo.$('.usermenu .badge')), 'no Management in the menu for staff: ' + jm);
    assert.deepStrictEqual(await jo.$$eval('.usermenu .mi:not([data-st])', (x) => x.map((y) => y.id)), ['um-phone', 'coset', 'um-help', 'out']); await jo.keyboard.press('Escape');
    await jo.evaluate(() => window.RiyeserTeam.setNav('settings')); await jo.waitForSelector('.lk-set');
    const js = await text(jo, '#mview');
    assert.ok(!/Management|join request|waiting to join|People & access|Branches & extensions|History|Billing/i.test(js) && !(await jo.$('#set-mgmt')) && !(await jo.$('#mfanag')), 'Settings has nothing for admins: ' + js.slice(0, 200));
    assert.ok(await jo.$('#comyphone') && await jo.$('#set-2fa') && await jo.$('#set-look') && await jo.$('#inv'), 'staff: My phone, two-step, appearance, invite');
    await jo.screenshot({ path: out + '/link-staff-settings.png' });
    await jo.evaluate(() => window.RiyeserTeam.setNav('manage')); assert.ok(!(await jo.$('#mglocked')) && !(await jo.$('#coppl')), 'Management can\'t even be opened by staff');
    for (const id of ['#coppl', '#coreq', '#cophones', '#cobill', '#coplan', '#um-mgmt', '#mgcode', '.lk-udot']) assert.ok(!(await jo.$(id)), id + ' never shows for staff');
    assert.ok(!(await jo.evaluate(() => document.body.innerText)).match(/join request|Management/i), 'no admin words anywhere');
    console.log('staff see no Management or admin items: ok'); await jo.close();
    await ctx.close();

    // 12. phone width: one panel at a time, with back buttons, no sideways scroll
    for (const theme of ['dark', 'light']) {
      const mc = await b.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
      await mc.addInitScript((t) => { try { localStorage.setItem('riyeser.link.look', JSON.stringify({ theme: t, accent: 'purple' })); } catch { /* */ } }, theme);
      const ph = await mc.newPage(); watch(ph, 'phone-' + theme); await ph.goto(DEMO); await ph.waitForSelector('#side .item');
      assert.strictEqual(await ph.viewportSize().width, 390);
      const vis = () => ph.evaluate(() => ['#lktop', '#side', '#main', '#lkright', '#lknav'].filter((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; }));
      assert.deepStrictEqual(await vis(), ['#lktop', '#side', '#lknav'], 'starts on the list, with the tab bar'); assert.strictEqual(await over(ph), 0);
      assert.deepStrictEqual(await ph.$$eval('#lknav [data-nav] span', (x) => x.map((y) => y.textContent)), ['Chats', 'Calls', 'People', 'Settings']);
      assert.strictEqual(await text(ph, '#ptitle'), 'Chats'); assert.ok(await ph.isVisible('#fabnew'), 'the + button for a new chat');
      await ph.screenshot({ path: out + `/link-${theme}-phone-list.png` });
      await ph.tap('[data-ch="c-general"]'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#main'], 'a chat opens full screen'); assert.strictEqual(await over(ph), 0);
      await ph.screenshot({ path: out + `/link-${theme}-phone-chat.png` });
      await ph.tap('#infobtn'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#lkright']); assert.strictEqual(await over(ph), 0);
      await ph.tap('#lkright .back'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#main']);
      await ph.tap('#mhead .back'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#lktop', '#side', '#lknav']);
      for (const [k, t] of [['calls', 'Calls'], ['people', 'People'], ['settings', 'Settings']]) {
        await ph.tap(`#lknav [data-nav=${k}]`); await ph.waitForTimeout(200); assert.deepStrictEqual(await vis(), ['#lktop', '#main', '#lknav'], k);
        assert.strictEqual(await text(ph, '#ptitle'), t); assert.strictEqual(await over(ph), 0); await ph.screenshot({ path: out + `/link-${theme}-phone-${k}.png` });
      }
      await ph.tap('#umenu'); await ph.waitForSelector('.usermenu [data-st]'); assert.strictEqual(await over(ph), 0); await ph.screenshot({ path: out + `/link-${theme}-phone-status.png` }); await ph.keyboard.press('Escape');
      await ph.tap('#lknav [data-nav=chat]'); await ph.waitForTimeout(150); assert.deepStrictEqual(await vis(), ['#lktop', '#side', '#lknav']);
      if (theme === 'dark') {
        await ph.tap('[data-dm="u-sam"]'); await ph.tap('#callbtn'); await ph.tap('#calldm'); const t0 = Date.now(); while (Date.now() - t0 < 6000 && (await status(ph)) !== 'live') await ph.waitForTimeout(150);
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
        if (old && /^link_(presence|status)/.test(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, 404);
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
    assert.strictEqual(await text(fp, '#stbtn'), 'Busy · Do not disturb', 'my saved status comes back (the older Busy is Busy / Do not disturb now)');
    await fp.click('#infobtn');
    assert.strictEqual(await text(fp, '#plist .lk-person[data-person="bbbbbbbb-0000-4000-8000-000000000002"] .lk-pst'), 'Busy · Do not disturb');
    assert.strictEqual(await text(fp, '#plist .lk-person[data-person="aaaaaaaa-0000-4000-8000-000000000001"] .lk-pst'), 'Busy · Do not disturb · Back at 2');
    await fp.click('#rclose');
    const pres = fs.rpc.filter(([f]) => f === 'link_status_set').pop(); console.log('status sent:', JSON.stringify(pres[1]));
    assert.deepStrictEqual(pres[1], { ws: W, st: 'dnd', manual_choice: 'dnd', custom: 'Back at 2', on_a_call: false, until_at: null });
    await fp.click('#stbtn'); await fp.click('[data-st=lunch]'); await fp.click('[data-until="30"]'); await fp.keyboard.press('Escape'); await fp.waitForTimeout(200);
    const lunch = fs.rpc.filter(([f]) => f === 'link_status_set').pop()[1];
    assert.ok(lunch.st === 'lunch' && lunch.manual_choice === 'lunch' && Math.abs(Date.parse(lunch.until_at) - Date.now() - 30 * 60000) < 60000, 'At lunch for 30 minutes: ' + JSON.stringify(lunch));
    assert.ok(fs.rpc.some(([f, x]) => f === 'link_my_dnd' && x.dnd_on === true) || fs.rpc.filter(([f]) => f === 'link_my_dnd').length === 0, 'the desk phone follows');
    await fp.click('#stbtn'); await fp.click('[data-st=available]'); await fp.waitForTimeout(200);
    // reactions
    assert.strictEqual(await text(fp, '.rxc'), '🎉 1'); await fp.click('.rxc');
    const rxPost = fs.rest.find(([m, p]) => m === 'POST' && p === 'message_reactions'); assert.deepStrictEqual(rxPost[3], { message_id: 'aaaa0000-0000-4000-8000-000000000001', emoji: '🎉' });
    await fp.click('.rxc.me'); const rxDel = fs.rest.find(([m, p]) => m === 'DELETE' && p === 'message_reactions');
    assert.match(rxDel[2], /message_id=eq\.aaaa0000.*user_id=eq\.aaaaaaaa.*emoji=eq\./);
    // pins
    await fp.click('#morebtn'); await fp.click('#mpin'); const pinPost = fs.rest.find(([m, p]) => m === 'POST' && p === 'channel_pins');
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
    await op.click('#infobtn'); assert.strictEqual(await text(op, '#plist .lk-person[data-person="bbbbbbbb-0000-4000-8000-000000000002"] .lk-pst'), 'Offline'); await op.click('#rclose');
    await op.click('#morebtn'); await op.click('#mpin'); await op.waitForTimeout(300);
    assert.deepStrictEqual(os.userPut.pop().data.riyeser_prefs.pinned, [G], 'pins kept with the account instead');
    await op.click('#stbtn'); await op.click('[data-st=dnd]'); assert.strictEqual(await text(op, '#stbtn'), 'Busy · Do not disturb');
    assert.strictEqual(os.rpc.filter(([f]) => f === 'link_presence_set' || f === 'link_status_set').length, 0, 'no status writes to a database without them');
    console.log('older database: ok');
  } catch (e) { failed = true; console.error('FAILED:', e.message, (e.stack || '').split('\n').find((l) => l.includes('link-ui-test')) || ''); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('LINK WORKSPACE TESTS PASSED');
})();
