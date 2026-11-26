# Riyeser Documents (formerly Riyeser Desk Assistant)

*A Riyeser Group product, opened from Riyeser Central. This folder also builds Riyeser Central, Riyeser PDF, As Built,
Riyeser Link and Riyeser Link Office. Build every Windows installer with `npm ci` then `npm run dist:all`.*

Riyeser Documents keeps the office's paperwork in one library: scans, photos and files, filed into department folders,
searchable by the text inside them. Free for 3 users, like the other free Riyeser programs.

- **Getting documents in.** Upload, or drag files onto the window (a copy goes in; the original stays where it was).
  **Scan** from a scanner on this PC (Windows' own scan window, through WIA), or at the office printer: each department
  has a scan folder (`<library>\_Scans\Accounts` ...) to add as a "Scan to folder" destination, and new scans appear
  in the Inbox within seconds with the department already set. `_Scans\Email in` is there for scan-to-email later.
- **Inbox and suggested filing.** Every new document is read (OCR for scans and photos) and gets a suggested folder,
  for example `Accounts › Suppliers › Pacific Hardware › 2026`, from (1) your filing rules ("anything that mentions BSP
  goes in Accounts › Bank statements"), (2) where you filed similar documents before and (3) what the document is and
  who it's from. **File it** moves it there (and renames it if you tick the suggested name), **Change** picks another
  folder (and is remembered), **File all as suggested** does the lot.
- **Finding things.** One search box for names and the text inside scans; Show (Scans / Photos / Documents), From and
  Sort; preview of PDFs and pictures; Open, Print (to a chosen printer), Move, Rename, Delete and Open in Riyeser PDF,
  for one document or several (Ctrl/Shift-click or Select).
- **Recycle bin.** Deleted documents are kept for 30 days and can be restored to where they were.
- **People and access.** Settings › People & access: per folder, for Everyone, groups and single people — No access
  (hidden), View, Add, Edit or Full. The owner always has Full access. A document can be marked Private. On a shared
  network folder, Windows folder permissions are the hard lock; the app says so.
- **History.** Who added, filed, moved, renamed, printed, deleted and restored what, per document and for the library.
- **One library for several PCs.** Put the library on a shared folder (Settings › Library), e.g.
  `\\OFFICE-PC\Riyeser Documents`. If it's briefly unreachable, each PC shows the documents it saw last and waits.

Demo mode (Riyeser Central › Try the demo) shows a sample library for Sample Trading Co, kept apart from real documents.

## Where things are

```
<library>\Accounts\Suppliers ...   department folders (real Windows folders; anything put here is picked up)
<library>\_Inbox                   new documents waiting to be filed
<library>\_Scans\<department>      scan-to-folder targets for the office printers (watched every few seconds)
<library>\_Recycle bin             deleted documents (30 days)
<library>\_Riyeser                 library.json (the list, rules, what it learned), access.json, history.jsonl
%APPDATA%\Desk Assistant\data      this PC's settings (documents.json), a copy of the list, backups
```

The data folder keeps its Desk Assistant name so the update from Desk Assistant keeps everything. The list Riyeser
Central searches (`data\index.json`) is written from the library.

## Run it

You need [Node.js](https://nodejs.org) 22.

```bash
npm ci
npm start
npm test
```

## Build the Windows installers

```bash
npm run dist:win     # Riyeser Documents -> dist/RiyeserDocuments-Setup-<version>.exe (+ a RiyeserDeskAssistant-Setup copy)
npm run dist:pdf     # Riyeser PDF       -> dist-pdf/RiyeserPDF-Setup-<version>.exe
npm run dist:all     # every program
```

Riyeser Documents keeps Desk Assistant's app id (`com.deskassistant.app`), install folder (`desk-assistant`), program
file (`Riyeser Desk Assistant.exe`) and data folder, so installed copies update in place; Windows shows it as
Riyeser Documents. The installers are one-click and per-user (no admin rights needed). On Linux/macOS, building them
needs Wine. Icons live in `build/` (`scripts/make-ico.py` makes the .ico files).

## Project layout

```
src/main.js              Riyeser Documents: window, tray, scan-folder watcher, printing, scanning, background reading
src/documents/           the library logic (no Electron), covered by test/documents.test.js
  library.js             folders, Inbox, filing, move/rename, Recycle bin, history, the shared list and its lock
  suggest.js             suggested folders: rules, learning, document type
  access.js              No access / View / Add / Edit / Full, groups, Private
  scanfolders.js         scan-to-folder paths, printer steps, the watcher
  scanner.js             Windows' WIA scan window (PowerShell) and Fax and Scan
  service.js             everything the window asks for
  demo.js                the demo library
src/core/                shared logic: text extraction, OCR, classifier, learning, safety, licences, backups...
src/renderer/documents.* the Riyeser Documents window (plain HTML/CSS/JS)
src/renderer/editor.*    the PDF editor (Riyeser PDF, also opened from Documents)
src/central-main.js      Riyeser Central
test/                    npm test
```

## Riyeser PDF (stand-alone PDF editor)

The PDF viewer/editor is its own small app, **Riyeser PDF**; Documents opens the same editor with **Open in Riyeser
PDF**. Both share `src/pdf-ipc.js` and `src/renderer/editor.*`.

## Coming later (phase 2)

Riyeser cloud sync, linking offices through Riyeser's relay, share links, request-files links, accountant access, and
making records in Accounting, Payroll and Bookings straight from a document.
