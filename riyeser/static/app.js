// Riyeser Accounting - line item tables, live totals, row links.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const num = v => { const n = parseFloat(String(v || "").replace(/[,$]/g, "")); return isNaN(n) ? 0 : n; };
  const money = n => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // clickable rows
  document.addEventListener("click", e => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a,button,input,select,form")) location.href = tr.dataset.href;
  });

  // confirm buttons
  document.addEventListener("submit", e => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // Generic add-row for any table.lines with a <template>
  $$("[data-add-row]").forEach(btn => btn.addEventListener("click", () => {
    const tbl = $(btn.dataset.addRow);
    const tpl = $("template", tbl.parentElement);
    tbl.tBodies[0].appendChild(tpl.content.cloneNode(true));
    recalc();
  }));
  document.addEventListener("click", e => {
    if (e.target.matches(".del-row")) {
      const tb = e.target.closest("tbody");
      if (tb.rows.length > 1) e.target.closest("tr").remove(); else $$("input", e.target.closest("tr")).forEach(i => i.value = "");
      recalc();
    }
  });

  // ---- Sales / purchase document form
  const docForm = $("#doc-form");
  const ITEMS = window.RIYESER_ITEMS || {}, CONTACTS = window.RIYESER_CONTACTS || {}, TAX = window.RIYESER_TAX || {};

  function recalc() {
    if (docForm) {
      const incl = $("#tax_inclusive", docForm).checked;
      let sub = 0, tax = 0;
      $$("#lines tbody tr", docForm).forEach(tr => {
        const q = num($("[name=line_qty]", tr).value), p = num($("[name=line_price]", tr).value);
        const d = num($("[name=line_discount]", tr).value);
        const rate = TAX[$("[name=line_tax]", tr).value] || 0;
        let gross = Math.round(q * p * (1 - d / 100) * 100) / 100, t, net;
        if (incl) { t = Math.round(gross * rate / (100 + rate) * 100) / 100; net = gross - t; }
        else { net = gross; t = Math.round(gross * rate) / 100; }
        sub += net; tax += t;
        $(".line-total", tr).textContent = money(incl ? gross : net);
      });
      $("#t-sub").textContent = money(sub); $("#t-tax").textContent = money(tax); $("#t-total").textContent = money(sub + tax);
    }
    const jf = $("#journal-form");
    if (jf) {
      let dr = 0, cr = 0;
      $$("[name=line_debit]", jf).forEach(i => dr += num(i.value));
      $$("[name=line_credit]", jf).forEach(i => cr += num(i.value));
      $("#j-dr").textContent = money(dr); $("#j-cr").textContent = money(cr);
      const diff = Math.round((dr - cr) * 100) / 100;
      $("#j-diff").textContent = diff ? "Out of balance " + money(diff) : "Balanced";
      $("#j-diff").className = diff ? "neg" : "badge paid";
    }
    const mf = $("#money-form");
    if (mf) {
      let t = 0; $$("[name=line_amount]", mf).forEach(i => t += num(i.value));
      $("#m-total").textContent = money(t);
    }
    const pf = $("#pay-form");
    if (pf) {
      let t = 0; $$("input[name^=alloc_]", pf).forEach(i => t += num(i.value));
      $("#p-total").textContent = money(t);
    }
  }
  window.riyeserRecalc = recalc;
  document.addEventListener("input", recalc);
  document.addEventListener("change", e => {
    if (e.target.name === "line_item") {
      const it = ITEMS[e.target.value], tr = e.target.closest("tr");
      if (it) {
        $("[name=line_description]", tr).value = it.name;
        $("[name=line_price]", tr).value = it.price.toFixed(2);
        if (it.account) $("[name=line_account]", tr).value = it.account;
        if (it.tax) $("[name=line_tax]", tr).value = it.tax;
        if (!$("[name=line_qty]", tr).value) $("[name=line_qty]", tr).value = 1;
      }
    }
    if (e.target.name === "line_account" && e.target.closest("#money-form, #journal-form, #lines")) {
      const opt = e.target.selectedOptions[0], tr = e.target.closest("tr"), tax = $("[name=line_tax]", tr);
      if (opt && opt.dataset.tax && tax && !tax.dataset.touched) tax.value = opt.dataset.tax;
    }
    if (e.target.name === "line_tax") e.target.dataset.touched = 1;
    if (e.target.id === "contact_id" && docForm) {
      const c = CONTACTS[e.target.value];
      if (c) {
        const dt = $("#date").value;
        if (dt) { const d = new Date(dt); d.setDate(d.getDate() + (c.terms || 0)); $("#due_date").value = d.toISOString().slice(0, 10); }
        $$("#lines tbody tr", docForm).forEach(tr => {
          const a = $("[name=line_account]", tr);
          if (c.account && !$("[name=line_item]", tr).value && !a.dataset.touched) a.value = c.account;
        });
      }
    }
    recalc();
  });
  document.addEventListener("DOMContentLoaded", recalc);
  recalc();

  // Payments: "pay in full" helper
  document.addEventListener("click", e => {
    if (e.target.matches("[data-fill]")) {
      const inp = document.getElementById(e.target.dataset.fill);
      inp.value = e.target.dataset.amount; recalc();
    }
  });
})();
