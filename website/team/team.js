/* Riyeser Link (formerly Riyeser Team): chat for a business. Channels, direct messages, live updates and unread counts.
   Served at riyeser.com/link/ and, unchanged, at its old address riyeser.com/team/ (older desktop apps and links).
   Runs on its own Supabase project (config.js, database in team-chat.sql). With ?demo, or before it's
   set up, it runs on sample data in this browser only, so anyone can try it. */
(() => {
  'use strict';
  const CFG = window.RIYESER_TEAM || {};
  const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const params = new URLSearchParams(location.search);
  // A link from one of our account emails (Supabase): #access_token=…&type=signup (confirm your email), type=recovery
  // (reset your password), or #error_code=otp_expired&error_description=… when the link is old or was used already.
  // Read now: the sign-in library takes these out of the address as it signs in.
  const AUTH = (() => { const h = new URLSearchParams(location.hash.replace(/^#/, '')); const type = h.has('access_token') ? (h.get('type') || '') : '';
    return { type, recovery: type === 'recovery', confirmed: ['signup', 'email_change', 'invite'].includes(type),
      error: h.has('access_token') ? '' : (h.get('error_code') || h.get('error') || params.get('error_code') || ''), errorText: h.get('error_description') || params.get('error_description') || '' }; })();
  const DEMO = params.has('demo') || !CONFIGURED;
  const $app = document.getElementById('app');
  const NAME = 'Riyeser Link';
  // Prices are in US dollars a month per business (the full list is on riyeser.com/pricing.html, from website/prices.mjs).
  // PRICE is the same list as PRICE in website/prices.mjs and riyeser_price() in team-chat.sql (pay-test.js checks they agree).
  const PRICE = { basic: 25, plus: 39, payroll: 25, pos: 29, bookings: 25, calls: 39, as_built: 29, users_included: 3, extra_user: 7, extra_company: 10 };
  const PRICE_LINK_PLUS = PRICE.calls;
  const PRICE_EXTRA_USER = PRICE.extra_user;   // each person after the 3 included, a month, per paid program
  const STORAGE_GB = { free: 2, plus: 20 };   // Riyeser Link files per business (the database enforces it: link_storage_limit)
  const GB = 1073741824;
  const usd = (n) => `US$${n % 1 ? n.toFixed(2) : n}`;
  // This page's own folder (/link/ or the old /team/), so signing out and the demo stay where they are.
  const HERE = location.pathname.replace(/[^/]*$/, '') || '/link/';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLOURS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#0d9488'];
  const colourOf = (id) => COLOURS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLOURS.length];
  const initials = (n) => (String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
  const av = (id, name, cls = '') => `<span class="av ${cls}" style="background:${colourOf(id)}" aria-hidden="true">${esc(initials(name))}</span>`;
  const plainError = (e) => {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e); const code = String((e && (e.code || e.error_code)) || '');
    if (/Invalid login/i.test(m)) return 'That email or password isn\'t right.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first: open the link we emailed you, then sign in.';
    if (/already registered/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
    if (/Password should be/i.test(m)) return 'Choose a password of at least 8 characters.';
    if (/should be different from the old|same_password/i.test(m + ' ' + code)) return 'That\'s the password you have now. Choose a different one.';
    // Supabase's sender stops after a few emails an hour ("email rate limit exceeded"), or can't send at all
    if (/email rate limit|over_email_send_rate_limit|error sending .*email|email_send|smtp/i.test(m + ' ' + code)) return 'We couldn\'t send the email just now. Try again in a few minutes or contact info@riyeser.com';
    if (/over_request_rate_limit|request rate limit|for security purposes, you can only request/i.test(m + ' ' + code)) return 'Too many tries just now. Wait a minute, then try again.';
    if (/friendly name .* already exists|mfa_factor_name_conflict/i.test(m + ' ' + code)) return 'Two-step sign-in couldn\'t start just now. Close this box and press Turn on two-step sign-in again.';
    if (/Signups not allowed/i.test(m)) return 'New accounts aren\'t open yet. Ask Riyeser to turn on sign-ups.';
    if (/Invalid TOTP|mfa_verification_failed|expired/i.test(m)) return 'That code isn\'t right. Type the 6 numbers your authenticator app shows now (they change every 30 seconds).';
    if (/created_by_fkey|JWT|sub claim/i.test(m)) return 'Your sign-in has ended. Sign out, then sign in again.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Can\'t reach Riyeser Link. Check your internet connection and try again.';
    if (/PGRST202|Could not find the function/i.test(m)) return 'This part of Riyeser is still being switched on. Use Get help for now.';
    return m;
  };

  // ------------------------------------------------------------------ the online service (Supabase)
  function onlineBackend() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, storageKey: 'riyeser.team.session' } });
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    let sub = null; let sub2 = null;
    // Parts of this release's team-chat.sql that a database may not have yet: those calls give null and the app hides them.
    const missing = (e) => /PGRST20[25]|42P01|42883|Could not find|schema cache|does not exist/i.test(String((e && (e.message || e.code)) || ''));
    const soft = async (q) => { const r = await q; if (r.error) { if (missing(r.error)) return null; throw r.error; } return r.data; };
    return {
      demo: false,
      async session() { return ok(await sb.auth.getSession()).session || null; },
      // The browser can remember a sign-in for an account that was since removed: ask the server, and sign out if it's gone.
      // (Asked at the same time as the account's businesses, S4.)
      async stillThere() {
        const { error } = await sb.auth.getUser();
        if (error && [401, 403, 404].includes(error.status)) { await sb.auth.signOut({ scope: 'local' }).catch(() => {}); S.signedOutNote = true; return false; }
        return true;
      },
      onAuth(fn) { sb.auth.onAuthStateChange((ev, s) => fn(ev, s)); },
      // A new password: from the reset link, or Change password. Every other sign-in of this account (other devices) ends.
      async setPassword(password) { ok(await sb.auth.updateUser({ password })); await sb.auth.signOut({ scope: 'others' }).catch(() => {}); },
      // Change password asks for the current one: checked with a separate, throwaway sign-in so this page's own stays as it is.
      async checkPassword(email, password) {
        const c = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'riyeser.pwcheck' } });
        const r = await c.auth.signInWithPassword({ email, password });
        if (r.error) { if (/Invalid login/i.test(r.error.message || '')) throw new Error('Your current password isn\'t right.'); throw r.error; }
        await c.auth.signOut({ scope: 'local' }).catch(() => {});
      },
      async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })); },
      async signUp(email, password, details) {
        // details (name, contact, optional business) are kept with the account and used to set it up after the email is confirmed
        return ok(await sb.auth.signUp({ email, password, options: { data: details ? { riyeser_signup: details } : {}, emailRedirectTo: location.origin + location.pathname + location.search } }));
      },
      async resetPassword(email) { return ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); },
      async signOut() { if (sub) sb.removeChannel(sub); if (sub2) sb.removeChannel(sub2); await sb.auth.signOut(); },
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
      // Your own name (in this business) and phone (kept with your account, so Riyeser Support sees the current one)
      async updateMyDetails(ws, uid, name, phone) {
        if (name) ok(await sb.from('members').update({ display_name: name }).eq('workspace_id', ws).eq('user_id', uid));
        const md = ((ok(await sb.auth.getUser()) || {}).user || {}).user_metadata || {};
        const su = md.riyeser_signup && typeof md.riyeser_signup === 'object' ? md.riyeser_signup : {};
        const r = ok(await sb.auth.updateUser({ data: { riyeser_signup: { ...su, you: name || su.you || '', phone: phone || '' } } }));
        return (r && r.user) || null;
      },
      async devices(ws) { return ok(await sb.from('devices').select('id, user_id, device_name, platform, app_version, last_seen').eq('workspace_id', ws).order('last_seen', { ascending: false })); },
      async unlinkDevice(id) { ok(await sb.from('devices').delete().eq('id', id)); },
      async aal() { return ok(await sb.auth.mfa.getAuthenticatorAssuranceLevel()); },
      async factors() { const f = ok(await sb.auth.mfa.listFactors()); return (f.totp || []).filter((x) => x.status === 'verified'); },
      async enrol() {
        // Set-ups that were started and never finished (Later, or the box closed) would block a new one: remove them first.
        const all = ok(await sb.auth.mfa.listFactors()).all || [];
        for (const f of all) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
        // A name of its own each time (the full time and a random part), so pressing the button again always works
        const name = 'Riyeser ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + Math.random().toString(36).slice(2, 7);
        const r = ok(await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: name }));
        // Supabase gives the QR code either as a data: address or as raw SVG text; always hand back something an <img> can show
        const q = String(r.totp.qr_code || '').trim();
        const raw = q.startsWith('<') ? q : (/^data:image\/svg\+xml;[^,]*,\s*</.test(q) ? q.slice(q.indexOf(',') + 1).trim() : '');   // supabase-js adds a data: prefix without encoding the SVG
        const qr = raw ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(raw) : q;
        return { id: r.id, qr, secret: r.totp.secret }; },
      async verifyCode(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      async unenrol(factorId) { ok(await sb.auth.mfa.unenroll({ factorId })); },
      async licence(ws) { return ok(await sb.rpc('company_licence', { ws })); },
      async history(ws) { return ok(await sb.from('audit_log').select('id, at, actor, action, details').eq('workspace_id', ws).order('at', { ascending: false }).limit(200)); },
      async joinTeam(code, you) { return ok(await sb.rpc('join_team', { code, your_name: you })); },
      async newInvite(ws) { return ok(await sb.rpc('new_invite_code', { ws })); },
      async people(ws) { return ok(await sb.from('members').select('user_id, display_name, role, job_role, extension').eq('workspace_id', ws).order('display_name')); },
      async channels(ws) {
        // archived channels come too (the list shows them under Archived, read-only)
        const chans = ok(await sb.from('channels').select('id, kind, name, topic, created_by, archived').eq('workspace_id', ws).order('name'));
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
      // The channel menu. channelPrefs is null on a database without this release's team-chat.sql (Mute, Leave and the
      // rest then hide). The database checks who may rename, change the topic or archive, and protects #general.
      async channelPrefs(_ws, uid) { return soft(sb.from('channel_prefs').select('channel_id, muted, left_at').eq('user_id', uid)); },
      async renameChannel(ch, name, topic) { ok(await sb.rpc('channel_rename', { ch, new_name: name, new_topic: topic })); },
      async archiveChannel(ch, on) { ok(await sb.rpc('channel_archive', { ch, archive: !!on })); },
      async muteChannel(ch, on) { ok(await sb.rpc('channel_mute', { ch, mute_on: !!on })); },
      async leaveChannel(ch) { ok(await sb.rpc('channel_leave', { ch })); },
      async rejoinChannel(ch) { ok(await sb.rpc('channel_rejoin', { ch })); },
      async openDm(ws, person) { return ok(await sb.rpc('open_dm', { ws, person })); },
      async messages(ch) {
        const rows = ok(await sb.from('messages').select('*').eq('channel_id', ch).order('created_at', { ascending: false }).limit(200));
        return rows.reverse();
      },
      async send(ws, ch, body, files) { return ok(await sb.from('messages').insert({ workspace_id: ws, channel_id: ch, body, ...(files && files.length ? { files } : {}) }).select('*').single()); },
      // ---- the Link workspace: your look (kept with your account), presence, reactions, pins, files, search
      async savePrefs(p) {
        const u = (ok(await sb.auth.getUser()) || {}).user || {}; const cur = (u.user_metadata || {}).riyeser_prefs;
        const r = ok(await sb.auth.updateUser({ data: { riyeser_prefs: { ...(cur && typeof cur === 'object' ? cur : {}), ...p } } }));
        return (r && r.user) || null;
      },
      async presence(ws) { return soft(sb.rpc('link_presence', { ws })); },
      async setPresence(ws, p) { ok(await sb.rpc('link_presence_set', { ws, st: p.status, manual_choice: p.manual || null, custom: p.text || '', on_a_call: !!p.on_call })); },
      async reactions(ch) { return soft(sb.from('message_reactions').select('message_id, user_id, emoji').eq('channel_id', ch)); },
      async react(_ws, msg, uid, emoji, on) {
        if (on) ok(await sb.from('message_reactions').insert({ message_id: msg, emoji }));
        else ok(await sb.from('message_reactions').delete().eq('message_id', msg).eq('user_id', uid).eq('emoji', emoji));
      },
      async pins(_ws, uid) { const r = await soft(sb.from('channel_pins').select('channel_id').eq('user_id', uid)); return r && r.map((x) => x.channel_id); },
      async pin(_ws, ch, uid, on) {
        if (on) ok(await sb.from('channel_pins').upsert({ channel_id: ch, user_id: uid }, { onConflict: 'user_id,channel_id', ignoreDuplicates: true }));
        else ok(await sb.from('channel_pins').delete().eq('channel_id', ch).eq('user_id', uid));
      },
      async lastMessages(ws) {
        const rows = ok(await sb.from('messages').select('*').eq('workspace_id', ws).order('created_at', { ascending: false }).limit(300));
        const out = {}; for (const m of rows) if (!out[m.channel_id]) out[m.channel_id] = m; return out;
      },
      async search(ws, q) {
        const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
        return ok(await sb.from('messages').select('*').eq('workspace_id', ws).eq('deleted', false).ilike('body', like).order('created_at', { ascending: false }).limit(20));
      },
      // Files go to the private "link-files" store, in a folder for this business and chat; only people in the chat can get them.
      async upload(ws, ch, file, name) {
        const rnd = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^0-9a-f]/gi, '').slice(0, 20);
        const path = `${ws}/${ch}/${rnd}/${name}`;
        ok(await sb.storage.from('link-files').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false }));
        return { path, name, size: file.size, type: file.type || '' };
      },
      async fileUrl(path, name) { return ok(await sb.storage.from('link-files').createSignedUrl(path, 120, { download: name })).signedUrl; },
      // File storage (2 GB free, 20 GB with Link Plus): null on a database without this release's team-chat.sql.
      async storage(ws) { return soft(sb.rpc('link_storage_json', { ws })); },
      async storageFits(ws, size) { return soft(sb.rpc('link_storage_fits', { ws, size })); },
      liveExtra(ws, fns) {
        if (sub2) sb.removeChannel(sub2);
        sub2 = sb.channel('link-' + ws);
        if (fns.presence) sub2.on('postgres_changes', { event: '*', schema: 'public', table: 'presence', filter: 'workspace_id=eq.' + ws }, (p) => fns.presence(p.new));
        if (fns.reaction) {
          sub2.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions', filter: 'workspace_id=eq.' + ws }, (p) => fns.reaction(p.new));
          sub2.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (p) => fns.reaction(p.old));   // deletes carry only the key
        }
        sub2.subscribe();
      },
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
      // Help requests, refunds and activity. These arrived with HQ: on a database that hasn't been updated yet they
      // fail, and the website hides them (touch never shows an error).
      async touch() { try { await sb.rpc('touch_activity'); } catch { /* not there yet */ } },
      async closedBusinesses() { return ok(await sb.rpc('my_closed_businesses')) || []; },
      async myTickets() { return ok(await sb.rpc('my_tickets')) || []; },
      async openTicket(ws, topic, subject, message) { return ok(await sb.rpc('open_ticket', { ws: ws || null, help_topic: topic, help_subject: subject, message })); },
      async ticket(id) { return ok(await sb.rpc('my_ticket', { ticket: id })); },
      async replyTicket(id, message) { ok(await sb.rpc('reply_ticket', { ticket: id, message })); },
      // Report an issue, Still having an issue, Confirm fixed and the rating (newer team-chat.sql)
      async reportIssue(ws, payload) { return ok(await sb.rpc('support_report', { ws, payload })); },
      async stillIssue(id, message) { ok(await sb.rpc('ticket_still_issue', { ticket: id, message: message || '' })); },
      async confirmFixed(id) { ok(await sb.rpc('ticket_confirm_fixed', { ticket: id })); },
      async rateTicket(id, stars, comment) { ok(await sb.rpc('ticket_rate', { ticket: id, stars, comment: comment || null })); },
      async myRefunds(ws) { return ok(await sb.rpc('my_refunds', { ws })) || []; },
      // Paying (the owner): null = this database hasn't had the payments part of team-chat.sql yet (Billing then hides).
      async myBilling(ws) { return soft(sb.rpc('my_billing', { ws })); },
      async billingQuote(ws, mods, people, period) { return ok(await sb.rpc('billing_quote', { ws, mods, people, billing_period: period })); },
      async billingStart(ws, mods, people, period, how) { return ok(await sb.rpc('billing_start', { ws, mods, people, billing_period: period, pay_method: how })); },
      async billingCancelInvoice(ws, ref) { ok(await sb.rpc('billing_cancel_invoice', { ws, invoice_ref: ref })); },
      // The paypal Edge Function (supabase/functions/paypal on main). Its status says whether PayPal is set up.
      async paypal(route, body) {
        const s = body ? ok(await sb.auth.getSession()).session : null;
        const r = await fetch(`${CFG.supabaseUrl}/functions/v1/paypal/${route}`, { method: body ? 'POST' : 'GET',
          headers: { apikey: CFG.supabaseKey, ...(s ? { Authorization: `Bearer ${s.access_token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined });
        let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
        if (!r.ok) throw new Error(j.error || 'PayPal isn\'t answering right now. Try again in a minute, or pay by bank transfer.');
        return j;
      },
      async paypalStatus() { try { return await this.paypal('status'); } catch { return { ready: false }; } },
      async paypalSubscribe(ws, mods, people, period) { return this.paypal('subscribe', { ws, modules: mods, people, billing: period }); },
      async paypalCancel(ws) { return this.paypal('cancel', { ws }); },
      // Riyeser Link Office (desk phones). null = the database hasn't had this release's team-chat.sql yet.
      async linkStatus(ws) { try { return ok(await sb.rpc('link_status', { ws })); } catch (e) { if (/PGRST202|Could not find the function|schema cache/i.test(e.message || '')) return null; throw e; } },
      async linkCommand(ws, office, kind, data) { return ok(await sb.rpc('link_command', { ws, office_id: office, kind, data: data || {} })); },
      async linkCommandState(id) { return ok(await sb.rpc('link_command_state', { command: id })); },
      async linkRevealTake(id) { return ok(await sb.rpc('link_reveal_take', { command: id })); },
      // My phone (everyone): null = the database hasn't had this release's team-chat.sql yet
      async linkMyPhone(ws) { try { return ok(await sb.rpc('link_my_phone', { ws })); } catch (e) { if (/PGRST202|Could not find the function|schema cache/i.test(e.message || '')) return null; throw e; } },
      async linkMyReveal(ws, key) { return ok(await sb.rpc('link_my_reveal', { ws, pub_key: key })); },
      async linkMyDnd(ws, on) { return ok(await sb.rpc('link_my_dnd', { ws, dnd_on: !!on })); },
      async linkSupport(ws, allow) { return ok(await sb.rpc(allow ? 'link_support_allow' : 'link_support_end', { ws })); },
      async requestRefund(ws, r) { return ok(await sb.rpc('request_refund', { ws, for_what: r.for_what, period: r.period, invoice_ref: r.invoice_ref,
        amount: r.amount, currency: r.currency, reason_category: r.reason_category, explanation: r.explanation, ticket: null })); },
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
    const ppl = [['u-me', 'You', 'owner', 101, 'owner'], ['u-sam', 'Sam Taylor', 'admin', 102, 'manager'], ['u-jordan', 'Jordan Lee', 'member', 201, 'staff'], ['u-alex', 'Alex Nguyen', 'member', 202, 'sales'],
      ['u-ana', 'Ana Ruiz', 'member', 103, 'bookkeeper']];
    const mfa = { on: true };
    const company = { name: 'Sample Plumbing', company_code: 'RIY-7K3M-Q2', legal_name: 'Sample Plumbing Pty Ltd', tax_number: '12 345 678 901', address: '4 Harbour Rd, Suva', phone: '330 1234', email: 'office@sample.test', country: 'Fiji', require_approval: true };
    const reqs = [{ id: 'r1', display_name: 'Mere Vula', email: 'mere@sample.test', branch_id: 'b-lau', note: 'New front desk at Lautoka', created_at: new Date(Date.now() - 25 * 60000).toISOString(), status: 'pending' }];
    const devs = [{ id: 'd1', user_id: 'u-me', device_name: 'Head office PC', platform: 'Windows', app_version: '1.7.0', last_seen: new Date(Date.now() - 2 * 60000).toISOString() },
      { id: 'd2', user_id: 'u-jordan', device_name: 'Lautoka front desk', platform: 'Windows', app_version: '1.7.0', last_seen: new Date(Date.now() - 3 * 3600000).toISOString() }];
    const brs = [{ id: 'b-head', name: 'Head office', code: 'HEA-3071', extension: 100, people: ['u-me', 'u-sam', 'u-ana'] },
      { id: 'b-lau', name: 'Lautoka branch', code: 'LAU-4821', extension: 200, people: ['u-jordan', 'u-alex'] }];
    // Calls in the demo travel between browser tabs (open the demo again with ?demo&as=u-sam to be Sam).
    const bus = 'BroadcastChannel' in window ? new BroadcastChannel('riyeser-team-demo-calls') : null;
    const online = new Set([AS]); let onSig = null; let onPres = null;
    const now = Date.now(); const ago = (m) => new Date(now - m * 60000).toISOString();
    // Who's around in the demo. Other demo tabs (?demo&as=u-sam) tell each other their real status.
    const pres = { 'u-sam': { user_id: 'u-sam', status: 'available', custom_text: '', on_call: false, fresh: true },
      'u-jordan': { user_id: 'u-jordan', status: 'busy', custom_text: '', on_call: true, fresh: true },
      'u-alex': { user_id: 'u-alex', status: 'away', custom_text: '', on_call: false, away_since: ago(10), fresh: true },
      'u-ana': { user_id: 'u-ana', status: 'offline', custom_text: '', on_call: false, fresh: false },
      'u-me': { user_id: 'u-me', status: 'available', custom_text: 'In the office today', on_call: false, fresh: true } };
    let myPres = null;
    if (bus) {
      bus.onmessage = (e) => { const m = e.data || {};
        if (m.hello) { online.add(m.hello); if (!m.reply) bus.postMessage({ hello: AS, reply: true }); if (myPres) bus.postMessage({ presence: myPres }); return; }
        if (m.presence) { pres[m.presence.user_id] = { ...m.presence, fresh: m.presence.status !== 'offline' }; if (onPres) onPres(pres[m.presence.user_id]); return; }
        if (m.to === AS && onSig) onSig(m); };
      bus.postMessage({ hello: AS });
      addEventListener('pagehide', () => { if (myPres) bus.postMessage({ presence: { ...myPres, status: 'offline', on_call: false } }); });
    }
    const chans = [{ id: 'c-general', kind: 'channel', name: 'general', topic: 'Everyone in the team', people: [], created_by: 'u-me' },
      { id: 'c-jobs', kind: 'channel', name: 'jobs', topic: 'Jobs, bookings and what\'s on today', people: [], created_by: 'u-jordan' },
      { id: 'c-office', kind: 'channel', name: 'office', topic: 'Invoices, bills and paperwork', people: [], created_by: 'u-me' },
      { id: 'c-exec', kind: 'private', name: 'executives', topic: 'Owners and managers only', people: ['u-me', 'u-sam'], created_by: 'u-me' },
      { id: 'd-sam', kind: 'dm', name: null, topic: null, people: ['u-me', 'u-sam'] },
      { id: 'd-alex', kind: 'dm', name: null, topic: null, people: ['u-me', 'u-alex'] }];
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
      msg('d-sam', 'u-sam', 'Can you approve the timesheets before 3? Pay run goes tonight.', 30),
      msg('d-alex', 'u-alex', 'Back from the yard in 20 min, then I\'ll call the supplier.', 12),
      msg('c-general', 'u-me', 'Morning team 👋 Quick update: the Hill Rd fit-out is on track. Please post your site notes by 4pm.', 50),
      msg('c-general', 'u-jordan', 'Got it. I\'ll send the final test results this afternoon.', 44),
      { ...msg('c-jobs', 'u-jordan', 'Job sheet for Booking 12, signed by the customer.', 16), files: [{ path: 'demo/c-jobs/sample/Job_12_sheet.pdf', name: 'Job_12_sheet.pdf', size: 188416, type: 'application/pdf' }] },
      msg('c-general', 'u-sam', 'Site visit tomorrow at 8am. Gear is ready and the access team knows we\'re coming ✅', 6),
      msg('c-general', 'u-sam', 'Bring your hard hats and hi-vis, please.', 5)];
    const read = { 'c-general': ago(10), 'c-jobs': ago(92), 'c-office': ago(61), 'c-exec': ago(200), 'd-sam': ago(40), 'd-alex': ago(60) };
    // reactions, pinned chats and files in the demo
    const rx = [['m1', 'u-alex', '👍'], ['m1', 'u-jordan', '👍'], ['m1', 'u-sam', '🎉'], ['m4', 'u-me', '👍'], ['m5', 'u-sam', '✅'], ['m5', 'u-alex', '✅'], ['m5', 'u-me', '🎉'],
      ['m7', 'u-me', '🎉'], ['m7', 'u-jordan', '🎉'], ['m7', 'u-alex', '❤️'], ['m11', 'u-sam', '👍'], ['m11', 'u-alex', '👍'], ['m11', 'u-jordan', '👍'], ['m11', 'u-ana', '🎉'],
      ['m14', 'u-jordan', '✅']].map(([message_id, user_id, emoji]) => ({ message_id, user_id, emoji }));
    let pinned = ['c-jobs', 'd-sam']; let onRx = null;
    // the channel menu in the demo: owner (You) and admin (Sam) manage every channel they can see; others only the ones they made
    const dprefs = {};
    const dchan = (ch) => { const c = chans.find((x) => x.id === ch && (x.kind === 'channel' || x.people.includes(AS))); if (!c) throw new Error('That channel isn\'t there any more.'); return c; };
    const dgen = (c) => c.kind === 'channel' && c.name === 'general';
    const dmanage = (c) => c.kind !== 'dm' && (c.created_by === AS || AS === 'u-me' || AS === 'u-sam');
    const files = { 'demo/c-jobs/sample/Job_12_sheet.pdf': 'data:text/plain;charset=utf-8,' + encodeURIComponent('A sample job sheet from the Riyeser Link demo.') };
    let listener = null;
    // a message Riyeser started (from HQ's "Message customer"): it waits for the customer's reply
    const tix = [{ id: 't0', ref: 'T-10230', topic: 'other', subject: 'Welcome to Riyeser', status: 'waiting_customer', who_acts: 'customer', mine: true, from_riyeser: true, business: 'Sample Plumbing',
      created_at: ago(300), updated_at: ago(300), read: '', messages: [{ id: 1, staff: true, mine: false, from: 'Riyeser Support', body: 'Hi! We\'re here if you need a hand setting up Riyeser Central or bringing your customers across. Just reply here.', at: ago(300) }] }];
    const refs = [];
    const lo = { office_id: 'lo-demo', pc_name: 'OFFICE-PC', version: '1.1.0', state: 'running', addresses: ['192.168.1.20'], sip_port: 5060, address_stable: true, pc_mac: '3C:52:82:1A:2B:3C',
      licence: { active: true, state: 'trial', text: 'Free trial · 74 days left' }, first_seen: ago(20000), last_seen: ago(1),
      counts: { people: 4, groups: 2, phones_assigned: 3, phones_connected: 2, new_phones: 1, calls_in_progress: 0, calls_made: 12 },
      phones: [{ mac: '0015654a1b2c', vendor: 'Yealink', model: 'T31P', extension: '101', assigned: true, registered: true, last_registered: ago(0), ip: '192.168.1.31', name: 'Front desk', location: 'Head office', provisioned_at: ago(2000) },
        { mac: '0015654a1b2d', vendor: 'Yealink', model: 'T33G', extension: '102', assigned: true, registered: true, last_registered: ago(0), ip: '192.168.1.32', name: 'Manager', location: 'Head office', provisioned_at: ago(2000) },
        { mac: '000b82c1d2e3', vendor: 'Grandstream', model: 'GRP2601P', extension: '201', assigned: true, registered: false, last_registered: ago(300), ip: '192.168.1.41', name: 'Workshop', location: 'Lautoka branch', provisioned_at: ago(2000) },
        { mac: '0015657d8e9f', vendor: 'Yealink', model: 'T31P', extension: null, assigned: false, registered: false, last_registered: null, ip: '192.168.1.44' }],
      extensions: [{ extension: '100', name: 'Head office', type: 'group', members: 2 }, { extension: '101', name: 'You', type: 'person', registered: 1, desk_phones: 1, app_users: 0, dnd: false },
        { extension: '102', name: 'Sam Taylor', type: 'person', registered: 2, desk_phones: 1, app_users: 1, dnd: false }, { extension: '200', name: 'Lautoka branch', type: 'group', members: 2 },
        { extension: '201', name: 'Jordan Lee', type: 'person', registered: 0, desk_phones: 1, app_users: 0, dnd: false }, { extension: '202', name: 'Alex Nguyen', type: 'person', registered: 0, desk_phones: 0, app_users: 0, dnd: true }] };
    const loCmds = {}; const loPw = {}; let loN = 0; let loSupport = null;
    // Demo file storage. sessionStorage 'riyeser.demo.storage': 'nearly' = 85% of the free 2 GB, 'full' = 1 MB left.
    const demoStore = (() => { let k = ''; try { k = sessionStorage.getItem('riyeser.demo.storage') || ''; } catch { /* private window */ }
      return k === 'full' ? { used: 2 * GB - 1048576, limit: 2 * GB, plus: false } : k === 'nearly' ? { used: 1.7 * GB, limit: 2 * GB, plus: false } : { used: 1.2 * GB, limit: 20 * GB, plus: true }; })();
    const reply = (ch, from, body, ms) => setTimeout(() => { const m = msg(ch, from, body, 0); m.created_at = new Date().toISOString(); msgs.push(m); listener && listener(m); }, ms);
    return {
      demo: true,
      async session() { return { user: me }; }, async stillThere() { return true; },
      onAuth() {},
      async signIn() { return { user: me }; }, async signUp() { return { user: me }; }, async resetPassword() {},
      async setPassword() {}, async checkPassword(_e, pw) { if (pw === 'wrong-password') throw new Error('Your current password isn\'t right.'); },
      async signOut() { location.href = HERE; },
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
      async updateMyDetails(_w, uid, name, phone) { const p = ppl.find((x) => x[0] === uid); if (p && name) p[1] = name;
        me.user_metadata = { ...(me.user_metadata || {}), riyeser_signup: { ...((me.user_metadata || {}).riyeser_signup || {}), you: name, phone } }; return me; },
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
      async features() { return { calls: demoStore.plus, calls_paid: false, trial_days_left: 74 }; },   // the storage knob below turns Link Plus off
      async branches() { return brs.map((b) => ({ ...b, people: b.people.slice() })); },
      async createBranch(_w, name) { const ext = Math.max(...brs.map((b) => b.extension)) + 100;
        brs.push({ id: 'b-' + Date.now(), name, code: name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'B') + '-' + Math.floor(1000 + Math.random() * 9000), extension: ext, people: [] }); },
      async newBranchCode(b) { const x = brs.find((y) => y.id === b); x.code = x.code.slice(0, 4) + Math.floor(1000 + Math.random() * 9000); return x.code; },
      async setBranchPeople(b, add, remove) { const x = brs.find((y) => y.id === b); x.people = [...new Set([...x.people, ...add])].filter((u) => !remove.includes(u)); },
      async setExtension(_w, person, ext) {
        if (ppl.some((q) => q[3] === ext && q[0] !== person) || brs.some((b) => b.extension === ext)) throw new Error(`Extension ${ext} is already used`);
        ppl.find((q) => q[0] === person)[3] = ext; },
      // ---- the Link workspace in the demo
      async savePrefs(p) { me.user_metadata = { ...(me.user_metadata || {}), riyeser_prefs: { ...((me.user_metadata || {}).riyeser_prefs || {}), ...p } }; return me; },
      async presence() { return Object.values(pres).filter((x) => ppl.some((q) => q[0] === x.user_id)).map((x) => ({ ...x, manual: x.user_id === AS ? x.manual : null })); },
      async setPresence(_w, p) { myPres = { user_id: AS, status: p.status, manual: p.manual || null, custom_text: p.text || '', on_call: !!p.on_call, away_since: p.away_since || null };
        pres[AS] = { ...myPres, fresh: true }; if (bus) bus.postMessage({ presence: myPres }); },
      async reactions(ch) { const ids = new Set(msgs.filter((m) => m.channel_id === ch).map((m) => m.id)); return rx.filter((r) => ids.has(r.message_id)).map((r) => ({ ...r })); },
      async react(_w, msgId, uid, emoji, on) {
        const i = rx.findIndex((r) => r.message_id === msgId && r.user_id === uid && r.emoji === emoji);
        if (on && i < 0) rx.push({ message_id: msgId, user_id: uid, emoji }); if (!on && i >= 0) rx.splice(i, 1); },
      async pins() { return pinned.slice(); },
      async pin(_w, ch, _u, on) { pinned = pinned.filter((x) => x !== ch); if (on) pinned.push(ch); },
      async lastMessages() { const out = {}; for (const m of [...msgs].sort((a, b) => b.created_at.localeCompare(a.created_at))) if (!out[m.channel_id]) out[m.channel_id] = { ...m }; return out; },
      async search(_w, q) { const t = q.toLowerCase(); return msgs.filter((m) => !m.deleted && m.body.toLowerCase().includes(t)).slice(-20).reverse().map((m) => ({ ...m })); },
      async upload(_w, ch, file, name) { const path = `demo/${ch}/${Date.now().toString(36)}/${name}`; files[path] = URL.createObjectURL(file); demoStore.used += file.size; return { path, name, size: file.size, type: file.type || '' }; },
      async storage() { const d = demoStore; return { used: d.used, limit: d.limit, pct: Math.round(d.used * 1000 / d.limit) / 10, plus: d.plus, extra_gb: 0 }; },
      async storageFits(_w, size) { return demoStore.used + size <= demoStore.limit; },
      async fileUrl(path) { return files[path] || 'data:text/plain,' + encodeURIComponent('This demo file is gone. Files only last while the demo is open.'); },
      liveExtra(_w, fns) { onPres = fns.presence || null; onRx = fns.reaction || null; },
      callHistory() { const t = (m) => new Date(Date.now() - m * 60000).toISOString();
        return [{ id: 'h1', dir: 'in', peer: 'u-alex', at: t(35), dur: 0, result: 'missed' }, { id: 'h2', dir: 'out', peer: 'u-sam', at: t(80), dur: 252, result: 'answered' },
          { id: 'h3', dir: 'in', peer: 'u-jordan', at: t(200), dur: 95, result: 'answered' }, { id: 'h4', dir: 'out', branch: 'b-lau', label: 'Lautoka branch', at: t(1500), dur: 0, result: 'no answer' }]; },
      async signal(_w, call, to, kind, payload) {
        const m = { call_id: call, from_user: AS, to_user: to, to, kind, payload: payload || null, created_at: new Date().toISOString() };
        if (bus && online.has(to)) bus.postMessage(m);
        else if (kind === 'ring' && onSig && online.size === 1) setTimeout(() => onSig({ ...m, from_user: to, to_user: AS, kind: 'accept', payload: { demo: true } }), 2200);
      },
      async tidyCall() {},
      onSignals(_u, fn) { onSig = fn; },
      async channels() { return chans.filter((c) => c.kind === 'channel' || c.people.includes(AS)).map((c) => ({ ...c, archived: !!c.archived })); },
      async createChannel(_w, _u, name, topic) { if (name === 'general' && chans.some((c) => c.name === 'general')) throw new Error('There\'s already a #general. Choose another name.');
        const id = 'c-' + name; chans.push({ id, kind: 'channel', name, topic, people: [], created_by: AS }); return id; },
      async createPrivate(_w, name, topic, people) { const id = 'p-' + name; chans.push({ id, kind: 'private', name, topic, people: [AS, ...people.filter((x) => x !== AS)], created_by: AS }); return id; },
      // the channel menu, with the same checks and messages as the database
      async channelPrefs() { return Object.entries(dprefs).map(([channel_id, x]) => ({ channel_id, ...x })); },
      async renameChannel(ch, name, topic) { const c = dchan(ch); if (c.kind === 'dm') throw new Error('Direct messages don\'t have a name to change.');
        if (!dmanage(c)) throw new Error('Only whoever made this channel, or the owner or an admin, can change its name or topic.');
        if (c.archived) throw new Error('This channel is archived. Bring it back first, then change it.');
        if (name != null) { const n = String(name).trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
          if (!/^[a-z0-9_-]{1,40}$/.test(n)) throw new Error('Use up to 40 lowercase letters, numbers, - or _ for the name (no spaces), e.g. hill-rd-site.');
          if (dgen(c) && n !== 'general') throw new Error('#general keeps its name, so everyone can find it.');
          if (!dgen(c) && n === 'general') throw new Error('There\'s already a #general. Choose another name.');
          c.name = n; }
        if (topic != null) { if (String(topic).trim().length > 200) throw new Error('Keep the topic under 200 characters.'); c.topic = String(topic).trim() || null; } },
      async archiveChannel(ch, on) { const c = dchan(ch); if (c.kind === 'dm') throw new Error('Direct messages can\'t be archived.');
        if (!dmanage(c)) throw new Error('Only whoever made this channel, or the owner or an admin, can archive it or bring it back.');
        if (on && dgen(c)) throw new Error('#general is where everyone in the team talks, so it can\'t be archived.'); c.archived = !!on; },
      async muteChannel(ch, on) { dchan(ch); dprefs[ch] = { muted: !!on, left_at: (dprefs[ch] || {}).left_at || null }; },
      async leaveChannel(ch) { const c = dchan(ch); if (c.kind === 'dm') throw new Error('You can\'t leave a direct message. Mute it instead.');
        if (dgen(c)) throw new Error('#general is for everyone in the team, so you can\'t leave it. Mute it instead.');
        if (c.kind === 'private') { if (!c.people.some((x) => x !== AS)) throw new Error('You\'re the only person in this channel. Add someone first, or archive it.'); c.people = c.people.filter((x) => x !== AS); }
        else dprefs[ch] = { muted: !!(dprefs[ch] || {}).muted, left_at: new Date().toISOString() }; },
      async rejoinChannel(ch) { dchan(ch); if (dprefs[ch]) dprefs[ch].left_at = null; },
      async setPeople(ch, add, remove) { const c = chans.find((x) => x.id === ch); c.people = [...new Set([...c.people, ...add])].filter((x) => !remove.includes(x)); },
      async leave(ch) { const i = chans.findIndex((x) => x.id === ch); if (i >= 0) chans.splice(i, 1); },
      async openDm(_w, person) {
        let c = chans.find((x) => x.kind === 'dm' && x.people.includes(person));
        if (!c) { c = { id: 'd-' + person, kind: 'dm', name: null, topic: null, people: ['u-me', person] }; chans.push(c); }
        return c.id;
      },
      async messages(ch) { return msgs.filter((m) => m.channel_id === ch).sort((a, b) => a.created_at.localeCompare(b.created_at)); },
      async send(_w, ch, body, fl) {
        if ((chans.find((c) => c.id === ch) || {}).archived) throw new Error('This channel is archived, so it\'s read-only. Whoever made it, or an owner or admin, can bring it back.');
        const m = msg(ch, 'u-me', body, 0); m.created_at = new Date().toISOString(); if (fl && fl.length) m.files = fl; msgs.push(m);
        const dm = chans.find((c) => c.id === ch && c.kind === 'dm');
        if (dm) reply(ch, dm.people.find((p) => p !== 'u-me'), 'Thanks, all sorted 👍', 1800);
        else if (/@jordan/i.test(body)) reply(ch, 'u-jordan', 'No worries, I\'ll take it.', 1800);
        else if (ch === 'c-general') setTimeout(() => { rx.push({ message_id: m.id, user_id: 'u-sam', emoji: '👍' }); if (onRx) onRx({ message_id: m.id }); }, 1500);
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
      // help requests in the demo: Riyeser Support "replies" a moment later
      async touch() {}, async closedBusinesses() { return []; },
      async myTickets() { return tix.map((t) => ({ ...t, unread: t.messages.filter((m) => m.staff && m.at > (t.read || '')).length, messages: undefined })); },
      async openTicket(_w, topic, subject, message) { const t = { id: 't' + (tix.length + 1), ref: 'T-' + (10234 + tix.length), topic, subject, status: 'new', mine: true, business: company.name,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(), read: new Date().toISOString(), messages: [{ id: 1, staff: false, mine: true, from: 'You', body: message, at: new Date().toISOString() }] };
        tix.unshift(t); setTimeout(() => { t.messages.push({ id: 2, staff: true, mine: false, from: 'Riyeser Support', body: 'Thanks for getting in touch. We\'re looking into it and will reply here soon.', at: new Date().toISOString() }); t.status = 'waiting_customer'; t.updated_at = new Date().toISOString(); }, 1500);
        return { id: t.id, ref: t.ref }; },
      async ticket(id) { const t = tix.find((x) => x.id === id); t.read = new Date().toISOString(); return { ...t }; },
      async replyTicket(id, body) { const t = tix.find((x) => x.id === id); t.messages.push({ id: t.messages.length + 1, staff: false, mine: true, from: 'You', body, at: new Date().toISOString() }); t.status = 'waiting_us'; t.updated_at = new Date().toISOString(); },
      async reportIssue(_w, p) { const n = tix.length; const d = p.diag_ref ? String(p.diag_ref).toUpperCase() : 'DG-' + (4821 + n);
        const t = { id: 't' + (n + 1), ref: 'T-' + (10234 + n), topic: 'program', product: p.product, subject: `${PRODUCT_NAMES[p.product] || 'Something else'}: ${String(p.what_happened).split('\n')[0]}`.slice(0, 150), status: 'new', who_acts: 'riyeser', mine: true, business: company.name,
          work_blocked: !!p.blocked, diag_ref: d, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), read: new Date().toISOString(),
          messages: [{ id: 1, staff: false, mine: true, from: 'You', body: `${p.what_happened}\n\nWork blocked: ${p.blocked ? 'Yes' : 'No'}\nDiagnostic reference: ${d}`, at: new Date().toISOString() }] };
        tix.unshift(t); return { id: t.id, ref: t.ref, diag_ref: d }; },
      async stillIssue(id, m) { const t = tix.find((x) => x.id === id); t.messages.push({ id: t.messages.length + 1, staff: false, mine: true, from: 'You', body: 'Still having an issue.' + (m ? '\n\n' + m : ''), at: new Date().toISOString() }); t.status = 'waiting_us'; t.who_acts = 'riyeser'; t.updated_at = new Date().toISOString(); },
      async confirmFixed(id) { const t = tix.find((x) => x.id === id); t.messages.push({ id: t.messages.length + 1, staff: false, mine: true, from: 'You', body: 'Confirmed fixed. Thanks!', at: new Date().toISOString() }); t.status = 'done'; t.who_acts = null; t.updated_at = new Date().toISOString(); },
      async rateTicket(id, stars, comment) { const t = tix.find((x) => x.id === id); if (t.status !== 'done') throw new Error('You can rate this once it\'s resolved.'); t.rating = stars; t.rating_comment = comment || null; },
      async myRefunds() { return refs.slice(); },
      // Riyeser Link Office in the demo: one office PC, four desk phones (one just plugged in), changes done after a moment.
      async linkStatus() { return { now: new Date().toISOString(), calls: true, offices: [JSON.parse(JSON.stringify(lo))], support: loSupport && loSupport > Date.now() ? { until: new Date(loSupport).toISOString() } : null }; },
      async linkCommand(_w, _o, kind, data) {
        const id = 'cmd' + (++loN); loCmds[id] = { id, kind, status: 'pending' };
        setTimeout(async () => {
          const c = loCmds[id]; const ph = (m) => lo.phones.find((x) => x.mac === m); const mac = String(data.mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
          const ext = lo.extensions.find((x) => x.extension === String(data.extension) && x.type === 'person');
          if (kind !== 'unassign_phone' && kind !== 'name_phone' && !ext) { c.status = 'failed'; c.error = `No one has extension ${data.extension} on Riyeser Link Office.`; return; }
          if (kind === 'assign_phone' || kind === 'add_phone') { const p = ph(mac) || (lo.phones.push({ mac, vendor: { yealink: 'Yealink', grandstream: 'Grandstream', snom: 'Snom', polycom: 'Polycom' }[data.vendor] || '', model: '', ip: null, registered: false, last_registered: null }), ph(mac));
            Object.assign(p, { assigned: true, extension: ext.extension });
            // in the demo the phone fetches its settings after a few seconds, then connects
            setTimeout(() => { p.provisioned_at = new Date().toISOString(); }, 4000); setTimeout(() => { p.registered = true; p.last_registered = new Date().toISOString(); }, 9000); }
          if (kind === 'name_phone') { const p = ph(mac); if (!p || !p.assigned) { c.status = 'failed'; c.error = 'That phone isn\'t given to anyone yet.'; return; } Object.assign(p, { name: data.name || '', location: data.branch || '', note: data.note || '' }); }
          if (kind === 'unassign_phone') { const p = ph(mac); if (!p || !p.assigned) { c.status = 'failed'; c.error = 'That phone isn\'t given to anyone.'; return; } lo.phones = lo.phones.filter((x) => x !== p); }
          if (kind === 'set_dnd') ext.dnd = !!data.on;
          if (kind === 'new_password') loPw[ext.extension] = 'Demo' + Math.random().toString(36).slice(2, 14);
          if (kind === 'reveal_password') {
            const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: data.key.n, e: data.key.e, alg: 'RSA-OAEP-256', ext: true }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
            const buf = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(loPw[ext.extension] || 'Kq7mPx2vRt9wHs4n')));
            c.sealed = btoa(String.fromCharCode(...buf));
          }
          lo.extensions.forEach((x) => { x.desk_phones = lo.phones.filter((p) => p.assigned && p.extension === x.extension).length; });
          c.status = 'done'; c.done_at = new Date().toISOString();
        }, 1200);
        return id; },
      async linkCommandState(id) { const c = loCmds[id]; return { ...c, ready: !!c.sealed, sealed: undefined }; },
      async linkRevealTake(id) { const c = loCmds[id]; const s = c.sealed || null; c.sealed = null; return s; },
      async linkMyPhone() { const mine = String((ppl.find((q) => q[0] === AS) || [])[3] || ''); const x = lo.extensions.find((e) => e.extension === mine);
        return { now: new Date().toISOString(), calls: true, extension: mine || null, owner_name: 'You', first_group: { extension: '100', name: 'Head office' }, dnd: !!(x && x.dnd),
          office: { office_id: lo.office_id, pc_name: lo.pc_name, state: lo.state, address: lo.addresses[0], sip_port: lo.sip_port, last_seen: new Date().toISOString(), online: true, licence: lo.licence },
          phones: lo.phones.filter((p) => p.assigned && p.extension === mine).map((p) => ({ ...p })) }; },
      async linkMyReveal(w, key) { return this.linkCommand(w, lo.office_id, 'reveal_password', { extension: String((ppl.find((q) => q[0] === AS) || [])[3]), key }); },
      async linkMyDnd(w, on) { return this.linkCommand(w, lo.office_id, 'set_dnd', { extension: String((ppl.find((q) => q[0] === AS) || [])[3]), on: !!on }); },
      async linkSupport(_w, allow) { loSupport = allow ? Date.now() + 3600e3 : null; return allow ? { until: new Date(loSupport).toISOString() } : null; },
      async requestRefund(_w, r) { const f = { id: 'f' + (refs.length + 1), ref: 'R-' + (1042 + refs.length), ...r, status: 'submitted', created_at: new Date().toISOString() }; refs.unshift(f); return { id: f.id, ref: f.ref }; },
      // the demo doesn't take payments (Billing hides)
      async myBilling() { return null; }, async paypalStatus() { return { ready: false }; },
    };
  }

  const api = DEMO ? demoBackend() : onlineBackend();
  const S = { user: null, teams: [], team: null, people: [], chans: [], unread: {}, ch: null, msgs: [], inChat: false, editing: null,
    features: { calls: false }, branches: [], requests: [], presence: {}, pinned: [], last: {}, rx: [], callLog: [], dial: {},
    allChans: [], archived: [], leftChans: [], cprefs: {}, cprefsOff: false };
  const JOBS = [['manager', 'Manager'], ['bookkeeper', 'Bookkeeper'], ['sales', 'Sales'], ['payroll', 'Payroll'], ['staff', 'Staff'], ['readonly', 'Read-only']];
  const isAdmin = () => !!S.team && (S.team.role === 'owner' || S.team.role === 'admin');
  // Only the owner sees what the business pays (prices, the plan and billing). Admins run the team, not the bill.
  const isOwner = () => !!S.team && S.team.role === 'owner';
  // Owners and admins need two-step sign-in before their admin powers work (the database checks this too).
  const needs2step = () => isAdmin() && S.aal !== 'aal2';
  const jobName = (j) => (JOBS.find((x) => x[0] === j) || [j, j === 'owner' ? 'Owner' : 'Staff'])[1];
  const nameOf = (uid) => (S.people.find((p) => p.user_id === uid) || {}).display_name || 'Someone who left';
  const isGeneral = (c) => !!c && c.kind === 'channel' && c.name === 'general';
  const muted = (id) => !!((S.cprefs || {})[id] || {}).muted;
  // Who may rename, change the topic and archive: whoever made the channel, or an owner or admin (the database checks too).
  const canManage = (c) => !!c && c.kind !== 'dm' && (c.created_by === S.user.id || isAdmin());
  const chanLabel = (c) => (c.kind === 'dm' ? nameOf(c.people.find((p) => p !== S.user.id) || S.user.id) : c.name);
  const demoBar = () => (DEMO ? `<div class="demo-bar">This is a demo with sample messages and calls${CONFIGURED ? ` · <a href="${HERE}">Sign in for real</a>` : ''} · <a href="/programs/link.html">About Riyeser Link</a></div>` : '');

  // ------------------------------------------------------------------ sign in / create account
  // A password box with an eye to show what was typed, and a Caps Lock warning.
  const pwField = (name, label, auto, hint) => `<label class="f"><span>${label}</span><span class="pwwrap"><input type="password" name="${name}" minlength="8" autocomplete="${auto}" required>
    <button type="button" class="pweye" aria-label="Show password" title="Show password" aria-pressed="false">👁</button></span>
    <small class="capsnote" hidden>Caps Lock is on</small>${hint ? `<small class="fhint">${hint}</small>` : ''}</label>`;
  function wirePw(root) {
    root.querySelectorAll('.pwwrap').forEach((w) => {
      const i = w.querySelector('input'); const b = w.querySelector('.pweye'); const caps = w.parentElement.querySelector('.capsnote');
      b.onclick = () => { const show = i.type === 'password'; i.type = show ? 'text' : 'password'; const l = show ? 'Hide password' : 'Show password';
        b.setAttribute('aria-label', l); b.title = l; b.setAttribute('aria-pressed', String(show)); b.classList.toggle('on', show); i.focus(); };
      const check = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
      i.addEventListener('keydown', check); i.addEventListener('keyup', check); i.addEventListener('blur', () => { caps.hidden = true; });
    });
  }
  function gate(mode = 'in', note = '', email = '') {
    const join = params.get('join');
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><form class="gcard" id="gf">${/Electron/.test(navigator.userAgent) ? '' : '<a class="gback" href="/">← Back to riyeser.com</a>'}
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      ${mode !== 'reset' ? `<div class="gtabs" role="tablist"><button type="button" role="tab" data-go="in" class="${mode === 'in' ? 'on' : ''}" aria-selected="${mode === 'in'}">Sign in</button><button type="button" role="tab" data-go="up" class="${mode === 'up' ? 'on' : ''}" aria-selected="${mode === 'up'}">Create account</button></div>` : ''}
      <h1>${mode === 'up' ? 'Create your Riyeser account' : mode === 'reset' ? 'Reset your password' : 'Sign in to Riyeser'}</h1>
      <p>${join ? 'You\'ve been invited to a team. ' : ''}${mode === 'up' ? 'Free. One account for you, your business and every Riyeser program.' : mode === 'reset' ? 'We\'ll email you a link to choose a new password.' : 'One account for you, your business and all your Riyeser programs.'}</p>
      ${note}
      ${mode === 'up' ? '<label class="f"><span>Your name</span><input name="you" required maxlength="60" autocomplete="name"></label>' : ''}
      <label class="f"><span>Email</span><input type="email" name="email" autocomplete="username email" required value="${esc(email)}"></label>
      ${mode !== 'reset' ? pwField('password', 'Password', mode === 'up' ? 'new-password' : 'current-password', mode === 'up' ? 'At least 8 characters.' : '') : ''}
      ${mode === 'up' ? pwField('password2', 'Confirm password', 'new-password', '') : ''}<div id="gerr"></div>
      ${mode === 'up' ? detailsFields(!!join) : ''}
      <button class="btn p w" type="submit">${mode === 'up' ? 'Create account' : mode === 'reset' ? 'Send the link' : 'Sign in'}</button>
      ${mode === 'up' ? `<button type="button" class="btn w gcancel" id="gcancel">Cancel</button>` : ''}
      <div class="alt">${mode === 'in' ? `<button type="button" class="linkbtn" data-go="reset">Forgot password?</button></div>
      <div class="or">New to Riyeser?</div><button type="button" class="btn w" data-go="up">Create a free account</button><div class="alt" hidden>`
        : `Already have an account? <button type="button" class="linkbtn" data-go="in">Sign in</button>`}</div></form></div>`;
    $app.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => gate(b.dataset.go)); wireCountry($app);
    wirePw($app);
    // Cancel: back to riyeser.com (in the Windows app, back to Sign in)
    const cx = $app.querySelector('#gcancel'); if (cx) cx.onclick = () => (/Electron/.test(navigator.userAgent) ? gate('in') : location.assign('/'));
    $app.querySelector('#gf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        if (mode === 'reset') { await api.resetPassword(f.get('email')); return gate('in', '<div class="ok">Check your email for the link.</div>'); }
        if (mode === 'up') {
          if (f.get('password') !== f.get('password2')) { btn.disabled = false; $app.querySelector('#gerr').innerHTML = '<div class="err">The two passwords don\'t match.</div>'; $app.querySelector('[name=password2]').focus(); return; }
          const r = await api.signUp(f.get('email'), f.get('password'), readDetails(f));
          if (!r.session) return gate('in', '<div class="ok">Nearly there: open the link we just emailed you, then sign in here.</div>');
        } else await api.signIn(f.get('email'), f.get('password'));
        await start();
      } catch (err) { btn.disabled = false; gate(mode, `<div class="err">${esc(plainError(err))}</div>`, String(f.get('email') || '')); }
    };
  }

  // ---------------- links from our account emails, and passwords (F1, F17)
  const clearAuthLink = () => { if (/access_token|error_code|error_description/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); };
  // "Confirm your email address": the link signs you in; say so before carrying on to set-up.
  function confirmedScreen() {
    clearAuthLink();
    $app.className = 'acct'; document.title = 'Email confirmed · Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><div class="gcard" id="confirmed">
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      <h1>✅ Email confirmed</h1><p>Thanks. Your Riyeser account is ready and you're signed in as <b>${esc(S.user.email || '')}</b>.</p>
      <button class="btn p w" id="cgo">Continue</button></div></div>`;
    const b = $app.querySelector('#cgo'); b.focus(); b.onclick = () => start();
  }
  // The "Reset your password" link signs you in for this one job: choose the new password (twice).
  function newPasswordScreen(note = '') {
    clearAuthLink();
    $app.className = 'acct'; document.title = 'Choose a new password · Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><form class="gcard" id="npf">
      <div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      <h1>Choose a new password</h1><p>For <b>${esc(S.user.email || '')}</b>. Your old password stops working, and you're signed out on your other devices.</p>${note}
      ${pwField('password', 'New password', 'new-password', 'At least 8 characters.')}${pwField('password2', 'Type it again', 'new-password', '')}
      <button class="btn p w" type="submit">Save my new password</button>
      <div class="alt"><button type="button" class="linkbtn" id="so">Cancel and sign out</button></div></form></div>`;
    wirePw($app); $app.querySelector('[name=password]').focus();
    $app.querySelector('#so').onclick = async () => { AUTH.recovery = false; await api.signOut(); gate(); };
    $app.querySelector('#npf').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target); const pw = String(f.get('password') || '');
      if (pw.length < 8) return newPasswordScreen('<div class="err">Choose a password of at least 8 characters.</div>');
      if (pw !== f.get('password2')) return newPasswordScreen('<div class="err">The two passwords don\'t match.</div>');
      e.target.querySelector('button[type=submit]').disabled = true;
      try { await api.setPassword(pw); AUTH.recovery = false; await start(); phMsg('✅ Your new password is saved. Use it next time you sign in.', 'ok'); }
      catch (err) { newPasswordScreen(`<div class="err">${esc(plainError(err))}</div>`); }
    };
  }
  // 🔑 Change password (signed in): the current password, the new one twice, and the code when two-step sign-in is on.
  async function changePassword() {
    const mfaOn = (await api.factors().catch(() => [])).length > 0;
    modal(`<h3>🔑 Change password</h3><p>For <b>${esc(S.user.email || '')}</b>. You'll be signed out on your other devices.</p>
      <form id="cpf">${pwField('current', 'Current password', 'current-password', '')}${pwField('password', 'New password', 'new-password', 'At least 8 characters.')}${pwField('password2', 'Type the new one again', 'new-password', '')}
      ${mfaOn ? '<label class="f"><span>Code from your authenticator app</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="dpn"></label>' : ''}
      <div id="cperr"></div><div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p" type="submit">Change password</button></div></form>`, (d, close) => {
      wirePw(d); d.querySelector('#cl').onclick = close;
      const err = (t) => { d.querySelector('#cperr').innerHTML = `<div class="err">${esc(t)}</div>`; };
      d.querySelector('#cpf').onsubmit = async (e) => {
        e.preventDefault(); const f = new FormData(e.target); const pw = String(f.get('password') || ''); const btn = e.target.querySelector('button[type=submit]');
        if (pw.length < 8) return err('Choose a new password of at least 8 characters.');
        if (pw !== f.get('password2')) return err('The two new passwords don\'t match.');
        if (pw === f.get('current')) return err('That\'s the password you have now. Choose a different one.');
        btn.disabled = true;
        try {
          await api.checkPassword(S.user.email, String(f.get('current') || ''));
          if (mfaOn) { const fa = (await api.factors())[0]; await api.verifyCode(fa.id, String(f.get('code') || '').trim()); S.aal = 'aal2'; }
          await api.setPassword(pw); close();
          modal('<h3>✅ Password changed</h3><p>Use your new password next time you sign in. Your other devices have been signed out.</p><div class="mfoot"><button class="btn p" id="cl">Done</button></div>', (dd, c2) => { dd.querySelector('#cl').onclick = c2; });
        } catch (x) { btn.disabled = false; err(plainError(x)); }
      };
    });
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
  function detailsFields(joining, d = {}) {
    const v = (k) => esc(d[k] || '');
    return `<div class="f2"><label class="f"><span>Mobile number (optional)</span><input name="phone" type="tel" maxlength="40" autocomplete="tel" placeholder="e.g. +679 …" value="${v('phone')}"></label>
        <label class="f"><span>Country</span><select name="country" autocomplete="country-name">${countryOptions(d.country || 'Fiji')}</select></label></div>
      ${joining ? '' : `<label class="f"><span>Business name (optional)</span><input name="team" maxlength="80" autocomplete="organization" value="${v('biz')}"></label>
        <label class="f"><span>ABN / TIN / Tax ID (optional)</span><input name="tax_number" maxlength="40" value="${v('tax_number')}"></label>
        <label class="f"><span>Business address (optional)</span><input name="address" maxlength="300" autocomplete="street-address" value="${v('address')}"></label>
        <p class="fhint" style="margin:-4px 0 14px">You can add or change any of these later.</p>`}`;
  }
  function readDetails(f) {
    const v = (k) => String(f.get(k) || '').trim();
    return { you: v('you'), phone: v('phone'), country: v('country'), email: v('email'), biz: v('team'), legal_name: v('legal_name'), tax_number: v('tax_number'), address: v('address'), joining: !!params.get('join') };
  }
  function wireCountry(root) {
    const cs = root.querySelector('[name=country]'); const ph = root.querySelector('[name=phone]');
    if (cs && ph) cs.onchange = () => { const dd = cs.selectedOptions[0] && cs.selectedOptions[0].dataset.dial; ph.placeholder = dd ? `e.g. ${dd} …` : 'Your mobile number'; };
  }
  function setupTeam(note = '', mode = params.get('join') ? 'join' : 'new') {
    const join = params.get('join') || '';
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    const md = (S.user && S.user.user_metadata && S.user.user_metadata.riyeser_signup) || {};
    const newForm = `<form id="cf"><h1>A few details</h1><p>Nearly done. This is how you'll appear in Riyeser.</p>
        <label class="f"><span>Your name</span><input name="you" required maxlength="60" autocomplete="name" value="${esc(md.you || '')}"></label>
        <label class="f"><span>Contact email</span><input name="email" type="email" required maxlength="120" autocomplete="email" value="${esc(md.email || (S.user && S.user.email) || '')}"></label>
        ${detailsFields(false, md)}
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
    wireCountry($app);
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
    const facs = await api.factors().catch(() => []); const on = facs.length > 0;
    // Turned on since this page signed in (on another device or tab): one code brings this page up to date.
    if (on && S.aal !== 'aal2') {
      modal(`<h3>🔐 Two-step sign-in is on</h3><p>It was turned on for your account after this page signed in. Type the 6 numbers your authenticator app shows to use it here.</p>
        <form id="vf"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="dpn" aria-label="6-number code"><div id="vferr"></div>
        <div class="mfoot"><button type="button" class="btn" id="cl">Later</button><button class="btn p">Continue</button></div></form>`, (d, close) => {
        d.querySelector('#cl').onclick = close; d.querySelector('#vf input').focus();
        d.querySelector('#vf').onsubmit = async (e) => {
          e.preventDefault();
          try { await api.verifyCode(facs[0].id, String(new FormData(e.target).get('code')).trim()); S.aal = 'aal2'; close(); await refreshCompany(); phMsg('✅ Two-step sign-in is on for this page too.', 'ok'); }
          catch (err) { d.querySelector('#vferr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; }
        };
      });
      return;
    }
    if (on) {
      modal(`<h3>🔐 Two-step sign-in is on</h3><p>Signing in needs your password and a code from your authenticator app. That stops someone who learns your password.</p>
        ${isAdmin() ? '<p><b>As an owner or admin you need it</b> to approve people, change access and see the history.</p>' : ''}
        <div class="mfoot"><button class="btn" id="off" style="margin-right:auto;color:#b91c1c">Turn it off</button><button class="btn" id="tocpw">🔑 Change password</button><button class="btn p" id="cl">Done</button></div>`, (d, close) => {
        d.querySelector('#cl').onclick = close; d.querySelector('#tocpw').onclick = () => { close(); changePassword(); };
        d.querySelector('#off').onclick = async () => {
          if (!(await ask(isAdmin() ? 'Turn off two-step sign-in? Your admin powers stop until you turn it on again.' : 'Turn off two-step sign-in?'))) return;
          try { const f = (await api.factors())[0]; await api.unenrol(f.id); S.aal = 'aal1'; close(); renderSide(); } catch (err) { tell(plainError(err)); }
        };
      });
      return;
    }
    let en;
    try { en = await api.enrol(); } catch (err) { tell(plainError(err)); return; }
    modal(`<h3>🔐 Turn on two-step sign-in</h3>
      <ol class="steps"><li>Install an authenticator app on your phone, such as <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> (free).</li>
      <li>In the app, add an account and <b>scan this code</b>:<div class="qr"><img src="${esc(en.qr)}" alt="QR code to scan"></div>
        <small class="muted">Can't scan? Type this key instead: <code>${esc(en.secret)}</code></small></li>
      <li>Type the <b>6 numbers</b> the app shows:</li></ol>
      <form id="vf"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="dpn" aria-label="6-number code">
      <div class="mfoot"><button type="button" class="btn" id="cl">Later</button><button class="btn p">Turn it on</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = async () => { try { await api.unenrol(en.id); } catch { /* not finished: nothing to undo */ } close(); };
      d.querySelector('#vf').onsubmit = async (e) => {
        e.preventDefault();
        try { await api.verifyCode(en.id, String(new FormData(e.target).get('code')).trim()); S.aal = 'aal2'; close(); await refreshCompany().catch(() => renderSide());
          modal('<h3>✅ Two-step sign-in is on</h3><p>Next time you sign in, Riyeser asks for a code from your authenticator app.</p><div class="mfoot"><button class="btn p" id="cl">Done</button></div>', (dd, c2) => { dd.querySelector('#cl').onclick = c2; }); }
        catch (err) { tell(plainError(err)); }
      };
    });
  }

  // ---------------- change history (owners and admins)
  const HIST = {
    'workspaces.update': 'changed the company details', 'members.insert': 'added someone to the company', 'members.update': 'changed someone\'s access',
    'members.delete': 'removed someone from the company', 'branches.insert': 'added a branch', 'branches.update': 'changed a branch', 'branches.delete': 'removed a branch',
    'branch_members.insert': 'put someone in a branch', 'branch_members.delete': 'took someone out of a branch', 'devices.insert': 'linked a PC',
    'devices.delete': 'unlinked a PC', 'join_request.approved': 'approved a join request', 'join_request.declined': 'declined a join request',
    'channel.rename': 'renamed a channel', 'channel.archive': 'archived a channel', 'channel.unarchive': 'brought back a channel',
    'link.assign_phone': 'gave a desk phone to someone', 'link.add_phone': 'added a desk phone', 'link.unassign_phone': 'took a desk phone off someone',
    'link.new_password': 'made a new phone password', 'link.set_dnd': 'changed Do not disturb', 'link.reveal_password': 'looked at a phone password (Set up a phone by hand)',
    'link.reveal_own': 'looked at their own phone password (My phone)', 'link.set_dnd_own': 'changed their own Do not disturb', 'link.name_phone': 'named or moved a desk phone',
    'link.support_allowed': 'let Riyeser help with the phones for an hour', 'link.support_ended': 'ended Riyeser\'s help with the phones',
    'support.reported': 'reported an issue to Riyeser', 'support.reopened': 'told Riyeser an issue is still happening', 'support.fixed': 'confirmed an issue is fixed',
  };
  function histLine(h) {
    const d = h.details || {}; const v = (k) => (d[k] && typeof d[k] === 'object' && 'now' in d[k] ? d[k].now : d[k]);
    const who = h.actor ? nameOf(h.actor) : 'Riyeser';
    let what = HIST[h.action] || h.action;
    const extra = [v('display_name'), v('device_name'), v('name'), d.user_id ? nameOf(v('user_id')) : null, d.extension ? `extension ${d.extension}` : null].filter(Boolean)[0];
    const changed = h.action.endsWith('.update') ? Object.keys(d).filter((k) => d[k] && typeof d[k] === 'object' && 'was' in d[k]).map((k) => k.replace(/_/g, ' ')).join(', ') : '';
    return `<div class="hl"><span class="hw">${esc(who)}</span> ${esc(what)}${extra ? ` · <b>${esc(extra)}</b>` : ''}${changed ? ` <small>(${esc(changed)})</small>` : ''}<time>${ago(h.at)}</time></div>`;
  }
  async function showHistory() {
    if (needs2step()) return security();
    let rows = [];
    try { rows = await api.history(S.team.id); } catch (err) { tell(plainError(err)); return; }
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
      d.querySelectorAll('[data-dec]').forEach((b) => b.onclick = async () => { if (!(await ask('Decline this request?'))) return;
        try { await api.decideJoin(b.dataset.dec, false, null, false, []); } catch (err) { tell(plainError(err)); } again(); });
      d.querySelectorAll('form[data-req]').forEach((f) => f.onsubmit = async (e) => { e.preventDefault();
        const job = f.querySelector('[name=job]').value; const admin = f.querySelector('[name=admin]').checked;
        const brs = [...f.querySelectorAll('[name=br]:checked')].map((x) => x.value);
        try { await api.decideJoin(f.dataset.req, true, job, admin, brs); } catch (err) { tell(plainError(err)); } again(); });
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
        catch (err) { tell(plainError(err)); } again(); });
      d.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
        if (!(await ask(`Remove ${nameOf(b.dataset.remove)} from ${S.team.name}? They lose access on all their devices. Their old messages stay.`))) return;
        try { await api.removePerson(S.team.id, b.dataset.remove); } catch (err) { tell(plainError(err)); } again(); });
    });
  }

  // The plan: each program's state, and people included (the owner's Company panel).
  // "4 people · 3 included in each program, then US$7 a month each" (PRICE_EXTRA_USER): users are charged per paid program.
  const peopleText = (lic) => `${lic.seats.used} ${lic.seats.used === 1 ? 'person' : 'people'} · ${lic.seats.included} included per program`;
  function planHtml(lic) {
    return `<div class="plan">${[['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Riyeser Link Plus']].map(([k, n]) => { const v = (lic.modules || {})[k] || {};
        const d = (x) => (x ? new Date(x).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
        const txt = v.status === 'active' ? `Paid${v.paid_until ? ' until ' + d(v.paid_until) : ''}` : v.status === 'trial' ? `Free trial · ${v.days_left} day${v.days_left === 1 ? '' : 's'} left` : v.status === 'cancelled' ? (v.active ? 'Cancelled · works until ' + d(v.paid_until) : 'Cancelled') : 'Trial ended';
        return `<div><span>${n}</span><span class="pl ${v.status === 'active' ? 'ok' : v.active ? (v.days_left <= 14 ? 'warn' : '') : 'bad'}">${txt}</span></div>`; }).join('')}
        ${lic.seats ? `<div><span>People</span><span class="pl">${peopleText(lic)}${lic.early_bird ? ' · 🐣 early bird' : ''}</span></div>` : ''}</div>`;
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
      <form id="cof">${field('name', 'Business name', 80)}${field('tax_number', 'ABN / TIN / Tax ID', 40)}${field('address', 'Address', 300)}${field('phone', 'Phone', 40)}${field('email', 'Email')}${field('country', 'Country', 60)}
      ${admin ? `<label class="opt sm"><input type="checkbox" name="require_approval"${t.require_approval ? ' checked' : ''}> New people need approval before they're in (recommended)</label>` : ''}
      ${lic && isOwner() ? `<h4 style="margin:16px 0 6px">Your plan</h4>${planHtml(lic)}
        <p class="muted small" style="margin:6px 0 0">Free forever: Riyeser Central, Invoices, PDF, Desk Assistant and Riyeser Link chat. To add programs or pay, use Billing on your Riyeser home page.</p>` : ''}
      ${admin && devs.length ? `<h4 style="margin:16px 0 6px">Linked PCs</h4><div class="devs">${devs.map((dv) => `<div><span><b>${esc(dv.device_name || 'A PC')}</b><small>${esc(nameOf(dv.user_id))} · ${esc(dv.platform || '')} · seen ${ago(dv.last_seen)}</small></span><button type="button" class="btn sm" data-unlink="${dv.id}">Unlink</button></div>`).join('')}</div>` : ''}
      <div class="mfoot"><button type="button" class="btn" id="cl">Close</button>${admin ? '<button class="btn p">Save</button>' : ''}</div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#cpid').onclick = async () => { try { await navigator.clipboard.writeText(t.company_code); d.querySelector('#cpid').textContent = 'Copied'; } catch { /* select it instead */ } };
      d.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => { if (!(await ask('Unlink this PC? It stops getting the company\'s information until someone links it again. Nothing is deleted.'))) return;
        try { await api.unlinkDevice(b.dataset.unlink); b.closest('div').remove(); } catch (err) { tell(plainError(err)); } });
      d.querySelector('#cof').onsubmit = async (e) => { e.preventDefault(); if (!admin) return close();
        const f = new FormData(e.target); const pr = Object.fromEntries(['name', 'tax_number', 'address', 'phone', 'email', 'country'].map((k) => [k, String(f.get(k) || '')]));
        pr.require_approval = !!f.get('require_approval');
        try { await api.updateCompany(t.id, pr); await refreshCompany(); close(); } catch (err) { tell(plainError(err)); } };
    });
  }

  // ------------------------------------------------------------------ the chat
  async function loadTeam(id) {
    S.team = S.teams.find((t) => t.id === id) || S.teams[0];
    try { localStorage.setItem('riyeser.team.last', S.team.id); } catch { /* private mode */ }
    let all;
    // S4: everything that doesn't depend on something else goes together
    [S.people, all, S.unread, , S.features, S.branches, S.requests] = await Promise.all([api.people(S.team.id), api.channels(S.team.id), api.unread(S.team.id), loadPrefs(),
      api.features(S.team.id).catch(() => ({ calls: false })), api.branches(S.team.id).catch(() => []), isAdmin() ? api.pendingRequests(S.team.id).catch(() => []) : []]);
    splitChans(all);
    Calls.listen();
    const first = S.chans.find(isGeneral) || S.chans[0];
    api.live(S.team.id, onLive);
    S.rxOff = false; S.ch = null;
    if (S.home) {   // the Riyeser home shows now; the chat loads behind it (Open waits for it)
      renderHome();
      S.wsReady = Promise.all([loadWorkspace(), openChannel(first && first.id, false, false)]);
      await S.wsReady;
    } else { S.wsReady = null; await loadWorkspace(); await openChannel(first && first.id, false); }
    if (params.has('phones') && !S.phonesShown && isAdmin()) { S.phonesShown = true; phonesPage(S.home ? 'home' : 'chat'); }
    else if ((params.has('myphone') || params.has('phones')) && !S.myShown) { S.myShown = true; S.phonesShown = true; myPhonePage(S.home ? 'home' : 'chat'); }
  }

  // The channels: S.chans are the ones in your list; S.archived are read-only, under Archived; S.leftChans are everyone
  // channels you left (Teams / Channels lets you join again). S.allChans is all of them.
  function splitChans(all) {
    const left = (c) => c.kind === 'channel' && !!(S.cprefs[c.id] || {}).left;
    S.allChans = all || [];
    S.chans = S.allChans.filter((c) => !c.archived && !left(c));
    S.archived = S.allChans.filter((c) => c.archived && !left(c));
    S.leftChans = S.allChans.filter((c) => !c.archived && left(c));
  }
  async function loadChans() { splitChans(await api.channels(S.team.id)); }
  async function loadPrefs() {
    const r = await api.channelPrefs(S.team.id, S.user.id).catch(() => null);
    S.cprefsOff = r === null;
    S.cprefs = Object.fromEntries((r || []).map((x) => [x.channel_id, { muted: !!x.muted, left: !!x.left_at }]));
  }

  async function openChannel(id, toChat = true, draw = true) {
    S.ch = S.chans.find((c) => c.id === id) || S.archived.find((c) => c.id === id) || null; S.editing = null;
    const ch = S.ch;
    const [msgs] = await Promise.all([ch ? api.messages(ch.id) : [], loadReactions()]);
    if (S.ch !== ch) return;   // another chat was opened meanwhile
    S.msgs = msgs;
    if (toChat) { S.inChat = true; S.home = false; S.nav = 'chat'; S.listTab = 'chats'; S.pane = 'main'; S.navOpen = false; }
    if (!draw) { /* drawn by whoever asked */ } else if (S.home) renderHome(); else render();
    if (S.ch) { await api.markRead(S.ch.id, S.user.id); S.unread[S.ch.id] = 0; renderSide(); }
  }

  function onLive(m) {
    if (!m || !S.team || m.workspace_id !== S.team.id) return;
    const lm = S.last && S.last[m.channel_id]; if (S.last && (!lm || lm.id === m.id || lm.created_at <= m.created_at)) S.last[m.channel_id] = m;
    if (S.ch && m.channel_id === S.ch.id) {
      const i = S.msgs.findIndex((x) => x.id === m.id);
      if (i >= 0) S.msgs[i] = m; else S.msgs.push(m);
      renderMsgs(true); renderList();
      if (!document.hidden) api.markRead(S.ch.id, S.user.id);
    } else if (m.user_id !== S.user.id && !m.deleted) {
      S.unread[m.channel_id] = (S.unread[m.channel_id] || 0) + 1;
      if (!S.allChans.find((c) => c.id === m.channel_id)) loadChans().then(renderSide); else renderSide();
    }
    chatTitle();
  }
  // The tab title in chat: "(3) Riyeser Link". The desktop apps read the unread count from it (they also still accept
  // "(3) Riyeser Team" from before the rename). A ringing call's "📞 ..." title is left alone.
  function chatTitle() {
    if (/^📞/.test(document.title)) return;
    const total = unreadTotal();
    document.title = (total ? `(${total}) ` : '') + NAME;
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
  const shortDay = (d) => new Date(d + (String(d).length === 10 ? 'T00:00:00' : '')).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  function licLine(lic, key) {
    if (key === 'free') return '<span class="pl ok">Free forever</span>';
    const v = lic && lic.modules && lic.modules[key]; if (!v) return '<span class="pl">Free for 90 days</span>';
    if (v.status === 'active') return `<span class="pl ok">Paid${v.paid_until ? ` to ${shortDay(v.paid_until)}` : ''}</span>`;
    if (v.status === 'trial') return `<span class="pl${v.days_left <= 14 ? ' warn' : ''}">Free trial${v.trial_ends ? ` to ${shortDay(v.trial_ends)}` : ''} · ${v.days_left} day${v.days_left === 1 ? '' : 's'} left</span>`;
    return '<span class="pl bad">Not active</span>';
  }
  // S4: the plan, file storage, billing and help requests load together, once per business; the home shows without
  // waiting and fills them in when they're in.
  function homeData(t) {
    if (S.homeFor === t.id && S.homeData) return S.homeData;
    S.homeFor = t.id; S.homeReady = false; S.billing = undefined;
    const admin = isAdmin(); const owner = isOwner();
    const lic = S.homeLic !== undefined && S.homeLicFor === t.id ? null
      : (admin ? api.licence(t.id).catch(() => null) : Promise.resolve(null)).then((v) => { S.homeLic = v; S.homeLicFor = t.id; });
    S.homeData = Promise.all([lic, (owner ? api.storage(t.id).catch(() => null) : Promise.resolve(null)).then((v) => { S.homeStore = v; }),
      owner ? loadBilling() : null, loadHelp()]).then(() => { if (S.homeFor === t.id) S.homeReady = true; });
    return S.homeData;
  }
  async function renderHome() {
    const t = S.team; const fresh = !(S.homeFor === t.id && S.homeReady);
    const ready = homeData(t);
    if (!fresh) await Promise.all([isOwner() && S.billing === undefined ? loadBilling() : null, loadHelp()]);
    if (S.view === 'phones' || S.view === 'myphone') return;   // the Phones or My phone page opened meanwhile (?phones, ?myphone)
    drawHome(true);
    if (fresh) { await ready; if (S.home && S.team === t && !S.view && $app.querySelector('.hmain')) drawHome(false); }
  }
  function drawHome(top) {
    tabIcon(false); document.title = 'Riyeser';
    const admin = isAdmin(); const t = S.team; const me = S.people.find((p) => p.user_id === S.user.id) || {};
    const solo = t.kind === 'personal'; const team = !solo || S.people.length > 1 || S.requests.length > 0;
    const owner = isOwner(); const ready = !!S.homeReady;
    const lic = S.homeLic && S.homeLic.modules ? S.homeLic : null;
    const unread = Object.values(S.unread || {}).reduce((a, b) => a + (b || 0), 0);
    const calls = lic && lic.modules && lic.modules.calls;
    $app.className = 'acct home'; if (top) window.scrollTo(0, 0);
    $app.innerHTML = `<header class="htop"><a class="hbrand" href="/"><img src="/assets/logo-r.png" alt="">Riyeser</a>
        ${S.teams.length > 1 ? `<select id="hsw" aria-label="Switch company">${S.teams.map((x) => `<option value="${x.id}"${x.id === t.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <span class="hme">${esc(me.display_name || S.user.email || '')}</span><button class="btn sm" id="hout">Sign out</button></header>
      <main class="hmain">
        <h1>Welcome${me.display_name ? ', ' + esc(me.display_name.split(' ')[0]) : ''}</h1>
        ${needs2step() ? '<button class="hnag" id="hmfa">🔐 Turn on <b>two-step sign-in</b> to approve people and change access. It takes 2 minutes.</button>' : ''}
        <section class="hco"><div><small>${solo ? 'Your account' : 'Your business'}</small><h2>${esc(t.name)}</h2>
          <div class="cid"><small>${solo ? 'Your Riyeser ID' : 'Business ID'}</small><span class="code">${esc(t.company_code || '')}</span><button class="btn sm" id="hcp">Copy</button></div>
          <p class="muted small">${solo ? 'Your Riyeser programs link to your account with this ID. If someone helps you later, they can use it to join you.' : 'The people who help you use this ID to join. Every Riyeser program on your PCs links with it.'}</p>
          <dl class="hkv">${[['ABN / TIN / Tax ID', t.tax_number], ['Address', t.address], ['Phone', t.phone], ['Email', t.email], ['Country', t.country]]
            .map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : `<span class="muted">${admin ? 'Not added yet' : '—'}</span>`}</dd>`).join('')}</dl></div>
          <div class="hacts"><button class="btn" id="hco">✏️ ${admin ? (solo ? 'Edit my details' : 'Edit business details') : 'Business details'}</button>${admin && team ? `<button class="btn" id="hppl">👥 People · ${S.people.length}</button>
          <button class="btn" id="hreq">👋 Requests${S.requests.length ? ` <span class="badge">${S.requests.length}</span>` : ''}</button><button class="btn" id="hhist">🕘 History</button>` : ''}
          <button class="btn" id="hsec">🔐 Security</button><button class="btn" id="hpw">🔑 Change password</button></div></section>
        ${myDetailsHtml(me, admin)}
        ${helpHtml()}
        ${owner && lic ? `<h3 class="hsec" id="hplanv">Your plan <small>${lic.seats ? `${peopleText(lic)}${lic.early_bird ? ' · 🐣 early bird' : ''} · ` : ''}${S.billing ? 'To add programs or pay, use Billing below.' : 'To change your plan, contact Riyeser.'}</small></h3>
        <div class="hplan">${[['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['calls', 'Riyeser Link Plus (calls)']]
          .filter(([k]) => lic.modules[k]).map(([k, n]) => `<div><span>${n}</span>${licLine(lic, k)}</div>`).join('')}</div>` : ''}
        ${owner && S.homeStore ? `${lic ? '' : '<h3 class="hsec" id="hplanv">Your plan</h3>'}${storageHtml(S.homeStore)}` : ''}
        ${owner ? billingHtml() : ''}
        ${!ready && (owner || admin) ? '<p class="muted small hloading" id="hloading" role="status">Loading your plan and billing…</p>' : ''}
        <h3 class="hsec">Riyeser Link</h3>
        <div class="happs"><div class="happ hteam"><img src="/assets/apps/link.png" alt=""><div><b>Riyeser Link${unread ? ` <span class="badge">${unread}</span>` : ''}</b>
          <small>Chat with the people you work with. Calls between you, your staff and other locations come with Riyeser Link Plus.</small>
          <span class="pl ok">Chat: free forever</span> ${!owner ? '' : calls ? licLine(lic, 'calls').replace('>Free trial', '>Calls: free trial').replace('>Paid', '>Calls: paid').replace('>Not active', '>Calls: not active') : '<span class="pl">Calls: free for 90 days</span>'}</div>
          <div class="hbtns"><button class="btn p sm" id="hchat">Open</button><a class="btn sm" href="${REL}RiyeserTeam-Setup.exe">⬇ Download for Windows</a></div></div>
          ${admin ? `<button class="happ hphones" id="hphones"><span class="hpic" aria-hidden="true">☎</span><div><b>Phones</b><small>Desk phones and Riyeser Link Office: the server address for phones, who has which phone, passwords and Do not disturb.</small>${calls && owner ? licLine(lic, 'calls').replace('>Free trial', '>Link Plus: free trial').replace('>Paid', '>Link Plus: paid').replace('>Not active', '>Link Plus: not active') : ''}</div><span class="go">Open →</span></button>` : ''}
          <button class="happ hphones" id="hmyphone"><span class="hpic" aria-hidden="true">☎</span><div><b>My phone</b><small>Your extension, your desk phone, and how to set it up. Do not disturb.</small></div><span class="go">Open →</span></button></div>
        <h3 class="hsec">Programs for your PC <small>Start with Riyeser Central: it installs and updates the rest.</small></h3>
        <div class="happs">${APPS.map(([id, n, d, file, key]) => `<a class="happ" href="${REL}${file}"><img src="/assets/apps/${id}.png" alt=""><div><b>${n}</b><small>${d}</small>${owner || key === 'free' ? licLine(lic, key) : ''}</div><span class="go">⬇ Download</span></a>`).join('')}</div>
        <p class="muted small hfoot">Windows 10 and 11. <a href="/help.html">Help Centre</a> · <a href="/pricing.html">Pricing</a></p>
      </main>`;
    const on = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.onclick = fn; };
    on('#hchat', async () => { if (S.wsReady) await S.wsReady.catch(() => {}); S.home = false; render(); });
    on('#hphones', () => phonesPage('home')); on('#hmyphone', () => myPhonePage('home'));
    on('#hout', async () => { await api.signOut(); S.team = null; gate(); });
    on('#hco', () => companyInfo(false));
    on('#hppl', () => (needs2step() ? security() : peopleAccess()));
    on('#hreq', () => (needs2step() ? security() : joinRequests()));
    on('#hhist', showHistory); on('#hsec', security); on('#hpw', changePassword); on('#hmfa', security);
    on('#hcp', async () => { try { await navigator.clipboard.writeText(t.company_code); $app.querySelector('#hcp').textContent = 'Copied'; } catch { /* nothing */ } });
    const sw = $app.querySelector('#hsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
    on('#hhelp', () => getHelp()); on('#hreport', () => reportIssue()); on('#hrefund', () => (needs2step() ? security() : requestRefund()));
    on('#hmine', () => editMyDetails(me)); on('#hmbiz', () => companyInfo(false));
    $app.querySelectorAll('[data-ticket]').forEach((b) => b.onclick = () => openTicket(b.dataset.ticket));
    wireBilling($app);
    if (!ready) return;   // ?help, ?add, ?paid… open once the help requests and billing are in
    if (params.has('help') && !S.helpShown) helpLink();
    else billingLinks();
  }
  // riyeser.com/link/?help opens Get help; ?help#T-10234 (the link in our emails) opens that request; ?help#report opens Report an issue.
  function helpLink() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '')).toUpperCase();
    const t = /^T-\d+$/.test(h) && (S.tickets || []).find((x) => x.ref === h);
    if (t || h === 'REPORT') { S.helpShown = true; params.delete('help'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '')); return t ? openTicket(t.id) : reportIssue(); }
    return getHelp();
  }

  // ------------------------------------------------------------------ paying: Add to my plan / Pay, and Billing (the owner only)
  // riyeser.com's Buy now and Start free buttons come here as ?signup&add=plus,payroll&users=5&period=yearly&buy=1: after
  // sign-in the owner gets "Add to my plan" for those programs. The total uses PRICE (the same list as prices.mjs and
  // riyeser_bill in team-chat.sql); the database works it out again when you pay (billing_start), early bird included.
  // Pay with PayPal (card or PayPal balance) goes through the paypal function to PayPal and back (?paid=RI-…);
  // bank transfer makes an invoice with the bank details. Only the owner can pay or see billing (the database checks).
  const PAID_MODS = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['payroll', 'Payroll'], ['pos', 'POS'], ['bookings', 'Bookings'], ['as_built', 'As Built'], ['calls', 'Riyeser Link Plus']];
  const modLabel = (m) => (PAID_MODS.find((x) => x[0] === m) || [m, m])[1];
  const money = (n) => `US$${Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const longDay = (d) => (d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  /** The same sum as riyeser_bill (no extra companies): each program + PRICE.extra_user for each person over 3; yearly x 10. */
  function billFor(mods, people, period, early = false) {
    const m = PAID_MODS.map((x) => x[0]).filter((k) => mods.includes(k) && !(k === 'basic' && mods.includes('plus')));
    const extra = Math.max(0, people - PRICE.users_included);
    const lines = m.map((k) => ({ module: k, name: modLabel(k), price: PRICE[k], extra, monthly: PRICE[k] + extra * PRICE.extra_user }));
    const monthly = lines.reduce((a, l) => a + l.monthly, 0);
    const total = Math.round(monthly * (period === 'yearly' ? 10 : 1) * (early ? 0.5 : 1) * 100) / 100;
    return { mods: m, lines, monthly, total };
  }
  const payParams = () => {
    const add = (params.get('add') || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => PAID_MODS.some((p) => p[0] === x));
    const users = Math.max(1, Math.min(500, parseInt(params.get('users') || '', 10) || 0)) || null;
    return { add, users, period: params.get('period') === 'yearly' ? 'yearly' : 'monthly', buy: params.has('buy') };
  };
  const dropParams = (...keys) => { keys.forEach((k) => params.delete(k)); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); };

  // What the home shows under Billing (null: this database hasn't had the payments part of team-chat.sql yet).
  async function loadBilling() {
    if (!isOwner()) { S.billing = null; return; }
    [S.billing, S.paypal] = await Promise.all([api.myBilling(S.team.id).catch(() => null), S.paypal ? S.paypal : api.paypalStatus().catch(() => ({ ready: false }))]);
  }
  const orderWhat = (o) => `${(o.modules || []).map(modLabel).join(', ')} · ${o.people} ${o.people === 1 ? 'person' : 'people'} · ${o.billing === 'yearly' ? 'yearly' : 'monthly'}`;
  function subLine(o) {
    const until = o.works_until || o.paid_through;
    if (o.status === 'pending') return '<span class="pl">Waiting for PayPal to confirm</span>';
    if (o.status === 'active') return `<span class="pl ok">Active</span> ${o.next_charge_at ? `Next charge <b>${money(o.next_amount)}</b> on <b>${longDay(o.next_charge_at)}</b>` : ''}`;
    if (o.status === 'payment_failed') return `<span class="pl bad">Payment didn't go through</span> Everything keeps working until <b>${longDay(until)}</b>. PayPal tries again by itself: check the card or PayPal account you pay with, or pay by bank transfer.`;
    if (o.status === 'suspended') return `<span class="pl bad">PayPal stopped this subscription</span>${until ? ` Everything works until <b>${longDay(until)}</b>.` : ''} Pay again below to carry on.`;
    if (o.status === 'cancelled') return `<span class="pl warn">Cancelled</span>${until ? ` Works until <b>${longDay(until)}</b>, then stops. Nothing is deleted.` : ''}`;
    return `<span class="pl">${esc(o.status)}</span>`;
  }
  function billingHtml() {
    const b = S.billing; if (!b) return '';
    const sub = b.subscription; const invoices = (b.orders || []).filter((o) => o.method === 'bank');
    const pays = b.payments || [];
    return `<h3 class="hsec" id="hbill">Billing <small>Only you, the owner, see this. All amounts in US dollars.</small></h3>
      <div class="hplan hbill">
        <div class="hbrow"><span><b>Pay for Riyeser</b><small>Add programs or people, monthly or yearly. PayPal (card or PayPal balance) or bank transfer.</small></span><button class="btn p sm" id="haddplan">➕ Add to my plan / Pay</button></div>
        ${sub ? `<div class="hbsub" id="hbsub"><span><b>PayPal subscription</b> <span class="muted">${esc(sub.ref)}</span><small>${esc(orderWhat(sub))} · ${money(sub.amount)} a ${sub.billing === 'yearly' ? 'year' : 'month'}${sub.early_bird ? ` (🐣 ${money(sub.first_amount)} for the first ${sub.early_cycles === 1 ? 'year' : sub.early_cycles + ' months'})` : ''}</small>
          <small class="hbst">${subLine(sub)}</small></span>
          <span class="hbbtns"><a class="btn sm" href="${esc(b.paypal_manage_url)}" target="_blank" rel="noopener">Manage in PayPal</a>${['active', 'payment_failed', 'suspended'].includes(sub.status) ? '<button class="btn sm danger" id="hbcancel">Cancel subscription</button>' : ''}</span></div>` : ''}
        ${invoices.length ? `<div class="hbtab"><b>Invoices</b><table class="tbl" id="hbinv">${invoices.map((o) => `<tr><td><b>${esc(o.ref)}</b><small>${shortDay(o.created_at)}</small></td><td>${esc(orderWhat(o))}</td><td class="num">${money(o.total)}</td>
          <td>${o.status === 'paid' ? '<span class="pl ok">Paid</span>' : o.status === 'void' ? '<span class="pl">Cancelled</span>' : `<span class="pl${o.due_date < today() ? ' bad' : ' warn'}">Due ${shortDay(o.due_date)}</span>`}</td>
          <td class="act"><button class="btn sm" data-inv="${esc(o.ref)}">View</button></td></tr>`).join('')}</table></div>` : ''}
        <div class="hbtab"><b>Payment history</b>${pays.length ? `<table class="tbl" id="hbpay">${pays.map((p) => `<tr><td>${shortDay(p.at)}<small>${p.ref ? esc(p.ref) : ''}</small></td><td>${p.method === 'paypal' ? 'PayPal' : 'Bank transfer'}<small>${esc((p.module_names || []).join(', '))}</small></td>
          <td class="num">${p.amount != null ? money(p.amount) : ''}</td><td>${p.status === 'completed' ? `<span class="pl ok">Paid</span>${p.period_to ? `<small>to ${shortDay(p.period_to)}</small>` : ''}` : `<span class="pl bad">Didn't go through</span>${p.note ? `<small>${esc(p.note)}</small>` : ''}`}</td>
          <td class="act">${p.status === 'completed' ? `<button class="btn sm" data-rcpt="${esc(p.ref)}">Receipt</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted small" style="margin:6px 0 0">No payments yet.</p>'}</div>
      </div>`;
  }
  const today = () => new Date().toISOString().slice(0, 10);
  function wireBilling(root) {
    const on = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };
    on('#haddplan', () => addToPlan({}));
    on('#hbcancel', cancelSubscription);
    root.querySelectorAll('[data-inv]').forEach((b) => b.onclick = () => { const o = (S.billing.orders || []).find((x) => x.ref === b.dataset.inv); if (o) invoiceView(o); });
    root.querySelectorAll('[data-rcpt]').forEach((b) => b.onclick = () => { const p = (S.billing.payments || []).find((x) => x.ref === b.dataset.rcpt); if (p) printDoc(receiptHtml(p), `Receipt ${p.ref}`); });
  }

  // "Add to my plan": the programs, how many people, monthly or yearly, the total, and the two ways to pay.
  async function addToPlan({ add = [], users = null, period = 'monthly', buy = true } = {}) {
    if (!isOwner()) {
      const ownerP = S.people.find((p) => p.role === 'owner');
      return modal(`<h3>Add to the plan</h3><p>Only the owner of ${esc(S.team.name)}${ownerP ? ` (${esc(ownerP.display_name)})` : ''} can pay for Riyeser. Ask them to sign in at riyeser.com/link and choose <b>Add to my plan</b>.</p>
        ${add.length ? `<p>You picked: <b>${esc(add.map(modLabel).join(', '))}</b>. ${buy ? '' : 'It\'s free for 90 days in the meantime.'}</p>` : ''}<div class="mfoot"><button class="btn p" id="cl">OK</button></div>`, (d, close) => { d.querySelector('#cl').onclick = close; });
    }
    if (S.billing === undefined) await loadBilling();
    if (!S.billing) return modal('<h3>Add to my plan</h3><p>Paying online is still being switched on. Email info@riyeser.com with the programs you want, and we\'ll send you an invoice.</p><div class="mfoot"><button class="btn p" id="cl">OK</button></div>', (d, close) => { d.querySelector('#cl').onclick = close; });
    const lic = S.billing.licence || {}; const L = lic.modules || {};
    const sub = S.billing.subscription && ['active', 'payment_failed', 'suspended'].includes(S.billing.subscription.status) ? S.billing.subscription : null;
    let chosen = add.length ? add.slice() : [];
    if (chosen.includes('plus')) chosen = chosen.filter((m) => m !== 'basic');
    const people0 = users || Math.max(PRICE.users_included, (lic.seats && lic.seats.used) || S.people.length || 1);
    const state = (m) => { const v = L[m] || {}; return v.status === 'active' ? `Paid to ${shortDay(v.paid_until)}` : v.status === 'trial' ? `Free trial · ${v.days_left} day${v.days_left === 1 ? '' : 's'} left` : v.status === 'cancelled' && v.active ? `Works to ${shortDay(v.paid_until)}` : 'Not active'; };
    modal(`<h3>${buy ? '➕ Add to my plan / Pay' : '➕ Add to my plan'}</h3>
      <p>${buy ? 'Choose what to pay for.' : 'You\'re on the 90-day free trial: nothing to pay today. When you\'re ready, choose what to pay for here.'} Prices are per business, in US dollars, with ${PRICE.users_included} people included in each program.</p>
      <form id="apf"><div class="apmods">${PAID_MODS.filter(([m]) => m !== 'as_built' || chosen.includes(m)).map(([m, n]) => `<label class="apm"><input type="checkbox" name="m" value="${m}"${chosen.includes(m) ? ' checked' : ''}><span><b>${n}</b><small>${usd(PRICE[m])} a month · ${esc(state(m))}</small></span></label>`).join('')}</div>
      <p class="muted small" id="apnote" hidden>Accounting Plus includes everything in Basics, so you pay for one or the other.</p>
      <div class="f2 apopts"><label class="f"><span>People using Riyeser</span><input name="people" type="number" min="1" max="500" value="${people0}" inputmode="numeric"></label>
        <div class="f"><span>Pay</span><label class="opt sm"><input type="radio" name="period" value="monthly"${period !== 'yearly' ? ' checked' : ''}> Monthly</label><label class="opt sm"><input type="radio" name="period" value="yearly"${period === 'yearly' ? ' checked' : ''}> Yearly (10 months for 12)</label></div></div>
      <ul class="brk" id="apbrk"></ul><div class="aptotal" id="aptotal"></div><p class="muted small" id="apeb"></p><p class="small" id="apwhen"></p><p class="muted small" id="aprepl" hidden></p>
      <p class="muted small">Your free days aren't lost: paid time starts when each program's free trial ends. You can cancel any time.</p>
      <div id="aperr"></div>
      ${sub ? `<div class="ok">You already pay by PayPal (${esc(sub.ref)}). To change that plan, cancel it under Billing first (it keeps working to the end of what's paid), then pay for the new plan here. Or pay for extra programs by bank transfer.</div>` : ''}
      <div class="appay"><button type="button" class="btn p" id="appaypal"${S.paypal && S.paypal.ready && !sub ? '' : ' hidden'}>Pay with PayPal <small>card or PayPal balance</small></button>
        <button type="button" class="btn" id="apbank">Pay by bank transfer <small>we give you an invoice</small></button></div>
      ${S.paypal && S.paypal.ready ? '' : '<p class="muted small" id="apnopp">Paying by PayPal isn\'t switched on yet, so it\'s bank transfer for now.</p>'}
      <div class="mfoot"><button type="button" class="btn" id="cl">${buy ? 'Cancel' : 'Not now'}</button></div></form>`, (d, close) => {
      d.querySelector('.mcard').classList.add('wide');
      const f = d.querySelector('#apf'); let quote = null; let qn = 0;
      const read = () => { const mods = [...f.querySelectorAll('input[name=m]:checked')].map((x) => x.value);
        return { mods, people: Math.max(1, Math.min(500, parseInt(f.people.value, 10) || 1)), period: f.querySelector('input[name=period]:checked').value }; };
      const draw = async (e) => {
        const t = e && e.target; const bx = (m) => f.querySelector(`input[value=${m}]`);
        if (t === bx('plus') && t.checked) bx('basic').checked = false; if (t === bx('basic') && t.checked) bx('plus').checked = false;
        const r = read(); const bill = billFor(r.mods, r.people, r.period);
        d.querySelector('#apnote').hidden = !r.mods.includes('plus');
        d.querySelector('#apbrk').innerHTML = bill.lines.map((l) => `<li><span>${esc(l.name)} (${usd(l.price)}${l.extra ? ` + ${l.extra} extra ${l.extra === 1 ? 'person' : 'people'} × ${usd(PRICE.extra_user)}` : `, ${PRICE.users_included} people included`})</span><b>${usd(l.monthly)}</b></li>`).join('')
          || '<li><span>Tick a program</span><b>US$0</b></li>';
        d.querySelector('#aptotal').innerHTML = bill.mods.length ? `${r.period === 'yearly' ? `<b>${money(bill.total)}</b> a year <small>(${usd(bill.monthly)} a month × 10)</small>` : `<b>${money(bill.total)}</b> a month`}` : '';
        d.querySelector('.appay').hidden = !bill.mods.length;
        // the database's quote: the same total, and the early bird if this business can have it
        // (the early bird and when-charged lines keep their text until the new quote is in, so nothing jumps under the pointer)
        const n = ++qn; quote = null;
        // S10: choosing PayPal replaces an open bank transfer invoice for the same programs
        const repl = ((S.billing && S.billing.orders) || []).filter((o) => o.method === 'bank' && o.status === 'pending' && bill.mods.length && (o.modules || []).every((m) => bill.mods.includes(m)));
        d.querySelector('#aprepl').hidden = !repl.length || !(S.paypal && S.paypal.ready && !sub);
        d.querySelector('#aprepl').textContent = repl.length ? `If you pay with PayPal, your open bank transfer invoice ${repl.map((o) => o.ref).join(', ')} for these programs is cancelled once PayPal confirms, so you never pay twice.` : '';
        if (!bill.mods.length) { d.querySelector('#apeb').textContent = ''; d.querySelector('#apwhen').textContent = ''; return; }
        try { const q = await api.billingQuote(S.team.id, bill.mods, r.people, r.period); if (n !== qn) return; quote = q;
          if (Math.abs(Number(q.amount) - bill.total) > 0.005) d.querySelector('#aptotal').innerHTML = `<b>${money(q.amount)}</b> a ${r.period === 'yearly' ? 'year' : 'month'}`;
          // S10: when the first payment is taken: never during the free trial (PayPal starts then), else today
          d.querySelector('#apwhen').innerHTML = !q.charge_from ? '' : q.charged_today === false
            ? `🗓 <b>Nothing is charged today.</b> With PayPal, your first payment is on <b>${esc(longDay(q.charge_from))}</b>, when your free trial ends.`
            : `<b>Charged today</b> when you pay with PayPal: ${money(q.due_now)}.`;
          d.querySelector('#apeb').innerHTML = q.early_bird ? `🐣 <b>Early bird:</b> ${money(q.first_amount)} a ${r.period === 'yearly' ? 'year for your first year' : `month for your first ${q.early_cycles} months`}, then ${money(q.amount)}.` : '';
        } catch { if (n === qn) { d.querySelector('#apeb').textContent = ''; d.querySelector('#apwhen').textContent = ''; } /* the total above stands; paying checks again */ }
      };
      f.querySelectorAll('input').forEach((i) => { i.addEventListener('change', draw); i.addEventListener('input', draw); });
      draw();
      d.querySelector('#cl').onclick = close;
      const fail = (err) => { d.querySelector('#aperr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; d.querySelectorAll('.appay button').forEach((b) => { b.disabled = false; }); };
      const go = (how) => async () => {
        const r = read(); const bill = billFor(r.mods, r.people, r.period);
        if (!bill.mods.length) return fail(new Error('Tick at least one program.'));
        d.querySelectorAll('.appay button').forEach((b) => { b.disabled = true; }); d.querySelector('#aperr').innerHTML = '';
        try {
          if (how === 'paypal') {
            d.querySelector('#aperr').innerHTML = '<div class="ok">Taking you to PayPal…</div>';
            const x = await api.paypalSubscribe(S.team.id, bill.mods, r.people, r.period);
            location.assign(x.approve_url); return;
          }
          const o = await api.billingStart(S.team.id, bill.mods, r.people, r.period, 'bank');
          close(); await loadBilling(); if (S.home) await renderHome(); invoiceView(o, true);
        } catch (err) { fail(err); }
      };
      d.querySelector('#appaypal').onclick = go('paypal'); d.querySelector('#apbank').onclick = go('bank');
    });
  }

  // The bank transfer invoice: number, amount, due date, the reference to quote, and the bank details.
  function invoiceView(o, fresh = false) {
    const bank = (o.seller && o.seller.bank) || {}; const has = !!String(bank.account_number || '').trim();
    const kv = [['Account name', bank.account_name], ['Bank', bank.bank_name], ['BSB', bank.bsb], ['Account number', bank.account_number], ['SWIFT / BIC', bank.swift]].filter(([, v]) => String(v || '').trim());
    modal(`<h3>🧾 Invoice ${esc(o.ref)}</h3>${fresh ? '<div class="ok">Your invoice is ready. The programs switch on as soon as Riyeser sees the money (usually 1–2 working days). Your free trial carries on until then.</div>' : ''}
      <dl class="hkv invkv"><dt>Amount</dt><dd><b>${money(o.total)}</b> (US dollars)</dd><dt>For</dt><dd>${esc(orderWhat(o))}</dd>
        <dt>Due</dt><dd>${longDay(o.due_date)}</dd><dt>Reference</dt><dd><span class="code" id="invref">${esc(o.ref)}</span> <small class="muted">put this on your transfer</small></dd>
        <dt>Status</dt><dd>${o.status === 'paid' ? '<span class="pl ok">Paid</span>' : o.status === 'void' ? '<span class="pl">Cancelled</span>' : '<span class="pl warn">Waiting for your payment</span>'}</dd></dl>
      <h4 style="margin:14px 0 6px">Pay to</h4>
      ${has ? `<dl class="hkv invkv" id="invbank">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${bank.note ? `<p class="muted small">${esc(bank.note)}</p>` : ''}
        <p class="muted small">Send US$${Number(o.total).toFixed(2)}. If your bank changes it from your own currency, any fees are yours.</p>`
        : '<p id="invnobank">Riyeser will email you the bank details for this invoice within one working day. Or email info@riyeser.com.</p>'}
      <div class="mfoot">${o.status === 'pending' ? '<button class="btn" id="invcancel" style="margin-right:auto">Cancel invoice</button>' : ''}<button class="btn" id="invprint">🖨 Print or save as PDF</button><button class="btn p" id="cl">Done</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#invprint').onclick = () => printDoc(invoiceHtml(o), `Invoice ${o.ref}`);
      const cx = d.querySelector('#invcancel'); if (cx) cx.onclick = async () => {
        if (!(await ask(`Cancel invoice ${o.ref}? Don't pay it after this. Your programs stay as they are now, and you can make a new invoice any time.`, { yes: 'Cancel invoice', no: 'Keep it', danger: true }))) return;
        try { await api.billingCancelInvoice(S.team.id, o.ref); close(); await loadBilling(); if (S.home) renderHome(); phMsg('Invoice cancelled.', 'ok'); } catch (err) { tell(plainError(err)); } };
    });
  }

  // Cancel the PayPal subscription: say exactly what happens first (in-page, never the browser's own box).
  async function cancelSubscription() {
    const sub = S.billing && S.billing.subscription; if (!sub) return;
    if (S.aal !== 'aal2') { tell('Turn on two-step sign-in (🔐 Security) to cancel. It keeps your business safe.'); return security(); }
    const until = sub.works_until || sub.paid_through;
    const yes = await ask(`If you cancel, PayPal won't charge you again. ${orderWhat(sub).split(' · ')[0]} keep${sub.modules.length === 1 ? 's' : ''} working until ${until ? longDay(until) : 'the end of what you\'ve paid'}, then stop${sub.modules.length === 1 ? 's' : ''}. Nothing is deleted: you can still open and print everything, and you can pay again any time.`,
      { title: 'Cancel your PayPal subscription?', yes: 'Cancel subscription', no: 'Keep it', danger: true });
    if (!yes) return;
    try { const r = await api.paypalCancel(S.team.id); await loadBilling(); if (S.home) await renderHome();
      phMsg(`Cancelled. Everything keeps working until ${longDay(r.works_until || until)}.`, 'ok'); }
    catch (err) { tell(plainError(err)); }
  }

  // Back from PayPal (?paid=RI-…): "Thanks, we're confirming your payment", until PayPal tells Riyeser it went through.
  async function paidReturn(ref) {
    let tries = 0;
    modal(`<h3>🙏 Thanks, we're confirming your payment</h3><p id="pdmsg">PayPal is letting Riyeser know. This usually takes less than a minute. You can close this: it carries on by itself.</p>
      <div class="mfoot"><button class="btn p" id="cl">Close</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      const tick = async () => {
        if (!document.body.contains(d)) return;
        await loadBilling();
        const o = S.billing && (S.billing.orders || []).find((x) => x.ref === ref);
        const done = o && ['active', 'paid'].includes(o.status) && o.paid_through;
        if (done) { d.querySelector('h3').textContent = '✅ Payment confirmed';
          d.querySelector('#pdmsg').innerHTML = `${esc(orderWhat(o))}: paid until <b>${longDay(o.paid_through)}</b>. Your receipt is under Billing. Riyeser Central picks it up by itself.`;
          if (S.home) renderHome(); return; }
        if (o && o.status === 'payment_failed') { d.querySelector('#pdmsg').innerHTML = `PayPal couldn't take the payment. ${subLine(o)}`; return; }
        if (++tries < 40) setTimeout(tick, 3000);
        else d.querySelector('#pdmsg').textContent = 'PayPal hasn\'t confirmed it yet. It can take a few minutes: check Billing on this page later. If you were charged and it still says waiting tomorrow, use Get help.';
      };
      setTimeout(tick, 1500);
    });
  }
  // On the home page, after sign-in: ?add (from riyeser.com's buttons), ?paid / ?paycancel (back from PayPal).
  function billingLinks() {
    if (S.billingLinked) return; S.billingLinked = true;
    if (params.has('paid')) { const ref = params.get('paid'); dropParams('paid', 'subscription_id', 'ba_token', 'token'); return paidReturn(ref); }
    if (params.has('paycancel')) { dropParams('paycancel', 'subscription_id', 'ba_token', 'token'); return tell('You didn\'t finish at PayPal, so nothing was charged. You can pay again under Billing.', 'warn'); }
    // From a billing email: ?receipt=RR-… or ?invoice=RI-… opens that receipt or invoice
    for (const k of ['receipt', 'invoice']) {
      if (!params.has(k)) continue; const ref = String(params.get(k) || '').toUpperCase(); dropParams(k); const b = S.billing || {};
      const x = k === 'receipt' ? (b.payments || []).find((y) => y.ref === ref) : (b.orders || []).find((y) => y.ref === ref);
      if (!x) return tell(`We couldn't find ${k} ${ref} for this business. Billing on this page lists them all.`, 'warn');
      return k === 'receipt' ? printDoc(receiptHtml(x), `Receipt ${ref}`) : invoiceView(x);
    }
    if (params.has('add')) { const p = payParams(); dropParams('add', 'buy', 'users', 'period', 'signup'); if (p.add.length || p.buy) return addToPlan(p); }
    return null;
  }

  // ---- printable invoice and receipt (the browser's Print, or Save as PDF)
  function sellerBlock(s) {
    s = s || {}; const lines = [s.address, s.tax_number ? `${s.tax_label || 'ABN'} ${s.tax_number}` : '', s.email].filter((x) => String(x || '').trim());
    return `<div class="pd-from"><b>${esc(s.name || 'Riyeser')}</b>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  }
  const buyerBlock = () => { const t = S.team; return `<div class="pd-to"><small>Bill to</small><b>${esc(t.legal_name || t.name)}</b>${[t.address, t.tax_number ? `Tax number ${t.tax_number}` : '', t.email, t.company_code ? `Riyeser ID ${t.company_code}` : ''].filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}</div>`; };
  function linesFor(o) {
    const bill = billFor(o.modules || [], o.people || 3, o.billing);
    const k = o.billing === 'yearly' ? 10 : 1;
    if (Math.abs(bill.total - Number(o.amount)) > 0.005) return [[`Riyeser: ${orderWhat(o)}`, Number(o.amount)]];
    const rows = bill.lines.map((l) => [`${l.name}${l.extra ? `, with ${l.extra} extra ${l.extra === 1 ? 'person' : 'people'} × ${usd(PRICE.extra_user)}` : `, ${PRICE.users_included} people included`}${k === 10 ? ' (a year: 10 months)' : ' (a month)'}`, l.monthly * k]);
    if (o.first_amount != null && Number(o.first_amount) < Number(o.amount)) rows.push(['🐣 Early bird: half price for the first 12 months', Number(o.first_amount) - Number(o.amount)]);
    return rows;
  }
  const docTable = (rows, total, label) => `<table class="pd-lines"><tr><th>Description</th><th class="num">US$</th></tr>${rows.map(([t, v]) => `<tr><td>${esc(t)}</td><td class="num">${Number(v).toFixed(2)}</td></tr>`).join('')}
    <tr class="pd-total"><td>${label}</td><td class="num">${money(total)}</td></tr></table>`;
  // The copy Riyeser kept when it was issued (billdoc.js draws it; HQ shows the same); older ones are drawn from the order.
  const keptDoc = (x) => (x && x.doc && window.RiyeserBillDoc ? x.doc : null);
  function invoiceHtml(o) {
    if (keptDoc(o)) return window.RiyeserBillDoc.html(o.doc, { paid: o.status === 'paid', paidAt: o.paid_at });
    const bank = (o.seller && o.seller.bank) || {}; const has = !!String(bank.account_number || '').trim();
    return `<div class="pd-head">${sellerBlock(o.seller)}<div class="pd-title"><h1>Invoice</h1><div>No. <b>${esc(o.ref)}</b></div><div>Date ${longDay(o.created_at)}</div><div>Due ${longDay(o.due_date)}</div></div></div>
      ${buyerBlock()}${docTable(linesFor(o), o.total, 'Total to pay (US dollars)')}
      <div class="pd-pay"><b>How to pay: bank transfer</b>${has ? [['Account name', bank.account_name], ['Bank', bank.bank_name], ['BSB', bank.bsb], ['Account number', bank.account_number], ['SWIFT / BIC', bank.swift]].filter(([, v]) => String(v || '').trim()).map(([k2, v]) => `<div>${k2}: <b>${esc(v)}</b></div>`).join('') + (bank.note ? `<div>${esc(bank.note)}</div>` : '') : '<div>Riyeser will email you the bank details.</div>'}
        <div>Reference: <b>${esc(o.ref)}</b> (please quote it so we can match your payment)</div></div>
      ${o.status === 'paid' ? `<p class="pd-stamp">PAID${o.paid_at ? ` ${longDay(o.paid_at)}` : ''}</p>` : ''}<p class="pd-foot">Thank you for using Riyeser.</p>`;
  }
  function receiptHtml(p) {
    if (keptDoc(p)) return window.RiyeserBillDoc.html(p.doc);
    const o = { modules: p.modules, people: p.people, billing: p.billing, amount: p.amount };
    return `<div class="pd-head">${sellerBlock(p.seller)}<div class="pd-title"><h1>Receipt</h1><div>No. <b>${esc(p.ref)}</b></div><div>Paid ${longDay(p.at)}</div><div>For invoice ${esc(p.order_ref)}</div></div></div>
      ${buyerBlock()}${docTable([[`Riyeser: ${orderWhat(o)}${p.period_to ? `, paid until ${longDay(p.period_to)}` : ''}`, p.amount]], p.amount, 'Paid (US dollars)')}
      <div class="pd-pay"><b>Paid by ${p.method === 'paypal' ? 'PayPal' : 'bank transfer'}</b>${p.provider_ref ? `<div>Reference ${esc(p.provider_ref)}</div>` : ''}</div>
      <p class="pd-stamp">PAID</p><p class="pd-foot">Thank you for using Riyeser.</p>`;
  }
  function printDoc(html, title) {
    modal(`<div class="printdoc" id="printdoc">${html}</div><div class="mfoot noprint"><button class="btn" id="cl">Close</button><button class="btn p" id="pp">🖨 Print or save as PDF</button></div>`, (d, close) => {
      d.classList.add('printing'); d.querySelector('.mcard').classList.add('wide', 'paper');
      d.querySelector('#cl').onclick = close;
      d.querySelector('#pp').onclick = () => { const t = document.title; document.title = title; window.print(); document.title = t; };
    });
  }

  // ------------------------------------------------------------------ your details (so Riyeser has the right name and phone for you)
  function myDetailsHtml(me, admin) {
    const su = (S.user && S.user.user_metadata && S.user.user_metadata.riyeser_signup) || {};
    return `<h3 class="hsec">Your details <small>So we can reach the right person. Only you can change these.</small></h3>
      <div class="hplan hmine" id="hmyd"><div><span>Your name</span><b>${esc(me.display_name || su.you || '—')}</b></div><div><span>Phone</span><b>${esc(su.phone || '—')}</b></div>
        <div><span>Email</span><b>${esc((S.user && S.user.email) || '')}</b></div>
        <div class="hmbtns"><button class="btn sm" id="hmine">✏️ Change my details</button>${admin ? '<button class="btn sm" id="hmbiz">Business details</button>' : ''}</div></div>`;
  }
  function editMyDetails(me) {
    const su = (S.user && S.user.user_metadata && S.user.user_metadata.riyeser_signup) || {};
    modal(`<h3>✏️ Your details</h3><p>Your name shows to the people you work with. Your phone is for Riyeser Support, if we need to call you back.</p>
      <form id="mdf"><label class="f"><span>Your name</span><input name="name" required maxlength="60" value="${esc(me.display_name || su.you || '')}" autocomplete="name"></label>
      <label class="f"><span>Your phone</span><input name="phone" type="tel" maxlength="40" value="${esc(su.phone || '')}" autocomplete="tel"></label>
      <div id="mderr"></div><div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Save</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#mdf').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const name = String(f.get('name')).trim(); const phone = String(f.get('phone') || '').trim();
        try { const u = await api.updateMyDetails(S.team.id, S.user.id, name, phone); if (u && u.user_metadata) S.user.user_metadata = u.user_metadata;
          const p = S.people.find((x) => x.user_id === S.user.id); if (p && name) p.display_name = name; close(); if (S.home) renderHome(); else render(); }
        catch (err) { d.querySelector('#mderr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; } };
    });
  }

  // ------------------------------------------------------------------ help requests (support tickets) and refunds
  // Plain words for each status. Customers never see levels, staff names or internal notes.
  const TOPICS = [['program', 'A problem with a program'], ['signin', 'Signing in'], ['billing', 'Billing or my plan'], ['other', 'Something else']];
  const TSTATUS = { new: ['Received', ''], investigating: ['We\'re looking into it', ''], waiting_us: ['With Riyeser', ''], waiting_customer: ['Waiting for your reply', 'warn'], done: ['Resolved', 'ok'] };
  // What each status means, in plain words, on the request itself.
  const TSAYS = { new: 'We\'ve got it and will reply soon.', investigating: 'We\'re looking into it.', waiting_us: 'It\'s with Riyeser. We\'ll reply here.',
    waiting_customer: 'We\'re waiting for your reply. Is it fixed?', done: 'Resolved. If it happens again, press Still having an issue.' };
  const PRODUCTS = [['central', 'Riyeser Central'], ['accounting', 'Accounting'], ['invoices', 'Invoices'], ['pos', 'POS'], ['bookings', 'Bookings'], ['payroll', 'Payroll'],
    ['link', 'Riyeser Link'], ['linkoffice', 'Riyeser Link Office'], ['pdf', 'Riyeser PDF'], ['desk', 'Desk Assistant'], ['website', 'riyeser.com'], ['other', 'Something else']];
  const PRODUCT_NAMES = Object.fromEntries(PRODUCTS);
  // "3:00 pm Fri" this week, else "3:00 pm Fri 5 Dec"
  const byWhen = (t) => { const d = new Date(t); const tm = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])\.?m\.?/i, ' $1m').toLowerCase();
    const soon = Math.abs(d - Date.now()) < 6 * 864e5; return `${tm} ${d.toLocaleDateString('en-AU', { weekday: 'short' })}${soon ? '' : ' ' + d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`; };
  const RSTATUS = { submitted: ['Received', ''], reviewing: ['Being looked at', ''], approved: ['Approved', 'ok'], partly_approved: ['Partly approved', 'ok'],
    declined: ['Not approved', 'bad'], paid: ['Paid', 'ok'] };
  const REFUND_FOR = ['Accounting Basics', 'Accounting Plus', 'Payroll', 'POS', 'Bookings', 'As Built', 'Riyeser Link Plus', 'My whole plan', 'Something else'];
  const REFUND_WHY = [['mistake', 'I was charged by mistake'], ['didnt_work', 'It didn\'t work for me'], ['cancelled', 'I cancelled'], ['duplicate', 'I was charged twice'], ['other', 'Something else']];
  const pill = (map, st) => { const [l, c] = map[st] || [st, '']; return `<span class="pl${c ? ' ' + c : ''}">${esc(l)}</span>`; };
  const money2 = (n, c) => `${esc(c || 'USD')} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // null = this part of Riyeser isn't switched on yet (the database hasn't been updated): hide it.
  async function loadHelp() {
    // refunds show amounts, so only the owner sees and asks for them (the database checks this too)
    [S.tickets, S.refunds] = await Promise.all([api.myTickets().catch(() => null),
      S.team && isOwner() && !needs2step() ? api.myRefunds(S.team.id).catch(() => null) : (S.team && isOwner() ? [] : null)]);
  }
  function helpHtml() {
    const unread = (S.tickets || []).reduce((a, t) => a + Number(t.unread || 0), 0);
    return `<h3 class="hsec">Help${unread ? ` <span class="badge">${unread}</span>` : ''} <small>Stuck, or something not right? Ask us. We usually reply within one business day.</small></h3>
      <div class="hhelp"><button class="btn p" id="hhelp">💬 Get help</button>${S.tickets !== null && S.team ? '<button class="btn" id="hreport">🛠 Report an issue</button>' : ''}${S.refunds !== null && S.tickets !== null && isOwner() ? '<button class="btn" id="hrefund">↩️ Request a refund</button>' : ''}<a class="btn" href="/help.html">📖 Help Centre</a></div>
      ${S.tickets && S.tickets.length ? `<h3 class="hsec">Your help requests</h3><div class="hplan htix">${S.tickets.map((t) => `<button class="htk" data-ticket="${esc(t.id)}">
        <span>${t.from_riyeser ? '<span class="pl riy">Message from Riyeser</span> ' : ''}<b>${esc(t.subject)}</b><small>${esc(t.ref)}${t.product ? ` · ${esc(PRODUCT_NAMES[t.product] || t.product)}` : ''} · ${t.from_riyeser ? (t.mine ? 'Riyeser wrote to you' : 'Riyeser wrote to someone in your business') : t.mine ? 'you asked' : 'asked by someone in your business'} · ${ago(t.updated_at)}</small>${t.next_update_due && t.status !== 'done' ? `<small class="hnu">We'll update you by ${esc(byWhen(t.next_update_due))}</small>` : ''}</span>
        <span class="htr">${Number(t.unread) ? `<span class="badge" title="New reply from Riyeser">${t.unread} new</span>` : ''}${pill(TSTATUS, t.status)}</span></button>`).join('')}</div>` : ''}
      ${S.refunds && S.refunds.length ? `<h3 class="hsec">Your refund requests</h3><div class="hplan hrf">${S.refunds.map((r) => `<div><span><b>${money2(r.amount, r.currency)} · ${esc(r.for_what)}</b>
        <small>${esc(r.ref)}${r.period ? ` · ${esc(r.period)}` : ''} · ${ago(r.created_at)}${r.amount_approved != null && r.status !== 'declined' && r.status !== 'submitted' && r.status !== 'reviewing' ? ` · ${money2(r.amount_approved, r.currency)} approved` : ''}${r.decision_reason ? `<br>${esc(r.decision_reason)}` : ''}</small></span>${pill(RSTATUS, r.status)}</div>`).join('')}</div>` : ''}`;
  }
  function helpOff() {
    modal(`<h3>💬 Get help</h3><p>Asking for help from here is on its way. For now, the Help Centre has answers to common questions.</p>
      <div class="mfoot"><button class="btn" id="cl">Close</button><a class="btn p" href="/help.html">Open the Help Centre</a></div>`, (d, close) => { d.querySelector('#cl').onclick = close; });
  }
  // The "Get help" form. ws: the business it's about (none for people without one).
  // pre: { topic, subject, message } to fill in the form (e.g. "Report a phone issue").
  function getHelp(ws = S.team ? S.team.id : null, pre = null) {
    S.helpShown = true;
    if (params.has('help')) { params.delete('help'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '')); }
    if (S.tickets === null) return helpOff();
    modal(`<h3>💬 Get help</h3><p>Tell us what's going on and we'll get back to you by email and here on your Riyeser home page.</p>
      <form id="ghf"><label class="f"><span>What's it about?</span><select name="topic">${TOPICS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>Subject</span><input name="subject" maxlength="150" required placeholder="e.g. The receipt printer stopped working"></label>
      <label class="f"><span>Message</span><textarea name="message" rows="5" maxlength="5000" required placeholder="What happened, and what were you trying to do?"></textarea></label>
      <div id="gherr"></div><div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Send</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      if (pre) { const g = d.querySelector('#ghf'); if (pre.topic) g.topic.value = pre.topic; if (pre.subject) g.subject.value = pre.subject; if (pre.message) { g.message.value = pre.message; g.message.focus(); g.message.setSelectionRange(g.message.value.length, g.message.value.length); } }
      d.querySelector('#ghf').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const btn = e.target.querySelector('.btn.p'); btn.disabled = true;
        try { const r = await api.openTicket(ws, String(f.get('topic')), String(f.get('subject')).trim(), String(f.get('message')).trim());
          d.querySelector('.mcard').innerHTML = `<h3>✅ Thanks, we've got it</h3><p>Your request number is <b class="code">${esc(r.ref)}</b>. We'll reply by email and here on your Riyeser home page.</p>
            <div class="mfoot"><button class="btn p" id="ok">Done</button></div>`;
          d.querySelector('#ok').onclick = () => { close(); if (S.team && S.home) renderHome(); };
        } catch (err) { btn.disabled = false; d.querySelector('#gherr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; } };
    });
  }
  // One help request: the conversation, what's happening in plain words, and Reply / Still having an issue / Confirm fixed.
  // After Confirm fixed: an optional rating ("How did we do?"). Older databases (no who_acts yet) just get Reply.
  async function openTicket(id, after = '') {
    let t; try { t = await api.ticket(id); } catch (err) { modal(`<h3>Help request</h3><div class="err">${esc(plainError(err))}</div><div class="mfoot"><button class="btn" id="cl">Close</button></div>`, (d, close) => { d.querySelector('#cl').onclick = close; }); return; }
    const fresh = 'who_acts' in t; const done = t.status === 'done';
    const stars = (n) => `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
    const rate = fresh && done && !t.rating;
    modal(`<h3>${esc(t.subject)}</h3><p class="small">${t.from_riyeser ? '<span class="pl riy">Message from Riyeser</span> ' : ''}${esc(t.ref)}${t.product ? ` · ${esc(PRODUCT_NAMES[t.product] || t.product)}` : ''} · ${pill(TSTATUS, t.status)}${t.diag_ref ? ` · Diagnostic reference <b>${esc(t.diag_ref)}</b>` : ''}</p>
      ${fresh ? `<p class="tsays${done ? ' ok' : ''}" id="tsays">${esc(TSAYS[t.status] || '')}${t.next_update_due && !done ? ` <b>We'll update you by ${esc(byWhen(t.next_update_due))}.</b>` : ''}</p>` : ''}
      ${after ? `<div class="okmsg">${esc(after)}</div>` : ''}
      <div class="tconv">${(t.messages || []).map((m) => `<div class="tmsg${m.staff ? ' staff' : ' me'}"><small>${esc(m.staff ? 'Riyeser Support' : m.from || 'You')} · ${ago(m.at)}</small><div>${esc(m.body).replace(/\n/g, '<br>')}</div></div>`).join('')}</div>
      ${rate ? `<form id="rtf" class="rate"><b>How did we do?</b> <small class="muted">(optional)</small><div class="starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="stars" value="${n}"><span title="${n} out of 5">★</span></label>`).join('')}</div>
          <label class="f"><span>Anything to add? <small class="muted">(optional)</small></span><textarea name="comment" rows="2" maxlength="1000"></textarea></label>
          <div id="rterr"></div><div class="mfoot"><button type="button" class="btn" id="rtskip">No thanks</button><button class="btn p">Send rating</button></div></form>`
        : fresh && t.rating ? `<p class="small">You rated this ${stars(t.rating)}. Thank you!</p>` : ''}
      ${done && !fresh ? '<p class="small">This request is marked done. If you still need help, reply and we\'ll pick it up again.</p>' : ''}
      <form id="trf"><label class="f"><span>${done && fresh ? 'Still not right? Tell us what\'s happening' : 'Your reply'}</span><textarea name="message" rows="3" maxlength="5000"></textarea></label>
      <div id="trerr"></div><div class="mfoot tacts"><button type="button" class="btn" id="cl">Close</button>
        ${fresh ? `<button type="button" class="btn" id="tstill">Still having an issue</button>${done ? '' : '<button type="button" class="btn ok" id="tfixed">✓ Confirm fixed</button>'}` : ''}
        ${done && fresh ? '' : '<button class="btn p" id="treply">Reply</button>'}</div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = () => { close(); if (S.home) renderHome(); };
      const conv = d.querySelector('.tconv'); conv.scrollTop = conv.scrollHeight;
      const msg = () => String(d.querySelector('#trf [name=message]').value).trim();
      const err = (e) => { d.querySelector('#trerr').innerHTML = `<div class="err">${esc(plainError(e))}</div>`; };
      const busy = (on) => d.querySelectorAll('#trf button').forEach((b) => { b.disabled = on; });
      d.querySelector('#trf').onsubmit = async (e) => { e.preventDefault(); if (!msg()) { err(new Error('Write your reply first.')); return; } busy(true);
        try { await api.replyTicket(id, msg()); close(); openTicket(id, 'Reply sent. We\'ll get back to you here.'); } catch (x) { busy(false); err(x); } };
      const still = d.querySelector('#tstill'); if (still) still.onclick = async () => { busy(true);
        try { await api.stillIssue(id, msg()); close(); openTicket(id, 'Thanks. It\'s back with Riyeser Support and we\'ll reply here.'); } catch (x) { busy(false); err(x); } };
      const fixed = d.querySelector('#tfixed'); if (fixed) fixed.onclick = async () => { busy(true);
        try { await api.confirmFixed(id); close(); openTicket(id, 'Great, it\'s marked resolved.'); } catch (x) { busy(false); err(x); } };
      const rf = d.querySelector('#rtf');
      if (rf) {
        d.querySelector('#rtskip').onclick = () => { rf.remove(); };
        rf.onsubmit = async (e) => { e.preventDefault(); const f = new FormData(rf); const n = Number(f.get('stars'));
          if (!n) { rf.querySelector('#rterr').innerHTML = '<div class="err">Choose 1 to 5 stars, or press No thanks.</div>'; return; }
          try { await api.rateTicket(id, n, String(f.get('comment') || '').trim()); rf.outerHTML = `<p class="small" id="rated">Thanks for the feedback: ${stars(n)}</p>`; }
          catch (x) { rf.querySelector('#rterr').innerHTML = `<div class="err">${esc(plainError(x))}</div>`; } };
      }
    });
  }
  // Report an issue (the website version of Riyeser Central's): the product, what happened and whether work is blocked.
  // No logs from the website (it can't read your PC). Optionally the DG- reference Riyeser Central showed.
  function reportIssue() {
    S.helpShown = true;
    if (S.tickets === null || !S.team) return getHelp();
    modal(`<h3>🛠 Report an issue</h3><p>Tell us which program and what happened. If Riyeser Central gave you a diagnostic reference (it looks like DG-4821), add it so we can see the technical details.</p>
      <form id="rif"><label class="f"><span>Which program?</span><select name="product" required><option value="">Choose…</option>${PRODUCTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>What happened?</span><textarea name="what" rows="4" maxlength="4000" required placeholder="e.g. The payroll export stops at about 90% with &quot;Export timed out&quot;"></textarea></label>
      <fieldset class="f yn"><legend>Is your work blocked?</legend><label><input type="radio" name="blocked" value="yes" required> Yes</label><label><input type="radio" name="blocked" value="no"> No</label></fieldset>
      <div class="rfrow"><label class="f"><span>Version <small class="muted">(optional)</small></span><input name="version" maxlength="40" placeholder="e.g. 2.8.1"></label>
      <label class="f"><span>Error message or code <small class="muted">(optional)</small></span><input name="error" maxlength="300"></label></div>
      <label class="f"><span>Diagnostic reference from Riyeser Central <small class="muted">(optional)</small></span><input name="diag" maxlength="20" placeholder="DG-4821" autocomplete="off"></label>
      <p class="small muted">Please don't include passwords, bank details or customers' details. Your records stay in your business.</p>
      <div id="rierr"></div><div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Send report</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#rif').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const v = (k) => String(f.get(k) || '').trim(); const btn = e.target.querySelector('.btn.p');
        const diag = v('diag').toUpperCase(); if (diag && !/^DG-\d+$/.test(diag)) { d.querySelector('#rierr').innerHTML = '<div class="err">That reference doesn\'t look right. It looks like DG-4821.</div>'; return; }
        btn.disabled = true;
        try { const r = await api.reportIssue(S.team.id, { source: 'web', product: v('product'), what_happened: v('what'), blocked: v('blocked') === 'yes', product_version: v('version') || null,
            error_text: v('error') || null, diag_ref: diag || null, reported_at: new Date().toISOString() });
          d.querySelector('.mcard').innerHTML = `<h3>✅ Thanks — your request number is ${esc(r.ref)}.</h3><p>Reference <b class="code">${esc(r.diag_ref || '')}</b>. We'll reply by email and here on your Riyeser home page.</p>
            <div class="mfoot"><button class="btn" id="ok">Done</button><button class="btn p" id="see">Open it</button></div>`;
          S.tickets = await api.myTickets().catch(() => S.tickets);
          d.querySelector('#ok').onclick = () => { close(); if (S.team && S.home) renderHome(); };
          d.querySelector('#see').onclick = () => { close(); openTicket(r.id); };
        } catch (err) { btn.disabled = false; d.querySelector('#rierr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; } };
    });
  }
  // The owner only: ask for a refund. It also opens a billing help request, where the conversation happens.
  function requestRefund() {
    modal(`<h3>↩️ Request a refund</h3><p>Tell us what it's for and why. We'll look at it within 2 business days and let you know by email.</p>
      <form id="rff"><label class="f"><span>What's it for?</span><select name="for_what">${REFUND_FOR.map((x) => `<option>${x}</option>`).join('')}</select></label>
      <div class="rfrow"><label class="f"><span>Which period? <small class="opt">(e.g. November 2026)</small></span><input name="period" maxlength="80"></label>
      <label class="f"><span>Invoice or receipt number <small class="opt">(optional)</small></span><input name="invoice_ref" maxlength="80"></label></div>
      <div class="rfrow"><label class="f"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal"></label>
      <label class="f"><span>Currency</span><select name="currency">${['USD', 'FJD', 'AUD', 'NZD'].map((c) => `<option${c === 'USD' ? ' selected' : ''}>${c}</option>`).join('')}</select></label></div>
      <label class="f"><span>Why?</span><select name="reason_category">${REFUND_WHY.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>Tell us a bit more</span><textarea name="explanation" rows="3" maxlength="2000" placeholder="What happened?"></textarea></label>
      <div id="rferr"></div><div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Send request</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#rff').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const v = (k) => String(f.get(k) || '').trim();
        try { const r = await api.requestRefund(S.team.id, { for_what: v('for_what'), period: v('period'), invoice_ref: v('invoice_ref'), amount: Number(v('amount')),
            currency: v('currency'), reason_category: v('reason_category'), explanation: v('explanation') });
          d.querySelector('.mcard').innerHTML = `<h3>✅ Thanks, we've got your request</h3><p>Your refund request number is <b class="code">${esc(r.ref)}</b>. We'll look at it within 2 business days and let you know by email.</p>
            <div class="mfoot"><button class="btn p" id="ok">Done</button></div>`;
          d.querySelector('#ok').onclick = () => { close(); renderHome(); };
        } catch (err) { d.querySelector('#rferr').innerHTML = `<div class="err">${esc(plainError(err))}</div>`; } };
    });
  }
  // A business that Riyeser has closed (or suspended): a plain message at sign-in.
  function closedScreen(b) {
    $app.className = 'acct'; document.title = 'Riyeser'; tabIcon(false);
    $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div>
      <h1>${esc(b.name)}</h1><p>This business is closed. Contact Riyeser support.</p>
      <button class="btn p w" id="gh">💬 Contact Riyeser support</button>
      <div class="alt"><button class="linkbtn" id="so">Sign out</button></div></div></div>`;
    $app.querySelector('#gh').onclick = async () => { if (S.tickets === undefined) S.tickets = await api.myTickets().catch(() => null); getHelp(b.id); };
    $app.querySelector('#so').onclick = async () => { await api.signOut(); gate(); };
  }

  // The browser tab shows Riyeser's logo on the account screens, and Riyeser Link's icon once inside chat.
  function tabIcon(team) {
    Theme.scope(team ? 'link' : 'acct');
    const l = document.getElementById('favicon'); if (!l) return;
    l.type = team ? 'image/svg+xml' : 'image/png'; l.href = team ? 'icon.svg' : '/assets/logo-r.png';
  }
  // ================================================================== the Riyeser Link workspace (phase 1)
  // Header (search, status, notifications, help, you) · left nav (Workspace, and Admin / Settings for owners and admins)
  // · the list (Chats / Calls / Voicemail) · the conversation or a view · the right panel (People / Info, Quick dial).
  // On a phone, one panel at a time with back buttons.
  const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || ''}</svg>`;
  const IC = {
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>', chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>', users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3 3 0 0 1 0 6M18 14c2 .8 3 2.8 3 6"/>',
    hash: '<path d="M9 3 7 21M17 3l-2 18M4 8h17M3 16h17"/>', desk: '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M6 9c0-3 2.5-5 6-5s6 2 6 5"/><path d="M7 13h4M7 16h4M15 13h2M15 16h2"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>', clip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>', send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>', plus: '<path d="M12 5v14M5 12h14"/>', down: '<path d="m6 9 6 6 6-6"/>', back: '<path d="m15 5-7 7 7 7"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micoff: '<path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.8-1"/><path d="M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.5 2.5M12 18v3"/>',
    pause: '<path d="M8 5v14M16 5v14"/>', speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    hang: '<path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3.5-1.5v-2.5a10 10 0 0 0-6 0V16L5.5 17.5z"/>', xfer: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>', conf: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20c0-3 2.5-5 6-5s6 2 6 5M14 15.3c.6-.2 1.3-.3 2-.3 3.5 0 6 2 6 5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', chart: '<path d="M5 20V10M12 20V4M19 20v-7"/>', file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', cam: '<path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>', grid: '<path d="M5 5h2v2H5zM11 5h2v2h-2zM17 5h2v2h-2zM5 11h2v2H5zM11 11h2v2h-2zM17 11h2v2h-2zM5 17h2v2H5zM11 17h2v2h-2zM17 17h2v2h-2z"/>',
    vm: '<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>', card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>', building: '<path d="M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2"/>',
    branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M18 11c0 4-6 3-12 5"/>', out: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7"/>', palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 2-1 3-1a4 4 0 0 0 4-4c0-4.5-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
    navshut: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M16 10l-2 2 2 2"/>', navopen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M14 10l2 2-2 2"/>',
    panelr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    note: '<path d="M5 4h14v16H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>', archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
    mute: '<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8"/><path d="M10 20a2 2 0 0 0 4 0M3 3l18 18"/>', leave: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
    in: '<path d="M18 6 6 18M6 9v9h9"/>', outc: '<path d="M6 18 18 6M9 6h9v9"/>', missed: '<path d="M18 6 6 18M6 9v9h9"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const STATUS = { available: 'Available', busy: 'Busy', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' };
  const REACTIONS = ['👍', '✅', '❤️', '😂', '🎉', '👀'];
  const EMOJI = ['😀', '😊', '😂', '😉', '😍', '🙏', '👍', '👏', '🙌', '💪', '✅', '❌', '🎉', '🔥', '⭐', '❤️', '👀', '🤔', '😅', '😢', '☕', '🚚', '🔧', '📞'];
  const MAX_FILE = 25 * 1024 * 1024;
  // File storage for each business: the bar for owners and admins ("1.2 GB of 2 GB used"), a warning at 80%.
  const gbText = (n) => { const g = n / GB; return `${g >= 10 || Number.isInteger(g) ? Math.round(g) : g.toFixed(1)} GB`; };
  const usedText = (n) => (n < 0.1 * GB ? sizeText(n) : gbText(n));
  // The storage is only space for files shared in Link chats (not website, email or cloud hosting). Chat files can't be
  // deleted yet, so the full / nearly full messages point to Link Plus or Riyeser support, never "free up space".
  const STORE_WHAT = 'space for files shared in Link chats (not website, email or cloud hosting)';
  const STORE_MORE = (plus) => (plus ? 'Contact Riyeser support for more space.' : `Upgrade to Riyeser Link Plus for ${STORAGE_GB.plus} GB, or contact Riyeser support.`);
  const STORE_FULL = (plus) => `Your business has used its ${plus ? STORAGE_GB.plus : STORAGE_GB.free} GB of ${STORE_WHAT}. ${STORE_MORE(plus)}`;
  const NEAR_FULL = 'Your business is close to its file storage limit. Ask the owner about Riyeser Link Plus.';
  function storageHtml(st) {
    if (!st || st.limit == null) return '';
    const pct = Math.max(0, Math.min(100, Number(st.pct) || 0)); const warn = pct >= 80;
    return `<div class="stor${warn ? ' warn' : ''}" id="stor"><div class="stor-h"><b>File storage</b><span>${usedText(Number(st.used) || 0)} of ${gbText(Number(st.limit))} used</span></div>
      <div class="sbar" role="progressbar" aria-label="File storage used" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      ${warn ? `<p class="stor-w">⚠️ ${pct >= 100 ? 'Full.' : `${Math.round(pct)}% used.`} ${STORE_MORE(!!st.plus)}</p>` : ''}
      <small class="muted">This is ${STORE_WHAT}: ${STORAGE_GB.free} GB per business free; ${STORAGE_GB.plus} GB with Riyeser Link Plus. Nothing is ever deleted for you.</small></div>`;
  }
  const personOf = (uid) => S.people.find((p) => p.user_id === uid) || null;
  const extOf = (uid) => (personOf(uid) || {}).extension || null;
  const plus = () => !!(S.features && S.features.calls);
  const otherIn = (c) => (c && c.kind === 'dm' ? c.people.find((p) => p !== S.user.id) || S.user.id : null);
  const dmWith = (uid) => S.chans.find((c) => c.kind === 'dm' && c.people.includes(uid) && (uid !== S.user.id || c.people.every((p) => p === uid)));
  const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const whenShort = (t) => { const d = new Date(t); const y = new Date(Date.now() - 864e5);
    return d.toDateString() === new Date().toDateString() ? timeOf(d) : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  const durText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

  // ---- in-page yes/no boxes and messages (never the browser's own pop-ups: they can stop typing in the Windows app)
  function ask(text, { yes = 'OK', no = 'Cancel', danger = false, title = '' } = {}) {
    return new Promise((resolve) => {
      modal(`${title ? `<h3>${esc(title)}</h3>` : ''}<p class="askp">${esc(text)}</p><div class="mfoot"><button class="btn" id="askno">${esc(no)}</button><button class="btn p${danger ? ' danger' : ''}" id="askyes">${esc(yes)}</button></div>`, (d, close) => {
        const done = (v) => { close(); resolve(v); };
        d.querySelector('#askno').onclick = () => done(false); d.querySelector('#askyes').onclick = () => done(true);
        d.onclick = (e) => { if (e.target === d) done(false); }; d.querySelector('#askyes').focus();
      });
    });
  }
  const tell = (text, cls = 'bad') => phMsg(esc(text), cls);

  // ---- presence: Available, Busy, Away (after 10 minutes idle), Do not disturb, Offline, and "On a call"
  const Presence = (() => {
    const AWAY_AFTER = 10 * 60000; const BEAT = 60000; const STALE = 3 * 60000;
    let lastActive = Date.now(); let awaySince = null; let lastSent = ''; let lastBeat = 0; let timer = null; let off = false; let fakeNow = null;
    const now = () => fakeNow || Date.now();
    const onCall = () => { const c = Calls.current; return !!(c && ['live', 'connecting', 'calling'].includes(c.status)); };
    function mine() {
      const m = S.myManual; let st;
      if (m === 'dnd' || m === 'offline') st = m; else if (onCall()) st = 'busy'; else if (m) st = m; else st = now() - lastActive > AWAY_AFTER ? 'away' : 'available';
      if (st === 'away' && !awaySince) awaySince = new Date(m === 'away' ? now() : lastActive).toISOString();   // "Away (12m)": since they last used Riyeser Link
      if (st !== 'away') awaySince = null;
      return { user_id: S.user.id, status: st, manual: m || null, custom_text: S.myText || '', on_call: onCall() && st !== 'offline', away_since: awaySince, fresh: true, at: Date.now() };
    }
    function info(uid) {
      if (S.user && uid === S.user.id) return mine();
      const p = S.presence[uid];
      if (!p || !p.fresh || Date.now() - (p.at || 0) > STALE || p.status === 'offline') return { status: 'offline', custom_text: '', on_call: false };
      return p;
    }
    function text(uid) {
      const p = info(uid);
      if (p.status === 'offline') return 'Offline';
      if (p.on_call) return 'On a call';
      if (p.status === 'away') { const m = p.away_since ? Math.max(1, Math.round((now() - Date.parse(p.away_since)) / 60000)) : 0; return p.custom_text || `Away${m ? ` (${m < 60 ? m + 'm' : Math.round(m / 60) + 'h'})` : ''}`; }
      return p.custom_text || STATUS[p.status] || 'Available';
    }
    const dot = (uid) => { const p = info(uid); return `<i class="pd st-${p.on_call && p.status !== 'offline' ? 'call' : p.status}" title="${esc(text(uid))}"></i>`; };
    async function send(force) {
      if (!S.team || off) return;
      const p = mine(); const key = [p.status, p.manual, p.custom_text, p.on_call].join('|');
      if (!force && key === lastSent && Date.now() - lastBeat < BEAT) return;
      lastSent = key; lastBeat = Date.now();
      try { await api.setPresence(S.team.id, { status: p.status, manual: p.manual, text: p.custom_text, on_call: p.on_call, away_since: p.away_since }); }
      catch (e) { if (/PGRST202|Could not find|schema cache|does not exist/i.test(String(e && e.message))) off = true; }
    }
    function changed() { send(); paintMine(); }
    function tick(at) { if (at) fakeNow = at; const before = lastSent; send(); if (lastSent !== before) { paintMine(); paintOthers(); } }
    function active() { const was = now() - lastActive > AWAY_AFTER; lastActive = Date.now(); fakeNow = null; if (was) changed(); }
    function start() {
      if (timer) return;
      ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((e) => addEventListener(e, active, { passive: true }));
      let mv = 0; addEventListener('pointermove', () => { if (Date.now() - mv > 5000) { mv = Date.now(); active(); } }, { passive: true });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) active(); });
      addEventListener('pagehide', () => { if (S.team && !off) api.setPresence(S.team.id, { status: 'offline', manual: S.myManual || null, text: S.myText || '', on_call: false }).catch(() => {}); });
      timer = setInterval(() => tick(), 15000);
    }
    async function load() {
      S.presence = {}; off = false;
      const rows = await api.presence(S.team.id).catch(() => null);
      if (rows === null) { off = true; return; }
      for (const r of rows) {
        if (r.user_id === S.user.id) { if (S.myManual === undefined) { S.myManual = r.manual || null; S.myText = r.custom_text || ''; } continue; }
        S.presence[r.user_id] = { ...r, at: Date.now() };
      }
    }
    function onRow(r) { if (!r || !r.user_id || r.user_id === S.user.id) return; S.presence[r.user_id] = { ...r, fresh: r.status !== 'offline', at: Date.now() }; paintOthers(); }
    // a status change from the picker (DND also switches Do not disturb on the desk phone, where there is one)
    async function choose(manual, txt) {
      const wasDnd = S.myManual === 'dnd'; S.myManual = manual === 'available' ? null : manual; if (txt !== undefined) S.myText = txt;
      lastActive = Date.now(); changed();
      if ((S.myManual === 'dnd') !== wasDnd && api.linkMyDnd) api.linkMyDnd(S.team.id, S.myManual === 'dnd').catch(() => {});
    }
    return { start, load, onRow, info, text, dot, choose, changed, tick, status: () => mine().status, get off() { return off; } };
  })();
  function paintMine() {
    const p = Presence.info(S.user.id); const b = document.getElementById('stbtn');
    if (b) { b.innerHTML = `${Presence.dot(S.user.id)}<span class="stt">${esc(Presence.text(S.user.id))}</span>${ic('down')}`; b.dataset.st = p.status; }
    document.querySelectorAll(`.pd-me`).forEach((x) => { x.outerHTML = Presence.dot(S.user.id).replace('class="pd', 'class="pd pd-me'); });
  }
  function paintOthers() {
    if (!document.getElementById('lkshell')) return;
    renderList(); renderRight(); if (S.nav === 'contacts' || S.nav === 'home') renderMain();
  }

  // ---- your look: Dark (navy/purple, the default), Light, or Match my computer, and an accent colour.
  // Kept with your account (riyeser_prefs), and in this browser so it shows straight away. Sign-in and Riyeser home stay Riyeser blue.
  const ACCENTS = [['purple', 'Purple (Riyeser Link)', '#7c3aed'], ['blue', 'Blue', '#2563eb'], ['teal', 'Teal', '#0f766e'], ['green', 'Green', '#15803d'], ['orange', 'Orange', '#c2410c'], ['pink', 'Pink', '#be185d']];
  const THEMES = [['dark', 'Dark', 'Navy and purple. Easy on the eyes.'], ['light', 'Light', 'Bright and clear, like Riyeser Link has always been.'], ['system', 'Match my computer', 'Dark or light, the same as Windows or your phone.']];
  const Theme = (() => {
    const KEY = 'riyeser.link.look'; let pref = { theme: 'dark', accent: 'purple' }; let scope = 'acct';
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) pref = { ...pref, ...v }; } catch { /* private mode */ }
    const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
    const resolved = () => (pref.theme === 'system' ? (mq && mq.matches ? 'dark' : 'light') : pref.theme === 'light' ? 'light' : 'dark');
    function apply() {
      const h = document.documentElement; const link = scope === 'link';
      h.dataset.theme = link ? resolved() : 'light'; h.dataset.scope = link ? 'link' : 'acct';
      if (link) h.dataset.accent = ACCENTS.some((a) => a[0] === pref.accent) ? pref.accent : 'purple'; else delete h.dataset.accent;
      const m = document.querySelector('meta[name=color-scheme]'); if (m) m.content = h.dataset.theme;
    }
    if (mq) (mq.addEventListener ? mq.addEventListener('change', apply) : mq.addListener(apply));
    function keep() { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch { /* private mode */ } }
    function set(p, save = true) {
      pref = { ...pref, ...p }; keep(); apply();
      if (save && S.user) api.savePrefs({ theme: pref.theme, accent: pref.accent }).then((u) => { if (u && u.user_metadata) S.user.user_metadata = u.user_metadata; }).catch(() => {});
    }
    function fromAccount(user) { const p = ((user && user.user_metadata) || {}).riyeser_prefs; if (p && typeof p === 'object') { pref = { ...pref, ...(p.theme ? { theme: p.theme } : {}), ...(p.accent ? { accent: p.accent } : {}) }; keep(); apply(); } }
    return { set, fromAccount, get: () => ({ ...pref }), resolved, scope(s) { scope = s; apply(); } };
  })();
  function appearance() {
    const p = Theme.get();
    const prev = (t) => `<span class="tprev tp-${t}" aria-hidden="true"><i class="tp-n"></i><i class="tp-l"><b></b><b></b><b></b></i><i class="tp-m"><b></b><b></b><b class="tp-a"></b></i></span>`;
    modal(`<h3>${ic('palette')} Appearance</h3><p>Choose how Riyeser Link looks for you. It follows you to every PC and phone you sign in on.</p>
      <div class="tpick" role="radiogroup" aria-label="Theme">${THEMES.map(([k, n, d]) => `<label class="tcard"><input type="radio" name="theme" value="${k}"${p.theme === k ? ' checked' : ''}>
        ${k === 'system' ? `<span class="tprev tp-split" aria-hidden="true">${prev('dark')}${prev('light')}</span>` : prev(k)}<b>${n}</b><small>${d}</small></label>`).join('')}</div>
      <h4 class="ahh">Accent colour</h4><div class="apick" role="radiogroup" aria-label="Accent colour">${ACCENTS.map(([k, n, c]) => `<label class="acc" title="${esc(n)}"><input type="radio" name="accent" value="${k}"${p.accent === k ? ' checked' : ''}><i style="background:${c}"></i><span>${esc(n)}</span></label>`).join('')}</div>
      <p class="muted small">Sign-in and your Riyeser home page keep Riyeser's own blue.</p>
      <div class="mfoot"><button class="btn p" id="cl">Done</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('input[name=theme]').forEach((r) => r.onchange = () => Theme.set({ theme: r.value }));
      d.querySelectorAll('input[name=accent]').forEach((r) => r.onchange = () => Theme.set({ accent: r.value }));
    });
  }

  // ---- call history (this device; Riyeser Link Office voicemail and a shared history come later)
  const callKey = () => `riyeser.link.calls.${S.user.id}.${S.team.id}`;
  function loadCalls() {
    let mine = []; try { mine = JSON.parse(localStorage.getItem(callKey()) || '[]'); } catch { /* private mode */ }
    const demo = api.callHistory ? api.callHistory() : [];
    S.callLog = [...mine, ...demo.filter((d) => !mine.some((x) => x.id === d.id))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
    try { S.callSeen = Number(localStorage.getItem(callKey() + '.seen') || 0); } catch { S.callSeen = 0; }
  }
  function logCall(e) {
    S.callLog = [e, ...(S.callLog || []).filter((x) => x.id !== e.id)].slice(0, 100);
    try { const mine = JSON.parse(localStorage.getItem(callKey()) || '[]').filter((x) => x.id !== e.id); localStorage.setItem(callKey(), JSON.stringify([e, ...mine].slice(0, 100))); } catch { /* private mode */ }
    if (document.getElementById('lkshell')) { renderList(); renderTop(); if (S.nav === 'calls' || S.nav === 'home') renderMain(); }
  }
  const missedNew = () => (S.callLog || []).filter((c) => c.result === 'missed' && Date.parse(c.at) > (S.callSeen || 0)).length;
  function seeCalls() { S.callSeen = Date.now(); try { localStorage.setItem(callKey() + '.seen', String(S.callSeen)); } catch { /* private mode */ } }
  const callWho = (c) => (c.peer ? nameOf(c.peer) : c.label || 'A branch');
  const callExt = (c) => (c.peer ? extOf(c.peer) : (S.branches.find((b) => b.id === c.branch) || {}).extension);
  const callLine = (c) => ({ missed: 'Missed', declined: 'Declined', answered: c.dir === 'in' ? 'Incoming' : 'Outgoing', 'no answer': 'No answer', cancelled: 'Cancelled', elsewhere: 'Answered elsewhere' }[c.result] || c.result);

  // ---- what you folded away: the left menu, the right panel and each list section. Kept in this browser, for each person.
  const UI = (() => {
    let v = { shut: {} }; let key = '';
    function load(uid) {
      key = 'riyeser.link.ui.' + uid; v = { shut: {} };
      try { const x = JSON.parse(localStorage.getItem(key) || 'null'); if (x && typeof x === 'object') v = { ...x, shut: { ...(x.shut && typeof x.shut === 'object' ? x.shut : {}) } }; } catch { /* private mode */ }
    }
    const save = () => { if (key) try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };
    return { load, get: (k) => v[k], set: (k, x) => { v[k] = x; save(); },
      // Archived starts folded; everything else starts open
      shut: (k) => (k in v.shut ? !!v.shut[k] : k === 'archived'), setShut: (k, on) => { v.shut[k] = !!on; save(); } };
  })();
  const wideRight = () => matchMedia('(min-width: 1181px)').matches;   // wide enough for the right panel beside the chat
  function toggleNav() {
    S.navMini = !S.navMini; UI.set('navMini', S.navMini); paneClasses(); renderNav();
    const t = document.getElementById('navtog'); if (t) t.focus();
  }
  function toggleRight() {
    if (!wideRight()) { if (S.pane === 'right') go(S.ch ? 'main' : 'list'); else showRight(S.rightTab || 'people'); return; }
    S.rightShut = !S.rightShut; UI.set('rightShut', S.rightShut); if (S.rightShut && S.pane === 'right') S.pane = 'main';
    paneClasses(); renderHead();
  }
  function toggleSec(k) {
    UI.setShut(k, !UI.shut(k)); renderList();
    const b = document.querySelector(`[data-sect="${k}"]`); if (b) b.focus();
  }
  // A list section's heading: click (or Enter / Space) to fold it away or open it again
  function secHead(k, label, extra = '', count = 0) {
    const shut = UI.shut(k);
    return `<div class="sec${shut ? ' shut' : ''}" data-sec="${k}"><button class="sech" data-sect="${k}" aria-expanded="${!shut}" aria-controls="sb-${k}" title="${shut ? 'Show' : 'Hide'} ${esc(label)}">${ic('down')}${esc(label)}${count ? `<span class="badge${k === 'archived' ? ' dim' : ''}">${count}</span>` : ''}</button>${extra}</div>`;
  }
  const secBody = (k, html) => `<div class="secb" id="sb-${k}"${UI.shut(k) ? ' hidden' : ''}>${html}</div>`;
  let keysOn = false;
  function wireKeys() {
    if (keysOn) return; keysOn = true;
    // Ctrl + [ folds the left menu; Ctrl + ] the right panel (not inside a dialog)
    addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !document.getElementById('lkshell') || document.querySelector('.modal')) return;
      if (e.code === 'BracketLeft' || e.key === '[') { e.preventDefault(); if (!narrow()) toggleNav(); else { S.navOpen = !S.navOpen; paneClasses(); } }
      else if (e.code === 'BracketRight' || e.key === ']') { e.preventDefault(); toggleRight(); }
    });
  }

  // ---- loading what the workspace shows
  async function loadWorkspace() {
    UI.load(S.user.id); S.navMini = !!UI.get('navMini'); S.rightShut = !!UI.get('rightShut'); wireKeys();
    S.nav = S.nav || 'chat'; S.listTab = S.listTab || 'chats'; S.rightTab = S.rightTab || 'people'; S.pane = S.pane || 'list';
    S.myManual = undefined; S.myText = '';
    const [pins, last] = await Promise.all([api.pins(S.team.id, S.user.id).catch(() => null), api.lastMessages(S.team.id).catch(() => ({})), Presence.load()]);
    if (S.myManual === undefined) S.myManual = null;
    S.pinsOff = pins === null; S.last = last || {};
    const meta = ((S.user.user_metadata || {}).riyeser_prefs || {});
    S.pinned = pins === null ? (Array.isArray(meta.pinned) ? meta.pinned : []) : pins;
    loadCalls();
    api.liveExtra && api.liveExtra(S.team.id, { presence: Presence.off ? null : Presence.onRow, reaction: S.rxOff ? null : onReaction });
    Presence.start(); Presence.changed();
  }
  async function togglePin(ch) {
    const on = !S.pinned.includes(ch);
    S.pinned = on ? [...S.pinned, ch] : S.pinned.filter((x) => x !== ch);
    renderList(); renderHead(); if (S.rightTab === 'info') renderRight();
    try {
      if (S.pinsOff) await api.savePrefs({ pinned: S.pinned }); else await api.pin(S.team.id, ch, S.user.id, on);
    } catch (err) { S.pinned = on ? S.pinned.filter((x) => x !== ch) : [...S.pinned, ch]; renderList(); tell(plainError(err)); }
  }

  // ---- reactions
  async function loadReactions() {
    if (!S.ch) { S.rx = []; return; }
    const r = await api.reactions(S.ch.id).catch(() => []);
    if (r === null) { S.rxOff = true; S.rx = []; return; }
    S.rx = r;
  }
  let rxTimer = null;
  function onReaction(r) {
    if (!r || !S.ch || !S.msgs.some((m) => m.id === r.message_id)) return;
    clearTimeout(rxTimer); rxTimer = setTimeout(async () => { await loadReactions(); renderMsgs(); }, 250);
  }
  async function react(msgId, emoji) {
    const mineNow = (S.rx || []).some((r) => r.message_id === msgId && r.user_id === S.user.id && r.emoji === emoji);
    if (mineNow) S.rx = S.rx.filter((r) => !(r.message_id === msgId && r.user_id === S.user.id && r.emoji === emoji));
    else S.rx = [...(S.rx || []), { message_id: msgId, user_id: S.user.id, emoji }];
    renderMsgs();
    try { await api.react(S.team.id, msgId, S.user.id, emoji, !mineNow); } catch (err) { tell(plainError(err)); await loadReactions(); renderMsgs(); }
  }
  function rxHtml(m) {
    if (S.rxOff || m.deleted) return '';
    const mine = (S.rx || []).filter((r) => r.message_id === m.id);
    if (!mine.length) return '';
    return `<div class="rx">${REACTIONS.filter((e) => mine.some((r) => r.emoji === e)).map((e) => { const who = mine.filter((r) => r.emoji === e);
      const me = who.some((r) => r.user_id === S.user.id);
      return `<button class="rxc${me ? ' me' : ''}" data-rx="${e}" aria-pressed="${me}"${S.ch && S.ch.archived ? ' disabled' : ''} title="${esc(who.map((r) => (r.user_id === S.user.id ? 'You' : nameOf(r.user_id))).join(', '))}">${e} <span>${who.length}</span></button>`; }).join('')}</div>`;
  }

  // ---- messages
  const autoBody = (files) => '📎 ' + files.map((f) => f.name).join(', ');
  function filesHtml(m) {
    if (!m.files || !m.files.length || m.deleted) return '';
    return `<div class="fcards">${m.files.map((f, i) => `<div class="fcard"><span class="fic">${ic('file')}<small>${esc(((f.name.split('.').pop() || '').slice(0, 4)).toUpperCase())}</small></span>
      <span class="fnm"><b>${esc(f.name)}</b><small>${esc(sizeText(Number(f.size) || 0))}</small></span><button class="lk-ib" data-file="${i}" aria-label="Download ${esc(f.name)}" title="Download">${ic('dl')}</button></div>`).join('')}</div>`;
  }
  function msgsHtml() {
    if (!S.ch) return `<div class="empty"><b>No channels yet</b>Add one with + next to Channels.</div>`;
    if (!S.msgs.length) return `<div class="empty"><b>${S.ch.kind === 'dm' ? 'Say hello 👋' : `Welcome to #${esc(S.ch.name)}`}</b>${esc(S.ch.topic || 'Nothing here yet. Write the first message below.')}</div>`;
    let out = ''; let lastDay = ''; let prev = null;
    for (const m of S.msgs) {
      const d = new Date(m.created_at); const day = d.toDateString();
      if (day !== lastDay) { out += `<div class="day"><span>${esc(dayName(d))}</span></div>`; lastDay = day; prev = null; }
      const cont = prev && prev.user_id === m.user_id && d - new Date(prev.created_at) < 5 * 60000;
      const mine = m.user_id === S.user.id && !m.deleted;
      const showText = !(m.files && m.files.length && m.body === autoBody(m.files)) || m.deleted;
      const body = S.editing === m.id
        ? `<form class="cbox" data-edit="${m.id}"><textarea rows="2">${esc(m.body)}</textarea><button>Save</button></form>`
        : `${showText ? `<div class="mb${m.deleted ? ' gone' : ''}${mine ? ' mine' : ''}">${m.deleted ? 'Message deleted' : fmt(m.body)}${m.edited_at && !m.deleted ? ' <span class="edited">(edited)</span>' : ''}</div>` : ''}${filesHtml(m)}`;
      const acts = m.deleted || S.ch.archived ? '' : `<span class="macts">${S.rxOff ? '' : `<button data-act="react" aria-label="Add a reaction" title="React">${ic('smile')}</button>`}${mine ? '<button data-act="edit">Edit</button><button data-act="del">Delete</button>' : ''}</span>`;
      out += `<div class="msg${cont ? ' cont' : ''}" data-id="${m.id}">${av(m.user_id, nameOf(m.user_id))}<div class="mc">
        ${cont ? '' : `<div class="mt"><b>${esc(nameOf(m.user_id))}</b><time datetime="${m.created_at}">${esc(timeOf(d))}</time></div>`}
        ${body}${rxHtml(m)}</div>${acts}</div>`;
      prev = m;
    }
    return out;
  }

  // ---- the shell
  function render(force) {
    S.view = null; tabIcon(true);
    if (S.nav === undefined || !S.listTab) { S.nav = S.nav || 'chat'; S.listTab = S.listTab || 'chats'; S.rightTab = S.rightTab || 'people'; S.pane = S.pane || (S.inChat ? 'main' : 'list'); }
    if (!force && document.getElementById('lkshell')) { paneClasses(); renderTop(); renderNav(); renderList(); renderMain(); renderRight(); return; }
    $app.className = 'lk';
    $app.innerHTML = `${demoBar()}<div class="shell" id="lkshell"><header class="lk-top" id="lktop"></header><nav class="lk-nav" id="lknav" aria-label="Workspace"></nav>
      <section class="lk-list" id="side" aria-label="Chats"></section><section class="main" id="main"></section><aside class="lk-right" id="lkright" aria-label="People and info"></aside>
      <div class="lk-scrim" id="scrim"></div></div>`;
    paneClasses();
    document.getElementById('scrim').onclick = () => { S.navOpen = false; if (S.pane === 'right' && !narrow()) S.pane = 'main'; paneClasses(); };
    renderTop(); renderNav(); renderList(); renderMain(); renderRight(); paneClasses();
  }
  const narrow = () => matchMedia('(max-width: 760px)').matches;
  function paneClasses() {
    const sh = document.getElementById('lkshell'); if (!sh) return;
    S.inChat = S.pane === 'main' || S.pane === 'right';
    sh.classList.toggle('inchat', S.pane === 'main'); sh.classList.toggle('inright', S.pane === 'right'); sh.classList.toggle('navopen', !!S.navOpen);
    sh.classList.toggle('rightshut', !!S.rightShut); sh.classList.toggle('navmini', !!S.navMini);
  }
  function go(pane) { S.pane = pane; S.navOpen = false; paneClasses(); }
  // Back-compat: the old name for "refresh the side panels".
  function renderSide() { if (!document.getElementById('lkshell')) return; renderTop(); renderNav(); renderList(); renderRight(); chatTitle(); }

  // ---- header: logo, search, status, notifications, help, you
  function renderTop() {
    const el = document.getElementById('lktop'); if (!el) return;
    const me = personOf(S.user.id) || {};
    const role = S.team.role === 'owner' ? 'Owner' : S.team.role === 'admin' ? 'Admin' : jobName(me.job_role || 'staff');
    const n = bellCount();
    if (!el.dataset.ready) {
      el.dataset.ready = '1';
      el.innerHTML = `<button class="lk-ib lk-burger" id="burger" aria-label="Menu">${ic('menu')}</button>
        <div class="lk-logo"><span class="lk-li" aria-hidden="true">Li.</span><span class="lk-lt"><b>Riyeser Link</b><small>Business Communications</small></span></div>
        <div class="lk-search" id="srch" role="search">${ic('search')}<input id="q" type="search" autocomplete="off" placeholder="Search chats, people, calls…" aria-label="Search chats, people and calls"><div class="lk-pop lk-sres" id="sres" hidden></div></div>
        <button class="lk-ib lk-sbtn" id="srchbtn" aria-label="Search">${ic('search')}</button>
        <button class="lk-status" id="stbtn" aria-haspopup="true" aria-label="Your status"></button>
        <button class="lk-ib" id="bell" aria-label="Notifications">${ic('bell')}<span class="badge" id="bellc" hidden></span></button>
        <button class="lk-ib" id="helpbtn" aria-label="Help">${ic('help')}</button>
        <button class="lk-user" id="umenu" aria-haspopup="true"><span id="umav"></span><span class="lk-un"><b id="umn"></b><small id="umr"></small></span>${ic('down')}</button>`;
      el.querySelector('#burger').onclick = () => { S.navOpen = !S.navOpen; paneClasses(); };
      el.querySelector('#srchbtn').onclick = () => { el.classList.toggle('searching'); el.querySelector('#q').focus(); };
      wireSearch(el.querySelector('#q'), el.querySelector('#sres'));
      el.querySelector('#stbtn').onclick = (e) => statusMenu(e.currentTarget);
      el.querySelector('#bell').onclick = (e) => bellMenu(e.currentTarget);
      el.querySelector('#helpbtn').onclick = (e) => helpMenu(e.currentTarget);
      el.querySelector('#umenu').onclick = (e) => userMenu(e.currentTarget);
    }
    el.querySelector('#umav').innerHTML = `<span class="lk-av">${av(S.user.id, me.display_name || S.user.email)}${Presence.dot(S.user.id).replace('class="pd', 'class="pd pd-me')}</span>`;
    el.querySelector('#umn').textContent = me.display_name || 'You'; el.querySelector('#umr').textContent = role;
    const bc = el.querySelector('#bellc'); bc.hidden = !n; bc.textContent = n;
    paintMine();
  }
  // Unread in your list: muted chats, archived ones and channels you left don't count (nor in the tab title the desktop apps read).
  const unreadTotal = () => (S.chans || []).reduce((a, c) => a + (muted(c.id) ? 0 : (S.unread || {})[c.id] || 0), 0);
  const bellCount = () => unreadTotal() + missedNew() + (isAdmin() ? S.requests.length : 0);

  // A small menu under a button. Closes on Escape or a click elsewhere.
  // at: { x, y } opens it at that point instead (a right-click).
  function popMenu(anchor, html, wire, cls = '', at = null) {
    closePops();
    const d = document.createElement('div'); d.className = `lk-pop lk-menu ${cls}`; d.setAttribute('role', 'menu'); d.innerHTML = html;
    document.body.appendChild(d);
    const r = at ? { top: at.y, bottom: at.y, left: at.x, right: at.x + Math.min(d.offsetWidth || 280, innerWidth - 16) } : anchor.getBoundingClientRect();
    const w = Math.min(d.offsetWidth || 280, innerWidth - 16); const h = d.offsetHeight || 200;
    d.style.top = `${Math.round(r.bottom + 6 + h > innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : Math.min(r.bottom + 6, Math.max(8, innerHeight - h - 8)))}px`; d.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, innerWidth - w - 8)))}px`;
    const close = () => d.remove();
    setTimeout(() => { const off = (e) => { if (!d.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) { close(); document.removeEventListener('pointerdown', off, true); } };
      document.addEventListener('pointerdown', off, true); }, 0);
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); anchor.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {   // move between the menu's items with the arrow keys
        const items = [...d.querySelectorAll('button.mi:not(:disabled), a.mi')]; if (!items.length) return;
        e.preventDefault(); const i = items.indexOf(document.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    });
    wire(d, close); const f = d.querySelector('button, input'); if (f) f.focus();
    return d;
  }
  const closePops = () => document.querySelectorAll('.lk-menu').forEach((x) => x.remove());
  function statusMenu(anchor) {
    const cur = Presence.info(S.user.id);
    popMenu(anchor, `<div class="mh">Your status</div>${[['available', 'Available', 'Away after 10 minutes without using Riyeser Link'], ['busy', 'Busy', ''], ['dnd', 'Do not disturb', 'Calls don\'t ring you; your desk phone too'], ['away', 'Away', ''], ['offline', 'Appear offline', '']]
      .map(([k, n, h]) => `<button class="mi${(S.myManual || 'available') === k ? ' on' : ''}" data-st="${k}" role="menuitemradio" aria-checked="${(S.myManual || 'available') === k}"><i class="pd st-${k}"></i><span>${n}${h ? `<small>${h}</small>` : ''}</span></button>`).join('')}
      <form class="mform" id="stf"><label><span>Status message</span><input name="t" maxlength="80" placeholder="e.g. At the Elm St job" value="${esc(S.myText || '')}"></label><button class="btn sm">Save</button></form>
      <div class="mnote">${cur.on_call ? 'You\'re on a call, so others see <b>On a call</b>.' : ''}</div>`, (d, close) => {
      d.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { close(); Presence.choose(b.dataset.st); renderRight(); });
      d.querySelector('#stf').onsubmit = (e) => { e.preventDefault(); const t = String(new FormData(e.target).get('t') || '').replace(/[<>]/g, '').trim(); close(); Presence.choose(S.myManual || 'available', t); renderRight(); };
    }, 'stmenu');
  }
  function bellMenu(anchor) {
    const unread = S.chans.filter((c) => S.unread[c.id] && !muted(c.id));
    const missed = (S.callLog || []).filter((c) => c.result === 'missed').slice(0, 5);
    popMenu(anchor, `<div class="mh">Notifications</div>
      ${unread.length ? unread.map((c) => `<button class="mi" data-go-ch="${c.id}">${c.kind === 'dm' ? av(otherIn(c), chanLabel(c)) : `<span class="hash">${c.kind === 'private' ? ic('lock') : '#'}</span>`}<span>${esc(chanLabel(c))}<small>${S.unread[c.id]} unread</small></span></button>`).join('') : ''}
      ${missed.map((c) => `<button class="mi" data-go-calls="1"><span class="hash miss">${ic('missed')}</span><span>Missed call: ${esc(callWho(c))}<small>${esc(whenShort(c.at))}</small></span></button>`).join('')}
      ${isAdmin() && S.requests.length ? `<button class="mi" data-go-req="1"><span class="hash">👋</span><span>${S.requests.length} join request${S.requests.length === 1 ? '' : 's'}<small>People asking to join ${esc(S.team.name)}</small></span></button>` : ''}
      ${!unread.length && !missed.length && !(isAdmin() && S.requests.length) ? '<p class="mnote">You\'re all caught up.</p>' : ''}`, (d, close) => {
      d.querySelectorAll('[data-go-ch]').forEach((b) => b.onclick = () => { close(); openChannel(b.dataset.goCh); });
      d.querySelectorAll('[data-go-calls]').forEach((b) => b.onclick = () => { close(); S.listTab = 'calls'; seeCalls(); renderList(); renderTop(); go('list'); });
      const rq = d.querySelector('[data-go-req]'); if (rq) rq.onclick = () => { close(); needs2step() ? security() : joinRequests(); };
    }, 'bellmenu');
  }
  function helpMenu(anchor) {
    popMenu(anchor, `<div class="mh">Help</div><a class="mi" href="/help/link.html" target="_blank" rel="noopener">${ic('help')}<span>Riyeser Link Help Centre<small>Chat, calls and desk phones</small></span></a>
      <button class="mi" id="hgh">${ic('chat')}<span>Ask Riyeser for help<small>We usually reply within one business day</small></span></button>
      <button class="mi" id="hks">${ic('grid')}<span>Keyboard tips</span></button>`, (d, close) => {
      d.querySelector('#hgh').onclick = () => { close(); getHelp(); };
      d.querySelector('#hks').onclick = () => { close(); modal(`<h3>Keyboard tips</h3><dl class="kbd"><dt>Enter</dt><dd>Send</dd><dt>Shift + Enter</dt><dd>New line</dd><dt>Esc</dt><dd>Stop editing, close a menu</dd><dt>/</dt><dd>Search</dd><dt>Ctrl + [</dt><dd>Make the left menu smaller, or bigger again</dd><dt>Ctrl + ]</dt><dd>Hide or show the People and details panel</dd><dt>Right-click a chat</dt><dd>Rename, mute, pin, leave or archive it</dd></dl>
        <p class="muted small">Type INV-1047, Q-0042 or Booking 12 in a message to point at one.</p><div class="mfoot"><button class="btn p" id="cl">Done</button></div>`, (m, c) => { m.querySelector('#cl').onclick = c; }); };
    });
  }
  function userMenu(anchor) {
    const me = personOf(S.user.id) || {}; const desk = /Electron/.test(navigator.userAgent) || DEMO;
    popMenu(anchor, `<div class="mh mhu">${av(S.user.id, me.display_name || 'You')}<span><b>${esc(me.display_name || 'You')}</b><small>${esc(S.user.email || '')}</small></span></div>
      <button class="mi" id="um-prof">${ic('user')}<span>My profile</span></button>
      <button class="mi" id="um-theme">${ic('palette')}<span>Theme<small>${esc((THEMES.find((t) => t[0] === Theme.get().theme) || THEMES[0])[1])} · ${esc((ACCENTS.find((a) => a[0] === Theme.get().accent) || ACCENTS[0])[1].replace(' (Riyeser Link)', ''))}</small></span></button>
      <button class="mi" id="um-phone">${ic('desk')}<span>My phone</span></button>
      <button class="mi" id="um-sec">${ic('shield')}<span>Security<small>Two-step sign-in</small></span></button>
      <button class="mi" id="um-pw">${ic('shield')}<span>Change password</span></button>
      <button class="mi" id="um-co">${ic('building')}<span>${esc(S.team.name)}<small>Company details</small></span></button>
      ${desk ? '' : `<button class="mi" id="tohome">${ic('back')}<span>Riyeser home</span></button>`}
      <button class="mi" id="out">${ic('out')}<span>Sign out</span></button>`, (d, close) => {
      const on = (id, fn) => { const b = d.querySelector(id); if (b) b.onclick = () => { close(); fn(); }; };
      on('#um-prof', () => editMyDetails(me)); on('#um-theme', appearance); on('#um-phone', () => myPhonePage('chat')); on('#um-sec', security); on('#um-pw', changePassword);
      on('#um-co', () => companyInfo(false)); on('#tohome', () => { S.home = true; renderHome(); });
      on('#out', async () => { await api.signOut(); S.team = null; gate(); });
    }, 'usermenu');
  }
  function wireSearch(input, box) {
    let t = null; let seq = 0;
    const hide = () => { box.hidden = true; };
    input.addEventListener('blur', () => setTimeout(hide, 200));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; hide(); input.blur(); } });
    addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') && document.getElementById('q')) { e.preventDefault(); document.getElementById('q').focus(); } });
    input.oninput = () => { clearTimeout(t); const q = input.value.trim(); if (!q) return hide(); t = setTimeout(() => run(q), 180); };
    async function run(q) {
      const my = ++seq; const ql = q.toLowerCase();
      const ppl = S.people.filter((p) => p.display_name.toLowerCase().includes(ql) || String(p.extension || '').startsWith(q)).slice(0, 5);
      const chs = S.chans.filter((c) => c.kind !== 'dm' && (c.name || '').toLowerCase().includes(ql)).slice(0, 5);
      const cls = (S.callLog || []).filter((c) => callWho(c).toLowerCase().includes(ql) || String(callExt(c) || '').startsWith(q)).slice(0, 4);
      const draw = (msgs) => {
        if (my !== seq) return;
        box.innerHTML = `${ppl.length ? `<div class="mh">People</div>${ppl.map((p) => `<button class="mi" data-sp="${p.user_id}"><span class="lk-av">${av(p.user_id, p.display_name)}${Presence.dot(p.user_id)}</span><span>${esc(p.display_name)}<small>${esc(Presence.text(p.user_id))}${p.extension ? ` · Ext. ${p.extension}` : ''}</small></span></button>`).join('')}` : ''}
          ${chs.length ? `<div class="mh">Chats</div>${chs.map((c) => `<button class="mi" data-sc="${c.id}"><span class="hash">${c.kind === 'private' ? ic('lock') : '#'}</span><span>${esc(c.name)}<small>${esc(c.topic || '')}</small></span></button>`).join('')}` : ''}
          ${cls.length ? `<div class="mh">Calls</div>${cls.map((c) => `<button class="mi" data-scl="1"><span class="hash">${ic('phone')}</span><span>${esc(callWho(c))}<small>${esc(callLine(c))} · ${esc(whenShort(c.at))}</small></span></button>`).join('')}` : ''}
          ${msgs && msgs.length ? `<div class="mh">Messages</div>${msgs.slice(0, 6).map((m) => { const c = S.chans.find((x) => x.id === m.channel_id) || S.archived.find((x) => x.id === m.channel_id); return c ? `<button class="mi" data-sm="${m.channel_id}"><span class="hash">${ic('chat')}</span><span>${esc(m.body.slice(0, 80))}<small>${esc(nameOf(m.user_id))} in ${esc(c.kind === 'dm' ? chanLabel(c) : '#' + c.name)} · ${esc(whenShort(m.created_at))}</small></span></button>` : ''; }).join('')}` : ''}
          ${!ppl.length && !chs.length && !cls.length && msgs && !msgs.length ? `<p class="mnote">Nothing found for “${esc(q)}”.</p>` : ''}`;
        box.hidden = false;
        box.querySelectorAll('[data-sp]').forEach((b) => b.onmousedown = (e) => { e.preventDefault(); hide(); input.value = ''; openDm(b.dataset.sp); });
        box.querySelectorAll('[data-sc],[data-sm]').forEach((b) => b.onmousedown = (e) => { e.preventDefault(); hide(); input.value = ''; openChannel(b.dataset.sc || b.dataset.sm); });
        box.querySelectorAll('[data-scl]').forEach((b) => b.onmousedown = (e) => { e.preventDefault(); hide(); input.value = ''; S.listTab = 'calls'; renderList(); go('list'); });
      };
      draw(null);
      if (q.length >= 2) draw(await api.search(S.team.id, q).catch(() => []));
    }
  }

  // ---- left nav
  function renderNav() {
    const el = document.getElementById('lknav'); if (!el) return;
    const admin = isAdmin(); const tip = (label) => ` aria-label="${label}"${S.navMini ? ` title="${label}"` : ''}`;
    const item = (k, icon, label, extra = '', id = '') => `<button class="lk-ni${S.nav === k ? ' on' : ''}" data-nav="${k}"${id ? ` id="${id}"` : ''}${tip(label)}>${ic(icon)}<span>${label}</span>${extra}</button>`;
    const unread = unreadTotal(); const missed = missedNew();
    el.innerHTML = `<div class="team"><span class="lk-tico" aria-hidden="true">${esc(initials(S.team.name))}</span><div>${S.teams.length > 1
      ? `<select id="tsw" aria-label="Switch company">${S.teams.map((t) => `<option value="${t.id}"${t.id === S.team.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : `<b>${esc(S.team.name)}</b>`}<small>${S.people.length} ${S.people.length === 1 ? 'person' : 'people'}${S.team.company_code ? ` · ${esc(S.team.company_code)}` : ''}</small></div></div>
      ${needs2step() ? '<button class="mfa-nag" id="mfanag">🔐 Owners and admins need <b>two-step sign-in</b> to approve people and change access. <u>Turn it on (2 minutes)</u></button>' : ''}
      <div class="lk-nscroll"><div class="lk-nh">Workspace</div>
      ${item('home', 'home', 'Home')}${item('chat', 'chat', 'Chat', unread ? `<span class="badge">${unread}</span>` : '')}${item('calls', 'phone', 'Calls', missed ? `<span class="badge">${missed}</span>` : '')}
      ${item('contacts', 'users', 'Contacts')}${item('channels', 'hash', 'Teams / Channels')}
      ${admin ? `<button class="lk-ni" id="cophones">${ic('desk')}<span>Desk Phones</span></button>` : `<button class="lk-ni" id="comyphone">${ic('desk')}<span>My phone</span></button>`}
      ${item('devices', 'monitor', 'Devices')}
      ${admin ? `<div class="lk-admin${S.adminShut ? ' shut' : ''}"><button class="lk-ah" id="adminh" aria-expanded="${!S.adminShut}">${ic('cog')}<span>Admin / Settings</span>${ic('down')}</button>
        <div class="lk-ag" id="adming">
          <button class="lk-ni sm" id="coppl">${ic('users')}<span>People &amp; access</span></button>
          <button class="lk-ni sm" id="coreq">${ic('user')}<span>Join requests</span>${S.requests.length ? `<span class="badge">${S.requests.length}</span>` : ''}</button>
          <button class="lk-ni sm" id="coinfo">${ic('building')}<span>Company</span></button>
          <button class="lk-ni sm" id="mgbr">${ic('branch')}<span>Branches &amp; extensions</span></button>
          <button class="lk-ni sm" id="ad-phones">${ic('desk')}<span>Desk phones</span></button>
          <button class="lk-ni sm" id="cosec">${ic('shield')}<span>Security</span></button>
          <button class="lk-ni sm" id="cohist">${ic('clock')}<span>History</span></button>
          <button class="lk-ni sm" disabled title="Coming soon">${ic('chart')}<span>Reports</span><span class="soon">soon</span></button>
          ${isOwner() ? `<button class="lk-ni sm" id="coplan">${ic('card')}<span>Plan &amp; billing</span></button>` : ''}
        </div></div>` : ''}</div>
      <div class="lk-nfoot"><button class="lk-ni sm" id="coset"${tip('Settings')}>${ic('cog')}<span>Settings</span></button><button class="lk-ni sm lk-inv" id="inv"${tip('Invite people')}>${ic('plus')}<span>Invite people</span></button>
        <button class="lk-ni sm lk-navtog" id="navtog" aria-expanded="${!S.navMini}" aria-label="${S.navMini ? 'Show the full menu' : 'Make the menu smaller'}" title="${S.navMini ? 'Show the full menu' : 'Make the menu smaller'} (Ctrl + [)">${ic(S.navMini ? 'navopen' : 'navshut')}<span>Make the menu smaller</span></button></div>`;
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = () => { S.navOpen = false; paneClasses(); fn(); }; };
    el.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => setNav(b.dataset.nav));
    const sw = el.querySelector('#tsw'); if (sw) sw.onchange = () => loadTeam(sw.value);
    on('#mfanag', security); on('#cophones', () => phonesPage('chat')); on('#ad-phones', () => phonesPage('chat')); on('#comyphone', () => myPhonePage('chat'));
    on('#coppl', () => (needs2step() ? security() : peopleAccess())); on('#coreq', () => (needs2step() ? security() : joinRequests()));
    on('#coinfo', () => companyInfo(false)); on('#mgbr', () => (needs2step() ? security() : manageBranches())); on('#cosec', security); on('#cohist', showHistory);
    on('#coplan', planBilling); on('#coset', settingsMenu); on('#inv', invite);
    el.querySelector('#navtog').onclick = toggleNav;
    const ah = el.querySelector('#adminh'); if (ah) ah.onclick = () => { S.adminShut = !S.adminShut; ah.parentElement.classList.toggle('shut', S.adminShut); ah.setAttribute('aria-expanded', String(!S.adminShut)); };
  }
  function setNav(k) {
    S.nav = k; S.navOpen = false; closePops();
    if (k === 'chat') { S.listTab = 'chats'; renderNav(); renderList(); renderMain(); go(narrow() ? 'list' : 'main'); return; }
    if (k === 'calls') { S.listTab = 'calls'; seeCalls(); renderTop(); }
    renderNav(); renderList(); renderMain(); go('main');
  }

  // ---- the list: Chats / Calls / Voicemail
  function chatRow(c, uid) {
    const ch = c || null; const id = ch ? ch.id : null; const lm = id ? S.last[id] : null; const un = id ? S.unread[id] || 0 : 0;
    const dm = uid || (ch && ch.kind === 'dm' ? otherIn(ch) : null);
    const label = dm ? nameOf(dm) : ch.name; const on = S.nav === 'chat' && S.ch && id && S.ch.id === id;
    const pic = dm ? `<span class="lk-av">${av(dm, label)}${Presence.dot(dm)}</span>`
      : `<span class="lk-chic${ch.kind === 'private' ? ' prv' : ''}" aria-hidden="true">${ch.kind === 'private' ? ic('lock') : ic('hash')}</span>`;
    const prev = lm ? (lm.deleted ? 'Message deleted' : `${lm.user_id === S.user.id ? 'You: ' : dm ? '' : esc(nameOf(lm.user_id).split(' ')[0]) + ': '}${esc(lm.body.replace(/\s+/g, ' ').slice(0, 70))}`)
      : dm ? esc(Presence.text(dm)) : esc((ch && ch.topic) || 'No messages yet');
    const pinned = id && S.pinned.includes(id); const mu = id && muted(id); const arch = !!(ch && ch.archived);
    return `<div class="lk-row${arch ? ' arch' : ''}"><button class="item${on ? ' on' : ''}${un && !arch ? ' unread' : ''}${mu ? ' muted' : ''}" ${dm ? `data-dm="${dm}"` : `data-ch="${id}"`}>${pic}
      <span class="lk-rb"><span class="lk-r1"><span class="nm">${esc(label)}</span>${mu ? `<span class="mutei" title="Muted">${ic('mute')}</span>` : ''}${lm ? `<time>${esc(whenShort(lm.created_at))}</time>` : dm && extOf(dm) ? `<span class="ext">${extOf(dm)}</span>` : ''}</span>
      <span class="lk-r2"><span class="pv">${prev}</span>${un && !arch ? `<span class="badge${mu ? ' dim' : ''}">${un}</span>` : ''}</span></span></button>
      ${id ? `<button class="lk-more" data-cmenu="${id}" aria-haspopup="menu" aria-label="More for ${esc(label)}" title="More: rename, mute, archive…">${ic('more')}</button>` : ''}
      ${id && !arch ? `<button class="lk-pin${pinned ? ' on' : ''}" data-pin="${id}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(label)}" title="${pinned ? 'Unpin' : 'Pin to the top'}">${ic('pin')}</button>` : ''}</div>`;
  }
  function renderList() {
    const el = document.getElementById('side'); if (!el) return;
    const tab = S.listTab || 'chats'; const missed = missedNew(); const unread = unreadTotal();
    let body = '';
    if (tab === 'chats') {
      const pinned = S.pinned.map((id) => S.chans.find((c) => c.id === id)).filter(Boolean);
      const chs = S.chans.filter((c) => c.kind !== 'dm' && !S.pinned.includes(c.id));
      const others = S.people.filter((p) => p.user_id !== S.user.id).filter((p) => { const d = dmWith(p.user_id); return !(d && S.pinned.includes(d.id)); })
        .sort((a, b) => { const la = S.last[(dmWith(a.user_id) || {}).id]; const lb = S.last[(dmWith(b.user_id) || {}).id];
          return (lb ? lb.created_at : '').localeCompare(la ? la.created_at : '') || a.display_name.localeCompare(b.display_name); });
      // a folded section still shows how many unread messages are in it
      const un = (list) => list.reduce((a, c) => a + (c && !muted(c.id) ? S.unread[c.id] || 0 : 0), 0);
      const dmRows = others.map((p) => dmWith(p.user_id));
      body = `<button class="lk-new" id="newchat">${ic('plus')} New chat</button><div class="sidescroll" id="lscroll">
        ${pinned.length ? `${secHead('pinned', 'Pinned', '', UI.shut('pinned') ? un(pinned) : 0)}${secBody('pinned', pinned.map((c) => chatRow(c)).join(''))}` : ''}
        ${secHead('channels', 'Channels', `<button id="addch" aria-label="Add a channel" title="Add a channel">${ic('plus')}</button>`, UI.shut('channels') ? un(chs) : 0)}
        ${secBody('channels', chs.map((c) => chatRow(c)).join('') || '<p class="lk-none">No channels yet.</p>')}
        ${secHead('dms', 'Direct messages', `<button id="adddm" aria-label="Message someone" title="Message someone">${ic('plus')}</button>`, UI.shut('dms') ? un(dmRows) : 0)}
        ${secBody('dms', others.map((p) => chatRow(dmWith(p.user_id), p.user_id)).join('') || '<p class="lk-none">Invite your team to start chatting.</p>')}
        ${S.archived.length ? `${secHead('archived', 'Archived', '', S.archived.length)}${secBody('archived', `<p class="lk-none lk-archnote">Hidden for everyone and read-only. The messages are kept.</p>${S.archived.map((c) => chatRow(c)).join('')}`)}` : ''}</div>`;
    } else if (tab === 'calls') {
      const f = S.features || {}; const me = personOf(S.user.id) || {};
      const trial = f.calls && !f.calls_paid && f.trial_days_left != null ? `<span class="trialtag">Trial · ${f.trial_days_left} days left</span>` : '';
      body = `<div class="sidescroll" id="lscroll">${secHead('branches', 'Ring a branch', `${f.calls ? trial : '<span class="trialtag prem">⭐ Premium</span>'}<span><button id="dial" aria-label="Dial an extension" title="Dial an extension">${ic('grid')}</button></span>`)}
        ${secBody('branches', `${S.branches.map((b) => `<div class="lk-row"><button class="item" data-callbranch="${b.id}" title="Rings everyone in ${esc(b.name)}"><span class="lk-chic" aria-hidden="true">${ic('phone')}</span><span class="lk-rb"><span class="lk-r1"><span class="nm">${esc(b.name)}</span>${b.extension ? `<span class="ext">${b.extension}</span>` : ''}</span><span class="lk-r2"><span class="pv">${b.people.length} ${b.people.length === 1 ? 'person' : 'people'} ring together</span></span></span></button></div>`).join('') || '<p class="lk-none">No branches yet.</p>'}
        ${me.extension ? `<p class="myext">Your extension: <b>${me.extension}</b></p>` : ''}`)}
        ${secHead('calls', 'Recent calls')}${secBody('calls', callRows(S.callLog || [], 30))}</div>`;
    } else {
      body = `<div class="sidescroll" id="lscroll"><div class="lk-vm">${ic('vm')}<b>No voicemail</b><p>Coming with Riyeser Link Office voicemail. Messages people leave on your extension will show here.</p></div></div>`;
    }
    el.innerHTML = `<div class="lk-tabs" role="tablist"><button role="tab" data-tab="chats" aria-selected="${tab === 'chats'}" class="${tab === 'chats' ? 'on' : ''}">Chats${unread ? ` <span class="badge">${unread}</span>` : ''}</button>
      <button role="tab" data-tab="calls" aria-selected="${tab === 'calls'}" class="${tab === 'calls' ? 'on' : ''}">Calls${missed ? ` <span class="badge">${missed}</span>` : ''}</button>
      <button role="tab" data-tab="voicemail" aria-selected="${tab === 'voicemail'}" class="${tab === 'voicemail' ? 'on' : ''}">Voicemail <span class="cnt" id="vmc">0</span></button></div>${body}`;
    el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.listTab = b.dataset.tab; if (S.listTab === 'calls') { seeCalls(); renderTop(); renderNav(); } renderList(); });
    el.querySelectorAll('[data-ch]').forEach((b) => b.onclick = () => openChannel(b.dataset.ch));
    el.querySelectorAll('[data-dm]').forEach((b) => b.onclick = () => openDm(b.dataset.dm));
    el.querySelectorAll('[data-pin]').forEach((b) => b.onclick = () => togglePin(b.dataset.pin));
    el.querySelectorAll('[data-sect]').forEach((b) => b.onclick = () => toggleSec(b.dataset.sect));
    const chOf = (id) => S.chans.find((c) => c.id === id) || S.archived.find((c) => c.id === id);
    el.querySelectorAll('[data-cmenu]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const c = chOf(b.dataset.cmenu); if (c) chanMenu(b, c); });
    // right-click (or the keyboard's menu key, or a long press) on a chat opens the same menu
    el.querySelectorAll('.lk-row > .item[data-ch], .lk-row > .item[data-dm]').forEach((b) => b.oncontextmenu = (e) => {
      const c = b.dataset.ch ? chOf(b.dataset.ch) : dmWith(b.dataset.dm); if (!c) return;
      e.preventDefault(); chanMenu(b, c, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null);
    });
    el.querySelectorAll('[data-callbranch]').forEach((b) => b.onclick = () => Calls.start({ branch: b.dataset.callbranch }));
    el.querySelectorAll('[data-redial]').forEach((b) => b.onclick = () => redial(b.dataset.redial));
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };
    on('#newchat', newChat); on('#addch', addChannel); on('#adddm', newChat); on('#dial', dialPad);
    chatTitle();
  }
  function callRows(list, n) {
    if (!list.length) return `<div class="lk-vm small">${ic('phone')}<b>Your calls will show here</b><p>Calls you make and get in Riyeser Link, on this device.</p></div>`;
    return list.slice(0, n).map((c, i) => `<div class="lk-row"><button class="item lk-callrow${c.result === 'missed' ? ' miss' : ''}" data-redial="${i}" title="Call back">
      <span class="lk-av">${c.peer ? av(c.peer, callWho(c)) + Presence.dot(c.peer) : `<span class="lk-chic" aria-hidden="true">${ic('phone')}</span>`}</span>
      <span class="lk-rb"><span class="lk-r1"><span class="nm">${esc(callWho(c))}</span><time>${esc(whenShort(c.at))}</time></span>
      <span class="lk-r2"><span class="pv"><span class="cdir">${ic(c.result === 'missed' ? 'missed' : c.dir === 'in' ? 'in' : 'outc')}</span>${esc(callLine(c))}${c.dur ? ` · ${durText(c.dur)}` : ''}${callExt(c) ? ` · Ext. ${callExt(c)}` : ''}</span></span></span></button></div>`).join('');
  }
  function redial(i) { const c = (S.callLog || [])[Number(i)]; if (!c) return; if (c.peer) Calls.start({ user: c.peer }); else if (c.branch) Calls.start({ branch: c.branch }); }
  async function openDm(uid) {
    if (uid === S.user.id) return;
    const id = await api.openDm(S.team.id, uid);
    if (!S.chans.find((c) => c.id === id)) await loadChans();
    openChannel(id);
  }

  // ---- the middle: a conversation, or Home / Calls / Contacts / Teams / Devices
  function renderMain() {
    const el = document.getElementById('main'); if (!el) return;
    if (S.nav === 'chat') {
      if (!document.getElementById('msgs')) {
        el.innerHTML = `<header class="mhead" id="mhead"></header><div class="msgs" id="msgs" aria-live="polite"></div>
          <form class="composer" id="comp"><div class="lk-up" id="upl" hidden></div><div class="cbox"><button type="button" class="lk-ib" id="attach" aria-label="Attach a file" title="Attach a file (up to 25 MB)">${ic('clip')}</button>
          <button type="button" class="lk-ib" id="emo" aria-label="Add an emoji" title="Emoji">${ic('smile')}</button>
          <textarea id="txt" rows="1" placeholder="" aria-label="Message"></textarea><button id="send" disabled aria-label="Send" title="Send (Enter)">${ic('send')}</button></div>
          <input type="file" id="file" multiple hidden></form>`;
        wireComposer();
      }
      renderHead(); renderMsgs(true);
      return;
    }
    el.innerHTML = `<div class="lk-view" id="mview"><button class="back lk-vback" aria-label="Back">${ic('back')}</button>${viewHtml(S.nav)}</div>`;
    el.querySelector('.lk-vback').onclick = () => go('list');
    wireView(el);
  }
  function card(title, body, cls = '', id = '') { return `<section class="lk-card ${cls}"${id ? ` id="${id}"` : ''}><h3>${title}</h3>${body}</section>`; }
  function personRow(p, actions = true) {
    const me = p.user_id === S.user.id;
    return `<div class="lk-person" data-person="${p.user_id}"><span class="lk-av">${av(p.user_id, p.display_name)}${Presence.dot(p.user_id)}</span>
      <span class="lk-pn"><b>${esc(p.display_name)}${me && p.display_name !== 'You' ? ' <small>(You)</small>' : ''}</b><small class="lk-pst">${esc(Presence.text(p.user_id))}</small></span>
      ${p.extension ? `<span class="lk-ext">Ext. ${p.extension}</span>` : '<span class="lk-ext"></span>'}
      ${actions && !me ? `${plus() ? `<button class="lk-call" data-callp="${p.user_id}" aria-label="Call ${esc(p.display_name)}" title="Call">${ic('phone')}</button>` : ''}` : ''}</div>`;
  }
  function viewHtml(k) {
    const me = personOf(S.user.id) || {};
    if (k === 'home') {
      const recent = [...S.chans].filter((c) => S.pinned.includes(c.id) || S.unread[c.id] || S.last[c.id])
        .sort((a, b) => (S.pinned.includes(b.id) - S.pinned.includes(a.id)) || ((S.unread[b.id] ? 1 : 0) - (S.unread[a.id] ? 1 : 0)) || String((S.last[b.id] || {}).created_at || '').localeCompare(String((S.last[a.id] || {}).created_at || ''))).slice(0, 6);
      const missed = (S.callLog || []).filter((c) => c.result === 'missed').slice(0, 4);
      const chans = S.chans.filter((c) => c.kind !== 'dm').slice(0, 6);
      return `<h1>Your workspace</h1><p class="lk-sub">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}${me.display_name && me.display_name !== 'You' ? ', ' + esc(me.display_name.split(' ')[0]) : ''}. Here's what's happening at ${esc(S.team.name)}.</p>
        <div class="lk-cards">
        ${card(`${ic('chat')} Recent conversations`, recent.length ? `<div class="lk-mini">${recent.map((c) => `<button class="mi" data-go-ch="${c.id}">${c.kind === 'dm' ? `<span class="lk-av">${av(otherIn(c), chanLabel(c))}${Presence.dot(otherIn(c))}</span>` : `<span class="lk-chic sm">${c.kind === 'private' ? ic('lock') : ic('hash')}</span>`}<span>${S.pinned.includes(c.id) ? `<span class="pinmark">${ic('pin')}</span>` : ''}${esc(chanLabel(c))}<small>${S.last[c.id] ? esc(S.last[c.id].body.slice(0, 60)) : esc(c.topic || '')}</small></span>${S.unread[c.id] ? `<span class="badge">${S.unread[c.id]}</span>` : ''}</button>`).join('')}</div>` : '<p class="muted">Pinned chats and unread messages show here.</p>', '', 'hrecent')}
        ${card(`${ic('phone')} Quick call`, plus() ? `<form class="lk-qc" id="qcf"><input id="qci" placeholder="Search name or extension" autocomplete="off" aria-label="Name or extension"><button class="btn p" id="qcgo">${ic('phone')} Call</button></form><div class="lk-mini" id="qcr"></div>` : `<p class="muted">Calls between your people and branches come with <b>Riyeser Link Plus</b>.</p><button class="btn" id="qcup">See Riyeser Link Plus</button>`, '', 'hquick')}
        ${card(`${ic('missed')} Missed calls`, missed.length ? `<div class="lk-mini">${missed.map((c) => `<div class="mi"><span class="lk-av">${c.peer ? av(c.peer, callWho(c)) : ''}</span><span>${esc(callWho(c))}<small>${esc(whenShort(c.at))}${callExt(c) ? ` · Ext. ${callExt(c)}` : ''}</small></span>
          ${c.peer && plus() ? `<button class="lk-ib" data-callp="${c.peer}" aria-label="Call back ${esc(callWho(c))}" title="Call back">${ic('phone')}</button>` : ''}${c.peer ? `<button class="lk-ib" data-dmp="${c.peer}" aria-label="Message ${esc(callWho(c))}" title="Send a message">${ic('chat')}</button>` : ''}</div>`).join('')}</div>` : '<p class="muted">No missed calls. Nice.</p>', '', 'hmissed')}
        ${card(`${ic('hash')} Team channels`, `<div class="lk-mini">${chans.map((c) => `<button class="mi" data-go-ch="${c.id}"><span class="lk-chic sm">${c.kind === 'private' ? ic('lock') : ic('hash')}</span><span>${esc(c.name)}<small>${esc(c.topic || '')}</small></span>${S.unread[c.id] ? `<span class="badge">${S.unread[c.id]}</span>` : ''}</button>`).join('')}</div><button class="linkbtn" data-nav-go="channels">All channels →</button>`, '', 'hchans')}
        ${isAdmin() ? card(`${ic('user')} Requests`, S.requests.length ? `<p><b>${S.requests.length}</b> ${S.requests.length === 1 ? 'person is' : 'people are'} asking to join ${esc(S.team.name)}.</p><button class="btn p" id="hreqs">Review requests</button>` : '<p class="muted">No one is waiting to join. Share your Company ID to invite people.</p><button class="btn" id="hinv">Invite people</button>', '', 'hrequests') : ''}
        ${card(`${ic('desk')} My devices`, `<div id="hdev"><p class="muted">Loading…</p></div>`, '', 'hdevices')}
        </div>`;
    }
    if (k === 'calls') {
      return `<h1>Calls</h1><p class="lk-sub">${plus() ? 'Ring a person or a whole branch. Calls go straight between devices, with no call charges.' : 'Calls come with <b>Riyeser Link Plus</b>: free for your first 90 days.'}</p>
        <div class="lk-cards two">${card(`${ic('grid')} Dial`, dialHtml('vd'), 'lk-qd')}${card(`${ic('clock')} Recent calls`, `<div class="lk-mini lk-calls">${callRows(S.callLog || [], 50)}</div>`)}</div>`;
    }
    if (k === 'contacts') {
      return `<h1>Contacts</h1><p class="lk-sub">Everyone at ${esc(S.team.name)}, their status and extension.</p>
        <input class="lk-find" id="cfind" placeholder="Search people…" aria-label="Search people">
        <div class="lk-dir" id="cdir">${S.people.map((p) => `<div class="lk-drow" data-name="${esc(p.display_name.toLowerCase())} ${p.extension || ''}">${personRow(p, false)}<span class="lk-job">${esc(p.role === 'owner' ? 'Owner' : jobName(p.job_role))}</span>
          <span class="lk-dact">${p.user_id !== S.user.id ? `<button class="btn sm" data-dmp="${p.user_id}">${ic('chat')} Message</button>${plus() ? `<button class="btn sm" data-callp="${p.user_id}">${ic('phone')} Call</button>` : ''}` : ''}</span></div>`).join('')}</div>
        ${S.branches.length ? `<h2 class="lk-h2">Branches</h2><div class="lk-dir">${S.branches.map((b) => `<div class="lk-drow"><div class="lk-person"><span class="lk-chic">${ic('branch')}</span><span class="lk-pn"><b>${esc(b.name)}</b><small class="lk-pst">${b.people.length} ${b.people.length === 1 ? 'person' : 'people'} · rings everyone</small></span>${b.extension ? `<span class="lk-ext">Ext. ${b.extension}</span>` : ''}</div><span class="lk-job"></span><span class="lk-dact">${plus() ? `<button class="btn sm" data-callbranch="${b.id}">${ic('phone')} Call</button>` : ''}</span></div>`).join('')}</div>` : ''}`;
    }
    if (k === 'channels') {
      const chs = S.chans.filter((c) => c.kind !== 'dm');
      const chCard = (c, extra = '') => `<button class="lk-card lk-chcard${c.archived ? ' arch' : ''}" data-go-ch="${c.id}"><span class="lk-chic">${c.archived ? ic('archive') : c.kind === 'private' ? ic('lock') : ic('hash')}</span><b>${esc(c.name)}</b><small>${esc(c.topic || (c.kind === 'private' ? 'Private' : 'Everyone in the team'))}</small>
          <span class="lk-chm">${c.kind === 'private' ? `${c.people.length} ${c.people.length === 1 ? 'person' : 'people'} · private` : `${S.people.length} people`}${extra}${S.unread[c.id] && !c.archived ? ` · <span class="badge">${S.unread[c.id]}</span>` : ''}</span></button>`;
      return `<div class="lk-vh"><div><h1>Teams / Channels</h1><p class="lk-sub">Channels everyone can see, and private ones you're in.</p></div><button class="btn p" id="vnewch">${ic('plus')} New channel</button></div>
        <div class="lk-cards">${chs.map((c) => chCard(c)).join('')}</div>
        ${S.leftChans.length ? `<h2 class="lk-h2">Channels you left</h2><div class="lk-dir">${S.leftChans.map((c) => `<div class="lk-drow"><div class="lk-person"><span class="lk-chic">${ic('hash')}</span><span class="lk-pn"><b>${esc(c.name)}</b><small class="lk-pst">${esc(c.topic || 'Everyone in the team')}</small></span></div><span class="lk-job"></span><span class="lk-dact"><button class="btn sm" data-rejoin="${c.id}">${ic('plus')} Join again</button></span></div>`).join('')}</div>` : ''}
        ${S.archived.length ? `<h2 class="lk-h2">Archived</h2><p class="lk-sub">Hidden for everyone and read-only. The messages are kept${S.archived.some(canManage) ? '; open one to bring it back' : ''}.</p><div class="lk-cards">${S.archived.map((c) => chCard(c, ' · archived')).join('')}</div>` : ''}`;
    }
    if (k === 'devices') {
      return `<h1>Devices</h1><p class="lk-sub">Your desk phone, and the PCs and apps you're signed in on.</p><div class="lk-cards two">
        ${card(`${ic('desk')} My desk phone`, '<div id="vdesk"><p class="muted">Loading…</p></div>')}${card(`${ic('monitor')} My PCs`, '<div id="vpcs"><p class="muted">Loading…</p></div>')}</div>`;
    }
    return '';
  }
  function wireView(el) {
    el.querySelectorAll('[data-go-ch]').forEach((b) => b.onclick = () => openChannel(b.dataset.goCh));
    el.querySelectorAll('[data-rejoin]').forEach((b) => b.onclick = () => rejoinChan(b.dataset.rejoin));
    el.querySelectorAll('[data-nav-go]').forEach((b) => b.onclick = () => setNav(b.dataset.navGo));
    el.querySelectorAll('[data-callp]').forEach((b) => b.onclick = () => Calls.start({ user: b.dataset.callp }));
    el.querySelectorAll('[data-dmp]').forEach((b) => b.onclick = () => openDm(b.dataset.dmp));
    el.querySelectorAll('[data-callbranch]').forEach((b) => b.onclick = () => Calls.start({ branch: b.dataset.callbranch }));
    el.querySelectorAll('[data-redial]').forEach((b) => b.onclick = () => redial(b.dataset.redial));
    const on = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };
    on('#hreqs', () => (needs2step() ? security() : joinRequests())); on('#hinv', invite); on('#vnewch', addChannel); on('#qcup', upsell);
    wireDial(el, 'vd');
    const cf = el.querySelector('#cfind'); if (cf) cf.oninput = () => { const q = cf.value.trim().toLowerCase(); el.querySelectorAll('#cdir .lk-drow').forEach((r) => { r.hidden = !!q && !r.dataset.name.includes(q); }); };
    const qci = el.querySelector('#qci');
    if (qci) {
      const find = () => { const q = qci.value.trim().toLowerCase(); return q ? S.people.filter((p) => p.user_id !== S.user.id && (p.display_name.toLowerCase().includes(q) || String(p.extension || '').startsWith(q))).slice(0, 4) : []; };
      const show = () => { const r = find(); el.querySelector('#qcr').innerHTML = r.map((p) => `<button class="mi" type="button" data-callp="${p.user_id}"><span class="lk-av">${av(p.user_id, p.display_name)}${Presence.dot(p.user_id)}</span><span>${esc(p.display_name)}<small>${esc(Presence.text(p.user_id))}${p.extension ? ` · Ext. ${p.extension}` : ''}</small></span>${ic('phone')}</button>`).join('');
        el.querySelectorAll('#qcr [data-callp]').forEach((b) => b.onclick = () => Calls.start({ user: b.dataset.callp })); };
      qci.oninput = show;
      el.querySelector('#qcf').onsubmit = (e) => { e.preventDefault(); const t = findDial(qci.value) || (find()[0] ? { user: find()[0].user_id } : null); if (t) Calls.start(t); else { el.querySelector('#qcr').innerHTML = '<p class="muted small">No one by that name or extension.</p>'; } };
    }
    if (el.querySelector('#hdev') || el.querySelector('#vdesk')) fillDevices(el);
  }
  async function fillDevices(el) {
    const [my, devs] = await Promise.all([api.linkMyPhone(S.team.id).catch(() => null), api.devices(S.team.id).catch(() => [])]);
    const mine = (devs || []).filter((d) => d.user_id === S.user.id);
    const phones = (my && my.phones) || []; const ext = (my && my.extension) || extOf(S.user.id);
    const phoneHtml = phones.length ? phones.map((p) => `<div class="mi"><span class="lk-chic sm">${ic('desk')}</span><span>${esc(phoneLabel(p))}<small>${esc([p.vendor, p.model].filter(Boolean).join(' '))}${ext ? ` · Ext. ${esc(ext)}` : ''}</small></span><span class="lk-pill ${p.registered ? 'ok' : ''}">${p.registered ? 'Online' : 'Not connected'}</span></div>`).join('')
      : `<p class="muted">${ext ? `No desk phone on extension ${esc(ext)} yet.` : 'No extension or desk phone yet.'}</p>`;
    const pcHtml = mine.length ? mine.map((d) => `<div class="mi"><span class="lk-chic sm">${ic('monitor')}</span><span>${esc(d.device_name || 'A PC')}<small>${esc(d.platform || '')}${d.app_version ? ' · ' + esc(d.app_version) : ''} · seen ${esc(ago(d.last_seen))}</small></span></div>`).join('')
      : '<p class="muted">No PCs linked yet. Riyeser Central links a PC when you sign in on it.</p>';
    const h = el.querySelector('#hdev'); if (h) { h.innerHTML = `<div class="lk-mini">${phoneHtml}${mine.length ? `<div class="mi"><span class="lk-chic sm">${ic('monitor')}</span><span>${mine.length} PC${mine.length === 1 ? '' : 's'} linked<small>${esc(mine[0].device_name || '')}</small></span></div>` : ''}</div><button class="linkbtn" data-nav-go="devices">All my devices →</button>`;
      h.querySelector('[data-nav-go]').onclick = () => setNav('devices'); }
    const vd = el.querySelector('#vdesk'); if (vd) { vd.innerHTML = `<div class="lk-mini">${phoneHtml}</div><button class="btn" id="vmyph">${ic('desk')} Open My phone</button>`; vd.querySelector('#vmyph').onclick = () => myPhonePage('chat'); }
    const vp = el.querySelector('#vpcs'); if (vp) vp.innerHTML = `<div class="lk-mini">${pcHtml}<div class="mi"><span class="lk-chic sm">${ic('chat')}</span><span>This ${/Electron/.test(navigator.userAgent) ? 'Riyeser Link app' : 'browser'}<small>Signed in now</small></span><span class="lk-pill ok">Online</span></div></div>`;
  }

  // ---- conversation header
  function renderHead() {
    const el = document.getElementById('mhead'); if (!el) return;
    const c = S.ch;
    if (!c) { el.innerHTML = '<button class="back" aria-label="Back to chats">‹</button><div class="lk-ht"><h2>No chat open</h2></div>'; el.querySelector('.back').onclick = () => go('list'); return; }
    const o = otherIn(c); const count = c.kind === 'channel' ? S.people.length : c.people.length;
    el.innerHTML = `<button class="back" aria-label="Back to chats">${ic('back')}</button>${c.kind === 'dm' ? `<span class="lk-av">${av(o, chanLabel(c))}${Presence.dot(o)}</span>` : `<span class="lk-chic hd${c.kind === 'private' ? ' prv' : ''}" aria-hidden="true">${c.kind === 'private' ? ic('lock') : ic('hash')}</span>`}
      <div class="lk-ht">${c.kind === 'dm' ? `<h2>${esc(chanLabel(c))}</h2><small>${esc(Presence.text(o))}${extOf(o) ? ` · Ext. ${extOf(o)}` : ''}</small>`
        : `<h2>${c.kind === 'private' ? '🔒' : '#'} ${esc(c.name)}${c.archived ? ' <span class="lk-pill arch">Archived</span>' : ''}${muted(c.id) ? ` <span class="mutei" title="Muted">${ic('mute')}</span>` : ''}</h2><small>${c.kind === 'private' ? `Private · ${c.people.length} ${c.people.length === 1 ? 'person' : 'people'}${c.topic ? ' · ' : ''}` : ''}${esc(c.topic || '')}</small>`}</div>
      <div class="lk-hacts">
        <button class="lk-ib" id="vidbtn" aria-label="Video call" title="Video call">${ic('video')}</button>
        <button class="lk-ib" id="${c.kind === 'dm' ? 'calldm' : 'callch'}" aria-label="${c.kind === 'dm' ? `Call ${esc(chanLabel(c))}` : 'Call someone in this chat'}" title="Call">${ic('phone')}</button>
        <button class="lk-hb" id="ppl" aria-label="People in this chat: ${count}" title="People">${ic('users')}<span>${count}</span></button>
        <button class="lk-ib" id="infobtn" aria-label="Chat info" title="Info">${ic('info')}</button>
        <button class="lk-ib" id="morebtn" aria-haspopup="menu" aria-label="More: rename, members, mute, archive" title="More: rename, members, mute, archive">${ic('more')}</button>
        <button class="lk-ib lk-rtog${S.rightShut ? '' : ' on'}" id="rtog" aria-expanded="${!S.rightShut}" aria-label="${S.rightShut ? 'Show' : 'Hide'} the People and details panel" title="${S.rightShut ? 'Show' : 'Hide'} the People and details panel (Ctrl + ])">${ic('panelr')}</button></div>`;
    el.querySelector('.back').onclick = () => go('list');
    const pb = el.querySelector('#ppl'); pb.onclick = () => (c.kind === 'private' ? peopleOf() : showRight('people'));
    el.querySelector('#infobtn').onclick = () => showRight('info');
    const call = (video) => (c.kind === 'dm' ? Calls.start({ user: o, video }) : pickToCall(video));
    el.querySelector('#vidbtn').onclick = () => call(true); el.querySelector(c.kind === 'dm' ? '#calldm' : '#callch').onclick = () => call(false);
    el.querySelector('#morebtn').onclick = (e) => chanMenu(e.currentTarget, c);
    el.querySelector('#rtog').onclick = toggleRight;
    composerState();
    const t = document.getElementById('txt');
    if (t) t.placeholder = c.kind === 'dm' ? `Type a message to ${chanLabel(c)}…` : c.kind === 'private' ? `Type a message in 🔒 ${c.name}…` : `Type a message in #${c.name}…`;
  }
  function pickToCall(video) {
    if (!plus()) return upsell();
    const who = (S.ch.kind === 'private' ? S.ch.people : S.people.map((p) => p.user_id)).filter((u) => u !== S.user.id);
    modal(`<h3>${video ? 'Video call' : 'Call'} someone in ${esc(S.ch.kind === 'dm' ? chanLabel(S.ch) : '#' + S.ch.name)}</h3><p>Group calls are coming. For now, call one person.</p>
      <div class="lk-mini">${who.map((u) => `<button class="mi" data-cw="${u}"><span class="lk-av">${av(u, nameOf(u))}${Presence.dot(u)}</span><span>${esc(nameOf(u))}<small>${esc(Presence.text(u))}${extOf(u) ? ` · Ext. ${extOf(u)}` : ''}</small></span>${ic(video ? 'video' : 'phone')}</button>`).join('')}</div>
      <div class="mfoot"><button class="btn" id="cl">Cancel</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close; d.querySelectorAll('[data-cw]').forEach((b) => b.onclick = () => { close(); Calls.start({ user: b.dataset.cw, video }); });
    });
  }

  // ---- the channel menu (⋯ in the conversation header, and ⋯ / right-click on a chat in the list)
  // Everyone: Members, Mute, Pin, Mark as read, Leave. Whoever made it, or an owner or admin: Rename, Edit topic, Archive.
  // #general can't be archived, renamed or left. Archiving hides it for everyone, read-only; it can be brought back.
  const chTitle = (c) => (c.kind === 'dm' ? chanLabel(c) : `${c.kind === 'private' ? '🔒 ' : '#'}${c.name}`);
  function chanMenu(anchor, c, at = null) {
    const dm = c.kind === 'dm'; const gen = isGeneral(c); const arch = !!c.archived; const newDb = !S.cprefsOff;
    const man = canManage(c) && newDb; const pinned = S.pinned.includes(c.id); const mu = muted(c.id);
    const mi = (id, icon, label, sub = '', cls = '') => `<button class="mi${cls}" id="${id}" role="menuitem">${ic(icon)}<span>${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
    const nPeople = c.kind === 'private' ? c.people.length : S.people.length;
    const html = `<div class="mh">${esc(chTitle(c))}${arch ? ' · Archived' : ''}</div>
      ${man && !arch && !gen ? mi('mrename', 'edit', 'Rename') : ''}
      ${man && !arch ? mi('mtopic', 'note', 'Edit topic', c.topic ? esc(c.topic.slice(0, 60)) : 'Say what it\'s for') : ''}
      ${!dm ? mi('mmembers', 'users', 'Members', c.kind === 'private' ? `${nPeople} ${nPeople === 1 ? 'person' : 'people'} · ${canManage(c) ? 'add or remove people' : 'see who\'s in it'}` : 'Everyone in the team') : ''}
      ${newDb ? mi('mmute', 'mute', mu ? 'Unmute' : 'Mute', mu ? 'Count its unread messages again' : 'Its messages won\'t add to your unread count') : ''}
      ${!arch ? mi('mpin', 'pin', pinned ? 'Unpin this chat' : 'Pin this chat') : ''}
      ${S.unread[c.id] ? mi('mread', 'chat', 'Mark as read') : ''}
      ${!dm && !at ? mi('minfo', 'info', 'Channel info') : ''}
      ${!dm && !gen && (c.kind === 'private' || newDb) ? mi('mleave', 'leave', 'Leave', c.kind === 'private' ? 'Someone can add you back' : 'You can join again from Teams / Channels', ' warn') : ''}
      ${man && !gen && !arch ? mi('marchive', 'archive', 'Archive', 'Hides it for everyone; you can bring it back', ' warn') : ''}
      ${man && arch ? mi('munarchive', 'archive', 'Unarchive', 'Bring it back for everyone') : ''}
      ${gen && !dm ? '<p class="mnote">#general is for everyone, so it can\'t be archived or left.</p>'
        : !dm && newDb && !canManage(c) ? '<p class="mnote">Only whoever made it, or an owner or admin, can rename or archive it.</p>' : ''}`;
    popMenu(anchor, html, (d, close) => {
      const on = (id, fn) => { const b = d.querySelector(id); if (b) b.onclick = () => { close(); fn(); }; };
      // an owner/admin who isn't the channel's maker needs two-step sign-in first (the database checks this too)
      const mg = (fn) => () => (c.created_by !== S.user.id && needs2step() ? security() : fn());
      on('#mrename', mg(() => renameChan(c, 'name'))); on('#mtopic', mg(() => renameChan(c, 'topic')));
      on('#mmembers', () => (c.kind === 'private' ? peopleOf(c) : (S.ch && S.ch.id === c.id ? showRight('info') : openChannel(c.id).then(() => showRight('info')))));
      on('#mmute', () => muteChan(c)); on('#mpin', () => togglePin(c.id)); on('#minfo', () => showRight('info'));
      on('#mread', () => { api.markRead(c.id, S.user.id); S.unread[c.id] = 0; renderSide(); });
      on('#mleave', () => leaveChan(c)); on('#marchive', mg(() => archiveChan(c, true))); on('#munarchive', mg(() => archiveChan(c, false)));
    }, 'chmenu', at);
  }
  // After a change: keep the open chat's details fresh and redraw what shows them.
  function afterChanChange() {
    if (S.ch) S.ch = S.allChans.find((x) => x.id === S.ch.id) || S.ch;
    renderSide(); if (S.nav === 'chat') { renderHead(); renderMsgs(); } else renderMain();
  }
  const toGeneral = () => openChannel((S.chans.find(isGeneral) || S.chans.find((x) => x.kind !== 'dm') || S.chans[0] || {}).id, false);
  const cleanName = (v) => String(v || '').trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  function renameChan(c, what) {
    const nm = what === 'name';
    modal(`<h3>${nm ? `Rename ${esc(chTitle(c))}` : `Topic for ${esc(chTitle(c))}`}</h3><p>${nm ? 'Everyone sees the new name straight away. The messages stay as they are.' : 'A line under the name that says what this channel is for.'}</p>
      <form id="rnf">${nm ? `<label class="f"><span>New name</span><input name="v" id="rnv" maxlength="40" required autocomplete="off" value="${esc(c.name)}"></label>
        <p class="small muted" id="rnp" aria-live="polite"></p>`
        : `<label class="f"><span>Topic (optional)</span><input name="v" id="rnv" maxlength="200" autocomplete="off" value="${esc(c.topic || '')}" placeholder="e.g. Jobs, bookings and what's on today"></label>`}
      <p class="ferr" id="rne" role="alert" hidden></p>
      <div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p" id="rngo">${nm ? 'Rename' : 'Save'}</button></div></form>`, (d, close) => {
      const v = d.querySelector('#rnv'); const err = d.querySelector('#rne'); const pv = d.querySelector('#rnp');
      d.querySelector('#cl').onclick = close; v.focus(); v.select();
      const show = () => { if (pv) { const n = cleanName(v.value); pv.textContent = n ? `It will show as ${c.kind === 'private' ? '🔒 ' : '#'}${n}` : 'Type a name: letters, numbers, - or _.'; } };
      v.oninput = () => { err.hidden = true; show(); }; show();
      d.querySelector('#rnf').onsubmit = async (e) => {
        e.preventDefault(); const val = nm ? cleanName(v.value) : v.value.trim();
        if (nm && !val) { err.textContent = 'Type a name: letters, numbers, - or _.'; err.hidden = false; return; }
        if (nm ? val === c.name : val === (c.topic || '')) { close(); return; }
        d.querySelector('#rngo').disabled = true;
        try {
          await api.renameChannel(c.id, nm ? val : null, nm ? null : val); await loadChans(); close(); afterChanChange();
          tell(nm ? `Renamed to ${c.kind === 'private' ? '🔒 ' : '#'}${val}.` : 'Topic saved.', 'ok');
        } catch (x) { err.textContent = plainError(x); err.hidden = false; d.querySelector('#rngo').disabled = false; }
      };
    });
  }
  async function archiveChan(c, on) {
    if (on && !(await ask(`Archive ${chTitle(c)}? This hides it for everyone; you can bring it back. The messages are kept, but no one can post in it while it's archived.`, { yes: 'Archive', title: 'Archive this channel?' }))) return;
    try {
      await api.archiveChannel(c.id, on); await loadChans();
      if (on) { S.pinned = S.pinned.filter((x) => x !== c.id); if (S.ch && S.ch.id === c.id) await toGeneral(); else afterChanChange(); tell(`${chTitle(c)} is archived. It's under Archived at the bottom of your chats if you need it again.`, 'ok'); }
      else { await openChannel(c.id); tell(`${chTitle(c)} is back for everyone.`, 'ok'); }
    } catch (err) { tell(plainError(err)); }
  }
  async function muteChan(c) {
    const on = !muted(c.id); const was = S.cprefs[c.id];
    S.cprefs[c.id] = { ...(was || {}), muted: on }; afterChanChange(); chatTitle();
    try { await api.muteChannel(c.id, on); tell(on ? `${chTitle(c)} is muted. Its messages won't add to your unread count.` : `${chTitle(c)} is unmuted.`, 'ok'); }
    catch (err) { if (was) S.cprefs[c.id] = was; else delete S.cprefs[c.id]; afterChanChange(); tell(plainError(err)); }
  }
  async function leaveChan(c, closeBox) {
    const priv = c.kind === 'private';
    if (!(await ask(priv ? `Leave ${c.name}? You won't see it again unless someone adds you back.` : `Leave #${c.name}? It goes from your list. You can join again from Teams / Channels.`, { yes: 'Leave', title: 'Leave this channel?' }))) return;
    try {
      if (S.cprefsOff) await api.leave(c.id, S.user.id); else await api.leaveChannel(c.id);
      await loadPrefs(); await loadChans(); if (closeBox) closeBox();
      if (S.ch && S.ch.id === c.id) await toGeneral(); else afterChanChange();
      tell(priv ? `You left ${c.name}.` : `You left #${c.name}. Join again any time from Teams / Channels.`, 'ok');
    } catch (err) { tell(plainError(err)); }
  }
  async function rejoinChan(id) {
    try { await api.rejoinChannel(id); await loadPrefs(); await loadChans(); openChannel(id); } catch (err) { tell(plainError(err)); }
  }
  // An archived channel is read-only: the box to type in is swapped for a note (and Unarchive, for whoever may).
  function composerState() {
    const f = document.getElementById('comp'); if (!f) return;
    const c = S.ch; const ro = !!(c && c.archived); f.hidden = ro;
    let bar = document.getElementById('archbar');
    if (!ro) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'archbar'; bar.className = 'lk-archbar'; bar.setAttribute('role', 'status'); f.before(bar); }
    const man = canManage(c) && !S.cprefsOff;
    bar.innerHTML = `${ic('archive')}<span><b>This channel is archived.</b> It's read-only: the messages are kept, but no one can post here.${man ? '' : ' Whoever made it, or an owner or admin, can bring it back.'}</span>${man ? '<button class="btn sm p" id="unarch">Unarchive</button>' : ''}`;
    const u = bar.querySelector('#unarch'); if (u) u.onclick = () => (c.created_by !== S.user.id && needs2step() ? security() : archiveChan(c, false));
  }

  // ---- right panel: People (n) / Info, and Quick dial
  function showRight(tab) { S.rightTab = tab; if (S.rightShut) { S.rightShut = false; UI.set('rightShut', false); renderHead(); } renderRight(); if (narrow() || matchMedia('(max-width: 1180px)').matches) go('right'); else paneClasses(); }
  function renderRight() {
    const el = document.getElementById('lkright'); if (!el) return;
    const tab = S.rightTab || 'people'; const q = (S.pq || '').toLowerCase();
    const list = [...S.people].sort((a, b) => (b.user_id === S.user.id) - (a.user_id === S.user.id) || (Number(a.extension) || 9999) - (Number(b.extension) || 9999))
      .filter((p) => !q || p.display_name.toLowerCase().includes(q) || String(p.extension || '').startsWith(q));
    let body = '';
    if (tab === 'people') {
      body = `<div class="lk-psearch">${ic('search')}<input id="psearch" placeholder="Search people…" aria-label="Search people" value="${esc(S.pq || '')}"></div>
        <div class="lk-people" id="plist">${list.map((p) => personRow(p)).join('') || '<p class="lk-none">No one matches.</p>'}</div>
        <section class="lk-qd${S.qdShut ? ' shut' : ''}" id="qd"><button class="lk-qdh" id="qdh" aria-expanded="${!S.qdShut}">${ic('grid')}<span>Quick Dial</span>${ic('down')}</button><div class="lk-qdb">${dialHtml('qd')}</div></section>`;
    } else {
      const c = S.ch;
      if (!c) body = '<p class="lk-none">Open a chat to see its details.</p>';
      else {
        const o = otherIn(c); const files = S.msgs.filter((m) => m.files && m.files.length && !m.deleted).flatMap((m) => m.files.map((f, i) => ({ ...f, m: m.id, i }))).slice(-8).reverse();
        const ppl = c.kind === 'channel' ? S.people.map((p) => p.user_id) : c.people;
        body = `<div class="lk-info">${c.kind === 'dm' ? `<div class="lk-icard"><span class="lk-av big">${av(o, nameOf(o), 'big')}${Presence.dot(o)}</span><b>${esc(nameOf(o))}</b><small>${esc(Presence.text(o))}${extOf(o) ? ` · Ext. ${extOf(o)}` : ''}</small>
            ${plus() ? `<div class="row2"><button class="btn sm" data-callp="${o}">${ic('phone')} Call</button><button class="btn sm" data-vidp="${o}">${ic('video')} Video</button></div>` : ''}</div>`
          : `<div class="lk-icard"><span class="lk-chic big">${c.kind === 'private' ? ic('lock') : ic('hash')}</span><b>${esc(c.name)}</b><small>${esc(c.topic || (c.kind === 'private' ? 'Private chat' : 'Everyone in the team'))}</small></div>`}
          <button class="btn w" id="ipin">${ic('pin')} ${S.pinned.includes(c.id) ? 'Unpin this chat' : 'Pin this chat'}</button>
          ${c.kind !== 'dm' ? `<h4>${c.kind === 'private' ? 'Who\'s in it' : 'Members'} · ${ppl.length}</h4><div class="lk-people">${ppl.map((u) => personOf(u)).filter(Boolean).map((p) => personRow(p)).join('')}</div>${c.kind === 'private' ? '<button class="btn sm" id="ippl">Change who\'s in it</button>' : ''}` : ''}
          <h4>Files</h4>${files.length ? `<div class="lk-mini">${files.map((f) => `<button class="mi" data-ifile="${f.m}:${f.i}"><span class="lk-chic sm">${ic('file')}</span><span>${esc(f.name)}<small>${esc(sizeText(Number(f.size) || 0))}</small></span>${ic('dl')}</button>`).join('')}</div>` : '<p class="muted small">Files shared here show up here.</p>'}</div>`;
      }
    }
    if (tab === 'info' && isAdmin() && S.storeInfo) body += filesUse(S.storeInfo);
    el.innerHTML = `<div class="lk-rhead"><button class="back" aria-label="Back">${ic('back')}</button><div class="lk-tabs" role="tablist"><button role="tab" data-rt="people" aria-selected="${tab === 'people'}" class="${tab === 'people' ? 'on' : ''}">People (${S.people.length})</button><button role="tab" data-rt="info" aria-selected="${tab === 'info'}" class="${tab === 'info' ? 'on' : ''}">Info</button></div>
      <button class="lk-ib lk-rclose" id="rclose" aria-label="Close the panel" title="Close">${ic('x')}</button></div><div class="lk-rbody">${body}</div>`;
    el.querySelector('.back').onclick = () => go(S.ch ? 'main' : 'list');
    el.querySelector('#rclose').onclick = () => { if (wideRight()) { S.rightShut = true; UI.set('rightShut', true); } if (S.pane === 'right') S.pane = 'main'; paneClasses(); renderHead(); };
    el.querySelectorAll('[data-rt]').forEach((b) => b.onclick = () => { S.rightTab = b.dataset.rt; renderRight(); });
    el.querySelectorAll('[data-callp]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); Calls.start({ user: b.dataset.callp }); });
    el.querySelectorAll('[data-vidp]').forEach((b) => b.onclick = () => Calls.start({ user: b.dataset.vidp, video: true }));
    el.querySelectorAll('.lk-person[data-person]').forEach((r) => { if (r.dataset.person !== S.user.id) { r.tabIndex = 0; r.setAttribute('role', 'button'); r.setAttribute('aria-label', `Message ${nameOf(r.dataset.person)}`);
      r.onclick = () => openDm(r.dataset.person); r.onkeydown = (e) => { if (e.key === 'Enter') openDm(r.dataset.person); }; } });
    const ps = el.querySelector('#psearch'); if (ps) ps.oninput = () => { S.pq = ps.value; const pos = ps.selectionStart; renderRight(); const n = document.getElementById('psearch'); n.focus(); n.setSelectionRange(pos, pos); };
    const qh = el.querySelector('#qdh'); if (qh) qh.onclick = () => { S.qdShut = !S.qdShut; renderRight(); };
    const ip = el.querySelector('#ipin'); if (ip) ip.onclick = () => togglePin(S.ch.id);
    const ipp = el.querySelector('#ippl'); if (ipp) ipp.onclick = peopleOf;
    el.querySelectorAll('[data-ifile]').forEach((b) => b.onclick = () => { const [mid, i] = b.dataset.ifile.split(':'); const m = S.msgs.find((x) => String(x.id) === mid); if (m) download(m.files[Number(i)]); });
    wireDial(el, 'qd');
    if (tab === 'info' && isAdmin() && S.storeInfo === undefined) { S.storeInfo = null; api.storage(S.team.id).then((x) => { S.storeInfo = x || false; if (S.rightTab === 'info') renderRight(); }).catch(() => { S.storeInfo = false; }); }
  }
  // Admins: how much file storage the business uses, in the Info panel. No prices here.
  function filesUse(st) {
    if (!st || st.limit == null) return '';
    const warn = Number(st.pct) >= 80;
    return `<div class="lk-files-use${warn ? ' warn' : ''}" id="ifiles"><b>Files: ${usedText(Number(st.used) || 0)} of ${gbText(Number(st.limit))}</b>
      <div class="sbar"><i style="width:${Math.min(100, Number(st.pct) || 0)}%"></i></div>${warn ? `<small>${esc(NEAR_FULL)}</small>` : ''}</div>`;
  }
  // the keypad (Quick dial in the right panel, and the Calls view)
  function dialHtml(p) {
    const sub = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };
    return `<input class="lk-dn" id="${p}n" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Extension" aria-label="Extension to call" value="${esc(S.dial[p] || '')}">
      <div class="lk-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '*', 0, '#'].map((k) => `<button type="button" data-${p}k="${k}">${k}<small>${sub[k] || ''}</small></button>`).join('')}</div>
      <div class="lk-dw" id="${p}w" aria-live="polite"></div>
      <div class="lk-dcall"><button type="button" class="lk-green" id="${p}call" aria-label="Call">${ic('phone')}</button><button type="button" class="lk-vbtn" id="${p}vid" aria-label="Video call">${ic('video')}</button></div>`;
  }
  function findDial(v) {
    const x = Number(String(v).trim()); if (!x) return null;
    const p = S.people.find((q) => q.extension === x && q.user_id !== S.user.id); if (p) return { user: p.user_id, label: p.display_name };
    const b = S.branches.find((q) => q.extension === x); return b ? { branch: b.id, label: b.name + ' (everyone)' } : null;
  }
  function wireDial(root, p) {
    const n = root.querySelector(`#${p}n`); if (!n) return; const w = root.querySelector(`#${p}w`);
    const show = () => { S.dial[p] = n.value; const t = findDial(n.value); w.textContent = n.value ? (t ? `${t.label}${t.user ? ' · ' + Presence.text(t.user) : ''}` : 'No one on that number') : ''; };
    if (n.value) show();
    n.oninput = () => { n.value = n.value.replace(/[^0-9*#]/g, '').slice(0, 4); show(); };
    root.querySelectorAll(`[data-${p}k]`).forEach((k) => k.onclick = () => { n.value = (n.value + k.getAttribute(`data-${p}k`)).slice(0, 4); show(); });
    n.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); root.querySelector(`#${p}call`).click(); } if (e.key === 'Backspace' && !n.value) e.preventDefault(); };
    const go2 = (video) => { const t = findDial(n.value); if (!t) { show(); n.focus(); return; } if (video && !t.user) { w.textContent = 'Video calls are for one person at a time.'; return; } Calls.start({ ...t, video }); n.value = ''; show(); };
    root.querySelector(`#${p}call`).onclick = () => go2(false); root.querySelector(`#${p}vid`).onclick = () => go2(true);
  }

  function renderMsgs(toBottom) {
    const el = document.getElementById('msgs'); if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    el.innerHTML = msgsHtml();
    if (toBottom || near) el.scrollTop = el.scrollHeight;
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation(); const id = b.closest('.msg').dataset.id;
      if (b.dataset.act === 'react') return popMenu(b, `<div class="rxpick">${REACTIONS.map((x) => `<button class="mi" data-rxp="${x}" aria-label="React ${x}">${x}</button>`).join('')}</div>`,
        (d, close) => d.querySelectorAll('[data-rxp]').forEach((x) => x.onclick = () => { close(); react(id, x.dataset.rxp); }), 'rxmenu');
      if (b.dataset.act === 'del') { if (!(await ask('Delete this message?', { yes: 'Delete', danger: true }))) return; await api.remove(id); const m = S.msgs.find((x) => x.id === id); if (m) { m.deleted = true; } renderMsgs(); }
      else { S.editing = id; renderMsgs(); const ta = el.querySelector(`[data-edit="${id}"] textarea`); ta && ta.focus(); }
    });
    el.querySelectorAll('[data-rx]').forEach((b) => b.onclick = () => react(b.closest('.msg').dataset.id, b.dataset.rx));
    el.querySelectorAll('[data-file]').forEach((b) => b.onclick = () => { const m = S.msgs.find((x) => String(x.id) === b.closest('.msg').dataset.id); if (m) download(m.files[Number(b.dataset.file)]); });
    el.querySelectorAll('.msg').forEach((m) => m.addEventListener('click', (e) => { if (matchMedia('(hover: none)').matches && !e.target.closest('button, a, form')) { el.querySelectorAll('.msg.sel').forEach((x) => x !== m && x.classList.remove('sel')); m.classList.toggle('sel'); } }));
    el.querySelectorAll('[data-edit]').forEach((f) => {
      const ta = f.querySelector('textarea');
      const save = async () => { const v = ta.value.trim(); const m = S.msgs.find((x) => x.id === f.dataset.edit);
        if (v && m && v !== m.body) { await api.edit(m.id, v); m.body = v; m.edited_at = new Date().toISOString(); } S.editing = null; renderMsgs(); };
      f.onsubmit = (e) => { e.preventDefault(); save(); };
      ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { S.editing = null; renderMsgs(); } };
    });
  }
  async function download(f) {
    if (!f) return;
    try { const url = await api.fileUrl(f.path, f.name); const a = document.createElement('a'); a.href = url; a.download = f.name; a.rel = 'noopener'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); }
    catch (err) { tell('That file couldn\'t be opened: ' + plainError(err)); }
  }
  const safeName = (n) => (String(n || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(-100) || 'file');
  function wireComposer() {
    const f = document.getElementById('comp'); const t = document.getElementById('txt'); const b = document.getElementById('send');
    const grow = () => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; b.disabled = !t.value.trim() || !S.ch; };
    t.oninput = grow;
    t.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); f.requestSubmit(); } };
    f.onsubmit = async (e) => {
      e.preventDefault(); const body = t.value.trim(); if (!body || !S.ch) return;
      t.value = ''; grow();
      try { const m = await api.send(S.team.id, S.ch.id, body); if (!S.msgs.find((x) => x.id === m.id)) S.msgs.push(m); S.last[S.ch.id] = m; renderMsgs(true); renderList(); }
      catch (err) { t.value = body; grow(); tell('That message didn\'t send: ' + plainError(err)); }
    };
    document.getElementById('emo').onclick = (e) => popMenu(e.currentTarget, `<div class="emopick">${EMOJI.map((x) => `<button class="mi" data-em="${x}" aria-label="${x}">${x}</button>`).join('')}</div>`, (d, close) => {
      d.querySelectorAll('[data-em]').forEach((x) => x.onclick = () => { const s0 = t.selectionStart ?? t.value.length; t.value = t.value.slice(0, s0) + x.dataset.em + t.value.slice(t.selectionEnd ?? s0); close(); grow(); t.focus(); t.setSelectionRange(s0 + x.dataset.em.length, s0 + x.dataset.em.length); });
    }, 'emomenu');
    const fi = document.getElementById('file');
    document.getElementById('attach').onclick = () => { if (!S.ch) return; fi.value = ''; fi.click(); };
    fi.onchange = () => sendFiles([...fi.files]);
    // drop files onto the conversation
    const main = document.getElementById('main');
    main.ondragover = (e) => { if (S.ch && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); main.classList.add('drop'); } };
    main.ondragleave = () => main.classList.remove('drop');
    main.ondrop = (e) => { main.classList.remove('drop'); if (S.ch && e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); sendFiles([...e.dataTransfer.files]); } };
    if (matchMedia('(min-width: 761px)').matches) t.focus();
  }
  async function sendFiles(list) {
    if (!list.length || !S.ch) return;
    if (list.length > 10) return tell('Send up to 10 files at a time.');
    const big = list.find((x) => x.size > MAX_FILE); if (big) return tell(`${big.name} is over 25 MB. Send a smaller file, or share a link to it instead.`);
    const empty = list.find((x) => !x.size); if (empty) return tell(`${empty.name} is empty.`);
    const box = document.getElementById('upl'); const t = document.getElementById('txt'); const ch = S.ch;
    const total = list.reduce((a, x) => a + x.size, 0);
    const plusOn = !!(S.features && S.features.calls);
    if ((await api.storageFits(S.team.id, total).catch(() => null)) === false) return tell(STORE_FULL(plusOn));
    box.hidden = false; const done = [];
    try {
      for (const x of list) {
        box.innerHTML = `<span class="spin sm"></span> Uploading ${esc(x.name)} (${esc(sizeText(x.size))})…`;
        done.push(await api.upload(S.team.id, ch.id, x, safeName(x.name)));
      }
      const files = done.map((d) => ({ path: d.path, name: d.name, size: d.size, type: d.type }));
      const text = t.value.trim(); const body = text || autoBody(files);
      const m = await api.send(S.team.id, ch.id, body, files); if (text) { t.value = ''; t.oninput(); }
      if (S.ch && S.ch.id === ch.id && !S.msgs.find((y) => y.id === m.id)) S.msgs.push(m); S.last[ch.id] = m; renderMsgs(true); renderList();
      if (isAdmin() && !S.storeWarned) {   // owners and admins: a heads-up once storage passes 80%
        const st = await api.storage(S.team.id).catch(() => null);
        if (st && Number(st.pct) >= 80) { S.storeWarned = true; S.storeInfo = st;
          tell(isOwner() ? `Your business has used ${usedText(Number(st.used))} of its ${gbText(Number(st.limit))} of ${STORE_WHAT} (${Math.round(Number(st.pct))}%). ${STORE_MORE(!!st.plus)}` : NEAR_FULL, 'warn'); }
      }
    } catch (err) {
      const msg = plainError(err);
      if (/row-level|policy|403|Unauthorized/i.test(msg) && (await api.storageFits(S.team.id, total).catch(() => null)) === false) return tell(STORE_FULL(plusOn));
      tell(/bucket|not found|row-level|policy|files/i.test(msg) ? 'Files can\'t be sent here yet. Ask your business\'s owner to finish the Riyeser Link update.' : 'That file didn\'t send: ' + msg);
    } finally { box.hidden = true; box.innerHTML = ''; }
  }

  // ---- New chat: message one person, a few people (a private chat), or make a channel
  function newChat() {
    const others = S.people.filter((p) => p.user_id !== S.user.id);
    modal(`<h3>New chat</h3><p>Choose one person for a direct message, or a few for a private group chat.</p>
      <input class="lk-find" id="ncq" placeholder="Search people…" aria-label="Search people" autocomplete="off">
      <form id="ncf"><div class="pick" id="ncl">${others.map((p) => `<label class="pk" data-n="${esc(p.display_name.toLowerCase())}"><input type="checkbox" name="p" value="${p.user_id}"><span class="lk-av">${av(p.user_id, p.display_name)}${Presence.dot(p.user_id)}</span><span>${esc(p.display_name)}<small class="lk-pst">${esc(Presence.text(p.user_id))}</small></span>${p.extension ? `<small>Ext. ${p.extension}</small>` : ''}</label>`).join('') || '<p class="muted" style="padding:8px">Invite your team first.</p>'}</div>
      <label class="f" id="ncname" hidden><span>Name for the group chat</span><input name="name" maxlength="40" placeholder="e.g. hill-rd-site"></label>
      <div class="mfoot"><button type="button" class="btn" id="ncch" style="margin-right:auto">${ic('hash')} New channel instead</button><button type="button" class="btn" id="cl">Cancel</button><button class="btn p" id="ncgo" disabled>Start chat</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close; d.querySelector('#ncch').onclick = () => { close(); addChannel(); };
      const q = d.querySelector('#ncq'); q.focus();
      q.oninput = () => { const v = q.value.trim().toLowerCase(); d.querySelectorAll('#ncl .pk').forEach((x) => { x.hidden = !!v && !x.dataset.n.includes(v); }); };
      const upd = () => { const n = ticked(d).length; d.querySelector('#ncgo').disabled = !n; d.querySelector('#ncname').hidden = n < 2; d.querySelector('#ncgo').textContent = n > 1 ? `Start group chat (${n + 1})` : 'Start chat'; };
      d.querySelectorAll('input[name=p]').forEach((x) => x.onchange = upd);
      d.querySelector('#ncf').onsubmit = async (e) => {
        e.preventDefault(); const who = ticked(d); if (!who.length) return;
        try {
          if (who.length === 1) { close(); return openDm(who[0]); }
          const raw = String(new FormData(e.target).get('name') || '').trim() || who.map((u) => nameOf(u).split(' ')[0]).join('-');
          const name = raw.toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'group-chat';
          const id = await api.createPrivate(S.team.id, name, '', who); await loadChans(); close(); openChannel(id);
        } catch (err) { tell(plainError(err)); }
      };
    });
  }

  // Plan & billing (the owner only): Riyeser home's plan section, with the file storage bar. Later: My Riyeser's Billing.
  async function planBilling() {
    if (!isOwner()) return;
    S.home = true; await renderHome();
    const x = document.getElementById('hbill') || document.getElementById('hplanv'); if (x) x.scrollIntoView({ block: 'start' });
  }

  function modal(html, wire) {
    const d = document.createElement('div'); d.className = 'modal'; d.innerHTML = `<div class="mcard" role="dialog" aria-modal="true">${html}</div>`;
    d.onclick = (e) => { if (e.target === d) d.remove(); };
    document.body.appendChild(d); wire(d, () => d.remove());
  }
  function invite() {
    const link = () => `${location.origin}/link/?join=${S.team.company_code || S.team.invite_code}`;
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
        if (!(await ask('Make a new code? The old invite link will stop working.'))) return;
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
          await loadChans(); close(); openChannel(id);
        } catch (err) { tell(plainError(err)); }
      };
    });
  }

  // Who's in a private chat. Whoever made it, or a team owner/admin, can change it; anyone in it can leave.
  function peopleOf(c = S.ch) {
    if (!c || c.kind !== 'private') return;
    const manage = c.created_by === S.user.id || S.team.role === 'owner' || S.team.role === 'admin';
    modal(`<h3>🔒 ${esc(c.name)}</h3><p>${manage ? 'Tick who should be in this private chat. Only they can see it.' : 'Only these people can see this private chat.'}</p>
      ${manage ? tickList(c.people) : `<div class="pick">${c.people.map((u) => `<div class="pk">${av(u, nameOf(u))}<span>${esc(nameOf(u))}${u === S.user.id ? ' (you)' : ''}</span></div>`).join('')}</div>`}
      <div class="mfoot"><button class="btn" id="lv" style="margin-right:auto;color:#b91c1c">Leave this chat</button><button class="btn" id="cl">${manage ? 'Cancel' : 'Done'}</button>${manage ? '<button class="btn p" id="sv">Save</button>' : ''}</div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelector('#lv').onclick = () => leaveChan(c, close);
      const sv = d.querySelector('#sv'); if (sv) sv.onclick = async () => {
        const now = ticked(d); if (!now.length) { tell('Keep at least one person in the chat.'); return; }
        const add = now.filter((u) => !c.people.includes(u)); const remove = c.people.filter((u) => !now.includes(u));
        try { await api.setPeople(c.id, add, remove); await loadChans(); close();
          const open = S.ch && S.ch.id === c.id; const still = S.allChans.find((x) => x.id === c.id);
          if (open && !still) toGeneral(); else afterChanChange(); }
        catch (err) { tell(plainError(err)); }
      };
    });
  }


  // ================================================================== Riyeser Link Plus (premium)
  // Calls go directly between the two devices (WebRTC). The online service only carries the ringing and set-up.
  // Calling a branch rings everyone in it; the first to answer takes the call. 30 seconds with no answer is a missed call.
  function upsell() {
    modal(`<h3>⭐ Riyeser Link Plus</h3><p>Calls between your people and branches, on the PC and phone: ring a person or a whole branch, answer on any device you're signed in on, with no call charges.</p>
      ${isOwner() ? `<p><b>${usd(PRICE_LINK_PLUS)} a month per business</b> (3 users included, then ${usd(PRICE_EXTRA_USER)} a month each), free for your first 90 days. It also gives your business ${STORAGE_GB.plus} GB of ${STORE_WHAT}. Your trial has ended, so calls are paused. Chat keeps working as normal.</p>` : `<p>Your business's free trial of calls has ended, so calls are paused. Chat keeps working as normal. Ask the owner about Riyeser Link Plus.</p>`}
      <div class="mfoot"><button class="btn" id="cl">Not now</button>${isOwner() ? '<a class="btn p" href="/pricing.html" target="_blank" rel="noopener">See pricing</a>' : ''}</div>`, (d, close) => { d.querySelector('#cl').onclick = close; });
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
      const run = async (fn) => { try { await fn(); } catch (err) { tell(plainError(err)); } await refresh(); };
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('[data-save]').forEach((b) => b.onclick = () => run(async () => {
        const br = S.branches.find((x) => x.id === b.dataset.save);
        const now = [...d.querySelectorAll(`input[data-br="${br.id}"]:checked`)].map((x) => x.value);
        await api.setBranchPeople(br.id, now.filter((u) => !br.people.includes(u)), br.people.filter((u) => !now.includes(u))); }));
      d.querySelectorAll('[data-code]').forEach((b) => b.onclick = async () => { if (await ask('Make a new join code for this branch? The old one stops working.', { yes: 'Make a new code' })) run(() => api.newBranchCode(b.dataset.code)); });
      d.querySelector('#nb').onsubmit = (e) => { e.preventDefault(); const nm = String(new FormData(e.target).get('name')).trim(); if (nm) run(() => api.createBranch(S.team.id, nm)); };
      d.querySelector('#sx').onclick = () => run(async () => {
        for (const i of d.querySelectorAll('[data-ext]')) {
          const p = S.people.find((x) => x.user_id === i.dataset.ext); const v = i.value ? Number(i.value) : null;
          if ((p.extension || null) !== v) await api.setExtension(S.team.id, p.user_id, v);
        } });
    });
  }

  // ------------------------------------------------------------------ Phones: Riyeser Link Office (desk phones) for owners and admins
  // What Riyeser Link Office (the phone system on an office PC) last reported: the address to type into phones, the
  // extensions and the desk phones, with changes sent to it (it checks every 30 seconds while the PC is on).
  // SIP passwords stay on the office PC. "Show" makes a one-off key in this browser tab; the office PC sends the
  // password encrypted to it, so only this tab can read it. It's taken once, within 5 minutes, and is in the history.
  const PH = {
    TITLE: 'Desk phones',
    UPSELL_TEAM: 'Desk phones and calls come with <b>Riyeser Link Plus</b>. Ask the owner about adding it.',
    UPSELL: `Desk phones and calls come with <b>Riyeser Link Plus</b>. It's free for your first 90 days, then ${usd(PRICE_LINK_PLUS)} a month per business (3 users included), with no call charges. To add it to your plan, contact Riyeser.`,
    GUIDE: ['Install <b>Riyeser Link Office</b> on a PC at the office that stays on (<b>Riyeser Central → Get more apps</b>).', 'Sign in with your Riyeser account.', 'Plug in desk phones.'],
    SENDING: 'Sending to Riyeser Link Office…', DONE: 'Done', SLOW: 'Riyeser Link Office hasn\'t picked this up yet. It checks every 30 seconds while the office PC is on and connected to the internet.',
    HELP: [['🔌 Power', 'Many desk phones don\'t come with a power adapter and expect power over the network cable (PoE). Buy the phone\'s power adapter, or a small PoE switch.'],
      ['🏢 Same office network', 'Desk phones must be plugged into the same office network as the Riyeser Link Office PC. A phone at home or in another building can\'t reach it yet.'],
      ['🚫 No emergency calls', 'These phones can only call each other. Keep a mobile or normal phone line for emergency calls (000, 111, 112, 911).'],
      ['📶 Wi-Fi phones', 'Wi-Fi desk phones work too, once they\'re joined to the office Wi-Fi.']],
  };
  const OFFLINE_AFTER = 12 * 60000;   // a heartbeat every 5 minutes, a check for changes every 30 seconds
  const prettyMac = (m) => String(m || '').toUpperCase().match(/../g)?.join(':') || '';
  const timeShort = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
  function officeState(o, now) {
    const fresh = now - new Date(o.last_seen) < OFFLINE_AFTER;
    if (!fresh) return ['Offline', 'bad', `Last heard from ${ago(o.last_seen)}. Is the office PC on and connected to the internet?`];
    if (o.state === 'running') return ['Running', 'ok', ''];
    if (o.state === 'waiting-licence' || o.state === 'stopping') return ['Waiting for Riyeser Link Plus', 'warn', 'Riyeser Link Office is installed but not switched on, because Riyeser Link Plus isn\'t active.'];
    if (o.state === 'error') return ['Not running', 'bad', 'Riyeser Link Office couldn\'t start. Open it on the office PC to see why.'];
    return ['Starting', '', ''];
  }
  // A one-off key pair for one "Show": the private half never leaves this tab and can't be exported.
  async function oneOffKey() {
    if (!(window.crypto && crypto.subtle)) throw new Error('This browser can\'t show passwords safely. Try Chrome, Edge or Safari.');
    const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
    const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
    return { kp, jwk: { kty: 'RSA', n: j.n, e: j.e } };
  }
  async function openSealed(kp, b64) {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, buf));
  }
  // Send one change and follow it: "Sending to Riyeser Link Office…", then "Done" or the reason it didn't work.
  async function sendCmd(kind, data, show, { wantReveal = false, sending = PH.SENDING } = {}) {
    const say = (html, cls = '') => { if (show) show(html, cls); };
    if (needs2step()) { security(); return null; }
    const o = S.lo && S.lo.office; if (!o) return null;
    say(`<span class="spin sm"></span> ${esc(sending)}`);
    let id;
    try { id = await api.linkCommand(S.team.id, o.office_id, kind, data); } catch (err) { say(esc(plainError(err)), 'bad'); return null; }
    return followCmd(id, show, { wantReveal });
  }
  // Follow a change already sent (by an admin, or by a member for their own extension) until it's done or failed.
  async function followCmd(id, show, { wantReveal = false, page = 'phonesPage' } = {}) {
    const say = (html, cls = '') => { if (show) show(html, cls); };
    const start = Date.now(); let slow = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, Date.now() - start < 20000 ? 1500 : 4000));
      let st; try { st = await api.linkCommandState(id); } catch (err) { say(esc(plainError(err)), 'bad'); return null; }
      if (st.status === 'done' && wantReveal) { if (st.ready) return { id, st }; say('Riyeser Link Office didn\'t send the password back. Press Show again.', 'bad'); return null; }
      if (st.status === 'done') { say(PH.DONE, 'ok'); if (page === 'phonesPage') setTimeout(() => refreshPhones(), 600); return { id, st }; }
      if (st.status === 'failed') { say(esc(st.error || 'That didn\'t work.'), 'bad'); return null; }
      if (!slow && Date.now() - start > 45000) { slow = true; say(`<span class="spin sm"></span> ${esc(PH.SLOW)}`, 'warn'); }
      if (Date.now() - start > (wantReveal ? 5 * 60000 : 10 * 60000)) return null;
      if (!document.body.contains(document.getElementById(page))) return null;
    }
  }
  function phMsg(html, cls = '') {
    let el = document.getElementById('phmsg');
    if (!el) { el = document.createElement('div'); el.id = 'phmsg'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.className = `phmsg ${cls}`; el.innerHTML = html; el.hidden = false;
    clearTimeout(phMsg.t); if (cls === 'ok' || cls === 'bad' || cls === 'warn') phMsg.t = setTimeout(() => { el.hidden = true; }, cls === 'ok' ? 3500 : 9000);
  }

  async function refreshPhones() {
    if (!document.getElementById('phonesPage')) return;
    try { S.lo.status = await api.linkStatus(S.team.id); } catch { /* keep what we have */ }
    drawPhones();
  }
  async function phonesPage(back) {
    S.phonesBack = back || S.phonesBack || (S.home ? 'home' : 'chat'); S.view = 'phones';
    S.lo = { status: undefined, office: null, pick: S.lo && S.lo.pick };
    if (!S.homeLic || S.homeLicFor !== S.team.id) { S.homeLicFor = S.team.id; S.homeLic = isAdmin() ? await api.licence(S.team.id).catch(() => null) : null; }
    try { S.lo.status = await api.linkStatus(S.team.id); } catch (err) { S.lo.error = plainError(err); }
    drawPhones();
    clearInterval(S.loTimer); S.loTimer = setInterval(() => { if (!document.getElementById('phonesPage')) clearInterval(S.loTimer); else if (!document.hidden && !document.querySelector('.modal')) refreshPhones(); }, 20000);
  }
  function drawPhones() {
    const t = S.team; const st = S.lo.status; const now = st && st.now ? Date.parse(st.now) : Date.now();   // the database's clock, not this device's
    const lic = S.homeLic && S.homeLic.modules ? S.homeLic.modules.calls : null;
    const plus = (lic && lic.active) || (st && st.calls) || (!lic && S.features && S.features.calls);
    const offices = (st && st.offices) || [];
    const o = offices.find((x) => x.office_id === S.lo.pick) || offices[0] || null;
    S.lo.office = o;
    tabIcon(false); document.title = 'Desk phones · Riyeser';
    $app.className = 'acct home'; const keepY = S.view === 'phones' && document.getElementById('phonesPage') ? window.scrollY : 0;
    const phones = o ? o.phones : [];
    const found = phones.filter((p) => !p.assigned); const desk = phones.filter((p) => p.assigned);
    const dot = (on) => `<span class="dot ${on ? 'on' : ''}" title="${on ? 'Connected' : 'Not connected'}">${on ? '●' : '○'}</span>`;
    const phoneLine = (p) => `<span class="lo-ph">${esc([p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone')} <small class="mono">${esc(prettyMac(p.mac))}</small></span>`;
    const admin = isAdmin();
    let body = '';
    if (!admin) body = '<div class="lo-card"><p>Only the business\'s owner and admins can see and change the desk phones. To set up your own phone, open <b>☎ My phone</b>.</p><button class="btn p" id="phmine">☎ My phone</button></div>';
    else if (!plus) body = `<div class="lo-card lo-up"><h2>⭐ Riyeser Link Plus</h2><p>${isOwner() ? PH.UPSELL : PH.UPSELL_TEAM}</p><p class="muted small">Chat stays free either way.</p></div>`;
    else if (!o) body = `${setupHtml(setupSteps([], now))}<div class="lo-card"><h2>Set up desk phones</h2><p>Riyeser Link Office is the office phone system: it runs on one PC at the office, and the office's desk phones connect to it and call each other. Nothing has been set up yet.</p>
        <p>Once it's running, this page shows the address to type into phones, every desk phone and extension, and lets you give phones to people from here.</p>
        <p><a class="btn" href="/help/link.html#desk-phones">📖 Read the guide: Setting up desk phones</a></p>${st === null ? '<p class="muted small">Riyeser is finishing an update to this page. If Riyeser Link Office is already running, its details show here soon.</p>' : ''}</div>`;
    else {
      const [stText, stCls, stWhy] = officeState(o, now);
      const addr = (o.addresses || [])[0] || '';
      const support = st.support && new Date(st.support.until) > Date.now() ? st.support : null;
      body = `${setupHtml(setupSteps(offices, now))}
      ${offices.length > 1 ? `<label class="lo-pick">Riyeser Link Office on <select id="lopick">${offices.map((x) => `<option value="${esc(x.office_id)}"${x === o ? ' selected' : ''}>${esc(x.pc_name || 'a PC')} · seen ${ago(x.last_seen)}</option>`).join('')}</select></label>` : ''}
      <section class="lo-card lo-top">
        <div class="lo-addr"><small>Server address to type into phones</small>
          <div class="lo-big"><code id="loaddr">${esc(addr || '—')}</code><span>port <b id="loport">${esc(o.sip_port || 5060)}</b></span><button class="btn sm" id="locopy">Copy</button></div>
          <p class="muted small">Username: the person's extension. Password: <b>Set up a phone by hand</b> next to them. Yealink, Grandstream, Snom and Polycom desk phones set themselves up once you give them to someone.</p>
          ${o.address_stable === false ? `<div class="lo-warn"><b>⚠️ This address isn't stable.</b> The office router has given the Riyeser Link Office PC a new address several times this month, so phones may lose touch. In the router's settings, add a <b>DHCP reservation</b> (also called a "static lease") so it always gives this PC ${esc(addr)}${o.pc_mac ? ` — the PC's MAC address is <code>${esc(o.pc_mac)}</code>` : ''}. Your IT person or internet provider can do this in a few minutes.</div>` : ''}
        </div>
        <dl class="lo-kv"><dt>Riyeser Link Office</dt><dd><span class="pl ${stCls}" id="lostate">${esc(stText)}</span>${stWhy ? `<small>${esc(stWhy)}</small>` : ''}</dd>
          <dt>Last seen</dt><dd id="loseen">${ago(o.last_seen)}</dd><dt>PC</dt><dd>${esc(o.pc_name || '—')}</dd><dt>Version</dt><dd>${esc(o.version || '—')}</dd>
          <dt>Licence</dt><dd>${o.licence && o.licence.active ? `<span class="pl ok">${esc(o.licence.text || 'On')}</span>` : `<span class="pl bad">${esc((o.licence && o.licence.text) || 'Riyeser Link Plus isn\'t active on this PC')}</span>`}</dd>
          <dt>Phones</dt><dd>${desk.length} · ${desk.filter((p) => p.registered).length} connected${(o.counts && o.counts.calls_in_progress) ? ` · ${o.counts.calls_in_progress} call${o.counts.calls_in_progress === 1 ? '' : 's'} now` : ''}</dd></dl>
      </section>
      ${found.length ? `<h3 class="hsec" id="lofoundh">New phones found <small>Plugged in at the office, not given to anyone yet.</small></h3>
        <div class="lo-found">${found.map((p) => `<div class="lo-new"><span>☎ <b>${phoneLine(p)}</b><small>${p.ip ? `at ${esc(p.ip)}` : ''}</small></span><button class="btn p sm" data-give="${esc(p.mac)}">Give to…</button><button class="btn sm" data-wiz="${esc(p.mac)}">Name it and add…</button></div>`).join('')}</div>` : ''}
      <div class="lo-dphead"><h3 class="hsec">Desk phones <small>Online · Configuring · Waiting for phone · Offline</small></h3><button class="btn p" id="loaddphone">+ Add desk phone</button></div>
      ${desk.length ? `<div class="lo-tw"><table class="lo lo-dp"><thead><tr><th>Name</th><th>Extension</th><th>Location</th><th>Status</th><th>Last check-in</th><th><span class="sr">More</span></th></tr></thead><tbody>
        ${desk.map((p) => `<tr data-mac="${esc(p.mac)}"><td data-l="Name"><span class="lo-nm"><span class="lo-ico" aria-hidden="true">☎</span><span><b>${esc(phoneLabel(p))}</b><small>${p.name ? modelLine(p) : `<span class="mono">${esc(prettyMac(p.mac))}</span>`}</small></span></span></td>
          <td data-l="Extension"><b>${esc(p.extension)}</b> ${esc(extName(p.extension))}</td><td data-l="Location">${esc(p.location || '—')}</td>
          <td data-l="Status">${statusPill(p, now)}</td><td data-l="Last check-in">${esc(checkIn(p))}</td>
          <td class="lo-morec"><button class="btn sm lo-dots" data-more="${esc(p.mac)}" aria-label="More for ${esc(phoneLabel(p))}" title="View setup, troubleshoot, replace…">⋯</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No desk phones given to anyone yet.</p>'}
      <h3 class="hsec">Extensions <small>Each person's number. Their desk phones and Riyeser Link apps ring together.</small></h3>
      <div class="lo-tw"><table class="lo lo-ext"><thead><tr><th>Ext.</th><th>Person or group</th><th>Desk phones</th><th>App users</th><th>Do not disturb</th><th></th></tr></thead><tbody>
        ${o.extensions.map((x) => x.type === 'group'
          ? `<tr class="grp"><td data-l="Ext."><b>${esc(x.extension)}</b></td><td data-l="Group">${esc(x.name)} <small class="muted">ring group · ${x.members || 0} ${x.members === 1 ? 'person' : 'people'}</small></td><td data-l="Desk phones" class="muted">—</td><td data-l="App users" class="muted">—</td><td data-l="Do not disturb" class="muted">—</td><td></td></tr>`
          : `<tr><td data-l="Ext."><b>${esc(x.extension)}</b></td><td data-l="Person">${esc(x.name)}</td>
            <td data-l="Desk phones">${desk.filter((p) => p.extension === x.extension).map((p) => `<div>${dot(p.registered)} ${phoneLine(p)}</div>`).join('') || '<span class="muted">None</span>'}</td>
            <td data-l="App users">${x.app_users ? `${dot(true)} ${x.app_users}` : '<span class="muted">0</span>'}</td>
            <td data-l="Do not disturb"><label class="sw"><input type="checkbox" data-dnd="${esc(x.extension)}"${x.dnd ? ' checked' : ''} aria-label="Do not disturb for ${esc(x.name)}"><span></span></label></td>
            <td><button class="btn sm" data-hand="${esc(x.extension)}">Set up a phone by hand</button></td></tr>`).join('')}</tbody></table></div>
      <section class="lo-card lo-help-us"><h4>🤝 Let Riyeser help</h4>${support
        ? `<p id="losupport">Riyeser support can see and change your phone set-up until <b>${esc(timeShort(support.until))}</b>. Everything they do is in your 🕘 History.</p><button class="btn" id="losupend">End it now</button>`
        : `<p id="losupport">Stuck? Give Riyeser support access to your phone set-up for 1 hour. They can do what you can on this page, including showing a phone's password to set it up with you. Everything they do is in your 🕘 History, and you can end it early.</p><button class="btn" id="losupon">Let Riyeser help</button>`}</section>`;
    }
    $app.innerHTML = `<header class="htop"><button class="btn sm" id="phback">← ${S.phonesBack === 'home' ? 'Riyeser home' : 'Back to chat'}</button><b class="hbrand-t">⚙ Settings › ☎ Desk phones</b><span class="hme">${esc(t.name)}</span></header>
      <main class="hmain" id="phonesPage"><h1>${PH.TITLE}</h1><p class="muted lo-sub">Riyeser Link Office: the office phone system for ${esc(t.name)}.</p>
        ${S.lo.error ? `<div class="err">${esc(S.lo.error)}</div>` : ''}${needs2step() && admin ? '<button class="hnag" id="phmfa">🔐 Turn on <b>two-step sign-in</b> to change the phones. It takes 2 minutes.</button>' : ''}
        ${body}
        <h3 class="hsec">Good to know</h3><div class="lo-tips">${PH.HELP.map(([h, x]) => `<div><b>${h}</b><span>${esc(x)}</span></div>`).join('')}</div>
        <p class="muted small hfoot"><a href="/help/link.html#desk-phones">Help: Setting up desk phones</a> · <a href="/help/link.html#own-desk-phone">Set up your own desk phone</a></p></main>`;
    window.scrollTo(0, keepY);
    const on = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.onclick = fn; };
    on('#phback', () => { clearInterval(S.loTimer); S.view = null; if (S.phonesBack === 'home') { S.home = true; renderHome(); } else { S.home = false; render(); } });
    on('#phmfa', security); on('#phmine', () => myPhonePage(S.phonesBack));
    on('#locopy', async () => { try { await navigator.clipboard.writeText($app.querySelector('#loaddr').textContent); $app.querySelector('#locopy').textContent = 'Copied'; } catch { /* select it */ } });
    on('#loaddphone', () => addDeskPhone());
    const pk = $app.querySelector('#lopick'); if (pk) pk.onchange = () => { S.lo.pick = pk.value; drawPhones(); };
    on('#losupon', async () => { if (needs2step()) return security();
      if (!(await ask('Let Riyeser support see and change your phone set-up for the next hour?'))) return;
      try { await api.linkSupport(t.id, true); phMsg('Riyeser support can help for the next hour.', 'ok'); } catch (err) { phMsg(esc(plainError(err)), 'bad'); } refreshPhones(); });
    on('#losupend', async () => { try { await api.linkSupport(t.id, false); phMsg('Riyeser support can\'t change your phones any more.', 'ok'); } catch (err) { phMsg(esc(plainError(err)), 'bad'); } refreshPhones(); });
    $app.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { const s = b.dataset.step;
      if (s === 'show') S.loStepsOpen = true; if (s === 'hide') S.loStepsOpen = false; if (s === 'test') setTestTicked(true);
      if (s === 'add') return addDeskPhone();
      if (s === 'found') { const h = $app.querySelector('#lofoundh'); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      drawPhones(); });
    $app.querySelectorAll('[data-hand]').forEach((b) => b.onclick = () => byHand(b.dataset.hand));
    $app.querySelectorAll('[data-more]').forEach((b) => b.onclick = () => phoneMenu(b.dataset.more));
    $app.querySelectorAll('[data-wiz]').forEach((b) => b.onclick = () => addDeskPhone(b.dataset.wiz));
    $app.querySelectorAll('[data-dnd]').forEach((c) => c.onchange = async () => { const r = await sendCmd('set_dnd', { extension: c.dataset.dnd, on: c.checked }, phMsg); if (!r) c.checked = !c.checked; });
    $app.querySelectorAll('[data-give]').forEach((b) => b.onclick = () => giveTo(b.dataset.give));
  }
  // A new phone found: choose who it's for.
  function giveTo(mac) {
    const o = S.lo.office; const p = o.phones.find((x) => x.mac === mac);
    modal(`<h3>Give this phone to…</h3><p>${esc([p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone')} · <span class="mono">${esc(prettyMac(mac))}</span>${p.ip ? ` · at ${esc(p.ip)}` : ''}</p>
      <div class="lo-who">${o.extensions.filter((x) => x.type === 'person').map((x) => `<button class="btn" data-to="${esc(x.extension)}"><b>${esc(x.extension)}</b> ${esc(x.name)}</button>`).join('')}</div>
      <div id="gstat" class="lo-stat"></div><p class="muted small">The phone sets itself up within a minute. If it doesn't, restart it.</p>
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      const say = (h, c) => { d.querySelector('#gstat').className = `lo-stat ${c || ''}`; d.querySelector('#gstat').innerHTML = h; };
      d.querySelectorAll('[data-to]').forEach((b) => b.onclick = async () => { d.querySelectorAll('[data-to]').forEach((x) => { x.disabled = true; });
        const r = await sendCmd('assign_phone', { mac, extension: b.dataset.to }, say);
        if (r) setTimeout(close, 900); else d.querySelectorAll('[data-to]').forEach((x) => { x.disabled = false; }); });
    });
  }
  // Set up a phone by hand: the details to type into any SIP phone or app. The password only on Show.
  function byHand(ext) {
    const o = S.lo.office; const x = o.extensions.find((e) => e.extension === ext) || { name: '' };
    const addr = (o.addresses || [])[0] || ''; let pw = null; let busyShow = false;
    modal(`<h3>Set up a phone by hand <small class="lo-h3s">Advanced setup (manual SIP)</small></h3><p><b>${esc(ext)}</b> · ${esc(x.name)}. Type these into the phone's SIP account settings, or into a SIP app such as Linphone or Zoiper.</p>
      <dl class="lo-sip"><dt>Server address</dt><dd><code>${esc(addr)}</code><button class="btn sm" data-cp="${esc(addr)}">Copy</button></dd>
        <dt>Port</dt><dd><code>${esc(o.sip_port || 5060)}</code></dd>
        <dt>Username</dt><dd><code>${esc(ext)}</code><button class="btn sm" data-cp="${esc(ext)}">Copy</button></dd>
        <dt>Password</dt><dd><code id="pw">••••••••••••••••</code><button class="btn sm" id="show">Show</button><button class="btn sm" id="cppw">Copy</button></dd></dl>
      <p class="muted small">Authentication name: the same as the username. Transport: UDP. The phone must be on the same office network as ${esc(o.pc_name || 'the Riyeser Link Office PC')}. Showing a password is recorded in your company's 🕘 History.</p>
      ${menusHtml('hmenus')}
      <div id="hstat" class="lo-stat"></div>
      <div class="mfoot"><button class="btn" id="newpw" style="margin-right:auto">Make a new password</button><button class="btn p" id="cl">Done</button></div>`, (d, close) => {
      const say = (h, c) => { const el = d.querySelector('#hstat'); el.className = `lo-stat ${c || ''}`; el.innerHTML = h; };
      d.querySelector('#cl').onclick = () => { pw = null; close(); };
      d.querySelectorAll('[data-cp]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.cp); b.textContent = 'Copied'; } catch { /* select it */ } });
      const show = async () => {
        if (pw) return pw; if (busyShow) return null; busyShow = true;
        try {
          const { kp, jwk } = await oneOffKey();
          const r = await sendCmd('reveal_password', { extension: ext, key: jwk }, say, { wantReveal: true, sending: 'Asking Riyeser Link Office for the password…' });
          if (!r) return null;
          const sealed = await api.linkRevealTake(r.id);
          if (!sealed) { say('That password was already shown, or 5 minutes have passed. Press Show again.', 'bad'); return null; }
          pw = await openSealed(kp, sealed);
          d.querySelector('#pw').textContent = pw; d.querySelector('#show').textContent = 'Hide';
          say('Shown to you only, on this screen. It isn\'t kept anywhere online.', 'ok');
          return pw;
        } catch (err) { say(esc(plainError(err)), 'bad'); return null; } finally { busyShow = false; }
      };
      d.querySelector('#show').onclick = async () => {
        if (pw && d.querySelector('#show').textContent === 'Hide') { d.querySelector('#pw').textContent = '••••••••••••••••'; d.querySelector('#show').textContent = 'Show'; return; }
        if (pw) { d.querySelector('#pw').textContent = pw; d.querySelector('#show').textContent = 'Hide'; return; }
        await show(); };
      d.querySelector('#cppw').onclick = async () => { const v = await show(); if (!v) return; try { await navigator.clipboard.writeText(v); d.querySelector('#cppw').textContent = 'Copied'; } catch { /* shown instead */ } };
      d.querySelector('#newpw').onclick = async () => {
        if (!(await ask(`Make a new password for extension ${ext}? Phones using the old one stop working until they get the new one. Desk phones set up by Riyeser Link Office get it when they restart.`))) return;
        pw = null; d.querySelector('#pw').textContent = '••••••••••••••••'; d.querySelector('#show').textContent = 'Show';
        const r = await sendCmd('new_password', { extension: ext }, say);
        if (r) say('New password made. Press <b>Show</b> to see it. Restart desk phones that Riyeser Link Office set up, so they get it.', 'ok');
      };
    });
  }

  // ------------------------------------------------------------------ Desk phones list, Add desk phone, ⋯ menu (Settings → Desk phones)
  // A desk phone's status: Online (connected now), Configuring (fetched its settings, not connected yet), Offline (was
  // connected, isn't now), Waiting for phone (given to someone, hasn't asked for its settings yet). The same rules as
  // Riyeser Link Office's own screen (desktop/src/renderer/link-text.js phoneStatus).
  function phoneStatus(p, now = Date.now()) {
    const t = (x) => (x ? Date.parse(x) : 0); const fetched = t(p.provisioned_at); const reg = t(p.last_registered);
    if (p.registered) return ['Online', 'ok'];
    if (fetched && fetched > reg && now - fetched < 15 * 60000) return ['Configuring', 'cfg'];
    if (reg) return ['Offline', 'bad'];
    if (fetched) return ['Configuring', 'cfg'];
    return ['Waiting for phone', 'wait'];
  }
  const statusPill = (p, now) => { const [t, c] = phoneStatus(p, now); return `<span class="lo-pill ${c}" data-st="${esc(t)}"><i aria-hidden="true"></i>${esc(t)}</span>`; };
  const phoneLabel = (p) => p.name || [p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone';
  const modelLine = (p) => `${esc([p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone')} · <span class="mono">${esc(prettyMac(p.mac))}</span>`;
  const checkIn = (p) => (p.registered ? 'Now' : p.last_registered ? ago(p.last_registered) : 'Never');
  const SVG_PHONE = '<svg class="pic" viewBox="0 0 64 48" aria-hidden="true"><rect x="6" y="14" width="52" height="30" rx="5" fill="#e0f2f7" stroke="#0e7490" stroke-width="2"/><path d="M10 14c0-6 6-10 22-10s22 4 22 10" fill="none" stroke="#0e7490" stroke-width="5" stroke-linecap="round"/><rect x="14" y="19" width="18" height="9" rx="2" fill="#fff" stroke="#0e7490" stroke-width="1.5"/>'
    + [0, 1, 2].map((r) => [0, 1, 2].map((c) => `<circle cx="${40 + c * 6}" cy="${21 + r * 7}" r="2" fill="#0e7490"/>`).join('')).join('') + '</svg>';
  const SVG_SOCKET = '<svg class="pic" viewBox="0 0 64 48" aria-hidden="true"><rect x="8" y="6" width="34" height="36" rx="4" fill="#f8fafc" stroke="#64708a" stroke-width="2"/><path d="M17 18h16v12h-4v4h-8v-4h-4z" fill="#fff" stroke="#64708a" stroke-width="2"/><path d="M25 30c0 8 6 12 14 12h20" fill="none" stroke="#1f62f0" stroke-width="4" stroke-linecap="round"/><text x="25" y="15" font-size="6" text-anchor="middle" fill="#64708a" font-family="sans-serif">LAN</text></svg>';
  // Where to type the details on common desk phones. Menus differ by model, so this stays general.
  const PHONE_MENUS = [
    ['Yealink', 'Type the phone\'s IP address into a web browser (press <b>OK</b> on the phone to see it). Sign in, then go to <b>Account → Register</b>. Turn <b>Line Active</b> on and fill in <b>Register Name</b> and <b>User Name</b> (your extension), <b>Password</b>, and <b>Server Host</b> (the server address) with port 5060.'],
    ['Grandstream', 'Type the phone\'s IP address into a web browser (it\'s in the phone\'s <b>Status</b> menu). Sign in, then go to <b>Account → Account 1 → General Settings</b>. Set <b>Account Active</b> to Yes, then fill in <b>SIP Server</b>, <b>SIP User ID</b> and <b>Authenticate ID</b> (your extension) and <b>Authenticate Password</b>.'],
    ['Snom', 'Type the phone\'s IP address into a web browser (it\'s under the phone\'s settings or info menu). Go to <b>Identity 1 → Login</b>, then fill in <b>Account</b> (your extension), <b>Password</b> and <b>Registrar</b> (the server address).'],
    ['Polycom / Poly', 'Type the phone\'s IP address into a web browser, starting with https:// (it\'s under <b>Settings → Status → Network</b> on the phone). Sign in as Admin, then go to <b>Settings → Lines → Line 1</b>. Fill in <b>Address</b>, <b>Auth User ID</b> (your extension), <b>Password</b>, and <b>Server 1 Address</b> with port 5060.'],
  ];
  const menusHtml = (id) => `<details class="lo-menus" id="${id}"><summary>Where do I type these on my phone?</summary>
    <p class="muted small">Every phone has a settings web page at its own IP address. There, the place for these details is usually called <b>Account</b> or <b>Line</b>, then <b>Register</b>. Menus differ by model, so check the phone's manual if yours looks different.</p>
    <dl>${PHONE_MENUS.map(([m, t]) => `<dt>${m}</dt><dd>${t}</dd>`).join('')}</dl></details>`;
  // The office PC's checklist when a phone won't connect.
  function troubleHtml(p, o, now) {
    const fresh = o && now - Date.parse(o.last_seen) < OFFLINE_AFTER;
    return `<div class="lo-trouble"><h4>🛠 Troubleshoot</h4><ol class="lo-check">
      <li><b>Power.</b> Is the phone's screen on? Many desk phones need power over the network cable (PoE) or their own power adapter.</li>
      <li><b>Network cable in the LAN port.</b> Plug the cable from the wall (or the network switch) into the phone's <b>LAN</b> port, not its <b>PC</b> port.</li>
      <li><b>Same office network.</b> The phone must be on the same office network as the Riyeser Link Office PC${o && o.pc_name ? ` (${esc(o.pc_name)})` : ''}. A phone at home or in another building can't reach it yet.</li>
      <li><b>The office PC is on and online.</b> ${o ? `Riyeser Link Office last reported <b>${ago(o.last_seen)}</b>${fresh ? '.' : '. Check the PC is on, awake and connected to the internet.'}` : 'Riyeser Link Office hasn\'t reported in yet.'}</li>
      <li><b>Restart the phone.</b> Unplug its power (or the network cable, for PoE) for 10 seconds, then plug it back in.</li></ol>
      ${p ? `<p class="small muted">Last check-in: <b>${esc(checkIn(p))}</b> · Last settings fetch: <b>${p.provisioned_at ? esc(ago(p.provisioned_at)) : 'never'}</b></p>` : ''}
      <button class="btn" data-report="${p ? esc(p.mac) : ''}">🛠 Report a phone issue</button></div>`;
  }
  // "Report a phone issue": the Get help form, filled in with the phone's details.
  function reportPhone(p, ext, extra = '') {
    const [st] = p ? phoneStatus(p) : ['No desk phone'];
    const lines = [p ? `Phone: ${[p.vendor, p.model].filter(Boolean).join(' ') || 'Desk phone'}${p.name ? ` (${p.name})` : ''}` : 'Phone: none yet',
      p ? `MAC: ${prettyMac(p.mac)}` : '', p ? `Connected: ${p.registered ? 'yes' : 'no'} (${st}, last check-in ${checkIn(p)})` : '', extra, '', 'What\'s happening: '].filter((x, i) => x || i > 3);
    getHelp(S.team.id, { topic: 'program', subject: `Phone problem: extension ${ext || '?'}`, message: lines.join('\n') });
  }
  const testKey = () => `riyeser.link.testcall.${S.team.id}`;
  const testTicked = () => { try { return localStorage.getItem(testKey()) === '1'; } catch { return false; } };
  const setTestTicked = (v) => { try { if (v) localStorage.setItem(testKey(), '1'); else localStorage.removeItem(testKey()); } catch { /* private mode */ } };
  // "Set up your office phones": 5 steps that tick themselves off from what Riyeser Link Office reports.
  function setupSteps(offices, now) {
    const phones = offices.flatMap((x) => x.phones || []); const last = offices[0];
    const fresh = offices.some((x) => now - Date.parse(x.last_seen) < 10 * 60000);
    const called = offices.some((x) => x.counts && ((x.counts.calls_made || 0) > 0 || (x.counts.calls_in_progress || 0) > 0));
    return [
      { t: 'Install Riyeser Link Office on a PC at the office that stays on.', s: 'Get it from <b>Riyeser Central → Get more apps</b>.', done: offices.length > 0, act: '<a class="btn sm" href="/help/link.html#desk-phones">How to install</a>' },
      { t: 'Sign in on that PC.', s: last && !fresh ? `Riyeser Link Office last reported ${ago(last.last_seen)}. Is the PC on, and signed in to your Riyeser account?` : 'Open Riyeser Link Office and sign in with your Riyeser account. It brings in your people and extensions.', done: fresh },
      { t: 'Plug in your desk phones.', s: 'Into a network socket at the office, and into power.', done: phones.length > 0, act: offices.length ? '<button class="btn sm" data-step="add">+ Add desk phone</button>' : '' },
      { t: 'Give each phone to a person.', s: 'New phones show up below. Choose who each one is for.', done: phones.length > 0 && phones.every((p) => p.assigned), act: phones.some((p) => !p.assigned) ? '<button class="btn sm" data-step="found">New phones found</button>' : '' },
      { t: 'Make a test call.', s: 'Pick up a desk phone and dial another extension.', done: called || testTicked(), act: offices.length ? '<button class="btn sm" data-step="test">Done</button>' : '' },
    ];
  }
  function setupHtml(steps) {
    const n = steps.filter((x) => x.done).length;
    if (n === steps.length && !S.loStepsOpen) return '<div class="lo-setdone" id="losetup"><b>✓ Office phones are set up</b> · <button class="linkbtn" data-step="show">Show the steps</button></div>';
    return `<section class="lo-card lo-setup" id="losetup"><div class="lo-sethead"><h2>Set up your office phones</h2><span class="muted small">${n} of ${steps.length} done</span></div>
      <ol class="lo-tick">${steps.map((x, i) => `<li class="${x.done ? 'done' : ''}"><span class="tk" aria-hidden="true">${x.done ? '✓' : i + 1}</span><div><b>${x.t}</b><small>${x.s}</small></div>${!x.done && x.act ? x.act : ''}</li>`).join('')}</ol>
      ${n === steps.length ? '<button class="linkbtn" data-step="hide">Hide the steps</button>' : ''}</section>`;
  }
  // The new phone's progress, live: Waiting for phone → Configuring → Online (checks every few seconds).
  function liveStatus(box, mac, onOnline) {
    const stages = ['Waiting for phone', 'Configuring', 'Online'];
    const draw = () => {
      const st = S.lo.status || {}; const now = st.now ? Date.parse(st.now) : Date.now();
      const p = ((S.lo.office || {}).phones || []).find((x) => x.mac === mac);
      const [t] = p ? phoneStatus(p, now) : ['Waiting for phone']; const cur = t === 'Offline' ? 0 : stages.indexOf(t);
      box.innerHTML = `<div class="lo-live" data-st="${esc(t)}">${stages.map((s, i) => `<span class="${i < cur ? 'past' : i === cur ? 'now' : ''}">${i < cur ? '✓ ' : ''}${s}</span>`).join('<i aria-hidden="true">→</i>')}</div>`;
      if (t === 'Online' && onOnline) { const f = onOnline; onOnline = null; f(); }
      return t;
    };
    draw();
    const tick = async () => {
      if (!document.body.contains(box)) return;
      try { S.lo.status = await api.linkStatus(S.team.id); const offs = (S.lo.status && S.lo.status.offices) || [];
        S.lo.office = offs.find((x) => S.lo.office && x.office_id === S.lo.office.office_id) || offs[0] || S.lo.office; } catch { /* try again */ }
      if (draw() !== 'Online') setTimeout(tick, 4000);
    };
    setTimeout(tick, 2500);
  }
  const people = () => ((S.lo.office || {}).extensions || []).filter((x) => x.type === 'person');
  const extName = (ext) => (((S.lo.office || {}).extensions || []).find((x) => x.extension === ext) || {}).name || '';
  const branchOptions = (cur) => `<option value="">No location</option>${S.branches.map((b) => `<option${b.name === cur ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}`;
  // Add desk phone: name → location → extension → identify the handset → plug it in (live status) → test call.
  function addDeskPhone(preMac) {
    const o = S.lo.office; if (!o) return; if (needs2step()) return security();
    const w = { step: 1, name: '', branch: '', ext: '', pick: preMac || '', mac: '', vendor: '', sn: '' };
    const found = () => (S.lo.office.phones || []).filter((p) => !p.assigned);
    modal('<div id="wiz"></div>', (d, close) => {
      const root = d.querySelector('#wiz');
      const nav = (back, next, nextLabel = 'Next') => `<div class="mfoot">${back ? '<button type="button" class="btn" data-w="back">Back</button>' : '<button type="button" class="btn" data-w="close">Cancel</button>'}${next ? `<button class="btn p">${nextLabel}</button>` : ''}</div>`;
      const head = (t) => `<p class="lo-wstep">Step ${w.step} of 6</p><h3>${t}</h3>`;
      const draw = () => {
        let h = '';
        if (w.step === 1) h = `${head('Name the phone')}<p>So everyone knows which phone is which, like <b>Reception</b> or <b>Workshop</b>.</p>
          <label class="f"><span>Phone name</span><input name="name" maxlength="40" required value="${esc(w.name)}" placeholder="e.g. Reception"></label>${nav(false, true)}`;
        if (w.step === 2) h = `${head('Choose a location')}<p>Which branch is it at?</p><label class="f"><span>Location</span><select name="branch">${branchOptions(w.branch)}</select></label>${nav(true, true)}`;
        if (w.step === 3) h = `${head('Choose the extension')}<p>Whose number rings on this phone?</p><div class="lo-pickx">${people().map((x) => `<label class="opt"><input type="radio" name="ext" value="${esc(x.extension)}"${w.ext === x.extension ? ' checked' : ''} required> <b>${esc(x.extension)}</b> ${esc(x.name)}</label>`).join('') || '<p class="muted">No one has an extension yet. Give people extensions under ⚙ Branches and extensions.</p>'}</div>
          <p class="muted small">A shared phone, such as Reception? Give it to the person who sits there, or add a person called Reception on the Riyeser Link Office PC (People tab) and put them in the ring group. Callers can then ring the whole group.</p>${nav(true, true)}`;
        if (w.step === 4) h = `${head('Identify the handset')}<p>Pick it from the new phones found, or type the details from the label under the phone.</p>
          <div class="lo-pickx">${found().map((p) => `<label class="opt"><input type="radio" name="pick" value="${esc(p.mac)}"${w.pick === p.mac ? ' checked' : ''}> <b>New phone found:</b> ${modelLine(p)}${p.ip ? ` <small>at ${esc(p.ip)}</small>` : ''}</label>`).join('')}
          <label class="opt"><input type="radio" name="pick" value=""${!w.pick ? ' checked' : ''}> <b>Type its MAC address</b></label>
          <label class="opt lo-off" title="Coming with Riyeser Link Cloud"><input type="radio" disabled> Use a setup code <small>Coming with Riyeser Link Cloud.</small></label></div>
          <div id="wtyped"${w.pick ? ' hidden' : ''}><div class="f2"><label class="f"><span>MAC address</span><input name="mac" value="${esc(w.mac)}" placeholder="e.g. 00:15:65:12:34:56" autocomplete="off" spellcheck="false"></label>
            <label class="f"><span>S/N <small class="muted">(optional)</small></span><input name="sn" maxlength="40" value="${esc(w.sn)}" autocomplete="off" spellcheck="false"></label></div>
            <label class="f"><span>Maker</span><select name="vendor"><option value="">Not sure</option>${['yealink', 'grandstream', 'snom', 'polycom'].map((v) => `<option value="${v}"${w.vendor === v ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label></div>
          <details class="lo-label"><summary>Where's the label?</summary><img src="/assets/help/phone-label.webp" alt="The label under a desk phone, showing its MAC and S/N, above the LAN port" loading="lazy">
            <p class="small muted">Turn the phone over. The label shows <b>MAC</b> (12 letters and numbers, like 00:15:65:12:34:56) and <b>S/N</b> (the serial number). It's often on the box too. Labels differ by model.</p></details>
          <div id="wstat" class="lo-stat"></div>${nav(true, true, 'Add phone')}`;
        if (w.step === 5) h = `${head('Plug it in')}<div class="lo-plug">${SVG_SOCKET}${SVG_PHONE}<p>Plug the network cable into the phone's <b>LAN</b> port (not the PC port), and plug in power if it has an adapter. It sets itself up in a minute or two.</p></div>
          ${w.warn ? `<div class="lo-stat warn">${w.warn}</div>` : ''}<div id="wlive"></div><p class="muted small">Not moving? <button type="button" class="linkbtn" data-w="trouble">Troubleshoot</button></p><div id="wtrouble"></div>
          <div class="mfoot"><button type="button" class="btn" data-w="close">Close</button><button class="btn p" id="wnext" disabled>Next: test call</button></div>`;
        if (w.step === 6) h = `${head('Make a test call')}<p>Pick up the new phone and dial another extension${S.lo.office && (S.lo.office.extensions || []).find((x) => x.type === 'group') ? `, or ${esc(S.lo.office.extensions.find((x) => x.type === 'group').extension)} to ring ${esc(S.lo.office.extensions.find((x) => x.type === 'group').name)}` : ''}.</p>
          <label class="opt"><input type="checkbox" name="ok"${testTicked() ? ' checked' : ''}> The test call worked</label>
          <div class="mfoot"><button class="btn p">Finish</button></div>`;
        root.innerHTML = `<form id="wf">${h}</form>`;
        const f = root.querySelector('#wf'); const i = f.querySelector('input:not([type=radio]):not([type=checkbox]),select'); if (i && w.step < 4) i.focus();
        f.querySelectorAll('[data-w]').forEach((b) => b.onclick = () => {
          if (b.dataset.w === 'back') { w.step -= 1; draw(); } else if (b.dataset.w === 'close') { close(); refreshPhones(); }
          else if (b.dataset.w === 'trouble') { const t = f.querySelector('#wtrouble'); const p = (S.lo.office.phones || []).find((x) => x.mac === w.mac); t.innerHTML = troubleHtml(p, S.lo.office, Date.now()); wireReport(t, w.ext); } });
        f.querySelectorAll('input[name=pick]').forEach((r) => r.onchange = () => { f.querySelector('#wtyped').hidden = !!f.querySelector('input[name=pick]:checked').value; });
        if (w.step === 5) liveStatus(f.querySelector('#wlive'), w.mac, () => { const n = f.querySelector('#wnext'); if (n) { n.disabled = false; n.focus(); } });
        f.onsubmit = async (e) => {
          e.preventDefault(); const v = new FormData(f);
          if (w.step === 1) { w.name = String(v.get('name') || '').trim(); if (!w.name) return; }
          if (w.step === 2) w.branch = String(v.get('branch') || '');
          if (w.step === 3) { w.ext = String(v.get('ext') || ''); if (!w.ext) return; }
          if (w.step === 4) {
            let last = ''; const say = (html, cls) => { last = html; const el = f.querySelector('#wstat'); el.className = `lo-stat ${cls || ''}`; el.innerHTML = html; };
            w.pick = String(v.get('pick') || ''); w.mac = String(v.get('mac') || ''); w.vendor = String(v.get('vendor') || ''); w.sn = String(v.get('sn') || '').trim();
            const mac = (w.pick || w.mac).replace(/[\s:.-]/g, '').toLowerCase();
            if (!/^[0-9a-f]{12}$/.test(mac)) { say('That isn\'t a MAC address. It\'s 12 letters and numbers, on the label under the phone (like 00:15:65:12:34:56).', 'bad'); return; }
            w.mac = mac; f.querySelector('.btn.p').disabled = true;
            const data = { mac, extension: w.ext }; if (!w.pick && w.vendor) data.vendor = w.vendor;
            const r = await sendCmd(w.pick ? 'assign_phone' : 'add_phone', data, say, { sending: 'Adding the phone…' });
            // the name and location are extras: an older Riyeser Link Office (or database) can't keep them yet, and the phone still works
            w.warn = r && !(await sendCmd('name_phone', { mac, name: w.name, branch: w.branch, note: w.sn ? `S/N ${w.sn}` : '' }, say, { sending: 'Saving its name and location…' }))
              ? `The phone is added, but its name and location weren't saved: ${last}` : '';
            if (!r) { f.querySelector('.btn.p').disabled = false; const t = document.createElement('div'); t.innerHTML = troubleHtml(null, S.lo.office, Date.now()); f.querySelector('#wstat').after(t); wireReport(t, w.ext); return; }
          }
          if (w.step === 6) { setTestTicked(!!v.get('ok')); close(); refreshPhones(); return; }
          w.step += 1; draw();
        };
      };
      draw();
    });
  }
  function wireReport(root, ext) {
    root.querySelectorAll('[data-report]').forEach((b) => b.onclick = () => {
      const p = ((S.lo.office || {}).phones || []).find((x) => x.mac === b.dataset.report);
      reportPhone(p, ext || (p && p.extension), S.lo.office ? `Riyeser Link Office: ${S.lo.office.pc_name || 'office PC'}, last reported ${ago(S.lo.office.last_seen)}` : '');
    });
  }
  // The ⋯ menu for one desk phone.
  function phoneMenu(mac) {
    const p = (S.lo.office.phones || []).find((x) => x.mac === mac); if (!p) return;
    const [st] = phoneStatus(p, Date.parse((S.lo.status || {}).now || '') || Date.now());
    modal(`<h3>${esc(phoneLabel(p))}</h3><p>${modelLine(p)} · extension <b>${esc(p.extension)}</b> ${esc(extName(p.extension))} · ${statusPill(p)}</p>
      <div class="lo-acts">${st !== 'Online' ? '<button class="btn" data-m="view">View setup</button><button class="btn" data-m="trouble">Troubleshoot</button>' : '<button class="btn" data-m="view">View setup</button>'}
        <button class="btn" data-m="replace">Replace phone</button>${isAdmin() ? '<button class="btn" data-m="adv">Advanced setup (manual SIP)</button>' : ''}
        <button class="btn" data-m="rename">Rename / move location</button><button class="btn" data-m="remove">Remove from this person</button></div>
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { close(); const m = b.dataset.m;
        if (m === 'view') viewSetup(mac); if (m === 'trouble') troubleshoot(mac); if (m === 'replace') replacePhone(mac);
        if (m === 'adv') byHand(p.extension); if (m === 'rename') renamePhone(mac); if (m === 'remove') removePhone(mac); });
    });
  }
  function viewSetup(mac) {
    const o = S.lo.office; const p = o.phones.find((x) => x.mac === mac); if (!p) return;
    modal(`<h3>Setup: ${esc(phoneLabel(p))}</h3><dl class="lo-kv lo-vs"><dt>Name</dt><dd>${esc(p.name || '—')}</dd><dt>Extension</dt><dd><b>${esc(p.extension)}</b> ${esc(extName(p.extension))}</dd>
        <dt>Location</dt><dd>${esc(p.location || '—')}</dd><dt>Phone</dt><dd>${modelLine(p)}</dd>${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ''}
        <dt>Last check-in</dt><dd>${esc(checkIn(p))}</dd><dt>Settings fetched</dt><dd>${p.provisioned_at ? esc(ago(p.provisioned_at)) : 'Not yet'}</dd></dl>
      <ol class="lo-steps"><li>Plug the network cable into the phone's <b>LAN</b> port, and plug in power if it has an adapter.</li><li>The phone asks the office for its settings (<b>Configuring</b>), then connects (<b>Online</b>). If it hasn't within a few minutes, restart it.</li><li>Make a test call: dial another extension.</li></ol>
      <div id="vlive"></div><div class="mfoot"><button class="btn" data-t="1">Troubleshoot</button><button class="btn p" id="cl">Close</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close; d.querySelector('[data-t]').onclick = () => { close(); troubleshoot(mac); };
      liveStatus(d.querySelector('#vlive'), mac);
    });
  }
  function troubleshoot(mac) {
    const o = S.lo.office; const p = o.phones.find((x) => x.mac === mac);
    modal(`<h3>${esc(p ? phoneLabel(p) : 'Desk phone')}: not connecting</h3>${p ? `<p>${modelLine(p)} · ${statusPill(p)}</p>` : ''}${troubleHtml(p, o, Date.parse((S.lo.status || {}).now || '') || Date.now())}
      <div class="mfoot"><button class="btn p" id="cl">Close</button></div>`, (d, close) => { d.querySelector('#cl').onclick = close; wireReport(d, p && p.extension); });
  }
  function renamePhone(mac) {
    const p = S.lo.office.phones.find((x) => x.mac === mac); if (!p) return;
    modal(`<h3>Rename or move</h3><p>${modelLine(p)}</p><form id="rnf"><label class="f"><span>Phone name</span><input name="name" maxlength="40" value="${esc(p.name || '')}" placeholder="e.g. Reception"></label>
      <label class="f"><span>Location</span><select name="branch">${branchOptions(p.location || '')}</select></label><div id="rstat" class="lo-stat"></div>
      <div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p">Save</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      const say = (h, c) => { const el = d.querySelector('#rstat'); el.className = `lo-stat ${c || ''}`; el.innerHTML = h; };
      d.querySelector('#rnf').onsubmit = async (e) => { e.preventDefault(); const v = new FormData(e.target);
        if (await sendCmd('name_phone', { mac, name: String(v.get('name') || '').trim(), branch: String(v.get('branch') || ''), note: p.note || '' }, say)) setTimeout(close, 700); };
    });
  }
  function removePhone(mac) {
    modal('<h3>Remove this phone from its person?</h3><p>Riyeser Link Office stops giving it settings. To lock it out completely, also make a new password for that person.</p><div class="mfoot"><button class="btn" id="cl">Cancel</button><button class="btn p" id="ok">Remove</button></div>', (d, close) => {
      d.querySelector('#cl').onclick = close; d.querySelector('#ok').onclick = () => { close(); sendCmd('unassign_phone', { mac }, phMsg); };
    });
  }
  // Replace phone: the new handset keeps the extension, name and location; the old one stops getting its settings.
  function replacePhone(mac) {
    const o = S.lo.office; const old = o.phones.find((x) => x.mac === mac); if (!old) return;
    const found = o.phones.filter((p) => !p.assigned);
    modal(`<h3>Replace ${esc(phoneLabel(old))}</h3><p>Now: ${modelLine(old)} · extension <b>${esc(old.extension)}</b> ${esc(extName(old.extension))}</p>
      <form id="rpf"><span class="pkh">The new phone</span><div class="lo-pickx">${found.map((p) => `<label class="opt"><input type="radio" name="pick" value="${esc(p.mac)}"> <b>New phone found:</b> ${modelLine(p)}</label>`).join('')}
        <label class="opt"><input type="radio" name="pick" value="" checked> <b>Type its MAC address</b></label></div>
        <div class="f2" id="rptyped"><label class="f"><span>MAC address</span><input name="mac" placeholder="e.g. 00:15:65:12:34:56" autocomplete="off" spellcheck="false"></label>
          <label class="f"><span>Maker</span><select name="vendor"><option value="">Not sure</option><option value="yealink">Yealink</option><option value="grandstream">Grandstream</option><option value="snom">Snom</option><option value="polycom">Polycom</option></select></label></div>
        <div class="lo-warn" id="rpprev">The old phone (MAC ${esc(prettyMac(old.mac))}) stops getting its settings now; it keeps working until it's restarted or reset. To lock it out straight away, also make a new password.
          The new phone keeps extension <b>${esc(old.extension)}</b>${old.name ? `, the name <b>${esc(old.name)}</b>` : ''}${old.location ? ` and the location <b>${esc(old.location)}</b>` : ''}.</div>
        <div id="rpstat" class="lo-stat"></div><div id="rplive"></div>
        <div class="mfoot"><button type="button" class="btn" id="cl">Cancel</button><button class="btn p" id="rpgo">Replace phone</button></div></form>`, (d, close) => {
      d.querySelector('#cl').onclick = () => { close(); refreshPhones(); };
      const f = d.querySelector('#rpf');
      f.querySelectorAll('input[name=pick]').forEach((r) => r.onchange = () => { f.querySelector('#rptyped').hidden = !!f.querySelector('input[name=pick]:checked').value; });
      const say = (h, c) => { const el = d.querySelector('#rpstat'); el.className = `lo-stat ${c || ''}`; el.innerHTML = h; };
      f.onsubmit = async (e) => { e.preventDefault(); const v = new FormData(f);
        const picked = String(v.get('pick') || ''); const nm = (picked || String(v.get('mac') || '')).replace(/[\s:.-]/g, '').toLowerCase();
        if (!/^[0-9a-f]{12}$/.test(nm)) { say('That isn\'t a MAC address. It\'s 12 letters and numbers, on the label under the phone (like 00:15:65:12:34:56).', 'bad'); return; }
        if (nm === old.mac) { say('That\'s the same phone. Choose the new one.', 'bad'); return; }
        d.querySelector('#rpgo').disabled = true;
        const data = { mac: nm, extension: old.extension }; if (!picked && v.get('vendor')) data.vendor = String(v.get('vendor'));
        const ok = await sendCmd('unassign_phone', { mac: old.mac }, say, { sending: 'Taking the old phone off…' })
          && await sendCmd(picked ? 'assign_phone' : 'add_phone', data, say, { sending: 'Giving the new phone the same extension…' });
        if (!ok) { d.querySelector('#rpgo').disabled = false; return; }
        if (old.name || old.location) await sendCmd('name_phone', { mac: nm, name: old.name || '', branch: old.location || '', note: '' }, say, { sending: 'Keeping its name and location…' });   // an extra: the phone works either way
        say(`Replaced. Plug in the new phone: it keeps extension ${esc(old.extension)}.`, 'ok'); d.querySelector('#rpgo').hidden = true; d.querySelector('#cl').textContent = 'Close';
        liveStatus(d.querySelector('#rplive'), nm);
      };
    });
  }

  // ------------------------------------------------------------------ ☎ My phone (everyone): my extension, my desk phone, how to set it up
  async function myPhonePage(back) {
    S.myBack = back || S.myBack || (S.home ? 'home' : 'chat'); S.view = 'myphone';
    S.my = { data: undefined, pw: null, shown: false };
    await loadMyPhone(); drawMyPhone();
    clearInterval(S.myTimer); S.myTimer = setInterval(async () => {
      if (!document.getElementById('myPhonePage')) { clearInterval(S.myTimer); return; }
      if (document.hidden || document.querySelector('.modal') || S.my.busy) return;
      await loadMyPhone(); drawMyPhone();
    }, 20000);
  }
  async function loadMyPhone() { try { S.my.data = await api.linkMyPhone(S.team.id); S.my.error = null; } catch (e) { S.my.error = plainError(e); } }
  function drawMyPhone() {
    const t = S.team; const d = S.my.data || {}; const me = S.people.find((p) => p.user_id === S.user.id) || {};
    const ext = d.extension != null ? String(d.extension) : (S.my.data === null && me.extension ? String(me.extension) : null);
    const owner = d.owner_name || (S.people.find((p) => p.role === 'owner') || {}).display_name || 'the business owner';
    const admin = isAdmin(); const calls = d.calls != null ? !!d.calls : !!(S.features && S.features.calls);
    const o = d.office || null; const phones = d.phones || [];
    const grp = d.first_group || (S.branches[0] && S.branches[0].extension ? { extension: String(S.branches[0].extension), name: S.branches[0].name } : null);
    const addr = (o && o.address) || '';
    tabIcon(false); document.title = 'My phone · Riyeser'; $app.className = 'acct home';
    const ready = calls && o;
    $app.innerHTML = `<header class="htop"><button class="btn sm" id="myback">← ${S.myBack === 'home' ? 'Riyeser home' : 'Back to chat'}</button><b class="hbrand-t">☎ My phone</b><span class="hme">${esc(t.name)}</span></header>
      <main class="hmain" id="myPhonePage"><h1>My phone</h1>${S.my.error ? `<div class="err">${esc(S.my.error)}</div>` : ''}
        <section class="lo-card my-ext"><small>Your extension</small>${ext ? `<p class="my-big" id="myext">Others call you by dialling <b>${esc(ext)}</b></p>`
          : `<p id="myext">You don't have an extension yet. Ask ${esc(owner)} to give you one in People &amp; access.</p>`}</section>
        ${!ready ? `<section class="lo-card" id="mynone">${admin ? `<p>Your business hasn't set up office phones yet.</p><button class="btn p" id="mytophones">☎ Open the Phones set-up guide</button>`
          : `<p>Your business hasn't set up office phones yet. Ask ${esc(owner)}.</p>`}</section>` : `
        <h3 class="hsec">Your desk phone${phones.length > 1 ? 's' : ''}</h3>
        ${phones.length ? `<div class="hplan my-phones">${phones.map((p) => `<div><span>${SVG_PHONE}<span><b>${esc(phoneLabel(p))}</b><small>${modelLine(p)}</small></span></span>
          <span class="my-st"><span class="dot ${p.registered ? 'on' : ''}">${p.registered ? '●' : '○'}</span> ${p.registered ? 'connected' : 'not connected'}<small>${p.registered ? 'now' : p.last_registered ? `last seen ${ago(p.last_registered)}` : 'not seen yet'}</small></span></div>`).join('')}</div>`
          : '<p class="muted" id="mynophone">No desk phone yet.</p>'}
        <section class="lo-card my-guide" id="myguide"><h2>Set up my desk phone</h2>
          <ol class="lo-steps my-steps">
            <li><div><div class="my-pics">${SVG_SOCKET}${SVG_PHONE}</div>Plug the phone into a network socket at the office (and into power, if it has an adapter).</div></li>
            <li><div>Most phones set themselves up: your manager will see it appear and give it to you.</div></li>
            <li><div>If it doesn't, type these into the phone's account settings:
              ${ext ? `<dl class="lo-sip"><dt>Server address</dt><dd><code id="myaddr">${esc(addr || '—')}</code><button class="btn sm" data-cp="${esc(addr)}">Copy</button></dd>
                <dt>Port</dt><dd><code id="myport">${esc(o.sip_port || 5060)}</code></dd>
                <dt>Username / Account</dt><dd><code id="myuser">${esc(ext)}</code><button class="btn sm" data-cp="${esc(ext)}">Copy</button></dd>
                <dt>Password</dt><dd><code id="mypw">${S.my.shown && S.my.pw ? esc(S.my.pw) : '••••••••••••••••'}</code><button class="btn sm" id="myshow">${S.my.shown && S.my.pw ? 'Hide' : 'Show'}</button><button class="btn sm" id="mycppw">Copy</button></dd></dl>
                <div id="mystat" class="lo-stat"></div>
                <p class="muted small">Your password is kept on the office PC, never online. Showing it is recorded in your business's history.</p>`
                : '<p class="muted">You need an extension first.</p>'}
              ${menusHtml('mymenus')}</div></li>
            <li><div>Test it: dial another extension${grp ? `, e.g. <b>${esc(grp.extension)}</b> for ${esc(grp.name)}` : ''}.</div></li>
          </ol></section>
        ${ext ? `<section class="lo-card my-dnd"><label class="sw"><input type="checkbox" id="mydnd"${d.dnd ? ' checked' : ''} aria-label="Do not disturb"><span></span></label>
          <div><b>Do not disturb</b><small>Your phones don't ring, and callers hear busy. You can also dial *78 (on) and *79 (off) on your desk phone.</small></div></section>` : ''}`}
        <section class="lo-card"><h4>📞 Calls from this app</h4><p>You can also call people and branches from Riyeser Link itself, with Riyeser Link Plus.</p>${calls ? '<button class="btn" id="mycall">📞 Call someone</button>' : ''}</section>
        <div class="lo-warn my-sos"><b>🚫 No emergency calls.</b> Office phones can only call each other. Keep a mobile or normal phone line for emergency calls (000, 111, 112, 911).</div>
        <h3 class="hsec">Something wrong?</h3><div class="hhelp"><button class="btn" id="myreport">🛠 Report a phone issue</button><a class="btn" href="/help/link.html#own-desk-phone">📖 Help: Set up your own desk phone</a></div>
      </main>`;
    const on = (sel, fn) => { const el = $app.querySelector(sel); if (el) el.onclick = fn; };
    on('#myback', () => { clearInterval(S.myTimer); S.view = null; S.my.pw = null; if (S.myBack === 'home') { S.home = true; renderHome(); } else { S.home = false; render(); } });
    on('#mytophones', () => { clearInterval(S.myTimer); phonesPage(S.myBack); });
    on('#mycall', dialPad);
    on('#myreport', () => reportPhone(phones[0], ext, o ? `Riyeser Link Office last reported ${ago(o.last_seen)}` : ''));
    $app.querySelectorAll('[data-cp]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.cp); b.textContent = 'Copied'; } catch { /* select it */ } });
    const say = (h, c) => { const el = $app.querySelector('#mystat'); if (el) { el.className = `lo-stat ${c || ''}`; el.innerHTML = h; } };
    const show = async () => {
      if (S.my.pw) return S.my.pw; if (S.my.busy) return null; S.my.busy = true;
      try {
        const { kp, jwk } = await oneOffKey();
        say(`<span class="spin sm"></span> ${esc('Asking Riyeser Link Office for your password…')}`);
        const id = await api.linkMyReveal(t.id, jwk);
        const r = await followCmd(id, say, { wantReveal: true, page: 'myPhonePage' });
        if (!r) return null;
        const sealed = await api.linkRevealTake(id);
        if (!sealed) { say('That password was already shown, or 5 minutes have passed. Press Show again.', 'bad'); return null; }
        S.my.pw = await openSealed(kp, sealed); S.my.shown = true;
        $app.querySelector('#mypw').textContent = S.my.pw; $app.querySelector('#myshow').textContent = 'Hide';
        say('Shown to you only, on this screen. It isn\'t kept anywhere online.', 'ok');
        return S.my.pw;
      } catch (err) { say(esc(plainError(err)), 'bad'); return null; } finally { S.my.busy = false; }
    };
    on('#myshow', async () => {
      if (S.my.pw && S.my.shown) { S.my.shown = false; $app.querySelector('#mypw').textContent = '••••••••••••••••'; $app.querySelector('#myshow').textContent = 'Show'; return; }
      if (S.my.pw) { S.my.shown = true; $app.querySelector('#mypw').textContent = S.my.pw; $app.querySelector('#myshow').textContent = 'Hide'; return; }
      await show(); });
    on('#mycppw', async () => { const v = await show(); if (!v) return; try { await navigator.clipboard.writeText(v); $app.querySelector('#mycppw').textContent = 'Copied'; } catch { /* shown instead */ } });
    const dn = $app.querySelector('#mydnd');
    if (dn) dn.onchange = async () => {
      S.my.busy = true; const want = dn.checked;
      try { const id = await api.linkMyDnd(t.id, want); const r = await followCmd(id, phMsg, { page: 'myPhonePage' });
        if (r) { phMsg(want ? 'Do not disturb is on.' : 'Do not disturb is off.', 'ok'); if (S.my.data) S.my.data.dnd = want; } else dn.checked = !want; }
      catch (err) { phMsg(esc(plainError(err)), 'bad'); dn.checked = !want; } finally { S.my.busy = false; }
    };
  }
  // ⚙ Settings in Riyeser Link: everything about you and the business in one place.
  function settingsMenu() {
    const admin = isAdmin();
    modal(`<h3>⚙ Settings</h3><div class="lo-acts lo-set">
      <button class="btn" data-s="myphone"><b>☎ My phone</b><small>Your extension, your desk phone and how to set it up</small></button>
      ${admin ? '<button class="btn" data-s="phones"><b>☎ Desk phones</b><small>Every desk phone in the business: add, replace, troubleshoot</small></button>' : ''}
      <button class="btn" data-s="look"><b>🎨 Appearance</b><small>Dark, light or match your computer, and your accent colour</small></button>
      <button class="btn" data-s="sec"><b>🔐 Security</b><small>Two-step sign-in</small></button>
      <button class="btn" data-s="pw"><b>🔑 Change password</b><small>Your current password, then the new one</small></button>
      <button class="btn" data-s="co"><b>🏢 Company</b><small>Business details and Company ID</small></button></div>
      <div class="mfoot"><button class="btn" id="cl">Close</button></div>`, (d, close) => {
      d.querySelector('#cl').onclick = close;
      d.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => { close(); const s = b.dataset.s; const back = S.home ? 'home' : 'chat';
        if (s === 'myphone') myPhonePage(back); if (s === 'phones') phonesPage(back); if (s === 'sec') security(); if (s === 'pw') changePassword(); if (s === 'co') companyInfo(false); if (s === 'look') appearance(); });
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

    // ---- the floating phone: a call bar bottom-right on every view (chat while you call), and the incoming-call card
    function box() { let b = document.getElementById('callbox'); if (!b) { b = document.createElement('div'); b.id = 'callbox'; document.body.appendChild(b); } return b; }
    const fmtTime = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const extLine = () => { const e = call.peer ? extOf(call.peer) : call.branch ? (S.branches.find((b) => b.id === call.branch) || {}).extension : null; return e ? `Ext. ${e}` : ''; };
    function draw() {
      const b = box();
      if (!call) { b.innerHTML = ''; b.className = ''; return; }
      const who = call.peer ? nameOf(call.peer) : call.label; const ext = extLine();
      const sub = call.status === 'incoming' ? `${ext ? ext + ' · ' : ''}Incoming call${call.via ? ` to ${esc(call.via)}` : ''}`
        : call.status === 'calling' ? `${ext ? ext + ' · ' : ''}Calling${call.branch ? ' everyone' : ''}…` : call.status === 'connecting' ? 'Connecting…'
        : call.status === 'live' ? `${ext ? ext + ' · ' : ''}<span id="ctime">${fmtTime(Date.now() - call.startedAt)}</span>${call.held ? ' · <b class="chold">On hold</b>' : ''}${call.remoteHeld ? ' · <b class="chold">They put you on hold</b>' : ''}${call.sim ? ' · demo call, no sound' : ''}`
        : esc(call.note || 'Call ended');
      const live = call.status === 'live';
      b.className = 'on' + (call.status === 'incoming' ? ' ringing' : ' bar') + (call.cam || call.remoteVideo ? ' video' : '') + (call.cam && call.remoteVideo ? ' both' : '');
      const btn = (id, icon, label, extra = '') => `<button class="cb${extra}" id="${id}" title="${label}" aria-label="${label}">${ic(icon)}<span>${label}</span></button>`;
      b.innerHTML = `<div class="cwin" role="dialog" aria-label="${call.status === 'incoming' ? 'Incoming call' : 'Call'}">
        <video id="rv" autoplay playsinline ${call.remoteVideo ? '' : 'hidden'}></video><video id="lv" autoplay playsinline muted ${call.cam ? '' : 'hidden'}></video>
        <div class="cwho">${call.peer ? `<span class="lk-av">${av(call.peer, who, 'big')}</span>` : `<span class="av big lk-brav">${ic('phone')}</span>`}<div><b>${esc(who || '')}</b><small>${sub}</small></div></div>
        <div class="cbtns">${call.status === 'incoming'
          ? `<button class="cb no" id="c-dec">${ic('hang')}<span>Decline</span></button><button class="cb yes" id="c-ans">${ic('phone')}<span>Answer</span></button>`
          : call.status === 'ended' ? '' : `${btn('c-mute', call.muted ? 'micoff' : 'mic', call.muted ? 'Unmute' : 'Mute', call.muted ? ' off' : '')}
            ${btn('c-hold', 'pause', call.held ? 'Resume' : 'Hold', call.held ? ' off' : '').replace('<button', live ? '<button' : '<button disabled')}
            ${btn('c-audio', 'speaker', 'Audio')}
            ${live && !call.sim ? btn('c-cam', 'cam', call.cam ? 'Camera off' : 'Camera', call.cam ? ' off' : '') : ''}
            <button class="cb soon" id="c-xfer" disabled title="Transfer: coming soon">${ic('xfer')}<span>Transfer</span><i>soon</i></button>
            <button class="cb soon" id="c-conf" disabled title="Conference: coming soon">${ic('conf')}<span>Conference</span><i>soon</i></button>
            <button class="cb no" id="c-end" title="${live ? 'End call' : 'Cancel'}">${ic('hang')}<span>${live ? 'End call' : 'Cancel'}</span></button>`}</div>
        <audio id="ra" autoplay></audio></div>`;
      const on = (id, fn) => { const e = b.querySelector(id); if (e) e.onclick = fn; };
      on('#c-ans', answer); on('#c-dec', decline); on('#c-end', () => hangup()); on('#c-mute', mute); on('#c-cam', camera); on('#c-hold', hold); on('#c-audio', (e) => audioMenu(e.currentTarget));
      const ra = b.querySelector('#ra');
      if (call.remoteStream) { ra.srcObject = call.remoteStream; b.querySelector('#rv').srcObject = call.remoteStream; }
      ra.muted = !!call.held; if (call.sinkId && ra.setSinkId) ra.setSinkId(call.sinkId).catch(() => {});
      if (call.camTrack) b.querySelector('#lv').srcObject = new MediaStream([call.camTrack]);
      if (typeof Presence !== 'undefined' && S.team) Presence.changed();
    }
    setInterval(() => { const t = document.getElementById('ctime'); if (t && call && call.startedAt) t.textContent = fmtTime(Date.now() - call.startedAt); }, 1000);
    // Mute and Hold: on hold, your microphone and camera stop and you don't hear them; they see "On hold".
    function tracks() {
      if (!call) return;
      if (call.local) call.local.getAudioTracks().forEach((t) => { t.enabled = !call.muted && !call.held; });
      if (call.camTrack) call.camTrack.enabled = !call.held;
      const ra = document.getElementById('ra'); if (ra) ra.muted = !!call.held;
    }
    function hold() { if (!call || call.status !== 'live') return; call.held = !call.held; tracks(); if (call.peer && !call.sim) send(call.peer, 'hold', { on: call.held }); draw(); }
    // Audio: choose the microphone, and the speaker or headset where the browser allows it.
    async function audioMenu(anchor) {
      let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* no list */ }
      const ins = devs.filter((d) => d.kind === 'audioinput'); const outs = devs.filter((d) => d.kind === 'audiooutput');
      const canOut = 'setSinkId' in HTMLMediaElement.prototype;
      const curIn = call && call.local && call.local.getAudioTracks()[0] ? (call.local.getAudioTracks()[0].getSettings().deviceId || '') : '';
      const opt = (d, cur, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === cur ? ' selected' : ''}>${esc(d.label || `Device ${i + 1}`)}</option>`;
      popMenu(anchor, `<div class="mh">Audio</div><form class="mform" id="audf"><label><span>Microphone</span><select id="ain">${ins.map((d, i) => opt(d, curIn, i)).join('') || '<option>Default microphone</option>'}</select></label>
        ${canOut ? `<label><span>Speaker or headset</span><select id="aout">${outs.map((d, i) => opt(d, (call && call.sinkId) || 'default', i)).join('') || '<option value="">Default speaker</option>'}</select></label>` : '<p class="mnote">This browser plays calls through your default speaker. Change it in Windows sound settings.</p>'}</form>`, (d) => {
        d.querySelector('#ain').onchange = async (e) => {
          if (!call || !call.local) return;
          try { const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: e.target.value }, echoCancellation: true, noiseSuppression: true } });
            const nt = st.getAudioTracks()[0]; const old = call.local.getAudioTracks()[0];
            const snd = call.pc && call.pc.getSenders().find((x) => x.track && x.track.kind === 'audio'); if (snd) await snd.replaceTrack(nt);
            if (old) { call.local.removeTrack(old); old.stop(); } call.local.addTrack(nt); tracks();
          } catch { tell('That microphone couldn\'t be used. Check it\'s plugged in.'); } };
        const ao = d.querySelector('#aout'); if (ao) ao.onchange = async (e) => { if (!call) return; call.sinkId = e.target.value; const ra = document.getElementById('ra');
          try { if (ra && ra.setSinkId) await ra.setSinkId(call.sinkId); } catch { tell('That speaker couldn\'t be used.'); } };
      }, 'audmenu');
    }

    async function mic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser can\'t make calls. Use Riyeser Central, Chrome or Edge.');
      try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
      catch (e) { throw new Error('Riyeser Link needs your microphone for calls. Allow it when asked (or in the browser\'s site settings), then try again.'); }
    }

    // ---- start a call to a person ({user}) or a branch ({branch})
    async function start(t) {
      if (!S.features.calls) return upsell();
      if (call && call.status !== 'ended') return;
      let targets; let label;
      if (t.branch) { const b = S.branches.find((x) => x.id === t.branch); if (!b) return;
        targets = b.people.filter((u) => u !== S.user.id); label = b.name;
        if (!targets.length) return tell(`Nobody else is in ${b.name} yet. Add people under ⚙ Branches and extensions.`); }
      else { targets = [t.user]; label = nameOf(t.user); }
      call = { id: uuid(), dir: 'out', status: 'calling', targets: new Set(targets), label, branch: t.branch || null, peer: t.user || null, pendingIce: [], wantVideo: !!(t.video && t.user), at: new Date().toISOString() };
      draw();
      try { call.local = await mic(); } catch (e) { call = null; draw(); return tell(e.message); }
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
        if (pc.connectionState === 'connected' && call.status !== 'live') { call.status = 'live'; call.startedAt = Date.now(); stopTone(); draw(); if (call.wantVideo && !call.cam) { call.wantVideo = false; camera(); } }
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
        if (Presence.status() === 'dnd') {   // Do not disturb: they hear "can't take the call", you see it as missed
          api.signal(S.team.id, sig.call_id, from, 'decline').catch(() => {});
          logCall({ id: sig.call_id, dir: 'in', peer: from, at: new Date().toISOString(), dur: 0, result: 'missed', via: pl.via || null }); return;
        }
        call = { id: sig.call_id, dir: 'in', status: 'incoming', peer: from, via: pl.via || null, pendingIce: [], at: new Date().toISOString() };
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
      if (k === 'hold' && from === call.peer) { call.remoteHeld = !!pl.on; draw(); return; }
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
    function mute() { if (!call || !call.local) return; call.muted = !call.muted; tracks(); draw(); }
    async function camera() {
      if (!call || !call.pc) return;
      const tx = call.pc.getTransceivers().find((t) => (t.receiver.track && t.receiver.track.kind === 'video'));
      if (!tx) return;
      if (call.cam) { await tx.sender.replaceTrack(null); call.camTrack && call.camTrack.stop(); call.camTrack = null; call.cam = false; draw(); return; }
      try { const v = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }); call.camTrack = v.getVideoTracks()[0];
        await tx.sender.replaceTrack(call.camTrack); call.cam = true; tracks(); draw(); }
      catch { tell('Riyeser Link couldn\'t use your camera. Check it\'s plugged in and allowed.'); }
    }

    // ---- end: tidy up, and (caller only) leave a note in the direct message
    async function finish(note, missed) {
      if (!call) return;
      const c = call; call = null; stopTone(); clearTimeout(c.timeout);
      const result = c.startedAt ? 'answered' : c.dir === 'in' ? (note === 'Declined' ? 'declined' : note === 'Answered by someone else' ? 'elsewhere' : 'missed') : note === 'Cancelled' ? 'cancelled' : 'no answer';
      try { logCall({ id: c.id, dir: c.dir, peer: c.peer || null, branch: c.branch || null, label: c.peer ? null : c.label, via: c.via || null, at: c.at || new Date().toISOString(),
        dur: c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0, result }); } catch { /* history is a nice-to-have */ }
      try { c.pc && c.pc.close(); } catch { /* closed */ }
      (c.local ? c.local.getTracks() : []).forEach((t) => t.stop()); c.camTrack && c.camTrack.stop();
      call = { ...c, status: 'ended', note, pc: null }; draw();
      setTimeout(() => { if (call && call.status === 'ended' && call.id === c.id) { call = null; draw(); } }, 2500);
      document.title = NAME; chatTitle();
      if (c.dir === 'out' && (c.peer || c.targets) && !DEMO) api.tidyCall(c.id).catch(() => {});
      if (c.dir === 'out' && c.peer) {
        const text = c.startedAt ? `📞 Call · ${fmtTime(Date.now() - c.startedAt)}` : `📞 Missed call${c.branch ? ` to ${c.label}` : ''}`;
        try { const dm = await api.openDm(S.team.id, c.peer); const m = await api.send(S.team.id, dm, text);
          if (S.ch && S.ch.id === dm && m && !S.msgs.find((x) => x.id === m.id)) { S.msgs.push(m); renderMsgs(true); }
          if (!S.chans.find((x) => x.id === dm)) { await loadChans(); renderSide(); } } catch { /* chat note is a nice-to-have */ }
      } else if (c.dir === 'out' && missed && c.branch) {
        const g = S.chans.find((x) => x.name === 'general'); if (g) api.send(S.team.id, g.id, `📞 Missed call to ${c.label}`).catch(() => {});
      }
    }

    function alertIncoming() {
      const who = nameOf(call.peer) + (extOf(call.peer) ? ` (ext. ${extOf(call.peer)})` : '');
      document.title = `📞 Incoming call from ${who}`;
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification(NAME, { body: `Incoming call from ${who}${call.via ? ` (${call.via})` : ''}`, icon: 'icon-192.png' }); } catch { /* no notifications */ }
    }

    function listen() {
      if (listening === S.user.id) return; listening = S.user.id;
      api.onSignals(S.user.id, (sig) => onSignal(sig).catch((e) => console.warn('call', e)));
      try { if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true }); } catch { /* no notifications */ }
    }
    return { start, listen, hold, get current() { return call; } };
  })();

  // ------------------------------------------------------------------ start
  async function start() {
    try {
      const s = await api.session();
      if (!s) { const gone = S.signedOutNote; S.signedOutNote = false;
        if (AUTH.error) { const why = AUTH.errorText; AUTH.error = ''; clearAuthLink();
          return gate('in', `<div class="err">${/expired|invalid/i.test(why) || !why ? 'That link has expired or has already been used. Sign in, or press Forgot password? for a new link.' : esc(why)}</div>`); }
        return gate(params.has('signup') ? 'up' : 'in', gone ? '<div class="err">That sign-in has ended (the account may have been removed). Sign in again, or create a new account.</div>' : ''); }
      S.user = s.user; Theme.fromAccount(S.user);
      S.home = (!DEMO || params.has('help')) && !/Electron/.test(navigator.userAgent) && !params.has('chat');
      const [still, lv, teams] = await Promise.all([api.stillThere(), api.aal().catch(() => ({ currentLevel: 'aal1', nextLevel: 'aal1' })), api.teams(S.user.id).catch((e) => e)]);
      if (!still) return start();
      S.aal = lv.currentLevel;
      if (lv.nextLevel === 'aal2' && lv.currentLevel !== 'aal2') return codeScreen();
      if (AUTH.recovery) return newPasswordScreen();   // the reset link: choose a new password first
      if (AUTH.confirmed) { AUTH.confirmed = false; return confirmedScreen(); }
      if (teams instanceof Error) throw teams;
      S.teams = teams;
      touchActivity();
      const jc = (params.get('join') || '').toUpperCase();
      if (jc && !S.teams.some((t) => t.invite_code === jc || t.company_code === jc)) return setupTeam();
      if (!S.teams.length && !jc) { const closed = (await api.closedBusinesses().catch(() => []))[0]; if (closed) return closedScreen(closed); }
      if (!S.teams.length) { const r = (await api.myRequests().catch(() => []))[0];
        if (r && r.status === 'pending') return waiting(r.company_name);
        const d = (S.user.user_metadata || {}).riyeser_signup;
        if (d && d.you && !jc && !d.joining) {   // details given when the account was made: set it up now, no second form
          try { await api.createTeam(d.biz || d.you, d.you, { kind: d.biz ? 'business' : 'personal', country: d.country || '', phone: d.phone || '', email: d.email || S.user.email || '',
            legal_name: d.legal_name || '', tax_number: d.tax_number || '', address: d.address || '' });
            S.teams = await api.teams(S.user.id); if (S.teams.length) return loadTeam(S.teams[0].id);
          } catch (err) { return setupTeam(`<div class="err">${esc(plainError(err))}</div>`); }
        }
        return setupTeam(); }
      let last = null; try { last = localStorage.getItem('riyeser.team.last'); } catch { /* private mode */ }
      await loadTeam(S.teams.some((t) => t.id === last) ? last : S.teams[0].id);
    } catch (e) { $app.className = 'acct'; $app.innerHTML = `<div class="gate"><div class="gcard"><div class="glogo"><img src="/assets/logo-r.png" alt="">Riyeser</div><div class="err">${esc(plainError(e))}</div><button class="btn p w" onclick="location.reload()">Try again</button></div></div>`; }
  }
  // Once per visit (at most hourly): tells Riyeser the account is in use, so it isn't closed for being inactive.
  function touchActivity() {
    let due = true; const k = 'riyeser.active.' + S.user.id;
    try { due = Date.now() - Number(localStorage.getItem(k) || 0) > 3600e3; if (due) localStorage.setItem(k, String(Date.now())); } catch { /* private mode */ }
    if (due) Promise.resolve().then(() => api.touch()).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ch && S.user) { api.markRead(S.ch.id, S.user.id); S.unread[S.ch.id] = 0; renderSide(); } });
  setInterval(async () => { if (S.team && isAdmin() && !document.hidden) { const n = (await api.pendingRequests(S.team.id).catch(() => S.requests)) || []; if (n.length !== S.requests.length) { S.requests = n; renderSide(); } } }, 60000);
  window.RiyeserTeam = { state: S, demo: DEMO, calls: Calls, companyInfo, peopleAccess, joinRequests, security, showHistory, getHelp, reportIssue, requestRefund, phonesPage, myPhonePage, settingsMenu,
    presence: Presence, theme: Theme, appearance, newChat, changePassword };
  api.onAuth((ev) => { if (ev === 'PASSWORD_RECOVERY') AUTH.recovery = true; });
  start();
})();
