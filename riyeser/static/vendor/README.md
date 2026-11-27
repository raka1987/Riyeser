# Vendored libraries (served by the app itself: no CDN, so Riyeser Estimate works offline)

| Library | Version | Licence | Used for |
|---|---|---|---|
| Leaflet (`leaflet/`) | 1.9.4 | BSD-2-Clause (`leaflet/LICENSE`) | The map in Riyeser Estimate (tiles come from the imagery provider; only the map needs the internet) |
| pdf.js (`pdfjs/`, from `pdfjs-dist`) | 4.10.38 | Apache-2.0 (`pdfjs/LICENSE`) | Showing PDF plans to measure on (`pdf.min.mjs`, `pdf.worker.min.mjs`, `standard_fonts/`) |

pdf.js's `standard_fonts/` are the PDFium Foxit fonts (BSD-3-Clause, `standard_fonts/LICENSE_FOXIT`) and the
Liberation fonts (SIL OFL 1.1, `standard_fonts/LICENSE_LIBERATION`). To update: `npm pack leaflet@x pdfjs-dist@y`, copy the same files, and keep this table current.
pdf.js is opened with `isEvalSupported: false`.
