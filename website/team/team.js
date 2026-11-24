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
      async people(ws) { return ok(await sb.from('members').select('user_id, display_name, role').eq('workspace_id', ws).order('display_name')); },
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
    const me = { id: 'u-me', email: 'you@sample.test' };
    const ws = 'w-demo';
    const ppl = [['u-me', 'You', 'owner'], ['u-sam', 'Sam Taylor', 'admin'], ['u-jordan', 'Jordan Lee', 'member'], ['u-alex', 'Alex Nguyen', 'member']];
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
      async people() { return ppl.map(([user_id, display_name, role]) => ({ user_id, display_name, role })); },
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
  const S = { user: null, teams: [], team: null, people: [], chans: [], unread: {}, ch: null, msgs: [], inChat: false, editing: null };
  const nameOf = (uid) => (S.people.find((p) => p.user_id === uid) || {}).display_name || 'Someone who left';
  const chanLabel = (c) => (c.kind === 'dm' ? nameOf(c.people.find((p) => p !== S.user.id) || S.user.id) : c.name);
  const demoBar = () => (DEMO ? `<div class="demo-bar">This is a demo with sample messages${CONFIGURED ? ` · <a href="/team/">Sign in for real</a>` : ''} · <a href="/programs/team.html">About Riyeser Team</a></div>` : '');

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
      ${others.map((p) => { const dm = dmFor(p.user_id); return `<button class="item${dm && S.ch && S.ch.id === dm.id ? ' on' : ''}${dm && S.unread[dm.id] ? ' unread' : ''}" data-dm="${p.user_id}">${av(p.user_id, p.display_name)}<span class="nm">${esc(p.display_name)}</span>${dm ? unreadBadge(dm.id) : ''}</button>`; }).join('')
        || '<p style="padding:4px 10px;color:var(--side-muted);font-size:13px">Invite your team to start chatting.</p>'}
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
    el.querySelector('#out').onclick = async () => { await api.signOut(); S.team = null; gate(); };
    const sw = el.querySelector('#tsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
  }
  function renderHead() {
    const el = document.getElementById('mhead'); if (!el) return;
    el.innerHTML = `<button class="back" aria-label="Back to channels">‹</button>${S.ch ? (S.ch.kind === 'dm'
      ? `${av(S.ch.people.find((p) => p !== S.user.id) || S.user.id, chanLabel(S.ch))}<div><h2>${esc(chanLabel(S.ch))}</h2><small>Direct message</small></div>`
      : `<div style="flex:1;min-width:0"><h2>${S.ch.kind === 'private' ? '🔒' : '#'} ${esc(S.ch.name)}</h2><small>${S.ch.kind === 'private' ? `Private · ${S.ch.people.length} ${S.ch.people.length === 1 ? 'person' : 'people'}${S.ch.topic ? ' · ' : ''}` : ''}${esc(S.ch.topic || '')}</small></div>${S.ch.kind === 'private' ? '<button class="btn sm" id="ppl">People</button>' : ''}`) : ''}`;
    el.querySelector('.back').onclick = () => { S.inChat = false; document.querySelector('.shell').classList.remove('inchat'); };
    const pb = el.querySelector('#ppl'); if (pb) pb.onclick = peopleOf;
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
  window.RiyeserTeam = { state: S, demo: DEMO };
  start();
})();
