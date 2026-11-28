# Riyeser online services: backups, restores and bad days

The online parts of Riyeser keep data in Supabase (PostgreSQL):
- **Riyeser Link** (chat, calls, companies; it was called Riyeser Team). This has its own Supabase project,
  still named for Riyeser Team; the tables, `team-chat.sql` and the `TEAM_DB_URL` secret keep their names.
- **As Built** (projects, drawings, inspections). This has its own Supabase project.

Everything else (Accounting, Payroll, POS, Bookings, Invoices) still keeps its data on each PC.

## What protects the data

| Layer | What it does |
|---|---|
| Row rules | Each business only ever sees its own data. Tested in `website/team/test/rules-test.sql`. |
| Two-step sign-in | Owners and admins need an authenticator code for admin powers. The database checks it (`is_admin`). |
| Change history | `audit_log` records who changed people, access, branches, PCs and company details. Nobody can edit it. |
| Nightly backups | `.github/workflows/backup.yml` makes an encrypted copy of each database every night and stores it in Cloudflare R2. It keeps 30 daily and 12 monthly copies. |
| Restore drill | `.github/workflows/restore-drill.yml` runs on the 2nd of each month. It restores last night's copy into an empty database and checks every row came back. |
| Supabase's own backups | Daily on the paid plan. Add "point in time recovery" once paying customers rely on it. |

## Setting up backups (once)

You need four things. Each is a value you paste into GitHub. **Never paste them into chat, email or a file in this repository.**

1. **Cloudflare R2 (where backups are stored)**
   - Sign in at dash.cloudflare.com and open **R2**. Create a bucket called `riyeser-backups`, with **location hint: Oceania**.
   - Go to **R2 → Manage API tokens → Create API token**. Choose **Object Read & Write**, limited to the `riyeser-backups` bucket. Note the **Access Key ID** and **Secret Access Key**.
   - Your **Account ID** is shown on the R2 overview page.
2. **Each database's connection string**
   - In Supabase, open the project, then **Connect** (top of the page), then **Session pooler**.
   - Copy the URI that starts `postgresql://postgres.` and put the database password in it.
   - Do this once for the Riyeser Link (Riyeser Team) project and once for the As Built project.
3. **A backup passphrase**
   - Make a long one: 5–6 random words.
   - **Write it down and keep it somewhere safe that isn't the computer**, such as a password manager and a paper copy in a safe.
   - Without it, the backups can't be opened by anyone, including you.
4. **Add the GitHub secrets**
   - On GitHub, open the repository, then **Settings → Secrets and variables → Actions → New repository secret**.
   - Add each of these:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | `riyeser-backups` |
| `R2_ACCESS_KEY_ID` | from the R2 API token |
| `R2_SECRET_ACCESS_KEY` | from the R2 API token |
| `TEAM_DB_URL` | Riyeser Link (Riyeser Team) connection string |
| `ASBUILT_DB_URL` | As Built connection string |
| `BACKUP_PASSPHRASE` | the passphrase |

5. **Check it works**
   - Go to **Actions → Nightly backups → Run workflow** and tick "Also save this as the month's copy". Wait for the green tick.
   - Then go to **Actions → Restore drill → Run workflow**. A green tick means the backup restores and every row is there.

If a secret is missing, the jobs just say "not set up yet" and don't fail.

## Riyeser HQ (riyeser.com/hq): the staff back office

HQ runs on the Riyeser Link (Riyeser Team) Supabase project. `team-chat.sql` already sets it up. HQ only ever sees account
information: companies, people counts, branches, linked PCs and versions, trials, Riyeser Link and downloads.
It never sees customers' messages, calls or books.

**Make yourself the first owner (once):**
1. Create your Riyeser account at riyeser.com/link, then turn on two-step sign-in there (🔐 Security).
2. In Supabase, open **SQL Editor** and run `select public.hq_make_owner('your@email', 'Your name');`
   This only works from the SQL Editor, never from a website.
3. Sign in at **riyeser.com/hq**. To add staff, open **HQ team**: each person needs a Riyeser account with two-step sign-in, and you choose their role.

| Role | Can do (defaults) |
|---|---|
| Owner | Everything, including HQ staff, settings, the HQ history and approving account removal |
| Finance | Companies, licences, refunds (approve and pay), free periods (give and approve), level 2 and 3 tickets, Reports |
| Support | Companies, notes, level 1 tickets, edit details, two-step resets, free periods (within the limit), entering refunds |
| Senior support | As Support, plus level 2 tickets, change owner, close and reopen businesses, Reports |
| Sales | Companies, notes, licences (view), tickets (view), free periods (within the limit) |
| Developer | Overview and downloads |

Each role is a set of **permissions**. On the HQ team tab an HQ owner can tick extra permissions on, or off, for one
person ("Permissions" beside them). The website hides what someone can't do, but the database is the real check.
Every HQ action is written to the HQ history, including opening a company or a ticket. Nobody can change or delete it,
not even the database owner. History has filters (who, what, business, dates) and **Download CSV**.

**Real download and install counts (HQ → Downloads):**
1. Run **Actions → Update the Riyeser Link database** (adds `download_events`, `install_events` and their functions).
2. Run **Actions → Deploy download counter** (the `download` Edge Function; optional secret `DOWNLOAD_SALT`, 32+ random
   characters, for the daily visitor hash).
3. Run **Actions → Publish website**: the Download buttons then go through riyeser.com/download/<program>.html, which
   counts the download and starts it. Until step 2 is done the page goes straight to GitHub, so nothing breaks.
4. Release Riyeser Central: it sends one anonymous "new install" note per PC, and a note per update (Settings →
   "Send anonymous usage counts" turns it off).
Real downloads leave out robots, tests (CI, `X-Riyeser-Test`) and HQ staff, and count one person once a day per program.
On a PC used for testing, open HQ → Downloads and tick **Don't count downloads from this browser**.

**PDF signing requests (Riyeser PDF → Ask someone to sign):**
1. Run **Actions → Update the Riyeser Link database** (adds the `sign_*` tables and functions and the private
   `sign-docs` Storage bucket with its rules: only the sender can upload or download; nobody at Riyeser HQ can).
2. Run **Actions → Deploy signing function** (the `sign` Edge Function). Before relying on the recorded internet
   addresses, check on staging which address it records when a request carries a made-up `X-Forwarded-For`
   (register SEC-017); set the repository variable `SIGN_TRUSTED_HOPS` if there's more than one proxy in front.
3. Run **Actions → Publish website** (riyeser.com/sign/, kept out of search engines).
4. Email: signing emails go through the same outbox as every other Riyeser email, so they're only sent once
   `RESEND_API_KEY` and `EMAIL_FROM` are set up (see Email sending). Until then requests can be made but nobody gets a link.
   The hourly HQ job sends them, so a link can take up to an hour to arrive.
5. Release Riyeser PDF with the Sign menu's "Ask someone to sign".
Free requests a business can send each month: the HQ setting `sign.free_per_month` (default 10).
Files are deleted when their keeping time is up (the sender chooses 30 days, 90 days, 1 year (default) or 2 years
after the request finishes); the history of each request is kept. Legal validity of electronic signatures differs
between countries and kinds of documents: the wording says "electronic signature with an audit trail" and makes no
claim about any particular law (owner's legal review before go-live).

**Daily GitHub totals (raw):** **Actions → HQ download counts** runs every day with the `TEAM_DB_URL` secret (nothing
else to set up) and saves GitHub's totals for the "Raw GitHub counts" section. Without `TEAM_DB_URL` it falls back to
the older token: `select public.hq_set_ingest_token('the token');` and the GitHub secret `HQ_INGEST_TOKEN`.
GitHub's totals include our CI runs, Central's update downloads and robots, so they're far higher than real downloads.

**Marking a company paid for Riyeser Link:** HQ → Customers → open the business → Programs → Riyeser Link → **Mark paid until…**.
Customers who pay online (PayPal or bank transfer) don't need this: see "Taking payments" below.

### Using HQ

The menu on the left is the same on every screen and only shows what your permissions allow. Every page has its own
address (for example `riyeser.com/hq/#/company/<id>/programs`), so you can paste a link to a colleague and Back works.
Needs the latest `team-chat.sql`; before that, the new parts say "Run the latest team-chat.sql…" and the rest still works.

- **Overview (start here):** New signups, Failed payments (PayPal payments in their grace period), Renewals due and Open
  complaints, then **Needs attention**: one queue of what's yours (complaints, approvals, refunds, your follow-ups due,
  trials and paid periods ending in 7 days, sign-ups stuck with no PC). Press the blue **Next action** (Reply, Approve,
  Review, Follow up, Extend, Message) or ▾ for more. On the right: **System health** (last backup and last restore test,
  from the nightly GitHub jobs) and **Team handover**: add a note for the next shift; tick it Done when it's handled.
- **Customers:** search, filter (plan, trial ending, country, status, inactive, open tickets, needs follow-up,
  My customers), sort any column, 50 a page. Quick views: Trials ending this week, Paying customers, Needs follow-up,
  My customers. **Download CSV** gives the whole filtered list (the download is in the HQ history).
- **The customer page:** click any business (in Customers, Support, Refunds, Licences, Inactive, Reports…). The header
  shows the Riyeser **Owner** (who looks after them: set it from the ⋯ menu), Next renewal, the next promised follow-up,
  the business owner's phone and email, and warning chips (trial ending, payment overdue, no sign-in, open tickets,
  Link Office offline). Tabs: Overview, Programs, PCs & programs (which Riyeser programs are on each PC, from Central
  1.8.1), People, Conversations, Money, History, Link. The **Customer timeline** on the right shows the latest of everything.
- **Quick extensions (Programs tab):** each program has **+7 / +30 / +90 days**, **Unlock now**, **Mark paid until…**,
  **Pause** (stops now) and **Cancel** (works until the end of what's paid). Each asks for a reason and an optional ticket
  number. Free days go through free periods: up to 31 days applies straight away, longer goes to **Approvals** for someone
  else to approve. Paid-until, Pause and Cancel need "Change licences and plans" (Owner, Finance). All are in the HQ history.
- **Message customer / Send customer reply:** starts a help request from Riyeser to someone in the business (the owner
  unless you choose). They see it on their Riyeser home page as "Message from Riyeser", get it by email, and can reply;
  their reply lands in Support. **Add internal note** is staff only: customers never see it.
- **Log a call:** they called us or we called them, who, what it was about, and an optional **follow-up date**.
  Follow-ups show in **My follow-ups** (Overview and the customer page) and in the Needs attention queue on the day.
  Tick **Done** when you've followed up.
- **Signups:** each new business from signed up → email verified → trial → set up (a PC linked) → activated (a program
  used), the step blocking go-live and its owner. Product checklists say "not reported yet" for anything the programs
  don't tell Riyeser yet.
- **Reports** (Owner, Finance, Senior): sign-ups and the funnel, trials and conversion, a **revenue estimate** (list
  prices until payments are connected), who's leaving, support and staff activity, for 30, 90 or 365 days. Every table
  has **CSV**. Numbers are account information only: never customers' messages or books.

## Riyeser Team is now Riyeser Link: Supabase addresses (once)

The chat app's main address is now **riyeser.com/link/**; riyeser.com/team/ still works (it serves the same app).
In Supabase → the Riyeser Link (Riyeser Team) project → **Authentication → URL Configuration**:

1. **Site URL**: `https://riyeser.com/link/`
2. **Redirect URLs**: add `https://riyeser.com/link/` (keep `https://riyeser.com/team/` and `https://riyeser.com/hq/`).

Until then, confirmation emails for sign-ups started on /link/ go to the Site URL instead, which still works.
Re-running `team-chat.sql` (below) also updates the email wording and HQ's labels to riyeser.com/link and Riyeser Link.

## After this release: re-run team-chat.sql in Supabase SQL Editor

Riyeser HQ (support and the Support workspace with diagnostic reports, fix-up tools, permissions, inactive accounts,
emails, refunds, free periods) needs the latest database rules. Until you do this, the website keeps working: the new customer parts stay hidden, and HQ shows
"Run the latest team-chat.sql to switch this on".

1. Open Supabase → the Riyeser Link (Riyeser Team) project → **SQL Editor** → **New query**.
2. Paste all of `website/team/team-chat.sql` (from the `module/desk-assistant` branch) and press **Run**.
   It is safe to run again: it only adds what's missing and never deletes data.
3. Check it says "Success". Then open riyeser.com/hq: the Support, Refunds, Approvals, Inactive accounts and Emails tabs now work.
   Until then, Support shows the older inbox (no product, promised updates or diagnostics), and Report an issue says it's still being switched on.
4. Run **Actions → HQ jobs → Run workflow** once. It should finish green (emails stay queued until email is set up).

## Support in HQ

Customers ask for help from their Riyeser home page (riyeser.com/link, under **Help**; the old riyeser.com/team
address still works):
- **Get help**: a topic, subject and message. They get a number like **T-10234**.
- **Report an issue**: which program, what happened, whether their work is blocked (Yes / No), optionally the version,
  the error and a diagnostic reference from Riyeser Central (DG-4821). "Yes, blocked" makes the ticket high priority.
- In **Riyeser Central** (1.8.3 and later): **Get help → Report an issue** does the same and adds the diagnostic details.
  They see exactly what will be sent before sending, and need to be signed in with their Riyeser account. They get
  "Thanks — your request number is T-10234. Reference DG-4821." and a link to it on riyeser.com.

What a diagnostic report holds (and nothing else): the program and its version, Riyeser Central's version, the Riyeser
programs installed on that PC with versions, the Windows version, when it was made, the error they typed, and the last
200 lines (64 KB at most) of that program's log if Central can find one (Riyeser Link Office:
`%APPDATA%\Riyeser Link Office\logs\link.log`; Desk Assistant: its `smart-review.log`; other programs have none yet).
Emails are masked (`x***@domain`), long numbers (bank, tax, card) are removed, and anything after "password" on a line
is removed, in Central and again in the database. No invoices, payroll, customers, files, folder paths or messages.

Each request on their home page shows its status in plain words, "We'll update you by …" when we've promised an
update, and three buttons: **Reply**, **Still having an issue** (back to its owner's queue, Riyeser to act) and
**Confirm fixed** (resolved). After Confirm fixed they can rate it 1–5 ("How did we do?") with an optional comment.
Our emails link straight to the request: riyeser.com/link/?help#T-10234.

In HQ → **Support** (three columns on a wide screen, one under the other on a phone):
- **Support inbox**: My tickets, Waiting (on the customer), Unassigned, Overdue update (no first reply in 24 hours, or a
  promised update missed), All. Filters: product, owner, status, level, topic. Each ticket says **Riyeser to act** or
  **Customer to act**; a missed promised update makes its row red. Search also finds DG- references.
- **The conversation**: set **Product**, **Status** (New, Investigating, In progress, Waiting on customer, Resolved)
  and **Owner** at the top. **Reply to customer** emails them; **Add internal note** is for staff only (yellow). Each
  keeps its own draft, and the line above the box says who will see it. **Log a call** puts a phone call in the thread
  (staff only). Saved replies, escalation and refund requests are where they were.
- **Product diagnostics**: the report's product, version, error and reference (looking at it needs the
  `support.diagnostics` permission: Support, Senior, Developer and Owner have it), the versions on the business's PCs,
  and the log lines. **🔎 DG-…** looks up any reference.
- **Next update**: when the customer will hear from us next, and who sends it. Always set one when you reply to an
  open problem. If it's missed, the row turns red, it shows in **Needs attention** on the Operations overview, and the
  hourly HQ job adds an internal reminder to the ticket and emails the owner (staff only: the customer isn't emailed).
- **Planned release** (free text, e.g. "Payroll 2.8.2") and **Linked bug** (a reference and an optional https link).
- **Customer support notes**: the business's pinned notes, on every one of its tickets. Add or edit them here.
- Opening a ticket, a diagnostic report or a company is written to the HQ history.

HQ never sees customers' chat messages or books. Support tickets and diagnostic reports are written to Riyeser, so
staff reading them is fine.

## Escalations

Each ticket has a level: **1 Support**, **2 Senior / technical**, **3 Management** (owner and finance).
- Only staff who can work a level can reply to tickets at that level: level 1 needs "Reply to tickets", level 2 needs
  "Work level 2" (the Senior support role has it), level 3 needs "Work level 3" (Owner and Finance).
- **Escalate / send back** needs a reason, and you can choose who takes it at the new level. The reason is an internal
  note ("Escalated to Senior by Sam: …") and goes in the HQ history. The customer only sees
  "We've passed this to our senior team. They'll reply here."
- **Automatic:** the hourly HQ job flags tickets with no first reply in 24 hours as **Overdue**, and moves tickets
  waiting on us for 48 hours up one level with the reason "No reply in 48 hours".
- The HQ owner can change both times in HQ → **HQ team** → **HQ settings**.

## Fixing things for a customer

The tools are in HQ → Companies → open the company → **Fix-up tools**, plus **Reset two-step** beside each person.
Each one needs its own permission and a **reason**. You can also add the **ticket number**. Each is written to the HQ
history, which can't be changed or deleted. Write reasons without personal details, because they are kept forever.
- **Edit details:** name, tax number, address, phone, email, country. The customer's own change history shows "Riyeser".
- **Reset two-step sign-in** (they lost their phone): **first check who they are.** Never reset it just because
  someone asks by email or chat. Call them back on the phone number already on file, or check another way you trust.
  Then type how you checked (for example "called back on the number on file"). Their authenticator is removed and
  they're emailed. At their next sign-in they use only their password, then set two-step up again under Security.
- **Change owner:** makes another person in the business the owner. The old owner becomes an admin.
- **Close or suspend / Reopen:** nothing is deleted. A closed business is hidden from its people. At sign-in they see
  "This business is closed. Contact Riyeser support." Its programs' online licence reads as not active (Central shows
  "business closed — contact Riyeser support"). The books on their PCs are never touched. The owner is emailed.
- **Close as duplicate:** for a business that signed up twice. Choose the business to keep. The panel links to it.
- **Give a free period:** see "Free periods and approvals".

### A customer forgot a password in a desktop program (Accounting, Invoices, Bookings, POS, Payroll)

We can't reset these passwords: they live in the company file on the customer's PC. **Forgot password?** on the
sign-in screen (desktop app only, on that PC) offers two ways, and both need proof:
- **Email me a code:** only when the program can send email (Setup → Company details → Email) and the person has an
  email address saved under Users & Roles. A 6-digit code, good once for 15 minutes, at most 3 an hour; 5 wrong tries
  cancel it. The screen says the same thing whether or not the username or email exists.
- **I'm the business owner:** the owner signs in with their Riyeser account (email, password and two-step code if they
  have one). It only works on a PC linked to their business (signed in to Riyeser Central on it) and only for the
  person who is the **owner** of that business. Then they choose the user and set a new password.

There is no reset without proof, and no command-line reset (`riyeser reset-password` was removed). If neither way
works: an administrator can set a new password under Setup → Users & Roles; if the owner lost their Riyeser
password, they use "Forgot password?" on riyeser.com (an emailed link); if they lost their two-step phone, see
"Reset two-step sign-in" above, and check who they are first. If the PC isn't linked, change the owner or link the PC
through Central — never by editing the company file for them. Every reset is in the program's audit log
("password_reset", with who and how).

## Prices (US dollars)

All Riyeser prices are in US dollars, per business per month (pricing v2). Free forever: Central, Desk Assistant,
Invoices, PDF. Each paid program is free for 90 days, then includes 3 users; each extra user is US$7 a month for that
program. Accounting Basics US$25, Accounting Plus US$39 (it includes Basics, so a business pays for one or the other),
Bookings US$25 (3 staff calendars), Riyeser Link US$20 (chat, calls, desk phones, Riyeser Link Office and 20 GB of chat
files; users = everyone who chats or takes calls), Payroll US$25 (3 office users who run pay or approve timesheets;
unlimited employees), POS US$29 (1 till and unlimited cashiers; US$15 a month per extra till), As Built US$29. One login
for the business's accountant or bookkeeper is free (job role Bookkeeper; it doesn't count as a Link user).
Bundles (each program still includes 3 users; extra users US$7, tills US$15): Shop = Accounting Basics + POS + Riyeser
Link US$59 (US$74 separately); Office = Accounting Basics + Payroll + Riyeser Link US$59 (US$70); Business = Accounting
Plus + Bookings + Riyeser Link + Payroll + POS US$99 (US$138). Billing applies the bundle that saves most by itself when
the programs chosen contain one. Extra companies in Accounting US$10 each. Yearly = 10 months (2 months free). Early bird
= half the program, bundle, user and till amounts for 12 months (first 100 businesses).
Riyeser Link chat files: 20 GB per business, plus any extra granted in HQ (customer page → Programs → File storage →
**Grant extra storage**, with a reason; needs "Manage licences"). While Riyeser Link is off (trial over, not paid),
chat is read-only: messages can be read, nothing new is sent or uploaded, and nothing is deleted.

**Pricing v2 change-over (once):** businesses that used Riyeser Link chat free before got 90 days of Riyeser Link from
the first time the pricing v2 `team-chat.sql` was run (marked in `riyeser_once`, so re-running doesn't reset it).
The paypal function on main passes users per program and tills to the database: redeploy it (deploy-paypal-function)
after running the new `team-chat.sql`; until then PayPal orders count the same users for every program and 1 till.

To change a price, change it in all of these, then re-run `website/team/team-chat.sql` and publish the website:
`riyeser_price()` in `website/team/team-chat.sql` (HQ's estimates and what customers are charged), `website/prices.mjs`
(the website, with BUNDLES), `PRICE`/`BUNDLES` in `website/hq/hq.js` (the HQ demo), `PRICE`/`BUNDLES` in
`website/team/team.js` (Add to my plan), `desktop/src/core/prices.js` (Central), `PRICE_USD` in `riyeser/db.py`
(Accounting's screens). Bundle prices are `bundle_shop`, `bundle_office` and `bundle_business` in `riyeser_price()`.
`website/team/test/pay-test.js` fails if the first four don't agree. A price change applies to new payments; PayPal
subscriptions already running keep the price they started with (cancel and pay again to move one to the new price).

## Taking payments (PayPal and bank transfer)

Customers pay on their Riyeser home page (riyeser.com/link). On riyeser.com every paid program has **Start free for 90
days** and **Buy now**, and the price calculator has **Buy this plan**. They create an account (or sign in), and
**Add to my plan / Pay** opens with that program. Only the business's **owner** can pay or see billing; admins and staff can't.
This needs the latest `website/team/team-chat.sql` (see "After this release"). Until it's re-run, Billing stays hidden and
Add to my plan says paying online is still being switched on.

- They choose the programs, how many people (3 included, then US$7 a month each for each program) and monthly or yearly
  (10 months for 12). The total comes from the price list (see "Prices"); the early bird applies by itself to the first
  100 businesses to pay. All amounts are in US dollars.
- **Their free days aren't lost:** paid time starts when each program's 90-day trial ends (or the day they pay, if it ended).
- **Pay with PayPal** (a card or their PayPal balance): PayPal takes the money every month or year until they cancel.
  They come back to "Thanks, we're confirming your payment", and the programs switch on when PayPal tells Riyeser it's paid
  (usually within a minute). Riyeser Central picks it up by itself.
- **Pay by bank transfer:** they get an invoice (like **RI-10003**) with the amount, a due date 14 days away, the reference to
  quote and your bank details. **The programs aren't switched on until you mark it paid** (their free trial carries on meanwhile).
- **Billing** on their home page shows their subscription and next charge, invoices, payment history, a printable invoice
  and receipt for each, **Manage in PayPal**, and **Cancel subscription** (two-step sign-in needed). Cancelling stops future
  charges; everything keeps working until the end of what they've paid, then stops. Nothing is deleted.
- **A failed PayPal payment:** PayPal tries again by itself. The programs keep working for a grace period (7 days;
  HQ team → HQ settings), and the owner sees and is emailed the exact date. It shows in HQ → Overview (Failed payments)
  and the Needs attention queue. After 3 failed tries PayPal stops the subscription ("Payments stopped").

### In HQ: Billing & Licences → Invoices & payments
- **PayPal card:** Sandbox (test money) or Live, the last webhook PayPal sent, and whether webhooks are verified.
- **Failed payments** and **Unpaid invoices** (also in Needs attention on the Overview).
- **Mark bank transfer paid** (Owner and Finance): only when the money is in your bank account. Type the amount and your
  bank's reference from the statement. The programs switch on straight away, the owner is emailed a receipt, and it's in the HQ history.
- **Payments:** every payment, with PayPal ids shown only by their last 6 characters. The same is on each customer's page, Money tab.
- **Billing entity:** who sells Riyeser, printed on every invoice and receipt: business name, address, **ABN** (or another
  tax number: change the label), contact email and the bank details customers pay into. **Until you add the bank details,
  HQ shows "Add your bank details"** and bank transfer invoices tell customers you'll email them the details.
  Each change is kept as a new version: invoices and receipts already made keep the details they were made with.

**Tax:** Riyeser doesn't add GST or any other tax to these prices. Whether you must charge GST to Australian customers
(and what to show on invoices if you do) is a question for your accountant.

### Set up PayPal (once)

You need a PayPal **Business** account (yours is an Australian one). Charges are in US dollars.

1. **Check the PayPal account**
   - Sign in at paypal.com. Under **Settings → Money, banks and cards**, check your Australian bank account is **linked and confirmed**.
   - Your PayPal account will hold a **US dollar balance** from Riyeser payments. When you withdraw to your Australian bank,
     PayPal converts US$ to A$ and charges a currency conversion fee. You can keep the money as US dollars in PayPal
     instead, and you can see the fee under **Settings → Money, banks and cards → Currency conversion** (or in PayPal's fees page).
2. **Make a PayPal app (Sandbox first)**
   - Go to **developer.paypal.com** and sign in with the same PayPal account. Open **Apps & Credentials**.
   - At the top, choose **Sandbox**. Press **Create App**, call it `Riyeser`, type **Merchant**, and create it.
   - You'll see a **Client ID** and a **Secret**. Don't paste them into chat, email or a file.
3. **Put them in GitHub** (repository → **Settings → Secrets and variables → Actions → New repository secret**):

   | Secret | Value |
   |---|---|
   | `PAYPAL_CLIENT_ID` | the app's Client ID |
   | `PAYPAL_CLIENT_SECRET` | the app's Secret |
   | `PAYPAL_ENV` | `sandbox` (later `live`) |
   | `SUPABASE_ACCESS_TOKEN` | already there if licence signing is set up |

4. **Deploy:** GitHub → **Actions → Deploy PayPal payments → Run workflow**. Wait for the green tick. Its summary says
   "PayPal keys are in (sandbox), but webhooks aren't verified yet" and shows the webhook address:
   `https://goaugynxeatzqzifpoes.supabase.co/functions/v1/paypal/webhook`
5. **Add the webhook:** back in developer.paypal.com → your Sandbox app → **Webhooks → Add Webhook**.
   - Webhook URL: the address above.
   - Tick these events: **Billing subscription activated**, **Billing subscription cancelled**, **Billing subscription
     suspended**, **Billing subscription expired**, **Billing subscription payment failed**, and **Payment sale completed**
     (`BILLING.SUBSCRIPTION.ACTIVATED`, `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`, `.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`).
   - Save. Copy the **Webhook ID** it shows and add it as the GitHub secret **`PAYPAL_WEBHOOK_ID`**.
   - Run **Deploy PayPal payments** again. Its summary now says "PayPal is on (sandbox)".
   Until `PAYPAL_WEBHOOK_ID` is there, Riyeser refuses PayPal's webhooks, HQ's PayPal card says "Webhooks not verified yet",
   and customers only see bank transfer (a PayPal payment couldn't be confirmed without webhooks).
6. **Test with pretend money:** developer.paypal.com → **Testing tools → Sandbox accounts** has a test **Personal** account
   (a pretend buyer; its email and password are under ⋯ → View/edit account).
   - Make a test business at riyeser.com/link (your own spare email), press **Add to my plan / Pay**, choose a program and
     **Pay with PayPal**. Sign in at PayPal with the **sandbox buyer** account and agree.
   - Back on riyeser.com it says "Thanks, we're confirming your payment", then "Payment confirmed". Check **Billing** shows the
     receipt, HQ → Invoices & payments shows the payment and "Last webhook: just now".
   - Try **Cancel subscription**: it should say everything works until the paid date.
7. **Go live:** in developer.paypal.com switch the top toggle to **Live**, create the app again (Live), and add the same
   webhook with the same events to the **Live** app. Update the GitHub secrets `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_WEBHOOK_ID` with the **Live** values and set `PAYPAL_ENV` to `live`. Run **Deploy PayPal payments**.
   HQ's PayPal card then says **Live**. Make one small real payment yourself and refund it in PayPal to be sure.
8. **After going live: clear your practice payments.** Practice (sandbox) payments never stop a real one, and the website
   never links to PayPal's practice site once PayPal is live. But programs paid only with practice money still show
   "Practice payment (test)". To put them back on their free trial: HQ → **Overview** shows **Practice payments to clear**
   (Owner only) → **Invoices & payments** → **Practice payments to clear** → click the business → **Money** tab →
   **Clear practice payments for this business** → **Clear practice payments**. Live PayPal and bank transfer payments are
   never touched. It's in the HQ history, and **Put practice payments back** on the same tab undoes it (until a real payment
   comes in).
9. **A real test (small):** on riyeser.com/link, your Riyeser home → **Your plan** → **Buy now** on one program (or
   **Add to my plan / Pay**, tick one program, choose **Buy now: start my paid plan today**) → **Pay with PayPal** → approve
   with your real PayPal account. Back on riyeser.com: "Thanks, we're confirming your payment", then **Billing** shows the
   subscription (Active) and the payment with its receipt; HQ → Invoices & payments shows it and "Last webhook: just now".
   Then **Billing → Cancel subscription** (two-step sign-in needed): PayPal won't charge again and the program works until
   the paid date. Refund the payment in PayPal (Activity → the payment → Refund) if you want the money back; Riyeser's
   records keep the payment and the paid time. (Choosing **Start paying when my free trial ends** instead charges nothing
   today: it tests the approval and cancelling without moving money.)

The workflow passes the secrets straight to Supabase without printing them. A secret missing from GitHub is left as it is in Supabase.

### Changing to a different PayPal account later
Put the new account's Client ID, Secret and Webhook ID (made as in steps 2–5, on the new account) in the same GitHub
secrets and run **Deploy PayPal payments**. New customers then pay into the new account. **Subscriptions already running
stay on the old account** (PayPal keeps charging them there), so keep the old account open, with its app and webhook,
until each of them has been cancelled; the customer can cancel and pay again to move. Update the **Billing entity** in HQ
if the business name, ABN or bank details change: old invoices and receipts keep their old details.

## Refunds

Owners and admins (with two-step sign-in) can ask for a refund from their Riyeser home page: what it's for, the
period, the amount and the currency it was paid in (USD by default; FJD, AUD or NZD if that's what was paid), and why. This also opens a billing help request for the
conversation. Support staff can enter one for a customer from their ticket.

In HQ → **Refunds**, with filters for New, Reviewing, Waiting for second approval, Approved – to pay, Paid and Declined:
1. **Approve**, **Partly approve** or **Decline**. Each needs a reason, and the customer sees it in their email.
2. **The two-person rule:** above the threshold (default **200**, in any currency), a second staff member with
   "Approve refunds" must also approve. The same person can't give both approvals. The database enforces this, not
   just the website. The HQ owner can change the threshold in HQ team → HQ settings.
3. **Mark as paid** with how it was paid (card refund, bank transfer, M-PAiSA or credit on account) and the reference.
   For a PayPal payment, refund it in PayPal (paypal.com → Activity → the payment → **Issue a refund**), then record it here.
   For a bank transfer, pay it back from the bank, then record it here. Credit on account shows on the company panel as "Credit: USD …".

Finance and owners can approve and pay. Support can see refunds and enter them for customers. The customer is emailed
when it's received, decided and paid. Refund requests are never deleted.

## Free periods and approvals

From a company panel, staff with "Give free periods" can give: a **longer free trial** for a program, **free time on
a paid program**, or the **whole account** (all paid programs). Choose days or months, a reason (retention, goodwill
after a problem, sales promotion, other), a note and optionally the ticket number.
- Up to **31 days** (the setting `offers.self_limit_days`) applies straight away.
- Anything longer **waits for a supervisor**: anyone with "Approve free periods" (Finance and owners). It doesn't
  change the licence until approved. The person who asked can't approve or decline it. Supervisors can decline with a reason.
- When it applies, the customer's plan shows the new date and they're emailed: "Good news: we've added 14 free days
  to POS — now free until …". They never see the reason.
- HQ → **Approvals** lists everything waiting for a second person: refunds over the threshold and free periods over
  the limit. It also shows how many free periods were given this month and the free days by reason.
- Every free period has a number like **O-1001**, shows on the company panel, is never deleted, and is in the HQ history.

## Inactive accounts

The owner's rule: **free** accounts close after **12 months** unused. **Paid** businesses (any paid program active)
are never closed for this. The books on customers' PCs are never touched.
- "Used" means anyone in the business signed in, opened riyeser.com/link (or the old riyeser.com/team), or Riyeser Central checked in.
- The daily HQ job emails the owner **30 days** and **7 days** before closing. An account that's already overdue gets
  the 7-day warning first, so nobody is closed without notice. Signing in before then resets the clock.
- At 12 months it's closed with the reason "inactive". HQ → **Inactive accounts** lists accounts closing soon and those already closed.
- **Two years after closing**, the account is marked **ready for removal**. Removal is **never automatic**: an HQ owner
  (with "Approve removing inactive accounts") ticks the accounts, gives a reason and approves. Removal blanks personal
  details and keeps the rows. Messages become "[removed]", names become "Removed person", business details are
  cleared and help requests are blanked. An anonymous record (how many, when, why, by whom) stays in the HQ history.
- **Login accounts are not deleted** by this. Deleting them is a later, separate step with the Supabase service key
  (Authentication → Users, or the admin API). Do it only after the removal above, and keep a note of when and how many.

## Email sending (not set up yet)

HQ queues emails to customers in the database (`email_outbox`). They're branded Riyeser and come from "Riyeser Support".
Emails go out when a help request is received or answered, after a two-step reset, for inactivity warnings, when a
business is closed or reopened, for refund steps, and when a free period is added.
**Nothing is sent until you set it up.** Until then the hourly HQ job says "email sending isn't set up yet" and leaves
them queued. Nothing is lost. HQ → **Emails** shows the counts, recent emails, and held or failed ones with **Send again**.

What the owner must decide and do:
1. **Choose a provider.** Resend (resend.com) is suggested and the job already works with it.
2. **Choose the sending address** on riyeser.com, for example `support@riyeser.com`.
3. **DNS:** the provider gives you a few DNS records (SPF, DKIM and usually DMARC) for riyeser.com. **The owner or their
   IT person must add these at riyeser.com's DNS host.** Riyeser's automation never changes DNS.
4. Add two GitHub secrets (Settings → Secrets and variables → Actions): `RESEND_API_KEY` (from the provider) and
   `EMAIL_FROM` (the address from step 2).
5. Run **Actions → HQ jobs** once and check HQ → Emails shows them as sent.

The job never prints email addresses or message text in its logs. After 3 failed tries an email shows as failed in HQ.

## HQ jobs (`.github/workflows/hq-jobs.yml`)

Every hour it runs the support sweep. Once a day it also runs the inactive-accounts sweep and the website traffic sweep
(adds yesterday's daily totals for HQ → Reports → Website traffic, deletes page views older than 13 months). Then it sends queued
emails if email is set up. It uses the `TEAM_DB_URL` secret, the same one as the backups. If the database hasn't had
the latest `team-chat.sql` yet, it says so and stops without failing. When it fails, open the red step. A connection
error usually means `TEAM_DB_URL` changed. Run it again by hand with **Run workflow**.

## HQ sees backups and restore tests without GitHub

Each backup, restore drill and HQ jobs run ends with **Record the result in HQ**: `ops/hq-jobs/record-run.sh` writes one row
(job, database, passed or failed, when, sizes, row counts and the backup's fingerprint; never data or secrets) through
`public.ops_record_run` with the same `TEAM_DB_URL` secret. HQ → Integrations reads it (`hq_ops_runs`), so it keeps working
once the code repository is private. Before the database has the latest `team-chat.sql`, the step just says "not recorded"
and never fails the job.

## When a backup fails

GitHub emails the repository owner when a scheduled job fails. Open the failed run, then the step with the red cross.

| Message | What to do |
|---|---|
| `looks empty` | The database answered but had no data. Check the connection string points at the right project. |
| A password or `connection` error | The database password changed. Update `TEAM_DB_URL` or `ASBUILT_DB_URL`. |
| An `aws` or `AccessDenied` error | The R2 token expired or was removed. Make a new one and update both R2 key secrets. |

One failed night is not an emergency: the previous 30 copies are still there. Two in a row is: fix it that day.

## When a restore drill fails

| Message | What it means | What to do |
|---|---|---|
| `fingerprint mismatch` | The stored file changed after it was made. | Treat as a security incident (see below), and check R2 access. |
| `Couldn't decrypt` | The `BACKUP_PASSPHRASE` secret doesn't match the one used for that night. | Fix the secret. The copy itself is fine. |
| `backup had N rows, restore has M` or a check failed | The copy is incomplete. | Run the backup by hand and drill it again. If it keeps failing, contact Supabase support. |

## Restoring for real

**One business made a mistake** (deleted messages, removed people):
- First check the change history. Most changes can simply be undone in the app: add the person back, re-approve them.
- If data is really gone, restore last night's copy into a **throwaway** database. Use the same steps as the drill: `ops/backup/restore-drill.sh` with `RESTORE_DB_URL` pointing at it. Then copy just that company's rows back with SQL.
- Never restore over the live database to fix one company.

**The whole database is lost or damaged:**
1. Create a new Supabase project in the same region.
2. In its SQL Editor, run `website/team/team-chat.sql` (for Riyeser Link).
3. Restore the data. Decrypt the newest good copy (as in `restore-drill.sh`), then run `pg_restore --no-owner --no-privileges --data-only -n auth -n public -d "<new connection string>" db.dump`.
4. Put the new project's URL and key into `website/team/config.js` and publish the website (it is published to both
   riyeser.com/link/config.js and riyeser.com/team/config.js). In the new project's Authentication → URL Configuration,
   set Site URL `https://riyeser.com/link/` and Redirect URLs `https://riyeser.com/link/`, `https://riyeser.com/team/`, `https://riyeser.com/hq/`.
5. Point `TEAM_DB_URL` at the new project, then run the backup and the drill.

Practise steps 1–4 with a copy at least once before you need them.

## A security incident (someone got in, or might have)

1. **Contain** (within the hour):
   - Rotate the Supabase **database password** and **API keys** (Project Settings → API). Rotating the JWT secret signs everyone out.
   - Rotate the R2 token.
   - Remove any unknown admin in the affected company.
2. **Look:**
   - Read the company's **🕘 History** and Supabase's logs (Logs → Auth, API).
   - Write down what was accessed, when, and how.
3. **Restore** anything that was changed, using the steps above.
4. **Tell people:**
   - Australia's Privacy Act (notifiable data breaches) applies to businesses with an annual turnover over $3 million, and to some smaller ones. Other countries' laws may also apply.
   - If personal information may have been seen and could cause serious harm, the affected businesses and the regulator must be told quickly.
   - Get advice; don't wait to be sure.
5. **Fix the cause:** add a rule test that would have caught it.

## Not covered yet
- **As Built photos and files** in Supabase Storage. The database copy includes their records but not the files themselves. Add a storage copy (Supabase Storage → R2) before customers depend on As Built online.
- **The books on each PC:** Accounting, Payroll and the rest. Each program keeps its own backups on the PC. These move online with the shared company database.

## Running the Riyeser relay

The relay (`relay/`, details in `relay/README.md`) joins customers' Riyeser Link Office sites and phones at home, and
is the STUN/TURN for Riyeser Link calls. Main relay: the head office PC (Windows task **Riyeser Relay**). Backup: a
rented Sydney server (systemd service `riyeser-relay`). Sites fail over to the backup by themselves within seconds and
come back when the main one answers again; calls inside each office never depend on either.

**Is it up?** `curl -k https://relay.riyeser.com/health` (and `relay2…`). In Supabase: `select id, region, last_seen, public_ip, counts from relay_servers;`
— `last_seen` older than 2 minutes means that relay isn't checking in.

**It's down.**
1. Linux: `sudo systemctl status riyeser-relay`, `journalctl -u riyeser-relay -n 100`, `sudo systemctl restart riyeser-relay`.
   Windows: Task Scheduler → *Riyeser Relay* → Run; log in `C:\ProgramData\Riyeser Relay\logs\relay.log`.
2. Head office internet down: sites are already on the backup (Phones page shows "Using backup relay"). Nothing to do.
3. Head office public address changed and the DNS record is stale: the relay updates it itself through Namecheap
   Dynamic DNS (below) at start, on every change and every 30 minutes. Look for `DNS:` lines in its log, or `dns` in
   `/health`. Otherwise update the A record by hand at Namecheap. Link Office also tries the address the relay last reported.
4. A bad update: `update.sh` already rolled back if the new version didn't start; the failed copy is in
   `/opt/riyeser-relay/app.bad`. To go back by hand: `sudo mv /opt/riyeser-relay/app /opt/riyeser-relay/app.bad && sudo mv /opt/riyeser-relay/app.old /opt/riyeser-relay/app && sudo systemctl restart riyeser-relay`.

**Dynamic DNS at Namecheap (owner, once; `riyeser.com` is at Namecheap).** So `relay.riyeser.com` follows the head
office's public address by itself:
1. Namecheap → **Domain List** → **Manage** next to `riyeser.com` → **Advanced DNS**.
2. **Dynamic DNS** → switch it on → copy the **Dynamic DNS Password** (not the Namecheap account password).
3. **Host Records** → **Add new record** → **A + Dynamic DNS Record**, host `relay`, value `127.0.0.1` for now (the
   relay replaces it), TTL Automatic → ✓. Remove any plain A record for `relay`. Same for `relay2` if the backup
   should update itself too.
4. On the head office PC: Riyeser Link Office → *Settings → Connect your branches → This PC as the relay* → paste the
   password into **Namecheap Dynamic DNS password** → *Run the relay on this PC…* (or *Save*). Never paste it into
   chat, email or a ticket. (Linux relay: `sudo ./relay/deploy/setup.sh … --ddns-provider namecheap`, asked hidden.)
5. Check: the same panel (or `/health` → `dns`) says the name points at the office, within a minute. "Namecheap
   refused the Dynamic DNS password": copy it again (step 2). "No A + Dynamic DNS Record": step 3.
The password lives only in `relay.env` on the relay machine (Administrators/SYSTEM, or root and the relay). If it may
have leaked: get a new Dynamic DNS password at Namecheap (Advanced DNS → Dynamic DNS; Namecheap support can reset it
if the page offers no way), then step 4 again.

**A customer's site won't connect.** Phones page → *Sites and the Riyeser relay* shows each site's state and reason.
"Update needed": Link Office older than 1.3.0. "Refused": the office was disconnected (Allow again) or the relay is
switched off for the business. "Not connected": the site has no internet, or blocks outgoing 443. On the PC:
*Settings → Connect your branches → Diagnostics*. "No sound between sites" with "Sound (UDP): blocked": the site's
firewall blocks outgoing UDP to the relay's ports 40000–49999.

**Revoke a site or phone at once** (stolen PC, lost phone): Phones page → *Disconnect* / *Remove*. The relay drops
it within 30 seconds (next `relay_sync`); old passes stop working.

**Rotate the relay secret** (if it may have leaked): make a new one (`openssl rand -hex 32`), put it in every relay
(`/etc/riyeser-relay/secret`, `C:\ProgramData\Riyeser Relay\secret`), restart them, then in Supabase:
`update relay_cluster set secret = '<new>';`. Link Offices get new passes on their next reconnect (they reconnect by
themselves when refused); browsers get new TURN passwords on their next call.

**Add or remove a relay**: `relay_register(...)` / `select relay_remove('mel1');` in the SQL editor.
**A relay just for one customer** (their own machine, managed by Riyeser): `relay_register('cust1', 'pbx.customer.com', 'Customer office', '<secret>', 1, '<workspace id>')`.

**Privacy**: relays log connections, extensions and call outcomes only. Never call sound, SDP, passwords or passes.
