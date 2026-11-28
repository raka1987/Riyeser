/* Print and view inside the app window (POS 2.11.1).
   The Riyeser programs run in an app window (pywebview). A link that opens a new window (target="_blank", or
   window.open) is handed to the computer's default web browser, which isn't signed in: a receipt opened the browser at
   the sign-in page. So links to Riyeser's own pages never leave the app:
     * a[data-print] and RiyeserInApp.print(url): load the page in a hidden frame; the page prints itself (receipts,
       dockets, X/Z reports) or is printed from here.
     * a[data-inapp], and any other internal link with a target (PDFs, payslips, job sheets, photos): an in-app viewer
       with Print, Save a copy and Close.
   Links to other websites (riyeser.com, maps) still open in the web browser, as they should. */
(function () {
  if (window.RiyeserInApp) return;
  const internal = href => { try { const u = new URL(href, location.href); return u.origin === location.origin; } catch (e) { return false; } };
  let frame = null;
  function print(url) {
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1; frame.title = 'Printing';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    frame.dataset.inappPrint = url;
    frame.addEventListener('load', () => {
      let w = null; try { w = frame.contentWindow; } catch (e) { /* not ours */ }
      if (!w) return;
      // our print pages print themselves when they load (body onload); others are printed from here
      let auto = false; try { auto = /print\(\)/.test(w.document.body.getAttribute('onload') || ''); } catch (e) { /* PDF */ }
      if (!auto) setTimeout(() => { try { w.focus(); w.print(); } catch (e) { view(url); } }, 300);
    });
    frame.src = url;
    document.body.appendChild(frame);
    return frame;
  }
  let box = null;
  function view(url, title) {
    if (!box) {
      box = document.createElement('div');
      box.id = 'inappViewer'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      box.innerHTML = '<div class="iv-bar"><b class="iv-t"></b><span class="iv-sp"></span>' +
        '<button type="button" class="iv-b" data-iv="print">Print</button><a class="iv-b" data-iv="save" download>Save a copy</a>' +
        '<button type="button" class="iv-b iv-x" data-iv="close" aria-label="Close">Close</button></div><iframe class="iv-f" title="Document"></iframe>';
      const st = document.createElement('style');
      st.textContent = '#inappViewer{position:fixed;inset:0;z-index:200;background:rgba(15,23,42,.55);display:flex;flex-direction:column;padding:16px}' +
        '#inappViewer .iv-bar{display:flex;align-items:center;gap:8px;background:#fff;border-radius:14px 14px 0 0;padding:10px 12px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}' +
        '#inappViewer .iv-t{font:700 15px system-ui,sans-serif;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:60%}' +
        '#inappViewer .iv-sp{flex:1}#inappViewer .iv-b{font:600 14px system-ui,sans-serif;border:1.5px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:10px;padding:8px 14px;min-height:40px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}' +
        '#inappViewer .iv-x{background:#0f172a;color:#fff;border-color:#0f172a}#inappViewer .iv-f{flex:1;border:0;background:#fff;border-radius:0 0 14px 14px;width:100%}' +
        '@media (max-width:600px){#inappViewer{padding:0}#inappViewer .iv-bar,#inappViewer .iv-f{border-radius:0}}';
      document.head.appendChild(st);
      document.body.appendChild(box);
      box.addEventListener('click', e => {
        const b = e.target.closest('[data-iv]'); if (!b) return;
        if (b.dataset.iv === 'close') { box.hidden = true; box.querySelector('iframe').src = 'about:blank'; }
        if (b.dataset.iv === 'print') { try { const w = box.querySelector('iframe').contentWindow; w.focus(); w.print(); } catch (err) { window.print(); } }
      });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) box.querySelector('[data-iv=close]').click(); });
    }
    box.querySelector('.iv-t').textContent = title || 'Document';
    box.querySelector('[data-iv=save]').href = url;
    box.querySelector('iframe').src = url;
    box.hidden = false;
    return box;
  }
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || !internal(href)) return;
    if (a.hasAttribute('data-print')) { e.preventDefault(); print(a.href); return; }
    if (a.hasAttribute('data-inapp')) { e.preventDefault(); view(a.href, (a.textContent || '').trim()); return; }
    const tg = (a.getAttribute('target') || '').toLowerCase();
    if (!tg || tg === '_self' || tg === '_top' || tg === '_parent') return;
    e.preventDefault();
    view(a.href, (a.textContent || '').trim());
  }, true);
  window.RiyeserInApp = { print, view };
})();
