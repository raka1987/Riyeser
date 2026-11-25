// F3 (Central part) and S12: one price list, and the licence window signs in instead of asking for a key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { pathToFileURL } = require('url');
const prices = require('../src/core/prices');
const licence = require('../src/core/licence');
const LUI = require('../src/renderer/licence-ui');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('F3: the desktop price list is riyeser.com\'s (website/prices.mjs), every price and the order', async () => {
  const web = await import(pathToFileURL(path.join(__dirname, '..', '..', 'website', 'prices.mjs')).href);
  assert.deepStrictEqual({ ...prices.PRICE }, { ...web.PRICE });
  assert.deepStrictEqual(prices.PAID, web.PAID);
  for (const [id] of prices.PAID) assert.strictEqual(prices.usd(prices.PRICE[id]), web.usd(web.PRICE[id]));
});

test('F3: Central\'s licence window, cards and messages carry no prices of their own (no old "$20")', () => {
  for (const f of ['renderer/central.js', 'renderer/company.js', 'renderer/licence-ui.js', 'central-main.js', 'core/licence.js', 'link/licence.js']) {
    const text = src(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(text, /(US)?\$\s?\d/, `${f} has a price written in it`);
  }
  // every price the window shows comes from the list
  const s = prices.summary();
  for (const [id, name] of prices.PAID) assert.ok(s.includes(`${name} US$${prices.PRICE[id]}`), `${name} in the summary`);
  assert.ok(s.includes(`each extra user is US$${prices.PRICE.extra_user}`));
  assert.ok(s.includes(`Extra companies in Accounting: US$${prices.PRICE.extra_company}`));
  assert.strictEqual(licence.MODULE_PRICES.plus, `US$${prices.PRICE.plus}/month`);
  assert.match(LUI.linkText(prices.forWindow()), new RegExp(`US\\$${prices.PRICE.calls}/month`));
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  assert.deepStrictEqual(licence.status(a).prices, prices.forWindow());   // sent to the window with the licence status
});

test('S12: no licence key box; the window says "Sign in to your Riyeser account to unlock your plan"', () => {
  const c = src('renderer/central.js');
  assert.doesNotMatch(c, /lickey|receipt email|licenceActivate|Turn on licence/);
  assert.doesNotMatch(src('central-main.js'), /central:licenceActivate/);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = LUI.signInHtml({ prices: prices.forWindow() }, esc, false);
  assert.match(html, /Sign in to your Riyeser account to unlock your plan/);
  assert.match(html, /data-lic="signin"/);
  assert.doesNotMatch(html, /<input/);
  assert.ok(src('renderer/central.html').indexOf('licence-ui.js') < src('renderer/central.html').indexOf('central.js'));
});

test('S12: program cards say where each paid program really stands', () => {
  // the company's plan from Riyeser online
  const plan = { online: { rows: [
    { id: 'basic', text: 'paid until 30 Jun 2027', tone: 'ok' },
    { id: 'payroll', text: 'trial ended — contact Riyeser', tone: 'bad' },
    { id: 'pos', text: 'free trial, 12 days left', tone: 'warn' },
  ] } };
  assert.deepStrictEqual([LUI.programStatus('accounting-basics', plan).text, LUI.programStatus('accounting-basics', plan).alert], ['Paid until 30 Jun 2027', false]);
  assert.deepStrictEqual([LUI.programStatus('payroll', plan).text, LUI.programStatus('payroll', plan).alert], ['Trial ended — contact Riyeser', true]);
  assert.strictEqual(LUI.programStatus('pos', plan).text, 'Free trial, 12 days left');
  assert.deepStrictEqual([LUI.programStatus('accounting', plan).text, LUI.programStatus('accounting', plan).alert], ['Not on your plan', true]);
  // no plan: the local 90-day trial
  assert.strictEqual(LUI.programStatus('accounting', { mode: 'trial', daysLeft: 40 }).text, 'Free trial, 40 days left');
  const ended = LUI.programStatus('accounting', { mode: 'expired' });
  assert.ok(ended.alert); assert.match(ended.text, /sign in to unlock your plan/);
  assert.doesNotMatch(ended.text, /Included in your licence/);
  // free programs have no plan line
  for (const id of ['invoices', 'desk', 'pdf', 'central']) assert.strictEqual(LUI.programStatus(id, plan), null);
  assert.strictEqual(LUI.programStatus('team', plan).module, 'calls');   // Riyeser Link is a paid program (pricing v2)
  // nothing says "Included in your licence" (it sat under "Licence needed")
  assert.doesNotMatch(src('central-main.js'), /Included in your licence/);
});
