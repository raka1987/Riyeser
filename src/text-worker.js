// Runs in its own background process: reads the text out of PDFs, Word, Excel etc.
// If a file is huge or broken, only this helper gets stuck - the app window never freezes.
const { extractRaw } = require('./core/extract');

process.parentPort.on('message', async (e) => {
  const { id, file } = e.data || {};
  try { process.parentPort.postMessage({ id, ok: true, result: await extractRaw(file) }); }
  catch (err) { process.parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
});
