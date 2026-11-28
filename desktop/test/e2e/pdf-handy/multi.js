// right-click "Combine selected" with three files: Windows starts the program three times; one window gathers them
const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DESK = process.argv[2]; const EL = require(require('path').join(__dirname, '..', '..', '..', 'node_modules', 'electron'));
const HOME = fs.mkdtempSync('/dev/shm/qa-pdfm-'); const F = (n) => path.join((process.env.PDF_FILES || '/dev/shm/pdfh-files'), n);
(async () => {
  const env = { ...process.env, HOME, TMPDIR: '/dev/shm' };
  const app = await _electron.launch({ executablePath: EL, args: ['--no-sandbox', path.join(DESK, 'src', 'pdf-main.js'), '--task=combine', F('Invoice INV-1001.pdf')], env });
  const w = await app.firstWindow(); await w.waitForFunction(() => window.__editor, null, { timeout: 30000 });
  for (const f of ['Invoice INV-1002.pdf', 'Invoice INV-1003.pdf']) spawn(EL, ['--no-sandbox', path.join(DESK, 'src', 'pdf-main.js'), '--task=combine', F(f)], { env, stdio: 'ignore' });
  await w.waitForTimeout(4000);
  const r = await w.evaluate(() => ({ view: document.body.dataset.view, page: window.__editor.home.page.name, files: window.__editor.home.state.comb.files.map((f) => f.split('/').pop()) }));
  console.log(JSON.stringify(r));
  console.log(r.page === 'combine' && r.files.length === 3 ? 'PASS three right-click starts gathered into one Combine' : 'FAIL');
  // "Open" from File Explorer while it's running: a new tab in the same window
  spawn(EL, ['--no-sandbox', path.join(DESK, 'src', 'pdf-main.js'), F('Quote Q-2041 v1.pdf')], { env, stdio: 'ignore' });
  await w.waitForTimeout(3500);
  const t = await w.evaluate(() => window.__editor.tabs.list.map((x) => (x.st.file || '').split('/').pop()));
  console.log(t.includes('Quote Q-2041 v1.pdf') ? 'PASS a double-clicked PDF opens as a tab in the running window' : `FAIL ${t}`);
  console.log(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1 ? 'PASS still one window' : 'FAIL windows');
  await app.close(); fs.rmSync(HOME, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
