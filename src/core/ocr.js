// Reads text from pictures of documents (scanned PDFs, photos of receipts) with Tesseract, entirely offline.
const path = require('path');
const fs = require('fs');

// When packaged, these modules live in app.asar.unpacked so the OCR worker thread can load them.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const LANG_PATH = unpacked(path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'));

// Inside Electron, Tesseract insists on downloading its language file unless it finds it in its cache folder.
// So we unpack the copy that ships with the app into a cache folder once, and nothing is ever downloaded.
let cacheDir = path.join(require('os').tmpdir(), 'desk-assistant-ocr');
function configure(opts = {}) { if (opts.cacheDir) cacheDir = opts.cacheDir; }
function ensureLanguageFile() {
  const target = path.join(cacheDir, 'eng.traineddata');
  if (!fs.existsSync(target)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const data = require('zlib').gunzipSync(fs.readFileSync(path.join(LANG_PATH, 'eng.traineddata.gz')));
    fs.writeFileSync(target + '.tmp', data);
    fs.renameSync(target + '.tmp', target);
  }
  return cacheDir;
}

let workerPromise = null;
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Text recognition ${what} timed out`)), ms).unref?.())]);
async function resetWorker() {
  const w = workerPromise; workerPromise = null;
  if (w) { try { (await w).terminate(); } catch { /* ignore */ } }
}
let idleTimer = null;
let queue = Promise.resolve();

async function getWorker() {
  clearTimeout(idleTimer);
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const tjsDir = path.dirname(require.resolve('tesseract.js/package.json'));
    const opts = { langPath: LANG_PATH, gzip: true, cachePath: ensureLanguageFile(), cacheMethod: 'readOnly' };
    const workerPath = unpacked(path.join(tjsDir, 'src', 'worker-script', 'node', 'index.js'));
    if (fs.existsSync(workerPath)) opts.workerPath = workerPath;
    let failed;
    opts.errorHandler = (e) => { failed = e; };
    workerPromise = withTimeout(createWorker('eng', 1, opts), 45_000, 'start-up')
      .catch((e) => { workerPromise = null; throw failed || e; });
  }
  return workerPromise;
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise; workerPromise = null;
    if (w) (await w).terminate().catch(() => {});
  }, 90_000); // free the memory when not in use
  idleTimer.unref?.();
}

/**
 * Recognise text in one image (PNG/JPG buffer).
 * Returns { text, confidence, lines: [{ text, x0, y0, x1, y1, confidence }] } with pixel coordinates.
 */
function recognize(image) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    try {
      let data;
      try { ({ data } = await withTimeout(worker.recognize(image), 90_000, 'of this page')); }
      catch (e) { await resetWorker(); throw e; }
      return {
        text: data.text || '',
        confidence: data.confidence,
        lines: (data.lines || []).filter((l) => l.text.trim() && l.confidence > 30)
          .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), confidence: l.confidence, ...l.bbox })),
      };
    } finally { scheduleIdleShutdown(); }
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { recognize, configure, LANG_PATH };
