/* The hosted booking page: riyeser.com/book/<address> (also riyeser.com/book/?b=<address>).
   Every Riyeser Bookings business can switch one on in Riyeser Link → Management → Connections → Booking page.
   It reads the business's public profile from the Riyeser API (GET /v1/pages/<address>: name, logo, colour, address,
   opening hours, services, staff, time zone), then the same flow as the booking widget (widget/book.js):
   service → (who) → day → time → details → POST /v1/pages/<address>/bookings, and follows the request
   (GET …/events/<id>) for a minute. No key is needed: the address finds the business's own page key on the server.
   No cookies, no tracking, nothing loaded from anywhere but riyeser.com and the API. What a customer types is sent
   only when they press "Request booking", and only to that business.
   /book/demo is a sample (nothing is sent); ?preview shows the owner's unsaved look (from Riyeser Link, this browser). */
(function () {
  'use strict';
  var API = '__RIYESER_API__';
  var doc = document;
  var BASE = doc.body.getAttribute('data-base') || '/';
  var app = doc.getElementById('app');
  var live = doc.getElementById('live');
  var POLL = Math.max(2000, +(new URLSearchParams(location.search).get('poll') || 10000));

  // ---------------------------------------------------------------- small helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // "2026-12-01T09:30" (already in the business's time zone) -> pieces, shown without converting
  function parts(local) { var m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(local || '') || []; return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4] || 0, mi: +m[5] || 0, day: (local || '').slice(0, 10) }; }
  function utcOf(p) { return new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h || 0, p.mi || 0)); }
  function fmt(p, o) { try { return utcOf(p).toLocaleString(undefined, Object.assign({ timeZone: 'UTC' }, o)); } catch (e) { return p.day; } }
  function wday(day) { return fmt(parts(day), { weekday: 'short' }); }
  function dnum(day) { return fmt(parts(day), { day: 'numeric' }); }
  function mon(day) { return fmt(parts(day), { month: 'short' }); }
  function longDay(day) { return fmt(parts(day), { weekday: 'long', day: 'numeric', month: 'long' }); }
  function timeOf(hhmm) { var m = /^(\d\d):(\d\d)/.exec(hhmm || ''); return m ? fmt({ y: 2026, mo: 1, d: 1, h: +m[1], mi: +m[2] }, { hour: 'numeric', minute: '2-digit' }) : ''; }
  function timeLabel(local) { return timeOf((local || '').slice(11, 16)); }
  function today(tz) { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function addDays(day, n) { var t = utcOf(parts(day)); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function money(n, cur) { if (n == null || n === '') return ''; if (+n === 0) return 'Free'; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: +n % 1 ? 2 : 0 }).format(+n); } catch (e) { return (cur ? cur + ' ' : '') + n; } }
  function mins(n) { n = +n || 0; if (n < 60) return n + ' min'; var h = Math.floor(n / 60); var m = n % 60; return h + ' hr' + (m ? ' ' + m + ' min' : ''); }
  function initials(name) { return String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || 'B'; }
  function say(t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 30); }

  // The business's colour: buttons in it, text in it only where it reads well (at least 4.5:1) in light and in dark.
  function rgb(hex) { var h = hex.slice(1); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
  function lum(c) { var l = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }
  function ratio(a, b) { var x = lum(a); var y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(a, b, t) { return a.map(function (v, i) { return Math.round(v + (b[i] - v) * t); }); }
  function hex(c) { return '#' + c.map(function (v) { return (v + 256).toString(16).slice(1); }).join(''); }
  function readable(c, bg, toward) { for (var t = 0; t <= 1; t += 0.05) { var m = mix(c, toward, t); if (ratio(m, bg) >= 4.5) return m; } return toward; }
  function paint(colour) {
    var c = /^#[0-9a-f]{6}$/i.test(colour || '') ? rgb(colour) : rgb('#0e7c86');
    var white = [255, 255, 255]; var night = [18, 26, 44];
    var on = ratio(white, c) >= ratio([17, 24, 39], c) ? '#fff' : '#111827';
    var r = doc.documentElement.style;
    r.setProperty('--a', hex(c)); r.setProperty('--on-a', on);
    // text in the colour must read on white and on the pale tint behind chosen options (and the same in dark)
    var soft = mix(c, white, 0.88); var softDark = mix(c, night, 0.78);
    r.setProperty('--a-ink-l', hex(readable(c, soft, [0, 0, 0])));
    r.setProperty('--a-soft-l', hex(soft));
    r.setProperty('--a-dark', hex(readable(c, softDark, white)));
    r.setProperty('--a-soft-dark', hex(softDark));
  }

  // ---------------------------------------------------------------- which page
  function slugFromUrl() {
    var path = location.pathname; var root = BASE + 'book/';
    if (path.indexOf(root) === 0) { var rest = decodeURIComponent(path.slice(root.length)).replace(/\/+$/, ''); if (rest && rest !== 'index.html' && rest.indexOf('/') < 0) return rest.toLowerCase(); }
    var q = new URLSearchParams(location.search); return (q.get('b') || '').trim().toLowerCase();
  }
  var isBookPath = location.pathname.indexOf(BASE + 'book') === 0;
  var slug = slugFromUrl();
  var preview = new URLSearchParams(location.search).has('preview');

  // ---------------------------------------------------------------- the API (or the sample)
  function call(method, path, body, idem) {
    var h = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    if (idem) h['Idempotency-Key'] = idem;
    return fetch(API.replace(/\/$/, '') + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = t ? JSON.parse(t) : null; } catch (x) { /* not JSON */ }
          if (r.ok) return j || {};
          var er = (j && j.error) || {}; throw { status: r.status, code: er.code || 'http_' + r.status, message: er.message, details: er.details || [], retry: +(r.headers.get('Retry-After') || 0) };
        });
      }, function () { throw { network: true }; })
      .catch(function (e) { throw e && (e.status || e.network) ? e : { network: true }; });
  }
  var P = '/v1/pages/' + encodeURIComponent(slug);
  var real = {
    profile: function () { return call('GET', P); },
    slots: function (q) { return call('GET', P + '/slots?' + Object.keys(q).filter(function (k) { return q[k] != null && q[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&')); },
    send: function (body, idem) { return call('POST', P + '/bookings', body, idem); },
    event: function (id) { return call('GET', P + '/events/' + encodeURIComponent(id)); },
  };
  function sample(look) {
    var wait = function (v, ms) { return new Promise(function (ok) { setTimeout(function () { ok(v); }, ms || 200); }); };
    var tz = 'UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* */ }
    var t0 = today(tz); var hours = [];
    for (var i = 0; i < 7; i++) { var d = addDays(t0, i); var wd = utcOf(parts(d)).getUTCDay(); if (wd !== 0) hours.push({ day: d, open: '09:00', close: wd === 6 ? '13:00' : '17:00' }); }
    var p = Object.assign({ slug: 'demo', name: 'Harbour Hair Studio', intro: 'Cuts, colour and styling by the water. Book a time that suits you: we confirm by text.', colour: '#0e7c86', logo: null,
      address: '12 Marine Drive, Suva', phone: '+679 330 1234', timezone: tz, accepting: true,
      services: [{ sku: 'CUT', name: 'Cut & style', duration_minutes: 45, price: 45, currency: 'USD', category: 'Hair' },
        { sku: 'COLOUR', name: 'Colour', duration_minutes: 90, price: 95, currency: 'USD', category: 'Hair', description: 'Includes a wash and blow wave.' },
        { sku: 'KIDS', name: 'Kids cut', duration_minutes: 30, price: 25, currency: 'USD', category: 'Hair' },
        { sku: 'BLOW', name: 'Blow wave', duration_minutes: 30, price: 35, currency: 'USD', category: 'Styling' },
        { sku: 'CONSULT', name: 'Free consultation', duration_minutes: 15, price: 0, currency: 'USD', category: 'Styling' }],
      staff: [{ ref: 'amy', name: 'Amy', services: [] }, { ref: 'sam', name: 'Sam', services: ['CUT', 'KIDS', 'BLOW'] }], hours: hours, demo: true }, look || {});
    if (look && look.show_prices === false) p.services.forEach(function (s) { s.price = null; });
    if (look && look.show_staff === false) p.staff = [];
    if (look && look.show_contact === false) { p.address = null; p.phone = null; }
    return {
      profile: function () { return wait(p); },
      slots: function (q) { var out = []; for (var i = 0; i < (q.days || 7); i++) { var d = addDays(q.from, i); var wd = utcOf(parts(d)).getUTCDay(); if (wd === 0) continue;
        for (var h = 9; h < (wd === 6 ? 13 : 17); h++) for (var m = 0; m < 60; m += 15) if ((h * 7 + m + i * 3 + (q.staff === 'sam' ? 2 : 0)) % 4 === 0 && !(d === t0 && h < 13)) out.push({ start: d + 'T' + pad(h) + ':' + pad(m) + ':00.000Z', local_start: d + 'T' + pad(h) + ':' + pad(m), staff: [], capacity: 1 }); }
        return wait({ timezone: tz, service: q.service, slots: out }); },
      send: function () { return wait({ id: uuid(), kind: 'booking', status: 'waiting', created_at: new Date().toISOString() }, 500); },
      event: function (id) { return wait({ id: id, status: 'done', result: { state: 'pending', message: 'Thanks! This is a sample page, so nothing was sent.' } }); },
    };
  }
  function previewLook() { try { var j = JSON.parse(localStorage.getItem('riyeser.book.preview') || 'null'); return j && Date.now() - (j.at || 0) < 864e5 ? j.look : null; } catch (e) { return null; } }
  var api = preview ? sample(Object.assign({ demo: 'preview' }, previewLook() || {})) : slug === 'demo' ? sample() : real;

  // ---------------------------------------------------------------- plain words for what can go wrong
  function plain(e) {
    if (!e || e.network) return 'Couldn\'t reach the booking system. Check your internet connection and try again.';
    var c = e.code;
    if (c === 'slot_not_available') return 'Sorry, that time has just gone. Please choose another time.';
    if (c === 'rate_limited' || c === 'daily_limit') return 'Too many tries just now. Please wait ' + (e.retry > 90 ? 'about ' + Math.round(e.retry / 60) + ' minutes' : 'a minute') + ' and try again.';
    if (c === 'page_not_found' || c === 'business_closed' || c === 'bookings_licence_required' || c === 'plan_required') return 'Online booking isn\'t available for this business right now. Please contact them directly.';
    if (c === 'invalid_payload') return 'Please check the details below.';
    if (c === 'unavailable' || e.status >= 500) return 'The booking system is busy. Please try again in a moment.';
    return e.message || 'Something went wrong. Please try again.';
  }

  // ---------------------------------------------------------------- state
  var S = { p: null, svc: null, staff: '', from: null, slots: null, day: null, slot: null, form: {}, errs: {}, msg: '', sending: false, idem: null, sig: '', done: null, failed: false };
  function svc() { return S.p && (S.p.services || []).filter(function (s) { return s.sku === S.svc; })[0]; }
  function staffFor(sku) { return ((S.p && S.p.staff) || []).filter(function (x) { return !x.services || !x.services.length || x.services.indexOf(sku) >= 0; }); }
  function staffName(ref) { var x = ((S.p && S.p.staff) || []).filter(function (y) { return y.ref === ref; })[0]; return x ? x.name : ''; }
  function tz() { return (S.p && S.p.timezone) || 'UTC'; }
  function hoursFor(day) { return ((S.p && S.p.hours) || []).filter(function (h) { return h.day === day; })[0]; }

  // ---------------------------------------------------------------- drawing
  function logo(p) { return '<span class="logo" aria-hidden="true">' + (p.logo ? '<img src="' + esc(p.logo) + '" alt="">' : esc(initials(p.name))) + '</span>'; }
  function openLine(p) {
    var t = today(tz()); var h = hoursFor(t);
    if (h) return '<span class="open">Open today ' + esc(timeOf(h.open)) + '–' + esc(timeOf(h.close)) + '</span>';
    var next = ((p.hours) || []).filter(function (x) { return x.day > t; })[0];
    return (p.hours || []).length ? '<span>Closed today' + (next ? ' · opens ' + esc(wday(next.day)) + ' ' + esc(timeOf(next.open)) : '') + '</span>' : '';
  }
  function header(p) {
    return '<header class="biz">' + (p.demo ? '<span class="demo">' + (p.demo === 'preview' ? 'Preview: sample services and times. Nothing is sent.' : 'Sample booking page: nothing is sent') + '</span>' : '')
      + '<div class="bizrow">' + logo(p) + '<div style="min-width:0"><h1 id="bizname">' + esc(p.name) + '</h1><div class="meta">' + (p.address ? '<span>' + esc(p.address) + '</span>' : '') + openLine(p) + '</div></div></div>'
      + (p.intro ? '<p class="intro">' + esc(p.intro) + '</p>' : '') + '</header>';
  }
  function step(id, n, title, body, o) {
    o = o || {};
    return '<section class="step' + (o.done ? ' fin' : '') + (o.later ? ' later' : '') + '" id="' + id + '" aria-labelledby="' + id + '-h"><h2 id="' + id + '-h" tabindex="-1"><span class="n" aria-hidden="true">' + (o.done ? '✓' : n) + '</span>' + esc(title)
      + (o.chosen ? '<span class="chosen">' + esc(o.chosen) + '</span>' : '') + '</h2>' + body + '</section>';
  }
  function services() {
    var list = S.p.services || []; var cats = {}; list.forEach(function (s) { cats[s.category || ''] = 1; }); var useCats = Object.keys(cats).length > 1; var last = null;
    return '<div class="svcs" role="group" aria-labelledby="s-svc-h">' + list.map(function (s) {
      var head = useCats && (s.category || '') !== last ? '<div class="cat" aria-hidden="true">' + esc(s.category || 'Other') + '</div>' : ''; last = s.category || '';
      var price = s.price != null ? money(s.price, s.currency) : '';
      return head + '<button type="button" class="opt svc" data-svc="' + esc(s.sku) + '" aria-pressed="' + (S.svc === s.sku) + '"><b>' + esc(s.name) + '</b><small>' + esc(mins(s.duration_minutes)) + (price ? ' · ' + esc(price) : '') + '</small>'
        + (s.description ? '<span class="d">' + esc(s.description) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function dayList() {
    var by = {}; (S.slots || []).forEach(function (x) { var d = (x.local_start || '').slice(0, 10); (by[d] = by[d] || []).push(x); });
    var days = []; for (var i = 0; i < 7; i++) days.push(addDays(S.from, i));
    if (!S.day || !by[S.day]) S.day = days.filter(function (d) { return by[d]; })[0] || null;
    return { by: by, days: days };
  }
  function draw(focus) {
    var p = S.p; if (!p) return;
    readForm();
    var sv = svc(); var ppl = sv ? staffFor(sv.sku) : []; var n = 1; var h = '';
    h += step('s-svc', n++, 'Choose a service', services(), { done: !!sv, chosen: sv ? sv.name : '' });
    if (sv && ppl.length) h += step('s-who', n++, 'Who would you like?', '<div class="ppl" role="group" aria-labelledby="s-who-h"><button type="button" class="opt" data-staff="" aria-pressed="' + (!S.staff) + '">Anyone available</button>'
      + ppl.map(function (x) { return '<button type="button" class="opt" data-staff="' + esc(x.ref) + '" aria-pressed="' + (S.staff === x.ref) + '">' + esc(x.name) + '</button>'; }).join('') + '</div>', { done: true, chosen: S.staff ? staffName(S.staff) : 'Anyone' });
    if (!sv) {
      h += step('s-day', n++, 'Choose a day', '<p class="hint">Choose a service first.</p>', { later: true });
      h += step('s-time', n++, 'Choose a time', '', { later: true });
    } else if (S.slots === null) {
      h += step('s-day', n++, 'Choose a day', '<div class="days" aria-hidden="true">' + [0, 1, 2, 3, 4, 5].map(function () { return '<div class="sk" style="width:74px;height:62px;flex:none"></div>'; }).join('') + '</div><p class="hint" role="status">Finding free times…</p>');
      h += step('s-time', n++, 'Choose a time', '', { later: true });
    } else {
      var dl = dayList(); var any = dl.days.some(function (d) { return dl.by[d]; }); var t0 = today(tz());
      var nav = '<div class="daynav">' + (S.from > t0 ? '<button type="button" class="btn sm" data-a="prev">← Earlier</button>' : '') + '<button type="button" class="btn sm" data-a="next">Later dates →</button></div>';
      h += step('s-day', n++, 'Choose a day', (S.msg && !S.slot ? '<p class="note bad" role="alert">' + esc(S.msg) + '</p>' : '')
        + (any ? '<div class="days" role="group" aria-labelledby="s-day-h">' + dl.days.map(function (d) { var c = (dl.by[d] || []).length;
          return '<button type="button" class="opt" data-day="' + d + '" aria-pressed="' + (S.day === d) + '"' + (c ? '' : ' disabled') + ' aria-label="' + esc(longDay(d)) + (c ? ', ' + c + ' free time' + (c === 1 ? '' : 's') : ', no free times') + '"><b>' + esc(d === t0 ? 'Today' : wday(d)) + '</b><span>' + esc(dnum(d)) + '</span><small>' + esc(c ? mon(d) : (S.p.hours || []).length && !hoursFor(d) ? 'Closed' : 'Full') + '</small></button>'; }).join('') + '</div>' + nav
          : '<p class="note" role="status" data-none="1">No free times from ' + esc(longDay(dl.days[0])) + ' to ' + esc(longDay(dl.days[6])) + '. Try later dates' + (p.phone ? ', or call ' + esc(p.phone) : '') + '.</p>' + nav),
        { done: !!S.day && any, chosen: S.day && any ? longDay(S.day) : '' });
      var mine = ''; try { mine = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* */ }
      h += step('s-time', n++, 'Choose a time', S.day && dl.by[S.day] ? '<div class="times" role="group" aria-label="Free times on ' + esc(longDay(S.day)) + '">' + dl.by[S.day].map(function (x, i) { return '<button type="button" class="opt" data-slot="' + i + '" aria-pressed="' + (!!S.slot && S.slot.start === x.start) + '">' + esc(timeLabel(x.local_start)) + '</button>'; }).join('') + '</div>'
        + (mine && mine !== tz() ? '<p class="hint">Times are in ' + esc(tz().replace(/_/g, ' ')) + ' time.</p>' : '') : '<p class="hint">Choose a day first.</p>', { done: !!S.slot, later: !S.day, chosen: S.slot ? timeLabel(S.slot.local_start) : '' });
    }
    h += step('s-you', n++, 'Your details', S.slot ? details() : '<p class="hint">Choose a time first.</p>', { later: !S.slot });
    var main = S.done ? doneView() : '<div class="flow">' + h + '</div>';
    app.innerHTML = '<div class="grid"><main class="card" id="main">' + header(p) + main + '</main>' + aside(p) + '</div>' + foot();
    wire();
    if (focus) { var t = doc.getElementById(focus) || doc.querySelector(focus); if (t) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } scrollTo(t); } }
  }
  function scrollTo(el) { var sec = el.closest('section, .done') || el; var r = sec.getBoundingClientRect(); if (r.top < 0 || r.top > innerHeight * 0.6) { try { sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch (e) { sec.scrollIntoView(); } } }
  function summary() {
    var sv = svc(); if (!sv) return ''; var bits = ['<b>' + esc(sv.name) + '</b>'];
    if (S.staff) bits.push('with ' + esc(staffName(S.staff)));
    if (S.slot) bits.push(esc(longDay(S.slot.local_start.slice(0, 10))) + ' at ' + esc(timeLabel(S.slot.local_start)));
    bits.push(esc(mins(sv.duration_minutes)) + (sv.price != null ? ' · ' + esc(money(sv.price, sv.currency)) : ''));
    return '<p class="sum">' + bits.join(' · ') + '</p>';
  }
  function details() {
    var f = S.form; var e = S.errs;
    var fld = function (name, label, type, more) { var id = 'f-' + name;
      return '<label for="' + id + '"><span>' + label + '</span><' + (type === 'textarea' ? 'textarea' : 'input type="' + type + '"') + ' id="' + id + '" name="' + name + '"' + (more || '') + (e[name] ? ' aria-invalid="true" aria-describedby="' + id + '-e"' : '')
        + (type === 'textarea' ? '>' + esc(f[name] || '') + '</textarea>' : ' value="' + esc(f[name] || '') + '">') + (e[name] ? '<span class="fe" id="' + id + '-e">' + esc(e[name]) + '</span>' : '') + '</label>'; };
    return summary() + (S.msg ? '<p class="note bad" role="alert" tabindex="-1" id="formmsg">' + esc(S.msg) + '</p>' : '')
      + '<form novalidate>' + fld('name', 'Your name', 'text', ' autocomplete="name" maxlength="120" required')
      + '<div class="two">' + fld('phone', 'Phone <i>(phone or email)</i>', 'tel', ' autocomplete="tel" inputmode="tel" maxlength="40"') + fld('email', 'Email', 'email', ' autocomplete="email" maxlength="200"') + '</div>'
      + fld('note', 'Anything we should know? <i>(optional)</i>', 'textarea', ' maxlength="2000" rows="3"')
      + '<div class="row"><button class="btn pri" type="submit" id="send"' + (S.sending ? ' disabled' : '') + '>' + (S.sending ? 'Sending…' : S.failed ? 'Try again' : 'Request booking') + '</button></div>'
      + '<p class="fine">' + esc(S.p.name) + ' confirms your booking by text or email. What you type goes only to them.</p></form>';
  }
  function doneView() {
    var r = S.done || {}; var res = r.result || {}; var st = res.state || ''; var ok = st === 'confirmed';
    var bad = st === 'cancelled' || r.status === 'rejected';
    return '<div class="done" role="status"><span class="tick' + (ok || bad ? '' : ' wait') + '" aria-hidden="true">' + (bad ? '!' : ok ? '✓' : '✓') + '</span><h2 tabindex="-1" id="donehead">'
      + (ok ? 'Booking confirmed' : bad ? 'This time couldn\'t be booked' : 'Booking request sent') + '</h2>' + summary()
      + '<p>' + esc(res.message || (ok ? 'See you then.' : bad ? 'Please choose another time or contact ' + S.p.name + '.' : S.p.name + ' will confirm your booking soon, by text or email.')) + '</p>'
      + (res.reference ? '<p class="hint">Reference: <span class="ref">' + esc(res.reference) + '</span></p>' : '')
      + '<div class="row"><button type="button" class="btn" data-a="again">Make another booking</button></div></div>';
  }
  function aside(p) {
    var t0 = today(tz()); var list = ''; var hrs = p.hours || [];
    if (hrs.length) { for (var i = 0; i < 7; i++) { var d = addDays(t0, i); var h = hoursFor(d);
      list += '<li' + (d === t0 ? ' class="today"' : '') + '><span>' + esc(d === t0 ? 'Today' : fmt(parts(d), { weekday: 'long' })) + '</span><span>' + (h ? esc(timeOf(h.open)) + '–' + esc(timeOf(h.close)) : 'Closed') + '</span></li>'; } }
    var rows = (p.address ? '<div><dt>Address</dt><dd>' + esc(p.address) + '<br><a href="https://www.google.com/maps/search/?api=1&amp;query=' + encodeURIComponent(p.name + ', ' + p.address) + '" rel="noopener noreferrer" target="_blank">Open in Maps</a></dd></div>' : '')
      + (p.phone ? '<div><dt>Phone</dt><dd><a href="tel:' + esc(String(p.phone).replace(/[^0-9+]/g, '')) + '">' + esc(p.phone) + '</a></dd></div>' : '')
      + (list ? '<div><dt>Opening hours</dt><dd><ul class="hours">' + list + '</ul></dd></div>' : '');
    return '<aside class="side" aria-label="About ' + esc(p.name) + '">' + (rows ? '<section class="card about"><h2>' + esc(p.name) + '</h2><dl>' + rows + '</dl></section>' : '')
      + '<section class="card trust"><span>Free times come straight from ' + esc(p.name) + '\'s calendar. You\'ll get a confirmation by text or email.</span><span>No account needed. No cookies or tracking.</span></section></aside>';
  }
  function foot() { return '<footer class="foot">Online booking by <a href="' + BASE + '">Riyeser</a> · <a href="' + BASE + 'terms.html">Terms</a></footer>'; }

  // ---------------------------------------------------------------- the pages that aren't the booking flow
  function message(o) {
    app.innerHTML = '<main class="card msg" id="main">' + (o.p ? logo(o.p) : '<span class="logo" aria-hidden="true">R</span>') + '<h1 tabindex="-1" id="msghead">' + esc(o.title) + '</h1><p>' + esc(o.text) + '</p>'
      + (o.p && (o.p.phone || o.p.address) ? '<div class="contact">' + (o.p.phone ? '<a href="tel:' + esc(String(o.p.phone).replace(/[^0-9+]/g, '')) + '">' + esc(o.p.phone) + '</a>' : '') + (o.p.address ? '<span>' + esc(o.p.address) + '</span>' : '') + '</div>' : '')
      + (o.retry ? '<button type="button" class="btn pri" data-a="reload">Try again</button>' : '') + (o.home ? '<a class="btn" href="' + BASE + '">Go to riyeser.com</a>' : '') + '</main>' + foot();
    wire(); doc.title = o.title + ' · Riyeser';
    var hd = doc.getElementById('msghead'); if (hd && o.focus) hd.focus();
  }
  function notTaking(p) {
    message({ p: p, title: p ? p.name + ' isn\'t taking online bookings right now' : 'This business isn\'t taking online bookings here',
      text: p ? 'Please contact them directly to book.' : 'The address may be mistyped, or the business has switched online booking off. Please contact the business directly.', home: !p });
  }
  function loading() {
    app.innerHTML = '<div class="grid" aria-busy="true"><main class="card"><div class="biz"><div class="bizrow"><div class="sk" style="width:56px;height:56px;border-radius:14px"></div><div style="flex:1;display:grid;gap:8px"><div class="sk" style="height:22px;width:60%"></div><div class="sk" style="height:14px;width:40%"></div></div></div></div>'
      + '<div class="flow"><div class="step"><div class="sk" style="height:18px;width:40%"></div><div class="svcs">' + [0, 1, 2, 3].map(function () { return '<div class="sk" style="height:62px"></div>'; }).join('') + '</div></div></div></main>'
      + '<div class="card about"><div class="sk" style="height:18px;width:50%"></div><div class="sk" style="height:90px"></div></div></div><p class="sr" role="status">Loading the booking page…</p>';
  }

  // ---------------------------------------------------------------- doing
  function readForm() { Array.prototype.forEach.call(app.querySelectorAll('form [name]'), function (i) { S.form[i.name] = i.value; }); }
  function check() {
    var f = S.form; var e = {};
    if (!(f.name || '').trim()) e.name = 'Please type your name.';
    if (!(f.phone || '').trim() && !(f.email || '').trim()) e.phone = 'Please give a phone number or an email address.';
    if ((f.email || '').trim() && !/^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(f.email.trim())) e.email = 'That email doesn\'t look right.';
    if ((f.phone || '').trim() && !/^[0-9 +().-]{5,40}$/.test(f.phone.trim())) e.phone = 'Use numbers, spaces and + ( ) - only.';
    return e;
  }
  function fieldOf(path) { return /email/.test(path) ? 'email' : /phone/.test(path) ? 'phone' : /name/.test(path) ? 'name' : /notes?/.test(path) ? 'note' : ''; }
  function submit() {
    readForm(); S.errs = check(); S.msg = '';
    if (Object.keys(S.errs).length) { S.msg = 'Please check the details below.'; draw(); var bad = app.querySelector('[aria-invalid=true]'); if (bad) bad.focus(); say(S.msg); return; }
    var f = S.form; var c = { name: f.name.trim() }; if ((f.email || '').trim()) c.email = f.email.trim(); if ((f.phone || '').trim()) c.phone = f.phone.trim();
    var body = { service: S.svc, start: S.slot.start, customer: c }; if (S.slot.end) body.end = S.slot.end; if (S.staff) body.staff = S.staff; if ((f.note || '').trim()) body.notes = f.note.trim();
    var sig = JSON.stringify(body);
    if (!S.idem || sig !== S.sig) { S.idem = uuid(); S.sig = sig; }   // the same key when the same request is tried again
    S.sending = true; draw(); say('Sending…');
    api.send(body, S.idem).then(function (r) {
      S.sending = false; S.failed = false; S.done = r; S.idem = null; draw('donehead'); say('Booking request sent');
      if (r.id) poll(r.id, 0);
    }, function (e) {
      S.sending = false; S.failed = true; S.msg = plain(e);
      if (e.code === 'invalid_payload') { (e.details || []).forEach(function (d) { var k = fieldOf(d.field || ''); if (k) S.errs[k] = d.message; else S.msg += ' ' + d.message; }); S.idem = null; }
      if (e.code === 'slot_not_available') { S.idem = null; S.slot = null; loadSlots('s-day-h', true); return; }
      if (e.code === 'idempotency_conflict') S.idem = null;
      draw('formmsg'); say(S.msg);
    });
  }
  function poll(id, n) {
    if (n >= 6) return;
    setTimeout(function () {
      if (!S.done || S.done.id !== id) return;
      api.event(id).then(function (ev) {
        if (!S.done || S.done.id !== id) return;
        if (ev && ev.result && (ev.result.state || ev.result.message)) { var was = JSON.stringify(S.done.result || {}); S.done.result = ev.result; S.done.status = ev.status;
          if (JSON.stringify(ev.result) !== was) { draw(); say(doc.getElementById('donehead').textContent); } }
        if (!ev || ev.status === 'waiting' || ev.status === 'taken' || (ev.result && ev.result.state === 'pending')) poll(id, n + 1);
      }, function () { poll(id, n + 1); });
    }, POLL);
  }
  function loadSlots(focus, keepMsg) {
    S.slots = null; S.slot = null; S.day = null; if (!keepMsg) S.msg = ''; draw();
    api.slots({ service: S.svc, from: S.from, days: 7, staff: S.staff || null }).then(function (r) {
      S.slots = r.slots || []; draw(focus); say(S.slots.length ? S.slots.length + ' free times' : 'No free times on these days');
    }, function (e) { S.slots = []; S.msg = plain(e); draw(focus); say(S.msg); });
  }
  function wire() {
    var on = function (sel, fn) { Array.prototype.forEach.call(app.querySelectorAll(sel), function (b) { b.onclick = function () { fn(b); }; }); };
    on('[data-svc]', function (b) { S.svc = b.getAttribute('data-svc'); S.staff = ''; S.msg = ''; S.from = today(tz()); loadSlots(staffFor(S.svc).length ? 's-who-h' : 's-day-h'); });
    on('[data-staff]', function (b) { S.staff = b.getAttribute('data-staff'); loadSlots('s-day-h'); });
    on('[data-day]', function (b) { S.day = b.getAttribute('data-day'); S.slot = null; draw('s-time-h'); });
    on('[data-slot]', function (b) { var dl = dayList(); S.slot = dl.by[S.day][+b.getAttribute('data-slot')]; S.msg = ''; S.errs = {}; draw('f-name'); });
    on('[data-a]', function (b) { var a = b.getAttribute('data-a');
      if (a === 'reload') start();
      if (a === 'next') { S.from = addDays(S.from, 7); loadSlots('s-day-h'); }
      if (a === 'prev') { var t0 = today(tz()); S.from = addDays(S.from, -7) < t0 ? t0 : addDays(S.from, -7); loadSlots('s-day-h'); }
      if (a === 'again') { S.form = { name: S.form.name, phone: S.form.phone, email: S.form.email }; S.done = null; S.slot = null; S.svc = null; S.slots = null; S.msg = ''; draw('s-svc-h'); }
    });
    var f = app.querySelector('form'); if (f) f.onsubmit = function (e) { e.preventDefault(); if (!S.sending) submit(); };
  }
  function start() {
    loading();
    api.profile().then(function (p) {
      S.p = p; paint(p.colour);
      if (!p.accepting || !(p.services || []).length) { notTaking(p); return; }
      doc.title = 'Book with ' + p.name;
      var m = doc.querySelector('meta[name=description]'); if (m) m.setAttribute('content', 'Book online with ' + p.name + '.');
      S.from = today(tz()); draw();
    }, function (e) {
      if (e && (e.code === 'page_not_found' || e.code === 'business_closed')) notTaking(null);
      else message({ title: 'Couldn\'t load the booking page', text: plain(e), retry: true, focus: true });
    });
  }

  if (preview || slug) start();
  else if (isBookPath) message({ title: 'Book online with a Riyeser business', text: 'Ask the business for their booking link: it looks like riyeser.com/book/their-name.', home: true });
  else message({ title: 'That page isn\'t here', text: 'It may have moved.', home: true });
  window.RiyeserBook = { state: S };
})();
