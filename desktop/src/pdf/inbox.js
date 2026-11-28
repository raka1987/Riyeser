// Riyeser PDF: the "Riyeser PDF inbox" folder, for Print to PDF.
// Riyeser PDF doesn't install a printer. In any program, people print to Windows' own "Microsoft Print to PDF" and
// save into this folder; while Riyeser PDF is open, each new PDF saved there opens in a tab. Nothing is moved or
// changed in the folder. Only PDFs that are new since Riyeser PDF started (or since the folder was switched on) open.
const fs = require('fs');
const path = require('path');

const defaultInboxDir = (documentsDir) => path.join(documentsDir, 'Riyeser PDF inbox');

/**
 * Watch dir for new PDFs. onPdf(file) once per new file, when it has finished being written (same size twice).
 * Returns { stop() }. opts: { settleMs, pollMs } (tests use small values).
 */
function watchInbox(dir, onPdf, { settleMs = 800, pollMs = 3000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set(fs.readdirSync(dir).filter((n) => /\.pdf$/i.test(n)));
  const waiting = new Map();
  let stopped = false;
  const check = (name) => {
    if (stopped || seen.has(name) || waiting.has(name) || !/\.pdf$/i.test(name)) return;
    const f = path.join(dir, name);
    let last = -1;
    const tick = () => {
      if (stopped) return;
      let size = -1; try { size = fs.statSync(f).size; } catch { waiting.delete(name); return; }
      if (size > 0 && size === last) { waiting.delete(name); seen.add(name); onPdf(f); return; }
      last = size; waiting.set(name, setTimeout(tick, settleMs));
    };
    waiting.set(name, setTimeout(tick, settleMs));
  };
  let watcher = null;
  try { watcher = fs.watch(dir, (_ev, name) => { if (name) check(String(name)); }); } catch { /* polling below still works */ }
  // fs.watch can miss files on network folders: look every few seconds as well
  const poll = setInterval(() => { try { for (const n of fs.readdirSync(dir)) check(n); } catch { /* folder gone for now */ } }, pollMs);
  return {
    dir,
    stop() { stopped = true; clearInterval(poll); try { watcher && watcher.close(); } catch { /* closed */ } for (const t of waiting.values()) clearTimeout(t); waiting.clear(); },
  };
}

module.exports = { watchInbox, defaultInboxDir };
