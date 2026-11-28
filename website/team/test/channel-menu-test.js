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
      const secs = () => pg.$$eval('#side .sec', (x) => x.map((y) => y.dataset.sec));
      assert.deepStrictEqual(await secs(), ['pinned', 'channels', 'people'], 'Pinned, Channels, Direct messages; no Archived section while nothing is archived');
      assert.deepStrictEqual(await pg.$$eval('#side .sec .secl', (x) => x.map((y) => y.textContent)), ['Pinned', 'Channels', 'Direct messages']);

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
      // a line in the chat for everyone, and the list's preview says so too
      await pg.waitForSelector('#msgs .lk-sys[data-sys="rename"]'); assert.match(await text(pg, '#msgs .lk-sys[data-sys="rename"]'), /^You renamed #office to #paper-work \d/);
      assert.strictEqual(await text(pg, '[data-ch="c-office"] .pv'), 'You renamed #office to #paper-work');
      assert.strictEqual(await pg.evaluate(() => window.RiyeserTeam.state.unread['c-office'] || 0), 0, 'the line isn\'t an unread message');
      // Edit topic
      await pg.click('#morebtn'); await pg.click('#mtopic'); await pg.fill('#rnv', 'Bills, invoices and the post'); await pg.click('#rngo');
      await pg.waitForFunction(() => /Bills, invoices and the post/.test(document.querySelector('#mhead small').textContent));
      await pg.waitForSelector('#msgs .lk-sys[data-sys="topic"]'); assert.match(await text(pg, '#msgs .lk-sys[data-sys="topic"]'), /^You changed the topic to “Bills, invoices and the post”/);
      await quiet(pg); await pg.screenshot({ path: out + `/channel-system-lines-${theme}.png` });
      // renaming a channel to "general" is refused, and the dialog says why
      await pg.click('#morebtn'); await pg.click('#mrename'); await pg.fill('#rnv', 'general'); await pg.click('#rngo');
      await pg.waitForSelector('#rne:not([hidden])'); assert.match(await text(pg, '#rne'), /There's already a #general/); await pg.click('.modal #cl');
      console.log(theme, 'rename and topic: ok');

      // 3. Mute, from the list's ⋯ (shows on hover): the unread badge dims and leaves the total
      const total = () => pg.evaluate(() => Number((document.title.match(/^\((\d+)\)/) || [0, 0])[1]));
      const before = await total(); const jobsUnread = await pg.evaluate(() => window.RiyeserTeam.state.unread['c-jobs'] || 0);
      assert.ok(jobsUnread > 0, '#jobs has unread messages to start with');
      await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]'); assert.match(await text(pg, '#mmute'), /^Mute… ?For an hour, a day, a week or until you unmute/); await pg.click('#mmute');
      // for how long: 1 hour, 8 hours, until tomorrow (8 am), a week, until I turn it back on
      await pg.waitForSelector('.mutemenu'); assert.deepStrictEqual(await pg.$$eval('.mutemenu .mi', (x) => x.map((y) => y.id)), ['mute-1h', 'mute-8h', 'mute-tomorrow', 'mute-week', 'mute-ever']);
      assert.match(await text(pg, '#mute-tomorrow'), /^Until tomorrow ?Until tomorrow, 8:00/);
      assert.ok(await pg.evaluate(() => { const m = document.querySelector('.mutemenu').getBoundingClientRect(); return m.right <= innerWidth && m.bottom <= innerHeight && m.left >= 0; }), 'the mute menu fits');
      await quiet(pg); await pg.screenshot({ path: out + `/channel-mute-for-${theme}.png` });
      await pg.click('#mute-8h');
      assert.ok(await pg.$('[data-ch="c-jobs"].muted .mutei') && await pg.$('[data-ch="c-jobs"] .badge.dim'), 'muted: an icon and a grey badge');
      const until = await pg.evaluate(() => window.RiyeserTeam.state.cprefs['c-jobs'].until);
      assert.ok(Math.abs(Date.parse(until) - Date.now() - 8 * 3600e3) < 60e3, 'muted for 8 hours: ' + until);
      assert.strictEqual(await total(), before - jobsUnread, 'muted chats leave the unread total (and the tab title)');
      await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]'); assert.match(await text(pg, '#mmute'), /^Unmute ?Muted until \d/); await pg.click('#mmute');
      assert.strictEqual(await total(), before); assert.ok(!(await pg.$('[data-ch="c-jobs"].muted')));
      // a timed mute ends by itself
      await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]'); await pg.click('#mmute'); await pg.click('#mute-1h');
      assert.strictEqual(await total(), before - jobsUnread);
      await pg.evaluate(() => { window.RiyeserTeam.state.cprefs['c-jobs'].until = new Date(Date.now() - 1000).toISOString(); });
      await pg.click('[data-filter="unread"]'); await pg.click('[data-filter="all"]');   // redraws the list and the title
      assert.strictEqual(await total(), before, 'past its time: counted again'); await pg.hover('[data-ch="c-jobs"]'); await pg.click('[data-cmenu="c-jobs"]');
      assert.match(await text(pg, '#mmute'), /^Mute…/); await pg.keyboard.press('Escape');
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
      assert.deepStrictEqual(await secs(), ['pinned', 'channels', 'people', 'archived']); assert.strictEqual(await text(pg, '[data-sect="archived"]'), 'Archived1');
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
      assert.strictEqual(await secOf(pg, 'c-office'), 'channels'); assert.ok(!(await pg.$('[data-sect="archived"]')), 'Archived goes when empty');
      assert.match(await text(pg, '#msgs .lk-sys[data-sys="unarchive"]'), /^You brought this channel back/);
      assert.ok(await pg.$('#msgs .lk-sys[data-sys="archive"]'), 'and the "archived" line before it');
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

      // Members of a private channel: add and remove people (each a line in the chat), and all of it in the change history
      await pg.click('[data-ch="c-exec"]'); await pg.click('#morebtn'); assert.match(await text(pg, '#mmembers'), /^Members ?2 people · add or remove people/); await pg.click('#mmembers');
      await pg.check('.modal input[value="u-jordan"]'); await pg.check('.modal input[value="u-alex"]'); await pg.click('.modal #sv');
      await pg.waitForSelector('#msgs .lk-sys[data-sys="add"]'); assert.match(await text(pg, '#msgs .lk-sys[data-sys="add"]'), /^You added (Alex Nguyen, Jordan Lee|Jordan Lee, Alex Nguyen) \d/);
      await pg.click('#morebtn'); await pg.click('#mmembers'); await pg.uncheck('.modal input[value="u-alex"]'); await pg.click('.modal #sv');
      await pg.waitForSelector('#msgs .lk-sys[data-sys="remove"]'); assert.match(await text(pg, '#msgs .lk-sys[data-sys="remove"]'), /^You removed Alex Nguyen/);
      assert.match(await text(pg, '#mhead small'), /^3 people/);
      await pg.evaluate(() => window.RiyeserTeam.showHistory()); await pg.waitForSelector('.modal .hist');
      const hist = await text(pg, '.modal .hist');
      for (const h of ['renamed a channel · #office → #paper-work', 'changed a channel\'s topic · #paper-work: “Bills, invoices and the post”', 'archived a channel · #paper-work',
        'brought back a channel · #paper-work', 'changed who\'s in a private channel · 🔒 executives: added', 'changed who\'s in a private channel · 🔒 executives: removed Alex Nguyen'])
        assert.ok(hist.includes(h), `the change history has "${h}": ${hist.slice(0, 400)}`);
      await quiet(pg); await pg.screenshot({ path: out + `/channel-history-${theme}.png` }); await pg.click('.modal #cl');
      console.log(theme, 'members and the change history: ok');

      // Folding away, remembered (a reload, this browser; the account test is below): a section, the list down to icons, the details
      await pg.click('[data-sect="people"]'); assert.strictEqual(await pg.getAttribute('[data-sect="people"]', 'aria-expanded'), 'false');
      assert.ok(!(await pg.isVisible('[data-dm="u-ana"]')), 'Direct messages folded away');
      assert.match(await text(pg, '[data-sect="people"]'), /^Direct messages ?1$/, 'its unread messages still show on the heading');
      await pg.click('#railbtn'); await pg.waitForSelector('#lkshell.rail');
      const lw = await pg.$eval('#side', (e) => e.getBoundingClientRect().width); assert.ok(lw <= 80, 'the list is down to icons: ' + lw);
      assert.strictEqual(await pg.getAttribute('[data-ch="c-general"]', 'title'), 'general'); assert.ok(await pg.isVisible('[data-ch="c-jobs"] .badge'), 'unread badges stay');
      assert.strictEqual(await pg.getAttribute('#railbtn', 'aria-pressed'), 'true');
      await pg.click('[data-ch="c-general"]'); await pg.click('#infobtn'); await pg.waitForSelector('#lkshell.details');
      await pg.reload(); await pg.waitForSelector('#lkshell .item'); await pg.waitForTimeout(200);
      assert.ok(await pg.$('#lkshell.rail'), 'still icons after a reload'); assert.ok(await pg.$('#lkshell.details'), 'the details are still open');
      assert.strictEqual(await pg.getAttribute('[data-sect="people"]', 'aria-expanded'), 'false', 'still folded');
      await quiet(pg); await pg.screenshot({ path: out + `/collapsed-${theme}.png` });
      await pg.keyboard.press('Control+BracketLeft'); await pg.waitForTimeout(100); assert.ok(!(await pg.$('#lkshell.rail')), 'Ctrl + [ opens the list again');
      await pg.click('#rclose'); await pg.click('[data-sect="people"]'); assert.ok(await pg.isVisible('[data-dm="u-ana"]'));
      console.log(theme, 'folding away, remembered: ok');

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
      await ph.tap('#mmute'); await ph.waitForSelector('.mutemenu');
      const mm = await ph.$eval('.mutemenu', (e) => { const x = e.getBoundingClientRect(); return { l: x.left, r: x.right, b: x.bottom }; });
      assert.ok(mm.l >= 0 && mm.r <= 390 && mm.b <= 844, 'the mute menu fits ' + JSON.stringify(mm)); await quiet(ph); await ph.screenshot({ path: out + `/phone-mute-${theme}.png` });
      await ph.tap('#mute-ever'); await ph.tap('#mhead .back'); await ph.waitForTimeout(150); assert.ok(await ph.$('[data-ch="c-office"].muted'));
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

    // 8. the owner's layout standard: 1280 at 125% (1024 wide), 1366, 1920 and a 390 phone, light and dark; the list, the ⋯ and
    //    mute menus, the details, the list down to icons: nothing cut off, nothing wrapping onto a second line, no sideways scroll
    const layoutIssues = (p) => p.evaluate(() => {
      const bad = []; const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const nm = (e) => `${e.id ? '#' + e.id : e.className} "${e.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)}"`;
      if (document.documentElement.scrollWidth > innerWidth) bad.push('the page scrolls sideways');
      for (const e of document.querySelectorAll('.lk-top > *, .lk-lhead, .lk-lhead > *, .lk-chips, .sec .sech, .lk-hacts, .lk-hacts > *, .lk-menu .mi, .chmenu .mi:not(#mtopic) small, .lk-rhead, .lk-iacts .btn, .lk-sys, #lknav button'))
        if (vis(e) && e.scrollWidth > e.clientWidth + 1) bad.push('cut off: ' + nm(e));
      // one line: every bit of its text sits on the same line (a text box starting below the line before it means it wrapped)
      const oneLine = (e) => { const rs = []; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let t;
        while ((t = w.nextNode())) { if (!t.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(t); rs.push(...[...r.getClientRects()].filter((x) => x.width > 0)); }
        rs.sort((x, y) => x.top - y.top); let bottom = -1e9; let lines = 0;
        for (const x of rs) { if (x.top >= bottom - 1) { lines += 1; bottom = x.bottom; } else bottom = Math.max(bottom, x.bottom); }
        return lines <= 1; };
      for (const e of document.querySelectorAll('.chip, .sec .sech, .lk-new, .lk-callb, .lk-tb, .lk-status, .lk-iacts .btn, .lk-menu .mi small, .lk-r1 .nm, .lk-r2 .pv, .lk-ht h2, .lk-ht small, .lk-menu .mh, .mutemenu .mnote'))
        if (vis(e) && !oneLine(e)) bad.push('wraps: ' + nm(e));
      for (const row of document.querySelectorAll('.lk-iacts')) { const bs = [...row.children].filter(vis); if (bs.length && new Set(bs.map((x) => Math.round(x.getBoundingClientRect().top))).size > 1) bad.push('the details buttons wrap'); }
      const ir = document.querySelector('.lk-iacts'); if (ir && vis(ir) && ir.scrollWidth > ir.clientWidth + 1) bad.push('the details buttons are cut off');
      const chips = [...document.querySelectorAll('.lk-chips .chip')].filter(vis);
      if (chips.length && new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size > 1) bad.push('the chips wrap onto two lines');
      for (const m of document.querySelectorAll('.lk-menu')) { const r = m.getBoundingClientRect(); if (r.left < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.top < 0) bad.push('a menu goes off the screen'); }
      return bad;
    });
    const SIZES = [{ n: '1280at125', viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1.25 }, { n: '1366', viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
      { n: '1920', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }, { n: '390', ...devices['iPhone 13'], deviceScaleFactor: 2 }];
    for (const sz of SIZES) for (const theme of ['light', 'dark']) {
      const lc = await b.newContext({ ...sz, n: undefined }); await lc.addInitScript(look(), theme);
      const lp = await lc.newPage(); watch(lp, `layout ${sz.n} ${theme}`); await lp.goto(BASE + '/link/?demo'); await lp.waitForSelector('#lkshell .item');
      const phone = sz.n === '390'; const shot = async (st) => { await quiet(lp); await lp.screenshot({ path: `${out}/layout-${sz.n}-${theme}-${st}.png` });
        const bad = await layoutIssues(lp); assert.deepStrictEqual(bad, [], `${sz.n} ${theme} ${st}: ${bad.join('; ')}`); };
      await shot('list');
      if (phone) { await lp.tap('[data-ch="c-office"]'); await lp.waitForTimeout(150); } else await lp.click('[data-ch="c-office"]');
      await lp.click('#morebtn'); await lp.waitForSelector('.chmenu'); await shot('menu');
      await lp.click('#mmute'); await lp.waitForSelector('.mutemenu'); await shot('mute');
      await lp.click('#mute-1h'); await lp.waitForTimeout(100);
      await lp.click('#infobtn'); await lp.waitForTimeout(250); await shot('details');
      if (!phone) {
        if (sz.viewport.width < 1281) await lp.click('#rclose');   // narrower: the details cover the chat, so close them first
        await lp.click('#railbtn'); await lp.waitForSelector('#lkshell.rail'); await shot('icons');
        await lp.click('[data-sect="channels"]'); await lp.click('[data-sect="pinned"]'); await shot('folded');
      }
      await lc.close();
    }
    console.log('layout at 1280@125%, 1366, 1920 and 390, light and dark: ok');

    // 7. a pretend Supabase: the actions reach the database's checked actions; its refusals show in plain words
    const user = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'owner@sample.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }], user_metadata: {} };
    const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
    const W = '11111111-2222-4333-8444-555555555555'; const G = '22222222-3333-4444-8555-666666666666'; const J = '33333333-3333-4444-8555-666666666666'; const A = '44444444-3333-4444-8555-666666666666';
    // old: true = a database without the channel menu; 'part1' = the channel menu without part 2 (no muted_until, no channel_mute_until)
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
        if (old === 'part1' && ((u.pathname === '/rest/v1/channel_prefs' && /muted_until/.test(u.search)) ))
          return json({ code: '42703', message: 'column channel_prefs.muted_until does not exist' }, 400);
        if (old === 'part1' && fn === 'channel_mute_until') return json({ code: 'PGRST202', message: 'Could not find the function public.channel_mute_until(ch, until_at) in the schema cache' }, 404);
        if (old === true && (u.pathname === '/rest/v1/channel_prefs' || /^channel_/.test(fn))) return json({ code: 'PGRST205', message: 'Could not find the table \'public.channel_prefs\' in the schema cache' }, 404);
        if (u.pathname === '/auth/v1/token') return json({ access_token: token(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user });
        if (u.pathname === '/auth/v1/user' && m === 'PUT') { const bd = JSON.parse(r.request().postData() || '{}'); st.put = bd; user.user_metadata = { ...user.user_metadata, ...(bd.data || {}) }; return json(user); }
        if (u.pathname === '/auth/v1/user') return json(user);
        if (u.pathname === '/rest/v1/members' && u.search.includes('workspaces')) return json([{ role: 'owner', job_role: 'owner', display_name: 'Alex Sample', workspaces: { id: W, name: 'Sample Plumbing', invite_code: 'AB12CD34', company_code: 'RIY-7K3M-Q2', kind: 'business' } }]);
        if (u.pathname === '/rest/v1/members') return json([{ user_id: user.id, display_name: 'Alex Sample', role: 'owner', job_role: 'owner', extension: 101 }]);
        if (u.pathname === '/rest/v1/channels') { st.chanQuery = u.search; return json(chans); }
        if (u.pathname === '/rest/v1/channel_prefs') return json([{ channel_id: J, muted: true, left_at: null }, { channel_id: G, muted: true, muted_until: new Date(Date.now() - 60e3).toISOString(), left_at: null }]);
        if (fn === 'channel_rename' && body.new_name === 'oops') return json({ code: 'P0001', message: 'Only whoever made this channel, or the owner or an admin, can change its name or topic.' }, 400);
        if (fn === 'channel_rename') { const c = chans.find((x) => x.id === body.ch); if (body.new_name != null) c.name = body.new_name; if (body.new_topic != null) c.topic = body.new_topic || null; return json(null); }
        if (fn === 'channel_archive') { chans.find((x) => x.id === body.ch).archived = body.archive; return json(null); }
        if (fn === 'channel_mute' || fn === 'channel_mute_until' || fn === 'channel_leave') return json(null);
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
    // the server's answer can arrive a moment after the screen changes: wait for the call itself
    const seen = (fn) => fs.rpc.filter(([f]) => f === fn);
    const called = async (fn, act) => { const n = seen(fn).length; await act(); for (let i = 0; i < 100 && seen(fn).length <= n; i++) await new Promise((r) => setTimeout(r, 50)); return (seen(fn).pop() || [])[1]; };
    assert.deepStrictEqual(await called('channel_archive', async () => { await fp.click('#unarch'); await fp.waitForSelector('#comp:not([hidden])'); }), { ch: A, archive: false });
    assert.deepStrictEqual(await called('channel_rename', async () => {
      await fp.click(`[data-ch="${J}"]`); await fp.click('#morebtn'); await fp.click('#mrename'); await fp.fill('#rnv', 'Site Jobs'); await fp.click('#rngo');
      await fp.waitForFunction(() => /site-jobs/.test(document.querySelector('#mhead h2').textContent));
    }), { ch: J, new_name: 'site-jobs', new_topic: null });
    await fp.click('#morebtn'); await fp.click('#mrename'); await fp.fill('#rnv', 'oops'); await fp.click('#rngo');
    await fp.waitForSelector('#rne:not([hidden])'); assert.match(await text(fp, '#rne'), /^Only whoever made this channel/, 'the database\'s refusal, in its own words'); await fp.click('.modal #cl');
    assert.ok(!(await fp.$(`[data-ch="${G}"].muted`)), 'muted until a time that has passed: not muted');
    assert.deepStrictEqual(await called('channel_mute', async () => { await fp.click('#morebtn'); await fp.click('#mmute'); }), { ch: J, mute_on: false });
    const mu = await called('channel_mute_until', async () => { await fp.click('#morebtn'); await fp.click('#mmute'); await fp.click('#mute-week'); }); assert.strictEqual(mu.ch, J);
    assert.ok(Math.abs(Date.parse(mu.until_at) - Date.now() - 7 * 86400e3) < 60e3, 'muted for a week: ' + mu.until_at);
    await fp.click('#morebtn'); await fp.click('#mmute');
    assert.deepStrictEqual(await called('channel_mute_until', async () => { await fp.click('#morebtn'); await fp.click('#mmute'); await fp.click('#mute-ever'); }), { ch: J, until_at: null }, 'until I turn it back on');
    await fp.click('#morebtn'); await fp.click('#mmute');
    assert.deepStrictEqual(await called('channel_archive', async () => { await fp.click('#morebtn'); await fp.click('#marchive'); await fp.click('#askyes'); await fp.waitForFunction(() => /general/.test(document.querySelector('#mhead h2').textContent)); }), { ch: J, archive: true });
    await fp.click('#morebtn'); assert.ok(!(await menuIds(fp)).includes('marchive'), 'no Archive on #general'); await fp.keyboard.press('Escape');
    console.log('pretend server: rename, mute, archive and unarchive: ok');

    const op = await b.newPage({ viewport: { width: 1280, height: 860 } }); watch(op, 'old db'); await fake(op, true);
    await op.goto(BASE + '/link/?chat'); await op.waitForSelector('#gf'); await op.fill('input[name=email]', user.email); await op.fill('input[name=password]', 'a-good-password'); await op.click('button[type=submit]');
    await op.waitForSelector('#txt'); await op.click(`[data-ch="${J}"]`); await op.click('#morebtn');
    assert.deepStrictEqual(await menuIds(op), ['mmembers', 'mpin', 'minfo'], 'an older database: only what it can do');
    console.log('older database: ok');

    // the channel menu without part 2: Mute still works (until turned back on), nothing breaks
    const p1 = await b.newPage({ viewport: { width: 1366, height: 860 } }); watch(p1, 'part1 db'); const s1 = await fake(p1, 'part1');
    await p1.goto(BASE + '/link/?chat'); await p1.waitForSelector('#gf'); await p1.fill('input[name=email]', user.email); await p1.fill('input[name=password]', 'a-good-password'); await p1.click('button[type=submit]');
    await p1.waitForSelector('#txt'); assert.ok(await p1.$(`[data-ch="${J}"].muted`), 'muted from the older table');
    await p1.click(`[data-ch="${J}"]`); await p1.click('#morebtn'); await p1.click('#mmute'); await p1.click('#morebtn'); await p1.click('#mmute'); await p1.click('#mute-8h');
    await p1.waitForFunction(() => document.querySelector('#phmsg') && /is muted\./.test(document.querySelector('#phmsg').textContent));
    assert.deepStrictEqual(s1.rpc.slice(-2).map(([f, x]) => [f, x.mute_on]), [['channel_mute_until', undefined], ['channel_mute', true]], 'falls back to channel_mute');
    assert.strictEqual(await p1.evaluate((j) => window.RiyeserTeam.state.cprefs[j].until, J), null);
    console.log('the channel menu without part 2: ok');

    // what you folded away comes from your account on another PC (nothing in this browser yet), and changes are saved to it
    user.user_metadata = { riyeser_prefs: { ui: { shut: { channels: true }, rail: true } } };
    const ap = await b.newPage({ viewport: { width: 1920, height: 1080 } }); watch(ap, 'account prefs'); const sa = await fake(ap, false);
    await ap.goto(BASE + '/link/?chat'); await ap.waitForSelector('#gf'); await ap.fill('input[name=email]', user.email); await ap.fill('input[name=password]', 'a-good-password'); await ap.click('button[type=submit]');
    await ap.waitForSelector('#txt'); await ap.waitForSelector('#lkshell.rail');
    assert.strictEqual(await ap.getAttribute('[data-sect="channels"]', 'aria-expanded'), 'false', 'Channels folded, from the account');
    await ap.click('#railbtn'); await ap.click('[data-sect="channels"]'); await ap.waitForTimeout(1200);
    assert.ok(sa.put && sa.put.data && sa.put.data.riyeser_prefs && sa.put.data.riyeser_prefs.ui, 'saved with the account');
    assert.strictEqual(sa.put.data.riyeser_prefs.ui.rail, false); assert.strictEqual(sa.put.data.riyeser_prefs.ui.shut.channels, false);
    assert.strictEqual(await ap.evaluate((u) => JSON.parse(localStorage.getItem('riyeser.link.ui.' + u)).rail, user.id), false, 'and in this browser');
    console.log('folding away, with the account: ok');
  } catch (e) { failed = true; console.error('FAILED:', e.message); }
  console.log('errors:', errs); await b.close();
  if (failed || errs.length) process.exit(1);
  console.log('CHANNEL MENU TESTS PASSED');
})();
