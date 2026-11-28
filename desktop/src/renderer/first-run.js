// Riyeser Central's first run, "One installer" (central/first-run.js has the rules):
//   Business: 1 Sign in -> 2 Install your plan (every program on it, one after another, a bar each) -> 3 Your business -> 4 Done
//     a second PC of the same business first answers "What is this PC for?" (Office PC / Till / Reception / Everything)
//   On your own ("Just try it", no account): 1 Get started (an optional business name) -> 2 Pick your programs -> 3 Done
// Nothing here pops up: progress carries on in a quiet panel on the home screen if the person keeps using Central.
/* global $, esc, bridge, toast, safe, wiz, closeWizard, CO, coLoad, afterChange, logo, refresh, reportIssue, setView, COUNTRIES, field */
const FR = { info: null, run: null, sum: null, screen: null, choosing: false, created: null, logoUrl: '', busy: false };
const FR_STEPS = { plan: ['Sign in', 'Install your plan', 'Your business', 'Done'], individual: ['Get started', 'Pick your programs', 'Done'] };
const frPath = () => (FR.info && FR.info.path) || 'plan';
/** The steps across the top of the first-run screens. */
function frSteps(n, pathName = frPath()) {
  return `<ol class="frsteps" aria-label="Getting started">${FR_STEPS[pathName].map((t, i) => `<li${i + 1 === n ? ' class="on" aria-current="step"' : i + 1 < n ? ' class="did"' : ''}>${i + 1} ${esc(t)}</li>`).join('')}</ol>`;
}
async function frLoad() { FR.info = await bridge.call('firstrun:get'); FR.run = FR.info.run; FR.sum = FR.info.summary; return FR.info; }
const frProg = (id) => ((FR.info && FR.info.programs) || []).find((p) => p.id === id) || { id, name: id, full: id, desc: '' };
const frBiz = () => (FR.info && FR.info.company && FR.info.company.name) || 'your business';
const andNames = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

// ---------------------------------------------------------------- after signing in
/** Signed in and linked (or set up): the plan installs, or (on their own) they pick programs. r.created: a new business. */
async function frAfterLinked(r = {}) {
  if (r.created) FR.created = r.created;
  CO.first = true;
  wiz(`${frSteps(2)}<h1>Reading your plan…</h1><p class="wsub">Finding the programs on ${esc(frBiz())}'s plan.</p>`);
  try { await frLoad(); } catch (e) { CO.err = e.message; return showChoice(); }
  if (frPath() === 'individual') return frShowPicker();
  if (FR.info.secondPc && !FR.info.roleChosen) return frShowRole();
  return frStartPlan();
}
async function frStartPlan(ids = null) {
  const r = await bridge.call('firstrun:start', ids, { step: 'install' });
  FR.run = r.run; FR.sum = r.summary; FR.choosing = false;
  frShowInstall();
}

// ---------------------------------------------------------------- What is this PC for? (a second PC of the business)
function frShowRole() {
  FR.screen = 'role';
  const role = FR.info.role || 'everything';
  const names = (ids) => (ids.length ? andNames(ids.map((id) => frProg(id).name)) : 'Nothing on your plan is for this yet');
  wiz(`${frSteps(2)}<h1>What is this PC for?</h1>
    <p class="wsub">${esc(frBiz())} already uses Riyeser. Choose what this PC does, and Central installs just those programs from your plan.</p>
    <div class="frroles" role="radiogroup" aria-label="What is this PC for?">${FR.info.roles.map((r) => `<button type="button" class="fropt" role="radio" data-fr="role" data-role="${esc(r.id)}" aria-checked="${r.id === role}">
      <b>${esc(r.title)}</b><small>${esc(r.sub)}</small><span class="frwill">${esc(names(r.programs))}</span></button>`).join('')}</div>
    <div class="wrow"><button class="btn" data-fr="role-go">Install for this PC</button></div>`);
}

// ---------------------------------------------------------------- Install your plan
const frIcon = (id) => logo({ id, name: frProg(id).name }, 36);
function frPill(i) {
  if (i.stage === 'installed') return '<span class="frpill ok">Installed</span>';
  if (i.stage === 'skipped') return '<span class="frpill ok">On this PC</span>';
  if (i.stage === 'failed') return '<span class="frpill bad">Problem</span>';
  if (i.stage === 'paused') return '<span class="frpill mu">Paused</span>';
  if (i.stage === 'waiting') return '<span class="frpill mu">Waiting</span>';
  return '<span class="frpill wa">Installing</span>';
}
const FR_BAR = { downloading: (i) => 0.04 + 0.66 * (Number(i.pct) || 0), checking: () => 0.72, ready: () => 0.75, installing: () => 0.85, verifying: () => 0.95, installed: () => 1, skipped: () => 1 };
const frWidth = (i) => `${Math.round(Math.min(1, (FR_BAR[i.stage] || ((x) => Math.min(0.7, Number(x.pct) || 0)))(i)) * 100)}%`;
function frText(i) {
  switch (i.stage) {
    case 'waiting': return 'Waiting for its turn';
    case 'downloading': return `Downloading… ${Math.round((Number(i.pct) || 0) * 100)}%`;
    case 'checking': return 'Checking the download…';
    case 'ready': return 'Downloaded. Windows asks for permission once the others are done';
    case 'installing': return i.elevate ? 'Installing… Windows asks for permission: choose Yes' : 'Installing…';
    case 'verifying': return 'Finishing…';
    case 'installed': return `Installed${i.version ? ` · version ${i.version}` : ''}`;
    case 'skipped': return 'Already installed on this PC';
    case 'paused': return 'Waiting for the internet. It carries on by itself.';
    case 'failed': return i.message || 'Install failed.';
    default: return '';
  }
}
function frRow(i) {
  const p = frProg(i.id); const bad = i.stage === 'failed';
  return `<div class="frrow${bad ? ' bad' : ''}" data-frrow="${esc(i.id)}" data-stage="${esc(i.stage)}">${frIcon(i.id)}<div class="frmid"><b>${esc(p.full)}</b>
    <span class="frtxt"${bad ? ' role="alert"' : ''}>${esc(frText(i))}</span>${bad ? '' : `<div class="frbar"><i style="width:${frWidth(i)}"></i></div>`}
    ${bad ? `${i.fix ? `<span class="frfix">${esc(i.fix)}</span>` : ''}<div class="frrowbtns"><button class="btn sm" data-fr="retry" data-id="${esc(i.id)}">Try again</button><button class="btn sm s" data-fr="help" data-id="${esc(i.id)}">Get help</button></div>` : ''}</div>${frPill(i)}</div>`;
}
/** The programs that can be chosen on the "Choose programs instead" list. */
const frChoices = () => (frPath() === 'plan' ? FR.info.plan : FR.info.individual);
function frChooseRow(id, on) {
  const p = frProg(id); const have = FR.info.installed.includes(id);
  return `<label class="frrow frpick">${frIcon(id)}<div class="frmid"><b>${esc(p.full)}</b><span class="frtxt">${esc(have ? 'Already installed on this PC' : p.desc)}</span></div>
    <input type="checkbox" name="fr" value="${esc(id)}"${on || have ? ' checked' : ''}${have ? ' disabled' : ''} aria-label="${esc(p.full)}"></label>`;
}
function frShowInstall() {
  FR.screen = 'install';
  const run = FR.run || { items: [] }; const s = FR.sum || { failed: [], paused: [], waiting: [], needsPermission: [], allDone: false, done: 0, total: 0 };
  const plan = frPath() === 'plan';
  const busy = s.waiting.length > 0;
  if (FR.choosing) {
    const now = new Set(run.items.map((i) => i.id));
    wiz(`${frSteps(2)}<h1>Choose programs</h1><p class="wsub">Untick anything this PC doesn't need. You can add it later from <b>Add a program</b>.</p>
      <form id="frchoose"><div class="frlist">${frChoices().map((id) => frChooseRow(id, now.has(id))).join('')}</div>
      <div class="wrow"><button type="button" class="btn s" data-fr="choose-cancel">Back</button><button class="btn">Install these</button></div></form>`);
    $('#frchoose').onsubmit = (e) => { e.preventDefault(); const ids = [...e.target.querySelectorAll('input[name=fr]:checked:not([disabled])')].map((x) => x.value);
      frRun(() => frStartPlan(ids)); };
    return;
  }
  const role = (FR.info.roles || []).find((r) => r.id === run.role);
  const title = s.allDone ? (plan ? `${esc(frBiz())} is installed` : 'Your programs are installed') : plan ? `Setting up ${esc(frBiz())}` : 'Installing your programs';
  const count = s.total && !s.allDone ? ` ${s.done} of ${s.total} done.` : '';
  const sub = s.allDone ? 'Everything is on this PC.'
    : plan ? `Installing everything on your plan${role && role.id !== 'everything' ? ` for the ${esc(role.title.toLowerCase())}` : ''}. You can keep working; Central carries on by itself.`
      : 'You can keep working; Central carries on by itself.';
  const subText = `${sub}${count}`;
  const perm = s.needsPermission.length ? `<p class="frnote">🛡 Windows asks for permission once, for ${esc(andNames(s.needsPermission.map((id) => frProg(id).full)))}: ${s.needsPermission.length === 1 ? 'it installs' : 'they install'} for everyone on this PC. Choose <b>Yes</b>. If you don't see it, look on the taskbar.</p>` : '';
  const off = s.paused.length ? '<p class="frnote warn" role="status">📶 This PC is offline. The rest installs by itself when it\'s back online, even after a restart.<button class="wlink" data-fr="resume">Try now</button></p>' : '';
  const nextLabel = plan ? 'Next: your business' : 'Done';
  const empty = !run.items.length ? `<p class="wnote">${plan && !FR.info.planKnown ? 'Central couldn\'t read your plan yet (it needs the internet). Choose programs instead, or try again later.' : 'Nothing to install for this PC.'}</p>` : '';
  wiz(`<div class="frcen">${frSteps(2)}<h1>${title}</h1><p class="wsub" id="frsub">${subText}</p></div>${off}
    <div class="frlist" id="frlist">${run.items.map(frRow).join('')}</div>${empty}${perm}
    <div class="frbtns"><button class="wlink" data-fr="choose">Choose programs instead</button><span class="grow"></span>
      ${busy ? '<button class="btn s" data-fr="bg">Keep using Central</button>' : ''}
      <button class="btn" data-fr="next"${busy ? ' disabled data-keepoff' : ''}>${s.failed.length && !busy ? (plan ? 'Skip them for now' : 'Done for now') : nextLabel}</button></div>`);
  frFocusRow();
}
/** Keep the program that's installing (or one with a problem) in view in the list. */
function frFocusRow() {
  const list = $('#frlist'); if (!list) return;
  const row = list.querySelector('.frrow.bad') || [...list.querySelectorAll('.frrow')].find((r) => !['installed', 'skipped', 'waiting', 'paused'].includes(r.dataset.stage));
  if (!row) return;
  const top = row.offsetTop - list.offsetTop;
  if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - 8);
}
/** A step arrived: just that row changes (and the buttons when everything has finished). */
function frPatch(id) {
  const i = FR.run.items.find((x) => x.id === id); const row = id && document.querySelector(`#frlist [data-frrow="${id}"]`);
  if (!i || !row) return frShowInstall();
  const t = row.querySelector('.frtxt'); const bar = row.querySelector('.frbar i');
  if (row.dataset.stage !== i.stage) { row.outerHTML = frRow(i); frFocusRow(); const sub = $('#frsub'); const s = FR.sum;
    if (sub && s && s.total && !s.allDone) sub.textContent = sub.textContent.replace(/ \d+ of \d+ done\.$/, ` ${s.done} of ${s.total} done.`); return; }
  if (t) t.textContent = frText(i); if (bar) bar.style.width = frWidth(i);
}

// ---------------------------------------------------------------- Pick your programs (someone on their own)
function frShowPicker() {
  FR.screen = 'picker';
  const on = new Set(FR.info.individualDefault);
  wiz(`${frSteps(2, 'individual')}<h1>Which programs would you like?</h1>
    <p class="wsub">Tick what you need and Central installs it. Free programs stay free; the others are free for 90 days, no account needed. You can add more any time from <b>Add a program</b>.</p>
    <form id="frpick"><div class="frlist">${FR.info.individual.map((id) => frChooseRow(id, on.has(id))).join('')}</div>
    <div class="frbtns"><button type="button" class="wlink" data-fr="skip">Not now</button><span class="grow"></span><button class="btn" id="frpickgo">Install</button></div></form>`);
  const form = $('#frpick');
  const count = () => { const n = form.querySelectorAll('input[name=fr]:checked:not([disabled])').length; const b = $('#frpickgo'); b.textContent = n ? `Install ${n} program${n === 1 ? '' : 's'}` : 'Nothing to install'; b.disabled = !n; };
  form.addEventListener('change', count); count();
  form.onsubmit = (e) => { e.preventDefault(); const ids = [...form.querySelectorAll('input[name=fr]:checked:not([disabled])')].map((x) => x.value);
    frRun(() => frStartPlan(ids)); };
}

// ---------------------------------------------------------------- Your business
function frShowBusiness() {
  FR.screen = 'business';
  bridge.call('firstrun:step', 'business').catch(() => {});
  const c = FR.info.company || {};
  const cur = c.currency || FR.info.countryCurrency[c.country] || 'FJD';
  wiz(`${frSteps(3)}<h1>Your business</h1><p class="wsub">Every Riyeser program on this PC uses these on invoices, receipts and payslips. Change them any time under <b>Company</b>.</p>
    <form id="frbiz"><div class="frbiz"><div class="wgrid">
      ${field('name', 'Business name', c.name, 'required maxlength="120" autocomplete="organization"')}
      <label class="wf"><span>Country</span><select name="country">${COUNTRIES.map((x) => `<option${(c.country || 'Fiji') === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label class="wf"><span>Currency</span><select name="currency">${FR.info.currencies.map(([k, n]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(k)} · ${esc(n)}</option>`).join('')}</select></label>
      ${field('tax_number', 'Tax number (ABN / TIN), if any', c.tax_number, 'maxlength="40"')}
    </div>
    <div class="frlogo"><span class="frlogobox">${FR.logoUrl ? `<img src="${FR.logoUrl}" alt="Your logo">` : c.logo ? '✓' : '🏷'}</span>
      <div><b>Logo</b><small>${c.logo || FR.logoUrl ? 'Saved. It goes on your invoices and receipts.' : 'A PNG or JPG. It goes on your invoices and receipts.'}</small><button type="button" class="btn sm s" data-fr="logo">${c.logo || FR.logoUrl ? 'Change…' : 'Choose a picture…'}</button></div></div></div>
    <div class="wrow"><button class="btn">Save and continue</button></div></form>`);
  const form = $('#frbiz');
  let touched = !!c.currency;
  form.currency.addEventListener('change', () => { touched = true; });
  form.country.addEventListener('change', () => { if (!touched) form.currency.value = FR.info.countryCurrency[form.country.value] || 'USD'; });
  form.onsubmit = (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(form).entries());
    frRun(async () => { const saved = await bridge.call('firstrun:profile', f); FR.info.company = { ...FR.info.company, ...saved }; await coLoad(); frShowDone(); }); };
}

// ---------------------------------------------------------------- Done
const frMain = () => {
  const ids = ((FR.run && FR.run.items) || []).filter((i) => ['installed', 'skipped'].includes(i.stage)).map((i) => i.id);
  const pref = FR.run && FR.run.role === 'till' ? ['pos'] : FR.run && FR.run.role === 'reception' ? ['bookings', 'linkoffice'] : [];
  return [...pref, 'accounting', 'accounting-basics', 'invoices', 'pos', 'bookings', 'payroll', 'estimate', 'desk', 'pdf', 'team', 'linkoffice', 'services'].find((id) => ids.includes(id)) || null;
};
async function frShowDone() {
  FR.screen = 'done';
  bridge.call('firstrun:step', 'done').catch(() => {});
  const s = FR.sum || { installed: [], skipped: [], failed: [] };
  const main = frMain(); const plan = frPath() === 'plan';
  let items = [];
  try { const cl = await bridge.call('central:checklist'); items = (cl.items || []).filter((x) => !x.done && !x.skipped && x.id !== 'signin' && x.id !== 'programs').slice(0, 4); } catch { /* the home screen has it */ }
  const n = s.installed.length + s.skipped.length;
  const code = FR.created && FR.created.company_code;
  wiz(`<div class="frcen">${frSteps(plan ? 4 : 3)}<div class="wdone">🎉</div><h1>You're all set</h1>
    <p class="wsub">${n ? `${n} program${n === 1 ? ' is' : 's are'} on this PC` : 'Riyeser Central is ready'}${s.failed.length ? `. ${esc(andNames(s.failed.map((id) => frProg(id).full)))} didn't install: ${s.failed.length === 1 ? 'it\'s' : 'they\'re'} on your home screen with Try again` : ''}.</p></div>
    ${code ? `<div class="wid sm"><span id="wid">${esc(code)}</span><button class="btn" data-w="copy">Copy</button></div><p class="lbl frcen">Your Company ID. Staff and other PCs join with it.</p>` : ''}
    ${items.length ? `<div class="frday"><b>Your first day</b><ul>${items.map((x) => `<li><span class="frtick" aria-hidden="true"></span><span><b>${esc(x.title)}</b><small>${esc(x.hint)}</small></span></li>`).join('')}</ul>
      <small class="lbl">These stay under <b>Getting started</b> on the home screen until they're done. Hide them there any time.</small></div>` : ''}
    <div class="frbtns"><span class="grow"></span><button class="btn s" data-fr="home">Go to the home screen</button>${main ? `<button class="btn" data-fr="open" data-id="${esc(main)}">Open ${esc(frProg(main).full)}</button>` : ''}</div>`);
}

// ---------------------------------------------------------------- the quiet panel on the home screen (Keep using Central)
function frPanel() {
  const bar = $('#frbar'); if (!bar) return;
  const run = FR.run; const step = run && run.step;
  const wizOpen = !$('#wizard').hidden;
  if (!run || !run.items || !run.items.length || wizOpen || step !== 'background') { bar.hidden = true; return; }
  const s = FR.sum || {};
  const cur = run.items.find((i) => !['installed', 'skipped', 'failed', 'paused', 'waiting'].includes(i.stage));
  bar.hidden = false;
  const head = s.allDone ? 'Everything is installed' : s.waiting.length ? `Setting up Riyeser: ${s.done} of ${s.total} installed`
    : s.paused.length ? 'Setting up Riyeser: waiting for the internet' : `Couldn't install ${andNames(s.failed.map((id) => frProg(id).full))}`;
  const line = cur ? `${frProg(cur.id).full}: ${frText(cur)}` : s.allDone ? 'Your programs are on the home screen.' : s.paused.length ? 'It carries on by itself when this PC is back online.' : 'See what happened and try again.';
  bar.innerHTML = `<span style="font-size:22px" aria-hidden="true">${s.allDone ? '✅' : s.failed.length && !s.waiting.length ? '⚠️' : '⬇'}</span><div class="grow"><b>${esc(head)}</b>
    <div class="prog"><i class="instbar" style="width:${Math.round((s.total ? s.done / s.total : 0) * 100)}%"></i></div><div class="lbl">${esc(line)}</div></div>
    <button class="go" data-fr="show">${s.allDone ? 'Finish setting up' : 'Show'}</button>`;
}

// ---------------------------------------------------------------- events
async function frRun(fn) {
  if (FR.busy) return; FR.busy = true;
  try { await fn(); } catch (e) { toast(e.message); } finally { FR.busy = false; }
}
let frRefreshAt = 0;
bridge.on('firstrun-progress', ({ run, summary }) => {
  const before = FR.run && FR.run.items ? FR.run.items.filter((i) => i.stage === 'installed').length : 0;
  FR.run = run; FR.sum = summary;
  if (FR.screen === 'install' && !FR.choosing && !$('#wizard').hidden) {
    const busyBtn = document.querySelector('[data-fr="next"][disabled]');
    if (!summary.waiting.length && busyBtn) frShowInstall();
    else if (!document.querySelector('#frlist')) frShowInstall();
    else run.items.forEach((i) => frPatch(i.id));
  }
  frPanel();
  // the home screen's tiles follow as each program arrives
  const after = run.items.filter((i) => i.stage === 'installed').length;
  if (after !== before && Date.now() - frRefreshAt > 1500 && typeof refresh === 'function') { frRefreshAt = Date.now(); safe(refresh); }
});
window.addEventListener('online', () => { bridge.call('firstrun:resume').catch(() => {}); });

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fr]'); if (!b || b.disabled) return;
  const a = b.dataset.fr; const id = b.dataset.id;
  if (a === 'role') { document.querySelectorAll('.fropt').forEach((x) => x.setAttribute('aria-checked', String(x === b))); return; }
  if (a === 'role-go') { const r = (document.querySelector('.fropt[aria-checked="true"]') || {}).dataset; return frRun(async () => { await bridge.call('firstrun:role', (r && r.role) || 'everything'); await frLoad(); await frStartPlan(); }); }
  if (a === 'choose') { FR.choosing = true; return frShowInstall(); }
  if (a === 'choose-cancel') { FR.choosing = false; return frShowInstall(); }
  if (a === 'retry') return frRun(async () => { const r = await bridge.call('firstrun:retry', id ? [id] : null); FR.run = r.run; FR.sum = r.summary; frShowInstall(); });
  if (a === 'resume') return frRun(async () => { await bridge.call('firstrun:resume'); });
  if (a === 'help') {
    const i = (FR.run.items || []).find((x) => x.id === id) || {};
    return safe(() => reportIssue({ product: ({ 'accounting-basics': 'accounting', accounting: 'accounting', team: 'link', services: 'other' })[id] || id,
      what: `Installing ${frProg(id).full} in Riyeser Central's first run didn't work: ${i.message || ''}`.trim(), error: i.code != null ? `code ${i.code}${i.reason ? ` (${i.reason})` : ''}` : i.reason || '' }));
  }
  if (a === 'bg') { bridge.call('firstrun:step', 'background').then(() => { FR.run.step = 'background'; closeWizard(); frPanel(); afterChange(); safe(refresh); }); return; }
  if (a === 'show') {
    CO.first = true;
    bridge.call('firstrun:step', 'install').then(() => { FR.run.step = 'install'; $('#frbar').hidden = true;
      if (FR.sum && FR.sum.allDone) return frPath() === 'plan' ? frShowBusiness() : frShowDone(); return frShowInstall(); });
    return;
  }
  if (a === 'next') return frPath() === 'plan' ? frShowBusiness() : frShowDone();
  if (a === 'logo') return frRun(async () => { const r = await bridge.call('firstrun:logo'); if (r) { FR.logoUrl = r.dataUrl; FR.info.company = { ...FR.info.company, logo: r.logo };
    const form = $('#frbiz'); const keep = form ? Object.fromEntries(new FormData(form).entries()) : null; frShowBusiness();
    if (keep) { const f = $('#frbiz'); for (const [k, v] of Object.entries(keep)) if (f[k]) f[k].value = v; } } });
  if (a === 'skip') { bridge.call('firstrun:step', 'closed').catch(() => {}); bridge.call('company:skip').catch(() => {}); closeWizard(); CO.first = false; afterChange(); return; }
  if (a === 'home' || a === 'open') {
    bridge.call('firstrun:step', 'closed').catch(() => {}); closeWizard(); CO.first = false; afterChange(); safe(refresh); if (typeof setView === 'function') setView('home');
    if (a === 'open') safe(() => bridge.call('central:open', id));
  }
});

/** "Set up this PC without an account", or "Set up later": someone on their own picks the programs they want. */
async function frIndividual() {
  CO.first = true;
  try { await frLoad(); } catch (e) { toast(e.message); closeWizard(); return; }
  FR.info.path = 'individual';
  frShowPicker();
}

// On start: a first run that was under way carries on where it was (the install screen or Your business), and one that
// is installing in the background shows its quiet panel. Nothing new is asked.
(async () => {
  try {
    await frLoad();
    const run = FR.run; const step = run && run.step;
    let demo = null; try { demo = await bridge.call('demo:get'); } catch { /* normal mode */ }
    if (!run || (demo && demo.on) || !FR.info.company && FR.info.path === 'plan') return frPanel();
    if (['install', 'business'].includes(step) && $('#wizard').hidden && run.items && run.items.length) {
      CO.first = true;
      if (step === 'business') frShowBusiness(); else frShowInstall();
      return;
    }
    frPanel();
  } catch { /* the rest of Central works without it */ }
})();
window.RiyeserFirstRun = { afterLinked: frAfterLinked, individual: frIndividual, steps: frSteps, state: () => FR };
