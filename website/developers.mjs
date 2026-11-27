// riyeser.com/developers/: the developer docs for Riyeser online connections (the public API, webhooks and the
// booking widget), written from the API contract (docs/api/openapi.yaml on feat/online-api, and the api_* part of
// team/team-chat.sql). build.mjs turns each entry into a page with the site's header and footer.
// Keep it plain: the first page is for business owners ("send this page to your web developer").

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const code = (lang, text) => `<div class="dcode"><div class="dlab"><span>${esc(lang)}</span><button type="button" class="dcopy" aria-label="Copy the ${esc(lang)} example">Copy</button></div><pre><code>${esc(text.replace(/^\n/, '').replace(/\s+$/, ''))}</code></pre></div>`;
const table = (head, rows) => `<div class="dtw"><table class="dtab"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const c = (s) => `<code>${esc(s)}</code>`;

export const DEV_PAGES = [
  ['index', 'Overview', 'Connect your website to Riyeser'],
  ['api', 'API reference', 'Endpoints, errors and limits'],
  ['webhooks', 'Webhooks', 'Hear about bookings, orders and stock'],
  ['widget', 'Booking widget', 'Copy-paste booking and enquiry forms'],
];

export function developerPages({ API, EMAIL, WIDGET_JS }) {
  const K = 'rk_test_0123456789abcdef0123456789abcdef0123456789abcdef';
  const W = 'rk_pub_live_0123456789abcdef0123456789abcdef0123456789abcdef';
  const curl = (m, path, body, idem) => `curl ${m === 'GET' ? '' : `-X ${m} `}"${API}${path}" \\\n  -H "Authorization: Bearer $RIYESER_KEY"${body ? ` \\\n  -H "Content-Type: application/json"${idem ? ` \\\n  -H "Idempotency-Key: ${idem}"` : ''} \\\n  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}'` : ''}`;
  const js = (m, path, body, idem) => `const res = await fetch("${API}${path}", {${m === 'GET' ? '' : `\n  method: "${m}",`}
  headers: {
    Authorization: \`Bearer \${process.env.RIYESER_KEY}\`,${body ? `\n    "Content-Type": "application/json",${idem ? `\n    "Idempotency-Key": "${idem}",` : ''}` : ''}
  },${body ? `\n  body: JSON.stringify(${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}),` : ''}
});
const data = await res.json();
if (!res.ok) throw new Error(\`\${data.error.code}: \${data.error.message}\`);`;
  const accepted = (kind) => JSON.stringify({ id: '6f1c2a90-1d1e-4c55-9b7e-1a2b3c4d5e6f', kind, status: 'waiting', test: true, created_at: '2026-11-26T21:04:11.520Z' }, null, 2);
  const person = { name: 'Mele Tui', email: 'mele@example.com', phone: '+679 999 1234' };

  const ENDPOINTS = [
    { id: 'ping', m: 'GET', path: '/v1/ping', scope: 'none (key optional)', lic: '–', sum: 'Check the API, and with a key which business and permissions it has. A good first call.',
      resp: { ok: true, version: '2026-11-26', workspace_id: '2b1f…', key: { name: 'Website shop', kind: 'secret', mode: 'test', scopes: ['orders:write', 'prices:read'] } } },
    { id: 'bookings', m: 'POST', path: '/v1/bookings', scope: 'bookings:write', lic: 'Riyeser Bookings', sum: 'Ask for a booking. It goes to the business\'s post box; a PC running Riyeser Bookings files it.',
      body: { service: 'CUT', staff: 'amy', start: '2026-12-01T09:30:00+12:00', party_size: 1, customer: person, notes: 'First visit', reference: 'WEB-1042' }, idem: 'web-booking-1042', resp202: 'booking',
      fields: [['service*', 'SKU of a published service'], ['staff', 'Staff ref (leave out for "anyone")'], ['start*', 'Date-time with a time zone; not in the past, within 2 years. Use a start time from /v1/availability/slots.'], ['end', 'After start. Filled in from the service\'s length if left out.'], ['party_size', '1–1000'], ['customer*', 'A person (below): name, and email or phone'], ['notes', 'Up to 2000 characters'], ['location', 'Up to 200'], ['reference', 'Your own reference, up to 64'], ['metadata', 'Up to 20 keys of short text, numbers or true/false']] },
    { id: 'orders', m: 'POST', path: '/v1/orders', scope: 'orders:write', lic: 'Riyeser POS or Accounting', sum: 'Send an online order. It lands in POS\'s order queue (or as an invoice in Accounting).',
      body: { reference: 'SHOP-5531', customer: person, currency: 'USD', items: [{ sku: 'CAKE-CHOC', quantity: 2, unit_price: 45 }, { name: 'Birthday candles', quantity: 1, unit_price: 3.5 }], fulfilment: { type: 'pickup', time: '2026-12-02T15:00:00+12:00' }, payment: { status: 'paid', method: 'card', amount: 93.5, provider: 'stripe', transaction_id: 'pi_3Q…' }, totals: { total: 93.5 } },
      idem: 'SHOP-5531', resp202: 'order',
      fields: [['reference', 'Your order number, up to 64'], ['customer*', 'A person'], ['currency', '3 letters'], ['items*', '1–200 lines: sku and/or name*, quantity* (> 0), unit_price, tax_rate (0–100), notes, options'], ['fulfilment', 'type* pickup | delivery | dine_in | shipping | digital; time, address, table, notes'], ['payment', 'status* paid | unpaid | part_paid; method, amount, currency, provider, transaction_id'], ['totals', 'subtotal, tax, shipping, discount, total'], ['notes', 'Up to 2000'], ['metadata', 'As above']] },
    { id: 'enquiries', m: 'POST', path: '/v1/enquiries', scope: 'enquiries:write', lic: 'any Riyeser program', sum: 'A question or quote request from a contact form.',
      body: { customer: person, subject: 'Quote for a bathroom', message: 'Can you quote for replacing a shower and vanity?', preferred_contact: 'phone', preferred_time: 'Weekday mornings', source_page: 'https://www.example.com/contact' }, idem: 'contact-7f3a', resp202: 'enquiry',
      fields: [['customer*', 'A person'], ['subject', 'Up to 200'], ['message*', 'Up to 5000'], ['service', 'SKU it\'s about'], ['preferred_contact', 'email | phone | any'], ['preferred_time', 'Up to 120'], ['source_page', 'The page it was sent from'], ['metadata', 'As above']] },
    { id: 'customers', m: 'POST', path: '/v1/customers', scope: 'customers:write', lic: 'any Riyeser program', sum: 'Add or update a customer (a sign-up or newsletter form). Matched on external_id, then email, then phone.',
      body: { name: 'Mele Tui', email: 'mele@example.com', external_id: 'cust_8812', marketing_consent: true, tags: ['newsletter'] }, idem: 'cust_8812-signup', resp202: 'customer',
      fields: [['name*', 'Up to 120'], ['email / phone', 'At least one'], ['company, address, notes', 'As for a person'], ['external_id', 'Your id, up to 64'], ['marketing_consent', 'true / false'], ['tags', 'Up to 20 of up to 40 characters']] },
    { id: 'quotes', m: 'POST', path: '/v1/quotes/{ref}/accept', scope: 'quotes:write', lic: 'any Riyeser program', sum: 'A customer accepts a quote online. {ref} is the quote number from Riyeser.',
      ex: '/v1/quotes/Q-1088/accept', body: { accepted_by: { name: 'Mele Tui', email: 'mele@example.com', position: 'Owner' }, signature: 'Mele Tui', po_number: 'PO-77', options: ['opt-2'] }, idem: 'Q-1088-accept', resp202: 'quote_accept',
      fields: [['accepted_by*', 'name*, email, phone, position'], ['signature', 'The typed name, up to 200'], ['po_number', 'Up to 64'], ['note', 'Up to 1000'], ['options', 'Optional lines chosen'], ['accepted_at', 'Date-time']] },
    { id: 'payments', m: 'POST', path: '/v1/invoices/{ref}/payments', scope: 'payments:write', lic: 'any Riyeser program', sum: 'Record a payment your website took for an invoice. Riyeser never drops one: an unknown invoice is kept as an unallocated payment.',
      ex: '/v1/invoices/INV-2207/payments', body: { amount: 250, currency: 'USD', method: 'card', provider: 'stripe', transaction_id: 'ch_3Q…', payer: { name: 'Mele Tui', email: 'mele@example.com' } }, idem: 'ch_3Q-INV-2207', resp202: 'invoice_payment',
      fields: [['amount*', '> 0'], ['currency', '3 letters'], ['paid_at', 'Date-time (default: now)'], ['method*', 'card | bank_transfer | paypal | stripe | cash | direct_debit | other'], ['provider, transaction_id', 'Up to 40 / 100'], ['payer', 'name, email'], ['note', 'Up to 1000']] },
    { id: 'events', m: 'GET', path: '/v1/events/{id}', scope: 'any key of the business (a widget key: only its own)', lic: '–', sum: 'What happened to something you sent: waiting, taken (a PC is filing it), done, failed or rejected, and the business\'s reference and message.',
      ex: '/v1/events/6f1c2a90-1d1e-4c55-9b7e-1a2b3c4d5e6f', resp: { id: '6f1c2a90-1d1e-4c55-9b7e-1a2b3c4d5e6f', kind: 'booking', status: 'done', test: false, created_at: '2026-11-26T21:04:11.520Z', updated_at: '2026-11-26T21:05:02.118Z', result: { reference: 'BK-1042', state: 'confirmed', message: 'See you on Tuesday at 9:30.' } } },
    { id: 'catalog', m: 'GET', path: '/v1/catalog', scope: 'catalog:read', lic: 'any Riyeser program', sum: 'Products and services the business publishes. Query: type=product|service, updated_since, sku=A,B, limit (1–500), after.',
      ex: '/v1/catalog?type=product&limit=2', resp: { items: [{ sku: 'CAKE-CHOC', type: 'product', name: 'Chocolate cake', description: null, category: 'Cakes', price: 45, currency: 'USD', tax_rate: 15, tax_included: true, unit: 'each', duration_minutes: null, active: true, updated_at: '2026-11-26T08:00:00Z' }], next: 'CAKE-LEMON', updated_at: '2026-11-26T08:00:00Z', test: false } },
    { id: 'prices', m: 'GET', path: '/v1/prices', scope: 'prices:read', lic: 'any Riyeser program', sum: 'Prices of active items. Query: sku, limit, after.', ex: '/v1/prices?sku=CAKE-CHOC',
      resp: { items: [{ sku: 'CAKE-CHOC', name: 'Chocolate cake', price: 45, currency: 'USD', tax_rate: 15, tax_included: true }], next: null, updated_at: '2026-11-26T08:00:00Z', test: false } },
    { id: 'stock', m: 'GET', path: '/v1/stock', scope: 'stock:read', lic: 'Riyeser POS or Accounting', sum: 'Stock levels. Query: sku, limit, after.', ex: '/v1/stock?sku=CAKE-CHOC',
      resp: { items: [{ sku: 'CAKE-CHOC', quantity: 6, in_stock: true, updated_at: '2026-11-26T09:12:00Z' }], next: null, updated_at: '2026-11-26T09:12:00Z', test: false } },
    { id: 'availability', m: 'GET', path: '/v1/availability', scope: 'availability:read', lic: 'Riyeser Bookings', sum: 'What can be booked: services, staff and the booking rules.',
      resp: { timezone: 'Pacific/Fiji', slot_minutes: 15, min_notice_minutes: 60, days_ahead: 30, updated_at: '2026-11-26T09:00:00Z', services: [{ sku: 'CUT', name: 'Haircut', description: null, category: 'Hair', duration_minutes: 30, price: 35, currency: 'USD' }], staff: [{ ref: 'amy', name: 'Amy', services: [] }], test: false } },
    { id: 'slots', m: 'GET', path: '/v1/availability/slots', scope: 'availability:read', lic: 'Riyeser Bookings', sum: 'Free start times for one service. Query: service* (SKU), from (YYYY-MM-DD in the business\'s time zone; default today), days (1–31, default 7), staff, party_size.',
      ex: '/v1/availability/slots?service=CUT&from=2026-12-01&days=7', resp: { timezone: 'Pacific/Fiji', service: 'CUT', duration_minutes: 30, from: '2026-11-30T12:00:00Z', to: '2026-12-07T12:00:00Z', slots: [{ start: '2026-11-30T21:30:00.000Z', end: '2026-11-30T22:00:00.000Z', local_start: '2026-12-01T09:30', staff: ['amy'], capacity: 1 }], test: false } },
  ];
  const ERRORS = [['401', 'missing_key, invalid_key, key_revoked', 'No key, a wrong key, or a revoked key.'], ['402', 'plan_required, bookings_licence_required, pos_or_accounting_licence_required', 'The business\'s Riyeser plan doesn\'t include this (trials count).'],
    ['403', 'missing_scope, origin_not_allowed, secret_key_in_browser, ip_not_allowed, business_closed', 'The key may not do this, or not from here.'], ['400', 'invalid_json, invalid_request, invalid_idempotency_key', 'The request itself is wrong.'],
    ['404 / 405', 'not_found, method_not_allowed', ''], ['409', 'idempotency_conflict, slot_not_available', 'The same Idempotency-Key with a different body; or that booking time has gone (ask for slots again).'],
    ['413 / 415', 'payload_too_large, unsupported_media_type', 'Bodies up to 64 KB of JSON.'], ['422', 'invalid_payload', 'Some fields are wrong: see details[] (up to 20), each {field, message}.'],
    ['429', 'rate_limited, daily_limit', 'Too many requests: wait Retry-After seconds.'], ['503', 'unavailable', 'Try again shortly with the same Idempotency-Key.']];
  const nav = (id) => `<aside class="hside"><h4>Developers</h4>${DEV_PAGES.map(([p, l]) => `<a href="${p === 'index' ? './' : `${p}.html`}"${p === id ? ' class="on" aria-current="page"' : ''}>${esc(l)}</a>`).join('')}
    ${id === 'api' ? `<div class="toc"><h4 style="margin-top:6px">On this page</h4><a href="#conventions">Conventions</a><a href="#errors">Errors</a><a href="#idempotency">Idempotency</a><a href="#limits">Rate limits</a>${ENDPOINTS.map((e) => `<a href="#${e.id}">${esc(e.m)} ${esc(e.path)}</a>`).join('')}</div>` : ''}</aside>`;
  const mobileNav = (id) => `<nav class="dnav" aria-label="Developer docs">${DEV_PAGES.map(([p, l]) => `<a href="${p === 'index' ? './' : `${p}.html`}"${p === id ? ' class="on" aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</nav>`;
  const COPY = `<script>/* copy buttons on the code examples */document.querySelectorAll('.dcopy').forEach(function(b){b.addEventListener('click',function(){var t=b.closest('.dcode').querySelector('code').textContent;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1500)},function(){})})})</script>`;
  const wrap = (id, inner) => `<div class="c hpage dev">${nav(id)}<div class="dmain">${mobileNav(id)}<div class="crumbs"><a href="${id === 'index' ? './' : './'}">Developers</a>${id === 'index' ? '' : ` › ${esc(DEV_PAGES.find((p) => p[0] === id)[1])}`}</div>${inner}</div></div>${COPY}`;

  const overview = wrap('index', `
<h1>Connect your website to Riyeser</h1>
<div class="downer"><h2>For business owners</h2><p>Your website or online shop can send bookings, orders and enquiries straight into Riyeser, and show your prices, stock and free booking times. You don't need to understand this page: <b>send it to your web developer</b>.</p>
<ol><li>In <a href="/link/">Riyeser Link</a>, open <b>Management → Connections</b> (owners and admins, with two-step sign-in).</li><li>For a booking form on your website, open <b>Add to your website</b> and copy the code. No developer needed.</li><li>For anything else, click <b>+ New key</b>, choose what it's for, and give the key to your developer (safely: not by email).</li></ol>
<p class="dnote">What your website sends waits in your <b>post box</b> until a PC running Riyeser collects it and files it in Bookings, POS or Accounting. Keep at least one PC with Riyeser on during opening hours.</p></div>
<h2 id="how">How it works</h2>
<p>A website <b>sends</b> things (a booking, an order, an enquiry, a customer, a quote acceptance, an invoice payment). Each goes into the business's post box with status <code>waiting</code>. A PC running Riyeser <b>collects</b> it, files it, and marks it <code>done</code> (with a reference and a message for the customer) or <code>rejected</code>. Your website can check with <a href="api.html#events">GET /v1/events/{id}</a>, or get a <a href="webhooks.html">webhook</a>.</p>
<p>What a website <b>reads</b> (products, prices, stock, services, staff and free times) is a copy the business's PCs publish, never its books. Each answer says when it was last published (<code>updated_at</code>).</p>
<h2 id="keys">Getting a key</h2>
${table(['Key', 'Looks like', 'Use it'], [['Secret, live', c('rk_live_…'), 'On your server only. Real bookings, orders and payments.'], ['Secret, test', c('rk_test_…'), 'On your server while you build. What it sends shows in Riyeser as a <b>test</b>, never as a real booking or sale; reads give the real published data.'], ['Widget, live / test', c('rk_pub_live_…') + ' ' + c('rk_pub_test_…'), 'In a public web page (the <a href="widget.html">booking widget</a> or your own form). Only reads free times and sends bookings and enquiries, only from the websites listed on the key.']])}
<p>Owners and admins make keys in Riyeser Link: <b>Management → Connections → API keys → + New key</b>. Each key has permissions (scopes), and optionally a list of websites and internet addresses it works from. <b>A key is shown once</b>: Riyeser keeps only a fingerprint (SHA-256). Lost it? Revoke it and make another.</p>
${table(['Scope', 'Lets the key'], [['bookings:write', 'POST /v1/bookings'], ['orders:write', 'POST /v1/orders'], ['enquiries:write', 'POST /v1/enquiries'], ['customers:write', 'POST /v1/customers'], ['quotes:write', 'POST /v1/quotes/{ref}/accept'], ['payments:write', 'POST /v1/invoices/{ref}/payments'], ['availability:read', 'GET /v1/availability, /v1/availability/slots'], ['catalog:read', 'GET /v1/catalog'], ['prices:read', 'GET /v1/prices'], ['stock:read', 'GET /v1/stock']].map(([a, b]) => [c(a), esc(b)]))}
<h2 id="auth">Authentication</h2><p>Send the key in the <code>Authorization</code> header on every request. JSON in and out.</p>
${code('HTTP', `GET /functions/v1/api/v1/ping HTTP/1.1\nHost: ${new URL(API).host}\nAuthorization: Bearer ${K}`)}
<h2 id="quick">Quick start</h2><p>Base address: <code>${esc(API)}</code></p>
${code('curl', `export RIYESER_KEY=${K}\n${curl('GET', '/v1/ping')}`)}
${code('JavaScript (Node 18+)', js('GET', '/v1/ping'))}
${code('Answer', JSON.stringify(ENDPOINTS[0].resp, null, 2))}
<h2 id="test">Test mode</h2><p>Use a test key (<code>rk_test_…</code> or <code>rk_pub_test_…</code>) while you build. Everything works the same and every answer says <code>"test": true</code>. What you send shows in Riyeser as a test, so the business can see your flow working without a fake booking in its calendar. Test widget keys may also list <code>http://localhost:3000</code>-style addresses. Switch to a live key when you go live.</p>
<h2 id="next">Next</h2><ul class="dlist"><li><a href="api.html">API reference</a>: every endpoint with curl and JavaScript, errors, idempotency and limits.</li><li><a href="webhooks.html">Webhooks</a>: events, retries, and checking the signature (Node and PHP).</li><li><a href="widget.html">Booking widget</a>: one line of HTML for a booking form, an enquiry form or an order button.</li></ul>
<p class="muted">Questions? <a href="/link/?contact">Contact Riyeser support</a> or email <a href="mailto:${EMAIL}">${EMAIL}</a>. Machine-readable contract: OpenAPI 3.1 (ask support for the file).</p>`);

  const endpoint = (e) => {
    const path = e.ex || e.path;
    return `<section class="dend" id="${e.id}"><h3><span class="dm dm-${e.m.toLowerCase()}">${e.m}</span> <code>${esc(e.path)}</code></h3><p>${esc(e.sum)}</p>
      <p class="dmeta"><span>Scope: <b>${esc(e.scope)}</b></span><span>Needs: <b>${esc(e.lic)}</b></span></p>
      ${e.fields ? table(['Field', 'What'], e.fields.map(([f, w]) => [c(f), esc(w)])) : ''}
      ${code('curl', curl(e.m, path, e.body, e.idem))}${code('JavaScript', js(e.m, path, e.body, e.idem))}
      ${code(e.resp202 ? 'Answer: 202 Accepted (200 with Idempotent-Replayed: true on a repeat)' : 'Answer: 200', e.resp202 ? accepted(e.resp202) : JSON.stringify(e.resp, null, 2))}</section>`;
  };
  const api = wrap('api', `<h1>API reference</h1><p class="dlead">Base address <code>${esc(API)}</code>. Every request needs <code>Authorization: Bearer &lt;key&gt;</code> (except <code>/v1/ping</code>).</p>
<h2 id="conventions">Conventions</h2><ul class="dlist"><li>JSON in and out (<code>Content-Type: application/json</code>), bodies up to 64 KB.</li><li>Every answer has <code>X-Request-Id</code> (quote it to support), <code>Cache-Control: no-store</code> and <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>, <code>RateLimit-Reset</code>.</li>
<li>Strings are trimmed and control characters removed. <b>Unknown fields are dropped</b>: put extras in <code>metadata</code> (up to 20 keys of short text, numbers or true/false).</li><li>Date-times must carry a time zone (<code>2026-12-01T09:30:00+12:00</code> or <code>…Z</code>) and come back as UTC. Emails are lower-cased, currencies upper-cased. Money: a number ≥ 0 with up to 4 decimals.</li>
<li>A <b>person</b> is <code>{name*, email, phone, company, address: {line1, line2, city, region, postcode, country}, notes}</code>. Bookings, orders, enquiries and customers need an email or a phone.</li>
<li>Lists (<code>/v1/catalog</code>, <code>/v1/prices</code>, <code>/v1/stock</code>) come in pages sorted by SKU: <code>{items, next, updated_at, test}</code>. Ask again with <code>after=&lt;next&gt;</code> until <code>next</code> is <code>null</code>.</li>
<li>Sending something answers <b>202 Accepted</b> with <code>Location: /v1/events/{id}</code>. It is in the post box, not yet in the business's books: check <a href="#events">/v1/events/{id}</a> or use <a href="webhooks.html">webhooks</a>.</li></ul>
<h2 id="errors">Errors</h2><p>Always <code>{"error": {"code", "message", "details"?}}</code>. Show <code>message</code> to people if you like: it's plain English. Act on <code>code</code>.</p>
${table(['HTTP', 'code', 'Meaning'], ERRORS.map(([h, cs, m]) => [esc(h), cs.split(', ').map(c).join(' '), esc(m)]))}
${code('422 example', JSON.stringify({ error: { code: 'invalid_payload', message: 'Some details need fixing.', details: [{ field: 'customer.email', message: "customer.email doesn't look like an email address." }] } }, null, 2))}
<h2 id="idempotency">Idempotency</h2><p>Send an <code>Idempotency-Key</code> header on every POST (up to 100 of <code>A-Z a-z 0-9 . _ : -</code>), for example your order number, or a UUID made once per attempt. If the connection drops or you get a 503, send the same request again with the same key: you get the first answer again (<code>200</code> with <code>Idempotent-Replayed: true</code>) and nothing is sent twice. The same key with a different body is <code>409 idempotency_conflict</code>. Key order and spacing in the JSON don't matter. Keys are kept 90 days, per API key.</p>
<h2 id="limits">Rate limits</h2>${table(['Limit', 'Per'], [['120 requests a minute', 'secret key'], ['60 requests a minute', 'widget key'], ['20 requests a minute', 'visitor internet address, on widget keys'], ['20 000 requests a day', 'business']])}
<p>Over a limit: <code>429</code> (<code>rate_limited</code> or <code>daily_limit</code>) with <code>Retry-After</code> in seconds. Watch <code>RateLimit-Remaining</code>. Cache reads (<code>updated_at</code> tells you when the data last changed).</p>
<h2 id="endpoints">Endpoints</h2>${table(['Method and path', 'Scope', 'Needs'], ENDPOINTS.map((e) => [`<a href="#${e.id}">${esc(e.m)} ${esc(e.path)}</a>`, esc(e.scope), esc(e.lic)]))}
${ENDPOINTS.map(endpoint).join('')}`);

  const NODE = `// Express: keep the raw body for the signature check
import crypto from "node:crypto";
import express from "express";

const app = express();
const SECRET = process.env.RIYESER_WEBHOOK_SECRET; // whsec_…
const seen = new Set(); // use your database in real life

app.post("/riyeser-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("Riyeser-Signature") || "";
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  const expected = crypto.createHmac("sha256", SECRET).update(\`\${parts.t}.\${req.body}\`).digest();
  const given = Buffer.from(parts.v1 || "", "hex");
  const fresh = Math.abs(Date.now() / 1000 - t) < 300;
  if (!fresh || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(400).send("bad signature");
  }
  const event = JSON.parse(req.body);
  if (!seen.has(event.id)) {          // a delivery can come more than once
    seen.add(event.id);
    console.log(event.type, event.data); // booking.received, order.ready, …
  }
  res.sendStatus(200);                // answer 2xx within 10 seconds
});
app.listen(3000);`;
  const PHP = `<?php
$secret = getenv('RIYESER_WEBHOOK_SECRET'); // whsec_…
$raw = file_get_contents('php://input');
$header = $_SERVER['HTTP_RIYESER_SIGNATURE'] ?? '';
$parts = [];
foreach (explode(',', $header) as $p) { [$k, $v] = array_pad(explode('=', $p, 2), 2, ''); $parts[$k] = $v; }
$t = (int)($parts['t'] ?? 0);
$expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
if (abs(time() - $t) >= 300 || !hash_equals($expected, $parts['v1'] ?? '')) {
  http_response_code(400); exit('bad signature');
}
$event = json_decode($raw, true);
// de-duplicate on $event['id'], then handle $event['type'] and $event['data']
http_response_code(200);`;
  const hooks = wrap('webhooks', `<h1>Webhooks</h1><p class="dlead">Riyeser tells your systems when something happens: a booking or order comes in, a booking is confirmed, an order is ready, stock changes. Owners and admins add endpoints in <b>Management → Connections → Webhooks</b>, choose the events, and get a signing secret (<code>whsec_…</code>, shown once).</p>
<h2 id="events">Events</h2>${table(['Event', 'When', 'data'], [['booking.received, order.received, enquiry.received, quote.accepted, payment.received', 'The API took it in', c('{event_id, kind, source, payload}')], ['booking.confirmed, booking.cancelled, order.ready, order.completed', 'The business said so in Riyeser', 'The business\'s details (e.g. ' + c('{reference, state, message, start, end}') + ') plus ' + c('event_id') + ' and ' + c('external_reference') + ' (your reference) when it came through the API'], ['stock.changed', 'A stock publish changed quantities', c('{items: [{sku, quantity, previous}]}') + ' (up to 500)'], ['ping', 'Send test', c('{message: "Hello from Riyeser"}')]].map(([a, b, d]) => [a.split(', ').map(c).join(' '), esc(b), d]))}
<p>Webhooks are live or test: test ones get what test keys send. Customers have no webhook yet.</p>
<h2 id="delivery">What we send</h2>${code('HTTP', `POST /riyeser-webhook HTTP/1.1
Content-Type: application/json
User-Agent: Riyeser-Webhooks/1
Riyeser-Event: booking.received
Riyeser-Delivery: 0b5d8a1e-…
Riyeser-Signature: t=1764190000,v1=5f2b…

{"id":"6f1c2a90-…","type":"booking.received","created_at":"2026-11-26T21:04:11.520Z","test":false,
 "data":{"event_id":"6f1c2a90-…","kind":"booking","source":"widget","payload":{"service":"CUT","start":"2026-11-30T21:30:00.000Z","customer":{"name":"Mele Tui","phone":"+679 999 1234"}}}}`)}
<ul class="dlist"><li>Answer with any <b>2xx within 10 seconds</b>. Redirects aren't followed.</li><li>Otherwise we try again after 1, 5 and 30 minutes, then 2, 6, 12 and 24 hours (8 tries), then mark it failed.</li><li>An endpoint failing for 3 days is <b>turned off</b>; the owner sees why and turns it back on after fixing it.</li><li>A delivery may arrive more than once: ignore repeats using <code>id</code> (the same for every webhook that gets that event).</li><li>Only public https addresses (no localhost, internal names or bare IP addresses).</li></ul>
<h2 id="verify">Checking the signature</h2><p><code>Riyeser-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where <code>v1</code> is HMAC-SHA256 of <code>"&lt;t&gt;.&lt;raw body&gt;"</code>, keyed with the whole secret string (<code>whsec_…</code>, as UTF-8). Use the raw body exactly as received (before parsing JSON), compare in constant time, and refuse a <code>t</code> more than 5 minutes away.</p>
${code('Node.js', NODE)}${code('PHP', PHP)}
<p><b>Check your code:</b> secret <code>whsec_test</code>, body <code>{"id":"1"}</code> and <code>t</code> <code>1700000000</code> give<br><code class="dbreak">v1=11bf4466ea17c3df3fd743af0b435368e16b7a05eb8eced85e8c4670767bdec5</code></p>
<p><b>Send test</b> (in Connections) sends a <code>ping</code> event to the endpoint, and <b>Deliveries</b> shows every try with your answer's status.</p>`);

  const widget = wrap('widget', `<h1>Booking widget</h1><p class="dlead">One line of HTML puts a booking form on any website: the customer picks a service, a person (if you like), a day and a free time, types their details, and the booking request goes straight to Riyeser. It works on WordPress, Wix, Squarespace, Shopify or plain HTML.</p>
<div class="downer"><h2>For business owners</h2><p>In Riyeser Link open <b>Management → Connections → Add to your website</b>. It makes the key, lets you choose the colour, shows a preview and gives you the code to paste into your website (an "HTML" or "Embed code" block). That's all.</p></div>
<h2 id="embed">Embed it</h2>${code('HTML', `<script src="${WIDGET_JS}" data-key="${W}" async></script>`)}
<p>The form appears where the script is (or in the element named by <code>data-target</code>). It needs a <b>widget key</b> (<code>rk_pub_…</code>) that lists your website's address, like <code>https://www.example.com</code> (add <code>https://*.example.com</code> for every subdomain). The key is meant to be public: it can only read free times and send bookings and enquiries, only from the websites on the key, and every widget booking must be one of the free times and arrives for the business to confirm.</p>
<h2 id="try">Try it</h2><p>A preview with sample services and times (nothing is sent):</p><div class="dwidget" id="demo">
<script src="../widget/book.js" data-demo data-accent="#1f62f0"></script></div>
<h2 id="options">Options</h2>${table(['Attribute', 'What it does'], [['data-key', 'Your widget key (needed)'], ['data-type', c('booking') + ' (default), ' + c('enquiry') + ' (a contact / quote request form) or ' + c('order') + ' (an order button for one product)'], ['data-service', 'Start with this service (its SKU)'], ['data-sku, data-name, data-price, data-currency', 'For the order button: the product'], ['data-label', 'The order button\'s text (default "Order")'], ['data-accent', 'Your colour, as a hex code: ' + c('#0f766e')], ['data-theme', c('auto') + ' (default: follows the visitor\'s light or dark setting), ' + c('light') + ' or ' + c('dark')], ['data-target', 'A CSS selector to show it in, e.g. ' + c('#booking')]].map(([a, b]) => [a.split(', ').map(c).join(' '), b]))}
<h2 id="enquiry">Enquiry form and order button</h2>${code('HTML', `<!-- a contact / quote request form -->
<script src="${WIDGET_JS}" data-key="${W}" data-type="enquiry" async></script>

<!-- an "Order" button for one product -->
<script src="${WIDGET_JS}" data-key="${W}" data-type="order"
  data-sku="CAKE-CHOC" data-name="Chocolate cake" data-price="45" data-currency="USD" async></script>`)}
<p>The order button sends an <b>order request</b> (as an enquiry with the product, quantity and price shown): the business confirms it and takes payment. A full online shop with payment sends real orders from its server with a secret key (<a href="api.html#orders">POST /v1/orders</a>).</p>
<h2 id="flow">What happens</h2><ol class="dlist"><li>The widget asks <code>GET /v1/availability</code> for services and staff, then <code>GET /v1/availability/slots</code> for free start times (7 days at a time).</li><li>It sends <code>POST /v1/bookings</code> with an <code>Idempotency-Key</code> made once per attempt: pressing "Try again" after a dropped connection never books twice.</li><li>It shows "Booking request sent", then checks <code>GET /v1/events/{id}</code> for a minute and shows "confirmed" and the business's message if it comes.</li><li>If the time has just gone (<code>409 slot_not_available</code>) it shows fresh times. Other problems get a plain message: no free times this week, online booking not on the business's plan, too many tries, or "couldn't reach the booking system".</li></ol>
<h2 id="csp">If your website has a Content-Security-Policy</h2><p>Allow the script and the API:</p>${code('CSP', `script-src 'self' https://riyeser.com;\nconnect-src 'self' ${new URL(API).origin};`)}<p>The widget draws inside a shadow DOM with its own styles, so your page's styles don't change it and it doesn't change your page.</p>
<h2 id="privacy">Privacy and accessibility</h2><ul class="dlist"><li>No cookies, no local storage, no tracking, no third parties: it talks only to the Riyeser API, and only sends what the visitor types when they press the button.</li><li>Keyboard and screen-reader friendly: real buttons and labels, the current step is announced, errors are read out and point to the field.</li><li>Works on phones: large touch targets, no sideways scrolling.</li></ul>
<h2 id="own">Building your own form instead</h2><p>Use a widget key from your page's JavaScript with the same three calls (<a href="api.html#availability">availability</a>, <a href="api.html#slots">slots</a>, <a href="api.html#bookings">bookings</a>). Answers refused before the key is known (a wrong key, too many requests) have no CORS headers, so the browser shows a network error: say "Couldn't reach the booking system, try again".</p>`);

  return [
    { path: 'developers/index.html', title: 'Developers — Riyeser online connections', description: 'Connect a website or online shop to Riyeser: send bookings, orders and enquiries, read prices, stock and free times. Keys, test mode and a quick start.', body: overview },
    { path: 'developers/api.html', title: 'API reference — Riyeser developers', description: 'Every Riyeser API endpoint with curl and JavaScript examples, errors, idempotency and rate limits.', body: api },
    { path: 'developers/webhooks.html', title: 'Webhooks — Riyeser developers', description: 'Riyeser webhooks: events, deliveries and retries, and checking the signature in Node.js and PHP.', body: hooks },
    { path: 'developers/widget.html', title: 'Booking widget — Riyeser developers', description: 'Put a Riyeser booking form, enquiry form or order button on any website with one line of HTML.', body: widget },
  ];
}
