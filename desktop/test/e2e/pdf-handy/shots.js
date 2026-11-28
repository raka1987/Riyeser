// Riyeser PDF 0.26.0 evidence: real Electron under xvfb, synthetic files. node shots.js DESK OUT theme(light|dark) size(1366|1280) [only]
const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'); const path = require('path');
const [DESK, OUT, THEME = 'light', SIZE = '1366', ONLY = ''] = process.argv.slice(2);
const FILES = (process.env.PDF_FILES || '/dev/shm/pdfh-files');
const [W, H, SCALE] = SIZE === '1280' ? [1024, 576 + 0, 1.25] : [1366, 768, 1];
const HOME = fs.mkdtempSync('/dev/shm/qa-pdfshot-');
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // a Riyeser Documents library on this "PC", and Riyeser PDF's own settings (theme)
  const docs = path.join(HOME, 'Documents'); fs.mkdirSync(docs, { recursive: true });
  const docsLinux = HOME; // Electron on Linux gives the home folder as Documents
  const { Library } = require(path.resolve(DESK, 'src/documents/library'));
  new Library({ root: path.join(docsLinux, 'Riyeser Documents'), cacheDir: null, me: { id: 'local:owner', name: 'Owner' } }).ensureLayout();
  const data = path.join(HOME, '.config', 'Desk PDF', 'data'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'theme.json'), JSON.stringify(THEME));
  fs.mkdirSync(path.join(HOME, '.config', 'Riyeser'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.config', 'Riyeser', 'company.json'), JSON.stringify({ name: 'Sample Plumbing Ltd', your_name: 'Jo Sample', tax_number: '51 824 753 556', address: '12 Sample Street, Suva', phone: '+679 555 0100', email: 'office@sampleplumbing.example', mode: 'local' }));
  const work = path.join(HOME, 'Work'); fs.cpSync(FILES, work, { recursive: true });
  const F = (n) => path.join(work, n);
  const app = await _electron.launch({ executablePath: require(require('path').join(__dirname, '..', '..', '..', 'node_modules', 'electron')), args: ['--no-sandbox', `--force-device-scale-factor=${SCALE}`, '--lang=en-AU', path.join(DESK, 'src', 'pdf-main.js')], env: { ...process.env, HOME, TMPDIR: '/dev/shm', XDG_DOCUMENTS_DIR: docs, LANG: 'en_AU.UTF-8' }, colorScheme: 'no-override' });
  const w = await app.firstWindow();
  const errors = [];
  w.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  w.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('[console]', m.text().slice(0, 300)); } });
  w.on('dialog', (d) => d.accept().catch(() => {}));
  await w.waitForFunction(() => window.__editor, null, { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }, [a, b]) => { BrowserWindow.getAllWindows()[0].setContentSize(a, b); }, [W, H]);
  // save dialogs answer themselves in this run (a folder in the test home)
  await app.evaluate(({ dialog }, dir) => {
    let n = 0;
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: require('path').join(dir, require('path').basename((o && o.defaultPath) || `saved-${++n}.pdf`)) });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, path.join(HOME, 'Saved'));
  fs.mkdirSync(path.join(HOME, 'Saved'));
  await wait(1500);
  const shot = async (name, keepToast = false) => { await wait(500); if (!keepToast) await w.evaluate(() => document.querySelector('#toast').classList.remove('show')); await wait(250); const f = path.join(OUT, `${name}-${THEME}-${SIZE === '1280' ? '1280@1.25' : '1366'}.png`); await w.screenshot({ path: f }); const hs = await w.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth); ok(!hs, `${name}: no sideways scrolling`); };
  const E = (fn, arg) => w.evaluate(fn, arg);
  const want = (n) => !ONLY || ONLY.split(',').includes(n);

  // ---- tabs: three PDFs, one with unsaved changes; recent files and a pinned one
  await E((fs2) => window.__editor.openFiles(fs2), [F('Quote Q-2041 v1.pdf'), F('Invoice INV-1001.pdf'), F('Site plan Level 2 - A-201.pdf')]);
  await wait(2500);
  ok(await E(() => window.__editor.tabs.list.length) === 3, 'three PDFs open in tabs');
  // a change on the site plan: a tick (the tab gets its unsaved dot)
  await E(() => { const ed = window.__editor; ed.setTool('check'); });
  const page = await w.$('.page'); const pb = await page.boundingBox();
  await w.mouse.click(pb.x + pb.width * 0.62, pb.y + pb.height * 0.32); await wait(300);
  await E(() => window.__editor.setTool('select'));
  ok(await E(() => !!document.querySelector('.tab.dirty .dot')), 'the changed tab shows its unsaved dot');
  if (want('tabs')) await shot('tabs');

  // ---- signature (typed, saved), placed with one click; stamps PAID and a custom one
  await E(() => window.__editor.commands.signature()); await wait(400);
  await w.click('[data-sigtab="type"]'); await w.fill('#sigtext', 'Jo Sample'); await wait(200);
  if (want('signature')) await shot('signature-window');
  await w.click('[data-cmd="sigplace"]'); await wait(800);
  // drag the signature down to the title block
  let sig = await w.$('.ann.image');
  ok(!!sig, 'signature placed on the page');
  if (sig) { const b = await sig.boundingBox(); await w.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await w.mouse.down(); await w.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 110, { steps: 6 }); await w.mouse.up(); await wait(300); }
  // one click: My initials needs one first; My signature places the saved one
  const before = await E(() => Object.values(window.__editor.st.anns).flat().filter((a) => a.type === 'image').length);
  await w.click('#signbtn'); await wait(200); await w.click('[data-cmd="mysignature"]'); await wait(800);
  ok(await E(() => Object.values(window.__editor.st.anns).flat().filter((a) => a.type === 'image').length) === before + 1, 'My signature places the saved signature with one click');
  await E(() => { const ed = window.__editor; ed.st.selected && ed.commands.undo(); }); await wait(300);
  // stamps
  await w.click('#stampbtn'); await wait(200);
  await w.click('#stampmenu [data-stamp="p0"]'); await wait(500); // PAID
  const stamp = await E(() => Object.values(window.__editor.st.anns).flat().find((a) => a.type === 'stamp'));
  ok(stamp && stamp.text === 'PAID' && /\d/.test(stamp.sub), `PAID stamp with today's date: ${stamp && stamp.sub}`);
  const st = await w.$('.ann.stamp'); if (st) { const b = await st.boundingBox(); await w.mouse.move(b.x + 20, b.y + 10); await w.mouse.down(); await w.mouse.move(b.x - 160, b.y - 120, { steps: 6 }); await w.mouse.up(); }
  await E(() => window.__editor.setTool('select')); await w.mouse.click(5, 300); await wait(200);
  await w.click('#signbtn'); await wait(300);
  if (want('signature')) await shot('signature-stamps');
  await w.keyboard.press('Escape'); await wait(200);
  await w.click('#stampbtn'); await wait(300);
  if (want('signature')) await shot('stamp-menu');
  await w.keyboard.press('Escape');
  // the saved PDF has the stamp and the signature
  await E(() => window.__editor.commands.save()); await wait(2500);
  ok(await E(() => !window.__editor.st.dirty), 'saved: no unsaved dot');

  // ---- Fill my details (from Central's company.json)
  await E((f) => window.__editor.openTab(f), F('Supplier application form.pdf')); await wait(2500);
  await E(() => window.__editor.fillMyDetails()); await wait(2000);
  const vals = await E(() => Object.fromEntries(window.__editor.st.form.map((f) => [f.name, f.value])));
  ok(vals.Text1 === 'Jo Sample' && vals.Text2 === 'Sample Plumbing Ltd' && vals.Text3 === '51 824 753 556' && vals.Text6 === 'office@sampleplumbing.example' && !vals.Text7, `Fill my details: ${JSON.stringify(vals)}`);
  ok(await E(() => document.querySelectorAll('.fillhl').length) >= 6, 'filled boxes are highlighted on the page');
  if (want('fill')) await shot('fill-my-details');
  await E(() => window.__editor.commands.fillundo()); await wait(1200);
  ok(await E(() => window.__editor.st.form.every((f) => !f.value || f.kind !== 'text')), 'Undo takes the details out again');
  await E(() => window.__editor.fillMyDetails()); await wait(1200);

  // ---- start screen (recent files, one pinned)
  await E(() => window.__editor.commands.home()); await wait(800);
  await w.click('.recent [data-pin]'); await wait(500);
  if (want('start')) await shot('start');
  ok(await E(() => document.querySelectorAll('#tiles .tile').length) === 10, 'ten task tiles');

  // ---- Convert: pictures to PDF (A4, turned upright), PDF to Excel
  await E((f) => window.__editor.home.openPage('convert', { files: f }), [F('photo-exif6.jpg'), F('scan.jpg'), F('Invoice INV-1004 with lines.pdf')]); await wait(500);
  await w.selectOption('#cv-size', 'a4');
  await w.click('[data-hcmd="convpics"]'); await wait(2500);
  await w.click('[data-hcmd="conv"][data-to="table"]').catch(() => {}); await wait(2500);
  await w.click('[data-hcmd="conv"][data-to="text"]'); await wait(2000);
  const res = await E(() => [...document.querySelectorAll('.results li')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(res.some((r) => /photo-exif6 \(combined\)\.pdf.*1 turned the right way up/.test(r)), `pictures to PDF: ${res[res.length - 1]}`);
  ok(res.some((r) => /INV-1004 with lines\.txt/.test(r)) && res.some((r) => /INV-1004 with lines\.xlsx.*1 table, 5 rows/.test(r)), `PDF to text and Excel: ${res.join(' | ')}`);
  if (want('convert')) await shot('convert');

  // ---- Batch: three invoices, watermark + page numbers + rename into a folder
  await E((f) => window.__editor.home.openPage('batch', { files: f, actions: ['watermark', 'pagenumbers', 'rename'] }), [F('Invoice INV-1001.pdf'), F('Invoice INV-1002.pdf'), F('Invoice INV-1003.pdf')]); await wait(400);
  await w.fill('#bo-wt', 'PAID'); await wait(100);
  await w.click('[data-hcmd="batrun"]'); await wait(3500);
  const bres = await E(() => [...document.querySelectorAll('.results li')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
  ok(bres.length === 3 && bres.every((r) => /Invoice INV-100\d \(\d{4}-\d\d-\d\d\)\.pdf/.test(r)), `batch results: ${bres[0]}`);
  ok(fs.existsSync(F('Invoice INV-1001.pdf')) && fs.readdirSync(work).filter((n) => /^Invoice INV-100\d \(/.test(n)).length === 3, 'new files next to the originals; originals kept');
  if (want('batch')) await shot('batch');
  await E(() => document.querySelector('.progress').scrollIntoView({ block: 'center' })); await wait(300);
  if (want('batch')) await shot('batch-results');

  // ---- Compare two versions of the quote
  await E((f) => window.__editor.home.openPage('compare', { files: f }), [F('Quote Q-2041 v1.pdf'), F('Quote Q-2041 v2.pdf')]); await wait(300);
  await w.click('[data-hcmd="cmprun"]'); await wait(3000);
  const cl = await E(() => [...document.querySelectorAll('.pagelist button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  ok(cl.length === 2 && /changes/.test(cl[0]) && /change/.test(cl[1]), `compare: ${cl.join(' | ')}`);
  ok(await E(() => document.querySelectorAll('#cmp-a .mark.del').length > 0 && document.querySelectorAll('#cmp-b .mark.add').length > 0), 'removed words red on the original, added words green on the changed copy');
  if (want('compare')) await shot('compare');

  // ---- Send to Riyeser Documents
  await E((f) => window.__editor.openTab(f), F('Quote Q-2041 v2.pdf')); await wait(1500);
  await E(() => { window.__editor.commands.senddocs(); }); await wait(800);
  if (want('send')) await shot('send-to-documents');
  await w.selectOption('#sd-dept', 'Sales').catch(() => {});
  await w.click('#dlgbox [data-dlg="ok"]'); await wait(1200);
  const inbox = fs.readdirSync(path.join(docsLinux, 'Riyeser Documents', '_Inbox'));
  ok(inbox.includes('Quote Q-2041 v2.pdf'), `in the Documents Inbox: ${inbox.join(', ')}`);
  if (want('send')) await shot('send-to-documents-done');

  // ---- Settings
  await E(() => window.__editor.commands.settings()); await wait(1200);
  if (want('settings')) await shot('settings');
  await E(() => document.querySelector('#set-stamps').scrollIntoView()); await wait(300);
  if (want('settings')) await shot('settings-stamps');

  // ---- keyboard: tab through the start screen
  await E(() => window.__editor.commands.home()); await wait(500);
  await w.keyboard.press('Tab'); await w.keyboard.press('Tab'); await w.keyboard.press('Tab');
  const foc = await E(() => document.activeElement && (document.activeElement.textContent || '').trim().slice(0, 30));
  ok(!!foc, `keyboard focus reaches the start screen: "${foc}"`);
  ok(!errors.length, `no page errors (${errors.length})`);
  // signatures on disk aren't readable
  const sigFile = path.join(data, 'signatures.json');
  ok(fs.existsSync(sigFile), `signature saved: ${fs.existsSync(sigFile) ? JSON.parse(fs.readFileSync(sigFile, 'utf8')).map((s) => s.sealed.slice(0, 6)).join(',') : 'none'}`);
  await app.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
})().catch(async (e) => { console.error('FAIL', e.stack); process.exitCode = 1; process.exit(1); });
