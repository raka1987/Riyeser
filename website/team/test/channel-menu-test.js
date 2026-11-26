// Riyeser Link: the channel menu and folding panels away, in the demo (light and dark) and against a pretend Supabase.
//  1. The ⋯ menu in the conversation header and on each chat in the list (hover, right-click): Rename, Edit topic, Members,
//     Mute, Pin, Leave, Archive. Rename (the name is tidied, e.g. "Paper Work" → #paper-work) and Edit topic.
//  2. Archive: the in-page "Archive" question ("Hides it for everyone; you can bring it back"), the Archived section
//     (folded at first), read-only (no box to type in), Unarchive brings it back.
//  3. #general can't be archived, renamed or left. Mute takes a chat out of the unread total.
//  4. Permissions: a member only sees what they may do (Rename / Archive only on the channel they made); Leave and Join again.
//  5. The details (ⓘ) only when asked for (Ctrl + ] too); the All · Channels · People · Unread chips.
//  6. Phone width: the chat's ⋯ menu fits, the chips, the bottom tab bar, no sideways scroll.
//  7. Pretend Supabase: the actions go to channel_rename / channel_archive / channel_mute / channel_leave; the database's
//     refusal shows in the dialog; an archived channel from the server shows read-only; an older database hides the new items.
// Screenshots (deviceScaleFactor 2) go to the folder given. Exits 1 on any failure.
// Run: build the site, serve website/public (LINK_BASE=http://127.0.0.1:8091 for another port), then
//   node website/team/test/channel-menu-test.js <screenshots folder>
const { chromium, devices } = require('playwright');
const assert = require('assert');
const BASE = process.env.LINK_BASE || 'http://127.0.0.1:8090';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.'; let failed = false;
  const watch = (p, as) => { p.on('pageerror', (e) => errs.push(`${as}: ${e.message}`)); p.on('dialog', (d) => { errs.push(`${as}: a browser pop-up: ${d.message()}`); d.dismiss(); });
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|WebSocket|realtime/i.test(m.text())) errs.push(`${as}: ${m.text()}`); }); };
  const text = (p, sel) => p.textContent(sel).then((t) => t.replace(/\s+/g, ' ').trim());
  const menuIds = (p) => p.$$eval('.chmenu .mi', (x) => x.map((y) => y.id));
  const quiet = (p) => p.evaluate(() => { const t = document.getElementById('phmsg'); if (t) t.hidden = true; });   // no passing notice in the pictures
  const over = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const look = (theme) => (t) => { try { localStorage.setItem('riyeser.link.look', JSON.stringify({ theme: t, accent: 'purple' })); } catch { /* */ } };
  const secOf = (p, id) => p.evaluate((cid) => { let sec = ''; for (const n of document.querySelector('#lscroll').children) { if (n.classList.contains('sec')) sec = n.dataset.sec; if (n.querySelector && n.querySelector(`[data-ch="${cid}"]`)) return sec; } return null; }, id);
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript(look(), theme);
      const pg = await ctx.newPage(); watch(pg, 'owner-' + theme);
      await pg.goto(BASE + '/link/?demo'); await pg.waitForSelector('#lkshell .item');
      assert.strictEqual(await pg.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.deepStrictEqual(await pg.$$eval('#side .sec', (x) => x.length), 0, 'one list (no sections), and no Archived section while nothing is archived');

      // 1. the header ⋯ menu, as the owner, on #office
      await pg.click('[data-ch="c-office"]'); await pg.click('#morebtn'); await pg.waitForSelector('.chmenu');
      assert.deepStrictEqual(await menuIds(pg), ['mrename', 'mtopic', 'mmembers', 'mmute', 'mpin', 'minfo', 'mleave', 'marchive']);
      assert.match(await text(pg, '#marchive'), /^Archive ?Hides it for everyone; you can bring it back$/);
      if (theme === 'light') await quiet(pg); await pg.screenshot({ path: out + '/channel-menu.png' });
      await quiet(pg); await pg.screenshot({ path: out + `/channel-menu-${theme}.png` });
      // keyboard: arrows move through the menu, Escape closes it and goes back to ⋯
      assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'mrename');
      await pg.keyboard.press('ArrowDown'); assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'mtopic');
      await pg.keyboard.press('ArrowUp'); await pg.keyboard.press('ArrowUp'); assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'marchive');
      await pg.keyboard.press('Escape'); assert.ok(!(await pg.$('.chmenu'))); assert.strictEqual(await pg.evaluate(() => document.activeElement.id), 'morebtn');

      // Rename: the in-page dialog, the tidied name, then the header and list follow
      await pg.click('#morebtn'); await pg.click('#mrename'); await pg.waitForSelector('#rnf');
      assert.strictEqual(await pg.inputValue('#rnv'), 'office');
      await pg.fill('#rnv', 'Paper Work'); assert.strictEqual(await text(pg, '#rnp'), 'It will show as #paper-work');
      await quiet(pg); await pg.screenshot({ path: out + `/channel-rename-${theme}.png` }); if (theme === 'light') await quiet(pg); await pg.screenshot({ path: out + '/channel-rename.png' });
      await pg.click('#rngo'); await pg.waitForFunction(() => /paper-work/.test(document.querySelector('#mhead h2').textContent));
      assert.strictEqual(await text(pg, '[data-ch="c-office"] .nm'), 'paper-work');
      assert.strictEqual(await pg.getAttribute('#txt', 'placeholder'), 'Message #paper-work');
      // Edit topic
      await pg.click('#morebtn'); await pg.click('#mtopic'); await pg.fill('#rnv', 'Bills, invoices and the post'); await pg.click('#rngo');
      await pg.waitForFunction(() => /Bills, invoices and the post/.test(document.querySelector('#mhead small').textContent));
      // renaming a channel to "general" is refused, and the dialog says why
      await pg.click('#morebtn'); await pg.click('#mrename'); await pg.fill('#rnv', 'general'); await pg.click('#rngo');
      await pg.waitForSelector('#rne:not([hidden])'); assert.match(await text(pg, '#rne'), /There's already a #general/); await pg.click('.modal #cl');
      console.log(theme, 'rename and topic: ok');

      // 3. Mute, from the list's ⋯ (shows on hover): the unread badge dims and leaves the total
      const total = () => pg.evaluate(() => Number((document.title.match(/^\((\d+)\)/) || [0, 0])[1]));
      const before = await total(); const jobsUnread = await pg.evaluate(() => window.RiyeserTeam.state.unread['c-jobs'] || 0);
      assert.ok(jobsUnread > 0, '#jobs has unread messages to start with');
      await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]'); await pg.click('#mmute');
      assert.ok(await pg.$('[data-ch="c-jobs"].muted .mutei') && await pg.$('[data-ch="c-jobs"] .badge.dim'), 'muted: an icon and a grey badge');
      assert.strictEqual(await total(), before - jobsUnread, 'muted chats leave the unread total (and the tab title)');
      await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]'); assert.match(await text(pg, '#mmute'), /^Unmute/); await pg.click('#mmute');
      assert.strictEqual(await total(), before); assert.ok(!(await pg.$('[data-ch="c-jobs"].muted')));
      // right-click a chat: the same menu, where the mouse is
      const r = await pg.$eval('[data-ch="c-jobs"]', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + 40, y: x.y + 10 }; });
      await pg.mouse.click(r.x, r.y, { button: 'right' }); await pg.waitForSelector('.chmenu');
      const at = await pg.$eval('.chmenu', (e) => { const x = e.getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y) }; });
      assert.ok(Math.abs(at.y - r.y) < 30, `the menu opens at the pointer (${JSON.stringify(at)} vs ${JSON.stringify(r)})`);
      assert.ok((await menuIds(pg)).includes('marchive')); await pg.keyboard.press('Escape');
      console.log(theme, 'mute and right-click: ok');

      // 3. #general: no Archive, Rename or Leave; the topic can change
      await pg.click('[data-ch="c-general"]'); await pg.click('#morebtn');
      assert.deepStrictEqual(await menuIds(pg), ['mtopic', 'mmembers', 'mmute', 'mpin', 'minfo']);
      assert.match(await text(pg, '.chmenu .mnote'), /#general is for everyone, so it can't be archived or left/); await pg.keyboard.press('Escape');

      // 2. Archive #paper-work: the in-page question, then it's under Archived (folded), read-only, and comes back
      await pg.click('[data-ch="c-office"]'); await pg.click('#morebtn'); await pg.click('#marchive');
      await pg.waitForSelector('#askyes'); assert.strictEqual(await text(pg, '#askyes'), 'Archive');
      assert.match(await text(pg, '.askp'), /hides it for everyone; you can bring it back\. The messages are kept/);
      await quiet(pg); await pg.screenshot({ path: out + `/channel-archive-ask-${theme}.png` });
      await pg.click('#askyes'); await pg.waitForFunction(() => /general/.test(document.querySelector('#mhead h2').textContent));
      assert.strictEqual(await secOf(pg, 'c-office'), 'archived');
      assert.deepStrictEqual(await pg.$$eval('#side .sec', (x) => x.map((y) => y.firstChild.textContent.trim())), ['Archived1']);
      assert.strictEqual(await pg.getAttribute('[data-sect="archived"]', 'aria-expanded'), 'false', 'Archived starts folded');
      assert.ok(!(await pg.isVisible('[data-ch="c-office"]')));
      await pg.click('[data-sect="archived"]'); assert.ok(await pg.isVisible('[data-ch="c-office"]'));
      await pg.$eval('#lscroll', (e) => { e.scrollTop = e.scrollHeight; });
      await quiet(pg); await pg.screenshot({ path: out + `/channel-archived-${theme}.png` }); if (theme === 'light') await quiet(pg); await pg.screenshot({ path: out + '/channel-archived.png' });
      await pg.click('[data-ch="c-office"]'); await pg.waitForSelector('#archbar');
      assert.ok(!(await pg.isVisible('#comp')), 'no box to type in'); assert.match(await text(pg, '#archbar'), /This channel is archived\. It's read-only/);
      assert.match(await text(pg, '#mhead h2'), /paper-work Archived/); assert.ok(!(await pg.$('#msgs [data-act=edit]')) && !(await pg.$('#msgs [data-act=react]')), 'no edit or react');
      await pg.click('#morebtn'); assert.deepStrictEqual(await menuIds(pg), ['mmembers', 'mmute', 'minfo', 'mleave', 'munarchive']); await pg.keyboard.press('Escape');
      await quiet(pg); await pg.screenshot({ path: out + `/channel-readonly-${theme}.png` });
      await pg.click('#unarch'); await pg.waitForSelector('#comp:not([hidden])'); assert.ok(!(await pg.$('#archbar')));
      assert.strictEqual(await secOf(pg, 'c-office'), ''); assert.ok(!(await pg.$('[data-sect="archived"]')), 'Archived goes when empty');
      console.log(theme, 'archive, read-only and unarchive: ok');

      // 5. the details (ⓘ) open only when asked for; Ctrl + ] opens and closes them; the filter chips
      assert.ok(!(await pg.isVisible('#lkright')), 'no details panel until ⓘ is pressed');
      await pg.click('#infobtn'); await pg.waitForSelector('#lkright #rclose'); assert.ok(await pg.isVisible('#lkright')); assert.strictEqual(await pg.getAttribute('#infobtn', 'aria-expanded'), 'true');
      await quiet(pg); await pg.screenshot({ path: out + `/details-${theme}.png` });
      await pg.keyboard.press('Control+BracketRight'); await pg.waitForTimeout(250); assert.ok(!(await pg.$('#lkshell.details')), 'Ctrl + ] closes the details');
      await pg.keyboard.press('Control+BracketRight'); assert.ok(await pg.$('#lkshell.details'), 'Ctrl + ] opens them again'); await pg.click('#rclose');
      await pg.click('[data-filter="unread"]'); const un = await pg.$$eval('#lscroll .item', (x) => x.map((y) => y.dataset.ch || y.dataset.dm));
      assert.ok(un.length && await pg.evaluate((ids) => { const S = window.RiyeserTeam.state; return ids.every((id) => (S.unread[id] || 0) > 0 || S.chans.some((c) => c.kind === 'dm' && c.people.includes(id) && S.unread[c.id] > 0)); }, un), 'Unread: only chats with unread messages');
      await pg.click('[data-filter="channels"]'); assert.ok(!(await pg.$('#lscroll [data-dm]')), 'Channels: no people');
      await pg.click('[data-filter="people"]'); assert.ok(!(await pg.$('#lscroll [data-ch]')), 'People: no channels');
      await pg.click('[data-filter="all"]');
      console.log(theme, 'details and filters: ok');

      // 4. a member (Jordan): only the actions they may use; Leave and Join again; someone else's settings don't carry over
      const jo = await ctx.newPage(); watch(jo, 'member-' + theme);
      await jo.goto(BASE + '/link/?demo&as=u-jordan'); await jo.waitForSelector('#lkshell .item');
      assert.ok(!(await jo.$('[data-ch="c-exec"]')), 'no private #executives for Jordan');
      await jo.click('[data-ch="c-office"]'); await jo.click('#morebtn');
      assert.deepStrictEqual(await menuIds(jo), ['mmembers', 'mmute', 'mpin', 'minfo', 'mleave'], 'no Rename, Edit topic or Archive on a channel Jordan didn\'t make');
      assert.match(await text(jo, '.chmenu .mnote'), /Only whoever made it, or an owner or admin, can rename or archive it/);
      await jo.keyboard.press('Escape');
      await jo.click('[data-ch="c-jobs"]'); await jo.click('#morebtn');
      assert.deepStrictEqual(await menuIds(jo), ['mrename', 'mtopic', 'mmembers', 'mmute', 'mpin', 'minfo', 'mleave', 'marchive'], 'Jordan made #jobs');
      await jo.keyboard.press('Escape');
      await jo.click('[data-ch="c-office"]'); await jo.click('#morebtn'); await jo.click('#mleave'); await jo.waitForSelector('#askyes');
      assert.match(await text(jo, '.askp'), /Leave #office\? It goes from your list\. You can join again from Browse channels, at the bottom of your chats\./); await jo.click('#askyes');
      await jo.waitForFunction(() => !document.querySelector('[data-ch="c-office"]'));
      await jo.click('#browsech'); await jo.waitForSelector('[data-rejoin="c-office"]'); await jo.click('[data-rejoin="c-office"]');
      await jo.waitForFunction(() => /office/.test(document.querySelector('#mhead h2') ? document.querySelector('#mhead h2').textContent : ''));
      assert.ok(await jo.$('[data-ch="c-office"]'), 'back in the list'); await jo.close();
      console.log(theme, 'member permissions, leave and join again: ok');
      await ctx.close();
    }

    // 6. phone width: ⋯ is always there, the menu fits, sections fold and are remembered, no sideways scroll
    for (const theme of ['light', 'dark']) {
      const mc = await b.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 }); await mc.addInitScript(look(), theme);
      const ph = await mc.newPage(); watch(ph, 'phone-' + theme); await ph.goto(BASE + '/link/?demo'); await ph.waitForSelector('#side .item');
      assert.strictEqual(await over(ph), 0);
      await quiet(ph); await ph.screenshot({ path: out + `/phone-list-${theme}.png` });
      assert.ok(!(await ph.isVisible('[data-cmenu="c-office"]')), 'no ⋯ on each row on a phone (the chat has its own ⋯)');
      await ph.tap('[data-ch="c-office"]'); await ph.tap('#morebtn'); await ph.waitForSelector('.chmenu');
      const m = await ph.$eval('.chmenu', (e) => { const x = e.getBoundingClientRect(); return { l: x.left, r: x.right, b: x.bottom }; });
      assert.ok(m.l >= 0 && m.r <= 390 && m.b <= 844, 'the menu fits on the screen ' + JSON.stringify(m)); assert.strictEqual(await over(ph), 0);
      await quiet(ph); await ph.screenshot({ path: out + `/phone-menu-${theme}.png` }); if (theme === 'light') await quiet(ph); await ph.screenshot({ path: out + '/phone-view.png' });
      await ph.tap('#mmute'); await ph.tap('#mhead .back'); await ph.waitForTimeout(150); assert.ok(await ph.$('[data-ch="c-office"].muted'));
      await ph.tap('[data-filter="people"]'); assert.ok(!(await ph.isVisible('[data-ch="c-general"]')) && await ph.isVisible('[data-dm="u-ana"]'));
      await ph.tap('[data-filter="all"]'); assert.strictEqual(await over(ph), 0);
      await ph.tap('[data-ch="c-general"]'); await ph.waitForTimeout(150); assert.ok(!(await ph.isVisible('#rtog')), 'the panel toggle stays off the phone header');
      await ph.tap('#morebtn'); await ph.waitForSelector('.chmenu'); assert.strictEqual(await over(ph), 0); await quiet(ph); await ph.screenshot({ path: out + `/phone-header-menu-${theme}.png` });
      await ph.tap('#mmembers'); await ph.waitForTimeout(200); assert.ok(await ph.isVisible('#lkright'), 'Members opens the details panel');
      await ph.tap('#lkright .back'); await ph.tap('#mhead .back'); await ph.waitForTimeout(150);
      assert.ok(await ph.isVisible('#lknav') && (await ph.$$('#lknav [data-nav]')).length === 4, 'Chats · Calls · People · Settings along the bottom');
      await quiet(ph); await ph.screenshot({ path: out + `/phone-nav-${theme}.png` });
      await mc.close();
    }
    console.log('phone width: ok');

    // 7. a pretend Supabase: the actions reach the database's checked actions; its refusals show in plain words
    const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }], user_metadata: {} };
    const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
    const W = '11111111-2222-4333-8444-555555555555'; const G = '22222222-3333-4444-8555-666666666666'; const J = '33333333-3333-4444-8555-666666666666'; const A = '44444444-3333-4444-8555-666666666666';
    const fake = async (page, old) => {
      const st = { rpc: [] };
      const chans = [{ id: G, kind: 'channel', name: 'general', topic: 'Everyone', created_by: user.id, archived: false }, { id: J, kind: 'channel', name: 'jobs', topic: null, created_by: user.id, archived: false },
        { id: A, kind: 'channel', name: 'old-site', topic: 'The 2025 fit-out', created_by: user.id, archived: true }];
      await page.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"sb_publishable_test"};' }));
      await page.route('https://fake.supabase.test/**', async (r) => {
        const u = new URL(r.request().url()); const m = r.request().method(); const fn = u.pathname.replace('/rest/v1/rpc/', ''); const body = (() => { try { return JSON.parse(r.request().postData() || '{}'); } catch { return {}; } })();
        const json = (x, s = 200) => r.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(x) });
        if (m === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (u.pathname.startsWith('/rest/v1/rpc/')) st.rpc.push([fn, body]);
        if (old && (u.pathname === '/rest/v1/channel_prefs' || /^channel_/.test(fn))) return json({ code: 'PGRST205', message: 'Could not find the table \'public.channel_prefs\' in the schema cache' }, 404);
        if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
        if (u.pathname === '/auth/v1/user') return json(user);
        if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: W, name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
        if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }]);
        if (u.pathname === '/rest/v1/channels') { st.chanQuery = u.search; return json(chans); }
        if (u.pathname === '/rest/v1/channel_prefs') return json([{ channel_id: J, muted: true, left_at: null }]);
        if (fn === 'channel_rename' && body.new_name === 'oops') return json({ code: 'P0001', message: 'Only whoever made this channel, or the owner or an admin, can change its name or topic.' }, 400);
        if (fn === 'channel_rename') { const c = chans.find((x) => x.id === body.ch); if (body.new_name != null) c.name = body.new_name; if (body.new_topic != null) c.topic = body.new_topic || null; return json(null); }
        if (fn === 'channel_archive') { chans.find((x) => x.id === body.ch).archived = body.archive; return json(null); }
        if (fn === 'channel_mute' || fn === 'channel_leave') return json(null);
        if (fn === 'team_features') return json({ calls: false });
        return json([]);
      });
      return st;
    };
    const fp = await b.newPage({ viewport: { width: 1366, height: 860 }, deviceScaleFactor: 2 }); watch(fp, 'server');
    const fs = await fake(fp, false);
    await fp.goto(BASE + '/link/?chat'); await fp.waitForSelector('#gf');
    await fp.fill('input[name=email]', user.email); await fp.fill('input[name=password]', 'a-good-password'); await fp.click('button[type=submit]');
    await fp.waitForSelector('#txt');
    assert.ok(!/archived=eq\.false/.test(fs.chanQuery), 'archived channels are asked for too');
    assert.ok(await fp.$(`[data-ch="${J}"].muted`), 'muted on the server: muted here'); assert.strictEqual(await fp.getAttribute('[data-sect="archived"]', 'aria-expanded'), 'false');
    await fp.click('[data-sect="archived"]'); await fp.click(`[data-ch="${A}"]`); await fp.waitForSelector('#archbar'); assert.ok(!(await fp.isVisible('#comp')));
    await fp.click('#unarch'); await fp.waitForSelector('#comp:not([hidden])');
    assert.deepStrictEqual(fs.rpc.filter(([f]) => f === 'channel_archive').pop()[1], { ch: A, archive: false });
    await fp.click(`[data-ch="${J}"]`); await fp.click('#morebtn'); await fp.click('#mrename'); await fp.fill('#rnv', 'Site Jobs'); await fp.click('#rngo');
    await fp.waitForFunction(() => /site-jobs/.test(document.querySelector('#mhead h2').textContent));
    assert.deepStrictEqual(fs.rpc.filter(([f]) => f === 'channel_rename').pop()[1], { ch: J, new_name: 'site-jobs', new_topic: null });
    await fp.click('#morebtn'); await fp.click('#mrename'); await fp.fill('#rnv', 'oops'); await fp.click('#rngo');
    await fp.waitForSelector('#rne:not([hidden])'); assert.match(await text(fp, '#rne'), /^Only whoever made this channel/, 'the database\'s refusal, in its own words'); await fp.click('.modal #cl');
    await fp.click('#morebtn'); await fp.click('#mmute'); assert.deepStrictEqual(fs.rpc.filter(([f]) => f === 'channel_mute').pop()[1], { ch: J, mute_on: false });
    await fp.click('#morebtn'); await fp.click('#marchive'); await fp.click('#askyes'); await fp.waitForFunction(() => /general/.test(document.querySelector('#mhead h2').textContent));
    assert.deepStrictEqual(fs.rpc.filter(([f]) => f === 'channel_archive').pop()[1], { ch: J, archive: true });
    await fp.click('#morebtn'); assert.ok(!(await menuIds(fp)).includes('marchive'), 'no Archive on #general'); await fp.keyboard.press('Escape');
    console.log('pretend server: rename, mute, archive and unarchive: ok');

    const op = await b.newPage({ viewport: { width: 1280, height: 860 } }); watch(op, 'old db'); await fake(op, true);
    await op.goto(BASE + '/link/?chat'); await op.waitForSelector('#gf'); await op.fill('input[name=email]', user.email); await op.fill('input[name=password]', 'a-good-password'); await op.click('button[type=submit]');
    await op.waitForSelector('#txt'); await op.click(`[data-ch="${J}"]`); await op.click('#morebtn');
    assert.deepStrictEqual(await menuIds(op), ['mmembers', 'mpin', 'minfo'], 'an older database: only what it can do');
    console.log('older database: ok');
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('CHANNEL MENU TESTS PASSED');
})();
