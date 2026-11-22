# Riyeser Group roadmap

Riyeser Group is the holding company. Every program is a module of the **Riyeser** hub.

| Phase | Module | Status |
|---|---|---|
| 1 | **Riyeser Accounting Basic**: invoices, quotes, customers, stock items, inventory reports | Done (choose Basic when creating a company) |
| 1 | **Riyeser Accounting Enterprise**: adds bank reconciliation, payroll, journals, jobs and budgets | Done |
| 2 | **Riyeser POS**: tap-to-sell register, cash or card, receipts, end-of-day totals, void a sale | Next. A first version is in the code but not yet in the menus |
| 3 | **Riyeser hub**: one desktop app with cards for Accounting, POS, Payroll, Desk Assistant, PDF and Services | In progress in the payroll and Desk Assistant chats |
| 3 | Links between modules: pay runs go from Payroll into Accounting, Desk Assistant files PDFs from Accounting and POS | Planned |
| Final | **Riyeser AI Assistant**: in-app help and first-line support | Planned (see below) |

## Final phase: Riyeser AI Assistant

**Goal:** fewer support calls. Users ask questions in plain English inside any Riyeser module and get an answer or have the task done for them. Only problems it can't solve go to a person.

**What it should do**
- **How do I…?** Explain any screen or feature from the Riyeser help guides. Examples: "How do I void an invoice?" and "Why is my bank reconciliation out?"
- **Look at my data.** With the user's permission, read their company file to answer questions such as "Who owes me money?", "What's low in stock?" or "Why doesn't my BAS match?"
- **Do it for me.** Prepare a draft invoice, stock adjustment or report, then ask the user to confirm before anything is posted.
- **Troubleshoot.** Check for common problems: an unbalanced period, a missing tax code, a locked period, or stock going negative.
- **Hand over to a person.** When it can't help, create a support ticket with a summary of the problem, the steps already tried, the version and diagnostics. Nobody has to explain it twice.

**How it would be built**
- One shared "Ask Riyeser" panel in the hub and in every module. It uses the Claude API through a small Riyeser Group service, so the API key is never stored on customers' computers.
- The help guides, these READMEs and the error messages form its knowledge base.
- Tools it can call: read-only reports and queries first. Any action that changes records always needs the user to confirm, and is written to the audit trail.
- Privacy: customer data is sent only when the user switches on "let the assistant see my data". Each company can turn this off.
- It needs the internet. Every module keeps working offline without it.

**Groundwork to lay now:** consistent error messages, a help page for each screen, and an exportable diagnostics bundle (version, edition, row counts, recent errors). All modules should follow these.
