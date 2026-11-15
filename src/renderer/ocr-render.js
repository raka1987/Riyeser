// Hidden helper window: draws PDF pages as images so the OCR engine can read scanned documents.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

/** Render up to `maxPages` pages of a PDF to PNG data URLs at roughly 200 dpi. */
window.renderPdf = async (file, maxPages = 3) => {
  const bytes = await window.api.call('ocr:readFile', file);
  const doc = await pdfjsLib.getDocument({ data: bytes, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(200 / 72, 3000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas.toDataURL('image/png'));
  }
  doc.destroy();
  return out;
};
window.ocrReady = true;
