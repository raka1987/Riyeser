// Riyeser HQ phase 1 in demo mode: the Support inbox (reply, internal note, assign, escalate, saved replies), fix-up tools (on the customer page),
// refunds with a second approver, free periods (14 days applies; 90 days waits for another supervisor), Approvals,
// permissions on the HQ team tab, Inactive accounts, Emails, History filters and CSV; phone widths; and the "old database" message.
// Run: build the site, serve website/public on port 8090 (or set HQ_URL), then `node website/hq/test-hq-ops.js <screenshot folder>`.
const { chromium, devices } = require('playwright');
const BASE = (process.env.HQ_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const errs = []; const out = process.argv[2] || '.';
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('dialog', (d) => d.accept());
  const as = async (name) => { await pg.selectOption('#demoAs', { label: name }); await pg.waitForSelector('#main > *'); };
  const tab = async (k) => { await pg.click(`[data-tab=${k}]`); await pg.waitForTimeout(250); };
  const fill = async (sel, v) => pg.fill(sel, v);
  const open = async (name, id) => { await tab('companies'); await fill('#sf input', name); await pg.click('#sf button'); await pg.waitForSelector(`tr[data-co="${id}"]`); await pg.click(`tr[data-co="${id}"]`); await pg.waitForSelector('.cpage'); };
  const cptab = async (k) => { await pg.click(`[data-cptab=${k}]`); await pg.waitForSelector(`#cpBody[data-tab=${k}]`); };
  await pg.goto(BASE + '/hq/?demo'); await pg.waitForSelector('.tiles');
  console.log('tabs:', await pg.evaluate(() => [...document.querySelectorAll('.snav .nv')].map((x) => x.textContent)));

  // --- Support: inbox, filters, timer, reply, internal note, assign, escalate
  await tab('support'); await pg.waitForSelector('.tk');
  console.log('inbox filters:', await pg.evaluate(() => [...document.querySelectorAll('#boxes .chip')].map((x) => x.textContent.trim()).join(' | ')));
  console.log('first-reply timers:', await pg.evaluate(() => [...document.querySelectorAll('.tk')].map((x) => x.querySelector('.code').textContent + ' ' + (x.querySelector('.tmr') ? x.querySelector('.tmr').textContent + (x.querySelector('.tmr.late') ? ' (red)' : '') : '')).join(' | ')));
  await pg.click('[data-box=overdue]'); await pg.waitForTimeout(200); console.log('Overdue filter:', await pg.evaluate(() => [...document.querySelectorAll('.tk b')].map((x) => x.textContent)));
  await pg.click('[data-box=overdue]'); await pg.waitForTimeout(200);
  await fill('#tsf input', 'printer'); await pg.click('#tsf button'); await pg.waitForTimeout(200);
  console.log('search "printer":', await pg.evaluate(() => [...document.querySelectorAll('.tk b')].map((x) => x.textContent)));
  await pg.click('.tk'); await pg.waitForSelector('#rf');
  console.log('business beside the ticket:', (await pg.textContent('#tbiz')).replace(/\s+/g, ' ').trim().slice(0, 140));
  await pg.selectOption('#ins', { label: 'Printer: turn it off and on' }); await pg.click('#rf .btn.p'); await pg.waitForTimeout(300);
  console.log('after reply:', await pg.evaluate(() => [...document.querySelectorAll('.msg small')].map((x) => x.textContent).pop()), '| status:', await pg.$eval('#tst', (s) => s.value));
  await pg.click('#rf [data-ctab=note]'); await fill('#rf textarea[name=note]', 'Known driver bug in 1.7.0, fix coming.'); await pg.click('#rf .btn.p'); await pg.waitForTimeout(300);
  console.log('internal note:', await pg.evaluate(() => { const n = [...document.querySelectorAll('.msg.note')].pop(); return n && n.innerText.replace(/\s+/g, ' '); }));
  await pg.selectOption('#tas', { label: 'Help Desk' }); await pg.waitForTimeout(300); console.log('assigned to:', await pg.$eval('#tas', (s) => s.options[s.selectedIndex].text));
  await pg.click('#tmore'); await pg.click('#tesc'); await pg.waitForSelector('#ef'); await pg.selectOption('#ef [name=level]', '2'); await pg.selectOption('#ef [name=assign]', { label: 'Senior Sione' });
  await fill('#ef [name=reason]', 'Needs a developer to check the printer driver'); await pg.click('#ef .btn.p'); await pg.waitForTimeout(300);
  console.log('escalated:', await pg.evaluate(() => [...document.querySelectorAll('.tview .pill')].map((x) => x.textContent).join(' | ')), '|', await pg.evaluate(() => [...document.querySelectorAll('.msg')].slice(-2).map((x) => x.innerText.replace(/\s+/g, ' ')).join(' || ')));
  console.log('after escalation, Help Desk-level staff see:', await pg.evaluate(() => (document.querySelector('#tas') || {}).value));
  await pg.click('#rf [data-ctab=reply]'); await pg.click('#tsr'); await pg.waitForSelector('#srn'); await fill('#srn input', 'Refund: we\'re on it'); await fill('#srn textarea', 'Thanks, we\'ve passed your refund request to our accounts team.');
  await pg.click('#srn .btn'); await pg.waitForTimeout(300); console.log('saved replies:', await pg.evaluate(() => [...document.querySelectorAll('.srl summary')].map((x) => x.textContent)));
  await pg.click('.modal [data-close]');
  await pg.screenshot({ path: out + '/hq-support.png' });

  // --- Refunds: approve 350 FJD (over 200) as Sam -> waits for a second approver; Sam can't; Finance Fi approves and marks it paid
  await tab('refunds'); await pg.waitForSelector('.rcard');
  console.log('refund queue filters:', await pg.evaluate(() => [...document.querySelectorAll('.chip')].map((x) => x.textContent.trim()).join(' | ')));
  await pg.click('[data-rf=rf1042] [data-ract=approve]'); await fill('#ar [name=reason]', 'Double charge confirmed in the bank statement'); await pg.click('#ar .btn.p'); await pg.waitForTimeout(300);
  console.log('after first approval:', (await pg.textContent('[data-rf=rf1042] .row')).replace(/\s+/g, ' ').trim());
  await tab('approvals'); await pg.click('[data-rf=rf1042] [data-ract=second]'); await pg.click('#sa .btn.p'); await pg.waitForTimeout(300);
  console.log('Sam tries the second approval:', (await pg.textContent('#saerr')).trim()); await pg.click('.modal [data-close]');
  await as('Finance Fi (Finance)'); await tab('approvals');
  console.log('approvals badge:', await pg.textContent('[data-badge=approvals]'));
  await pg.click('[data-rf=rf1042] [data-ract=second]'); await pg.click('#sa .btn.p'); await pg.waitForTimeout(300);
  await tab('refunds'); await pg.click('[data-box=to_pay]'); await pg.waitForSelector('[data-rf=rf1042]');
  await pg.click('[data-rf=rf1042] [data-ract=paid]'); await pg.selectOption('#pd [name=method]', 'credit'); await pg.click('#pd .btn.p'); await pg.waitForTimeout(300);
  await pg.click('[data-box=paid]'); await pg.waitForTimeout(200);
  console.log('paid:', (await pg.textContent('[data-rf=rf1042]')).replace(/\s+/g, ' ').trim().slice(0, 220));
  await pg.screenshot({ path: out + '/hq-refunds.png' });

  // --- Free periods (as Sam): 14 days applies straight away; 90 days waits; Finance Fi approves; seen in Approvals and the company panel
  await as('Sam (Owner)'); await open('northside', 'w3'); await cptab('programs');
  const posBefore = (await pg.textContent('#licCard tr[data-mod=pos] .pill')).trim();
  await pg.click('[data-fix=offer]'); await pg.waitForSelector('#of'); await pg.selectOption('#of [name=kind]', 'trial'); await pg.check('#of input[value=pos]');
  await fill('#of [name=amount]', '14'); await pg.selectOption('#of [name=why]', 'goodwill'); await fill('#of [name=reason]', 'Sorry about the printer trouble'); await pg.click('#of .btn.p');
  await pg.waitForSelector('.flash'); console.log('14 days:', await pg.textContent('.flash'), '| POS was:', posBefore, '| now:', (await pg.textContent('#licCard tr[data-mod=pos] .pill')).trim());
  await pg.click('[data-fix=offer]'); await pg.waitForSelector('#of'); await pg.selectOption('#of [name=kind]', 'trial'); await pg.check('#of input[value=bookings]');
  await fill('#of [name=amount]', '90'); await pg.selectOption('#of [name=why]', 'retention'); await fill('#of [name=reason]', 'Thinking of leaving; wants to try Bookings properly'); await pg.click('#of .btn.p');
  await pg.waitForTimeout(400); console.log('90 days:', await pg.evaluate(() => [...document.querySelectorAll('.flash')].pop().textContent), '| Bookings now:', (await pg.textContent('#licCard tr[data-mod=bookings] .pill')).trim());
  console.log('company panel offers:', await pg.evaluate(() => [...document.querySelectorAll('#offCard tr')].slice(1).map((r) => r.innerText.replace(/\s+/g, ' ')).join(' || ')));
  await pg.screenshot({ path: out + '/hq-offers.png' }); await pg.click('#cpBack');
  await tab('approvals'); console.log('Sam sees his own waiting:', (await pg.textContent('#ao')).includes('someone else needs to approve it'));
  await as('Finance Fi (Finance)'); await tab('approvals');
  console.log('approvals tiles:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | '))));
  await pg.click('#ao [data-oact=yes]'); await pg.waitForTimeout(400);
  console.log('after approval:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | ')).slice(1, 3)));
  await pg.screenshot({ path: out + '/hq-approvals.png' });
  await as('Sam (Owner)'); await open('northside', 'w3'); await cptab('programs');
  console.log('Bookings after approval:', (await pg.textContent('#licCard tr[data-mod=bookings] .pill')).trim(), '| offers:', await pg.evaluate(() => [...document.querySelectorAll('#offCard tr td:nth-child(3)')].map((x) => x.innerText.replace(/\s+/g, ' ')).join(' | ')));

  // --- a fix-up tool: reset two-step for a person (identity check), then close as duplicate; the panel's own HQ history
  await cptab('people'); await pg.click('[data-r2fa="w3-p2"]'); await pg.waitForSelector('#fx'); await fill('#fx [name=how]', 'called back on the number on file'); await fill('#fx [name=reason]', 'Lost phone');
  await fill('#fx [name=ticket]', 'T-10236'); await pg.click('#fx .btn.p'); await pg.waitForSelector('.flash');
  console.log('2FA reset:', await pg.evaluate(() => [...document.querySelectorAll('.flash')].pop().textContent));
  await cptab('history'); console.log('company HQ history:', await pg.evaluate(() => [...document.querySelectorAll('#coHist tr')].slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ')).join(' || ')));
  await cptab('overview'); await pg.click('#bizCard [data-fix=edit]'); await pg.waitForSelector('#fx'); await fill('#fx [name=phone]', '02 9000 0000'); await pg.click('#fx .btn.p'); await pg.waitForTimeout(200);
  console.log('edit without a reason:', await pg.evaluate(() => document.querySelector('#fx [name=reason]').validity.valueMissing)); await fill('#fx [name=reason]', 'Owner asked on the phone'); await pg.click('#fx .btn.p'); await pg.waitForTimeout(300);
  console.log('phone now:', await pg.evaluate(() => [...document.querySelectorAll('.kv dt')].find((x) => x.textContent === 'Phone').nextElementSibling.textContent));
  await pg.screenshot({ path: out + '/hq-company-tools.png' }); await pg.click('#cpBack');
  await tab('companies'); await fill('#sf input', ''); await pg.selectOption('#sf select', 'closed'); await pg.waitForTimeout(300);
  console.log('status filter closed:', await pg.evaluate(() => [...document.querySelectorAll('#cl tr.click b')].map((x) => x.textContent)));
  await pg.click('tr[data-co="w7"]'); await pg.waitForSelector('.banner'); console.log('duplicate banner:', (await pg.textContent('.banner')).replace(/\s+/g, ' ').trim());
  await pg.click('.banner [data-goco]'); await pg.waitForTimeout(400); console.log('link opens:', await pg.textContent('.cpage h2')); await pg.click('#cpBack');

  // --- HQ team: permissions for a person
  // (custom HQ roles: the person's page, their standard role and its ticks; tick or untick for them; test-hq-roles.js has the rest)
  await tab('team'); await pg.click('[data-access=s2]'); await pg.waitForSelector('[data-pa=s2]');
  await pg.check('[data-pa=s2] input[value="business.close"]'); await pg.uncheck('[data-pa=s2] input[value="people.reset_2fa"]'); await pg.click('#paSave'); await pg.waitForTimeout(300);
  console.log('Help Desk role:', await pg.$eval('#paStatus', (x) => x.textContent.replace(/\s+/g, ' ').trim()));
  await as('Help Desk (Support)');
  console.log('Help Desk tabs:', await pg.evaluate(() => [...document.querySelectorAll('.snav .nv')].map((x) => x.textContent.replace(/\d+$/, '')).join(', ')));
  await tab('companies'); await pg.selectOption('#sf select', 'all'); await open('sample plumbing', 'w1');
  console.log('Help Desk tools:', await pg.evaluate(() => [...document.querySelectorAll('[data-fix]')].map((x) => x.textContent.trim()).join(', ')));
  await cptab('people'); console.log('reset 2FA buttons:', await pg.evaluate(() => document.querySelectorAll('[data-r2fa]').length));
  await pg.click('#cpBack'); await as('Sam (Owner)');
  await tab('team'); console.log('settings:', await pg.evaluate(() => [...document.querySelectorAll('#setf input')].map((i) => i.name + '=' + i.value).join(', ')));
  await pg.screenshot({ path: out + '/hq-team.png', fullPage: true });

  // --- Inactive accounts, Emails
  await tab('inactive'); await pg.waitForSelector('#ready');
  console.log('inactive:', await pg.evaluate(() => [...document.querySelectorAll('.card h3')].map((h) => h.innerText.replace(/\s+/g, ' ') + ': ' + [...h.parentElement.querySelectorAll('tr td b')].map((x) => x.textContent).join(', ')).join(' || ')));
  await pg.check('#rm input[name=id]'); await fill('#rm [name=reason]', 'Closed 2 years, owner\'s rule'); await pg.click('#rm .btn.p'); await pg.waitForSelector('.flash');
  console.log('removal:', await pg.evaluate(() => [...document.querySelectorAll('.flash')].pop().textContent));
  await pg.screenshot({ path: out + '/hq-inactive.png' });
  await tab('emails'); console.log('emails tiles:', await pg.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => t.innerText.replace(/\n/g, ' | '))));
  await pg.click('[data-resend="3"]'); await pg.waitForTimeout(300); console.log('after send again, held/failed:', await pg.evaluate(() => document.querySelectorAll('[data-resend]').length));
  await pg.screenshot({ path: out + '/hq-emails.png' });

  // --- History: filters and CSV
  await tab('history'); await pg.waitForSelector('#hf');
  await pg.selectOption('#hf [name=action]', 'refund.'); await pg.click('#hf .btn.p'); await pg.waitForTimeout(300);
  console.log('history (refunds):', await pg.evaluate(() => [...document.querySelectorAll('#hl tr')].slice(1).map((r) => r.cells[1].textContent + ': ' + r.cells[2].innerText.replace(/\s+/g, ' ')).join(' || ')));
  await pg.selectOption('#hf [name=action]', ''); await pg.selectOption('#hf [name=who]', { label: 'Finance Fi' }); await pg.click('#hf .btn.p'); await pg.waitForTimeout(300);
  console.log('history (Finance Fi):', await pg.evaluate(() => document.querySelectorAll('#hl tr').length - 1), 'rows');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#csv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8'); console.log('CSV:', dl.suggestedFilename(), '|', csv.split('\r\n').length - 1, 'rows | header:', csv.split('\r\n')[0].replace(/^﻿/, ''));
  await pg.selectOption('#hf [name=who]', ''); await pg.click('#hf .btn.p'); await pg.waitForTimeout(300);
  console.log('download is logged:', await pg.evaluate(() => [...document.querySelectorAll('#hl tr td:nth-child(3)')].some((x) => x.textContent.includes('downloaded the HQ history'))));
  await pg.screenshot({ path: out + '/hq-history.png' });

  // --- phone widths: no sideways scrolling on the new screens
  const ph = await (await b.newContext({ ...devices['iPhone 13'] })).newPage(); ph.on('pageerror', (e) => errs.push('phone: ' + e.message)); ph.on('dialog', (d) => d.accept());
  await ph.goto(BASE + '/hq/?demo'); await ph.waitForSelector('.tiles'); const over = {};
  // on a phone the pages are in the Menu
  const pick = async (k) => { await ph.click('#mnav'); await ph.click(`#mmenu [data-tab=${k}]`); await ph.waitForTimeout(350); };
  for (const k of ['support', 'refunds', 'approvals', 'inactive', 'emails', 'team', 'history']) { await pick(k); over[k] = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth); }
  await pick('support'); await ph.waitForSelector('.tk'); await ph.click('.tk'); await ph.waitForSelector('.tview'); over.ticket = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await ph.screenshot({ path: out + '/hq-support-phone.png' });
  await pick('companies'); await ph.waitForSelector('tr[data-co]'); await ph.fill('#sf input', 'sample plumbing'); await ph.click('#sf button'); await ph.waitForSelector('tr[data-co="w1"]');
  await ph.click('tr[data-co="w1"]'); await ph.waitForSelector('.cpage'); await ph.waitForTimeout(300); over.customer_page = await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log('phone overflow:', JSON.stringify(over));

  // --- before team-chat.sql is re-run: the new screens say how to switch them on
  const p3 = await b.newPage(); p3.on('pageerror', (e) => errs.push('old db: ' + e.message));
  await p3.route('**/link/config.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.RIYESER_TEAM={supabaseUrl:"https://fake.supabase.test",supabaseKey:"k"};' }));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const user = { id: 'u1', email: 'sam@riyeser.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] };
  const tok = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
  await p3.addInitScript((t) => localStorage.setItem('riyeser.hq.session', JSON.stringify({ access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: 'u1', email: 'sam@riyeser.test', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] } })), tok);
  const OLD = ['hq_me', 'hq_overview', 'hq_companies', 'hq_staff_list', 'hq_history', 'hq_downloads', 'hq_licences'];
  await p3.route('https://fake.supabase.test/**', (r) => { const u = new URL(r.request().url()); const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/user') return json(user);
    if (fn === 'hq_me') return json({ role: 'owner', name: 'Sam', active: true, two_step: true });
    if (fn === 'hq_overview') return json({ companies: 1, versions: [], countries: [], signups_by_week: [], trials_ending: [] });
    if (fn === 'hq_staff_list') return json([{ user_id: 'u1', display_name: 'Sam', role: 'owner', active: true, email: 'sam@riyeser.test', added_at: new Date().toISOString() }]);
    if (u.pathname.startsWith('/rest/v1/rpc/') && !OLD.includes(fn)) return json({ code: 'PGRST202', message: `Could not find the function public.${fn}` }, 404);
    return json([]); });
  await p3.goto(BASE + '/hq/'); await p3.waitForSelector('.tiles', { timeout: 15000 });
  console.log('old database tabs:', await p3.evaluate(() => [...document.querySelectorAll('.snav .nv')].map((x) => x.textContent.replace(/\d+$/, '')).join(', ')));
  await p3.click('[data-tab=support]'); await p3.waitForTimeout(500); console.log('old database Support:', (await p3.textContent('#main')).trim());
  await p3.click('[data-tab=team]'); await p3.waitForTimeout(500); console.log('old database HQ team still works:', await p3.evaluate(() => [...document.querySelectorAll('#staff b')].map((x) => x.textContent)));
  console.log('errors:', errs); await b.close();
})();
