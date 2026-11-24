// Riyeser Central: the company this PC belongs to.
// First run: a full-window wizard to set up a new company, join an existing one (an admin approves it, like a friend
// request), or set this PC up on its own. Afterwards, the Company page shows the profile and Company ID.
// The profile is saved in %APPDATA%\Riyeser\company.json, so every Riyeser program fills in the company details itself.
/* global $, esc, bridge, toast, safe, setView, renderNav */
const CO = { first: false, list: null, details: null, state: null, mode: null, screen: 'choice', create: false, poll: null, busy: false, err: '', note: '', last: null };
const COUNTRIES = ['Fiji', 'Australia', 'New Zealand', 'Samoa', 'Tonga', 'Vanuatu', 'Papua New Guinea', 'Solomon Islands', 'Other'];
const field = (n, label, v = '', extra = '') => `<label class="wf"><span>${label}</span><input name="${n}" value="${esc(v)}" ${extra}></label>`;
const profileFields = (p = {}) => `<div class="wgrid">
  ${field('name', 'Company or trading name', p.name, 'required maxlength="120" autocomplete="organization"')}
  ${field('legal_name', 'Legal name (if different)', p.legal_name, 'maxlength="160"')}
  ${field('tax_number', 'ABN / TIN / tax number', p.tax_number, 'maxlength="40"')}
  <label class="wf"><span>Country</span><select name="country">${COUNTRIES.map((c) => `<option${(p.country || 'Fiji') === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
  <label class="wf wide"><span>Address</span><input name="address" value="${esc(p.address || '')}" maxlength="240" autocomplete="street-address"></label>
  ${field('phone', 'Phone', p.phone, 'maxlength="40" autocomplete="tel"')}
  ${field('email', 'Business email', p.email, 'type="email" maxlength="120" autocomplete="email"')}
</div>`;
const formData = (f) => Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, String(v).trim()]));

async function coLoad() { CO.state = await bridge.call('company:get'); return CO.state; }

// ---------------------------------------------------------------- the wizard
function wiz(html) {
  const w = $('#wizard'); w.hidden = false;
  w.innerHTML = `<div class="wcard"><div class="wlogo"><img src="logo-r.png" alt="">Riyeser</div>${CO.err ? `<div class="werr">${esc(CO.err)}</div>` : ''}${CO.note ? `<div class="wok">${esc(CO.note)}</div>` : ''}${html}</div>`;
  CO.err = ''; CO.note = '';
  const first = w.querySelector('input:not([type=hidden]), button.wbig'); if (first) first.focus();
}
function closeWizard() { $('#wizard').hidden = true; $('#wizard').innerHTML = ''; clearInterval(CO.poll); CO.poll = null; }
const offlineNote = () => (CO.state && !CO.state.onlineReady
  ? '<p class="wnote">Signing in with a Riyeser account is being switched on. Set up this PC without an account for now, and sign in later from <b>Company</b>.</p>' : '');

// The first step the first time: start blank (the normal set-up) or explore with demo data (Sample Trading Co).
// Demo mode writes only demo.json: no company.json, so nothing is linked to a real online company.
function showStart() {
  CO.screen = 'start';
  wiz(window.RiyeserDemo.startHtml());
}

// "Start blank": sign in with the same Riyeser account as riyeser.com, and Central fills everything in from it.
function showChoice() {
  CO.screen = 'choice';
  const on = CO.state.onlineReady;
  wiz(`<h1>Set up Riyeser on this PC</h1><p class="wsub">Sign in once and every Riyeser program on this PC gets your business details, so you never type them again.</p>
    <button class="wbig wmain" data-w="signin"${on ? '' : ' disabled'}><span class="wi">🔑</span><b>Sign in with your Riyeser account</b><small>Use the same email and password as riyeser.com.</small></button>
    <p class="wfoot wtight">Don't have one? <button class="wlink" data-w="signup"${on ? '' : ' disabled'}>Create a free account</button></p>
    <div class="wchoices two wsmallrow">
      <button class="wbig wsm" data-w="join"${on ? '' : ' disabled'}><span class="wi">🤝</span><b>Join with a code</b><small>Someone's business already uses Riyeser. Enter its Company ID or branch code, and they approve you.</small></button>
      <button class="wbig wsm" data-w="local"><span class="wi">💻</span><b>Set up this PC without an account</b><small>Type your business details on this PC only. You can sign in later.</small></button>
    </div>${offlineNote()}
    <p class="wfoot">${CO.first ? '<button class="wlink" data-w="start">Back</button> · ' : ''}<button class="wlink" data-w="later">Set up later</button></p>`);
}

// next: 'signin' (then the account's business is found) or 'join' (then the code form)
function showAccount(next) {
  CO.mode = next; CO.screen = 'account';
  if (CO.state.signedIn) return next === 'join' ? showJoinForm() : findBusiness();
  wiz(`<h1>${CO.create ? 'Create your free Riyeser account' : 'Sign in with your Riyeser account'}</h1>
    <p class="wsub">${CO.create ? 'You can use it on riyeser.com and in every Riyeser program.' : 'Use the same email and password as riyeser.com.'}</p>
    <form id="wf-acc">${field('email', 'Email', '', 'type="email" required autocomplete="email"')}
      <label class="wf"><span>Password</span><input name="password" type="password" minlength="8" required autocomplete="${CO.create ? 'new-password' : 'current-password'}"></label>
      <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button><button class="btn">${CO.create ? 'Create account' : 'Sign in'}</button></div></form>
    <p class="wfoot">${CO.create ? 'Already have an account? <button class="wlink" data-w="signin-form">Sign in</button>' : 'Don\'t have one? <button class="wlink" data-w="signup-form">Create a free account</button>'}</p>`);
  $('#wf-acc').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); run(async () => {
    const r = await bridge.call('company:signIn', f.email, f.password, CO.create);
    if (r && r.needsConfirm) { CO.create = false; CO.note = `Nearly there: open the link we emailed to ${f.email}, then sign in here.`; return showAccount(next); }
    await coLoad(); return next === 'join' ? showJoinForm() : findBusiness();
  }); };
}

// Signed in: one business -> linked straight away; several -> pick one; none -> "A few details".
async function findBusiness() {
  CO.screen = 'finding';
  wiz('<h1>Looking up your account…</h1><p class="wsub">Finding the business your Riyeser account belongs to.</p>');
  try {
    const r = await bridge.call('company:afterSignIn'); await coLoad();
    if (r.status === 'linked') return showWelcome(r);
    if (r.status === 'choose') { CO.list = r.businesses; return showPick(); }
    CO.details = r.details || {}; CO.last = null; return showNewForm();
  } catch (e) { CO.err = e.message; return showChoice(); }
}

function showWelcome(r) {
  CO.screen = 'welcome';
  const c = r.company || {};
  wiz(`<div class="wdone">👋</div><h1>Welcome back${r.firstName ? `, ${esc(r.firstName)}` : ''}.</h1>
    <p class="wsub">This PC is now linked to <b>${esc(c.name)}</b>${c.company_code ? ` (${esc(c.company_code)})` : ''}. Your details are filled in for every Riyeser program.</p>
    <div class="wrow"><button class="btn" data-w="done">Start using Riyeser</button></div>`);
}

function showPick() {
  CO.screen = 'pick';
  wiz(`<h1>Which business is this PC for?</h1><p class="wsub">Your Riyeser account belongs to more than one. You can change it later under <b>Company</b>.</p>
    <div class="wpick">${(CO.list || []).map((b) => `<button class="wbig wsm" data-w="pick" data-ws="${esc(b.workspace_id)}"><b>${esc(b.name)}</b><small>${esc(b.company_code || '')}${b.role ? ` · ${esc(b.role)}` : ''}</small></button>`).join('')}</div>
    <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button></div>`);
}

// No business yet: a few details. For a person on their own the business fields can stay empty.
const opt = (n, label, v, extra = '') => field(n, `${label} (optional)`, v, extra);
function showNewForm() {
  CO.screen = 'newform';
  const d = CO.last || CO.details || {};
  wiz(`<h1>A few details</h1><p class="wsub">Signed in as <b>${esc(CO.state.signedIn)}</b>. Only your name is needed. Anything else you add goes on your invoices and documents.</p>
    <form id="wf-new"><div class="wgrid">
      ${field('your_name', 'Your name', d.your_name, 'required maxlength="60" autocomplete="name"')}
      ${opt('phone', 'Phone', d.phone, 'maxlength="40" autocomplete="tel"')}
      ${field('name', 'Business name (optional)', d.name, 'maxlength="120" autocomplete="organization"')}
      ${field('tax_number', 'ABN / TIN / Tax ID (optional)', d.tax_number, 'maxlength="40"')}
      <label class="wf wide"><span>Business address (optional)</span><input name="address" value="${esc(d.address || '')}" maxlength="240" autocomplete="street-address"></label>
      ${opt('email', 'Business email', d.email, 'type="email" maxlength="120" autocomplete="email"')}
      <label class="wf"><span>Country</span><select name="country">${COUNTRIES.map((c) => `<option${(d.country || 'Fiji') === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
      <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button><button class="btn">Finish setting up</button></div></form>`);
  $('#wf-new').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); CO.last = f; run(async () => {
    const c = await bridge.call('company:details', f); await coLoad(); showCreated(c); }); };
}

function showCreated(c) {
  CO.screen = 'created';
  wiz(`<div class="wdone">✅</div><h1>${esc(c.name)} is set up</h1>
    <p class="wsub">Give this Company ID to your staff and branches. They choose <b>Join an existing company</b> and enter it, then you approve them.</p>
    <div class="wid"><span id="wid">${esc(c.company_code || '')}</span><button class="btn" data-w="copy">Copy</button></div>
    <p class="wnote">You can always find it under <b>Company</b> in the sidebar. Branch codes (for staff who belong to a branch) are in Riyeser Team.</p>
    <div class="wrow"><button class="btn" data-w="done">Start using Riyeser</button></div>`);
}

function showJoinForm() {
  CO.screen = 'joinform';
  wiz(`<h1>Join your company</h1><p class="wsub">Signed in as <b>${esc(CO.state.signedIn)}</b>. Ask your manager for the Company ID, or your branch code if you work at a branch.</p>
    <form id="wf-join">${field('code', 'Company ID or branch code', '', 'required maxlength="20" placeholder="e.g. RIY-7K3M-Q2 or LAU-4821" autocapitalize="characters" spellcheck="false"')}
      ${field('your_name', 'Your name, as your team will see it', '', 'required maxlength="60" autocomplete="name"')}
      ${field('note', 'A note for whoever approves you (optional)', '', 'maxlength="200" placeholder="e.g. New sales rep at Lautoka, starting Monday"')}
      <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button><button class="btn">Send request</button></div></form>`);
  $('#wf-join').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); run(async () => {
    const r = await bridge.call('company:join', f.code, f.your_name, f.note);
    await coLoad(); if (r.status === 'approved') return showJoined(r.company); showWaiting(r.company_name); }); };
}

function showWaiting(name) {
  CO.screen = 'waiting';
  wiz(`<div class="wdone wait">⏳</div><h1>Waiting for ${esc(name || 'your company')} to approve you</h1>
    <p class="wsub">We've let them know. An owner or admin approves you in Riyeser Team (Join requests) and chooses what you can see. This page checks every 15 seconds.</p>
    <div class="wrow"><button class="btn s" data-w="cancel-join">Use a different code</button><button class="btn" data-w="check">Check now</button></div>
    <p class="wfoot"><button class="wlink" data-w="later">Keep using Central while I wait</button></p>`);
  clearInterval(CO.poll); CO.poll = setInterval(() => checkJoin(true), 15000);
}
async function checkJoin(quiet) {
  try {
    const r = await bridge.call('company:checkJoin');
    if (r.status === 'approved') { clearInterval(CO.poll); await coLoad(); return showJoined(r.company); }
    if (r.status === 'declined') { clearInterval(CO.poll); await coLoad(); return showDeclined(r.company_name); }
    if (!quiet && CO.screen === 'waiting') toast('Not approved yet. We\'ll keep checking.');
  } catch (e) { if (!quiet) toast(e.message); }
}
function showJoined(c) {
  CO.screen = 'joined'; clearInterval(CO.poll);
  wiz(`<div class="wdone">🎉</div><h1>You're in ${esc(c.name)}</h1><p class="wsub">This PC is linked to ${esc(c.name)}${c.company_code ? ` (${esc(c.company_code)})` : ''}. Your Riyeser programs will use its details.</p>
    <div class="wrow"><button class="btn" data-w="done">Start using Riyeser</button></div>`);
}
function showDeclined(name) {
  CO.screen = 'declined';
  wiz(`<div class="wdone">✋</div><h1>${esc(name || 'The company')} didn't approve this request</h1>
    <p class="wsub">Check you have the right Company ID or branch code with your manager, then try again.</p>
    <div class="wrow"><button class="btn s" data-w="local">Just this PC for now</button><button class="btn" data-w="join">Try another code</button></div>`);
}

function showLocal() {
  CO.screen = 'local';
  wiz(`<h1>Business details for this PC</h1><p class="wsub">Saved on this PC only. Every Riyeser program here uses them. You can sign in with your Riyeser account later.</p>
    <form id="wf-local">${profileFields((CO.state && CO.state.company) || CO.last || {})}${field('your_name', 'Your name', (CO.state && CO.state.company && CO.state.company.your_name) || '', 'maxlength="60" autocomplete="name"')}
      <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button><button class="btn">Save</button></div></form>`);
  $('#wf-local').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); CO.last = f; run(async () => {
    await bridge.call('company:local', f, f.your_name); await coLoad(); closeWizard(); toast(`${f.name} is set up on this PC.`); afterChange(); }); };
}

async function run(fn) {
  if (CO.busy) return; CO.busy = true;
  document.querySelectorAll('#wizard button').forEach((b) => { b.disabled = true; });
  try { await fn(); } catch (e) { CO.err = e.message; rerender(); }
  finally { CO.busy = false; document.querySelectorAll('#wizard button').forEach((b) => { if (!b.hasAttribute('data-keepoff')) b.disabled = false; }); }
}
function rerender() {
  const s = CO.screen;
  if (s === 'account') return showAccount(CO.mode);
  if (s === 'newform') return showNewForm();
  if (s === 'pick') return showPick();
  if (s === 'finding') return showChoice();
  if (s === 'joinform') return showJoinForm();
  if (s === 'local') return showLocal();
  if (s === 'waiting') return showWaiting(CO.state.pendingJoin && CO.state.pendingJoin.company_name);
  if (s === 'start') return showStart();
  return showChoice();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]'); if (!b || b.disabled) return;
  const a = b.dataset.w;
  if (a === 'signin' || a === 'join') { CO.create = false; return showAccount(a); }
  if (a === 'signup') { CO.create = true; return showAccount('signin'); }
  if (a === 'pick') return run(async () => { const r = await bridge.call('company:link', b.dataset.ws); await coLoad(); showWelcome(r); });
  if (a === 'local') return showLocal();
  if (a === 'blank') return showChoice();
  if (a === 'start') return showStart();
  if (a === 'demo') return run(async () => { closeWizard(); CO.first = false; await window.RiyeserCentralDemo.startDemo(); });
  if (a === 'signup-form' || a === 'signin-form') { CO.create = a === 'signup-form'; return showAccount(CO.mode); }
  if (a === 'back') return showChoice();
  if (a === 'copy') { const t = ($('#wid') || $('#coid') || {}).textContent; safe(() => bridge.call('company:copy', t)).then(() => toast('Company ID copied')); return; }
  if (a === 'check') return checkJoin(false);
  if (a === 'cancel-join') return run(async () => { await bridge.call('company:cancelJoin'); await coLoad(); showJoinForm(); });
  if (a === 'later') { safe(() => bridge.call('company:skip')); closeWizard(); return; }
  if (a === 'done') { closeWizard(); afterChange(); return; }
  if (a === 'restart') { coLoad().then(showChoice); return; }
  if (a === 'link') { coLoad().then(() => (CO.state.onlineReady ? showAccount('signin') : (CO.err = 'Online company linking is being switched on. Try again soon.', showChoice()))); return; }
  if (a === 'signout') { safe(async () => { await bridge.call('company:signOut'); await coLoad(); renderCompany(); toast('Signed out of Riyeser Online on this PC.'); }); }
});

// ---------------------------------------------------------------- Company page and the "unlinked" note
function renderCompany() {
  const s = CO.state || {}; const c = s.company; const el = $('#companyv');
  if (!c) {
    el.innerHTML = `<h2 class="sec">Company</h2><div class="panel cobox"><p>This PC isn't set up with a business yet.</p><div class="row"><button class="btn" data-w="restart">Set up or join a business</button></div></div>`;
    return;
  }
  const row = (k, v) => (v ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '');
  el.innerHTML = `<h2 class="sec">Company</h2>
    <div class="panel cobox">
      <div class="cohead"><span class="cologo">🏢</span><div><h3>${esc(c.name)}</h3><div class="lbl">${c.mode === 'online' ? `Linked online${s.signedIn ? ` · signed in as ${esc(s.signedIn)}` : ''}` : 'Set up on this PC only'}</div></div></div>
      ${c.company_code ? `<div class="wid sm"><span id="coid">${esc(c.company_code)}</span><button class="btn" data-w="copy">Copy</button></div><p class="lbl">Give this Company ID to staff and branches. They choose <b>Join an existing company</b> in Riyeser Central, and you approve them in Riyeser Team.</p>` : ''}
      <div class="kvs">${row('Legal name', c.legal_name)}${row('ABN / tax number', c.tax_number)}${row('Address', c.address)}${row('Phone', c.phone)}${row('Email', c.email)}${row('Country', c.country)}${row('You', c.your_name)}</div>
      <div class="row">${c.mode !== 'online' ? '<button class="btn" data-w="link">Sign in with your Riyeser account</button><button class="btn s" data-w="local">Edit details</button>' : ''}
        ${s.signedIn ? '<button class="btn s" data-w="signout">Sign out</button>' : ''}<button class="btn s" data-w="restart">Use a different company</button></div>
      <p class="lbl">Changing company never deletes anything: your books, files and settings on this PC stay where they are.</p>
    </div>`;
}
function renderCoBar() {
  const s = CO.state || {}; const bar = $('#cobar'); if (!bar) return;
  const show = s.unlinked && s.company;
  bar.hidden = !show;
  if (show) bar.innerHTML = `<span style="font-size:24px">🔗</span><div class="grow"><b>This PC was unlinked from ${esc(s.company.name)}</b><div class="lbl">An admin removed it, or you left the company. Everything on this PC is still here.</div></div><button class="go" data-w="restart">Set up or join a business</button>`;
}
function afterChange() { renderCompany(); renderCoBar(); if (typeof renderNav === 'function') renderNav(); }

// After leaving demo mode, for someone who never set up a company: the normal set-up.
async function offerSetup() { await coLoad(); if (!CO.state.company && !CO.state.skipped && !CO.state.pendingJoin) { CO.first = false; showChoice(); } }

// On start: the wizard the first time (it starts with "How would you like to start?"), or the waiting screen if a
// request is still out. Nothing is asked while demo mode is on, or once the company is set up.
(async () => {
  try {
    const s = await coLoad();
    renderCompany(); renderCoBar();
    let demo = null; try { demo = await bridge.call('demo:get'); } catch { /* normal mode */ }
    const first = window.RiyeserDemo.firstScreen(s, demo);
    if (first === 'waiting') { showWaiting(s.pendingJoin.company_name); checkJoin(true); }
    else if (first === 'start') { CO.first = true; showStart(); }
    else if (s.company && s.company.mode === 'online') { await bridge.call('company:checkLinked').catch(() => null); await coLoad(); renderCoBar(); }
  } catch { /* the rest of Central works without it */ }
  setInterval(async () => { try { await bridge.call('company:checkLinked'); await coLoad(); renderCoBar(); } catch { /* offline */ } }, 24 * 3600 * 1000);
})();
window.RiyeserCompany = { renderCompany, showChoice, showStart, offerSetup, state: () => CO.state };
