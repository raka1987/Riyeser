// Real calls between browser tabs in the demo (fake microphone and camera): person to person, a ring group call
// (first to answer takes it), the dial pad, branch set-up, ring groups with chosen members (only the chosen ring, in
// order, rotate, Do not disturb skipped, what happens if nobody answers, nobody chosen), and the premium upsell.
// Exits 1 if a ring group check fails.
const { chromium, devices } = require('playwright');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';   // LINK_BASE=http://127.0.0.1:8091 to use another port
const URL = BASE + '/link/?demo';
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  const errs = []; const out = process.argv[2] || '.';
  const open = async (as) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(as + ': ' + e.message)); p.on('dialog', (d) => d.accept());
    await p.goto(URL + (as ? '&as=' + as : '')); await p.waitForSelector('.item'); return p; };
  const status = (p) => p.evaluate(() => { const c = window.RiyeserTeam.calls.current; return c ? c.status : 'none'; });
  const tab = async (p, t) => { await p.evaluate((k) => window.RiyeserTeam.setNav(k), t === 'chats' ? 'chat' : t); await p.waitForTimeout(100); };
  const callDm = async (p) => { await p.click('#callbtn'); await p.click('#calldm'); };   // the green Call button, then Voice call
  const until = async (p, want, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await status(p)) === want) return true; await p.waitForTimeout(100); } return false; };

  const me = await open(''); const jordan = await open('u-jordan');
  await me.waitForTimeout(300); await tab(me, 'calls');
  console.log('Calls tab:', await me.evaluate(() => [...document.querySelectorAll('[data-callgroup]')].map((x) => x.textContent.replace(/\s+/g, ' ').trim())),
    '| my ext:', await me.textContent('#mview .lk-sub b'));

  // 1. person to person
  await tab(me, 'chats'); await me.click('[data-dm="u-jordan"]'); await me.waitForTimeout(200); await callDm(me);
  console.log('1. Jordan rings:', await until(jordan, 'incoming'), '| title:', await jordan.title());
  await jordan.screenshot({ path: out + '/call-incoming.png' });
  await jordan.click('#c-ans');
  console.log('   both live:', await until(me, 'live'), await until(jordan, 'live'));
  const audioIn = await jordan.evaluate(() => { const s = window.RiyeserTeam.calls.current.remoteStream; return s ? s.getAudioTracks().length : 0; });
  console.log('   Jordan receives audio tracks:', audioIn);
  await me.click('#c-cam'); await jordan.waitForTimeout(1500);
  console.log('   camera on -> Jordan sees video:', await jordan.evaluate(() => !!(window.RiyeserTeam.calls.current || {}).remoteVideo));
  await me.click('#c-mute'); console.log('   muted:', await me.evaluate(() => window.RiyeserTeam.calls.current.muted));
  await me.screenshot({ path: out + '/call-live.png' });
  await me.waitForTimeout(1200); await me.click('#c-end');
  console.log('   hung up -> Jordan:', await until(jordan, 'ended'), '| note in DM:', await me.evaluate(() => [...document.querySelectorAll('#msgs .mb')].map((x) => x.textContent).filter((t) => t.includes('📞')).pop()));
  await me.waitForTimeout(2700);

  // 2. a branch's number (Lautoka 200, upgraded: Jordan and Alex chosen): both ring; Jordan answers, Alex is told
  const alex = await open('u-alex'); await me.waitForTimeout(300);
  await tab(me, 'calls'); await me.click('[data-callgroup="g-lau"]');
  console.log('2. branch rings both:', await until(jordan, 'incoming'), await until(alex, 'incoming'));
  await jordan.click('#c-ans');
  console.log('   Jordan live:', await until(jordan, 'live'), '| Alex sees:', await until(alex, 'ended') && await alex.evaluate(() => window.RiyeserTeam.calls.current && window.RiyeserTeam.calls.current.note));
  await jordan.click('#c-end'); await until(me, 'ended'); await me.waitForTimeout(2700);

  // 3. declining
  await tab(me, 'chats'); await me.click('[data-dm="u-jordan"]'); await callDm(me); await until(jordan, 'incoming'); await jordan.click('#c-dec');
  console.log('3. declined ->', await until(me, 'ended') && await me.evaluate(() => window.RiyeserTeam.calls.current.note));
  await me.waitForTimeout(2700);

  // 4. dial pad
  await tab(me, 'chats'); await me.click('#callbtn'); await me.click('#callkeys'); await me.click('[data-k="2"]'); await me.click('[data-k="0"]'); await me.click('[data-k="2"]');
  console.log('4. dial 202 ->', await me.textContent('#dpw')); await me.fill('#dpn', '200'); await me.dispatchEvent('#dpn', 'input'); console.log('   dial 200 ->', await me.textContent('#dpw'));
  await me.click('#cl');

  // 5. branches and extensions (owner)
  await tab(me, 'manage'); await me.fill('#mgcode', '123456'); await me.click('#mgunlock'); await me.waitForSelector('#mgbr'); await me.click('#mgbr'); await me.fill('#nb input', 'Nadi branch'); await me.click('#nb button'); await me.waitForTimeout(300);
  console.log('5. new branch:', await me.evaluate(() => window.RiyeserTeam.state.branches.map((x) => `${x.name} ${x.extension} ${x.code}`)));
  await me.fill('[data-ext="u-alex"]', '101'); await me.click('#sx'); await me.waitForTimeout(300);
  console.log('   taken number refused, Alex still:', await me.evaluate(() => window.RiyeserTeam.state.people.find((p) => p.user_id === 'u-alex').extension));
  await me.screenshot({ path: out + '/call-branches.png' });
  await me.click('#cl');

  // 7. ring groups (owner, Management unlocked in 5): the one-time notice, then choose who answers
  const fails = []; const check = (ok, what) => { console.log(`   ${ok ? 'ok' : 'FAIL'} - ${what}`); if (!ok) fails.push(what); };
  const neverRings = async (p, ms = 2500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await status(p)) === 'incoming') return false; await p.waitForTimeout(100); } return true; };
  const hangAll = async () => { for (const p of [me, jordan, alex]) { if (p.isClosed()) continue; const st = await status(p); if (st !== 'none' && st !== 'ended') { const b = await p.$('#c-end') || await p.$('#c-dec'); if (b) await b.click().catch(() => {}); } } await me.waitForTimeout(2800); };
  const save = async () => { await me.click('#rgsave'); await me.waitForSelector('#rgok', { timeout: 4000 }); };
  const pickOnly = async (keys) => { for (const c of await me.$$('[data-pick]')) { const k = await c.getAttribute('data-pick'); if ((await c.isChecked()) !== keys.includes(k)) await c.click(); } };
  await tab(me, 'manage'); await me.waitForTimeout(200);
  console.log('7. notice in Management:', await me.evaluate(() => { const n = document.getElementById('mgrgnote'); return n ? n.querySelector('b').textContent : null; }));
  check(!!(await me.$('#mgrgnote')), 'Management says "Choose who answers each branch number" after the upgrade');
  await me.click('#rgnotego'); await me.waitForSelector('[data-view="rings"] #rgf');
  check((await me.textContent('#rged h3')).includes('Head office'), 'Choose now opens the first number to check (Head office)');
  await me.click('[data-rg="g-lau"]'); await me.waitForSelector('#rgf');
  check((await me.$$eval('#rgchosen .rg-m', (x) => x.length)) === 2, 'Lautoka starts with the 2 people who were in the branch');
  await pickOnly(['u:u-jordan']); await save();
  console.log('   saved:', (await me.textContent('#rgok')).trim());
  check(await me.evaluate(() => window.RiyeserTeam.state.groups.find((g) => g.id === 'g-lau').members.map((m) => m.user_id).join()) === 'u-jordan', 'Lautoka now only Jordan');
  await tab(me, 'calls'); await me.waitForTimeout(150);
  const lauRow = await me.textContent('[data-callgroup="g-lau"]');
  console.log('   Calls tab row:', lauRow.replace(/\s+/g, ' ').trim()); check(/Jordan · ring all at once/.test(lauRow), 'Calls shows who is in it');
  await me.click('[data-callgroup="g-lau"]');
  check(await until(jordan, 'incoming'), 'calling Lautoka rings Jordan (chosen)');
  check(await neverRings(alex), 'Alex (in Lautoka, not chosen) does not ring');
  await hangAll();

  // 8. a new group with its own number, ring in order: Alex first, then Jordan after 5 seconds; a taken number is refused
  await tab(me, 'manage'); await me.click('#mgrg'); await me.waitForSelector('[data-view="rings"]');
  await me.click('#rgnew'); await me.fill('#rgname', 'Sales'); await me.fill('#rgext', '101'); await me.dispatchEvent('#rgext', 'input');
  console.log('8. number 101 ->', await me.textContent('#rgxmsg')); check(/your extension/.test(await me.textContent('#rgxmsg')), 'a person\'s number is refused');
  await me.fill('#rgext', '300'); await me.dispatchEvent('#rgext', 'input');
  console.log('   number 300 ->', await me.textContent('#rgxmsg')); check(/Nadi branch/.test(await me.textContent('#rgxmsg')), 'a branch\'s number is refused');
  await me.fill('#rgext', '400'); await me.dispatchEvent('#rgext', 'input');
  check((await me.textContent('#rgxmsg')) === '', '400 is free');
  await me.click('[data-pick="u:u-alex"]'); await me.click('[data-pick="u:u-jordan"]');
  await me.click('input[name=rgst][value=order]'); await me.fill('#rgsec', '5'); await me.dispatchEvent('#rgsec', 'input');
  await me.screenshot({ path: out + '/ring-groups-edit.png' });
  await save();
  const sales = await me.evaluate(() => window.RiyeserTeam.state.groups.find((g) => g.name === 'Sales'));
  check(!!sales && sales.extension === 400 && sales.strategy === 'order', 'Sales 400 made, ring in order');
  await tab(me, 'calls'); await me.waitForTimeout(150);
  console.log('   keypad 400 ->', await me.evaluate(() => { const n = document.querySelector('#vdn'); n.value = '400'; n.dispatchEvent(new Event('input')); return document.querySelector('#vdw').textContent; }));
  await me.click(`[data-callgroup="${sales.id}"]`);
  const t8 = Date.now();
  check(await until(alex, 'incoming'), 'in order: Alex rings first');
  check(await neverRings(jordan, 2500), 'Jordan waits his turn');
  check(await until(jordan, 'incoming', 6000), 'then Jordan rings');
  console.log('   Jordan rang after', Math.round((Date.now() - t8) / 100) / 10, 's; Alex now:', await status(alex), await alex.evaluate(() => (window.RiyeserTeam.calls.current || {}).note));
  check(Date.now() - t8 >= 4500, 'after Alex\'s 5 seconds');
  await jordan.click('#c-ans'); check(await until(me, 'live'), 'Jordan answers: live');
  await hangAll();

  // 9. rotate: each call starts with the next person
  await tab(me, 'manage'); await me.click('#mgrg'); await me.waitForSelector('[data-view="rings"]');
  await me.click(`[data-rg="${sales.id}"]`); await me.click('input[name=rgst][value=rotate]'); await save();
  const firstUp = [];
  for (let i = 0; i < 2; i++) {
    await tab(me, 'calls'); await me.click(`[data-callgroup="${sales.id}"]`);
    const t0 = Date.now(); let who = null;
    while (!who && Date.now() - t0 < 4000) { if ((await status(alex)) === 'incoming') who = 'Alex'; else if ((await status(jordan)) === 'incoming') who = 'Jordan'; else await me.waitForTimeout(100); }
    firstUp.push(who); await me.click('#c-end'); await me.waitForTimeout(2900);
  }
  console.log('9. rotate first:', firstUp); check(firstUp[0] && firstUp[1] && firstUp[0] !== firstUp[1], 'rotate: a different person first on the next call');

  // 10. Do not disturb is skipped: Alex on Busy / Do not disturb, Sales back to all at once
  await alex.click('#stbtn'); await alex.click('[data-st=dnd]'); await alex.keyboard.press('Escape'); await me.waitForTimeout(700);
  await tab(me, 'manage'); await me.click('#mgrg'); await me.click(`[data-rg="${sales.id}"]`); await me.waitForSelector('#rgf');
  console.log('10. Alex in the list:', (await me.textContent(`#rgchosen [data-k="u:u-alex"] small`)).trim());
  await me.click('input[name=rgst][value=all]'); await save();
  await tab(me, 'calls'); await me.click(`[data-callgroup="${sales.id}"]`);
  check(await until(jordan, 'incoming'), 'Jordan rings');
  check(await neverRings(alex, 2000), 'Alex on Do not disturb is skipped');
  await hangAll();
  await alex.click('#stbtn'); await alex.click('[data-st=available]'); await alex.keyboard.press('Escape');

  // 11. if nobody answers: nobody chosen at Lautoka now, on to Sales; and Nadi (new, nobody chosen) goes to missed
  await tab(me, 'manage'); await me.click('#mgrg'); await me.click('[data-rg="g-lau"]'); await me.waitForSelector('#rgf');
  await pickOnly([]); await me.selectOption('#rgfb', 'group'); await me.selectOption('#rgfbg', sales.id); await save();
  check(/Nobody chosen yet · calls go to Sales/.test(await me.textContent('[data-rg="g-lau"]')), 'the list says Lautoka goes to Sales');
  await tab(me, 'calls'); await me.click('[data-callgroup="g-lau"]');
  check(await until(jordan, 'incoming'), 'Lautoka (nobody chosen) falls back to Sales: Jordan rings');
  console.log('    caller sees:', await me.evaluate(() => document.querySelector('.cwho small') && document.querySelector('.cwho small').textContent));
  await hangAll();
  const nadi = await me.evaluate(() => window.RiyeserTeam.state.groups.find((g) => g.name === 'Nadi branch'));
  console.log('    Nadi row:', nadi && (await me.textContent(`[data-callgroup="${nadi.id}"]`)).replace(/\s+/g, ' ').trim());
  await me.click(`[data-callgroup="${nadi.id}"]`); await me.waitForTimeout(300);
  console.log('    Nadi ->', await me.evaluate(() => (window.RiyeserTeam.calls.current || {}).note));
  check(/Nobody is chosen to answer Nadi branch/.test(await me.evaluate(() => (window.RiyeserTeam.calls.current || {}).note || '')), 'a new branch with nobody chosen: not rung, the caller is told');
  check(await neverRings(jordan, 1200) && await neverRings(alex, 300), 'nobody rings for Nadi');
  await me.waitForTimeout(4600);
  // the notice: Keep as they are (Head office is still from the upgrade)
  await tab(me, 'manage'); await me.click('#rgnotego'); await me.waitForSelector('#rgkeep'); await me.click('#rgkeep'); await me.waitForTimeout(300);
  check(!(await me.$('#rgnotice')), 'Keep as they are: the notice goes away');
  await tab(me, 'manage'); check(!(await me.$('#mgrgnote')), '…in Management too');
  // staff never see ring groups
  const staffNav = await jordan.evaluate(() => { window.RiyeserTeam.setNav('rings'); return window.RiyeserTeam.state.nav; });
  check(staffNav === 'settings' && !(await jordan.$('#mgrg')) && !(await jordan.$('#set-rg')), 'staff can\'t open Ring groups');

  // 6. one tab alone: a demo call that "answers"; and premium off shows the upsell
  await jordan.close(); await alex.close();
  const solo = await (await b.newContext({ permissions: ['microphone'] })).newPage(); solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
  await solo.goto(URL); await solo.waitForSelector('.item'); await solo.click('[data-dm="u-sam"]'); await callDm(solo);
  const t = Date.now(); let st; while (Date.now() - t < 6000 && (st = await status(solo)) !== 'live') await solo.waitForTimeout(150);
  console.log('6. solo demo call:', st, '|', await solo.textContent('.cwho small'));
  await solo.click('#c-end'); await solo.waitForTimeout(2700);
  await solo.evaluate(() => { window.RiyeserTeam.state.features = { calls: false }; }); await solo.click('#callbtn');
  console.log('   premium off ->', await solo.textContent('.modal h3'));
  const ph = await (await b.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] })).newPage();
  await ph.goto(URL); await ph.waitForSelector('.item'); await ph.tap('[data-dm="u-sam"]'); await ph.tap('#callbtn'); await ph.tap('#calldm'); await ph.waitForTimeout(400);
  await ph.screenshot({ path: out + '/call-phone.png' });
  console.log('   phone overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  // 12. the layout standard: 1280 at 125% (1024 wide), 1366, 1920 and a 390 phone, light and dark: Management's notice,
  //     the Ring groups list and editor, and the Calls card. Nothing cut off or overlapping, no sideways scroll.
  const rgIssues = (p) => p.evaluate(() => {
    const bad = []; const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const nm = (e) => `${e.id ? '#' + e.id : e.className} "${e.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)}"`;
    if (document.documentElement.scrollWidth > innerWidth) bad.push('the page scrolls sideways');
    const v = document.querySelector('#mview'); if (v && v.scrollWidth > v.clientWidth + 1) bad.push('the view scrolls sideways');
    for (const e of document.querySelectorAll('.rg-row, .rg-row b, .rg-m, .rg-mt b, .rg-sc, .rg-foot .btn, .rg-eh h3, .rg-notice, .lk-tile, #rgcard .mi, .rg-fb select'))
      if (vis(e) && e.scrollWidth > e.clientWidth + 1) bad.push('cut off: ' + nm(e));
    const ed = document.querySelector('.rg-ed'); const ls = document.querySelector('.rg-list');
    if (ed && ls && vis(ed) && vis(ls)) { const a = ed.getBoundingClientRect(); const c = ls.getBoundingClientRect(); if (a.left < c.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) bad.push('the list and the editor overlap'); }
    for (const e of document.querySelectorAll('.rg-foot .btn, .rg-sc b, .rg-row .lk-ext, .rg-lh .btn')) { if (!vis(e)) continue; const r = document.createRange(); r.selectNodeContents(e);
      const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))); if (tops.size > 1) bad.push('wraps: ' + nm(e)); }
    return bad;
  });
  const look = (t) => { try { localStorage.setItem('riyeser.link.look', JSON.stringify({ theme: t, accent: 'purple' })); } catch { /* */ } };
  const SIZES = [{ n: '1280at125', viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1.25 }, { n: '1366', viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
    { n: '1920', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }, { n: '390', ...devices['iPhone 13'], deviceScaleFactor: 2 }];
  for (const sz of SIZES) for (const theme of ['light', 'dark']) {
    const lc = await b.newContext({ ...sz, n: undefined, permissions: ['microphone'] }); await lc.addInitScript(look, theme);
    const lp = await lc.newPage(); lp.on('pageerror', (e) => errs.push(`layout ${sz.n} ${theme}: ${e.message}`)); await lp.goto(URL); await lp.waitForSelector('#lkshell .item');
    const shot = async (st) => { await lp.waitForTimeout(150); await lp.screenshot({ path: `${out}/rg-${sz.n}-${theme}-${st}.png` }); const bad = await rgIssues(lp); check(!bad.length, `${sz.n} ${theme} ${st}${bad.length ? ': ' + bad.join('; ') : ''}`); };
    await lp.evaluate(() => window.RiyeserTeam.setNav('manage')); await lp.fill('#mgcode', '123456'); await lp.click('#mgunlock'); await lp.waitForSelector('#mgrgnote');
    await shot('manage');
    await lp.click('#rgnotego'); await lp.waitForSelector('#rgf'); await shot('edit-branch');
    await lp.click('input[name=rgst][value=order]'); await lp.selectOption('#rgfb', 'person'); await shot('edit-order');
    if (await lp.isVisible('#rgback')) { await lp.click('#rgback'); await lp.waitForSelector('.rg-row'); await shot('list'); }   // narrower: the list or the editor, one at a time
    await lp.click('#rgnew'); await lp.fill('#rgname', 'Reception'); await lp.fill('#rgext', '301'); await lp.dispatchEvent('#rgext', 'input'); await lp.click('[data-pick="p:150"]'); await lp.click('[data-pick="u:u-sam"]');
    await shot('new');
    await lp.click('#rgsave'); await lp.waitForSelector('#rgok'); await shot('saved');
    await lp.evaluate(() => window.RiyeserTeam.setNav('calls')); await lp.waitForSelector('#rgcard'); await lp.evaluate(() => document.getElementById('rgcard').scrollIntoView()); await shot('calls');
    await lc.close();
  }

  console.log('errors:', errs); await b.close();
  console.log(fails.length ? `RING GROUP CHECKS FAILED: ${fails.join('; ')}` : 'RING GROUP CHECKS PASSED');
  if (fails.length || errs.length) process.exit(1);
})();
