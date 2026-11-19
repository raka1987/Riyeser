// Copies the browser builds of the PDF libraries into src/renderer/vendor so the editor window can load them.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });
const copy = (from, to) => fs.cpSync(path.join(root, 'node_modules', from), path.join(out, to), { recursive: true });
copy('pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs');
copy('pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'cmaps');
copy('pdfjs-dist/standard_fonts', 'standard_fonts');
copy('pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js');
console.log('PDF libraries copied to', path.relative(root, out));
