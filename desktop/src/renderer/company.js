// Riyeser Central: the company this PC belongs to.
// First run: a full-window wizard to set up a new company, join an existing one (an admin approves it, like a friend
// request), or set this PC up on its own. Afterwards, the Company page shows the profile and Company ID.
// The profile is saved in %APPDATA%\Riyeser\company.json, so every Riyeser program fills in the company details itself.
/* global $, esc, bridge, toast, safe, setView, renderNav */
const CO = { first: false, fromCompany: false, email: '', list: null, details: null, state: null, mode: null, screen: 'choice', create: false, poll: null, busy: false, err: '', note: '', last: null };
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
// Passwords are sent exactly as typed (a space at the end is part of a password); everything else is trimmed.
const formData = (f) => Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, /^password/.test(k) ? String(v) : String(v).trim()]));
// A password box with an eye button to see what was typed, and a Caps Lock warning under it.
const pwField = (n, label, auto) => `<label class="wf"><span>${label}</span><span class="pwwrap"><input name="${n}" type="password" minlength="8" required autocomplete="${auto}" spellcheck="false"><button type="button" class="pweye" data-pweye aria-label="Show password" title="Show password">👁</button></span></label>`;

async function coLoad() { CO.state = await bridge.call('company:get'); try { renderAcct(); } catch { /* sidebar not drawn yet */ } return CO.state; }

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
const typedEmail = () => (CO.email || (CO.state && CO.state.lastEmail) || '');
function showAccount(next) {
  CO.mode = next; CO.screen = 'account';
  if (CO.state.signedIn) return next === 'join' ? showJoinForm() : findBusiness();
  const make = CO.create;
  wiz(`<h1>${make ? 'Create your free Riyeser account' : 'Sign in with your Riyeser account'}</h1>
    <p class="wsub">${make ? 'You can use it on riyeser.com and in every Riyeser program.' : 'Use the same email and password as riyeser.com.'}</p>
    <form id="wf-acc" autocomplete="on">${field('email', 'Email', make ? CO.email : typedEmail(), 'type="email" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="200"')}
      ${pwField('password', make ? 'Choose a password (at least 8 characters)' : 'Password', make ? 'new-password' : 'current-password')}
      ${make ? pwField('password2', 'Type the password again', 'new-password') : ''}
      <p class="wcaps" hidden>Caps Lock is on</p>
      <div class="werr" id="wf-msg" hidden></div>
      ${make ? '' : '<p class="wforgot"><button type="button" class="wlink" data-w="forgot">Forgot password?</button></p>'}
      <div class="wrow"><button type="button" class="btn s" data-w="back">Back</button><button class="btn">${make ? 'Create account' : 'Sign in'}</button></div></form>
    <p class="wfoot">${make ? 'Already have an account? <button class="wlink" data-w="signin-form">Sign in</button>' : 'Don\'t have one? <button class="wlink" data-w="signup-form">Create a free account</button>'}</p>`);
  const form = $('#wf-acc');
  // the email box gets the focus when it's empty, else the password (the email is remembered from last time)
  (form.email.value ? form.password : form.email).focus();
  form.onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); CO.email = f.email;
    if (make && f.password !== f.password2) { const m = $('#wf-msg'); m.textContent = 'The two passwords don\'t match. Type them again.'; m.hidden = false; form.password2.focus(); return; }
    run(async () => {
      const r = await bridge.call('company:signIn', f.email, f.password, make);
      if (r && r.needsConfirm) { CO.create = false; CO.note = `Nearly there: open the link we emailed to ${f.email}, then sign in here.`; return showAccount(next); }
      if (r && r.needsCode) return showCode(next);   // S11: two-step sign-in is on for this account
      await coLoad(); return next === 'join' ? showJoinForm() : findBusiness();
    }); };
}

// S11: the second step of signing in, for accounts with two-step sign-in (an authenticator app) turned on.
function showCode(next) {
  CO.screen = 'code';
  wiz(`<h1>Two-step sign-in</h1><p class="wsub">Open your authenticator app and type the 6-digit code for Riyeser.</p>
    <form id="wf-code" autocomplete="off">${field('code', 'Code', '', 'inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" required autocomplete="one-time-code"')}
      <div class="werr" id="wf-msg" hidden></div>
      <div class="wrow"><button type="button" class="btn s" data-w="signin-form">Back</button><button class="btn">Verify</button></div></form>`);
  const form = $('#wf-code'); form.code.focus();
  form.onsubmit = (e) => { e.preventDefault(); const f = formData(e.target);
    run(async () => { await bridge.call('company:verifyCode', f.code); await coLoad(); return next === 'join' ? showJoinForm() : findBusiness(); }); };
}

// "Forgot password?": Riyeser emails a reset link. The same words whether or not there's an account for that email.
function showForgot() {
  CO.screen = 'forgot';
  wiz(`<h1>Reset your password</h1><p class="wsub">Type the email you use for Riyeser. We'll email you a link to choose a new password.</p>
    <form id="wf-forgot">${field('email', 'Email', typedEmail(), 'type="email" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="200"')}
      <div class="wrow"><button type="button" class="btn s" data-w="signin-form">Back</button><button class="btn">Send reset link</button></div></form>`);
  $('#wf-forgot').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); CO.email = f.email; run(async () => {
    await bridge.call('company:recover', f.email); showForgotSent(); }); };
}
function showForgotSent() {
  CO.screen = 'forgot-sent';
  wiz(`<div class="wdone">📧</div><h1>Check your email</h1>
    <p class="wsub">If that email has a Riyeser account, we've sent a link to reset the password. Open it, choose a new password, then sign in here.</p>
    <div class="wrow"><button class="btn" data-w="signin-form">Back to sign in</button></div>`);
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
    <p class="wnote">You can always find it under <b>Company</b> in the sidebar. Branch codes (for staff who belong to a branch) are in Riyeser Link.</p>
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
    <p class="wsub">We've let them know. An owner or admin approves you in Riyeser Link (Join requests) and chooses what you can see. This page checks every 15 seconds.</p>
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

// "Sign out" on the Company page: asked first, then the business is put away on this PC (renamed, never deleted).
async function signOut() {
  const c = (CO.state && CO.state.company) || {};
  const ok = await window.RiyeserCentralDemo.askConfirm({ title: 'Sign out of Riyeser on this PC?',
    body: `This PC stops showing ${c.name || 'your business'} and its Company ID until someone signs in again. Your books and files on this PC aren't touched.`,
    ok: 'Sign out', cancel: 'Cancel' });
  if (!ok) return;
  clearInterval(CO.poll); CO.poll = null; CO.list = null; CO.details = null; CO.last = null;
  await bridge.call('company:signOut');
  await coLoad(); afterChange();
  toast('Signed out. This PC no longer shows your business.');
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
  if (s === 'forgot') return showForgot();
  return showChoice();
}

// The eye button: show or hide the password typed in the box next to it.
document.addEventListener('click', (e) => {
  const eye = e.target.closest('[data-pweye]'); if (!eye) return;
  const input = eye.parentElement.querySelector('input'); const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const t = show ? 'Hide password' : 'Show password'; eye.setAttribute('aria-label', t); eye.title = t; eye.classList.toggle('on', show);
  input.focus();
});
// "Caps Lock is on" under the password boxes while it is.
const capsCheck = (e) => {
  if (!e.target.matches || !e.target.matches('#wizard input[name^=password]') || typeof e.getModifierState !== 'function') return;
  const note = document.querySelector('#wizard .wcaps'); if (note) note.hidden = !e.getModifierState('CapsLock');
};
document.addEventListener('keydown', capsCheck); document.addEventListener('keyup', capsCheck);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-w]'); if (!b || b.disabled) return;
  const a = b.dataset.w;
  if (a === 'signin' || a === 'join') { CO.create = false; CO.fromCompany = false; return showAccount(a); }
  if (a === 'signup') { CO.create = true; CO.fromCompany = false; return showAccount('signin'); }
  if (a === 'pick') return run(async () => { const r = await bridge.call('company:link', b.dataset.ws); await coLoad(); showWelcome(r); });
  if (a === 'local') return showLocal();
  if (a === 'blank') return showChoice();
  if (a === 'start') return showStart();
  // demo mode only after "Turn on demo mode?" is answered yes; Cancel stays on this step
  if (a === 'demo') return run(async () => { if (await window.RiyeserCentralDemo.startDemo()) { closeWizard(); CO.first = false; } });
  if (a === 'signup-form' || a === 'signin-form') { CO.create = a === 'signup-form'; return showAccount(CO.mode || 'signin'); }
  if (a === 'forgot') { const em = document.querySelector('#wf-acc [name=email]'); if (em && em.value.trim()) CO.email = em.value.trim(); return showForgot(); }
  // from the Company page's "You're signed out", Back goes back there (not to the set-up choices)
  if (a === 'back') { if (CO.fromCompany) { closeWizard(); return; } return showChoice(); }
  if (a === 'copy') { const t = ($('#wid') || $('#coid') || {}).textContent; safe(() => bridge.call('company:copy', t)).then(() => toast('Company ID copied')); return; }
  if (a === 'check') return checkJoin(false);
  if (a === 'cancel-join') return run(async () => { await bridge.call('company:cancelJoin'); await coLoad(); showJoinForm(); });
  if (a === 'later') { safe(() => bridge.call('company:skip')); closeWizard(); return; }
  if (a === 'done') { closeWizard(); afterChange(); return; }
  if (a === 'restart') { CO.fromCompany = false; coLoad().then(showChoice); return; }
  if (a === 'link' || a === 'co-signup') {
    CO.fromCompany = !!b.closest('#companyv'); CO.create = a === 'co-signup';
    coLoad().then(() => (CO.state.onlineReady ? showAccount('signin') : (CO.err = 'Online company linking is being switched on. Try again soon.', showChoice()))); return;
  }
  if (a === 'signout') { safe(signOut); }
});

// ---------------------------------------------------------------- Company page and the "unlinked" note
function renderCompany() {
  const s = CO.state || {}; const c = s.company; const el = $('#companyv');
  if (!c && s.signedOut) {   // signed out on purpose: nothing of the old business is shown
    el.innerHTML = `<h2 class="sec">Company</h2><div class="panel cobox coout"><span class="cologo">🔒</span><h3>You're signed out.</h3>
      <p>Sign in with your Riyeser account to see your business on this PC.</p>
      <div class="row"><button class="btn big" data-w="link">Sign in</button><button class="btn s" data-w="co-signup">Create a free account</button></div></div>`;
    return;
  }
  if (!c) {
    el.innerHTML = `<h2 class="sec">Company</h2><div class="panel cobox"><p>This PC isn't set up with a business yet.</p><div class="row"><button class="btn" data-w="restart">Set up or join a business</button></div></div>`;
    return;
  }
  const row = (k, v) => (v ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '');
  el.innerHTML = `<h2 class="sec">Company</h2>
    <div class="panel cobox">
      <div class="cohead"><span class="cologo">🏢</span><div><h3>${esc(c.name)}</h3><div class="lbl">${c.mode === 'online' ? `Linked online${s.signedIn ? ` · signed in as ${esc(s.signedIn)}` : ''}` : 'Set up on this PC only'}</div></div></div>
      ${c.company_code ? `<div class="wid sm"><span id="coid">${esc(c.company_code)}</span><button class="btn" data-w="copy">Copy</button></div><p class="lbl">Give this Company ID to staff and branches. They choose <b>Join an existing company</b> in Riyeser Central, and you approve them in Riyeser Link.</p>` : ''}
      <div class="kvs">${row('Legal name', c.legal_name)}${row('ABN / tax number', c.tax_number)}${row('Address', c.address)}${row('Phone', c.phone)}${row('Email', c.email)}${row('Country', c.country)}${row('You', c.your_name)}</div>
      ${c.mode === 'online' && !s.signedIn ? '<p class="wnote">You\'re not signed in on this PC any more. Sign in again to keep your plan and team up to date.</p>' : ''}
      <div class="row">${c.mode !== 'online' ? '<button class="btn" data-w="link">Sign in with your Riyeser account</button><button class="btn s" data-w="local">Edit details</button>' : ''}
        ${c.mode === 'online' && !s.signedIn ? '<button class="btn" data-w="link">Sign in again</button>' : ''}
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
// The bottom of the sidebar always says who's signed in, with a Sign in / Sign out button.
function renderAcct() {
  const el = $('#acct'); if (!el) return; const s = CO.state || {};
  el.innerHTML = s.signedIn
    ? `<span class="acct-who">👤 Signed in as <b>${esc(s.signedIn)}</b></span> <button data-w="signout">Sign out</button>`
    : `<span class="acct-who">👤 Not signed in</span> <button class="acct-in" data-w="link">Sign in</button>`;
}
function afterChange() { renderAcct(); renderCompany(); renderCoBar(); if (typeof renderNav === 'function') renderNav(); }

// After leaving demo mode, for someone who never set up a company: the normal set-up.
async function offerSetup() { await coLoad(); if (!CO.state.company && !CO.state.skipped && !CO.state.pendingJoin && !CO.state.signedOut) { CO.first = false; showChoice(); } }

// On start: the wizard the first time (it starts with "How would you like to start?"), or the waiting screen if a
// request is still out. Nothing is asked while demo mode is on, or once the company is set up.
(async () => {
  try {
    const s = await coLoad();
    renderCompany(); renderCoBar(); renderAcct();
    let demo = null; try { demo = await bridge.call('demo:get'); } catch { /* normal mode */ }
    const first = window.RiyeserDemo.firstScreen(s, demo);
    if (first === 'waiting') { showWaiting(s.pendingJoin.company_name); checkJoin(true); }
    else if (first === 'start') { CO.first = true; showStart(); }
    else if (first === 'signedout') { if (typeof setView === 'function') setView('company'); }   // never the first-run choice again
    else if (s.company && s.company.mode === 'online') { await bridge.call('company:checkLinked').catch(() => null); await coLoad(); renderCoBar(); }
  } catch { /* the rest of Central works without it */ }
  setInterval(async () => { try { await bridge.call('company:checkLinked'); await coLoad(); renderCoBar(); renderAcct(); } catch { /* offline */ } }, 24 * 3600 * 1000);
})();
window.RiyeserCompany = { renderCompany, showChoice, showStart, offerSetup, state: () => CO.state };
