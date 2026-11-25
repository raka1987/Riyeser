// Desk Assistant: M8 (first start), M25 (email sorting), M26 (the AI model it uses).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const { categorise } = require('../src/core/email');
const ai = require('../src/core/ai');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const settings = { companies: [{ name: 'Coastal Cafe', type: 'Clients' }], ownCompanyNames: ['Sample Plumbing'] };

// ---------- M25 ----------
test('M25: an email from coastalcafe.com.fj is the known customer "Coastal Cafe", not "Coastalcafe"', () => {
  const r = categorise({ from: 'Mere <mere@coastalcafe.com.fj>', subject: 'Hello', text: 'Hi there, thanks for last week.' }, settings);
  assert.strictEqual(r.company, 'Coastal Cafe');
});
test('M25: a supplier\'s invoice ("Please find attached…") isn\'t "needs reply"; a real question still is', () => {
  const inv = categorise({ from: 'accounts@pipesupplies.com.au', subject: 'Invoice INV-2201',
    text: 'Please find attached invoice INV-2201 for $540.00. Tax invoice. Total due $540.00 by 30 November. Please let me know if you have any questions.' }, settings);
  assert.strictEqual(inv.category, 'Invoices & Bills');
  assert.strictEqual(inv.needsReply, false);
  const st = categorise({ from: 'statements@pipesupplies.com.au', subject: 'Your statement', text: 'Statement of account. Opening balance $0.00. Closing balance $540.00. Please let me know if anything looks wrong.' }, settings);
  assert.strictEqual(st.needsReply, false);
  const q = categorise({ from: 'Mere <mere@coastalcafe.com.fj>', subject: 'Quick question', text: 'Are you free next week?' }, settings);
  assert.strictEqual(q.needsReply, true);
});
test('M25: "could you come Thursday to fix the leaking pipe?" makes a to-do (due Thursday)', () => {
  const r = categorise({ from: 'Mere <mere@coastalcafe.com.fj>', subject: 'Leak in the kitchen', text: 'Hi, could you come Thursday to fix the leaking pipe? Thanks, Mere' }, settings);
  assert.strictEqual(r.actionItems.length, 1);
  assert.match(r.actionItems[0].text, /come Thursday to fix the leaking pipe/i);
  assert.strictEqual(r.actionItems[0].due, 'Thursday');
  assert.strictEqual(r.needsReply, true);
});
test('M25: a lookalike bank email gets "check the sender", not "urgent"; the real bank doesn\'t', () => {
  const fake = categorise({ from: 'BSP Security <security@bsp-verify-login.xyz>', subject: 'Your account is locked',
    text: 'Your account is locked. Urgent: verify your details immediately by clicking here.' }, settings);
  assert.match(fake.warning, /^Check the sender: bsp-verify-login\.xyz/);
  assert.strictEqual(fake.urgent, false);
  assert.strictEqual(fake.needsReply, false);
  assert.deepStrictEqual(fake.actionItems, []);
  const real = categorise({ from: 'BSP <statements@bsp.com.fj>', subject: 'Your statement is ready', text: 'Your November statement is ready in internet banking.' }, settings);
  assert.strictEqual(real.warning, null);
  // a known company's name in someone else's domain
  const copy = categorise({ from: 'billing@coastalcafe-payments.top', subject: 'Update your payment details', text: 'Please update your payment details today.' }, settings);
  assert.ok(copy.warning);
  assert.match(src('renderer/app.js'), /check the sender/);
});

// ---------- M26 ----------
test('M26: sorting uses the smallest, cheapest model unless people choose another', async () => {
  assert.strictEqual(ai.DEFAULT_MODEL, 'claude-haiku-5-5');
  assert.deepStrictEqual(ai.MODELS.map((m) => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.strictEqual(ai.pickModel('something-old'), 'claude-haiku-5-5');
  const h = ai.request(undefined, 'sys', 'text');
  assert.strictEqual(h.model, 'claude-haiku-5-5'); assert.strictEqual(h.betas, undefined); assert.strictEqual(h.fallbacks, undefined);
  assert.strictEqual(h.output_config.effort, 'low');
  const o = ai.request('claude-opus-5-5', 'sys', 'text');
  assert.deepStrictEqual([o.model, o.fallbacks, o.betas], ['claude-opus-5-5', 'default', ['server-side-fallback-2026-07-01']]);
  // what goes out for a file, with the default
  const sent = [];
  const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ docType: 'Invoices', company: 'Coastal Cafe', companyType: 'Clients', confident: true, reason: 'An invoice.', title: '', date: null }) }] };
  const client = { messages: { create: async (p) => { sent.push(['messages', p]); return reply; } }, beta: { messages: { create: async (p) => { sent.push(['beta', p]); return reply; } } } };
  const r = await ai.createAI(null, undefined, { client }).classify('a.pdf', 'Tax invoice', settings);
  assert.strictEqual(r.docType, 'Invoices');
  assert.deepStrictEqual(sent.map(([w, p]) => [w, p.model]), [['messages', 'claude-haiku-5-5']]);
  // main.js: the default, earlier saved defaults moved over, and a choice in Settings
  assert.match(src('main.js'), /aiModel: AI_DEFAULT/);
  assert.match(src('main.js'), /if \(!s\.aiModelChosen\) s\.aiModel = AI_DEFAULT/);
  assert.match(src('renderer/app.js'), /id="aimodel"/);
  assert.match(src('renderer/app.js'), /aiModelChosen: true/);
});

// ---------- M8 ----------
test('M8: a "Getting things ready…" screen on first start, and the slow libraries load only when needed', () => {
  const main = src('main.js');
  const ready = main.indexOf('app.whenReady()');
  assert.ok(main.indexOf('showSplash()', ready) > ready && main.indexOf('showSplash()', ready) < main.indexOf('new Store(', ready), 'splash before the set-up');
  assert.match(main, /once\('ready-to-show', \(\) => \{ mainWin\.show\(\); closeSplash\(\); \}\)/);
  assert.match(src('renderer/splash.html'), /Getting things ready…/);
  assert.match(src('renderer/index.html'), /<main id="page"><div class="ready-note"[^>]*><b>Getting things ready…<\/b>/);
  const loaded = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'email.js'))}); require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'ai.js'))});
    console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /node_modules[\\\\/](imapflow|mailparser|@anthropic-ai)/.test(k)).length))`], { encoding: 'utf8' });
  assert.strictEqual(loaded.trim(), '0');
});
test('M8: no "Move 0 to Recycle Bin" when nothing is selected', () => {
  const app = src('renderer/app.js');
  assert.match(app, /data-act="cleantrash" \$\{cleanSel\.size \? '' : 'disabled hidden'\}/);
  assert.match(app, /btn\.hidden = !cleanSel\.size/);
});
