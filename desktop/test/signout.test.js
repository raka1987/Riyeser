// Central's "Sign out", demo mode only on purpose, and the sign-in form's extras (Forgot password, remembered email).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const on = require('../src/core/online');
const licence = require('../src/core/licence');
const ui = require('../src/renderer/demo-ui');
const { Store } = require('../src/core/store');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'so-'));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// A pretend Riyeser Online (no network).
function fake({ members, recoverStatus = 200 } = {}) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ path: u.pathname, query: u.search, body, headers: opts.headers || {} });
    if (u.href.startsWith(on.CONFIG_URL)) return res(200, 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"sb_publishable_k"};');
    if (u.pathname === '/auth/v1/token') return body.password === 'right-password'
      ? res(200, { access_token: 'tok', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: body.email, user_metadata: {} } }) : res(400, { error_description: 'Invalid login credentials' });
    if (u.pathname === '/auth/v1/recover') return res(recoverStatus, recoverStatus < 300 ? {} : { msg: 'User not found' });
    if (u.pathname === '/rest/v1/members') return res(200, members());
    if (u.pathname === '/rest/v1/rpc/company_licence') return res(200, { company_code: 'RIY-SAMP-01', modules: { pos: { active: true, paid_until: '2027-01-31' } } });
    if (u.pathname === '/rest/v1/rpc/link_device') return res(200, '');
    return res(404, { message: 'not found' });
  };
  return { fetchFn, calls };
}
const wsRow = (id, name, code, extra = {}) => ({ role: 'owner', display_name: 'Alex Sample', workspaces: { id, name, company_code: code, legal_name: '', tax_number: '', address: '1 Old Rd', phone: '', email: '', country: 'Fiji', ...extra } });
function make(opts) {
  const dir = tmp(); let list = [wsRow('w5', 'Sample Trading Co', 'RIY-SAMP-01')];
  const srv = fake({ members: () => list, ...opts });
  const store = new Store(path.join(dir, 'data'));
  const o = new on.Online({ store, fetchFn: srv.fetchFn, appData: dir });
  return { dir, srv, o, store, setMembers: (l) => { list = l; } };
}

test('sign out: company.json and the online licence are put away (renamed, never deleted); the PC reads as not linked', async () => {
  const { dir, o, store } = make();
  await o.signIn('alex@sample.example', 'right-password');
  await o.afterSignIn();
  assert.equal(on.readCompany(dir).name, 'Sample Trading Co');
  assert.ok(licence.read(dir).online);
  licence.ensureTrial(dir); const trialStart = licence.read(dir).trialStart;
  store.update('company-setup', {}, (x) => ({ ...(x || {}), pendingJoin: { workspace_id: 'w9', company_name: 'Other' } }));
  // an older signed-out copy is fine to overwrite
  fs.writeFileSync(path.join(dir, 'Riyeser', 'company.signed-out.json'), '{"name":"Older"}');

  const r = o.signOutOfPC();
  assert.equal(o.session, null);
  assert.equal(on.readCompany(dir), null);                                     // no company on this PC now
  assert.equal(fs.existsSync(on.companyFile(dir)), false);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'Riyeser', 'company.signed-out.json'), 'utf8'));
  assert.equal(kept.name, 'Sample Trading Co'); assert.equal(kept.company_code, 'RIY-SAMP-01');   // renamed, not deleted
  assert.equal(r.company, path.join(dir, 'Riyeser', 'company.signed-out.json')); assert.equal(r.licence, true);
  const lic = licence.read(dir);
  assert.equal(lic.online, undefined);                                         // programs see no business plan
  assert.equal(lic.online_signed_out.modules.pos.active, true);                // kept aside
  assert.ok(lic.online_signed_out.signed_out_at);
  assert.equal(lic.trialStart, trialStart);                                    // the rest of licence.json as it was
  assert.equal(licence.onlinePlan(dir), null); assert.equal(licence.status(dir).online, undefined);
  const setup = store.get('company-setup', {});
  assert.equal(setup.pendingJoin, null); assert.equal(setup.signedOut, true);
  assert.equal(await o.stillLinked(), null); assert.equal(await o.refreshLicence(), null);   // nothing to check while signed out
});

test('sign out: a business set up on this PC only (no account) is left alone', () => {
  const { dir, o } = make();
  o.setupLocal({ name: 'Corner Cafe', country: 'Fiji' }, 'Kim');
  o.signOutOfPC();
  assert.equal(on.readCompany(dir).name, 'Corner Cafe');
});

test('sign in again after signing out: company.json is written fresh from Riyeser online, the old one never comes back', async () => {
  const { dir, o, store, setMembers } = make();
  await o.signIn('alex@sample.example', 'right-password'); await o.afterSignIn();
  o.signOutOfPC();
  setMembers([wsRow('w5', 'Sample Trading Co', 'RIY-SAMP-01', { address: '2 New St' })]);
  await o.signIn('alex@sample.example', 'right-password');
  const r = await o.afterSignIn();
  assert.equal(r.status, 'linked');
  const c = on.readCompany(dir);
  assert.equal(c.address, '2 New St'); assert.equal(c.workspace_id, 'w5');
  assert.ok(licence.read(dir).online);                                         // plan fetched again
  assert.equal(store.get('company-setup', {}).signedOut, false);
  // the put-away copy is still there, untouched
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Riyeser', 'company.signed-out.json'), 'utf8')).address, '1 Old Rd');
});

test('signed out: Central reports no company, and never shows the first-run "How would you like to start?"', () => {
  assert.equal(ui.firstScreen({ company: null, skipped: false, signedOut: true }, { on: false }), 'signedout');
  assert.equal(ui.firstScreen({ company: null, skipped: false, signedOut: true }, null), 'signedout');
  assert.equal(ui.firstScreen({ company: null, skipped: false }, null), 'start');   // a PC never set up still gets it
  // main: "never set up" (which offers the set-up after leaving demo mode) is false once signed out
  assert.match(src('central-main.js'), /neverSetUp = \(\) => \{[^\n]*!setup\.signedOut/);
  assert.match(src('central-main.js'), /signedOut: !!setup\.signedOut && !s/);
  const company = src('renderer/company.js');
  assert.match(company, /You're signed out\./);
  assert.match(company, /Sign in with your Riyeser account to see your business on this PC\./);
  assert.match(company, /first === 'signedout'/);
  // the signed-out Company page shows nothing of the old business
  const out = company.slice(company.indexOf('if (!c && s.signedOut)'), company.indexOf('if (!c) {'));
  assert.doesNotMatch(out, /company_code|c\.name|coid|data-w="copy"|data-w="restart"/);
});

test('demo mode: only starts when the person confirmed it; signing out never starts it', () => {
  assert.equal(ui.startAllowed(undefined), false);
  assert.equal(ui.startAllowed({}), false);
  assert.equal(ui.startAllowed({ confirmed: 'yes' }), false);
  assert.equal(ui.startAllowed({ confirmed: true }), true);
  assert.equal(ui.TEXT.confirmTitle, 'Turn on demo mode?');
  assert.equal(ui.TEXT.confirmBody, 'Every Riyeser program opens with made-up practice data for Sample Trading Co. Your own records stay separate. You can leave any time from the yellow banner.');
  assert.equal(ui.TEXT.confirmOk, 'Turn on demo mode');
  const main = src('central-main.js');
  assert.match(main, /handle\('demo:start', \(opts\) => \{\s*if \(!demoUi\.startAllowed\(opts\)\) throw/);
  const central = src('renderer/central.js');
  assert.match(central, /askConfirm\(\{ title: T\.confirmTitle/);
  assert.equal((central.match(/bridge\.call\('demo:start'/g) || []).length, 1);
  assert.match(central, /bridge\.call\('demo:start', \{ confirmed: true \}\)/);
  assert.doesNotMatch(src('renderer/company.js'), /demo:start/);              // the wizard goes through startDemo (and its question)
  const signOut = src('renderer/company.js').match(/async function signOut\(\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(signOut, /demo|showStart/);
  // the first-run step: Start blank is the big choice, demo a smaller one under it
  const html = ui.startHtml();
  assert.ok(html.indexOf('data-w="blank"') < html.indexOf('data-w="demo"'));
  assert.match(html, /class="wbig wmain wprimary" data-w="blank"/);
  assert.match(html, /class="wbig wsm" data-w="demo"/);
});

test('forgot password: POST /auth/v1/recover with just the email and the key, back to riyeser.com/link/; same answer either way', async () => {
  const { srv, o } = make();
  assert.equal(await o.recover(' alex@sample.example '), true);
  const c = srv.calls.find((x) => x.path === '/auth/v1/recover');
  assert.deepEqual(c.body, { email: 'alex@sample.example' });
  assert.equal(c.headers.apikey, 'sb_publishable_k');
  assert.equal(c.headers.Authorization, undefined);
  assert.equal(new URLSearchParams(c.query).get('redirect_to'), 'https://riyeser.com/link/');
  const nobody = make({ recoverStatus: 400 });
  assert.equal(await nobody.o.recover('nobody@sample.example'), true);       // doesn't say whether the account exists
  await assert.rejects(o.recover('not an email'), /Enter the email/);
  const offline = new on.Online({ store: new Store(path.join(tmp(), 'd')), appData: tmp(), fetchFn: async (u) => {
    if (String(u).startsWith(on.CONFIG_URL)) return { ok: true, status: 200, text: async () => 'window.RIYESER_TEAM={supabaseUrl:"https://x.supabase.co",supabaseKey:"k"};' };
    throw new Error('ENOTFOUND'); } });
  await assert.rejects(offline.recover('alex@sample.example'), /^Error: Can't reach Riyeser\. Check your internet and try again\.$/);
  const company = src('renderer/company.js');
  assert.match(company, /If that email has a Riyeser account, we've sent a link to reset the password\. Open it, choose a new password, then sign in here\./);
});

test('sign in: the email is remembered for next time, the password never is; plain messages', async () => {
  const { dir, o } = make();
  assert.equal(o.lastEmail(), '');
  await assert.rejects(o.signIn('alex@sample.example', 'wrong-password'), /^Error: That email or password isn't right\.$/);
  assert.equal(o.lastEmail(), 'alex@sample.example');
  await o.signIn('alex@sample.example', 'right-password');
  // nothing on disk holds the password
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes('right-password') && !t.includes('wrong-password'), `password found in ${f}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'last-email.json'), 'utf8')), { email: 'alex@sample.example' });
  assert.match(src('core/online.js'), /Please confirm your email first: open the link we emailed you, then sign in\./);
  // the form: eye button, autocomplete hints, confirm password, Caps Lock
  const company = src('renderer/company.js');
  assert.match(company, /aria-label="Show password"/); assert.match(company, /'Hide password' : 'Show password'/);
  assert.match(company, /autocomplete="username"/); assert.match(company, /'new-password' : 'current-password'/);
  assert.match(company, /pwField\('password2'/); assert.match(company, /The two passwords don\\?'t match/);
  assert.match(company, /Caps Lock is on/);
  assert.match(company, /Forgot password\?/);
});
