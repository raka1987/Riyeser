Riyeser PDF 0.26.0 end-to-end checks and screenshots, in the real program (Electron) under xvfb. Synthetic files only.
Needs Playwright (PLAYWRIGHT=/path/to/node_modules/playwright if it isn't installed here). TMPDIR=/dev/shm keeps it off the disk.
  node test/e2e/pdf-handy/mkfiles.js . /dev/shm/pdfh-files                        sample PDFs (form, two quotes, invoices)
  PDF_FILES=/dev/shm/pdfh-files xvfb-run -a node test/e2e/pdf-handy/shots.js . <out> light|dark 1366|1280
                     tabs, signature and stamps, Fill my details, start screen, Convert, Batch, Compare, Send to Documents, Settings
  xvfb-run -a node test/e2e/pdf-handy/multi.js .     right-click "Combine selected" with 3 files: 3 starts, one Combine page; Open adds a tab
  xvfb-run -a node test/e2e/pdf-handy/kb.js .        keyboard: menus, signature window, Ctrl+W, closing a changed tab asks
  xvfb-run -a node test/e2e/pdf-handy/webshots.js . <out>   website/assets/shots pdf-markup and pdf-tools (1280x800)
Each prints PASS/FAIL lines. tabs/webshots also use a drawing, "Site plan Level 2 - A-201.pdf" (the website's sample site plan), in PDF_FILES.
