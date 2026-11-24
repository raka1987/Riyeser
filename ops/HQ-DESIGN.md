# Riyeser HQ: design and roadmap

Riyeser HQ (riyeser.com/hq) is the staff workspace for looking after customers of Riyeser Accounting, Payroll,
Bookings, POS and Riyeser Link in Fiji, Australia and New Zealand. This is the owner's design guide turned into a plan.
The guide's mock-ups are kept privately, not in this public repository.

Status for each item:

- **Built now**: in HQ today (needs the latest `team-chat.sql` in Supabase).
- **Phase 2 billing**: waits for a payment provider (invoices, payments, payouts).
- **Later**: planned, not started.

## Navigation and access

| Item | Status |
|---|---|
| The same left-hand menu on every screen: Overview, Customers, Signups, Billing & Licences, Support, Team Inbox, Retention, System Operations, Reports, Admin | Built now |
| What each person sees comes from their HQ role and permissions (Support, Finance, Senior, Sales, Developer, Owner; per-person extras) | Built now |
| Every change and every customer page or ticket opened is in the HQ history, which nobody can change | Built now |
| A separate Finance section in the menu | Phase 2 billing |
| A Technical Operations role | Later |

## Operations overview (the work queue)

| Item | Status |
|---|---|
| Counts: new signups this week, renewals due in 7 days, open complaints | Built now |
| Failed payments count | Phase 2 billing (shows 0, "payments not connected yet") |
| One "Needs attention" queue: customer, issue, owner, next action (Reply, Approve, Review, Follow up, Extend, Message) | Built now |
| Supervisors' view of overdue and unassigned work | Built now (Queue at a glance) |
| Service incidents in the queue | Later |
| System health: last backup and last restore test (from the nightly GitHub jobs), email delivery | Built now |
| Riyeser Link Office health per business (phones, last check-in) | Built now, on the customer page's Link tab |
| Link Office health across all businesses on the overview | Later |
| Team handover: current shift, handover to, key notes, Add handover note | Built now |

## Customer account

| Item | Status |
|---|---|
| Search by business, contact, Company ID, ABN/TIN, phone or email | Built now |
| Search by invoice, licence key or Link extension | Later (invoices: phase 2 billing) |
| Header: country, status, assigned Riyeser owner, next renewal, next promised follow-up, contacts, open issues | Built now |
| Enabled modules, branches, people, linked PCs and the programs on them | Built now |
| Customer timeline with Add internal note and Send customer reply | Built now |
| Currency per customer | Phase 2 billing |
| Authorised contacts beyond the business's own people | Later |

## Billing and licences

| Item | Status |
|---|---|
| Licences per program: trial, paid until, cancelled, days left; one-click +7/+30/+90 days, Unlock, Mark paid until, Pause, Cancel | Built now |
| Manual extensions through free periods, with the self limit and supervisor approval, all logged | Built now |
| Refunds with two-person approval, credit on account | Built now |
| Invoices (open, overdue, paid) and payment states (pending, approved, settled, declined, refunded, disputed) | Phase 2 billing |
| Decline reasons, next retry, secure payment links, checking an uncertain transaction | Phase 2 billing |
| Renewals applied once even if the same payment update arrives twice | Phase 2 billing |
| Seats, devices and outlets with expiry, auto-renewal and grace dates; device transfers; masked licence keys | Later |
| Preview the service impact before changing access | Later |
| Country pricing, add-ons, discounts and legacy arrangements, with a preview of the next invoice | Phase 2 billing |

## Signups and onboarding

| Item | Status |
|---|---|
| Stages: signed up, email verified, trial, set up (a PC linked), activated (a program used), the step blocking go-live, owner | Built now |
| POS checklist: installed (known); outlet, products, test sale | Built now for "installed"; the rest "not reported yet" until POS reports it (later) |
| Link checklist: installed (known); extensions registered, test call | Built now for "installed"; the rest from Link Office reports (later) |
| Accounting checklist: first invoice | Later (needs the program to report it) |

## Support and complaints

| Item | Status |
|---|---|
| Tickets with status, priority, level (escalation), assignee, overdue timer, saved replies, internal notes | Built now |
| Staff-started tickets ("Message customer"), logged calls, follow-up dates and My follow-ups | Built now |
| Who needs to act (Riyeser or the customer): "Riyeser to act" / "Customer to act" on every ticket | Built now (`who_acts`) |
| The Support workspace: inbox, one conversation, Product diagnostics (three columns; stacked on narrow screens) | Built now |
| Affected product on each ticket, with a product filter | Built now |
| Next promised update (due time and owner), red when overdue, in Needs attention and the hourly sweep | Built now |
| Diagnostic reports (DG-4821) from Riyeser Central's and riyeser.com's Report an issue | Built now |
| Customer Reply / Still having an issue / Confirm fixed, and an optional 1–5 rating | Built now |
| Known issues board (one known issue, many tickets, one workaround) | Later (`known_issue_id` is ready) |
| Release tracking (the version with the fix, and whether the customer has updated) | Later (`fixed_in_version` is ready) |
| Live chat (Start chat, Leave a message, availability) | Later |

### The Support workspace (first release)

From the owner's support guide (its mock-up is kept privately). The guide's **First release** is built: the inbox,
customer replies, internal notes, diagnostic lookup and reminders for promised updates.

- **Support inbox** (left): quick tabs My tickets (n), Waiting (n), Unassigned, Overdue update, All, and "Known issues
  (soon)" switched off. Filters: product, owner, status, level, topic. Each row: product icon, title, business, ticket
  number, product, status pill (New, Investigating, In progress, Waiting on customer, Resolved) and Riyeser to act /
  Customer to act. A row is red when its next promised update is overdue.
- **Conversation** (middle): title, business (links to the customer page), ticket number, Product, Status, Owner. One
  thread: customer messages, replies, logged calls and yellow internal notes ("Internal note · only Riyeser staff see
  this"). Two composer tabs, **Reply to customer** and **Add internal note**, each with its own draft and an audience
  line ("The customer will see this and get an email" / "Only Riyeser staff"). Saved replies; Log a call.
- **Product diagnostics** (right): the report's product, version, error and reference; the Riyeser programs and versions
  on the business's PCs (`devices.programs`); Windows version and when it was reported; the log lines on request.
  **Next update** ("Next update to customer: by 3:00 pm Fri (Maya)"), **Planned release** (free text for now),
  **Linked bug** (reference and an optional https link), and **Customer support notes** (the business's pinned notes).
- Diagnostic reports hold technical details only. Riyeser Central collects the program and its version, Central's
  version, the installed Riyeser programs, the Windows version, the time, and the last 200 lines (64 KB) of the
  program's log when it has one Central can read (today: Riyeser Link Office and Desk Assistant). Emails, long numbers
  and anything after "password" are masked before the preview and again in the database. Never customer records.
  Customers read only their own reports; HQ needs the `support.diagnostics` permission (Support, Senior, Developer, Owner).

### Ready for the next releases

- `support_tickets.known_issue_id` (uuid, empty for now): the known issues board adds a `support_known_issues` table
  (title, product, affected versions, workaround, status, the developer bug) and points tickets at it, so one
  workaround and one update reach every affected customer.
- `support_tickets.fixed_in_version` (text, empty for now): release tracking fills it when the fix ships, and compares
  it with `devices.programs` to show whether the customer has updated before asking them to Confirm fixed.
- `planned_release`, `bug_ref` and `bug_url` stay as free text until Support and Development share the same ticket
  history; then they become links to the release and the bug.
- Live chat becomes another kind of message in the same ticket thread, so the history stays in one place.

## Retention and cancellations

| Item | Status |
|---|---|
| Inactive accounts: warnings, closing, owner-approved removal | Built now |
| Flags for stalled onboarding, repeated declines, unresolved complaints, falling use, cancellation requests, with outcomes | Later (declines: phase 2 billing) |
| Cancellation checklist (end date, final invoice, export, access, retention dates) | Later |

## Team inbox, lifecycle and integrations

| Item | Status |
|---|---|
| Team handover notes | Built now |
| Internal chat linked to a customer, case or invoice; handovers that become tasks with an owner and due time | Later |
| Owner lockouts, change of ownership (with reason and audit), two-step resets | Built now |
| Authorised data export requests with approvals | Later |
| Failed email deliveries with send again | Built now |
| Failed bank feeds, imports and payment updates | Later (payment updates: phase 2 billing) |

## Finance, system health and recovery

| Item | Status |
|---|---|
| Revenue estimate at list prices, new and lost paid programs, by program | Built now (labelled an estimate) |
| Reconciliation of invoices to card payments, transfers and payouts; unmatched funds, fees, chargebacks | Phase 2 billing |
| Last successful backup and last verified restore | Built now |
| Recording the recovery point and scope, restoring in a separate place first, owner approval for a live restore | Built now as a runbook (ops/RUNBOOK.md); in HQ later |

## Reports

| Item | Status |
|---|---|
| Sign-ups and funnel, trials and conversion, leaving, support, staff activity; every table to CSV; 30/90/365 days | Built now |
| Activation rate, upcoming renewals, overdue complaints, each opening the accounts behind it | Built now (Signups, Overview, Reports) |
| Recovered payments and cancellation reasons | Phase 2 billing / later |

## Imports and communications

| Item | Status |
|---|---|
| Emails sent to each business (subject, status) on its timeline | Built now |
| Update a billing contact and resend from the account | Later |
| Preview bulk messages before sending | Later |
| Import preview with duplicates, invalid rows and a downloadable error list | Later |
