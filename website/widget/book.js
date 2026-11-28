/* Riyeser booking widget (riyeser.com/widget/book.js). No dependencies, no cookies, no tracking.
   <script src="https://riyeser.com/widget/book.js" data-key="rk_pub_live_…" async></script>
   data-type   booking (default) | enquiry | order
   data-sku    order: the product's SKU (with data-name, and optionally data-price + data-currency)
   data-service  booking/enquiry: start with this service (SKU)
   data-accent #0f766e (a hex colour)   data-theme auto (default) | light | dark
   data-target a CSS selector to show it in (default: right after the script tag)
   data-demo   sample services and times, nothing is sent (for previews)
   It talks only to the Riyeser API with the widget key; what a visitor types is sent only when they press the button.
   Docs: https://riyeser.com/developers/widget.html */
(function () {
  'use strict';
  var API = '__RIYESER_API__';
  var VERSION = '1.0.0';
  var doc = document;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
    return Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // "2026-12-01T09:30" (already in the business's time zone) -> pieces, shown without converting
  function parts(local) { var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(local || '') || []; return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], day: (local || '').slice(0, 10) }; }
  function utcOf(p) { return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h || 0, p.mi || 0)); }
  function fmt(p, o) { try { return utcOf(p).toLocaleString(undefined, Object.assign({ timeZone: 'UTC' }, o)); } catch (e) { return p.day; } }
  var dayLabel = function (p) { return fmt(p, { weekday: 'short', day: 'numeric', month: 'short' }); };
  var longDay = function (p) { return fmt(p, { weekday: 'long', day: 'numeric', month: 'long' }); };
  var timeLabel = function (p) { return fmt(p, { hour: 'numeric', minute: '2-digit' }); };
  function today(tz) { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function addDays(day, n) { var p = parts(day + 'T00:00'); var t = utcOf(p); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function money(n, cur) { if (n == null || n === '') return ''; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(+n); } catch (e) { return (cur ? cur + ' ' : '') + n; } }
  function hexOk(c) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c || ''); }
  function onColour(hex) {   // white or near-black text on the accent, whichever reads better
    var h = hex.slice(1); if (h.length === 3) h = h.replace(/./g, '$&$&');
    var l = [0, 2, 4].map(function (i) { var v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#fff' : '#111827';
  }

  // Plain messages for what can go wrong (the API's error codes)
  function plain(e, kind) {
    var what = kind === 'booking' ? 'booking' : kind === 'order' ? 'ordering' : 'enquiry';
    if (!e || e.network) return 'Couldn\'t reach the ' + what + ' system. Check your internet connection and try again.';
    var c = e.code;
    if (c === 'slot_not_available') return 'Sorry, that time has just gone. Please choose another time.';
    if (c === 'rate_limited' || c === 'daily_limit') return 'Too many tries just now. Please wait ' + (e.retry > 90 ? 'about ' + Math.round(e.retry / 60) + ' minutes' : 'a minute') + ' and try again.';
    if (c === 'plan_required' || c === 'bookings_licence_required' || c === 'pos_or_accounting_licence_required' || c === 'business_closed') return 'Online ' + what + ' isn\'t available for this business right now. Please contact them directly.';
    if (c === 'origin_not_allowed' || c === 'missing_scope' || c === 'invalid_key' || c === 'key_revoked' || c === 'missing_key' || c === 'secret_key_in_browser') return 'This form isn\'t set up for this website yet. Please contact the business directly.';
    if (c === 'invalid_payload') return 'Please check the details below.';
    if (c === 'unavailable' || e.status >= 500) return 'The ' + what + ' system is busy. Please try again in a moment.';
    return e.message || 'Something went wrong. Please try again.';
  }

  // ---- talking to the API (or the built-in sample for previews)
  function client(cfg) {
    var base = (cfg.api || API).replace(/\/$/, '');
    function call(method, path, body, idem) {
      var h = { Authorization: 'Bearer ' + cfg.key, Accept: 'application/json' };
      if (body) h['Content-Type'] = 'application/json';
      if (idem) h['Idempotency-Key'] = idem;
      return fetch(base + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
        .then(function (r) {
          return r.text().then(function (t) {
            var j = null; try { j = t ? JSON.parse(t) : null; } catch (x) { /* not JSON */ }
            if (r.ok) return j || {};
            var er = (j && j.error) || {}; throw { status: r.status, code: er.code || 'http_' + r.status, message: er.message, details: er.details || [], retry: +(r.headers.get('Retry-After') || 0) };
          });
        }, function () { throw { network: true }; })
        .catch(function (e) { throw e && (e.status || e.network) ? e : { network: true }; });   // a cut-off answer counts as no answer
    }
    if (cfg.demo) return demoClient();
    return {
      availability: function () { return call('GET', '/v1/availability'); },
      slots: function (q) { return call('GET', '/v1/availability/slots?' + Object.keys(q).filter(function (k) { return q[k] != null && q[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&')); },
      send: function (kind, body, idem) { return call('POST', kind === 'booking' ? '/v1/bookings' : '/v1/enquiries', body, idem); },
      event: function (id) { return call('GET', '/v1/events/' + encodeURIComponent(id)); },
    };
  }
  function demoClient() {
    var wait = function (v, ms) { return new Promise(function (ok) { setTimeout(function () { ok(v); }, ms || 250); }); };
    var tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* */ }
    return {
      availability: function () { return wait({ timezone: tz, slot_minutes: 30, services: [
        { sku: 'CUT', name: 'Haircut', duration_minutes: 30, price: 35, currency: 'USD' }, { sku: 'COLOUR', name: 'Colour and style', duration_minutes: 90, price: 120, currency: 'USD' },
        { sku: 'CONSULT', name: 'Free consultation', duration_minutes: 15, price: 0, currency: 'USD' }], staff: [{ ref: 'amy', name: 'Amy', services: [] }, { ref: 'sam', name: 'Sam', services: ['CUT'] }], test: true }); },
      slots: function (q) { var out = []; for (var i = 0; i < (q.days || 7); i++) { var d = addDays(q.from, i); var wd = utcOf(parts(d + 'T00:00')).getUTCDay(); if (wd === 0) continue;
        for (var h = 9; h < 17; h++) for (var m = 0; m < 60; m += 30) if ((h * 7 + m + i * 3) % 5) out.push({ start: d + 'T' + pad(h) + ':' + pad(m) + ':00.000Z', local_start: d + 'T' + pad(h) + ':' + pad(m), staff: [], capacity: 1 }); }
        return wait({ timezone: tz, service: q.service, slots: out, test: true }); },
      send: function (kind) { return wait({ id: uuid(), kind: kind, status: 'waiting', test: true, created_at: new Date().toISOString() }, 600); },
      event: function (id) { return wait({ id: id, status: 'waiting', result: {} }); },
    };
  }

  var CSS = ':host{all:initial;display:block;--a:#2563eb;--on:#fff;--bg:#fff;--fg:#0f172a;--mu:#475569;--ln:#cbd5e1;--soft:#f1f5f9;--err:#b91c1c;--ok:#15803d;color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}'
    + ':host([data-theme=dark]){--bg:#0f172a;--fg:#e5e7eb;--mu:#a7b4c8;--ln:#334155;--soft:#1e293b;--err:#fca5a5;--ok:#86efac}'
    + '@media (prefers-color-scheme:dark){:host([data-theme=auto]){--bg:#0f172a;--fg:#e5e7eb;--mu:#a7b4c8;--ln:#334155;--soft:#1e293b;--err:#fca5a5;--ok:#86efac}}'
    + '*{box-sizing:border-box}.w{background:var(--bg);border:1px solid var(--ln);border-radius:14px;padding:16px;max-width:560px;width:100%}'
    + 'h3{font-size:17px;margin:0 0 10px;outline:none}p{margin:0 0 10px}.mu{color:var(--mu);font-size:13.5px}'
    + '.opts{display:grid;gap:8px;margin:0 0 12px}.o{display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;border:1px solid var(--ln);background:var(--bg);color:inherit;border-radius:10px;padding:10px 12px;font:inherit;cursor:pointer;min-height:44px}'
    + '.o small{color:var(--mu);display:block;font-size:13px}.o[aria-pressed=true]{border-color:var(--a);box-shadow:inset 0 0 0 2px var(--a)}.o:hover{border-color:var(--a)}'
    + '.days{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.days .o{width:auto;flex:0 0 auto;display:block;text-align:center;padding:8px 10px}'
    + '.times{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;margin:0 0 12px}.times .o{justify-content:center;text-align:center}'
    + '.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--a);color:var(--on);border:0;border-radius:10px;padding:11px 18px;font:inherit;font-weight:650;cursor:pointer;min-height:44px}'
    + '.btn[disabled]{opacity:.6;cursor:default}.btn.s{background:transparent;color:var(--fg);border:1px solid var(--ln)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}'
    + ':focus-visible{outline:3px solid var(--a);outline-offset:2px}label{display:block;margin:0 0 10px;font-weight:600;font-size:14px}label i{font-style:normal;font-weight:400;color:var(--mu)}'
    + 'input,textarea,select{display:block;width:100%;margin-top:4px;font:inherit;font-weight:400;padding:10px;border:1px solid var(--ln);border-radius:8px;background:var(--bg);color:var(--fg);min-height:44px}'
    + 'textarea{min-height:84px;resize:vertical}[aria-invalid=true]{border-color:var(--err)}.fe{color:var(--err);font-weight:400;font-size:13px;display:block;margin-top:3px}'
    + '.note{border-radius:10px;padding:10px 12px;margin:0 0 12px;background:var(--soft)}.note.bad{color:var(--err);border:1px solid currentColor;background:transparent}.note.ok{border:1px solid var(--ok)}'
    + '.sum{background:var(--soft);border-radius:10px;padding:8px 12px;margin:0 0 12px;font-size:14px}.done h3{color:var(--ok)}.f{font-size:12px;color:var(--mu);margin-top:12px}.f a{color:inherit}'
    + '.qty{display:flex;align-items:center;gap:8px}.qty input{width:80px;text-align:center;margin:0}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}';

  function mount(target, opt) {
    opt = opt || {};
    var kind = opt.type === 'enquiry' || opt.type === 'order' ? opt.type : 'booking';
    var host = doc.createElement('div'); host.className = 'riyeser-widget'; host.setAttribute('data-type', kind);
    host.setAttribute('data-theme', /^(light|dark)$/.test(opt.theme || '') ? opt.theme : 'auto');
    if (target.tagName === 'SCRIPT') target.parentNode.insertBefore(host, target.nextSibling); else { target.innerHTML = ''; target.appendChild(host); }
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var accent = hexOk(opt.accent) ? opt.accent : '#2563eb';
    root.innerHTML = '<style>' + CSS + ':host{--a:' + accent + ';--on:' + onColour(accent) + '}</style><div class="w" part="widget"><div class="sr" aria-live="polite" id="live"></div><div id="b"></div></div>';
    var $b = root.getElementById ? root.getElementById('b') : root.querySelector('#b');
    var $live = root.querySelector('#live');
    if (!opt.key && !opt.demo) { $b.innerHTML = '<p class="note bad">The booking form needs a widget key (data-key).</p>'; return host; }
    var api = client(opt);
    var pollMs = +opt.poll || 10000;
    var S = { step: kind === 'booking' ? 'service' : 'details', avail: null, service: null, staff: '', from: null, slots: null, day: null, slot: null, form: {}, errs: {}, msg: '', idem: null, sig: '', sending: false, qty: 1 };
    var q = function (s) { return root.querySelector(s); };
    var qa = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };
    function say(t) { $live.textContent = ''; setTimeout(function () { $live.textContent = t; }, 30); }
    function note(t, bad) { return t ? '<p class="note' + (bad ? ' bad' : '') + '" role="' + (bad ? 'alert' : 'status') + '">' + esc(t) + '</p>' : ''; }
    function foot() { return '<p class="f">' + (opt.demo ? 'Preview: nothing is sent. ' : '') + 'Booking by <a href="https://riyeser.com" target="_blank" rel="noopener">Riyeser</a>. What you type goes only to this business.</p>'; }
    function svc() { return S.avail && S.avail.services.filter(function (s) { return s.sku === S.service; })[0]; }
    function staffFor(sku) { return ((S.avail && S.avail.staff) || []).filter(function (p) { return !p.services || !p.services.length || p.services.indexOf(sku) >= 0; }); }
    function staffName(ref) { var p = ((S.avail && S.avail.staff) || []).filter(function (x) { return x.ref === ref; })[0]; return p ? p.name : ''; }
    function summary() {
      var s = svc(); if (!s) return ''; var bits = [esc(s.name)];
      if (S.staff) bits.push('with ' + esc(staffName(S.staff)));
      if (S.slot) { var p = parts(S.slot.local_start); bits.push(esc(longDay(p)) + ' at ' + esc(timeLabel(p))); }
      return '<p class="sum">' + bits.join(' · ') + '</p>';
    }
    function draw(focus) {
      var h = '';
      if (S.step === 'loading') h = '<p class="mu">Loading…</p>';
      else if (S.step === 'fatal') h = note(S.msg, true) + '<div class="row"><button class="btn s" data-a="reload" type="button">Try again</button></div>';
      else if (S.step === 'service') {
        var list = S.avail.services || [];
        h = '<h3 tabindex="-1">What would you like to book?</h3>' + note(S.msg, true) + (list.length ? '<div class="opts" role="group" aria-label="Services">' + list.map(function (s) {
          return '<button type="button" class="o" data-svc="' + esc(s.sku) + '" aria-pressed="' + (S.service === s.sku) + '"><span>' + esc(s.name) + '<small>' + (s.duration_minutes ? s.duration_minutes + ' min' : '') + (s.description ? ' · ' + esc(s.description) : '') + '</small></span><span>' + (s.price ? esc(money(s.price, s.currency)) : s.price === 0 ? 'Free' : '') + '</span></button>';
        }).join('') + '</div>' : '<p class="note">There\'s nothing to book online just now. Please contact the business directly.</p>');
      } else if (S.step === 'staff') {
        var ppl = staffFor(S.service);
        h = summary() + '<h3 tabindex="-1">Who would you like?</h3><div class="opts" role="group" aria-label="Staff"><button type="button" class="o" data-staff="" aria-pressed="' + (!S.staff) + '"><span>Anyone available</span></button>'
          + ppl.map(function (p) { return '<button type="button" class="o" data-staff="' + esc(p.ref) + '" aria-pressed="' + (S.staff === p.ref) + '"><span>' + esc(p.name) + '</span></button>'; }).join('') + '</div><div class="row"><button type="button" class="btn s" data-a="back">Back</button></div>';
      } else if (S.step === 'time') {
        var days = {}; var order = [];
        (S.slots || []).forEach(function (x) { var d = (x.local_start || '').slice(0, 10); if (!days[d]) { days[d] = []; order.push(d); } days[d].push(x); });
        if (!S.day || !days[S.day]) S.day = order[0] || null;
        var tz = S.avail.timezone; var mine = ''; try { mine = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* */ }
        h = summary() + '<h3 tabindex="-1">When?</h3>' + note(S.msg, true)
          + (S.slots === null ? '<p class="mu">Finding available times…</p>' : !order.length ? '<p class="note" role="status" data-none="1">No available times between ' + esc(dayLabel(parts(S.from + 'T00:00'))) + ' and ' + esc(dayLabel(parts(addDays(S.from, 6) + 'T00:00'))) + '. Try the next week.</p>'
          : '<div class="days" role="group" aria-label="Days">' + order.map(function (d) { return '<button type="button" class="o" data-day="' + d + '" aria-pressed="' + (S.day === d) + '">' + esc(dayLabel(parts(d + 'T00:00'))) + '</button>'; }).join('') + '</div>'
            + '<div class="times" role="group" aria-label="Available times on ' + esc(longDay(parts(S.day + 'T00:00'))) + '">' + days[S.day].map(function (x, i) { return '<button type="button" class="o" data-slot="' + i + '" aria-pressed="' + (S.slot === x) + '">' + esc(timeLabel(parts(x.local_start))) + '</button>'; }).join('') + '</div>'
            + (tz && mine && tz !== mine ? '<p class="mu">Times are in ' + esc(tz.replace(/_/g, ' ')) + ' time.</p>' : ''))
          + '<div class="row"><button type="button" class="btn s" data-a="back">Back</button>' + (S.from > today(tz) ? '<button type="button" class="btn s" data-a="prev">Earlier</button>' : '') + '<button type="button" class="btn s" data-a="next">Next week</button></div>';
      } else if (S.step === 'details') {
        var f = S.form; var e = S.errs; var o = kind === 'order';
        var fld = function (n, label, type, more) { var id = 'f-' + n; return '<label for="' + id + '">' + label + '<' + (type === 'textarea' ? 'textarea' : 'input type="' + type + '"') + ' id="' + id + '" name="' + n + '"' + (more || '') + (e[n] ? ' aria-invalid="true" aria-describedby="' + id + '-e"' : '') + (type === 'textarea' ? '>' + esc(f[n] || '') + '</textarea>' : ' value="' + esc(f[n] || '') + '">') + (e[n] ? '<span class="fe" id="' + id + '-e">' + esc(e[n]) + '</span>' : '') + '</label>'; };
        h = (kind === 'booking' ? summary() : '') + '<h3 tabindex="-1">' + (kind === 'booking' ? 'Your details' : o ? 'Order ' + esc(opt.name || opt.sku) : 'Send an enquiry') + '</h3>'
          + (o && opt.price ? '<p class="mu">' + esc(money(opt.price, opt.currency)) + ' each</p>' : '') + note(S.msg, S.msgBad !== false)
          + '<form novalidate>' + (o ? '<label for="f-qty">How many<span class="qty"><button type="button" class="btn s" data-a="minus" aria-label="One fewer">−</button><input id="f-qty" name="qty" inputmode="numeric" value="' + S.qty + '"><button type="button" class="btn s" data-a="plus" aria-label="One more">+</button></span></label>' : '')
          + fld('name', 'Your name', 'text', ' autocomplete="name" maxlength="120" required') + fld('phone', 'Phone <i>(phone or email)</i>', 'tel', ' autocomplete="tel" maxlength="40"') + fld('email', 'Email', 'email', ' autocomplete="email" maxlength="200"')
          + (o ? fld('when', 'When would you like it? <i>(optional)</i>', 'text', ' maxlength="120" placeholder="e.g. Saturday morning, pick up"') : '')
          + (kind === 'enquiry' ? fld('message', 'Your message', 'textarea', ' maxlength="5000" required') : fld('note', 'Anything we should know? <i>(optional)</i>', 'textarea', ' maxlength="' + (o ? 1000 : 2000) + '"'))
          + '<div class="row">' + (kind === 'booking' ? '<button type="button" class="btn s" data-a="back">Back</button>' : '') + '<button class="btn" type="submit"' + (S.sending ? ' disabled' : '') + '>' + (S.sending ? 'Sending…' : S.idem && S.failed ? 'Try again' : kind === 'booking' ? 'Request booking' : o ? 'Send order request' : 'Send enquiry') + '</button></div></form>';
      } else if (S.step === 'done') {
        var r = S.done || {}; var st = (r.result && r.result.state) || '';
        h = '<div class="done" role="status"><h3 tabindex="-1">' + (st === 'confirmed' ? 'Booking confirmed' : kind === 'booking' ? 'Booking request sent' : kind === 'order' ? 'Order request sent' : 'Enquiry sent') + '</h3>'
          + (kind === 'booking' ? summary() : '') + '<p>' + esc((r.result && r.result.message) || (st === 'confirmed' ? 'See you then.' : kind === 'booking' ? 'The business will confirm your booking soon.' : 'The business will get back to you soon.')) + '</p>'
          + (r.result && r.result.reference ? '<p class="mu">Reference: ' + esc(r.result.reference) + '</p>' : '') + (r.test ? '<p class="mu">This was a test: it shows in Riyeser as a test.</p>' : '')
          + '<div class="row"><button type="button" class="btn s" data-a="again">' + (kind === 'booking' ? 'Make another booking' : kind === 'order' ? 'Order something else' : 'Send another') + '</button></div></div>';
      }
      if (kind === 'order' && S.step === 'closed') h = '<button type="button" class="btn" data-a="open">' + esc(opt.label || 'Order') + (opt.name ? ' <span class="sr">' + esc(opt.name) + '</span>' : '') + '</button>';
      $b.innerHTML = h + (S.step === 'closed' ? '' : foot());
      wire();
      if (focus) { var t = q('h3') || q('.note.bad') || q('button'); if (t) try { t.focus({ preventScroll: false }); } catch (e) { t.focus(); } }
    }
    function readForm() { qa('form [name]').forEach(function (i) { S.form[i.name] = i.value; }); var n = parseInt(S.form.qty, 10); if (n > 0) S.qty = Math.min(n, 999); }
    function check() {
      var f = S.form; var e = {};
      if (!(f.name || '').trim()) e.name = 'Please type your name.';
      if (!(f.phone || '').trim() && !(f.email || '').trim()) e.phone = 'Please give a phone number or an email address.';
      if ((f.email || '').trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'That email doesn\'t look right.';
      if ((f.phone || '').trim() && !/^[0-9 +().-]{5,40}$/.test(f.phone.trim())) e.phone = 'Use numbers, spaces and + ( ) - only.';
      if (kind === 'enquiry' && !(f.message || '').trim()) e.message = 'Please type your message.';
      return e;
    }
    function payload() {
      var f = S.form; var c = { name: f.name.trim() }; if ((f.email || '').trim()) c.email = f.email.trim(); if ((f.phone || '').trim()) c.phone = f.phone.trim();
      var page = location.origin + location.pathname;
      if (kind === 'booking') { var b = { service: S.service, start: S.slot.start, customer: c }; if (S.slot.end) b.end = S.slot.end; if (S.staff) b.staff = S.staff; if ((f.note || '').trim()) b.notes = f.note.trim(); b.metadata = { source_page: page.slice(0, 200) }; return b; }
      if (kind === 'order') {
        var nm = opt.name || opt.sku; var lines = [S.qty + ' × ' + nm + (opt.sku ? ' (' + opt.sku + ')' : '')]; if (opt.price) lines.push('Price shown: ' + money(opt.price, opt.currency) + ' each');
        if ((f.note || '').trim()) lines.push(f.note.trim());
        var o = { customer: c, subject: ('Order request: ' + S.qty + ' × ' + nm).slice(0, 200), message: lines.join('\n'), source_page: page, metadata: { order_sku: String(opt.sku || '').slice(0, 64), order_quantity: S.qty } };
        if ((f.when || '').trim()) o.preferred_time = f.when.trim(); if (opt.price) o.metadata.order_unit_price = +opt.price; if (opt.currency) o.metadata.order_currency = String(opt.currency).slice(0, 3);
        return o;
      }
      var q2 = { customer: c, message: f.message.trim(), source_page: page }; if (opt.service) q2.service = opt.service; if (opt.subject) q2.subject = String(opt.subject).slice(0, 200); return q2;
    }
    function fieldOf(path) { return /email/.test(path) ? 'email' : /phone/.test(path) ? 'phone' : /name/.test(path) ? 'name' : /message/.test(path) ? 'message' : /notes?/.test(path) ? 'note' : ''; }
    function submit() {
      readForm(); S.errs = check(); S.msg = '';
      if (Object.keys(S.errs).length) { S.msg = 'Please check the details below.'; draw(); var bad = q('[aria-invalid=true]'); if (bad) bad.focus(); return; }
      var body = payload(); var sig = JSON.stringify(body);
      if (!S.idem || sig !== S.sig) { S.idem = uuid(); S.sig = sig; }   // the same key when the same request is tried again
      S.sending = true; draw(); say('Sending…');
      api.send(kind === 'booking' ? 'booking' : 'enquiry', body, S.idem).then(function (r) {
        S.sending = false; S.failed = false; S.done = r; S.idem = null; S.step = 'done'; draw(true); say(q('h3').textContent);
        if (kind === 'booking' && r.id) poll(r.id, 0);
      }, function (e) {
        S.sending = false; S.failed = true; S.msgBad = true; S.msg = plain(e, kind);
        if (e.code === 'invalid_payload') { (e.details || []).forEach(function (d) { var k = fieldOf(d.field || ''); if (k) S.errs[k] = d.message; else S.msg += ' ' + d.message; }); S.idem = null; }
        if (e.code === 'slot_not_available') { S.idem = null; S.slot = null; S.step = 'time'; loadSlots(true); return; }
        if (e.code === 'idempotency_conflict') S.idem = null;
        draw(); say(S.msg); var x = q('.note.bad'); if (x) x.setAttribute('tabindex', '-1'), x.focus();
      });
    }
    function poll(id, n) {
      if (n >= 6) return;
      setTimeout(function () {
        if (S.step !== 'done' || !S.done || S.done.id !== id) return;
        api.event(id).then(function (ev) { if (S.step !== 'done' || !S.done || S.done.id !== id) return;
          if (ev && ev.result && (ev.result.state || ev.result.message)) { var was = JSON.stringify(S.done.result || {}); S.done.result = ev.result; S.done.status = ev.status; if (JSON.stringify(ev.result) !== was) { draw(); say(q('h3').textContent); } }
          if (!ev || ev.status === 'waiting' || ev.status === 'taken' || (ev.result && ev.result.state === 'pending')) poll(id, n + 1);
        }, function () { poll(id, n + 1); });
      }, pollMs);
    }
    function loadSlots(keepMsg) {
      S.slots = null; S.slot = null; if (!keepMsg) S.msg = ''; draw(true);
      api.slots({ service: S.service, from: S.from, days: 7, staff: S.staff || null }).then(function (r) { S.slots = r.slots || []; S.day = null; draw(); say(S.slots.length ? S.slots.length + ' available times' : 'No available times this week'); },
        function (e) { S.slots = []; S.msg = plain(e, 'booking'); draw(); say(S.msg); });
    }
    function start() {
      if (kind !== 'booking') { S.step = kind === 'order' ? 'closed' : 'details'; draw(); return; }
      S.step = 'loading'; draw();
      api.availability().then(function (a) {
        S.avail = a || { services: [] }; S.avail.services = S.avail.services || []; S.from = today(S.avail.timezone);
        if (opt.service && S.avail.services.some(function (s) { return s.sku === opt.service; })) { S.service = opt.service; S.step = staffFor(S.service).length ? 'staff' : 'time'; if (S.step === 'time') return loadSlots(); }
        else S.step = 'service';
        draw();
      }, function (e) { S.step = 'fatal'; S.msg = plain(e, 'booking'); draw(); });
    }
    function wire() {
      qa('[data-svc]').forEach(function (b) { b.onclick = function () { S.service = b.getAttribute('data-svc'); S.staff = ''; S.msg = ''; if (staffFor(S.service).length) { S.step = 'staff'; draw(true); } else { S.step = 'time'; loadSlots(); } }; });
      qa('[data-staff]').forEach(function (b) { b.onclick = function () { S.staff = b.getAttribute('data-staff'); S.step = 'time'; loadSlots(); }; });
      qa('[data-day]').forEach(function (b) { b.onclick = function () { S.day = b.getAttribute('data-day'); S.slot = null; draw(); var t = q('.times .o'); if (t) t.focus(); }; });
      qa('[data-slot]').forEach(function (b) { b.onclick = function () { var list = S.slots.filter(function (x) { return x.local_start.slice(0, 10) === S.day; }); S.slot = list[+b.getAttribute('data-slot')]; S.msg = ''; S.step = 'details'; draw(true); }; });
      qa('[data-a]').forEach(function (b) { b.onclick = function () { var a = b.getAttribute('data-a');
        if (a === 'reload') start();
        if (a === 'back') { readForm(); S.msg = ''; S.step = S.step === 'details' ? 'time' : S.step === 'time' ? (staffFor(S.service).length ? 'staff' : 'service') : 'service'; if (S.step === 'time' && !S.slots) return loadSlots(); draw(true); }
        if (a === 'next') { S.from = addDays(S.from, 7); loadSlots(); }
        if (a === 'prev') { var t0 = today(S.avail.timezone); S.from = addDays(S.from, -7) < t0 ? t0 : addDays(S.from, -7); loadSlots(); }
        if (a === 'again') { S.form = { name: S.form.name, phone: S.form.phone, email: S.form.email }; S.slot = null; S.done = null; S.qty = 1; S.msg = ''; if (kind === 'booking') { S.step = 'service'; S.slots = null; } else S.step = 'details'; draw(true); }
        if (a === 'open') { S.step = 'details'; draw(true); }
        if (a === 'minus' || a === 'plus') { readForm(); S.qty = Math.max(1, Math.min(999, S.qty + (a === 'plus' ? 1 : -1))); var i = q('#f-qty'); i.value = S.qty; say(S.qty + ''); }
      }; });
      var f = q('form'); if (f) f.onsubmit = function (e) { e.preventDefault(); if (!S.sending) submit(); };
    }
    start();
    host.riyeser = { version: VERSION, state: S };
    return host;
  }

  function fromScript(s) {
    var d = s.dataset || {}; var t = d.target ? doc.querySelector(d.target) : null;
    return mount(t || s, { key: d.key, type: d.type, sku: d.sku, name: d.name, price: d.price, currency: d.currency, service: d.service, subject: d.subject, label: d.label,
      accent: d.accent, theme: d.theme, api: d.api, demo: d.demo != null && d.demo !== 'false', poll: d.poll });
  }
  window.RiyeserWidget = window.RiyeserWidget || { version: VERSION, mount: function (el, o) { return mount(typeof el === 'string' ? doc.querySelector(el) : el, o); } };
  var me = doc.currentScript;
  if (me && (me.hasAttribute('data-key') || me.hasAttribute('data-demo')) && !me.__riyeser) {
    me.__riyeser = 1;
    if (doc.readyState === 'loading' && me.dataset.target) doc.addEventListener('DOMContentLoaded', function () { fromScript(me); }); else fromScript(me);
  }
})();
