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
      async session() { return ok(await sb.auth.getSession()).session; },
      onAuth(fn) { sb.auth.onAuthStateChange((_e, s) => fn(s)); },
      async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })); },
      async signUp(email, password) {
        return ok(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname + location.search } }));
      },
      async resetPassword(email) { return ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); },
      async signOut() { if (sub) sb.removeChannel(sub); await sb.auth.signOut(); },
      async teams(uid) {
        const rows = ok(await sb.from('members').select('role, display_name, workspaces(id, name, invite_code)').eq('user_id', uid));
        return rows.filter((r) => r.workspaces).map((r) => ({ ...r.workspaces, role: r.role, myName: r.display_name }));
      },
      async createTeam(name, you) { return ok(await sb.rpc('create_team', { team_name: name, your_name: you })); },
      async joinTeam(code, you) { return ok(await sb.rpc('join_team', { code, your_name: you })); },
      async newInvite(ws) { return ok(await sb.rpc('new_invite_code', { ws })); },
      async people(ws) { return ok(await sb.from('members').select('user_id, display_name, role, extension').eq('workspace_id', ws).order('display_name')); },
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
    const ppl = [['u-me', 'You', 'owner', 101], ['u-sam', 'Sam Taylor', 'admin', 102], ['u-jordan', 'Jordan Lee', 'member', 201], ['u-alex', 'Alex Nguyen', 'member', 202]];
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
      async teams() { return [{ id: ws, name: 'Sample Plumbing', invite_code: 'DEMO1234', role: 'owner', myName: 'You' }]; },
      async createTeam() { return ws; }, async joinTeam() { return ws; }, async newInvite() { return 'DEMO' + Math.floor(1000 + Math.random() * 9000); },
      async people() { return ppl.map(([user_id, display_name, role, extension]) => ({ user_id, display_name, role, extension })); },
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
    features: { calls: false }, branches: [] };
  const nameOf = (uid) => (S.people.find((p) => p.user_id === uid) || {}).display_name || 'Someone who left';
  const chanLabel = (c) => (c.kind === 'dm' ? nameOf(c.people.find((p) => p !== S.user.id) || S.user.id) : c.name);
  const demoBar = () => (DEMO ? `<div class="demo-bar">This is a demo with sample messages and calls${CONFIGURED ? ` · <a href="/team/">Sign in for real</a>` : ''} · <a href="/programs/team.html">About Riyeser Team</a></div>` : '');

  // ------------------------------------------------------------------ sign in / create account
  function gate(mode = 'in', note = '') {
    const join = params.get('join');
    $app.className = '';
    $app.innerHTML = `<div class="gate"><form class="gcard" id="gf">
      <div class="glogo"><img src="icon.svg" alt="">Riyeser Team</div>
      <h1>${mode === 'up' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in'}</h1>
      <p>${join ? 'You\'ve been invited to a team. ' : ''}${mode === 'up' ? 'Free. Use your work email.' : mode === 'reset' ? 'We\'ll email you a link to choose a new password.' : 'Chat with your team, alongside your Riyeser programs.'}</p>
      ${note}
      <label class="f"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
      ${mode !== 'reset' ? `<label class="f"><span>Password</span><input type="password" name="password" minlength="8" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" required></label>` : ''}
      <button class="btn p w" type="submit">${mode === 'up' ? 'Create account' : mode === 'reset' ? 'Send the link' : 'Sign in'}</button>
      <div class="alt">${mode === 'in' ? `New here? <button type="button" class="linkbtn" data-go="up">Create an account</button> · <button type="button" class="linkbtn" data-go="reset">Forgot password?</button>`
        : `Already have an account? <button type="button" class="linkbtn" data-go="in">Sign in</button>`}</div>
      <div class="alt"><a href="?demo">Try the demo first</a></div></form></div>`;
    $app.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => gate(b.dataset.go));
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
  function setupTeam(note = '') {
    const join = params.get('join') || '';
    $app.className = '';
    $app.innerHTML = `<div class="gate"><div class="gcard">
      <div class="glogo"><img src="icon.svg" alt="">Riyeser Team</div>
      ${note}
      <form id="jf"><h1>Join your team</h1><p>Use the invite link or code someone in your team sent you.</p>
        <label class="f"><span>Invite code</span><input name="code" value="${esc(join)}" required autocapitalize="characters"></label>
        <label class="f"><span>Your name, as the team will see it</span><input name="you" required maxlength="60"></label>
        <button class="btn p w">Join the team</button></form>
      <div class="or">or</div>
      <form id="cf"><h1 style="font-size:19px">Start a team for your business</h1>
        <label class="f"><span>Business or team name</span><input name="team" required maxlength="80" placeholder="e.g. Sample Plumbing"></label>
        <label class="f"><span>Your name</span><input name="you" required maxlength="60"></label>
        <button class="btn w">Create the team</button></form>
      <div class="alt"><button class="linkbtn" id="so">Sign out</button></div></div></div>`;
    const go = async (fn) => { try { await fn(); history.replaceState(null, '', location.pathname); await start(); } catch (e) { setupTeam(`<div class="err">${esc(plainError(e))}</div>`); } };
    $app.querySelector('#jf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); go(() => api.joinTeam(f.get('code'), f.get('you'))); };
    $app.querySelector('#cf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); go(() => api.createTeam(f.get('team'), f.get('you'))); };
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
  }

  // ------------------------------------------------------------------ the chat
  async function loadTeam(id) {
    S.team = S.teams.find((t) => t.id === id) || S.teams[0];
    try { localStorage.setItem('riyeser.team.last', S.team.id); } catch { /* private mode */ }
    [S.people, S.chans, S.unread] = await Promise.all([api.people(S.team.id), api.channels(S.team.id), api.unread(S.team.id)]);
    [S.features, S.branches] = await Promise.all([api.features(S.team.id).catch(() => ({ calls: false })), api.branches(S.team.id).catch(() => [])]);
    Calls.listen();
    const first = S.chans.find((c) => c.name === 'general') || S.chans[0];
    api.live(S.team.id, onLive);
    await openChannel(first && first.id, false);
  }

  async function openChannel(id, toChat = true) {
    S.ch = S.chans.find((c) => c.id === id) || null; S.editing = null;
    S.msgs = S.ch ? await api.messages(S.ch.id) : [];
    if (toChat) S.inChat = true;
    render();
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
    return `<div class="team"><img src="icon.svg" alt=""><div>${S.teams.length > 1
      ? `<select id="tsw" aria-label="Switch team">${S.teams.map((t) => `<option value="${t.id}"${t.id === S.team.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : `<b>${esc(S.team.name)}</b>`}<small>${S.people.length} ${S.people.length === 1 ? 'person' : 'people'}</small></div></div>
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

  function render() {
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
    el.querySelector('#inv').onclick = invite;
    el.querySelectorAll('[data-callbranch]').forEach((b) => b.onclick = () => Calls.start({ branch: b.dataset.callbranch }));
    const dp = el.querySelector('#dial'); if (dp) dp.onclick = dialPad;
    const mg = el.querySelector('#mgbr'); if (mg) mg.onclick = manageBranches;
    el.querySelector('#out').onclick = async () => { await api.signOut(); S.team = null; gate(); };
    const sw = el.querySelector('#tsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
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
    const link = () => `${location.origin}/team/?join=${S.team.invite_code}`;
    const admin = S.team.role === 'owner' || S.team.role === 'admin';
    modal(`<h3>Invite people to ${esc(S.team.name)}</h3><p>Send them this link. They create a free account, then join with the code.</p>
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


  // ================================================================== Riyeser Team Calls (premium)
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
    modal(`<h3>⭐ Riyeser Team Calls</h3><p>Calls between your people and branches, on the PC and phone: ring a person or a whole branch, answer on any device you're signed in on, with no call charges.</p>
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
      if (!s) return gate();
      S.user = s.user;
      S.teams = await api.teams(S.user.id);
      if (!S.teams.length || (params.get('join') && !S.teams.some((t) => t.invite_code === params.get('join').toUpperCase()))) return setupTeam();
      let last = null; try { last = localStorage.getItem('riyeser.team.last'); } catch { /* private mode */ }
      await loadTeam(S.teams.some((t) => t.id === last) ? last : S.teams[0].id);
    } catch (e) { $app.className = ''; $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo"><img src="icon.svg" alt="">Riyeser Team</div><div class="err">${esc(plainError(e))}</div><button class="btn p w" onclick="location.reload()">Try again</button></div></div>`; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ch && S.user) { api.markRead(S.ch.id, S.user.id); S.unread[S.ch.id] = 0; renderSide(); } });
  window.RiyeserTeam = { state: S, demo: DEMO, calls: Calls };
  start();
})();
