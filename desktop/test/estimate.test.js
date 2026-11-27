// Riyeser Estimate in Riyeser Central: a program it installs, updates and opens; its licence module 'estimate' is free
// for 90 days from first use, with no price yet ("price to be announced").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const licence = require('../src/core/licence');
const prices = require('../src/core/prices');
const updates = require('../src/central/updates');
const checklist = require('../src/central/checklist');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const plan = (estimate) => ({ workspace_id: 'w1', company_code: 'RIY-7K3M-Q2', checked_at: '2026-11-24T12:00:00Z',
  modules: { basic: { status: 'trial', active: true, trial_ends: '2027-01-03', paid_until: null, days_left: 40 }, estimate },
  seats: { included: 3, extra: 0, used: 1 }, extra_companies: 0, billing: 'monthly', early_bird: false });
const NOT_STARTED = { status: 'trial', active: true, trial_ends: null, paid_until: null, days_left: 90, starts_on_first_use: true };

test('estimate: Central updates and installs it from the release', () => {
  const p = updates.PRODUCTS.find((x) => x.id === 'estimate');
  assert.ok(p, 'in the update list'); assert.equal(p.asset, 'RiyeserEstimate-Setup.exe'); assert.equal(p.display, 'Riyeser Estimate');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'central-main.js'), 'utf8');
  assert.match(src, /id: 'estimate', name: 'Estimate', full: 'Riyeser Estimate'/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'logos', 'estimate.png')), 'its logo');
});

test('estimate: no price yet, and its plan line before and after first use', () => {
  assert.equal(prices.PRICE.estimate, undefined);
  assert.equal(prices.monthly('estimate'), 'price to be announced');
  assert.match(licence.lockedText('estimate'), /Riyeser Estimate.*price to be announced/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-'));
  licence.saveOnline(dir, plan(NOT_STARTED), NOW);
  let row = licence.onlinePlan(dir, NOW).rows.find((r) => r.id === 'estimate');
  assert.equal(row.line, 'Riyeser Estimate: free for 90 days from first use');
  licence.saveOnline(dir, plan({ status: 'trial', active: true, trial_ends: '2026-12-04', paid_until: null, days_left: 10 }), NOW);
  row = licence.onlinePlan(dir, NOW).rows.find((r) => r.id === 'estimate');
  assert.equal(row.line, 'Riyeser Estimate: free trial, 10 days left');
});

test('estimate: "your plan includes" only once the business has used it', () => {
  const lic = (e) => ({ online: { modules: { basic: plan().modules.basic, estimate: e } } });
  assert.ok(!checklist.planModules(lic(NOT_STARTED)).includes('estimate'));
  assert.ok(checklist.planModules(lic({ status: 'trial', active: true, trial_ends: '2027-02-01', days_left: 60 })).includes('estimate'));
});
