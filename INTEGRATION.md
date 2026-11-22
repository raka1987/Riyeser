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
| PAYG / tax withheld payable | | tax_withheld + other_deductions |
| Super / contribution payable | | employer_contribution |
| Bank account the user picks on import | | net |

The accounts come from **Setup → Company → Linked accounts**: wages, super expense, PAYG payable and super payable.

## Accounting → Desk Assistant: PDFs

- Each document has a **Save to Riyeser folder** button.
- The **Save a PDF of every invoice and bill** setting (Setup → Company) writes files to `Accounting\<Invoices|Quotes|Bills|Purchase Orders>\<year>\`.
- File names follow `<date> <customer or supplier> <type> <number>.pdf`, the same "date, company, type, reference" style Desk Assistant uses.

## Hub → Accounting

- The hub opens `%LOCALAPPDATA%\Programs\Riyeser Accounting\Riyeser Accounting.exe`. Its Installed-apps DisplayName is `Riyeser Accounting <version>`.
- To run it embedded with no window: `Riyeser Accounting.exe --no-window --port <port>`, then show `http://127.0.0.1:<port>`.
- The company file is `%USERPROFILE%\.riyeser\company.db`.
