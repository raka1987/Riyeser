// Riyeser PDF 0.26.0: the start screen (big tiles for everyday jobs, recent and pinned files) and the pages for
// Convert, Combine, Batch, Compare, Scan and Settings, plus Send to Riyeser Documents. The editor (editor.js) passes
// in what it shares: opening files in tabs, its dialogs and toasts, the PDF libraries.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const TILES = [
  ['edit', '✍', 'Edit & sign', 'Change words, mark up and sign'],
  ['form', '📝', 'Fill a form', 'Type in the boxes, Fill my details'],
  ['combine', '🧩', 'Combine', 'Several PDFs or pictures into one'],
  ['split', '✂', 'Split', 'Every page, or the pages you choose'],
  ['compress', '🗜', 'Compress', 'Smaller files for email'],
  ['convert', '🔄', 'Convert', 'Word, Excel, text, pictures'],
  ['protect', '🔒', 'Protect', 'Add a password'],
  ['scan', '📷', 'Scan', 'From a scanner or photos'],
  ['batch', '🗂', 'Batch', 'Do the same to many files'],
  ['compare', '⇆', 'Compare', 'See what changed'],
];
const PAGES = { convert: 'Convert', combine: 'Combine', batch: 'Batch', compare: 'Compare two PDFs', scan: 'Scan', settings: 'Settings' };
const isPdf = (f) => /\.pdf$/i.test(f);
const isPic = (f) => /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f);
const folderOf = (f) => String(f).replace(/[\\/][^\\/]*$/, '');
const opt = (list, v) => list.map(([k, l]) => `<option value="${k}"${String(v) === k ? ' selected' : ''}>${l}</option>`).join('');

export function initHome(E) {
  const { bridge, toast, dialog, esc, Hy, fileName, kb } = E;
  const homeEl = $('#home'); const taskEl = $('#task');
  const page = { name: null, opts: {}, from: 'home' };
  const dropped = (e) => [...(e.dataTransfer?.files || [])].map((f) => bridge.pathForFile(f)).filter(Boolean);
  const call = (fn) => Promise.resolve().then(fn).catch((err) => toast(err.message));

  // ------------------------------------------------------------ start screen
  async function renderHome() {
    homeEl.innerHTML = `<div class="homewrap">
      <div class="homehead"><img src="icon-pdf.png" alt="" width="44" height="44"><div><h1>What would you like to do?</h1>
        <p class="muted">Pick a job, or drop files onto it. Everything happens on this PC: it's free and works without the internet.</p></div></div>
      <div class="tiles" id="tiles">${TILES.map(([job, ic, name, line]) => `<button class="tile" data-job="${job}" aria-describedby="tl-${job}"><span class="ti" aria-hidden="true">${ic}</span><b>${name}</b><small id="tl-${job}">${line}</small></button>`).join('')}</div>
      <div class="homecols">
        <section class="card recentcard" aria-labelledby="recent-h"><div class="cardhead"><h2 id="recent-h">Recent files</h2><span class="spacer"></span><button data-hcmd="open">Open a PDF…</button></div><div id="recent"><p class="muted small">Loading…</p></div></section>
        <section class="card tipcard" aria-labelledby="tips-h"><h2 id="tips-h">Handy to know</h2><ul class="tiplist">
          <li><span aria-hidden="true">⬇</span><span><b>Drop files anywhere</b> in this window: PDFs open in tabs, pictures become a PDF.</span></li>
          ${E.platform && E.platform !== 'win32' ? '' : `<li><span aria-hidden="true">🖱</span><span><b>Right-click a PDF</b> in File Explorer: Riyeser PDF ▸ Compress, Combine selected, Sign, Convert to images or Open. (On Windows 11, under <i>Show more options</i>.)</span></li>`}
          <li><span aria-hidden="true">🖨</span><span><b>Print to PDF</b> from any program with Windows' <i>Microsoft Print to PDF</i>. <button class="link" data-hcmd="printhelp">How</button></span></li>
          <li><span aria-hidden="true">✍</span><span><b>Save your signature once</b>, then place it with one click from <i>Sign</i>.</span></li>
        </ul></section>
      </div></div>`;
    await renderRecent();
  }
  async function renderRecent() {
    const box = $('#recent'); if (!box) return;
    let r = { pinned: [], recent: [] };
    try { r = await bridge.call('pdf:recentList'); } catch { /* none */ }
    const row = (f, pinned) => `<li><button class="rname" data-open="${esc(f.file)}" title="${esc(f.file)}"><span class="rfile" aria-hidden="true">📄</span><span class="rtext"><span class="rn">${esc(f.name)}</span><small>${esc(f.folder)} · ${kb(f.size)}</small></span></button>
      <button class="rpin${pinned ? ' on' : ''}" data-pin="${esc(f.file)}" data-on="${pinned ? 0 : 1}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(f.name)}" title="${pinned ? 'Unpin' : 'Pin to the top'}">${pinned ? '★' : '☆'}</button>
      <button class="rx" data-forget="${esc(f.file)}" aria-label="Remove ${esc(f.name)} from this list" title="Remove from this list (the file stays where it is)">✕</button></li>`;
    box.innerHTML = !r.pinned.length && !r.recent.length
      ? '<p class="muted small emptyrecent">PDFs you open show up here. Pin the ones you use often.</p>'
      : `${r.pinned.length ? `<div class="rhead">Pinned</div><ul class="recent">${r.pinned.map((f) => row(f, true)).join('')}</ul>` : ''}${r.recent.length ? `${r.pinned.length ? '<div class="rhead">Recent</div>' : ''}<ul class="recent">${r.recent.map((f) => row(f, false)).join('')}</ul>` : ''}`;
  }
  homeEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-job]'); if (t) { call(() => E.runJob(t.dataset.job)); return; }
    const o = e.target.closest('[data-open]'); if (o) { call(() => E.openFiles([o.dataset.open])); return; }
    const p = e.target.closest('[data-pin]'); if (p) { call(async () => { await bridge.call('pdf:pin', p.dataset.pin, p.dataset.on === '1'); await renderRecent(); $(`[data-pin="${CSS.escape(p.dataset.pin)}"]`)?.focus(); }); return; }
    const x = e.target.closest('[data-forget]'); if (x) { call(async () => { await bridge.call('pdf:forget', x.dataset.forget); await renderRecent(); }); return; }
    const h = e.target.closest('[data-hcmd]'); if (h) call(() => HCMD[h.dataset.hcmd] && HCMD[h.dataset.hcmd](h));
  });
  // drop files straight onto a tile: that job starts with them
  homeEl.addEventListener('dragover', (e) => { const t = e.target.closest('.tile'); $$('.tile.over').forEach((x) => x !== t && x.classList.remove('over')); if (t) { e.preventDefault(); t.classList.add('over'); } });
  homeEl.addEventListener('dragleave', (e) => { const t = e.target.closest('.tile'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('over'); });
  homeEl.addEventListener('drop', (e) => {
    const t = e.target.closest('.tile'); $$('.tile.over').forEach((x) => x.classList.remove('over'));
    if (!t) return;
    e.preventDefault(); document.body.classList.remove('dropping');
    const files = dropped(e); if (files.length) call(() => E.runJob(t.dataset.job, files));
  });

  // ------------------------------------------------------------ task pages
  function openPage(name, opts = {}) {
    if (E.tabs.view === 'doc') page.from = 'doc'; else if (E.tabs.view === 'home') page.from = 'home';
    page.name = name; page.opts = opts;
    E.setView('task');
    document.title = `${PAGES[name] || 'Riyeser PDF'} — Riyeser PDF`;
    RENDER[name](opts);
    taskEl.scrollTop = 0;
    setTimeout(() => { const h = $('.tphead h1', taskEl); if (h && !opts.section) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }, 0);
  }
  const back = () => { if (page.from === 'doc' && E.tabs.active) { E.tabs.active && document.querySelector(`[data-tabgo="${E.tabs.active.id}"]`)?.click(); } else E.showHome(); };
  const head = (title, line) => `<div class="tphead"><button class="back" data-hcmd="back" aria-label="Back">← ${page.from === 'doc' && E.tabs.active ? 'Back to the PDF' : 'Start'}</button><div><h1>${title}</h1>${line ? `<p class="muted">${line}</p>` : ''}</div></div>`;
  const fileChips = (files, key) => (files.length ? `<ul class="chips filelist">${files.map((f, i) => `<li class="chip" title="${esc(f)}"><span class="ellipsis">${esc(fileName(f))}</span><button data-hcmd="removefile" data-list="${key}" data-i="${i}" aria-label="Remove ${esc(fileName(f))}">✕</button></li>`).join('')}</ul>` : '');
  const results = (list) => (list && list.length ? `<ul class="results">${list.map((r) => (r.ok === false
    ? `<li class="bad"><span class="rs" aria-hidden="true">✗</span><span class="rt"><b>${esc(r.name || '')}</b><small>${esc(r.error)}</small></span></li>`
    : `<li><span class="rs good" aria-hidden="true">✓</span><span class="rt"><b>${esc(fileName(r.output))}</b><small>${esc(r.note || folderOf(r.output))}</small></span>${isPdf(r.output) ? `<button data-hcmd="openresult" data-f="${esc(r.output)}">Open</button>` : `<button data-hcmd="openpath" data-f="${esc(r.output)}">Open</button>`}<button data-hcmd="showpath" data-f="${esc(r.output)}">Show in folder</button></li>`)).join('')}</ul>` : '');
  taskEl.addEventListener('click', (e) => { const h = e.target.closest('[data-hcmd]'); if (h) { e.preventDefault(); call(() => HCMD[h.dataset.hcmd] && HCMD[h.dataset.hcmd](h)); } });
  taskEl.addEventListener('dragover', (e) => { const z = e.target.closest('[data-drop]'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  taskEl.addEventListener('dragleave', (e) => { const z = e.target.closest('[data-drop]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over'); });
  taskEl.addEventListener('drop', (e) => {
    const z = e.target.closest('[data-drop]') || (page.name && $('[data-drop]', taskEl));
    if (!z) return;
    e.preventDefault(); z.classList.remove('over'); document.body.classList.remove('dropping');
    const files = dropped(e); if (files.length) call(() => DROP[z.dataset.drop] && DROP[z.dataset.drop](files));
  });

  // ------------------------------------------------------------ Convert
  const conv = { pdf: null, pics: [], results: [], busy: false, o: { size: 'fit', or: 'auto', rot: true, one: true, imgf: 'png', dpi: '150', tab: 'xlsx' } };
  function renderConvert(opts = {}) {
    if (opts.files) { const p = opts.files.filter(isPdf); const q = opts.files.filter(isPic); if (p.length) conv.pdf = p[0]; if (q.length) conv.pics = q; }
    const busy = conv.busy ? ' disabled' : '';
    taskEl.innerHTML = `<div class="tp">${head('Convert', 'Everything is converted on this PC. Nothing is uploaded.')}<div class="tpbody">
      ${results(conv.results)}
      <div class="convgrid">
        <section class="card cv${opts.mode === 'pictures' ? ' focus' : ''}" data-drop="pics" aria-labelledby="cv-pics"><h2 id="cv-pics">Pictures to PDF</h2>
          <p class="muted small">JPG and PNG photos and scans (also WebP, BMP and GIF). Drop them here.</p>
          <div class="row"><button data-hcmd="pickpics">Choose pictures…</button><button data-hcmd="pickpicfolder">A whole folder…</button>${conv.pics.length ? `<span class="muted small">${conv.pics.length} picture${conv.pics.length === 1 ? '' : 's'}</span>` : ''}</div>
          ${fileChips(conv.pics, 'pics')}
          <div class="formgrid">
            <label for="cv-size">Page size</label><select id="cv-size" data-cv="size">${opt([['fit', 'Same as the picture'], ['a4', 'A4'], ['letter', 'Letter']], conv.o.size)}</select>
            <label for="cv-or">Orientation</label><select id="cv-or" data-cv="or">${opt([['auto', 'Automatic (follows each picture)'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], conv.o.or)}</select>
          </div>
          <label class="ffcheck"><input type="checkbox" id="cv-rot" data-cv="rot"${conv.o.rot ? ' checked' : ''}> Turn photos the right way up (from the camera's information)</label>
          <label class="ffcheck"><input type="checkbox" id="cv-one" data-cv="one"${conv.o.one ? ' checked' : ''}> Put them all in one PDF</label>
          <p class="note small">iPhone HEIC photos aren't supported yet. On the iPhone choose Settings › Camera › Formats › Most Compatible, or save them as JPEG first.</p>
          <div class="cardfoot"><button class="primary" data-hcmd="convpics"${busy}>Make PDF</button></div>
        </section>
        <section class="card cv${opts.mode === 'images' ? ' focus' : ''}" data-drop="pdf" aria-labelledby="cv-from"><h2 id="cv-from">From a PDF</h2>
          <div class="pickrow"><span class="muted small">PDF:</span>${conv.pdf ? `<b class="ellipsis" title="${esc(conv.pdf)}">${esc(fileName(conv.pdf))}</b>` : '<span class="muted">none chosen yet</span>'}<span class="spacer"></span><button data-hcmd="pickconvpdf">${conv.pdf ? 'Change…' : 'Choose a PDF…'}</button></div>
          <ul class="convlist">
            <li><div><b>Pictures of the pages</b><small>A PNG or JPG of each page, in a new folder next to the PDF.</small>
              <div class="row small"><label for="cv-imgf" class="vh">Picture type</label><select id="cv-imgf" data-cv="imgf">${opt([['png', 'PNG'], ['jpg', 'JPG']], conv.o.imgf)}</select><label for="cv-dpi" class="vh">Resolution</label><select id="cv-dpi" data-cv="dpi">${opt([['96', '96 dpi (screen)'], ['150', '150 dpi'], ['300', '300 dpi (print)']], conv.o.dpi)}</select></div></div>
              <button data-hcmd="conv" data-to="images"${busy}>Save pictures</button></li>
            <li><div><b>Word (.docx) <span class="pill warn">Basic: layout may change</span></b><small>The text and paragraphs of each page, to edit in Word. With Microsoft Word on this PC, Word does it.</small></div><button data-hcmd="conv" data-to="word"${busy}>Make Word file</button></li>
            <li><div><b>Excel (.xlsx) or CSV <span class="pill warn">Basic: simple tables only</span></b><small>Finds rows of text lined up in columns, like an invoice's lines. It can't read merged cells or rotated text.</small>
              <div class="row small"><label for="cv-tab" class="vh">Spreadsheet type</label><select id="cv-tab" data-cv="tab">${opt([['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']], conv.o.tab)}</select></div></div><button data-hcmd="conv" data-to="table"${busy}>Make spreadsheet</button></li>
            <li><div><b>Plain text (.txt)</b><small>Just the words, line by line. Scanned pages need Recognise text first.</small></div><button data-hcmd="conv" data-to="text"${busy}>Make text file</button></li>
          </ul>
        </section>
        <section class="card cv" aria-labelledby="cv-office"><h2 id="cv-office">Word, Excel or PowerPoint to PDF</h2>
          <p class="muted small">Uses Microsoft Office when it's on this PC (exact layout); otherwise a built-in converter that keeps the words and tables.</p>
          <div class="cardfoot"><button data-hcmd="convoffice"${busy}>Choose files…</button></div></section>
        <section class="card cv" aria-labelledby="cv-print"><h2 id="cv-print">Print to PDF from any program</h2>
          <p class="muted small">Riyeser PDF doesn't add a printer. Windows already has one: <b>Microsoft Print to PDF</b>.</p>
          <ol class="steps small"><li>In the program, choose <b>Print</b>.</li><li>Pick the printer <b>Microsoft Print to PDF</b>, then <b>Print</b>.</li><li>Save it into your <b>Riyeser PDF inbox</b> folder: it opens here by itself while Riyeser PDF is open.</li></ol>
          <div class="cardfoot"><button data-hcmd="inboxsettings">Set up the inbox folder…</button></div></section>
      </div></div></div>`;
    if (opts.mode) setTimeout(() => $('.cv.focus', taskEl)?.scrollIntoView({ block: 'nearest' }), 0);
  }
  async function convBusy(fn) {
    if (conv.busy) return;
    conv.busy = true; renderConvert(page.opts = {}); toast('Converting…');
    try { await fn(); toast(conv.results[0] && conv.results[0].output ? `Done: ${fileName(conv.results[0].output)}` : 'Done.'); } catch (e) { conv.results.unshift({ ok: false, name: 'Couldn\'t convert', error: e.message }); toast('That one couldn\'t be converted: see why at the top.'); }
    finally { conv.busy = false; conv.results = conv.results.slice(0, 8); if (page.name === 'convert') renderConvert({}); }
  }

  // ------------------------------------------------------------ Combine
  const comb = { files: [], result: null };
  function renderCombine(opts = {}) {
    if (opts.files && opts.files.length) comb.files = [...new Set([...comb.files, ...opts.files.filter((f) => isPdf(f) || isPic(f))])];
    taskEl.innerHTML = `<div class="tp">${head('Combine', 'Put several PDFs and pictures into one PDF, in the order below.')}<div class="tpbody">
      ${comb.result ? results([comb.result]) : ''}
      <section class="card" data-drop="combine"><div class="cardhead"><h2>Files <span class="muted small">(${comb.files.length})</span></h2><span class="spacer"></span><button data-hcmd="combadd">Add files…</button><button data-hcmd="combfolder">Add a folder…</button></div>
        ${comb.files.length ? `<ol class="orderlist">${comb.files.map((f, i) => `<li><span class="num">${i + 1}</span><span class="ellipsis grow" title="${esc(f)}">${isPdf(f) ? '📄' : '🖼'} ${esc(fileName(f))}</span>
          <button data-hcmd="combmove" data-i="${i}" data-d="-1" aria-label="Move ${esc(fileName(f))} up"${i === 0 ? ' disabled' : ''}>▲</button><button data-hcmd="combmove" data-i="${i}" data-d="1" aria-label="Move ${esc(fileName(f))} down"${i === comb.files.length - 1 ? ' disabled' : ''}>▼</button><button data-hcmd="removefile" data-list="combine" data-i="${i}" aria-label="Remove ${esc(fileName(f))}">✕</button></li>`).join('')}</ol>`
          : '<div class="dropnote">Drop PDFs and pictures here, or choose them.</div>'}
        <div class="cardfoot"><span class="muted small">The originals stay as they are. You choose where the new PDF goes.</span><span class="spacer"></span><button class="primary" data-hcmd="combrun"${comb.files.length < 2 ? ' disabled' : ''}>Combine…</button></div></section>
    </div></div>`;
  }

  // ------------------------------------------------------------ Batch
  const ACT = {
    compress: 'Compress', watermark: 'Watermark', pagenumbers: 'Page numbers', password: 'Password', rename: 'Rename',
  };
  const bat = { files: [], order: ['compress', 'watermark', 'pagenumbers', 'password', 'rename'], on: {}, opts: { compress: { quality: 'balanced' }, watermark: { text: 'COPY', opacity: 0.22, angle: 35, color: '#9ca3af' }, pagenumbers: { format: 'Page {n} of {total}', position: 'bottom-center' }, password: { password: '' }, rename: { pattern: '{name} ({date})' } }, where: 'next', dir: '', replace: false, results: [], progress: null, busy: false };
  function actionOptions(a) {
    const o = bat.opts[a];
    if (a === 'compress') return `<label for="bo-cq" class="vh">Quality</label><select id="bo-cq" data-bo="compress.quality"><option value="balanced"${o.quality === 'balanced' ? ' selected' : ''}>Balanced</option><option value="small"${o.quality === 'small' ? ' selected' : ''}>Smallest</option><option value="high"${o.quality === 'high' ? ' selected' : ''}>High quality</option></select>`;
    if (a === 'watermark') return `<label for="bo-wt" class="vh">Watermark text</label><input id="bo-wt" data-bo="watermark.text" value="${esc(o.text)}" class="w-text">
      <label for="bo-wo" class="small muted">Strength</label><input id="bo-wo" type="range" min="0.08" max="0.6" step="0.02" data-bo="watermark.opacity" value="${o.opacity}">
      <label for="bo-wa" class="small muted">Angle</label><select id="bo-wa" data-bo="watermark.angle">${[0, 35, 45, 90].map((n) => `<option value="${n}"${+o.angle === n ? ' selected' : ''}>${n}°</option>`).join('')}</select>
      <label for="bo-wc" class="vh">Colour</label><input id="bo-wc" type="color" data-bo="watermark.color" value="${o.color}">`;
    if (a === 'pagenumbers') return `<label for="bo-pf" class="vh">Style</label><select id="bo-pf" data-bo="pagenumbers.format">${[['Page {n} of {total}', 'Page 1 of 5'], ['{n}', '1'], ['{n} / {total}', '1 / 5'], ['- {n} -', '- 1 -']].map(([v, l]) => `<option value="${esc(v)}"${o.format === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label for="bo-pp" class="vh">Position</label><select id="bo-pp" data-bo="pagenumbers.position">${Hy.PAGE_NUMBER_POSITIONS.map(([v, l]) => `<option value="${v}"${o.position === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    if (a === 'password') return `<label for="bo-pw" class="vh">Password</label><input id="bo-pw" type="password" autocomplete="new-password" placeholder="Password" data-bo="password.password" value="${esc(o.password)}"><span class="small muted">Always put on last.</span>`;
    return `<label for="bo-rn" class="vh">New name</label><input id="bo-rn" data-bo="rename.pattern" value="${esc(o.pattern)}" class="w-text"><span class="small muted">{name} {date} {n} → ${esc(Hy.renamePattern(o.pattern, { name: bat.files[0] ? fileName(bat.files[0]) : 'Invoice 1001.pdf', n: 1, total: Math.max(1, bat.files.length) }))}</span>`;
  }
  function renderBatch(opts = {}) {
    if (opts.files && opts.files.length) bat.files = [...new Set([...bat.files, ...opts.files.filter(isPdf)])];
    if (opts.actions) { bat.on = {}; for (const a of opts.actions) bat.on[a] = true; }
    const chosen = bat.order.filter((a) => bat.on[a]);
    const pr = bat.progress;
    taskEl.innerHTML = `<div class="tp">${head('Batch', 'Do the same jobs to many PDFs at once. The originals are never changed unless you tick that.')}<div class="tpbody">
      <div class="batchgrid">
        <section class="card" data-drop="batch" aria-labelledby="b-files"><div class="cardhead"><h2 id="b-files">1. Files <span class="muted small">(${bat.files.length})</span></h2><span class="spacer"></span><button data-hcmd="batadd">Add PDFs…</button><button data-hcmd="batfolder">Add a folder…</button></div>
          ${bat.files.length ? `<ul class="flist">${bat.files.map((f, i) => `<li><span class="ellipsis grow" title="${esc(f)}">📄 ${esc(fileName(f))}</span><button data-hcmd="removefile" data-list="batch" data-i="${i}" aria-label="Remove ${esc(fileName(f))}">✕</button></li>`).join('')}</ul>${bat.files.length > 1 ? '<button class="link small" data-hcmd="batclear">Clear the list</button>' : ''}`
            : '<div class="dropnote">Drop PDFs here, or add a whole folder.</div>'}
        </section>
        <section class="card" aria-labelledby="b-acts"><h2 id="b-acts">2. What to do, in this order</h2>
          <ol class="actlist">${bat.order.map((a, i) => `<li class="${bat.on[a] ? 'on' : ''}"><label class="actname"><input type="checkbox" data-hcmd="battoggle" data-a="${a}"${bat.on[a] ? ' checked' : ''}> ${ACT[a]}</label>
            <span class="actopts">${bat.on[a] ? actionOptions(a) : ''}</span>
            <span class="actmove"><button data-hcmd="batmove" data-i="${i}" data-d="-1" aria-label="Move ${ACT[a]} up"${i === 0 ? ' disabled' : ''}>▲</button><button data-hcmd="batmove" data-i="${i}" data-d="1" aria-label="Move ${ACT[a]} down"${i === bat.order.length - 1 ? ' disabled' : ''}>▼</button></span></li>`).join('')}</ol>
          <h2 class="h2gap">3. Where the new files go</h2>
          <div class="radios" role="radiogroup" aria-label="Where the new files go">
            <label><input type="radio" name="bw" value="next" data-hcmd="batwhere"${bat.where === 'next' && !bat.replace ? ' checked' : ''}${bat.replace ? ' disabled' : ''}> Next to each original (a new name, so nothing is overwritten)</label>
            <label><input type="radio" name="bw" value="folder" data-hcmd="batwhere"${bat.where === 'folder' && !bat.replace ? ' checked' : ''}${bat.replace ? ' disabled' : ''}> In this folder: <button data-hcmd="batdir">${bat.dir ? esc(bat.dir) : 'Choose…'}</button></label>
          </div>
          <label class="ffcheck warnbox"><input type="checkbox" data-hcmd="batreplace"${bat.replace ? ' checked' : ''}> Replace the original files <small>(a copy of each is kept in Tools › Copies kept when saving over a file)</small></label>
          <div class="cardfoot"><span class="muted small">${chosen.length ? chosen.map((a) => ACT[a]).join(' → ') : 'Tick at least one job.'}</span><span class="spacer"></span><button class="primary" data-hcmd="batrun"${!bat.files.length || !chosen.length || bat.busy ? ' disabled' : ''}>Run on ${bat.files.length} file${bat.files.length === 1 ? '' : 's'}</button></div>
        </section>
      </div>
      ${pr ? `<section class="card" aria-labelledby="b-res"><h2 id="b-res">${bat.busy ? 'Working…' : 'Done'}</h2><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${pr.total}" aria-valuenow="${pr.done}"><i style="width:${pr.total ? Math.round((pr.done / pr.total) * 100) : 0}%"></i></div>
        <p class="small muted">${bat.busy ? `File ${Math.min(pr.done + 1, pr.total)} of ${pr.total}: ${esc(pr.file || '')}` : `${bat.results.filter((r) => r.ok).length} of ${pr.total} done${bat.results.some((r) => !r.ok) ? `, ${bat.results.filter((r) => !r.ok).length} couldn't be done` : ''}.`}</p>
        ${results(bat.results.map((r) => (r.ok ? { ...r, note: `${kb(r.before)} → ${kb(r.after)} · ${folderOf(r.output)}` } : r)))}</section>` : ''}
    </div></div>`;
  }
  taskEl.addEventListener('input', (e) => {
    const k = e.target.dataset.bo; if (!k) return;
    const [a, f] = k.split('.'); bat.opts[a][f] = e.target.type === 'range' ? +e.target.value : e.target.value;
    if (a === 'rename') { const s = e.target.parentElement.querySelector('.small.muted'); if (s) s.textContent = `{name} {date} {n} → ${Hy.renamePattern(bat.opts.rename.pattern, { name: bat.files[0] ? fileName(bat.files[0]) : 'Invoice 1001.pdf', n: 1, total: Math.max(1, bat.files.length) })}`; }
  });
  async function runBatchNow() {
    const steps = bat.order.filter((a) => bat.on[a]).map((a) => ({ type: a, ...bat.opts[a] }));
    if (bat.on.password && !bat.opts.password.password) throw new Error('Type the password, or untick Password.');
    if (!bat.replace && bat.where === 'folder' && !bat.dir) throw new Error('Choose the folder for the new files.');
    if (bat.replace) {
      const r = await dialog(`<h2>Replace the original files?</h2><p class="muted">The ${bat.files.length} original PDF${bat.files.length === 1 ? '' : 's'} will be changed. A copy of each is kept in Tools › Copies kept when saving over a file.</p><div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Replace them</button></div>`);
      if (r !== 'ok') return;
    }
    bat.busy = true; bat.results = []; bat.progress = { done: 0, total: bat.files.length, file: '' }; renderBatch();
    const io = {
      L: window.PDFLib, now: new Date(),
      read: (p) => bridge.call('pdf:readQuiet', p),
      compress: (bytes, s) => E.compressBytes(bytes, s.quality),
      write: (f, name, bytes) => bridge.call('batch:write', bat.replace ? null : (bat.where === 'folder' ? bat.dir : folderOf(f.path)), name, bytes, bat.replace ? f.path : null),
    };
    try {
      bat.results = await Hy.runBatch(bat.files.map((p) => ({ path: p, name: fileName(p) })), steps, io, (p) => { bat.progress = p; if (page.name === 'batch') { const bar = $('.progress i', taskEl); if (bar) bar.style.width = `${Math.round((p.done / p.total) * 100)}%`; const t = $('.progress + p', taskEl); if (t) t.textContent = `File ${Math.min(p.done + 1, p.total)} of ${p.total}: ${p.file}`; } });
    } finally { bat.busy = false; if (page.name === 'batch') renderBatch(); }
    toast(`Batch finished: ${bat.results.filter((r) => r.ok).length} of ${bat.files.length} done.`);
  }

  // ------------------------------------------------------------ Compare
  const cmp = { a: null, b: null, result: null, sel: 0, docs: null, busy: false };
  function renderCompare(opts = {}) {
    if (opts.files && opts.files.length) { const p = opts.files.filter(isPdf); if (p[0]) { cmp.a = p[0]; cmp.result = null; } if (p[1]) cmp.b = p[1]; }
    const r = cmp.result;
    const label = (p) => ({ same: 'No changes', changed: `${p.removed.length + p.added.length} change${p.removed.length + p.added.length === 1 ? '' : 's'}`, added: 'Only in the changed copy', removed: 'Only in the original', notext: p.visual == null ? 'Scanned: no words' : p.visual > 0.002 ? 'Scanned: looks different' : 'Scanned: looks the same' }[p.status]);
    const changed = r ? r.pages.filter((p) => p.status !== 'same' && !(p.status === 'notext' && p.visual != null && p.visual <= 0.002)) : [];
    taskEl.innerHTML = `<div class="tp">${head('Compare two PDFs', 'See what changed between two versions: words taken out are red, words added are green.')}<div class="tpbody">
      <div class="cmppick">
        <div class="card pickcard" data-drop="cmpa"><span class="muted small">Original</span>${cmp.a ? `<b class="ellipsis" title="${esc(cmp.a)}">${esc(fileName(cmp.a))}</b>` : '<span class="muted">Drop or choose a PDF</span>'}<button data-hcmd="cmppick" data-k="a">${cmp.a ? 'Change…' : 'Choose…'}</button></div>
        <div class="card pickcard" data-drop="cmpb"><span class="muted small">Changed copy</span>${cmp.b ? `<b class="ellipsis" title="${esc(cmp.b)}">${esc(fileName(cmp.b))}</b>` : '<span class="muted">Drop or choose a PDF</span>'}<button data-hcmd="cmppick" data-k="b">${cmp.b ? 'Change…' : 'Choose…'}</button></div>
        <button class="primary" data-hcmd="cmprun"${!cmp.a || !cmp.b || cmp.busy ? ' disabled' : ''}>${cmp.busy ? 'Comparing…' : 'Compare'}</button>
      </div>
      ${r ? `<div class="cmpgrid">
        <aside class="card cmplist" aria-labelledby="cmp-h"><h2 id="cmp-h">${changed.length ? `${changed.length} page${changed.length === 1 ? '' : 's'} changed` : 'No differences found'}</h2>
          <p class="small muted">${r.pages.length} page${r.pages.length === 1 ? '' : 's'} compared.</p>
          <ul class="pagelist">${r.pages.map((p, i) => `<li><button class="${i === cmp.sel ? 'on ' : ''}st-${p.status}" data-hcmd="cmpgo" data-i="${i}" aria-current="${i === cmp.sel}"><b>Page ${p.page}</b><small>${label(p)}</small></button></li>`).join('')}</ul>
          <div class="legend small"><span class="lg del"></span> Taken out <span class="lg add"></span> Added</div></aside>
        <div class="cmpview"><div class="row cmpnav"><button data-hcmd="cmpstep" data-d="-1" aria-label="Previous change">◀ Previous change</button><button data-hcmd="cmpstep" data-d="1" aria-label="Next change">Next change ▶</button><span class="spacer"></span><span id="cmpnote" class="small muted"></span></div>
          <div class="cmpcols"><figure><figcaption>Original</figcaption><div class="cmppage" id="cmp-a"></div></figure><figure><figcaption>Changed copy</figcaption><div class="cmppage" id="cmp-b"></div></figure></div></div>
      </div>` : '<div class="dropnote big">Choose the two PDFs, then Compare.</div>'}
    </div></div>`;
    if (r) drawComparePage();
  }
  async function loadWords(file) {
    const bytes = await bridge.call('pdf:readQuiet', file);
    let doc;
    try { doc = await E.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/' }).promise; }
    catch (e) { throw new Error(/password/i.test(e.name + e.message) ? `${fileName(file)} has a password. Open it, save a copy without the password, then compare.` : `${fileName(file)} couldn't be read.`); }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      pages.push(Hy.wordsFromItems(tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || 10 }))));
    }
    return { doc, pages };
  }
  async function runCompare() {
    cmp.busy = true; renderCompare();
    try {
      if (cmp.docs) { cmp.docs.a.doc.destroy(); cmp.docs.b.doc.destroy(); }
      const [a, b] = await Promise.all([loadWords(cmp.a), loadWords(cmp.b)]);
      cmp.docs = { a, b };
      const pages = Hy.comparePages(a.pages, b.pages);
      // scanned pages (no words in either copy): compare small pictures of them
      for (const p of pages.filter((x) => x.status === 'notext')) p.visual = await visualDiff(a.doc, b.doc, p.page);
      cmp.result = { pages };
      cmp.sel = Math.max(0, pages.findIndex((p) => p.status !== 'same'));
    } finally { cmp.busy = false; }
    renderCompare();
  }
  async function renderPageTo(doc, n, width) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    const c = document.createElement('canvas'); const ratio = window.devicePixelRatio || 1;
    c.width = Math.floor(vp.width * ratio); c.height = Math.floor(vp.height * ratio); c.style.width = `${vp.width}px`; c.style.height = `${vp.height}px`;
    const ctx = c.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { c, vp };
  }
  async function visualDiff(a, b, n) {
    if (n > a.numPages || n > b.numPages) return 1;
    const pic = async (doc) => { const page = await doc.getPage(n); const vp = page.getViewport({ scale: 120 / page.getViewport({ scale: 1 }).width }); const c = document.createElement('canvas'); c.width = 120; c.height = Math.round(vp.height); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); await page.render({ canvasContext: x, viewport: vp }).promise; return x.getImageData(0, 0, c.width, c.height).data; };
    try { return Hy.pixelDifference(await pic(a), await pic(b)); } catch { return null; }
  }
  async function drawComparePage() {
    const r = cmp.result; const p = r.pages[cmp.sel]; if (!p) return;
    const boxA = $('#cmp-a'); const boxB = $('#cmp-b'); if (!boxA) return;
    const width = Math.max(220, Math.min(620, (boxA.clientWidth || 400) - 4));
    const draw = async (which, box, idx, cls) => {
      box.innerHTML = '';
      const d = cmp.docs[which];
      if (p.page > d.doc.numPages) { box.innerHTML = `<div class="nopage">${which === 'a' ? 'Not in the original' : 'Not in the changed copy'}</div>`; return; }
      const { c, vp } = await renderPageTo(d.doc, p.page, width);
      box.appendChild(c);
      const words = d.pages[p.page - 1] || [];
      for (const i of idx) {
        const w = words[i]; if (!w) continue;
        const p1 = vp.convertToViewportPoint(w.x, w.y - w.h * 0.22); const p2 = vp.convertToViewportPoint(w.x + w.w, w.y + w.h * 0.9);
        const m = document.createElement('span'); m.className = `mark ${cls}`;
        Object.assign(m.style, { left: `${Math.min(p1[0], p2[0])}px`, top: `${Math.min(p1[1], p2[1])}px`, width: `${Math.abs(p2[0] - p1[0])}px`, height: `${Math.abs(p2[1] - p1[1])}px` });
        box.appendChild(m);
      }
    };
    await Promise.all([draw('a', boxA, p.removed, 'del'), draw('b', boxB, p.added, 'add')]);
    const note = $('#cmpnote');
    if (note) {
      if (p.status === 'notext') {
        note.innerHTML = `This page is a picture (scanned), so only how it looks can be compared${p.visual != null ? `: ${p.visual > 0.002 ? 'it looks different' : 'it looks the same'}` : ''}. For word-by-word changes, <button class="link" data-hcmd="cmpocr">recognise the text first</button>.`;
      } else note.textContent = p.status === 'same' ? 'No changes on this page.' : p.status === 'changed' ? `${p.removed.length} word${p.removed.length === 1 ? '' : 's'} taken out, ${p.added.length} added.` : '';
    }
  }

  // ------------------------------------------------------------ Scan
  const scan = { pics: [], busy: false, result: null };
  function renderScan(opts = {}) {
    if (opts.files && opts.files.length) scan.pics = [...scan.pics, ...opts.files.filter(isPic)];
    const win = E.platform === 'win32';
    taskEl.innerHTML = `<div class="tp">${head('Scan', 'Turn paper into a PDF: from a scanner, or from photos of the pages.')}<div class="tpbody">
      ${scan.result ? results([scan.result]) : ''}
      <div class="convgrid">
        <section class="card" aria-labelledby="sc-a"><h2 id="sc-a">From a scanner</h2>
          <p class="muted small">${win ? 'Uses Windows\' own scanning. Put the page in the scanner, then press Scan a page (once for each page).' : 'Scanning from here works on Windows. On this computer, choose photos or scans instead.'}</p>
          <div class="cardfoot"><button class="primary" data-hcmd="scanpage"${!win || scan.busy ? ' disabled' : ''}>${scan.busy ? 'Scanning…' : 'Scan a page'}</button></div></section>
        <section class="card" data-drop="scan" aria-labelledby="sc-b"><h2 id="sc-b">From photos or a folder</h2>
          <p class="muted small">Photos of pages from a phone or camera: copy them to this PC first (for example with the Windows Photos app's Import), then choose them here. Photos are turned the right way up.</p>
          <div class="cardfoot"><button data-hcmd="scanpics">Choose photos…</button><button data-hcmd="scanfolder">A whole folder…</button></div></section>
      </div>
      <section class="card" aria-labelledby="sc-p"><div class="cardhead"><h2 id="sc-p">Pages <span class="muted small">(${scan.pics.length})</span></h2><span class="spacer"></span>${scan.pics.length ? '<button class="link small" data-hcmd="scanclear">Start again</button>' : ''}</div>
        ${scan.pics.length ? `<ol class="orderlist">${scan.pics.map((f, i) => `<li><span class="num">${i + 1}</span><span class="ellipsis grow" title="${esc(f)}">🖼 ${esc(fileName(f))}</span><button data-hcmd="scanmove" data-i="${i}" data-d="-1" aria-label="Move page ${i + 1} up"${i === 0 ? ' disabled' : ''}>▲</button><button data-hcmd="scanmove" data-i="${i}" data-d="1" aria-label="Move page ${i + 1} down"${i === scan.pics.length - 1 ? ' disabled' : ''}>▼</button><button data-hcmd="removefile" data-list="scan" data-i="${i}" aria-label="Remove page ${i + 1}">✕</button></li>`).join('')}</ol>` : '<div class="dropnote">No pages yet.</div>'}
        <div class="cardfoot"><span class="muted small">A4 pages. Afterwards, <b>Recognise text</b> makes the words searchable.</span><span class="spacer"></span><button class="primary" data-hcmd="scanmake"${scan.pics.length ? '' : ' disabled'}>Make PDF…</button></div></section>
    </div></div>`;
  }

  // ------------------------------------------------------------ Settings
  const set = { profile: null, fromCompany: [], hasCompany: false, prefs: null, sigs: [], sigStatus: null, inbox: null, ctx: null, theme: 'system' };
  async function renderSettings(opts = {}) {
    taskEl.innerHTML = `<div class="tp">${head('Settings', '')}<div class="tpbody"><p class="muted">Loading…</p></div></div>`;
    const [pr, prefs, sigs, sigStatus, inbox, ctx, theme] = await Promise.all([
      bridge.call('profile:get'), bridge.call('pdfset:get'), bridge.call('sig:list'), bridge.call('sig:status'), bridge.call('inbox:get'), bridge.call('pdf:contextMenuStatus').catch(() => null), bridge.call('theme:get').catch(() => 'system')]);
    Object.assign(set, { profile: pr.profile, fromCompany: pr.fromCompany, hasCompany: pr.hasCompany, prefs, sigs, sigStatus, inbox, ctx, theme });
    const p = set.profile; const win = prefs.platform === 'win32';
    const fld = (k, label, type = 'text', auto = '') => `<label for="pf-${k}">${label}</label><input id="pf-${k}" name="${k}" type="${type}" value="${esc(p[k] || '')}" autocomplete="${auto || 'off'}"${set.fromCompany.includes(k) ? ' class="fromco"' : ''}>`;
    const sample = new Date();
    taskEl.innerHTML = `<div class="tp">${head('Settings', 'Kept on this PC.')}<div class="tpbody setgrid">
      <nav class="setnav card" aria-label="Settings sections">${[['details', 'My details'], ['signatures', 'Signatures'], ['stamps', 'Stamps and dates'], ['windows', 'Windows'], ['print', 'Print to PDF'], ['look', 'Appearance'], ['backups', 'Backups']].map(([id, l]) => `<a href="#set-${id}" data-hcmd="setjump" data-id="${id}">${l}</a>`).join('')}</nav>
      <div class="setmain">
      <section class="card" id="set-details" aria-labelledby="sd-h"><h2 id="sd-h">My details</h2>
        <p class="muted small">For <b>Fill my details</b> in forms.${set.hasCompany ? ' Empty boxes are filled in from your business in Riyeser Central (shown with a dotted line); what you type here wins.' : ''}</p>
        <form id="profileform" class="formgrid wide">
          ${fld('name', 'Your name', 'text', 'name')}${fld('business', 'Business', 'text', 'organization')}
          <label for="pf-taxLabel">Tax number is called</label><input id="pf-taxLabel" name="taxLabel" value="${esc(p.taxLabel || 'Tax number')}" placeholder="e.g. ABN, TIN, GST number, VAT number">
          ${fld('taxNumber', 'Tax number')}${fld('address', 'Address', 'text', 'street-address')}${fld('phone', 'Phone', 'tel', 'tel')}${fld('email', 'Email', 'email', 'email')}
        </form>
        <div class="cardfoot"><span id="pf-saved" class="small muted" role="status"></span><span class="spacer"></span><button class="primary" data-hcmd="saveprofile">Save my details</button></div></section>

      <section class="card" id="set-signatures" aria-labelledby="ss-h"><h2 id="ss-h">Signatures and initials</h2>
        <p class="muted small">${sigStatus.protected ? 'Kept on this PC only, locked to your Windows sign-in: another Windows user, or another PC, can\'t use them.' : 'Kept on this PC only.'} Make a new one from <b>Sign ▾</b> in a PDF.</p>
        ${sigs.length ? `<ul class="siglist">${sigs.map((s) => `<li><img src="${s.data}" alt="${s.kind === 'initials' ? 'Initials' : 'Signature'}"><span class="small">${s.kind === 'initials' ? 'Initials' : 'Signature'}${s.isDefault ? ' <span class="pill">One click</span>' : ''}</span><span class="spacer"></span>${s.isDefault ? '' : `<button data-hcmd="sigdef" data-id="${s.id}">Use for one click</button>`}<button data-hcmd="sigdel" data-id="${s.id}" aria-label="Forget this ${s.kind === 'initials' ? 'set of initials' : 'signature'}">Forget</button></li>`).join('')}</ul>` : '<p class="small">None saved yet.</p>'}</section>

      <section class="card" id="set-stamps" aria-labelledby="st-h"><h2 id="st-h">Stamps and dates</h2>
        <div class="formgrid"><label for="sd-fmt">Date on stamps</label><select id="sd-fmt" data-hcmd="setdate">${Hy.DATE_FORMATS.map(([v, l]) => `<option value="${v}"${prefs.dateFormat === v ? ' selected' : ''}>${l} — ${esc(Hy.formatStampDate(sample, v, prefs.locale || undefined))}</option>`).join('')}</select></div>
        <p class="small muted">${prefs.companyDateFormat ? `Your business's format from Riyeser Central is used when this is set to Windows setting. ` : ''}Stamps and the Date button use it.</p>
        <h3>Your stamps</h3>${prefs.stamps.length ? `<ul class="stamplist">${prefs.stamps.map((s, i) => `<li><span class="stampprev" style="color:${esc(s.color)};border-color:${esc(s.color)}">${esc(s.text)}</span><span class="small muted">${s.date ? 'with the date' : 'no date'}</span><span class="spacer"></span><button data-hcmd="stampdel" data-i="${i}" aria-label="Remove the stamp ${esc(s.text)}">Remove</button></li>`).join('')}</ul>` : '<p class="small muted">None yet. Add one from <b>Stamp ▾ › New stamp…</b> in a PDF.</p>'}</section>

      <section class="card" id="set-windows" aria-labelledby="sw-h"><h2 id="sw-h">Windows</h2>
        ${win ? `<div class="setrow"><div><b>Default PDF program</b><p class="small muted">Windows doesn't let programs make themselves the default. This opens Windows' Default apps page: choose <b>Riyeser PDF</b> for .pdf there. Nothing changes until you do.</p></div><button data-hcmd="makedefault">Make Riyeser PDF my default…</button></div>
        <div class="setrow"><div><b>Right-click menu</b><p class="small muted">${ctx && ctx.installed ? '✓ On: right-click PDFs and pictures in File Explorer for <b>Riyeser PDF ▸</b> Open, Sign, Compress, Combine selected, Convert to images (pictures: Convert to PDF). On Windows 11 it\'s under <i>Show more options</i>. Select up to 15 files at a time; for more, use Batch.' : 'Added by the Riyeser PDF installer, for this Windows user. Install the latest Riyeser PDF to get it.'}</p></div></div>`
          : '<p class="small muted">The default PDF program and the right-click menu are set up on Windows.</p>'}</section>

      <section class="card" id="set-print" aria-labelledby="sp-h"><h2 id="sp-h">Print to PDF</h2>
        <p class="small muted">Riyeser PDF doesn't install a printer. In any program, print to Windows' own <b>Microsoft Print to PDF</b> and save into your Riyeser PDF inbox folder: while Riyeser PDF is open, each new PDF there opens in a tab.</p>
        <label class="ffcheck"><input type="checkbox" data-hcmd="inboxtoggle"${inbox.on ? ' checked' : ''}> Open new PDFs saved in my Riyeser PDF inbox</label>
        <div class="setrow"><span class="path ellipsis" title="${esc(inbox.dir)}">${esc(inbox.dir)}</span><button data-hcmd="inboxopen">Open the folder</button></div></section>

      <section class="card" id="set-look" aria-labelledby="sl-h"><h2 id="sl-h">Appearance</h2>
        <div class="formgrid"><label for="set-theme">Light or dark</label><select id="set-theme" data-hcmd="settheme"><option value="system"${set.theme === 'system' ? ' selected' : ''}>Same as Windows</option><option value="light"${set.theme === 'light' ? ' selected' : ''}>Light</option><option value="dark"${set.theme === 'dark' ? ' selected' : ''}>Dark</option></select></div></section>

      <section class="card" id="set-backups" aria-labelledby="sb-h"><h2 id="sb-h">Backups</h2>
        <p class="small muted">Your signatures, stamps, details and recent files are backed up every day. (Signatures locked to your Windows sign-in can only be used again by the same Windows user on this PC.)</p>
        <div class="row"><button data-cmd="backupnow">Back up now</button><button data-cmd="backuprestore">Restore from a backup…</button><button data-cmd="backupfolder">Open the backups folder</button><button data-cmd="pdfbackups">Copies kept when saving over a file</button></div>
        <p class="small muted aboutline">Riyeser PDF ${esc(prefs.version || '')} · <button class="link" data-cmd="help">Help with Riyeser PDF</button></p></section>
      </div></div></div>`;
    if (opts.section) setTimeout(() => { const s = $(`#set-${opts.section}`); if (s) { s.scrollIntoView({ block: 'start' }); const f = $('input, select, button', s); if (f) f.focus({ preventScroll: true }); } }, 0);
  }
  taskEl.addEventListener('change', (e) => {
    const cv = e.target.dataset.cv; if (cv) conv.o[cv] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const h = e.target.dataset.hcmd;
    if (h && CHANGE[h]) call(() => CHANGE[h](e.target));
  });
  const CHANGE = {
    setdate: async (el) => { await bridge.call('pdfset:set', { dateFormat: el.value }); await E.reloadPrefs(); toast('Stamps use this date format now.'); },
    settheme: (el) => bridge.call('theme:set', el.value),
    inboxtoggle: async (el) => { const r = await bridge.call('inbox:set', el.checked); toast(r.on ? 'New PDFs saved in your Riyeser PDF inbox will open here.' : 'The inbox folder isn\'t watched any more.'); },
    battoggle: (el) => { bat.on[el.dataset.a] = el.checked; renderBatch(); $(`[data-a="${el.dataset.a}"]`, taskEl)?.focus(); },
    batwhere: (el) => { bat.where = el.value; if (el.value === 'folder' && !bat.dir) return HCMD.batdir(); renderBatch(); return null; },
    batreplace: (el) => { bat.replace = el.checked; renderBatch(); $('[data-hcmd="batreplace"]', taskEl)?.focus(); },
  };

  // ------------------------------------------------------------ Send to Riyeser Documents
  async function sendToDocuments(files) {
    const t = await bridge.call('docs:target');
    if (!t.ok) { await dialog(`<h2>Send to Riyeser Documents</h2><p>${esc(t.reason)}</p><div class="dlgbtns"><button class="primary" data-dlg="cancel">OK</button></div>`); return; }
    const depts = t.departments.filter((d) => d.canAdd);
    const r = await dialog(`<h2>Send to Riyeser Documents</h2>
      <p class="muted">A copy of <b>${esc(files.map(fileName).join(', '))}</b> goes into the library's Inbox. Riyeser Documents reads it and suggests a folder; the file here stays as it is.</p>
      <div class="dlgrow"><label>Library</label><span class="path ellipsis" title="${esc(t.root)}" style="flex:1">${esc(t.root)}${t.shared ? ' (shared)' : ''}</span></div>
      <div class="dlgrow"><label>From</label><span>${esc(t.who)}</span></div>
      <div class="dlgrow"><label for="sd-dept">For</label><select id="sd-dept" style="flex:1">${t.canAddInbox ? '<option value="">The Inbox: Documents suggests a folder</option>' : ''}${depts.map((d) => `<option value="${esc(d.rel)}">${esc(d.rel)}</option>`).join('')}</select></div>
      ${!t.canAddInbox && !depts.length ? '<p class="bad small">You don\'t have access to add documents to this library. Ask its owner to change it in Riyeser Documents › Settings › People & access.</p>' : ''}
      <div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok"${!t.canAddInbox && !depts.length ? ' disabled' : ''}>Send</button></div>`);
    if (r !== 'ok') return;
    const dept = $('#sd-dept').value || null;
    const res = await bridge.call('docs:send', files, { dept });
    toast(`Sent to Riyeser Documents${dept ? ` for ${dept}` : ''}: ${res.added.map((a) => a.name).join(', ')} is in its Inbox.`);
  }

  // ------------------------------------------------------------ actions
  const listFor = { pics: () => conv.pics, combine: () => comb.files, batch: () => bat.files, scan: () => scan.pics };
  const rerender = () => RENDER[page.name]({});
  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
  const pickPdf = async (title) => ((await bridge.call('pdf:pickFiles', 'pdf', false, title)) || [])[0] || null;
  const HCMD = {
    back,
    open: () => E.runJob('open'),
    printhelp: () => openPage('convert', { mode: 'print' }),
    inboxsettings: () => openPage('settings', { section: 'print' }),
    removefile: (b) => { listFor[b.dataset.list]().splice(+b.dataset.i, 1); rerender(); },
    openresult: (b) => E.openFiles([b.dataset.f]),
    openpath: (b) => bridge.call('file:openPath', b.dataset.f),
    showpath: (b) => bridge.call('file:showPath', b.dataset.f),
    // Convert
    pickpics: async () => { const f = await bridge.call('pdf:pickFiles', 'images', true, 'Choose the pictures'); if (f) { conv.pics = [...conv.pics, ...f]; renderConvert({}); } },
    pickpicfolder: async () => { const f = await bridge.call('pdf:pickFolder', 'images'); if (f) { if (!f.length) toast('No pictures in that folder.'); conv.pics = [...conv.pics, ...f]; renderConvert({}); } },
    pickconvpdf: async () => { const f = await pickPdf('Choose the PDF to convert'); if (f) { conv.pdf = f; renderConvert({}); } },
    convpics: () => {
      if (!conv.pics.length) return HCMD.pickpics();
      const opts = { pageSize: conv.o.size, orientation: conv.o.or, autoRotate: conv.o.rot, combine: conv.o.one };
      return convBusy(async () => {
        const r = await bridge.call('convert:images', conv.pics, opts);
        conv.results.unshift(...r.outputs.map((o) => ({ output: o, note: `${r.pages} picture${r.pages === 1 ? '' : 's'}${r.rotated ? `, ${r.rotated} turned the right way up` : ''} · ${folderOf(o)}` })));
        conv.pics = [];
      });
    },
    conv: async (b) => {
      if (!conv.pdf) { conv.pdf = await pickPdf('Choose the PDF to convert'); if (!conv.pdf) return; }
      const to = b.dataset.to; const file = conv.pdf;
      const imgOpts = to === 'images' ? { format: conv.o.imgf, dpi: +conv.o.dpi } : null; const tabFmt = to === 'table' ? conv.o.tab : null;
      await convBusy(async () => {
        if (to === 'images') { const r = await bridge.call('convert:pdfToImages', file, imgOpts); conv.results.unshift({ output: r.folder, note: `${r.count} picture${r.count === 1 ? '' : 's'} · ${folderOf(r.folder)}` }); }
        if (to === 'word') { const r = await bridge.call('convert:pdfToWord', file); conv.results.unshift({ output: r.output, note: r.usedOffice ? 'Made by Microsoft Word' : `Basic: the layout may change${r.scannedPages ? `. ${r.scannedPages} scanned page${r.scannedPages === 1 ? ' was' : 's were'} read with text recognition` : ''}` }); }
        if (to === 'table') { const r = await bridge.call('convert:pdfToTable', file, tabFmt); conv.results.unshift({ output: r.output, note: `${r.tables} table${r.tables === 1 ? '' : 's'}, ${r.rows} rows (page${r.pages.length === 1 ? '' : 's'} ${r.pages.join(', ')}). Basic: check the columns.` }); }
        if (to === 'text') { const r = await bridge.call('convert:pdfToText', file); conv.results.unshift({ output: r.output, note: r.emptyPages ? `${r.emptyPages} page${r.emptyPages === 1 ? ' has' : 's have'} no words (scanned): use Recognise text first` : folderOf(r.output) }); }
      });
    },
    convoffice: async () => {
      const files = await bridge.call('files:pick', 'convert'); if (!files || !files.length) return;
      await convBusy(async () => { const r = await bridge.call('convert:toPdf', files, { combine: false }); conv.results.unshift(...r.outputs.map((o) => ({ output: o, note: r.usedOffice ? 'Made by Microsoft Office' : folderOf(o) }))); });
    },
    // Combine
    combadd: async () => { const f = await bridge.call('pdf:pickFiles', 'pdfOrImages', true, 'Choose the files to combine'); if (f) renderCombine({ files: f }); },
    combfolder: async () => { const f = await bridge.call('pdf:pickFolder', 'pdf'); if (f) { if (!f.length) toast('No PDFs in that folder.'); renderCombine({ files: f }); } },
    combmove: (b) => { move(comb.files, +b.dataset.i, +b.dataset.d); renderCombine({}); $(`[data-hcmd="combmove"][data-i="${+b.dataset.i + +b.dataset.d}"][data-d="${b.dataset.d}"]`, taskEl)?.focus(); },
    combrun: async () => {
      toast('Combining…');
      const r = await bridge.call('pdf:combineFiles', comb.files);
      if (!r) return;
      comb.result = { output: r.output, note: `${r.pages} pages from ${comb.files.length} files · ${folderOf(r.output)}` };
      comb.files = []; renderCombine({});
      await E.openFiles([r.output]);
      toast(`Combined into ${fileName(r.output)} (${r.pages} pages).`);
    },
    // Batch
    batadd: async () => { const f = await bridge.call('pdf:pickFiles', 'pdf', true, 'Choose the PDFs'); if (f) renderBatch({ files: f }); },
    batfolder: async () => { const f = await bridge.call('pdf:pickFolder', 'pdf'); if (f) { if (!f.length) toast('No PDFs in that folder.'); renderBatch({ files: f }); } },
    batclear: () => { bat.files = []; renderBatch(); },
    batmove: (b) => { move(bat.order, +b.dataset.i, +b.dataset.d); renderBatch(); },
    batdir: async () => { const d = await bridge.call('pdf:chooseFolder', bat.files[0] ? folderOf(bat.files[0]) : ''); if (d) { bat.dir = d; bat.where = 'folder'; } renderBatch(); },
    batrun: runBatchNow,
    // Compare
    cmppick: async (b) => { const f = await pickPdf(b.dataset.k === 'a' ? 'Choose the original PDF' : 'Choose the changed copy'); if (f) { cmp[b.dataset.k] = f; cmp.result = null; renderCompare(); } },
    cmprun: runCompare,
    cmpgo: (b) => { cmp.sel = +b.dataset.i; $$('.pagelist button', taskEl).forEach((x, i) => { x.classList.toggle('on', i === cmp.sel); x.setAttribute('aria-current', String(i === cmp.sel)); }); drawComparePage(); },
    cmpstep: (b) => {
      const pages = cmp.result.pages; const d = +b.dataset.d;
      for (let i = cmp.sel + d; i >= 0 && i < pages.length; i += d) if (pages[i].status !== 'same') { HCMD.cmpgo({ dataset: { i } }); $$('.pagelist button', taskEl)[i]?.scrollIntoView({ block: 'nearest' }); return; }
      toast(d > 0 ? 'No more changes after this page.' : 'No changes before this page.');
    },
    cmpocr: async () => { const p = cmp.result.pages[cmp.sel]; toast(`Opening the original: use Recognise text, save, then compare again (page ${p.page}).`); await E.ocrFile(cmp.a); },
    // Scan
    scanpage: async () => {
      scan.busy = true; renderScan();
      try {
        const r = await bridge.call('scan:page');
        if (r.ok) { scan.pics.push(r.file); toast(`Page ${scan.pics.length} scanned. Scan the next page, or Make PDF.`); }
        else if (r.reason !== 'cancelled') toast(r.reason === 'no-scanner' ? `${r.message} Windows Fax and Scan is opening: scan there, save the pictures, then choose them under From photos or a folder.` : r.message);
      } finally { scan.busy = false; renderScan(); }
    },
    scanpics: async () => { const f = await bridge.call('pdf:pickFiles', 'images', true, 'Choose the photos of the pages'); if (f) renderScan({ files: f }); },
    scanfolder: async () => { const f = await bridge.call('pdf:pickFolder', 'images'); if (f) { if (!f.length) toast('No pictures in that folder.'); renderScan({ files: f }); } },
    scanclear: () => { scan.pics = []; scan.result = null; renderScan(); },
    scanmove: (b) => { move(scan.pics, +b.dataset.i, +b.dataset.d); renderScan(); },
    scanmake: async () => {
      toast('Making the PDF…');
      const r = await bridge.call('convert:images', scan.pics, { pageSize: 'a4', orientation: 'auto', autoRotate: true, combine: true, temp: true });
      const bytes = await bridge.call('pdf:readQuiet', r.outputs[0]);
      const d = new Date();
      const target = await bridge.call('pdf:save', `Scan ${Hy.formatStampDate(d, 'ymd')}.pdf`, bytes, true);
      if (!target) return;
      scan.result = { output: target, note: `${scan.pics.length} page${scan.pics.length === 1 ? '' : 's'} · ${folderOf(target)}` };
      scan.pics = []; renderScan();
      await E.openFiles([target]);
      toast('Your scan is open. Use Recognise text to make its words searchable, then save.');
    },
    // Settings
    setjump: (b) => { const s = $(`#set-${b.dataset.id}`); if (s) { s.scrollIntoView({ block: 'start', behavior: 'smooth' }); const f = $('input, select, button', s); if (f) f.focus({ preventScroll: true }); } },
    saveprofile: async () => {
      const data = Object.fromEntries(new FormData($('#profileform')).entries());
      await bridge.call('profile:save', data);
      $('#pf-saved').textContent = 'Saved.'; toast('Your details are saved. Use Fill my details in a form.');
    },
    sigdel: async (b) => { const ok = await dialog('<h2>Forget this one?</h2><p class="muted">It\'s taken off this PC. PDFs you already signed keep it.</p><div class="dlgbtns"><button data-dlg="cancel">Cancel</button><button class="primary" data-dlg="ok">Forget it</button></div>'); if (ok === 'ok') { await bridge.call('sig:delete', b.dataset.id); renderSettings({ section: 'signatures' }); } },
    sigdef: async (b) => { await bridge.call('sig:setDefault', b.dataset.id); renderSettings({ section: 'signatures' }); },
    stampdel: async (b) => { const list = set.prefs.stamps.filter((_, i) => i !== +b.dataset.i); await bridge.call('pdfset:set', { stamps: list }); await E.reloadPrefs(); renderSettings({ section: 'stamps' }); },
    makedefault: async () => { const name = await bridge.call('pdf:makeDefault'); toast(`Windows Settings is opening: choose “${name}” for .pdf there.`); },
    inboxopen: () => bridge.call('inbox:open'),
  };
  const DROP = {
    pics: (files) => { const p = files.filter(isPic); if (!p.length) return toast('Drop pictures here (JPG, PNG…).'); conv.pics = [...conv.pics, ...p]; return renderConvert({}); },
    pdf: (files) => { const p = files.filter(isPdf); if (!p.length) return toast('Drop a PDF here.'); conv.pdf = p[0]; return renderConvert({}); },
    combine: (files) => renderCombine({ files }),
    batch: (files) => renderBatch({ files }),
    cmpa: (files) => { const p = files.filter(isPdf); if (p[0]) { cmp.a = p[0]; cmp.result = null; } if (p[1]) cmp.b = p[1]; renderCompare(); },
    cmpb: (files) => { const p = files.filter(isPdf); if (p[0]) { cmp.b = p[0]; cmp.result = null; } renderCompare(); },
    scan: (files) => renderScan({ files }),
  };
  const RENDER = { convert: renderConvert, combine: renderCombine, batch: renderBatch, compare: renderCompare, scan: renderScan, settings: renderSettings };
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (E.tabs.view === 'task' && page.name === 'compare' && cmp.result) drawComparePage(); }, 250); });

  /** Right-click › Convert to images: each PDF's pages saved as pictures (PNG, 150 dpi), shown on the Convert page. */
  async function pdfsToImages(files) {
    if (!files.length) return;
    conv.pdf = files[0];
    openPage('convert', { mode: 'images' });
    await convBusy(async () => {
      for (const f of files) {
        try { const r = await bridge.call('convert:pdfToImages', f, { format: 'png', dpi: 150 }); conv.results.unshift({ output: r.folder, note: `${r.count} picture${r.count === 1 ? '' : 's'} of ${fileName(f)}` }); }
        catch (e) { conv.results.unshift({ ok: false, name: fileName(f), error: e.message }); }
      }
    });
  }

  return { renderHome, openPage, sendToDocuments, pdfsToImages, get page() { return page; }, state: { conv, comb, bat, cmp, scan } };
}
