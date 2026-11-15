// Hidden helper window: draws PDF pages as images (for OCR, conversions, exporting pages) and decodes pictures.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

/** Render pages of a PDF to image data URLs. opts: { dpi (default 200), format 'png'|'jpeg', quality, startPage (1-based) } */
window.renderPdf = async (file, maxPages = 3, opts = {}) => {
  const { dpi = 200, format = 'png', quality = 0.85, startPage = 1 } = opts || {};
  const bytes = await window.api.call('ocr:readFile', file);
  const doc = await pdfjsLib.getDocument({ data: bytes, cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false }).promise;
  const out = [];
  for (let i = startPage; i <= Math.min(doc.numPages, startPage + maxPages - 1); i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, 4000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', quality));
  }
  doc.destroy();
  return out;
};

/** Decode any picture the browser understands (WebP, BMP, GIF...) and return it as PNG. */
window.imageToPng = (dataUrl) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); resolve(c.toDataURL('image/png')); };
  img.onerror = () => reject(new Error('This picture format can\'t be read'));
  img.src = dataUrl;
});
window.ocrReady = true;
