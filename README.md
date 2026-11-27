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

* **Windows installers:** `RiyeserAccountingBasics-Setup-<version>.exe`, `RiyeserAccountingPlus-Setup-<version>.exe` and `RiyeserPOS-Setup-<version>.exe` install it for your Windows user (no admin needed), with a
  desktop icon, a Start menu entry under *Riyeser Group* and an *Installed apps* listing. It works completely offline:
  it opens in its own window and everything stays on your PC. Uninstalling keeps your company file (`%USERPROFILE%\.riyeser`).
* **Download:** after each push to `main`, GitHub Actions ("Build desktop app") builds
  `Riyeser Accounting.exe` (Windows), `Riyeser Accounting.app` (macOS, zipped) and `riyeser-accounting` (Linux).
  Get them from the workflow run's **Artifacts**. Pushing a tag such as `v1.0.0` also attaches them to a GitHub Release.
* **Build it yourself:** run `pip install ".[desktop]" pyinstaller`, then `python packaging/build_desktop.py --edition basics` (or `plus`, or `pos`). The app lands in `dist/`.
* **Run from source:** run `pip install ".[desktop]"`, then `riyeser-desktop`.

The builds are unsigned. Windows SmartScreen will warn ("More info → Run anyway"). On macOS, right-click the app → **Open** the first time.

## Forgot your password?

* **Ask an administrator:** they can set a new password under **Setup → Users & Roles**.
* **Desktop app:** click **Forgot password?** on the sign-in screen (only in the desktop app, on the computer that holds the company file). It needs proof, the same two ways as Riyeser Payroll:
  * **Email me a code** (when email is set up and the person's email address is saved under Users & Roles): a 6-digit code, good once for 15 minutes, at most 3 an hour, 5 wrong tries cancel it.
  * **I'm the business owner:** the owner signs in with their Riyeser account (and two-step code, if they have one). The PC must be linked to their business in Riyeser Central, and they must be its owner. Then they choose the user and set the new password.
* There is no reset without proof, and no command-line reset. Every reset is in the audit log, and the person's other sessions are signed out.

## Three apps: Accounting Basics, Accounting Plus and Riyeser POS

This code base ships as **three separate Windows apps**, so they're easy to look after. Each has its own installer, name, icon and colours, so nobody mixes them up:

| | **Riyeser Accounting Basics** | **Riyeser Accounting Plus** | **Riyeser POS** |
|---|---|---|---|
| Price | Free for 90 days, then a Riyeser licence | Free for 90 days, then a Riyeser licence | Free for 90 days, then a Riyeser licence |
| Looks | Green, "B." logo | Blue, "P." logo | Teal, "Po." logo |
| Has | Invoices, quotes, customers, suppliers, bills, stock, simple money in/out, key reports | Everything in Basics plus bank reconciliation, statement import, payroll, general journal, jobs, budgets, Balance Sheet and Trial Balance | The till: retail or restaurant, receipts, tables and kitchen dockets, manager approvals, refunds, close till, plus products, stock and customers |
| Installer | `RiyeserAccountingBasics-Setup.exe` | `RiyeserAccountingPlus-Setup.exe` | `RiyeserPOS-Setup.exe` |

* **Same books.** All three open the same company files in `~/.riyeser`, which no installer or uninstaller touches.
* **Upgrade:** install Plus. It replaces Basics and opens the books exactly as they were.
* **Downgrade:** install Basics. It asks first, then replaces Plus. Payroll, journals, jobs and budgets stay in the company file (hidden) and come back if Plus is installed again.
* **Plus after the trial without a licence:** the everyday screens keep working; the Plus-only screens lock (nothing removed) until a licence is entered in Riyeser Central.
* Existing *Riyeser Accounting 1.x* installs update in place to Plus.
* **Riyeser POS installs next to Accounting** (it never replaces Basics or Plus) and works without it. Each till sale is a paid tax invoice in the same company file, so Accounting's stock, GST and reports include it straight away. Accounting Basics and Plus don't have a till of their own: their **Riyeser POS** menu item opens POS, or offers the download.
* **90-day free trial:** every paid program is free for 90 days, with a reminder in the last two weeks. The rule lives in one place, `riyeser/plan.py` (the trial and licence come from Riyeser Central's licence file). When the trial ends without a licence nothing is deleted or hidden; only new invoices (Basics) or new till sales (POS) stop until a licence is entered in Riyeser Central. Quotes, payments, reports, past sales and close-till all keep working. Prices are on riyeser.com.

Build one: `python packaging/build_desktop.py --edition basics` (or `plus`, or `pos`). Run from source with no edition baked in, each company picks Basic or Plus under **Setup → Company** instead (set `RIYESER_APP_EDITION=basics|plus|pos` to try any of the apps). The names live in one place, `EDITIONS` in `riyeser/db.py`; the edition logic is in `riyeser/edition.py`.

## Riyeser Estimate (Measure & Quote)

A separate app from the same code base (`--edition estimate`, `RiyeserEstimate-Setup.exe`, orange "Es." logo): measure a job and turn it into a quote. It opens the same company file as Invoices, Bookings and Accounting, so its quotes are ordinary Riyeser quotes there (accept, then invoice or make a Bookings job).

* **Six steps, one screen each:** customer and job address, how to measure (map, plan or photo, type in sizes), measure, trade template, review price (profit and margin for you only; quick rate, waste and markup changes), send (PDF preview, email, print). Every step saves as you go; the Estimates list (Draft, Sent, Accepted, Declined, Expired; search, sort, Duplicate) is the home screen.
* **Measuring:** rooms (walls less doors and windows), areas, circles, triangles, lengths, counts, volumes and hours by hand (a Bluetooth laser in keyboard mode types into the boxes); PDF plans and photos with a scale from a known line or a drawing scale (pdf.js, multi-page, cut-outs, counts, undo/redo); the map (Leaflet on Esri World Imagery) with roof faces (pitch in degrees or rise/run, ridge/hip/valley/eave/rake edges, shared edges counted once) and fences (posts from spacing, gates). Map figures are labelled as estimates to check on site.
* **Units and money:** metric or imperial (m, m², m³ / ft, sq ft, cu yd, roofing squares) per company with a per-estimate switch; the company's currency, tax name (GST, VAT, sales tax) and date format.
* **Templates:** 15 trades shipped as editable starting points (waste %, coverage, pack sizes; no prices), your own templates, a supplier price list import (CSV), and "save these prices as a template" from a past job.
* **Only your own lines are kept:** map imagery is never stored or put in a PDF; the quote's measurements page draws your lines on a plain background (plans show your own plan with the lines).
* **Licence:** module `estimate`, free for 90 days from first use (`riyeser/licence.py` first-use trial; Riyeser online starts it when Central first reports the program), then read-only until it's on the plan. The price after the trial is still to be announced.
* Code: `riyeser/measure/` (geometry, units, engine, seeds, quote, drawing, demo, licence), `riyeser/views/estimate.py`, `riyeser/templates/estimate/`, `riyeser/static/measure/`; libraries in `riyeser/static/vendor/` (see its README for licences). Tests: `tests/test_estimate.py`; in a browser, `tests/browser/estimate.e2e.js` with `tests/browser/serve_estimate.py` (stand-in map tiles, never Esri).

## Features

**Accounts**
* Chart of accounts numbered by type (1- Assets … 9- Other Expenses), with opening balances.
* General journal checks that each entry balances.
* Search Transactions, plus a register and drill-down for every account.
* Reversing entries. Posted entries are never deleted, so the audit trail stays intact.
* Period lock date.
* Linked (control) accounts.

**Banking**
* Money Out / Money In with split allocations. GST can be inclusive or exclusive.
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
* Supplier contacts.

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
