// The "Online connections" help guide (website/help.mjs → help/online.html): how it works with the diagram (website →
// Riyeser Online post box → your sync PC → your programs, and back), the five set-up steps, where to paste the code in
// common site builders, the self-ticking checklist, Send a test, the panel's states, the activity trail and problems.
// Run: node website/team/test/online-help-test.js (after node website/build-combined.mjs, it checks the built page too).
const assert = require('assert');
const fs = require('fs'); const path = require('path');
(async () => {
  const { helpGuides } = await import(path.join(__dirname, '..', '..', 'help.mjs'));
  const g = helpGuides({ EMAIL: 'help@riyeser.com', SERVICES_APP: '', up: '/' }).find((x) => x.id === 'online');
  assert.ok(g, 'there is an Online connections guide');
  const items = Object.fromEntries(g.groups.flatMap((x) => x.items).map(([id, q, a]) => [id, { q, a }]));
  for (const id of ['how', 'which-pc', 'setup', 'paste', 'checklist', 'test', 'panel', 'activity', 'problem', 'nothing-arrives']) assert.ok(items[id], `answer ${id}`);
  const how = items.how.a;
  assert.match(how, /<svg[^>]*role="img"/); assert.match(how, /<title id="hflow-t">/);
  for (const w of ['Your website', 'Riyeser Online', 'Your sync PC', 'Your programs', 'prices, stock, free times']) assert.ok(how.includes(w), `diagram: ${w}`);
  const setup = items.setup.a;
  assert.strictEqual((setup.match(/<li>/g) || []).length, 5, 'five steps');
  for (const w of ['Choose what you want', 'Make the key', 'Management → Connections', 'Copy the code into your website', 'Send a test', 'Done ✓']) assert.ok(setup.includes(w), `setup: ${w}`);
  for (const w of ['WordPress', 'Wix', 'Squarespace', 'Shopify', 'Plain HTML']) assert.ok(items.paste.a.includes(w), `paste: ${w}`);
  assert.match(items.checklist.a, /ticks itself from what really happened/);
  assert.match(items.checklist.a, /aren\'t set up<\/b> in grey/);
  assert.match(items.test.a, /no booking, invoice, customer or stock change is kept/);
  assert.match(items.activity.a, /Export CSV/); assert.match(items.activity.a, /90 days/);
  assert.match(items.problem.a, /Get help/); assert.match(items.problem.a, /OA-/);
  // plain English: no "API" jargon in the owner-facing steps beyond the key's name
  assert.doesNotMatch(setup, /endpoint|JSON|HTTP/);
  const bookings = helpGuides({ EMAIL: 'x', SERVICES_APP: '', up: '/' }).find((x) => x.id === 'bookings');
  assert.match(bookings.groups.flatMap((x) => x.items).find((x) => x[0] === 'online')[2], /help\/online\.html#setup/);
  const built = path.join(__dirname, '..', '..', 'public', 'help', 'online.html');
  if (fs.existsSync(built)) {
    const h = fs.readFileSync(built, 'utf8');
    for (const id of ['how', 'setup', 'paste', 'checklist', 'test', 'activity', 'problem']) assert.ok(h.includes(`id="${id}"`), `built page anchor #${id}`);
    assert.ok(h.includes('hflow-t'), 'built page has the diagram');
  } else console.log('(site not built: built page not checked)');
  console.log('ONLINE HELP TESTS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
