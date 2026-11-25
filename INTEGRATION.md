# Connecting Riyeser modules to Riyeser Accounting

All Riyeser Group modules share one folder on the PC: **`Documents\Riyeser`**. You can change it with the `RIYESER_DOCS` environment variable.

```
Documents\Riyeser\
  Accounting\Invoices\2026\...pdf   PDFs written by Riyeser Accounting (for Desk Assistant to file)
  Accounting\Bills\2026\...pdf
  Inbox\Payroll\*.json              pay runs written by Riyeser Payroll, waiting to be imported
  Inbox\Payroll\Imported\           moved here once Accounting has imported them
```

## Riyeser Payroll → Accounting: pay run file

When a pay run is finalised, Riyeser Payroll writes one UTF-8 JSON file to `Documents\Riyeser\Inbox\Payroll\`. Name it `<pay date> <payrun_id>.json`. In Accounting, go to **Money → Import from Payroll** (Basic) or **Banking → Import from Riyeser Payroll** (Enterprise) to see waiting pay runs and import them.

```json
{
  "format": "riyeser.payrun.v1",
  "source": "Riyeser Payroll",
  "payrun_id": "2026-11-14-W46",
  "pay_date": "2026-11-14",
  "period_start": "2026-11-08",
  "period_end": "2026-11-14",
  "currency": "FJD",
  "employees": [
    {"name": "Iliesa", "gross": 650.00, "tax_withheld": 48.00, "employer_contribution": 65.00,
     "other_deductions": 52.00, "net": 550.00}
  ]
}
```

**Fields**
- **Amounts** are numbers in dollars and cents.
- **`tax_withheld`** is PAYG in Australia or PAYE in Fiji.
- **`employer_contribution`** is super in Australia or FNPF in Fiji.
- **`other_deductions`** is optional. It covers the employee's own FNPF share, loans and other deductions.
- **`net`** must equal `gross − tax_withheld − other_deductions`. If you leave it out, it is calculated for you.
- **`payrun_id`** together with `source` must be unique. Accounting refuses to import the same pay run twice. Reversing the import in Accounting allows it to be imported again.

**What Accounting posts** (one summary journal, dated `pay_date`):

| Account | Debit | Credit |
|---|---|---|
| Wages & Salaries | gross | |
| Super / employer contribution expense | employer_contribution | |
| PAYG / PAYE tax withheld payable | | tax_withheld |
| Super / FNPF contribution payable | | employer_contribution |
| Employee deductions payable (own FNPF, loans) | | other_deductions |
| Bank account the user picks on import | | net |

On the first import the user chooses the account for each line (for Fiji, e.g. FNPF Expense, FNPF Payable and
FRCS PAYE Payable); the choice is kept for later imports. Until then the defaults are the company's default accounts
(wages, super expense, PAYG payable, super payable) and a new **2-1430 Payroll Deductions Payable** for deductions.

**`currency`** must match the company's currency (Setup → Company details, default AUD). A pay run in another
currency is refused rather than booked one-for-one (FJ$10,870 is not A$10,870).

## Accounting → Desk Assistant: PDFs

- Each document has a **Save to Riyeser folder** button.
- The **Save a PDF of every invoice and bill** setting (Setup → Company) writes files to `Accounting\<Invoices|Quotes|Bills|Purchase Orders>\<year>\`.
- File names follow `<date> <customer or supplier> <type> <number>.pdf`, the same "date, company, type, reference" style Desk Assistant uses.

## Hub → Accounting

- The hub opens `%LOCALAPPDATA%\Programs\Riyeser Accounting\Riyeser Accounting.exe`. Its Installed-apps DisplayName is `Riyeser Accounting <version>`.
- To run it embedded with no window: `Riyeser Accounting.exe --no-window --port <port>`, then show `http://127.0.0.1:<port>`.
- The company file is `%USERPROFILE%\.riyeser\company.db`.

## Central → every program: demo mode

- Central writes `%APPDATA%\Riyeser\demo.json` (next to `company.json` and `licence.json`): `{"on": true, "since": "<ISO>", "business": "Sample Trading Co"}`. No file, a damaged file or `"on": false` means normal mode. `RIYESER_DEMO_FILE` points elsewhere (tests, dev server).
- Demo on: Accounting Basics/Plus, Invoices, Bookings and POS all open `%USERPROFILE%\.riyeser\demo\company.db` instead of the real `company.db`. They share one folder in normal mode, so they share one demo folder too. Whichever opens first makes "Sample Trading Co (demo)" there (under a lock); the others open the same file.
- The demo signs in on its own as `demo` (password `demo`, administrator). After signing out, the login page says "Demo mode: sign in with demo / demo".
- The demo's staff are `riyeser.demo.DEMO_STAFF`; Riyeser Payroll's demo uses the same people.
- Leaving demo mode: set `"on": false`, then rename `.riyeser\demo` to `.riyeser\demo-ended-<UTC stamp>` (never delete it). Close the programs first, or reopen them afterwards: a program that is still open shows "Demo mode has ended. Close this program and open it again." Next time demo is switched on, a fresh demo folder is made.

## Accounting company files and backups (for Central's "Back up everything / Restore everything")

**Company files** (all Accounting apps: Basics, Plus, Invoices, POS, Bookings share them):
- Folder: `%USERPROFILE%\.riyeser\` (`~/.riyeser/` on Mac and Linux), or `RIYESER_HOME` when set. No installer or
  uninstaller touches it.
- The first company: `company.db`. Other companies: `companies\<id>.db`, listed in `companies.json`
  (`[{"id", "file", "archived"}]`, `file` relative to the folder).
- Each file is one SQLite database. Copy it with SQLite's online backup (or while no Accounting app is running).

**Backups** (the owner's standard OWNER-BACKUP, the same in every Riyeser program):
- Folder: `Documents\Riyeser\Accounting\Backups\<company file name without .db>\`, e.g. `Backups\company\` and
  `Backups\acme-pty-ltd-3f2a1b\` (`RIYESER_DOCS` replaces `Documents\Riyeser`). Outside the install folder, so
  backups survive uninstalling, reinstalling and moving PCs.
- File names: `<YYYY-MM-DD HHMMSS> <company name>.db` (a before-restore copy ends in `(before restore).db`). Each is a
  plain company file, which can be restored as it is.
- Accounting makes one automatic backup a day of each company the first time it's opened that day, and keeps the last
  30 per company. **Setup → Backups** has *Back up now*, *Open the backups folder*, a download copy, and *Restore from a
  backup…* (pick a file anywhere, see the company name and counts, then restore over the company, saving a
  before-restore copy first, or bring it in as "<name> (restored 25 Nov 2026)"). With no company yet, the first-run
  screen offers *Restore from a backup…* next to creating a new company. `riyeser backup` writes to the same folder.
