# Riyeser Accounting

*A Riyeser Group module.*

Double-entry business accounting for Australian small and medium businesses. It runs in your browser and keeps everything in one local company file (SQLite). Riyeser is an original product, written from scratch.

## Install

You need **Python 3.10 or newer**.

| Platform | Command |
|---|---|
| macOS / Linux | `./install.sh` |
| Windows (PowerShell) | `powershell -ExecutionPolicy Bypass -File install.ps1` (also adds a desktop shortcut) |
| Any (pip) | `pip install .` (or `pip install riyeser-accounting-1.0.0-py3-none-any.whl`) |

Then run:

```bash
riyeser                                    # opens http://127.0.0.1:8080
riyeser init --name "Acme Pty Ltd" --demo  # optional: create a company file with sample data
riyeser serve --host 0.0.0.0 --port 8080   # multi-user on your office network
riyeser backup                             # safe hot backup of the company file
```

By default the company file is `~/.riyeser/company.db`. You can change this with `--data-dir`, `--db` or the `RIYESER_HOME` environment variable. The first time you run it with no company file, a setup screen opens in the browser. On a new company file you sign in as **admin** with the password you chose (`admin` if you created it with `riyeser init`).

To build a distributable wheel for your own install packages, run `pip wheel . -w dist --no-deps`.

## Desktop app

Riyeser also runs as a normal desktop app in its own window, with no Python needed. It keeps the company file in `~/.riyeser`.

* **Windows installer:** `RiyeserAccounting-Setup-<version>.exe` installs it for your Windows user (no admin needed), with a
  desktop icon, a Start menu entry under *Riyeser Group* and an *Installed apps* listing. It works completely offline:
  it opens in its own window and everything stays on your PC. Uninstalling keeps your company file (`%USERPROFILE%\.riyeser`).
* **Download:** after each push to `main`, GitHub Actions ("Build desktop app") builds
  `Riyeser Accounting.exe` (Windows), `Riyeser Accounting.app` (macOS, zipped) and `riyeser-accounting` (Linux).
  Get them from the workflow run's **Artifacts**. Pushing a tag such as `v1.0.0` also attaches them to a GitHub Release.
* **Build it yourself:** run `pip install ".[desktop]" pyinstaller`, then `python packaging/build_desktop.py`. The app lands in `dist/`.
* **Run from source:** run `pip install ".[desktop]"`, then `riyeser-desktop`.

The builds are unsigned. Windows SmartScreen will warn ("More info → Run anyway"). On macOS, right-click the app → **Open** the first time.

## Forgot your password?

* **Desktop app:** click **Forgot password?** on the sign-in screen. This works only in the desktop app on the computer that holds the company file, so nobody else on the network can use it.
* **Other users:** an administrator can set a new password under **Setup → Users & Roles**.
* **Command line:** run `riyeser reset-password admin` on the computer that holds the company file.

## Features

**Accounts**
* Chart of accounts numbered by type (1- Assets … 9- Other Expenses), with opening balances.
* General journal checks that each entry balances.
* Find Transactions, plus a register and drill-down for every account.
* Reversing entries. Posted entries are never deleted, so the audit trail stays intact.
* Period lock date.
* Linked (control) accounts.

**Banking**
* Spend Money / Receive Money with split allocations. GST can be inclusive or exclusive.
* Transfer Money.
* Bank reconciliation with a live out-of-balance display and undo.
* Bank statement CSV import. Each line can be allocated in one click or split.

**Sales**
* Quote → Order → Invoice conversion.
* Tax-inclusive and tax-exclusive pricing, line discounts and job tagging.
* Printable / PDF invoices.
* Receive Payments, applied across several invoices.
* Customer statements, credit limits and terms.

**Purchases**
* Quotes, purchase orders and bills, plus Pay Bills.
* Supplier card file.

**Inventory**
* Stock items with moving average cost.
* Automatic COGS on invoices.
* Stock adjustments and stocktake.
* Reorder alerts and a valuation report.

**Payroll**
* Hourly and salaried employees on weekly, fortnightly or monthly pay.
* PAYG withholding (approximate), 12% superannuation guarantee and annual leave accrual.
* Pay runs post to the ledger automatically.
* Payslips with year-to-date figures, and reversal of a pay run.

**GST / BAS**
* Tax codes: GST, CAP, FRE, EXP, INP and N-T.
* BAS summary covering G1, G2, G3, G10, G11, 1A, 1B, W1 and W2.
* GST detail by tax code.

**Reports.** All reports can be filtered, printed, drilled into and exported to CSV:
* Profit & Loss, compared with the same period last year and filterable by job
* Balance Sheet
* Trial Balance
* General Ledger detail
* Budget vs Actual
* Cash movement
* Aged Receivables and Aged Payables
* Sales by customer and sales by item (with gross profit)
* Purchases by supplier
* Inventory valuation and items to reorder
* Payroll summary
* Job P&L

**Business setup and control**
* Company details and preferences.
* Jobs (job costing).
* Monthly budgets.
* Users with three roles: Admin, Accountant and read-only Viewer.
* Full audit trail.
* Dashboard showing KPIs, cash, overdue invoices, bills due and low stock.

## How it works

Every business transaction (invoice, bill, payment, pay run, stock adjustment…) becomes a balanced journal entry through `riyeser/ledger.py`. All reports read only from the general ledger, so the trial balance and balance sheet always reconcile. Money is stored as integer cents.

```
riyeser/
  ledger.py        posting engine and business transactions
  payroll_calc.py  PAYG / super / leave calculations
  schema.sql       database schema
  views/           web screens (accounts, banking, sales/purchases, inventory, payroll, reports)
  templates/       HTML
  cli.py           the `riyeser` command
tests/             pytest suite (run: pytest)
```

## Limitations (v1)

* PAYG withholding uses the 2024-25 resident tax rates plus a 2% Medicare levy on annualised earnings. It is **not** the ATO's official Schedule 1 formula. STP lodgement, leave types other than annual leave, and salary sacrifice are not implemented.
* There is no multi-currency support, no direct bank feeds (statements are imported from CSV), no email sending, no recurring transactions, no cash-basis GST and no year-end rollover. Retained earnings are calculated automatically instead.
* Each company file holds one company. For multi-company use, run one `--db` per company.
* Have an accountant review your setup before relying on it for statutory reporting.
