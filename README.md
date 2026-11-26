# Riyeser Payroll

Time clock, timesheets, pay runs, payslips, leave, pay history and reports for a small business. Part of the Riyeser suite
(the hub that opens each program is Riyeser Central). The company name, pay rules and tax tables are set in Settings.

## Tech stack
- Node.js 22.5+ (built-in `node:sqlite`), Express 5, plain HTML/CSS/JavaScript (no front-end framework)
- One SQLite file for all records; cookie sessions; live updates over WebSocket
- exceljs (wage report import), pdf.js and tesseract.js (bank statement PDFs, read on the computer), nodemailer (email)
- Windows program: Electron + electron-builder (NSIS installer and portable .exe)
- Tests: `node --test`

## Run it (web)
```bash
npm install
ADMIN_PASSWORD='choose-a-strong-one' npm start
```
Open http://localhost:3000 and log in as `admin` with that password (or the one saved in
`data/FIRST_RUN_ADMIN_PASSWORD.txt` if you didn't set one). Records are in `data/payroll.db`. Back it up regularly.

A fresh install starts with no staff, no pay and no company details.

## Access by area
Each person has a level in each area: employees, pay rates & bank details, timesheets, pay runs & payslips, leave,
reports and setup. Levels: **Hidden**, **View**, **Add & edit** (no deleting) and **Full**. Presets: Owner (Administrator),
Payroll officer, Supervisor (their own team only, no pay rates or bank details), Employee self-service (their own
timesheets and payslips) and Read-only. Administrators always have Full access and are the only ones who change access;
the last active administrator can't be removed. Everything is checked on the server for every request, and access, pay
and bank detail changes and deletions are kept in an audit trail.

## What's in it
- **Time clock** on a shared PC: each person taps their name and types their own 4-digit PIN.
- **Timesheets**: by person or as a list, opening on the pay run's pay period; click a day's line to change it in place (paid
  days are locked), Edit week, multi-shift entry, week grids with running totals, supervisor approval, print and email.
- **Roster**: plan the week on a grid of people and days: shifts with start, finish, unpaid break, role or area and a note;
  copy last week, repeat a shift on other days, drag a shift to another day or person (Ctrl copies), open shifts (nobody yet).
  Warnings for overlapping shifts, leave already booked, shifts over 12 hours and weeks over the normal week. Hours and
  estimated wages per person and for the week. **Publish roster**: staff see their shifts on the time clock (after tapping
  their name) and on the Roster page, printed (or saved as PDF), or as plain text for WhatsApp / SMS. Changes after
  publishing are marked until it's published again; staff then see them marked "changed". Timesheets show early / late
  against the published roster, and **Start next pay run** can fill hours from it for people who don't clock in.
- **Payroll**: normal week 40 hours by default, weekly pay, FNPF and PAYE rates in Settings, unpaid break rules, regular
  deductions per person. Pay runs: preview, then finalise. **Start next pay run** opens the next period in one click and
  copies last week's hours (or starts empty, as chosen in Payroll rules); click a name to change that person's days.
- **Payslips** with year-to-date totals. Print, save as PDF or email them. Everyone can see their own.
- **Leave**: annual and sick leave entitlement, leave taken and balances.
- **Import wage reports**: monthly Excel wage reports (one sheet per person, a row per week), checked for problems before saving.
- **Bank statements**: PDF (text or scanned, read on the computer and checked against the running balance), CSV or Excel.
  Wage payments ("Name Pay 230.00", or the company's name and a staff name) are matched to staff and shown next to pay history.

## Windows program
- **Build:** `cd desktop && npm install && npm run build` (on Linux this needs Wine), or run **Actions → Windows app** on GitHub,
  which builds on Windows, checks the program starts, and keeps `RiyeserPayroll-Setup-x.y.z.exe` and
  `RiyeserPayroll-Portable-x.y.z.exe` as downloads.
- **Installs to:** `%LOCALAPPDATA%\Programs\riyeser-payroll\Riyeser Payroll.exe` (per user; silent install: `/S`).
- **Records:** `%APPDATA%\Riyeser Payroll\payroll\payroll.db`, on the computer only. The first start asks for the owner's login.
- **Earlier versions:** records from the earlier "Riyser" program are brought in the first time (the old files are kept).
- **Backups:** a copy every day in `Documents\Riyeser\Payroll\Backups` (the last 30 are kept), plus **Payroll → Back up now** and
  **Payroll → Restore from a backup…** (also in **Settings → Backups**, with a **Restore** button on each backup, and on the
  first-run screen of a new PC or a reinstall). Restoring backs up the current records first, then restarts. It also offers
  records put away by Central's "Fresh start on this PC" (`%APPDATA%\Riyeser Payroll (before fresh start …)\payroll\payroll.db`).
- **Uninstalling** never removes the records or `Documents\Riyeser` (the installer is built with `deleteAppDataOnUninstall: false`).

### Where Payroll keeps its files (for backing up everything)
| What | Path (Windows) |
|---|---|
| Records (one SQLite file; copy it with its `-wal` file, or use a backup) | `%APPDATA%\Riyeser Payroll\payroll\payroll.db` |
| Locked copies from **Start again** and their log | `%APPDATA%\Riyeser Payroll\payroll\archive\` |
| Demo-mode records | `%APPDATA%\Riyeser Payroll\payroll\demo\payroll.db` |
| Daily and manual backups (`payroll-daily-….db`, `payroll-manual-….db`, `payroll-before-restore-….db`) | `Documents\Riyeser\Payroll\Backups\` |
| Payslip PDFs | `Documents\Riyeser\Payroll\Payslips\` |
| Demo backups and payslips | `Documents\Riyeser\Payroll\Demo\` |
| Pay runs written for Riyeser Accounting (`riyeser.payrun.v1`) | `Documents\Riyeser\Inbox\Payroll\` |

The Accounting inbox follows `RIYESER_DOCS` when that is set. A backup file can be restored on any PC with **Restore from a backup…**.

## Before paying staff from it
Check the PAYE brackets and FNPF rates against the current FRCS and FNPF rules (Settings and Payroll → Payroll rules).

## Tests
```bash
npm test
```
All test data is made up.
