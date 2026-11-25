// The customer's copy of a Riyeser invoice or receipt, drawn from the copy the database kept when it was issued
// (billing_documents.doc in team-chat.sql). Riyeser home (Billing) and Riyeser HQ both use this, so staff see exactly
// what the customer sees. Print or Save as PDF with the browser's Print. No libraries.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => `US$${Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const longDay = (d) => (d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const CSS = `.printdoc { background: #fff; color: #111827; border-radius: 10px; padding: 26px; font-size: 14px; line-height: 1.45; }
.pd-head { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; border-bottom: 2px solid #111827; padding-bottom: 14px; margin-bottom: 14px; }
.pd-from b { font-size: 18px; } .pd-title { text-align: right; } .pd-title h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: .5px; color: #111827; }
.pd-to { margin: 0 0 16px; } .pd-to small { display: block; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: .6px; }
.pd-lines { width: 100%; border-collapse: collapse; margin: 0 0 16px; } .pd-lines th { text-align: left; border-bottom: 1px solid #9ca3af; padding: 6px 4px; font-size: 12px; color: #4b5563; }
.pd-lines td { padding: 7px 4px; border-bottom: 1px solid #e5e7eb; } .pd-lines .num { text-align: right; white-space: nowrap; }
.pd-total td { font-weight: 800; font-size: 16px; border-bottom: 2px solid #111827; }
.pd-pay { background: #f3f4f6; border-radius: 8px; padding: 10px 12px; } .pd-pay > b { display: block; margin-bottom: 4px; }
.pd-stamp { display: inline-block; border: 3px solid #15803d; color: #15803d; font-weight: 900; letter-spacing: 3px; padding: 4px 12px; border-radius: 6px; transform: rotate(-4deg); margin: 16px 0 0; }
.pd-foot { color: #6b7280; margin-top: 14px; font-size: 12.5px; }
@media (max-width: 520px) { .printdoc { padding: 16px; } .pd-title { text-align: left; } }`;
  if (typeof document !== 'undefined' && !document.getElementById('billdoc-css')) {
    const st = document.createElement('style'); st.id = 'billdoc-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  function seller(s) {
    s = s || {}; const lines = [s.address, s.tax_number ? `${s.tax_label || 'ABN'} ${s.tax_number}` : '', s.email].filter((x) => String(x || '').trim());
    return `<div class="pd-from"><b>${esc(s.name || 'Riyeser')}</b>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  }
  function buyer(b) {
    b = b || {}; const c = b.contact || {};
    const lines = [b.address, b.tax_number ? `Tax number ${b.tax_number}` : '', b.email, b.company_code ? `Riyeser ID ${b.company_code}` : '', c.name ? `Contact: ${c.name}` : ''].filter(Boolean);
    return `<div class="pd-to"><small>Bill to</small><b>${esc(b.legal_name || b.name || '')}</b>${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  }
  const table = (rows, total, label) => `<table class="pd-lines"><tr><th>Description</th><th class="num">US$</th></tr>${rows.map((r) => `<tr><td>${esc(r.text)}</td><td class="num">${Number(r.amount).toFixed(2)}</td></tr>`).join('')}
    <tr class="pd-total"><td>${label}</td><td class="num">${money(total)}</td></tr></table>`;
  // d: the kept copy. opt.paid (an invoice that has since been paid) and opt.paidAt add the PAID stamp.
  function html(d, opt = {}) {
    if (d.kind === 'receipt') {
      return `<div class="pd-head">${seller(d.seller)}<div class="pd-title"><h1>Receipt</h1><div>No. <b>${esc(d.ref)}</b></div><div>Paid ${longDay(d.issued_at)}</div>${d.order_ref ? `<div>For invoice ${esc(d.order_ref)}</div>` : ''}</div></div>
        ${buyer(d.buyer)}${table(d.lines || [], d.total, 'Paid (US dollars)')}
        <div class="pd-pay"><b>Paid by ${d.method === 'paypal' ? 'PayPal' : 'bank transfer'}</b>${d.method_ref ? `<div>Reference ${esc(d.method_ref)}</div>` : ''}${d.period_to ? `<div>Paid until ${longDay(d.period_to)}</div>` : ''}</div>
        <p class="pd-stamp">PAID</p><p class="pd-foot">Thank you for using Riyeser.</p>`;
    }
    const bank = (d.seller && d.seller.bank) || {}; const has = !!String(bank.account_number || '').trim();
    return `<div class="pd-head">${seller(d.seller)}<div class="pd-title"><h1>Invoice</h1><div>No. <b>${esc(d.ref)}</b></div><div>Date ${longDay(d.issued_at)}</div>${d.due_date ? `<div>Due ${longDay(d.due_date)}</div>` : ''}</div></div>
      ${buyer(d.buyer)}${table(d.lines || [], d.total, 'Total to pay (US dollars)')}
      <div class="pd-pay"><b>How to pay: bank transfer</b>${has ? [['Account name', bank.account_name], ['Bank', bank.bank_name], ['BSB', bank.bsb], ['Account number', bank.account_number], ['SWIFT / BIC', bank.swift]].filter(([, v]) => String(v || '').trim()).map(([k, v]) => `<div>${k}: <b>${esc(v)}</b></div>`).join('') + (bank.note ? `<div>${esc(bank.note)}</div>` : '') : '<div>Riyeser will email you the bank details.</div>'}
        <div>Reference: <b>${esc(d.reference || d.ref)}</b> (please quote it so we can match your payment)</div></div>
      ${opt.paid ? `<p class="pd-stamp">PAID${opt.paidAt ? ` ${longDay(opt.paidAt)}` : ''}</p>` : ''}<p class="pd-foot">Thank you for using Riyeser.</p>`;
  }
  window.RiyeserBillDoc = { html, money, longDay };
})();
