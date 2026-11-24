/* Riyeser Team: team chat for a business. Channels, direct messages, live updates and unread counts.
   Runs on its own Supabase project (config.js, database in team-chat.sql). With ?demo, or before it's
   set up, it runs on sample data in this browser only, so anyone can try it. */
(() => {
  'use strict';
  const CFG = window.RIYESER_TEAM || {};
  const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo') || !CONFIGURED;
  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLOURS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#0d9488'];
  const colourOf = (id) => COLOURS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLOURS.length];
  const initials = (n) => (String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
  const av = (id, name, cls = '') => `<span class="av ${cls}" style="background:${colourOf(id)}" aria-hidden="true">${esc(initials(name))}</span>`;
  const plainError = (e) => {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/Invalid login/i.test(m)) return 'That email or password isn\'t right.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first: open the link we emailed you, then sign in.';
    if (/already registered/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
    if (/Password should be/i.test(m)) return 'Choose a password of at least 8 characters.';
    if (/Signups not allowed/i.test(m)) return 'New accounts aren\'t open yet. Ask Riyeser to turn on sign-ups.';
    if (/Invalid TOTP|mfa_verification_failed|expired/i.test(m)) return 'That code isn\'t right. Type the 6 numbers your authenticator app shows now (they change every 30 seconds).';
    if (/created_by_fkey|JWT|sub claim/i.test(m)) return 'Your sign-in has ended. Sign out, then sign in again.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Can\'t reach Riyeser Team. Check your internet connection and try again.';
    return m;
  };

  // ------------------------------------------------------------------ the online service (Supabase)
  function onlineBackend() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.team.session' } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    let sub = null;
    return {
      demo: false,
      async session() {
        const s = ok(await sb.auth.getSession()).session; if (!s) return null;
        // The browser can remember a sign-in for an account that was since removed: ask the server, and sign out if it's gone.
        const { error } = await sb.auth.getUser();
        if (error && [401, 403, 404].includes(error.status)) { await sb.auth.signOut({ scope: 'local' }).catch(() => {}); S.signedOutNote = true; return null; }
        return s;
      },
      onAuth(fn) { sb.auth.onAuthStateChange((_e, s) => fn(s)); },
      async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })); },
      async signUp(email, password) {
        return ok(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname + location.search } }));
      },
      async resetPassword(email) { return ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); },
      async signOut() { if (sub) sb.removeChannel(sub); await sb.auth.signOut(); },
      async teams(uid) {
        const cols = 'id, name, invite_code, company_code, legal_name, tax_number, address, phone, email, country, require_approval';
        // 'kind' (just me / business) arrived later: still works on a database that hasn't been updated yet
        let res = await sb.from('members').select(`role, job_role, display_name, workspaces(${cols}, kind)`).eq('user_id', uid);
        if (res.error) res = await sb.from('members').select(`role, job_role, display_name, workspaces(${cols})`).eq('user_id', uid);
        const rows = ok(res);
        return rows.filter((r) => r.workspaces).map((r) => ({ ...r.workspaces, role: r.role, jobRole: r.job_role, myName: r.display_name }));
      },
      async createTeam(name, you, profile) { return ok(await sb.rpc('create_company', { company_name: name, your_name: you, profile: profile || {} })); },
      async requestJoin(code, you, note) { return ok(await sb.rpc('request_join', { code, your_name: you, note: note || '' })); },
      async myRequests() { return ok(await sb.rpc('my_join_requests')); },
      async pendingRequests(ws) {
        const r = ok(await sb.from('join_requests').select('id, display_name, email, branch_id, note, created_at').eq('workspace_id', ws).eq('status', 'pending').order('created_at'));
        return r;
      },
      async decideJoin(id, approve, job, admin, branches) { ok(await sb.rpc('decide_join', { request: id, approve, job_role: job, make_admin: !!admin, branch_ids: branches || [] })); },
      async setAccess(ws, person, job, admin, branches) { ok(await sb.rpc('set_access', { ws, person, job_role: job, make_admin: !!admin, branch_ids: branches || [] })); },
      async removePerson(ws, person) { ok(await sb.from('members').delete().eq('workspace_id', ws).eq('user_id', person)); },
      async updateCompany(ws, profile) { ok(await sb.rpc('update_company', { ws, profile })); },
      async devices(ws) { return ok(await sb.from('devices').select('id, user_id, device_name, platform, app_version, last_seen').eq('workspace_id', ws).order('last_seen', { ascending: false })); },
      async unlinkDevice(id) { ok(await sb.from('devices').delete().eq('id', id)); },
      async aal() { return ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel()); },
      async factors() { const f = ok(await sb.auth.mfa.listFactors()); return (f.totp || []).filter((x) => x.status === 'verified'); },
      async enrol() { const r = ok(await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Riyeser ' + new Date().toISOString().slice(0, 16) }));
        return { id: r.id, qr: r.totp.qr_code, secret: r.totp.secret }; },
      async verifyCode(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      async unenrol(factorId) { ok(await sb.auth.mfa.unenroll({ factorId })); },
      async licence(ws) { return ok(await sb.rpc('company_licence', { ws })); },
      async history(ws) { return ok(await sb.from('audit_log').select('id, at, actor, action, details').eq('workspace_id', ws).order('at', { ascending: false }).limit(200)); },
      async joinTeam(code, you) { return ok(await sb.rpc('join_team', { code, your_name: you })); },
      async newInvite(ws) { return ok(await sb.rpc('new_invite_code', { ws })); },
      async people(ws) { return ok(await sb.from('members').select('user_id, display_name, role, job_role, extension').eq('workspace_id', ws).order('display_name')); },
      async channels(ws) {
        const chans = ok(await sb.from('channels').select('id, kind, name, topic, created_by').eq('workspace_id', ws).eq('archived', false).order('name'));
        const dms = chans.filter((c) => c.kind !== 'channel').map((c) => c.id);
        const cm = dms.length ? ok(await sb.from('channel_members').select('channel_id, user_id').in('channel_id', dms)) : [];
        return chans.map((c) => ({ ...c, people: cm.filter((x) => x.channel_id === c.id).map((x) => x.user_id) }));
      },
      async createChannel(ws, uid, name, topic) {
        return ok(await sb.from('channels').insert({ workspace_id: ws, kind: 'channel', name, topic: topic || null, created_by: uid }).select('id').single()).id;
      },
      async createPrivate(ws, name, topic, people) {
        return ok(await sb.rpc('create_private_channel', { ws, channel_name: name, channel_topic: topic || '', people }));
      },
      async setPeople(ch, add, remove) { ok(await sb.rpc('set_channel_people', { ch, add_people: add, remove_people: remove })); },
      async leave(ch, uid) { ok(await sb.from('channel_members').delete().eq('channel_id', ch).eq('user_id', uid)); },
      async openDm(ws, person) { return ok(await sb.rpc('open_dm', { ws, person })); },
      async messages(ch) {
        const rows = ok(await sb.from('messages').select('*').eq('channel_id', ch).order('created_at', { ascending: false }).limit(200));
        return rows.reverse();
      },
      async send(ws, ch, body) { return ok(await sb.from('messages').insert({ workspace_id: ws, channel_id: ch, body }).select('*').single()); },
      async edit(id, body) { ok(await sb.from('messages').update({ body }).eq('id', id)); },
      async remove(id) { ok(await sb.from('messages').update({ deleted: true, body: '(deleted)' }).eq('id', id)); },
      async markRead(ch, uid) { await sb.from('reads').upsert({ channel_id: ch, user_id: uid, last_read_at: new Date().toISOString() }); },
      async unread(ws) { const r = ok(await sb.rpc('unread_counts', { ws })); return Object.fromEntries(r.map((x) => [x.channel_id, Number(x.unread)])); },
      async features(ws) { return ok(await sb.rpc('team_features', { ws })) || { calls: false }; },
      async branches(ws) {
        const rows = ok(await sb.from('branches').select('id, name, code, extension, branch_members(user_id)').eq('workspace_id', ws).order('extension'));
        return rows.map((b) => ({ id: b.id, name: b.name, code: b.code, extension: b.extension, people: (b.branch_members || []).map((x) => x.user_id) }));
      },
      async createBranch(ws, name) { return ok(await sb.rpc('create_branch', { ws, branch_name: name })); },
      async newBranchCode(branch) { return ok(await sb.rpc('new_branch_code', { branch })); },
      async setBranchPeople(branch, add, remove) {
        if (add.length) ok(await sb.from('branch_members').insert(add.map((user_id) => ({ branch_id: branch, user_id }))));
        if (remove.length) ok(await sb.from('branch_members').delete().eq('branch_id', branch).in('user_id', remove));
      },
      async setExtension(ws, person, ext) { ok(await sb.rpc('set_extension', { ws, person, ext })); },
      async signal(ws, call, to, kind, payload) {
        ok(await sb.from('call_signals').insert({ workspace_id: ws, call_id: call, to_user: to, kind, payload: payload || null }));
      },
      async tidyCall(call) { await sb.from('call_signals').delete().eq('call_id', call); },
      onSignals(uid, fn) {
        sb.channel('calls-' + uid)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_signals', filter: 'to_user=eq.' + uid }, (p) => fn(p.new))
          .subscribe();
      },
      live(ws, onChange) {
        if (sub) sb.removeChannel(sub);
        sub = sb.channel('team-' + ws)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'workspace_id=eq.' + ws }, (p) => onChange(p.new))
          .subscribe();
      },
    };
  }

  // ------------------------------------------------------------------ the demo (sample data, this browser only)
  function demoBackend() {
    const AS = /^u-(me|sam|jordan|alex)$/.test(params.get('as') || '') ? params.get('as') : 'u-me';
    const me = { id: AS, email: AS.slice(2) + '@sample.test' };
    const ws = 'w-demo';
    const ppl = [['u-me', 'You', 'owner', 101, 'owner'], ['u-sam', 'Sam Taylor', 'admin', 102, 'manager'], ['u-jordan', 'Jordan Lee', 'member', 201, 'staff'], ['u-alex', 'Alex Nguyen', 'member', 202, 'sales']];
    const mfa = { on: true };
    const company = { name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', legal_name: 'Sample Plumbing Pty Ltd', tax_number: '12 345 678 901', address: '4 Harbour Rd, Suva', phone: '330 1234', email: 'office@sample.test', country: 'Fiji', require_approval: true };
    const reqs = [{ id: 'r1', display_name: 'Mere Vula', email: 'mere@sample.test', branch_id: 'b-lau', note: 'New front desk at Lautoka', created_at: new Date(Date.now() - 25 * 60000).toISOString(), status: 'pending' }];
    const devs = [{ id: 'd1', user_id: 'u-me', device_name: 'Head office PC', platform: 'Windows', app_version: '1.7.0', last_seen: new Date(Date.now() - 2 * 60000).toISOString() },
      { id: 'd2', user_id: 'u-jordan', device_name: 'Lautoka front desk', platform: 'Windows', app_version: '1.7.0', last_seen: new Date(Date.now() - 3 * 3600000).toISOString() }];
    const brs = [{ id: 'b-head', name: 'Head office', code: 'HEA-3071', extension: 100, people: ['u-me', 'u-sam'] },
      { id: 'b-lau', name: 'Lautoka branch', code: 'LAU-4821', extension: 200, people: ['u-jordan', 'u-alex'] }];
    // Calls in the demo travel between browser tabs (open the demo again with ?demo&as=u-sam to be Sam).
    const bus = 'BroadcastChannel' in window ? new BroadcastChannel('riyeser-team-demo-calls') : null;
    const online = new Set([AS]); let onSig = null;
    if (bus) {
      bus.onmessage = (e) => { const m = e.data || {};
        if (m.hello) { online.add(m.hello); if (!m.reply) bus.postMessage({ hello: AS, reply: true }); return; }
        if (m.to === AS && onSig) onSig(m); };
      bus.postMessage({ hello: AS });
    }
    const now = Date.now(); const ago = (m) => new Date(now - m * 60000).toISOString();
    const chans = [{ id: 'c-general', kind: 'channel', name: 'general', topic: 'Everyone in the team', people: [] },
      { id: 'c-jobs', kind: 'channel', name: 'jobs', topic: 'Jobs, bookings and what\'s on today', people: [] },
      { id: 'c-office', kind: 'channel', name: 'office', topic: 'Invoices, bills and paperwork', people: [] },
      { id: 'c-exec', kind: 'private', name: 'executives', topic: 'Owners and managers only', people: ['u-me', 'u-sam'], created_by: 'u-me' },
      { id: 'd-sam', kind: 'dm', name: null, topic: null, people: ['u-me', 'u-sam'] }];
    let n = 0; const msg = (ch, u, body, m) => ({ id: 'm' + (++n), channel_id: ch, workspace_id: ws, user_id: u, body, created_at: ago(m), edited_at: null, deleted: false });
    const msgs = [
      msg('c-general', 'u-sam', 'Morning all ☀️ Toolbox talk at 7:15 in the yard.', 1500),
      msg('c-general', 'u-alex', 'Van 2 is booked in for a service Thursday, so I\'ll take van 3.', 1480),
      msg('c-jobs', 'u-me', 'New job: Booking 12 for Jo Smith, hot water service at 4 Elm St, 10:00 today. @Jordan can you take it?', 95),
      msg('c-jobs', 'u-jordan', 'On it 👍 Heading there after the Harbour Cafe call-out.', 90),
      msg('c-jobs', 'u-jordan', 'Booking 12 done. Old unit removed, new 315L installed and tested. Photos in As Built.', 18),
      msg('c-office', 'u-sam', 'INV-1047 from Sample Customer Pty Ltd is 4 days overdue ($880). I\'ll give them a call.', 60),
      msg('c-office', 'u-sam', 'They paid! INV-1047 is cleared ✅', 8),
      msg('c-exec', 'u-sam', 'Q3 numbers are in. Margins up 4% on last quarter. Can we talk pricing for next year on Friday?', 240),
      msg('d-sam', 'u-sam', 'Can you approve the timesheets before 3? Pay run goes tonight.', 30)];
    const read = { 'c-general': ago(1400), 'c-jobs': ago(92), 'c-office': ago(61), 'c-exec': ago(200), 'd-sam': ago(40) };
    let listener = null;
    const reply = (ch, from, body, ms) => setTimeout(() => { const m = msg(ch, from, body, 0); m.created_at = new Date().toISOString(); msgs.push(m); listener && listener(m); }, ms);
    return {
      demo: true,
      async session() { return { user: me }; },
      onAuth() {},
      async signIn() { return { user: me }; }, async signUp() { return { user: me }; }, async resetPassword() {},
      async signOut() { location.href = '/team/'; },
      async teams() { return [{ id: ws, ...company, invite_code: 'DEMO1234', role: AS === 'u-me' ? 'owner' : AS === 'u-sam' ? 'admin' : 'member', myName: 'You' }]; },
      async requestJoin(code) { return { status: 'pending', company_name: 'Sample Plumbing', workspace_id: ws, code }; },
      async myRequests() { return []; },
      async pendingRequests() { return reqs.filter((r) => r.status === 'pending'); },
      async decideJoin(id, approve, job, admin, branches) { const r = reqs.find((x) => x.id === id); r.status = approve ? 'approved' : 'declined';
        if (approve) { const uid = 'u-' + r.display_name.split(' ')[0].toLowerCase(); const b = brs.find((x) => x.id === ((branches && branches[0]) || r.branch_id)) || brs[0];
          const ext = Math.max(b.extension, ...ppl.filter((q) => q[3] > b.extension && q[3] < b.extension + 100).map((q) => q[3])) + 1;
          ppl.push([uid, r.display_name, admin ? 'admin' : 'member', ext, job]); (branches && branches.length ? branches : [b.id]).forEach((bid) => brs.find((x) => x.id === bid).people.push(uid)); } },
      async setAccess(_w, person, job, admin, branches) { const q = ppl.find((x) => x[0] === person); if (q[2] !== 'owner') { q[2] = admin ? 'admin' : 'member'; q[4] = job; }
        brs.forEach((b) => { b.people = b.people.filter((u) => u !== person); if (branches.includes(b.id)) b.people.push(person); }); },
      async removePerson(_w, person) { const i = ppl.findIndex((x) => x[0] === person); if (i >= 0) ppl.splice(i, 1); brs.forEach((b) => { b.people = b.people.filter((u) => u !== person); }); },
      async updateCompany(_w, pr) { Object.assign(company, Object.fromEntries(Object.entries(pr).filter(([, v]) => v !== undefined))); },
      async devices() { return devs.slice(); },
      async unlinkDevice(id) { const i = devs.findIndex((d) => d.id === id); if (i >= 0) devs.splice(i, 1); },
      async aal() { return { currentLevel: mfa.on ? 'aal2' : 'aal1', nextLevel: mfa.on ? 'aal2' : 'aal1' }; },
      async factors() { return mfa.on ? [{ id: 'f1', status: 'verified' }] : []; },
      async enrol() { return { id: 'f1', secret: 'JBSWY3DPEHPK3PXP', qr: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/>' + [...Array(120)].map((_, i) => `<rect x="${(i * 7) % 21}" y="${Math.floor(i * 7 / 21) % 21}" width="1" height="1"/>`).join('') + '<rect x="0" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="14" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="0" y="14" width="7" height="7" fill="none" stroke="#000"/></svg>') }; },
      async verifyCode(_f, code) { if (!/^\d{6}$/.test(code)) throw new Error('That code isn\'t right. Check the 6 numbers in your authenticator app.'); mfa.on = true; },
      async unenrol() { mfa.on = false; },
      async licence() { const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
        return { modules: { basic: { status: 'active', active: true, paid_until: d(200), days_left: 200 }, plus: { status: 'trial', active: true, trial_ends: d(10), days_left: 10 },
          payroll: { status: 'ended', active: false }, pos: { status: 'trial', active: true, trial_ends: d(10), days_left: 10 }, bookings: { status: 'trial', active: true, trial_ends: d(10), days_left: 10 },
          as_built: { status: 'trial', active: true, trial_ends: d(10), days_left: 10 }, calls: { status: 'trial', active: true, trial_ends: d(10), days_left: 10 } },
          seats: { included: 3, extra: 2, used: 4 }, extra_companies: 0, billing: 'monthly', early_bird: true }; },
      async history() { const t = (m) => new Date(Date.now() - m * 60000).toISOString();
        return [{ id: 5, at: t(3), actor: 'u-me', action: 'devices.delete', details: { device_name: 'Lautoka front desk' } },
          { id: 4, at: t(9), actor: 'u-me', action: 'members.update', details: { job_role: { was: 'staff', now: 'bookkeeper' }, user_id: 'u-jordan' } },
          { id: 3, at: t(30), actor: 'u-me', action: 'join_request.approved', details: { display_name: { was: 'Mere Vula', now: 'Mere Vula' } } },
          { id: 2, at: t(1440), actor: 'u-sam', action: 'branches.insert', details: { name: 'Lautoka branch', extension: 200 } },
          { id: 1, at: t(2880), actor: 'u-me', action: 'workspaces.update', details: { phone: { was: '330 0000', now: '330 1234' } } }]; },
      async createTeam() { return ws; }, async joinTeam() { return ws; }, async newInvite() { return 'DEMO' + Math.floor(1000 + Math.random() * 9000); },
      async people() { return ppl.map(([user_id, display_name, role, extension, job_role]) => ({ user_id, display_name, role, extension, job_role: job_role || (role === 'owner' ? 'owner' : 'staff') })); },
      async features() { return { calls: true, calls_paid: false, trial_days_left: 74 }; },
      async branches() { return brs.map((b) => ({ ...b, people: b.people.slice() })); },
      async createBranch(_w, name) { const ext = Math.max(...brs.map((b) => b.extension)) + 100;
        brs.push({ id: 'b-' + Date.now(), name, code: name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'B') + '-' + Math.floor(1000 + Math.random() * 9000), extension: ext, people: [] }); },
      async newBranchCode(b) { const x = brs.find((y) => y.id === b); x.code = x.code.slice(0, 4) + Math.floor(1000 + Math.random() * 9000); return x.code; },
      async setBranchPeople(b, add, remove) { const x = brs.find((y) => y.id === b); x.people = [...new Set([...x.people, ...add])].filter((u) => !remove.includes(u)); },
      async setExtension(_w, person, ext) {
        if (ppl.some((q) => q[3] === ext && q[0] !== person) || brs.some((b) => b.extension === ext)) throw new Error(`Extension ${ext} is already used`);
        ppl.find((q) => q[0] === person)[3] = ext; },
      async signal(_w, call, to, kind, payload) {
        const m = { call_id: call, from_user: AS, to_user: to, to, kind, payload: payload || null, created_at: new Date().toISOString() };
        if (bus && online.has(to)) bus.postMessage(m);
        else if (kind === 'ring' && onSig && online.size === 1) setTimeout(() => onSig({ ...m, from_user: to, to_user: AS, kind: 'accept', payload: { demo: true } }), 2200);
      },
      async tidyCall() {},
      onSignals(_u, fn) { onSig = fn; },
      async channels() { return chans.slice(); },
      async createChannel(_w, _u, name, topic) { const id = 'c-' + name; chans.push({ id, kind: 'channel', name, topic, people: [], created_by: 'u-me' }); return id; },
      async createPrivate(_w, name, topic, people) { const id = 'p-' + name; chans.push({ id, kind: 'private', name, topic, people: ['u-me', ...people.filter((x) => x !== 'u-me')], created_by: 'u-me' }); return id; },
      async setPeople(ch, add, remove) { const c = chans.find((x) => x.id === ch); c.people = [...new Set([...c.people, ...add])].filter((x) => !remove.includes(x)); },
      async leave(ch) { const i = chans.findIndex((x) => x.id === ch); if (i >= 0) chans.splice(i, 1); },
      async openDm(_w, person) {
        let c = chans.find((x) => x.kind === 'dm' && x.people.includes(person));
        if (!c) { c = { id: 'd-' + person, kind: 'dm', name: null, topic: null, people: ['u-me', person] }; chans.push(c); }
        return c.id;
      },
      async messages(ch) { return msgs.filter((m) => m.channel_id === ch).sort((a, b) => a.created_at.localeCompare(b.created_at)); },
      async send(_w, ch, body) {
        const m = msg(ch, 'u-me', body, 0); m.created_at = new Date().toISOString(); msgs.push(m);
        const dm = chans.find((c) => c.id === ch && c.kind === 'dm');
        if (dm) reply(ch, dm.people.find((p) => p !== 'u-me'), 'Thanks, all sorted 👍', 1800);
        else if (/@jordan/i.test(body)) reply(ch, 'u-jordan', 'No worries, I\'ll take it.', 1800);
        return m;
      },
      async edit(id, body) { const m = msgs.find((x) => x.id === id); if (m) { m.body = body; m.edited_at = new Date().toISOString(); } },
      async remove(id) { const m = msgs.find((x) => x.id === id); if (m) { m.deleted = true; m.body = '(deleted)'; } },
      async markRead(ch) { read[ch] = new Date().toISOString(); },
      async unread() {
        const out = {};
        for (const c of chans) out[c.id] = msgs.filter((m) => m.channel_id === c.id && m.user_id !== 'u-me' && !m.deleted && m.created_at > (read[c.id] || '')).length;
        return out;
      },
      live(_w, fn) { listener = fn; },
    };
  }

  const api = DEMO ? demoBackend() : onlineBackend();
  const S = { user: null, teams: [], team: null, people: [], chans: [], unread: {}, ch: null, msgs: [], inChat: false, editing: null,
    features: { calls: false }, branches: [], requests: [] };
  const JOBS = [['manager', 'Manager'], ['bookkeeper', 'Bookkeeper'], ['sales', 'Sales'], ['payroll', 'Payroll'], ['staff', 'Staff'], ['readonly', 'Read-only']];
  const isAdmin = () => !!S.team && (S.team.role === 'owner' || S.team.role === 'admin');
  // Owners and admins need two-step sign-in before their admin powers work (the database checks this too).
  const needs2step = () => isAdmin() && S.aal !== 'aal2';
  const jobName = (j) => (JOBS.find((x) => x[0] === j) || [j, j === 'owner' ? 'Owner' : 'Staff'])[1];
  const nameOf = (uid) => (S.people.find((p) => p.user_id === uid) || {}).display_name || 'Someone who left';
  const chanLabel = (c) => (c.kind === 'dm' ? nameOf(c.people.find((p) => p !== S.user.id) || S.user.id) : c.name);
  const demoBar = () => (DEMO ? `<div class="demo-bar">This is a demo with sample messages and calls${CONFIGURED ? ` · <a href="/team/">Sign in for real</a>` : ''} · <a href="/programs/team.html">About Riyeser Team</a></div>` : '');

  // ------------------------------------------------------------------ sign in / create account
  function gate(mode = 'in', note = '') {
    const join = params.get('join');
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><form class="gcard" id="gf">${/Electron/.test(navigator.userAgent) ? '' : '<a class="gback" href="/">← Back to riyeser.com</a>'}
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      ${mode !== 'reset' ? `<div class="gtabs" role="tablist"><button type="button" role="tab" data-go="in" class="${mode === 'in' ? 'on' : ''}" aria-selected="${mode === 'in'}">Sign in</button><button type="button" role="tab" data-go="up" class="${mode === 'up' ? 'on' : ''}" aria-selected="${mode === 'up'}">Create account</button></div>` : ''}
      <h1>${mode === 'up' ? 'Create your Riyeser account' : mode === 'reset' ? 'Reset your password' : 'Sign in to Riyeser'}</h1>
      <p>${join ? 'You\'ve been invited to a team. ' : ''}${mode === 'up' ? 'Free. One account for you, your business and every Riyeser program.' : mode === 'reset' ? 'We\'ll email you a link to choose a new password.' : 'One account for you, your business and all your Riyeser programs.'}</p>
      ${note}
      <label class="f"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
      ${mode !== 'reset' ? `<label class="f"><span>Password</span><input type="password" name="password" minlength="8" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" required></label>` : ''}
      <button class="btn p w" type="submit">${mode === 'up' ? 'Create account' : mode === 'reset' ? 'Send the link' : 'Sign in'}</button>
      ${mode === 'up' ? `<button type="button" class="btn w gcancel" id="gcancel">Cancel</button>` : ''}
      <div class="alt">${mode === 'in' ? `<button type="button" class="linkbtn" data-go="reset">Forgot password?</button></div>
      <div class="or">New to Riyeser?</div><button type="button" class="btn w" data-go="up">Create a free account</button><div class="alt" hidden>`
        : `Already have an account? <button type="button" class="linkbtn" data-go="in">Sign in</button>`}</div></form></div>`;
    $app.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => gate(b.dataset.go));
    // Cancel: back to riyeser.com (in the Windows app, back to Sign in)
    const cx = $app.querySelector('#gcancel'); if (cx) cx.onclick = () => (/Electron/.test(navigator.userAgent) ? gate('in') : location.assign('/'));
    $app.querySelector('#gf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        if (mode === 'reset') { await api.resetPassword(f.get('email')); return gate('in', '<div class="ok">Check your email for the link.</div>'); }
        if (mode === 'up') {
          const r = await api.signUp(f.get('email'), f.get('password'));
          if (!r.session) return gate('in', '<div class="ok">Nearly there: open the link we just emailed you, then sign in here.</div>');
        } else await api.signIn(f.get('email'), f.get('password'));
        await start();
      } catch (err) { btn.disabled = false; gate(mode, `<div class="err">${esc(plainError(err))}</div>`); }
    };
  }

  // ------------------------------------------------------------------ create or join a team
  // Every country, named in English, with its phone prefix (from the libphonenumber region list). Fiji, Australia and NZ first.
  const DIAL = Object.fromEntries('AC247,AD376,AE971,AF93,AG1,AI1,AL355,AM374,AO244,AR54,AS1,AT43,AU61,AW297,AX358,AZ994,BA387,BB1,BD880,BE32,BF226,BG359,BH973,BI257,BJ229,BL590,BM1,BN673,BO591,BQ599,BR55,BS1,BT975,BW267,BY375,BZ501,CA1,CC61,CD243,CF236,CG242,CH41,CI225,CK682,CL56,CM237,CN86,CO57,CR506,CU53,CV238,CW599,CX61,CY357,CZ420,DE49,DJ253,DK45,DM1,DO1,DZ213,EC593,EE372,EG20,EH212,ER291,ES34,ET251,FI358,FJ679,FK500,FM691,FO298,FR33,GA241,GB44,GD1,GE995,GF594,GG44,GH233,GI350,GL299,GM220,GN224,GP590,GQ240,GR30,GT502,GU1,GW245,GY592,HK852,HN504,HR385,HT509,HU36,ID62,IE353,IL972,IM44,IN91,IO246,IQ964,IR98,IS354,IT39,JE44,JM1,JO962,JP81,KE254,KG996,KH855,KI686,KM269,KN1,KP850,KR82,KW965,KY1,KZ7,LA856,LB961,LC1,LI423,LK94,LR231,LS266,LT370,LU352,LV371,LY218,MA212,MC377,MD373,ME382,MF590,MG261,MH692,MK389,ML223,MM95,MN976,MO853,MP1,MQ596,MR222,MS1,MT356,MU230,MV960,MW265,MX52,MY60,MZ258,NA264,NC687,NE227,NF672,NG234,NI505,NL31,NO47,NP977,NR674,NU683,NZ64,OM968,PA507,PE51,PF689,PG675,PH63,PK92,PL48,PM508,PR1,PS970,PT351,PW680,PY595,QA974,RE262,RO40,RS381,RU7,RW250,SA966,SB677,SC248,SD249,SE46,SG65,SH290,SI386,SJ47,SK421,SL232,SM378,SN221,SO252,SR597,SS211,ST239,SV503,SX1,SY963,SZ268,TA290,TC1,TD235,TG228,TH66,TJ992,TK690,TL670,TM993,TN216,TO676,TR90,TT1,TV688,TW886,TZ255,UA380,UG256,US1,UY598,UZ998,VA39,VC1,VE58,VG1,VI1,VN84,VU678,WF681,WS685,XK383,YE967,YT262,ZA27,ZM260,ZW263'.split(',').map((x) => [x.slice(0, 2), '+' + x.slice(2)]));
  const COUNTRY_NAMES = (() => { let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old browser */ }
    return Object.keys(DIAL).map((c) => [c, (dn && dn.of(c)) || c]).sort((a, b) => a[1].localeCompare(b[1])); })();
  function countryOptions(sel = 'Fiji') {
    const top = ['FJ', 'AU', 'NZ']; const name = (c) => (COUNTRY_NAMES.find((x) => x[0] === c) || [c, c])[1];
    const opt = (c, n) => `<option value="${esc(n)}" data-dial="${DIAL[c] || ''}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`;
    return top.map((c) => opt(c, name(c))).join('') + '<option disabled>──────────</option>'
      + COUNTRY_NAMES.filter(([c]) => !top.includes(c)).map(([c, n]) => opt(c, n)).join('');
  }
  function setupTeam(note = '', mode = params.get('join') ? 'join' : 'new') {
    const join = params.get('join') || '';
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    const newForm = `<form id="cf"><h1>A few details</h1><p>Nearly done. This is how you'll appear in Riyeser.</p>
        <label class="f"><span>Your name</span><input name="you" required maxlength="60" autocomplete="name"></label>
        <div class="f2"><label class="f"><span>Mobile number</span><input name="phone" type="tel" required maxlength="40" autocomplete="tel" placeholder="e.g. +679 912 3456"></label>
          <label class="f"><span>Country</span><select name="country" autocomplete="country-name">${countryOptions()}</select></label></div>
        <label class="f"><span>Contact email</span><input name="email" type="email" required maxlength="120" autocomplete="email" value="${esc((S.user && S.user.email) || '')}"></label>
        <fieldset class="opt-set"><legend>Business details <small>Optional. Add them now or later; they're used on your invoices and in your programs.</small></legend>
          <label class="f"><span>Business name</span><input name="team" maxlength="80" autocomplete="organization" placeholder="Only if you have one"></label>
          <div class="f2"><label class="f"><span>Legal name</span><input name="legal_name" maxlength="120" placeholder="If different"></label>
            <label class="f"><span>ABN / TIN</span><input name="tax_number" maxlength="40"></label></div>
          <label class="f"><span>Business address</span><input name="address" maxlength="300" autocomplete="street-address"></label></fieldset>
        <button class="btn p w">Finish signing up</button></form>
      <div class="or">Joining someone else's business?</div>
      <button type="button" class="btn w" id="tojoin">Join with their code</button>`;
    const joinForm = `<form id="jf"><h1>Join someone's business</h1><p>Enter the code they gave you (like RIY-7K3M-Q2). They approve you, then you're in.</p>
        <label class="f"><span>Their code</span><input name="code" value="${esc(join)}" required autocapitalize="characters" placeholder="RIY-…"></label>
        <label class="f"><span>Your name, as they'll see it</span><input name="you" required maxlength="60"></label>
        <label class="f"><span>A note for them (optional)</span><input name="note" maxlength="300" placeholder="e.g. New at the Lautoka front desk"></label>
        <button class="btn p w">Ask to join</button></form>
      <div class="or">Not joining anyone?</div>
      <button type="button" class="btn w" id="tonew">Set up my own account</button>`;
    $app.innerHTML = `<div class="gate"><div class="gcard">
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      ${note}${mode === 'join' ? joinForm : newForm}
      <div class="alt"><button class="linkbtn" id="so">Cancel and sign out</button></div></div></div>`;
    const cs = $app.querySelector('#cf [name=country]'); const ph = $app.querySelector('#cf [name=phone]');
    if (cs && ph) cs.onchange = () => { const d = cs.selectedOptions[0] && cs.selectedOptions[0].dataset.dial; ph.placeholder = d ? `e.g. ${d} …` : 'Your mobile number'; };
    const sw = $app.querySelector(mode === 'join' ? '#tonew' : '#tojoin'); sw.onclick = () => setupTeam('', mode === 'join' ? 'new' : 'join');
    const fail = (e) => setupTeam(`<div class="err">${esc(plainError(e))}</div>`, mode);
    const jf = $app.querySelector('#jf'); if (jf) jf.onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const r = await api.requestJoin(String(f.get('code')), String(f.get('you')), String(f.get('note') || ''));
        history.replaceState(null, '', location.pathname);
        if (r.status === 'member') return start();
        waiting(r.company_name); } catch (err) { fail(err); }
    };
    const cf = $app.querySelector('#cf'); if (cf) cf.onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      // Everyone starts as an individual; a business name makes it a business account.
      const you = String(f.get('you')).trim(); const biz = String(f.get('team') || '').trim(); const kind = biz ? 'business' : 'personal';
      const v = (k) => String(f.get(k) || '').trim();
      try { await api.createTeam(biz || you, you, { kind, country: v('country'), phone: v('phone'), email: v('email'), legal_name: v('legal_name'), tax_number: v('tax_number'), address: v('address') });
        history.replaceState(null, '', location.pathname); await start(); if (S.team) companyInfo(true); } catch (err) { fail(err); }
    };
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
  }

  // Asked to join: wait for the company to approve (checks every 15 seconds).
  let waitTimer = null;
  function waiting(company, declined) {
    clearInterval(waitTimer);
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><div class="gcard">
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      ${declined ? `<h1>${esc(company)} didn't approve this</h1><p>Check with them, or ask to join with a different Company ID.</p><button class="btn p w" id="again">Try another code</button>`
        : `<h1>Waiting for ${esc(company)}</h1><p>We've asked them to let you in. As soon as an owner or admin approves you, you're in: this page checks by itself.</p>
          <div class="waitdots" aria-hidden="true"><i></i><i></i><i></i></div><button class="btn w" id="chk">Check now</button>`}
      <div class="alt"><button class="linkbtn" id="other">Use a different code</button> · <button class="linkbtn" id="so">Sign out</button></div></div></div>`;
    const check = async () => {
      try {
        S.teams = await api.teams(S.user.id);
        if (S.teams.length) { clearInterval(waitTimer); return start(); }
        const r = (await api.myRequests())[0];
        if (r && r.status === 'declined') { clearInterval(waitTimer); waiting(r.company_name, true); }
      } catch { /* try again next time */ }
    };
    const on = (id, fn) => { const el = $app.querySelector(id); if (el) el.onclick = fn; };
    on('#chk', check); on('#again', () => setupTeam()); on('#other', () => { clearInterval(waitTimer); setupTeam(); });
    on('#so', async () => { clearInterval(waitTimer); await api.signOut(); gate(); });
    if (!declined) waitTimer = setInterval(check, 15000);
  }


  // ---------------- two-step sign-in
  // At sign-in, when it's turned on: the 6-number code from the authenticator app.
  async function codeScreen(note = '') {
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><form class="gcard" id="cs">
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      <h1>🔐 Enter your code</h1><p>Open your authenticator app and type the 6 numbers shown for Riyeser.</p>${note}
      <label class="f"><span>Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="dpn"></label>
      <button class="btn p w">Continue</button>
      <div class="alt">Lost your phone? Ask your company's owner, or Riyeser support, to reset it. · <button type="button" class="linkbtn" id="so">Sign out</button></div></form></div>`;
    $app.querySelector('input').focus();
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
    $app.querySelector('#cs').onsubmit = async (e) => {
      e.preventDefault();
      try { const f = (await api.factors())[0]; await api.verifyCode(f.id, String(new FormData(e.target).get('code')).trim()); await start(); }
      catch (err) { codeScreen(`<div class="err">${esc(plainError(err))}</div>`); }
    };
  }

  // Turn two-step sign-in on (scan a QR code, type the code) or off.
  async function security() {
    const on = (await api.factors().catch(() => [])).length > 0;
    if (on) {
      modal(`<h3>🔐 Two-step sign-in is on</h3><p>Signing in needs your password and a code from your authenticator app. That stops someone who learns your password.</p>
        ${isAdmin() ? '<p><b>As an owner or admin you need it</b> to approve people, change access and see the history.</p>' : ''}
        <div class="mfoot"><button class="btn" id="off" style="margin-right:auto;color:#b91c1c">Turn it off</button><button class="btn p" id="cl">Done</button></div>`, (d, close) => {
        d.querySelector('#cl').onclick = close;
        d.querySelector('#off').onclick = async () => {
          if (!confirm(isAdmin() ? 'Turn off two-step sign-in? Your admin powers stop until you turn it on again.' : 'Turn off two-step sign-in?')) return;
          try { const f = (await api.factors())[0]; await api.unenrol(f.id); S.aal = 'aal1'; close(); renderSide(); } catch (err) { alert(plainError(err)); }
        };
      });
      return;
    }
    let en;
    try { en = await api.enrol(); } catch (err) { alert(plainError(err)); return; }
    modal(`<h3>🔐 Turn on two-step sign-in</h3>
      <ol class="steps"><li>Install an authenticator app on your phone, such as <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> (free).</li>
      <li>In the app, add an account and <b>scan this code</b>:<div class="qr"><img src="${en.qr}" alt="QR code to scan"></div>
        <small class="muted">Can't scan? Type this key instead: <code>${esc(en.secret)}</code></small></li>
      <li>Type the <b>6 numbers</b> the app shows:</li></ol>
      <form id="vf"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="dpn" aria-label="6-number code">
      <div class="mfoot"><button type="button" class="btn" id="cl">Later</button><button class="btn p">Turn it on</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = async () => { try { await api.unenrol(en.id); } catch { /* not finished: nothing to undo */ } close(); };
      d.querySelector('#vf').onsubmit = async (e) => {
        e.preventDefault();
        try { await api.verifyCode(en.id, String(new FormData(e.target).get('code')).trim()); S.aal = 'aal2'; close(); await refreshCompany();
          modal('<h3>✅ Two-step sign-in is on</h3><p>Next time you sign in, Riyeser asks for a code from your authenticator app.</p><div class="mfoot"><button class="btn p" id="cl">Done</button></div>', (dd, c2) => { dd.querySelector('#cl').onclick = c2; }); }
        catch (err) { alert(plainError(err)); }
      };
    });
  }

  // ---------------- change history (owners and admins)
  const HIST = {
    'workspaces.update': 'changed the company details', 'members.insert': 'added someone to the company', 'members.update': 'changed someone\'s access',
    'members.delete': 'removed someone from the company', 'branches.insert': 'added a branch', 'branches.update': 'changed a branch', 'branches.delete': 'removed a branch',
    'branch_members.insert': 'put someone in a branch', 'branch_members.delete': 'took someone out of a branch', 'devices.insert': 'linked a PC',
    'devices.delete': 'unlinked a PC', 'join_request.approved': 'approved a join request', 'join_request.declined': 'declined a join request',
  };
  function histLine(h) {
    const d = h.details || {}; const v = (k) => (d[k] && typeof d[k] === 'object' && 'now' in d[k] ? d[k].now : d[k]);
    const who = h.actor ? nameOf(h.actor) : 'Riyeser';
    let what = HIST[h.action] || h.action;
    const extra = [v('display_name'), v('device_name'), v('name'), d.user_id ? nameOf(v('user_id')) : null].filter(Boolean)[0];
    const changed = h.action.endsWith('.update') ? Object.keys(d).filter((k) => d[k] && typeof d[k] === 'object' && 'was' in d[k]).map((k) => k.replace(/_/g, ' ')).join(', ') : '';
    return `<div class="hl"><span class="hw">${esc(who)}</span> ${esc(what)}${extra ? ` · <b>${esc(extra)}</b>` : ''}${changed ? ` <small>(${esc(changed)})</small>` : ''}<time>${ago(h.at)}</time></div>`;
  }
  async function showHistory() {
    if (needs2step()) return security();
    let rows = [];
    try { rows = await api.history(S.team.id); } catch (err) { alert(plainError(err)); return; }
    modal(`<h3>🕘 Change history</h3><p>Who changed people, access, branches, PCs and company details. It can't be edited or deleted.</p>
      <div class="hist">${rows.map(histLine).join('') || '<div class="empty"><b>Nothing yet</b></div>'}</div>
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`, (d, close) => { d.querySelector('#cl').onclick = close; });
  }

  // ---------------- company admin: requests, people & access, company profile and PCs
  const branchTicks = (chosen, attr) => `<div class="pick">${S.branches.map((b) => `<label class="pk"><input type="checkbox" ${attr} value="${b.id}"${chosen.includes(b.id) ? ' checked' : ''}><span>${esc(b.name)}${b.extension ? ` · ${b.extension}` : ''}</span></label>`).join('') || '<p class="muted" style="padding:6px">No branches yet.</p>'}</div>`;
  const jobSelect = (cur, name = 'job') => `<select name="${name}">${JOBS.map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const ago = (t) => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
  async function refreshCompany() {
    [S.people, S.branches, S.teams] = await Promise.all([api.people(S.team.id), api.branches(S.team.id), api.teams(S.user.id)]);
    S.team = S.teams.find((t) => t.id === S.team.id) || S.team;
    S.requests = isAdmin() ? await api.pendingRequests(S.team.id).catch(() => []) : [];
    renderSide(); if (S.home) renderHome();
  }

  function joinRequests() {
    const body = () => `<h3>👋 Join requests</h3><p>People asking to join ${esc(S.team.name)}. Choose what they can do, then approve.</p>
      ${S.requests.length ? S.requests.map((r) => { const br = S.branches.find((b) => b.id === r.branch_id);
        return `<form class="req" data-req="${r.id}"><div class="rq-who">${av(r.id, r.display_name)}<div><b>${esc(r.display_name)}</b><small>${esc(r.email || '')}${br ? ` · asked for ${esc(br.name)}` : ''} · ${ago(r.created_at)}</small>${r.note ? `<p class="rq-note">“${esc(r.note)}”</p>` : ''}</div></div>
          <div class="rq-grid"><label class="f"><span>Job role</span>${jobSelect('staff')}</label><label class="opt sm"><input type="checkbox" name="admin"> Admin (can approve people)</label></div>
          <span class="pkh">Branches</span>${branchTicks(r.branch_id ? [r.branch_id] : [], 'name="br"')}
          <div class="row2" style="justify-content:flex-end;margin-top:8px"><button type="button" class="btn sm" data-dec="${r.id}">Decline</button><button class="btn p sm">Approve</button></div></form>`; }).join('')
        : '<div class="empty"><b>No requests right now</b>Give people the Company ID or a branch code, and they\'ll show up here.</div>'}
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`;
    modal(body(), function wire(d, close) {
      d.querySelector('#cl').onclick = close;
      const again = async () => { await refreshCompany(); d.querySelector('.mcard').innerHTML = body(); wire(d, close); };
      d.querySelectorAll('[data-dec]').forEach((b) => b.onclick = async () => { if (!confirm('Decline this request?')) return;
        try { await api.decideJoin(b.dataset.dec, false, null, false, []); } catch (err) { alert(plainError(err)); } again(); });
      d.querySelectorAll('form[data-req]').forEach((f) => f.onsubmit = async (e) => { e.preventDefault();
        const job = f.querySelector('[name=job]').value; const admin = f.querySelector('[name=admin]').checked;
        const brs = [...f.querySelectorAll('[name=br]:checked')].map((x) => x.value);
        try { await api.decideJoin(f.dataset.req, true, job, admin, brs); } catch (err) { alert(plainError(err)); } again(); });
    });
  }

  function peopleAccess() {
    const body = () => `<h3>People & access</h3><p>What each person can do and which branches they're in. Changes apply straight away, on every device.</p>
      ${S.people.map((p) => { const mine = S.branches.filter((b) => b.people.includes(p.user_id)).map((b) => b.id); const owner = p.role === 'owner';
        return `<details class="brm"><summary>${av(p.user_id, p.display_name)} <b>${esc(p.display_name)}</b> <span class="muted">${owner ? 'Owner' : jobName(p.job_role)}${p.role === 'admin' ? ' · admin' : ''}${p.extension ? ` · ${p.extension}` : ''}</span></summary>
          <form data-person="${p.user_id}">${owner ? '<p class="muted">The owner can do everything.</p>' : `<div class="rq-grid"><label class="f"><span>Job role</span>${jobSelect(p.job_role)}</label>
          <label class="opt sm"><input type="checkbox" name="admin"${p.role === 'admin' ? ' checked' : ''}> Admin (can approve people)</label></div>`}
          <span class="pkh">Branches</span>${branchTicks(mine, 'name="br"')}
          <div class="row2" style="justify-content:flex-end;margin-top:8px">${owner || p.user_id === S.user.id ? '' : `<button type="button" class="btn sm" data-remove="${p.user_id}" style="color:#b91c1c">Remove from company</button>`}<button class="btn p sm">Save</button></div></form></details>`; }).join('')}
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`;
    modal(body(), function wire(d, close) {
      d.querySelector('#cl').onclick = close;
      const again = async () => { await refreshCompany(); d.querySelector('.mcard').innerHTML = body(); wire(d, close); };
      d.querySelectorAll('form[data-person]').forEach((f) => f.onsubmit = async (e) => { e.preventDefault();
        const j = f.querySelector('[name=job]'); const a = f.querySelector('[name=admin]');
        try { await api.setAccess(S.team.id, f.dataset.person, j ? j.value : 'staff', a ? a.checked : false, [...f.querySelectorAll('[name=br]:checked')].map((x) => x.value)); }
        catch (err) { alert(plainError(err)); } again(); });
      d.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
        if (!confirm(`Remove ${nameOf(b.dataset.remove)} from ${S.team.name}? They lose access on all their devices. Their old messages stay.`)) return;
        try { await api.removePerson(S.team.id, b.dataset.remove); } catch (err) { alert(plainError(err)); } again(); });
    });
  }

  async function companyInfo(justMade) {
    const admin = isAdmin(); const t = S.team;
    const devs = admin ? await api.devices(t.id).catch(() => []) : [];
    let lic = admin ? await api.licence(t.id).catch(() => null) : null;
    if (!lic || !lic.modules || !lic.seats) lic = null;   // not set up online yet: no plan to show
    const field = (k, label, max = 120) => `<label class="f"><span>${label}</span><input name="${k}" value="${esc(t[k] || '')}" maxlength="${max}"${admin ? '' : ' readonly'}></label>`;
    modal(`<h3>${esc(t.name)}</h3>${justMade ? '<div class="ok">Your company is set up. Give your staff and branches the Company ID below: they ask to join, and you approve them.</div>' : ''}
      <div class="cid"><small>Company ID</small><span class="code" id="cidv">${esc(t.company_code || '')}</span><button class="btn sm" id="cpid">Copy</button></div>
      <p class="muted small" style="margin:4px 0 14px">Everyone in the company, on every Riyeser program and PC, links with this ID. ${admin ? 'New people need your approval.' : ''}</p>
      <form id="cof">${field('name', 'Business name', 80)}${field('legal_name', 'Legal name')}${field('tax_number', 'ABN / TIN', 40)}${field('address', 'Address', 300)}${field('phone', 'Phone', 40)}${field('email', 'Email')}${field('country', 'Country', 60)}
      ${admin ? `<label class="opt sm"><input type="checkbox" name="require_approval"${t.require_approval ? ' checked' : ''}> New people need approval before they're in (recommended)</label>` : ''}
      ${lic ? `<h4 style="margin:16px 0 6px">Your plan</h4><div class="plan">${[['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Team Chat Plus']].map(([k, n]) => { const v = (lic.modules || {})[k] || {};
        const d = (x) => (x ? new Date(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
        const txt = v.status === 'active' ? `Paid${v.paid_until ? ' until ' + d(v.paid_until) : ''}` : v.status === 'trial' ? `Free trial · ${v.days_left} day${v.days_left === 1 ? '' : 's'} left` : v.status === 'cancelled' ? (v.active ? 'Cancelled · works until ' + d(v.paid_until) : 'Cancelled') : 'Trial ended';
        return `<div><span>${n}</span><span class="pl ${v.status === 'active' ? 'ok' : v.active ? (v.days_left <= 14 ? 'warn' : '') : 'bad'}">${txt}</span></div>`; }).join('')}
        <div><span>People</span><span class="pl">${lic.seats.used} of ${lic.seats.included + lic.seats.extra} included${lic.early_bird ? ' · 🐣 early bird' : ''}</span></div></div>
        <p class="muted small" style="margin:6px 0 0">Free forever: Riyeser Central, Invoices, PDF, Desk Assistant and Team chat. To change your plan, contact Riyeser.</p>` : ''}
      ${admin && devs.length ? `<h4 style="margin:16px 0 6px">Linked PCs</h4><div class="devs">${devs.map((dv) => `<div><span><b>${esc(dv.device_name || 'A PC')}</b><small>${esc(nameOf(dv.user_id))} · ${esc(dv.platform || '')} · seen ${ago(dv.last_seen)}</small></span><button type="button" class="btn sm" data-unlink="${dv.id}">Unlink</button></div>`).join('')}</div>` : ''}
      <div class="mfoot"><button type="button" class="btn" id="cl">Close</button>${admin ? '<button class="btn p">Save</button>' : ''}</div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#cpid').onclick = async () => { try { await navigator.clipboard.writeText(t.company_code); d.querySelector('#cpid').textContent = 'Copied'; } catch { /* select it instead */ } };
      d.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => { if (!confirm('Unlink this PC? It stops getting the company\'s information until someone links it again. Nothing is deleted.')) return;
        try { await api.unlinkDevice(b.dataset.unlink); b.closest('div').remove(); } catch (err) { alert(plainError(err)); } });
      d.querySelector('#cof').onsubmit = async (e) => { e.preventDefault(); if (!admin) return close();
        const f = new FormData(e.target); const pr = Object.fromEntries(['name', 'legal_name', 'tax_number', 'address', 'phone', 'email', 'country'].map((k) => [k, String(f.get(k) || '')]));
        pr.require_approval = !!f.get('require_approval');
        try { await api.updateCompany(t.id, pr); await refreshCompany(); close(); } catch (err) { alert(plainError(err)); } };
    });
  }

  // ------------------------------------------------------------------ the chat
  async function loadTeam(id) {
    S.team = S.teams.find((t) => t.id === id) || S.teams[0];
    try { localStorage.setItem('riyeser.team.last', S.team.id); } catch { /* private mode */ }
    [S.people, S.chans, S.unread] = await Promise.all([api.people(S.team.id), api.channels(S.team.id), api.unread(S.team.id)]);
    [S.features, S.branches] = await Promise.all([api.features(S.team.id).catch(() => ({ calls: false })), api.branches(S.team.id).catch(() => [])]);
    S.requests = isAdmin() ? await api.pendingRequests(S.team.id).catch(() => []) : [];
    Calls.listen();
    const first = S.chans.find((c) => c.name === 'general') || S.chans[0];
    api.live(S.team.id, onLive);
    await openChannel(first && first.id, false);
  }

  async function openChannel(id, toChat = true) {
    S.ch = S.chans.find((c) => c.id === id) || null; S.editing = null;
    S.msgs = S.ch ? await api.messages(S.ch.id) : [];
    if (toChat) { S.inChat = true; S.home = false; }
    if (S.home) renderHome(); else render();
    if (S.ch) { await api.markRead(S.ch.id, S.user.id); S.unread[S.ch.id] = 0; renderSide(); }
  }

  function onLive(m) {
    if (!m || !S.team || m.workspace_id !== S.team.id) return;
    if (S.ch && m.channel_id === S.ch.id) {
      const i = S.msgs.findIndex((x) => x.id === m.id);
      if (i >= 0) S.msgs[i] = m; else S.msgs.push(m);
      renderMsgs(true);
      if (!document.hidden) api.markRead(S.ch.id, S.user.id);
    } else if (m.user_id !== S.user.id && !m.deleted) {
      S.unread[m.channel_id] = (S.unread[m.channel_id] || 0) + 1;
      if (!S.chans.find((c) => c.id === m.channel_id)) api.channels(S.team.id).then((c) => { S.chans = c; renderSide(); }); else renderSide();
    }
    const total = Object.values(S.unread).reduce((a, b) => a + b, 0);
    document.title = (total ? `(${total}) ` : '') + 'Riyeser Team';
  }

  // Message text: safe HTML, links, @names, and Riyeser references (INV-1047, Q-0042, Booking 12, Job #12).
  function fmt(body) {
    let h = esc(body);
    h = h.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    h = h.replace(/\b(INV-\d+|Q-\d+|PO-\d+)\b/g, '<span class="chip inv">$1</span>');
    h = h.replace(/\b((?:Booking|Job) #?\d+)\b/gi, '<span class="chip bk">$1</span>');
    h = h.replace(/(^|\s)@([A-Za-z][\w'-]*)/g, '$1<span class="at">@$2</span>');
    return h;
  }
  const dayName = (d) => { const t = new Date(); const y = new Date(Date.now() - 864e5); const s = (x) => x.toDateString();
    return s(d) === s(t) ? 'Today' : s(d) === s(y) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };
  const timeOf = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function msgsHtml() {
    if (!S.ch) return `<div class="empty"><b>No channels yet</b>Add one with + next to Channels.</div>`;
    if (!S.msgs.length) return `<div class="empty"><b>${S.ch.kind === 'dm' ? 'Say hello 👋' : `Welcome to #${esc(S.ch.name)}`}</b>${esc(S.ch.topic || 'Nothing here yet. Write the first message below.')}</div>`;
    let out = ''; let lastDay = ''; let prev = null;
    for (const m of S.msgs) {
      const d = new Date(m.created_at); const day = d.toDateString();
      if (day !== lastDay) { out += `<div class="day">${esc(dayName(d))}</div>`; lastDay = day; prev = null; }
      const cont = prev && prev.user_id === m.user_id && d - new Date(prev.created_at) < 5 * 60000;
      const mine = m.user_id === S.user.id && !m.deleted;
      const body = S.editing === m.id
        ? `<form class="cbox" data-edit="${m.id}"><textarea rows="2">${esc(m.body)}</textarea><button>Save</button></form>`
        : `<div class="mb${m.deleted ? ' gone' : ''}">${m.deleted ? 'Message deleted' : fmt(m.body)}${m.edited_at && !m.deleted ? ' <span class="edited">(edited)</span>' : ''}</div>`;
      out += `<div class="msg${cont ? ' cont' : ''}" data-id="${m.id}">${av(m.user_id, nameOf(m.user_id))}<div>
        ${cont ? '' : `<div class="mt"><b>${esc(nameOf(m.user_id))}</b><time datetime="${m.created_at}">${esc(timeOf(d))}</time>${mine ? `<span class="macts"><button data-act="edit">Edit</button><button data-act="del">Delete</button></span>` : ''}</div>`}
        ${cont && mine ? `<div class="mt"><span class="macts"><button data-act="edit">Edit</button><button data-act="del">Delete</button></span></div>` : ''}
        ${body}</div></div>`;
      prev = m;
    }
    return out;
  }

  function sideHtml() {
    const chs = S.chans.filter((c) => c.kind !== 'dm');
    const others = S.people.filter((p) => p.user_id !== S.user.id);
    const dmFor = (uid) => S.chans.find((c) => c.kind === 'dm' && c.people.includes(uid));
    const me = S.people.find((p) => p.user_id === S.user.id) || {};
    const unreadBadge = (id) => (S.unread[id] ? `<span class="badge">${S.unread[id]}</span>` : '');
    return `${/Electron/.test(navigator.userAgent) || DEMO ? '' : '<button class="tohome" id="tohome">← Riyeser home</button>'}<div class="team"><img src="icon.svg" alt=""><div>${S.teams.length > 1
      ? `<select id="tsw" aria-label="Switch team">${S.teams.map((t) => `<option value="${t.id}"${t.id === S.team.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : `<b>${esc(S.team.name)}</b>`}<small>${S.people.length} ${S.people.length === 1 ? 'person' : 'people'}${S.team.company_code ? ` · ${esc(S.team.company_code)}` : ''}</small></div></div>
    <div class="cobar"><button id="coinfo">🏢 Company</button>${isAdmin() ? `<button id="coppl">👥 People</button><button id="coreq">👋 Requests${S.requests.length ? ` <span class="badge">${S.requests.length}</span>` : ''}</button><button id="cohist">🕘 History</button>` : ''}<button id="cosec">🔐 Security</button></div>
    ${needs2step() ? '<button class="mfa-nag" id="mfanag">🔐 Owners and admins need <b>two-step sign-in</b> to approve people and change access. <u>Turn it on (2 minutes)</u></button>' : ''}
    <div class="sidescroll">
      <div class="sec">Channels <button id="addch" aria-label="Add a channel" title="Add a channel">+</button></div>
      ${chs.map((c) => `<button class="item${S.ch && S.ch.id === c.id ? ' on' : ''}${S.unread[c.id] ? ' unread' : ''}" data-ch="${c.id}"><span class="hash">${c.kind === 'private' ? '🔒' : '#'}</span><span class="nm">${esc(c.name)}</span>${unreadBadge(c.id)}</button>`).join('')}
      <div class="sec">Direct messages</div>
      ${others.map((p) => { const dm = dmFor(p.user_id); return `<button class="item${dm && S.ch && S.ch.id === dm.id ? ' on' : ''}${dm && S.unread[dm.id] ? ' unread' : ''}" data-dm="${p.user_id}">${av(p.user_id, p.display_name)}<span class="nm">${esc(p.display_name)}</span>${p.extension ? `<span class="ext">${p.extension}</span>` : ''}${dm ? unreadBadge(dm.id) : ''}</button>`; }).join('')
        || '<p style="padding:4px 10px;color:var(--side-muted);font-size:13px">Invite your team to start chatting.</p>'}
      ${callsSideHtml()}
      <button class="invite" id="inv">+ Invite people</button>
    </div>
    <div class="me">${av(S.user.id, me.display_name || S.user.email)}<div class="nm">${esc(me.display_name || 'You')}<small>${esc(S.user.email || '')}</small></div><button id="out">Sign out</button></div>`;
  }


  // ------------------------------------------------------------------ Riyeser home (the account's front page on the website)
  const REL = 'https://github.com/raka1987/Riyeser/releases/latest/download/';
  const APPS = [
    ['central', 'Riyeser Central', 'Your home screen on the PC. Installs and updates everything.', 'RiyeserCentral-Setup.exe', 'free'],
    ['accounting-basics', 'Accounting Basics', 'Invoices, quotes, customers and stock.', 'RiyeserAccountingBasics-Setup.exe', 'basic'],
    ['accounting', 'Accounting Plus', 'Full books: banking, BAS, payroll, jobs.', 'RiyeserAccountingPlus-Setup.exe', 'plus'],
    ['invoices', 'Invoices', 'Quotes and invoices, free.', 'RiyeserInvoices-Setup.exe', 'free'],
    ['pos', 'POS', 'The till for shops and restaurants.', 'RiyeserPOS-Setup.exe', 'pos'],
    ['bookings', 'Bookings', 'Jobs, appointments and tables.', 'RiyeserBookings-Setup.exe', 'bookings'],
    ['payroll', 'Payroll', 'Staff, timesheets and pay runs.', 'RiyeserPayroll-Setup.exe', 'payroll'],
    ['pdf', 'PDF', 'Fill, sign and edit PDFs.', 'RiyeserPDF-Setup.exe', 'free'],
    ['desk-assistant', 'Desk Assistant', 'Files your documents for you.', 'RiyeserDeskAssistant-Setup.exe', 'free'],
  ];
  function licLine(lic, key) {
    if (key === 'free') return '<span class="pl ok">Free forever</span>';
    const v = lic && lic.modules && lic.modules[key]; if (!v) return '<span class="pl">Free for 90 days</span>';
    if (v.status === 'active') return '<span class="pl ok">Paid</span>';
    if (v.status === 'trial') return `<span class="pl${v.days_left <= 14 ? ' warn' : ''}">Free trial · ${v.days_left} day${v.days_left === 1 ? '' : 's'} left</span>`;
    return '<span class="pl bad">Not active</span>';
  }
  async function renderHome() {
    tabIcon(false); document.title = 'Riyeser';
    const admin = isAdmin(); const t = S.team; const me = S.people.find((p) => p.user_id === S.user.id) || {};
    const solo = t.kind === 'personal'; const team = !solo || S.people.length > 1 || S.requests.length > 0;
    if (S.homeLic === undefined || S.homeLicFor !== t.id) { S.homeLicFor = t.id; S.homeLic = admin ? await api.licence(t.id).catch(() => null) : null; }
    const lic = S.homeLic && S.homeLic.modules ? S.homeLic : null;
    const unread = Object.values(S.unread || {}).reduce((a, b) => a + (b || 0), 0);
    const calls = lic && lic.modules && lic.modules.calls;
    $app.className = 'acct home'; window.scrollTo(0, 0);
    $app.innerHTML = `<header class="htop"><a class="hbrand" href="/"><img src="/assets/logo-r.png" alt="">Riyeser</a>
        ${S.teams.length > 1 ? `<select id="hsw" aria-label="Switch company">${S.teams.map((x) => `<option value="${x.id}"${x.id === t.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <span class="hme">${esc(me.display_name || S.user.email || '')}</span><button class="btn sm" id="hout">Sign out</button></header>
      <main class="hmain">
        <h1>Welcome${me.display_name ? ', ' + esc(me.display_name.split(' ')[0]) : ''}</h1>
        ${needs2step() ? '<button class="hnag" id="hmfa">🔐 Turn on <b>two-step sign-in</b> to approve people and change access. It takes 2 minutes.</button>' : ''}
        <section class="hco"><div><small>${solo ? 'Your account' : 'Your business'}</small><h2>${esc(t.name)}</h2>
          <div class="cid"><small>${solo ? 'Your Riyeser ID' : 'Business ID'}</small><span class="code">${esc(t.company_code || '')}</span><button class="btn sm" id="hcp">Copy</button></div>
          <p class="muted small">${solo ? 'Your Riyeser programs link to your account with this ID. If someone helps you later, they can use it to join you.' : 'The people who help you use this ID to join. Every Riyeser program on your PCs links with it.'}</p>
          <dl class="hkv">${[...(solo ? [] : [['Legal name', t.legal_name]]), ['ABN / TIN', t.tax_number], ['Address', t.address], ['Phone', t.phone], ['Email', t.email], ['Country', t.country]]
            .map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : `<span class="muted">${admin ? 'Not added yet' : '—'}</span>`}</dd>`).join('')}</dl></div>
          <div class="hacts"><button class="btn" id="hco">✏️ ${admin ? (solo ? 'Edit my details' : 'Edit business details') : 'Business details'}</button>${admin && team ? `<button class="btn" id="hppl">👥 People · ${S.people.length}</button>
          <button class="btn" id="hreq">👋 Requests${S.requests.length ? ` <span class="badge">${S.requests.length}</span>` : ''}</button><button class="btn" id="hhist">🕘 History</button>` : ''}
          <button class="btn" id="hsec">🔐 Security</button></div></section>
        ${lic ? `<h3 class="hsec">Your plan <small>${lic.seats ? `${lic.seats.used} of ${lic.seats.included + lic.seats.extra} people included${lic.early_bird ? ' · 🐣 early bird' : ''} · ` : ''}To change your plan, contact Riyeser.</small></h3>
        <div class="hplan">${[['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['calls', 'Team Chat Plus (calls)']]
          .filter(([k]) => lic.modules[k]).map(([k, n]) => `<div><span>${n}</span>${licLine(lic, k)}</div>`).join('')}</div>` : ''}
        <h3 class="hsec">Riyeser Team</h3>
        <div class="happs"><div class="happ hteam"><img src="/assets/apps/team.png" alt=""><div><b>Riyeser Team${unread ? ` <span class="badge">${unread}</span>` : ''}</b>
          <small>Chat with the people you work with. Calls between you, your staff and other locations come with Team Chat Plus.</small>
          <span class="pl ok">Chat: free forever</span> ${calls ? licLine(lic, 'calls').replace('>Free trial', '>Calls: free trial').replace('>Paid', '>Calls: paid').replace('>Not active', '>Calls: not active') : '<span class="pl">Calls: free for 90 days</span>'}</div>
          <div class="hbtns"><button class="btn p sm" id="hchat">Open</button><a class="btn sm" href="${REL}RiyeserTeam-Setup.exe">⬇ Download for Windows</a></div></div></div>
        <h3 class="hsec">Programs for your PC <small>Start with Riyeser Central: it installs and updates the rest.</small></h3>
        <div class="happs">${APPS.map(([id, n, d, file, key]) => `<a class="happ" href="${REL}${file}"><img src="/assets/apps/${id}.png" alt=""><div><b>${n}</b><small>${d}</small>${admin || key === 'free' ? licLine(lic, key) : ''}</div><span class="go">⬇ Download</span></a>`).join('')}</div>
        <p class="muted small hfoot">Windows 10 and 11. <a href="/help.html">Help Centre</a> · <a href="/pricing.html">Pricing</a></p>
      </main>`;
    const on = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.onclick = fn; };
    on('#hchat', () => { S.home = false; render(); });
    on('#hout', async () => { await api.signOut(); S.team = null; gate(); });
    on('#hco', () => companyInfo(false));
    on('#hppl', () => (needs2step() ? security() : peopleAccess()));
    on('#hreq', () => (needs2step() ? security() : joinRequests()));
    on('#hhist', showHistory); on('#hsec', security); on('#hmfa', security);
    on('#hcp', async () => { try { await navigator.clipboard.writeText(t.company_code); $app.querySelector('#hcp').textContent = 'Copied'; } catch { /* nothing */ } });
    const sw = $app.querySelector('#hsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
  }

  // The browser tab shows Riyeser's logo on the account screens, and Team's icon once inside chat.
  function tabIcon(team) {
    const l = document.getElementById('favicon'); if (!l) return;
    l.type = team ? 'image/svg+xml' : 'image/png'; l.href = team ? 'icon.svg' : '/assets/logo-r.png';
  }
  function render() {
    tabIcon(true);
    $app.className = '';
    $app.innerHTML = `${demoBar()}<div class="shell${S.inChat ? ' inchat' : ''}"><aside class="side" id="side"></aside>
      <section class="main"><header class="mhead" id="mhead"></header><div class="msgs" id="msgs" aria-live="polite"></div>
      <form class="composer" id="comp"><div class="cbox"><textarea id="txt" rows="1" placeholder="" aria-label="Message"></textarea><button id="send" disabled>Send</button></div>
      <div class="hint">Enter to send · Shift+Enter for a new line · Type INV-1047 or Booking 12 to point at one</div></form></section></div>`;
    renderSide(); renderHead(); renderMsgs(true); wireComposer();
  }
  function renderSide() {
    const el = document.getElementById('side'); if (!el) return;
    el.innerHTML = sideHtml();
    el.querySelectorAll('[data-ch]').forEach((b) => b.onclick = () => openChannel(b.dataset.ch));
    el.querySelectorAll('[data-dm]').forEach((b) => b.onclick = async () => {
      const id = await api.openDm(S.team.id, b.dataset.dm);
      if (!S.chans.find((c) => c.id === id)) S.chans = await api.channels(S.team.id);
      openChannel(id);
    });
    el.querySelector('#addch').onclick = addChannel;
    const th = el.querySelector('#tohome'); if (th) th.onclick = () => { S.home = true; renderHome(); };
    el.querySelector('#inv').onclick = invite;
    el.querySelectorAll('[data-callbranch]').forEach((b) => b.onclick = () => Calls.start({ branch: b.dataset.callbranch }));
    const dp = el.querySelector('#dial'); if (dp) dp.onclick = dialPad;
    const mg = el.querySelector('#mgbr'); if (mg) mg.onclick = manageBranches;
    el.querySelector('#out').onclick = async () => { await api.signOut(); S.team = null; gate(); };
    const sw = el.querySelector('#tsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
    el.querySelector('#coinfo').onclick = () => companyInfo(false);
    const pp = el.querySelector('#coppl'); if (pp) pp.onclick = () => (needs2step() ? security() : peopleAccess());
    const rq = el.querySelector('#coreq'); if (rq) rq.onclick = () => (needs2step() ? security() : joinRequests());
    const hs = el.querySelector('#cohist'); if (hs) hs.onclick = showHistory;
    el.querySelector('#cosec').onclick = security;
    const ng = el.querySelector('#mfanag'); if (ng) ng.onclick = security;
    const mg2 = el.querySelector('#mgbr'); if (mg2 && needs2step()) mg2.onclick = security;
  }
  function renderHead() {
    const el = document.getElementById('mhead'); if (!el) return;
    el.innerHTML = `<button class="back" aria-label="Back to channels">‹</button>${S.ch ? (S.ch.kind === 'dm'
      ? `${av(S.ch.people.find((p) => p !== S.user.id) || S.user.id, chanLabel(S.ch))}<div style="flex:1;min-width:0"><h2>${esc(chanLabel(S.ch))}</h2><small>Direct message${(() => { const o = S.people.find((p) => p.user_id === S.ch.people.find((u) => u !== S.user.id)); return o && o.extension ? ' · ext ' + o.extension : ''; })()}</small></div><button class="btn sm callbtn" id="calldm" aria-label="Call ${esc(chanLabel(S.ch))}">📞 Call</button>`
      : `<div style="flex:1;min-width:0"><h2>${S.ch.kind === 'private' ? '🔒' : '#'} ${esc(S.ch.name)}</h2><small>${S.ch.kind === 'private' ? `Private · ${S.ch.people.length} ${S.ch.people.length === 1 ? 'person' : 'people'}${S.ch.topic ? ' · ' : ''}` : ''}${esc(S.ch.topic || '')}</small></div>${S.ch.kind === 'private' ? '<button class="btn sm" id="ppl">People</button>' : ''}`) : ''}`;
    el.querySelector('.back').onclick = () => { S.inChat = false; document.querySelector('.shell').classList.remove('inchat'); };
    const pb = el.querySelector('#ppl'); if (pb) pb.onclick = peopleOf;
    const cb = el.querySelector('#calldm'); if (cb) cb.onclick = () => Calls.start({ user: S.ch.people.find((u) => u !== S.user.id) });
    const t = document.getElementById('txt'); if (t && S.ch) t.placeholder = S.ch.kind === 'dm' ? `Message ${chanLabel(S.ch)}` : S.ch.kind === 'private' ? `Message ${S.ch.name} (private)` : `Message #${S.ch.name}`;
  }
  function renderMsgs(toBottom) {
    const el = document.getElementById('msgs'); if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    el.innerHTML = msgsHtml();
    if (toBottom || near) el.scrollTop = el.scrollHeight;
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const id = b.closest('.msg').dataset.id;
      if (b.dataset.act === 'del') { if (!confirm('Delete this message?')) return; await api.remove(id); const m = S.msgs.find((x) => x.id === id); if (m) { m.deleted = true; } renderMsgs(); }
      else { S.editing = id; renderMsgs(); const ta = el.querySelector(`[data-edit="${id}"] textarea`); ta && ta.focus(); }
    });
    el.querySelectorAll('[data-edit]').forEach((f) => {
      const ta = f.querySelector('textarea');
      const save = async () => { const v = ta.value.trim(); const m = S.msgs.find((x) => x.id === f.dataset.edit);
        if (v && m && v !== m.body) { await api.edit(m.id, v); m.body = v; m.edited_at = new Date().toISOString(); } S.editing = null; renderMsgs(); };
      f.onsubmit = (e) => { e.preventDefault(); save(); };
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { S.editing = null; renderMsgs(); } };
    });
  }
  function wireComposer() {
    const f = document.getElementById('comp'); const t = document.getElementById('txt'); const b = document.getElementById('send');
    const grow = () => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; b.disabled = !t.value.trim() || !S.ch; };
    t.oninput = grow;
    t.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit(); } };
    f.onsubmit = async (e) => {
      e.preventDefault(); const body = t.value.trim(); if (!body || !S.ch) return;
      t.value = ''; grow();
      try { const m = await api.send(S.team.id, S.ch.id, body); if (!S.msgs.find((x) => x.id === m.id)) S.msgs.push(m); renderMsgs(true); }
      catch (err) { t.value = body; grow(); alert('That message didn\'t send: ' + plainError(err)); }
    };
    renderHead();
    if (matchMedia('(min-width: 761px)').matches) t.focus();
  }

  function modal(html, wire) {
    const d = document.createElement('div'); d.className = 'modal'; d.innerHTML = `<div class="mcard" role="dialog" aria-modal="true">${html}</div>`;
    d.onclick = (e) => { if (e.target === d) d.remove(); };
    document.body.appendChild(d); wire(d, () => d.remove());
  }
  function invite() {
    const link = () => `${location.origin}/team/?join=${S.team.company_code || S.team.invite_code}`;
    const admin = S.team.role === 'owner' || S.team.role === 'admin';
    modal(`<h3>Invite people to ${esc(S.team.name)}</h3><p>Send them this link, or the Company ID <b>${esc(S.team.company_code || '')}</b>. They create a free account and ask to join${S.team.require_approval ? ', then you approve them under 👋 Requests' : ''}.</p>
      <div class="copyrow"><input id="il" readonly value="${esc(link())}"><button class="btn p" id="cp">Copy</button></div>
      <p style="margin:14px 0 0">Or give them the code: <span class="code" id="ic">${esc(S.team.invite_code)}</span></p>
      ${S.branches.length ? `<p style="margin:16px 0 6px"><b>Joining a branch?</b> Use its code instead: they're put in that branch and given the next extension.</p>
      <div class="brcodes">${S.branches.map((b) => `<div><span>${esc(b.name)}${b.extension ? ` · ${b.extension}` : ''}</span><span class="code sm">${esc(b.code || '')}</span></div>`).join('')}</div>` : ''}
      <div class="mfoot">${admin ? '<button class="btn" id="nc" title="The old link stops working">New code</button>' : ''}<button class="btn" id="cl">Done</button></div>`, (d, close) => {
      d.querySelector('#cp').onclick = async () => { try { await navigator.clipboard.writeText(link()); d.querySelector('#cp').textContent = 'Copied'; } catch { d.querySelector('#il').select(); } };
      d.querySelector('#cl').onclick = close;
      const nc = d.querySelector('#nc'); if (nc) nc.onclick = async () => {
        if (!confirm('Make a new code? The old invite link will stop working.')) return;
        S.team.invite_code = await api.newInvite(S.team.id); d.querySelector('#il').value = link(); d.querySelector('#ic').textContent = S.team.invite_code; };
    });
  }
  const tickList = (chosen, locked = []) => `<div class="pick">${S.people.map((p) => `<label class="pk"><input type="checkbox" name="p" value="${p.user_id}"${chosen.includes(p.user_id) ? ' checked' : ''}${locked.includes(p.user_id) ? ' disabled' : ''}>${av(p.user_id, p.display_name)}<span>${esc(p.display_name)}${p.user_id === S.user.id && p.display_name !== 'You' ? ' (you)' : ''}</span>${p.role !== 'member' ? `<small>${esc(p.role)}</small>` : ''}</label>`).join('')}</div>`;
  const ticked = (d) => [...d.querySelectorAll('input[name=p]:checked')].map((x) => x.value);

  function addChannel() {
    modal(`<h3>Add a chat</h3><p>For a topic, a job or a group of people.</p>
      <form id="nf"><label class="f"><span>Name</span><input name="name" required maxlength="40" placeholder="e.g. sales, executives, hill-rd-site"></label>
      <label class="f"><span>What it's for (optional)</span><input name="topic" maxlength="200"></label>
      <div class="f"><span>Who can see it?</span>
        <label class="opt"><input type="radio" name="who" value="some" checked> <b>🔒 Only people I choose</b><small>Private: it doesn't even show up for anyone else</small></label>
        <label class="opt"><input type="radio" name="who" value="all"> <b>Everyone in the team</b><small>Everyone sees it, including people who join later</small></label></div>
      <div id="pickwrap"><span class="pkh">Choose who's in it</span>${tickList([S.user.id], [S.user.id])}</div>
      <div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Add</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('input[name=who]').forEach((r) => r.onchange = () => { d.querySelector('#pickwrap').hidden = d.querySelector('input[name=who]:checked').value !== 'some'; });
      d.querySelector('#nf').onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target);
        const name = String(f.get('name')).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40);
        if (!name) return;
        const topic = String(f.get('topic') || '').trim();
        try {
          const id = f.get('who') === 'some'
            ? await api.createPrivate(S.team.id, name, topic, ticked(d).filter((x) => x !== S.user.id))
            : await api.createChannel(S.team.id, S.user.id, name, topic);
          S.chans = await api.channels(S.team.id); close(); openChannel(id);
        } catch (err) { alert(plainError(err)); }
      };
    });
  }

  // Who's in a private chat. Whoever made it, or a team owner/admin, can change it; anyone in it can leave.
  function peopleOf() {
    const c = S.ch; if (!c || c.kind !== 'private') return;
    const manage = c.created_by === S.user.id || S.team.role === 'owner' || S.team.role === 'admin';
    modal(`<h3>🔒 ${esc(c.name)}</h3><p>${manage ? 'Tick who should be in this private chat. Only they can see it.' : 'Only these people can see this private chat.'}</p>
      ${manage ? tickList(c.people) : `<div class="pick">${c.people.map((u) => `<div class="pk">${av(u, nameOf(u))}<span>${esc(nameOf(u))}${u === S.user.id ? ' (you)' : ''}</span></div>`).join('')}</div>`}
      <div class="mfoot"><button class="btn" id="lv" style="margin-right:auto;color:#b91c1c">Leave this chat</button><button class="btn" id="cl">${manage ? 'Cancel' : 'Done'}</button>${manage ? '<button class="btn p" id="sv">Save</button>' : ''}</div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#lv').onclick = async () => {
        if (!confirm(`Leave ${c.name}? You won't see it again unless someone adds you back.`)) return;
        try { await api.leave(c.id, S.user.id); S.chans = await api.channels(S.team.id); close(); openChannel((S.chans.find((x) => x.name === 'general') || S.chans[0] || {}).id, false); }
        catch (err) { alert(plainError(err)); }
      };
      const sv = d.querySelector('#sv'); if (sv) sv.onclick = async () => {
        const now = ticked(d); if (!now.length) { alert('Keep at least one person in the chat.'); return; }
        const add = now.filter((u) => !c.people.includes(u)); const remove = c.people.filter((u) => !now.includes(u));
        try { await api.setPeople(c.id, add, remove); S.chans = await api.channels(S.team.id); S.ch = S.chans.find((x) => x.id === c.id) || null; close();
          if (!S.ch) openChannel((S.chans.find((x) => x.name === 'general') || S.chans[0] || {}).id, false); else { renderHead(); renderSide(); } }
        catch (err) { alert(plainError(err)); }
      };
    });
  }


  // ================================================================== Team Chat Plus (premium)
  // Calls go directly between the two devices (WebRTC). The online service only carries the ringing and set-up.
  // Calling a branch rings everyone in it; the first to answer takes the call. 30 seconds with no answer is a missed call.
  function callsSideHtml() {
    const f = S.features || {};
    const admin = S.team.role === 'owner' || S.team.role === 'admin';
    const trial = f.calls && !f.calls_paid && f.trial_days_left != null ? `<span class="trialtag">Trial · ${f.trial_days_left} days left</span>` : '';
    const me = S.people.find((p) => p.user_id === S.user.id) || {};
    return `<div class="sec">Calls ${f.calls ? trial : '<span class="trialtag prem">⭐ Premium</span>'}<span>${admin ? '<button id="mgbr" aria-label="Branches and extensions" title="Branches and extensions">⚙</button>' : ''}<button id="dial" aria-label="Dial an extension" title="Dial an extension">⌨</button></span></div>
      ${S.branches.map((b) => `<button class="item" data-callbranch="${b.id}" title="Rings everyone in ${esc(b.name)}"><span class="hash">📞</span><span class="nm">${esc(b.name)}</span>${b.extension ? `<span class="ext">${b.extension}</span>` : ''}</button>`).join('')}
      ${me.extension ? `<p class="myext">Your extension: <b>${me.extension}</b></p>` : ''}`;
  }

  function upsell() {
    modal(`<h3>⭐ Team Chat Plus</h3><p>Calls between your people and branches, on the PC and phone: ring a person or a whole branch, answer on any device you're signed in on, with no call charges.</p>
      <p><b>+$20 a month per business</b>, free for your first 90 days. Your trial has ended, so calls are paused. Chat keeps working as normal.</p>
      <div class="mfoot"><button class="btn" id="cl">Not now</button><a class="btn p" href="/pricing.html" target="_blank" rel="noopener">See pricing</a></div>`, (d, close) => { d.querySelector('#cl').onclick = close; });
  }

  function dialPad() {
    modal(`<h3>Dial an extension</h3><p>A person's number rings them; a branch's number (like 200) rings everyone there.</p>
      <form id="dpf"><input id="dpn" class="dpn" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="Extension">
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => k === '' ? '<span></span>' : `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="dpwho" id="dpw"></div>
      <div class="mfoot"><button type="button" class="btn" id="cl">Close</button><button class="btn p">📞 Call</button></div></form>`, (d, close) => {
      const n = d.querySelector('#dpn'); const who = d.querySelector('#dpw');
      const find = (v) => { const x = Number(v); const p = S.people.find((q) => q.extension === x && q.user_id !== S.user.id); if (p) return { user: p.user_id, label: p.display_name };
        const b = S.branches.find((q) => q.extension === x); return b ? { branch: b.id, label: b.name + ' (everyone)' } : null; };
      const show = () => { const t = find(n.value); who.textContent = n.value ? (t ? t.label : 'No one on that number') : ''; };
      n.oninput = show; n.focus();
      d.querySelectorAll('[data-k]').forEach((k) => k.onclick = () => { n.value = k.dataset.k === '⌫' ? n.value.slice(0, -1) : (n.value + k.dataset.k).slice(0, 4); show(); });
      d.querySelector('#cl').onclick = close;
      d.querySelector('#dpf').onsubmit = (e) => { e.preventDefault(); const t = find(n.value); if (!t) { show(); return; } close(); Calls.start(t); };
    });
  }

  // Owners and admins: branches, who's in each, their join codes, and everyone's extension.
  function manageBranches() {
    const body = () => `<h3>Branches and extensions</h3><p>Each branch has its own join code: staff who join with it go straight into that branch with the next extension.</p>
      ${S.branches.map((b) => `<details class="brm"><summary><b>${esc(b.name)}</b>${b.extension ? ` · ${b.extension}` : ''} <span class="code sm">${esc(b.code || '')}</span></summary>
        <div class="pick">${S.people.map((p) => `<label class="pk"><input type="checkbox" data-br="${b.id}" value="${p.user_id}"${b.people.includes(p.user_id) ? ' checked' : ''}>${av(p.user_id, p.display_name)}<span>${esc(p.display_name)}</span></label>`).join('')}</div>
        <div class="row2"><button class="btn sm" data-save="${b.id}">Save who's in it</button><button class="btn sm" data-code="${b.id}">New join code</button></div></details>`).join('')}
      <form id="nb" class="row2" style="margin-top:10px"><input name="name" required maxlength="60" placeholder="New branch, e.g. Nadi branch" class="inl"><button class="btn sm">+ Add branch</button></form>
      <h4 style="margin:18px 0 6px">Extensions</h4>
      <div class="exts">${S.people.map((p) => `<label>${av(p.user_id, p.display_name)}<span>${esc(p.display_name)}</span><input type="number" min="10" max="9999" value="${p.extension || ''}" data-ext="${p.user_id}" aria-label="Extension for ${esc(p.display_name)}"></label>`).join('')}</div>
      <div class="mfoot"><button class="btn" id="cl">Close</button><button class="btn p" id="sx">Save extensions</button></div>`;
    modal(body(), function wire(d, close) {
      const refresh = async () => { [S.people, S.branches] = await Promise.all([api.people(S.team.id), api.branches(S.team.id)]); renderSide();
        d.querySelector('.mcard').innerHTML = body(); wire(d, close); };
      const run = async (fn) => { try { await fn(); } catch (err) { alert(plainError(err)); } await refresh(); };
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('[data-save]').forEach((b) => b.onclick = () => run(async () => {
        const br = S.branches.find((x) => x.id === b.dataset.save);
        const now = [...d.querySelectorAll(`input[data-br="${br.id}"]:checked`)].map((x) => x.value);
        await api.setBranchPeople(br.id, now.filter((u) => !br.people.includes(u)), br.people.filter((u) => !now.includes(u))); }));
      d.querySelectorAll('[data-code]').forEach((b) => b.onclick = () => { if (confirm('Make a new join code for this branch? The old one stops working.')) run(() => api.newBranchCode(b.dataset.code)); });
      d.querySelector('#nb').onsubmit = (e) => { e.preventDefault(); const nm = String(new FormData(e.target).get('name')).trim(); if (nm) run(() => api.createBranch(S.team.id, nm)); };
      d.querySelector('#sx').onclick = () => run(async () => {
        for (const i of d.querySelectorAll('[data-ext]')) {
          const p = S.people.find((x) => x.user_id === i.dataset.ext); const v = i.value ? Number(i.value) : null;
          if ((p.extension || null) !== v) await api.setExtension(S.team.id, p.user_id, v);
        } });
    });
  }

  const Calls = (() => {
    const ICE = CFG.iceServers || [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    let call = null; let listening = null;
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2));
    const send = (to, kind, payload) => api.signal(S.team.id, call.id, to, kind, payload).catch((e) => console.warn('call signal', e));
    const myName = () => (S.people.find((p) => p.user_id === S.user.id) || {}).display_name || 'Someone';

    // ---- sounds: a ring for incoming calls, a softer ring-back while calling out
    let audio = null; let toneTimer = null;
    function tone(kind) {
      stopTone();
      try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
      const beep = (f1, f2, len) => { const t = audio.currentTime; const g = audio.createGain(); g.gain.value = kind === 'in' ? 0.12 : 0.05; g.connect(audio.destination);
        for (const f of [f1, f2]) { const o = audio.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + len); } };
      const once = () => (kind === 'in' ? (beep(440, 480, 0.4), setTimeout(() => beep(440, 480, 0.4), 600)) : beep(400, 450, 1.0));
      once(); toneTimer = setInterval(once, kind === 'in' ? 2500 : 3000);
    }
    function stopTone() { clearInterval(toneTimer); toneTimer = null; }

    // ---- the call window
    function box() { let b = document.getElementById('callbox'); if (!b) { b = document.createElement('div'); b.id = 'callbox'; document.body.appendChild(b); } return b; }
    const fmtTime = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    function draw() {
      const b = box();
      if (!call) { b.innerHTML = ''; b.className = ''; return; }
      const who = call.peer ? nameOf(call.peer) : call.label;
      const sub = call.status === 'incoming' ? `Incoming call${call.via ? ` to ${esc(call.via)}` : ''}`
        : call.status === 'calling' ? `Calling${call.branch ? ' everyone' : ''}…` : call.status === 'connecting' ? 'Connecting…'
        : call.status === 'live' ? `<span id="ctime">${fmtTime(Date.now() - call.startedAt)}</span>${call.sim ? ' · demo call, no sound' : ''}` : esc(call.note || 'Call ended');
      b.className = 'on' + (call.cam || call.remoteVideo ? ' video' : '') + (call.cam && call.remoteVideo ? ' both' : '');
      b.innerHTML = `<div class="cwin" role="dialog" aria-label="Call">
        <video id="rv" autoplay playsinline ${call.remoteVideo ? '' : 'hidden'}></video><video id="lv" autoplay playsinline muted ${call.cam ? '' : 'hidden'}></video>
        <div class="cwho">${call.peer ? av(call.peer, who, 'big') : '<span class="av big" style="background:#a21caf">📞</span>'}<div><b>${esc(who || '')}</b><small>${sub}</small></div></div>
        <div class="cbtns">${call.status === 'incoming'
          ? `<button class="cb no" id="c-dec">Decline</button><button class="cb yes" id="c-ans">Answer</button>`
          : call.status === 'ended' ? '' : `<button class="cb${call.muted ? ' off' : ''}" id="c-mute">${call.muted ? 'Unmute' : 'Mute'}</button>
            ${call.status === 'live' && !call.sim ? `<button class="cb${call.cam ? ' off' : ''}" id="c-cam">${call.cam ? 'Camera off' : 'Camera'}</button>` : ''}
            <button class="cb no" id="c-end">${call.status === 'live' ? 'Hang up' : 'Cancel'}</button>`}</div>
        <audio id="ra" autoplay></audio></div>`;
      const on = (id, fn) => { const e = b.querySelector(id); if (e) e.onclick = fn; };
      on('#c-ans', answer); on('#c-dec', decline); on('#c-end', () => hangup()); on('#c-mute', mute); on('#c-cam', camera);
      if (call.remoteStream) { b.querySelector('#ra').srcObject = call.remoteStream; b.querySelector('#rv').srcObject = call.remoteStream; }
      if (call.camTrack) b.querySelector('#lv').srcObject = new MediaStream([call.camTrack]);
    }
    setInterval(() => { const t = document.getElementById('ctime'); if (t && call && call.startedAt) t.textContent = fmtTime(Date.now() - call.startedAt); }, 1000);

    async function mic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser can\'t make calls. Use Riyeser Central, Chrome or Edge.');
      try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
      catch (e) { throw new Error('Riyeser Team needs your microphone for calls. Allow it when asked (or in the browser\'s site settings), then try again.'); }
    }

    // ---- start a call to a person ({user}) or a branch ({branch})
    async function start(t) {
      if (!S.features.calls) return upsell();
      if (call && call.status !== 'ended') return;
      let targets; let label;
      if (t.branch) { const b = S.branches.find((x) => x.id === t.branch); if (!b) return;
        targets = b.people.filter((u) => u !== S.user.id); label = b.name;
        if (!targets.length) return alert(`Nobody else is in ${b.name} yet. Add people under ⚙ Branches and extensions.`); }
      else { targets = [t.user]; label = nameOf(t.user); }
      call = { id: uuid(), dir: 'out', status: 'calling', targets: new Set(targets), label, branch: t.branch || null, peer: t.user || null, pendingIce: [] };
      draw();
      try { call.local = await mic(); } catch (e) { call = null; draw(); return alert(e.message); }
      if (!call) return;
      tone('out');
      for (const to of targets) send(to, 'ring', { from_name: myName(), via: t.branch ? label : null });
      call.timeout = setTimeout(() => { if (call && call.status === 'calling') { for (const to of call.targets) send(to, 'cancel'); finish('No answer', true); } }, 30000);
    }

    function newPc() {
      const pc = new RTCPeerConnection({ iceServers: ICE });
      pc.onicecandidate = (e) => { if (e.candidate && call && call.peer) send(call.peer, 'ice', e.candidate.toJSON()); };
      pc.ontrack = (e) => { if (!call) return; call.remoteStream = call.remoteStream || new MediaStream();
        if (!call.remoteStream.getTracks().includes(e.track)) call.remoteStream.addTrack(e.track);
        if (e.track.kind === 'video') { e.track.onunmute = () => { if (call) { call.remoteVideo = true; draw(); } }; e.track.onmute = () => { if (call) { call.remoteVideo = false; draw(); } }; }
        draw(); };
      pc.onconnectionstatechange = () => {
        if (!call) return;
        if (pc.connectionState === 'connected' && call.status !== 'live') { call.status = 'live'; call.startedAt = Date.now(); stopTone(); draw(); }
        if (pc.connectionState === 'failed') { if (call.peer) send(call.peer, 'hangup'); finish('Couldn\'t connect. A network between you may be blocking calls.'); }
      };
      return pc;
    }
    async function flushIce() { if (!call || !call.pc || !call.pc.remoteDescription) return; for (const c of call.pendingIce.splice(0)) { try { await call.pc.addIceCandidate(c); } catch { /* old candidate */ } } }

    async function onSignal(sig) {
      if (!sig || !S.team) return;
      if (sig.created_at && Date.now() - new Date(sig.created_at) > 60000) return;   // something old
      const k = sig.kind; const from = sig.from_user; const pl = sig.payload || {};
      if (k === 'ring') {
        if (call && call.status !== 'ended') { api.signal(S.team.id, sig.call_id, from, 'busy').catch(() => {}); return; }
        if (!S.features.calls) return;
        call = { id: sig.call_id, dir: 'in', status: 'incoming', peer: from, via: pl.via || null, pendingIce: [] };
        tone('in'); draw(); alertIncoming(); return;
      }
      if (!call || sig.call_id !== call.id) return;
      if (call.dir === 'in') {
        if (k === 'cancel') return finish('Missed call');
        if (k === 'taken') return finish('Answered by someone else');
        if (k === 'offer' && call.pc) {
          await call.pc.setRemoteDescription(pl);
          call.pc.getTransceivers().forEach((t) => { if (t.receiver.track && t.receiver.track.kind === 'video') t.direction = 'sendrecv'; });
          const ans = await call.pc.createAnswer(); await call.pc.setLocalDescription(ans);
          send(from, 'answer', { type: ans.type, sdp: ans.sdp }); await flushIce(); return;
        }
      } else {
        if (k === 'accept' && call.status === 'calling') {
          clearTimeout(call.timeout); call.peer = from; call.targets.delete(from);
          for (const to of call.targets) send(to, 'taken'); call.targets.clear();
          if (pl.demo) { call.sim = true; call.status = 'live'; call.startedAt = Date.now(); stopTone(); draw(); return; }
          call.status = 'connecting'; draw();
          call.pc = newPc();
          call.local.getTracks().forEach((tr) => call.pc.addTrack(tr, call.local));
          call.pc.addTransceiver('video', { direction: 'sendrecv' });
          const off = await call.pc.createOffer(); await call.pc.setLocalDescription(off);
          send(from, 'offer', { type: off.type, sdp: off.sdp }); return;
        }
        if (k === 'accept' && from !== call.peer) { api.signal(S.team.id, call.id, from, 'taken').catch(() => {}); return; }
        if ((k === 'decline' || k === 'busy') && call.status === 'calling') {
          call.targets.delete(from); if (!call.targets.size) { clearTimeout(call.timeout); finish(k === 'busy' ? `${call.label} is on another call` : `${call.label} can't take the call right now`, true); }
          return;
        }
        if (k === 'answer' && call.pc) { await call.pc.setRemoteDescription(pl); await flushIce(); return; }
      }
      if (k === 'ice' && from === call.peer) { if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(pl); } catch { /* ignore */ } } else call.pendingIce.push(pl); return; }
      if (k === 'hangup' && from === call.peer) return finish('Call ended');
    }

    async function answer() {
      if (!call || call.status !== 'incoming') return;
      stopTone(); call.status = 'connecting'; draw();
      try { call.local = await mic(); } catch (e) { send(call.peer, 'decline'); finish(e.message); return; }
      call.pc = newPc();
      call.local.getTracks().forEach((tr) => call.pc.addTrack(tr, call.local));
      send(call.peer, 'accept');
    }
    function decline() { if (!call) return; send(call.peer, 'decline'); finish('Declined'); }
    function hangup() {
      if (!call) return;
      if (call.status === 'calling') { clearTimeout(call.timeout); for (const to of call.targets) send(to, 'cancel'); return finish('Cancelled', true); }
      if (call.peer) send(call.peer, 'hangup');
      finish('Call ended');
    }
    function mute() { if (!call || !call.local) return; call.muted = !call.muted; call.local.getAudioTracks().forEach((t) => { t.enabled = !call.muted; }); draw(); }
    async function camera() {
      if (!call || !call.pc) return;
      const tx = call.pc.getTransceivers().find((t) => (t.receiver.track && t.receiver.track.kind === 'video'));
      if (!tx) return;
      if (call.cam) { await tx.sender.replaceTrack(null); call.camTrack && call.camTrack.stop(); call.camTrack = null; call.cam = false; draw(); return; }
      try { const v = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }); call.camTrack = v.getVideoTracks()[0];
        await tx.sender.replaceTrack(call.camTrack); call.cam = true; draw(); }
      catch { alert('Riyeser Team couldn\'t use your camera. Check it\'s plugged in and allowed.'); }
    }

    // ---- end: tidy up, and (caller only) leave a note in the direct message
    async function finish(note, missed) {
      if (!call) return;
      const c = call; call = null; stopTone(); clearTimeout(c.timeout);
      try { c.pc && c.pc.close(); } catch { /* closed */ }
      (c.local ? c.local.getTracks() : []).forEach((t) => t.stop()); c.camTrack && c.camTrack.stop();
      call = { ...c, status: 'ended', note, pc: null }; draw();
      setTimeout(() => { if (call && call.status === 'ended' && call.id === c.id) { call = null; draw(); } }, 2500);
      document.title = 'Riyeser Team';
      if (c.dir === 'out' && (c.peer || c.targets) && !DEMO) api.tidyCall(c.id).catch(() => {});
      if (c.dir === 'out' && c.peer) {
        const text = c.startedAt ? `📞 Call · ${fmtTime(Date.now() - c.startedAt)}` : `📞 Missed call${c.branch ? ` to ${c.label}` : ''}`;
        try { const dm = await api.openDm(S.team.id, c.peer); const m = await api.send(S.team.id, dm, text);
          if (S.ch && S.ch.id === dm && m && !S.msgs.find((x) => x.id === m.id)) { S.msgs.push(m); renderMsgs(true); }
          if (!S.chans.find((x) => x.id === dm)) { S.chans = await api.channels(S.team.id); renderSide(); } } catch { /* chat note is a nice-to-have */ }
      } else if (c.dir === 'out' && missed && c.branch) {
        const g = S.chans.find((x) => x.name === 'general'); if (g) api.send(S.team.id, g.id, `📞 Missed call to ${c.label}`).catch(() => {});
      }
    }

    function alertIncoming() {
      const who = nameOf(call.peer);
      document.title = `📞 Incoming call from ${who}`;
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Riyeser Team', { body: `Incoming call from ${who}${call.via ? ` (${call.via})` : ''}`, icon: 'icon-192.png' }); } catch { /* no notifications */ }
    }

    function listen() {
      if (listening === S.user.id) return; listening = S.user.id;
      api.onSignals(S.user.id, (sig) => onSignal(sig).catch((e) => console.warn('call', e)));
      try { if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true }); } catch { /* no notifications */ }
    }
    return { start, listen, get current() { return call; } };
  })();

  // ------------------------------------------------------------------ start
  async function start() {
    try {
      const s = await api.session();
      if (!s) { const gone = S.signedOutNote; S.signedOutNote = false;
        return gate(params.has('signup') ? 'up' : 'in', gone ? '<div class="err">That sign-in has ended (the account may have been removed). Sign in again, or create a new account.</div>' : ''); }
      S.user = s.user;
      S.home = !DEMO && !/Electron/.test(navigator.userAgent) && !params.has('chat');
      const lv = await api.aal().catch(() => ({ currentLevel: 'aal1', nextLevel: 'aal1' }));
      S.aal = lv.currentLevel;
      if (lv.nextLevel === 'aal2' && lv.currentLevel !== 'aal2') return codeScreen();
      S.teams = await api.teams(S.user.id);
      const jc = (params.get('join') || '').toUpperCase();
      if (jc && !S.teams.some((t) => t.invite_code === jc || t.company_code === jc)) return setupTeam();
      if (!S.teams.length) { const r = (await api.myRequests().catch(() => []))[0];
        return r && r.status === 'pending' ? waiting(r.company_name) : setupTeam(); }
      let last = null; try { last = localStorage.getItem('riyeser.team.last'); } catch { /* private mode */ }
      await loadTeam(S.teams.some((t) => t.id === last) ? last : S.teams[0].id);
    } catch (e) { $app.className = 'acct'; $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div><div class="err">${esc(plainError(e))}</div><button class="btn p w" onclick="location.reload()">Try again</button></div></div>`; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ch && S.user) { api.markRead(S.ch.id, S.user.id); S.unread[S.ch.id] = 0; renderSide(); } });
  setInterval(async () => { if (S.team && isAdmin() && !document.hidden) { const n = (await api.pendingRequests(S.team.id).catch(() => S.requests)) || []; if (n.length !== S.requests.length) { S.requests = n; renderSide(); } } }, 60000);
  window.RiyeserTeam = { state: S, demo: DEMO, calls: Calls, companyInfo, peopleAccess, joinRequests, security, showHistory };
  start();
})();
