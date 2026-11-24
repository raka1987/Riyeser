// Real calls between browser tabs in the demo (fake microphone and camera): person to person, a branch call
// (first to answer takes it), the dial pad, branch set-up, and the premium upsell.
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
  const tab = async (p, t) => { await p.click(`[data-tab="${t}"]`); await p.waitForTimeout(100); };
  const until = async (p, want, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await status(p)) === want) return true; await p.waitForTimeout(100); } return false; };

  const me = await open(''); const jordan = await open('u-jordan');
  await me.waitForTimeout(300); await tab(me, 'calls');
  console.log('Calls tab:', await me.evaluate(() => [...document.querySelectorAll('[data-callbranch]')].map((x) => x.textContent.replace(/\s+/g, ' ').trim())),
    '| my ext:', await me.textContent('.myext'));

  // 1. person to person
  await tab(me, 'chats'); await me.click('[data-dm="u-jordan"]'); await me.waitForTimeout(200); await me.click('#calldm');
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

  // 2. branch call: Jordan and Alex both ring; Jordan answers, Alex is told
  const alex = await open('u-alex'); await me.waitForTimeout(300);
  await tab(me, 'calls'); await me.click('[data-callbranch="b-lau"]');
  console.log('2. branch rings both:', await until(jordan, 'incoming'), await until(alex, 'incoming'));
  await jordan.click('#c-ans');
  console.log('   Jordan live:', await until(jordan, 'live'), '| Alex sees:', await until(alex, 'ended') && await alex.evaluate(() => window.RiyeserTeam.calls.current && window.RiyeserTeam.calls.current.note));
  await jordan.click('#c-end'); await until(me, 'ended'); await me.waitForTimeout(2700);

  // 3. declining
  await tab(me, 'chats'); await me.click('[data-dm="u-jordan"]'); await me.click('#calldm'); await until(jordan, 'incoming'); await jordan.click('#c-dec');
  console.log('3. declined ->', await until(me, 'ended') && await me.evaluate(() => window.RiyeserTeam.calls.current.note));
  await me.waitForTimeout(2700);

  // 4. dial pad
  await tab(me, 'calls'); await me.click('#dial'); await me.click('[data-k="2"]'); await me.click('[data-k="0"]'); await me.click('[data-k="2"]');
  console.log('4. dial 202 ->', await me.textContent('#dpw')); await me.fill('#dpn', '200'); await me.dispatchEvent('#dpn', 'input'); console.log('   dial 200 ->', await me.textContent('#dpw'));
  await me.click('#cl');

  // 5. branches and extensions (owner)
  await me.click('#mgbr'); await me.fill('#nb input', 'Nadi branch'); await me.click('#nb button'); await me.waitForTimeout(300);
  console.log('5. new branch:', await me.evaluate(() => window.RiyeserTeam.state.branches.map((x) => `${x.name} ${x.extension} ${x.code}`)));
  await me.fill('[data-ext="u-alex"]', '101'); await me.click('#sx'); await me.waitForTimeout(300);
  console.log('   taken number refused, Alex still:', await me.evaluate(() => window.RiyeserTeam.state.people.find((p) => p.user_id === 'u-alex').extension));
  await me.screenshot({ path: out + '/call-branches.png' });
  await me.click('#cl');

  // 6. one tab alone: a demo call that "answers"; and premium off shows the upsell
  await jordan.close(); await alex.close();
  const solo = await (await b.newContext({ permissions: ['microphone'] })).newPage(); solo.on('pageerror', (e) => errs.push('solo: ' + e.message));
  await solo.goto(URL); await solo.waitForSelector('.item'); await solo.click('[data-dm="u-sam"]'); await solo.click('#calldm');
  const t = Date.now(); let st; while (Date.now() - t < 6000 && (st = await status(solo)) !== 'live') await solo.waitForTimeout(150);
  console.log('6. solo demo call:', st, '|', await solo.textContent('.cwho small'));
  await solo.click('#c-end'); await solo.waitForTimeout(2700);
  await solo.evaluate(() => { window.RiyeserTeam.state.features = { calls: false }; }); await solo.click('#calldm');
  console.log('   premium off ->', await solo.textContent('.modal h3'));
  const ph = await (await b.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] })).newPage();
  await ph.goto(URL); await ph.waitForSelector('.item'); await ph.tap('[data-dm="u-sam"]'); await ph.tap('#calldm'); await ph.waitForTimeout(400);
  await ph.screenshot({ path: out + '/call-phone.png' });
  console.log('   phone overflow:', await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  console.log('errors:', errs); await b.close();
})();
