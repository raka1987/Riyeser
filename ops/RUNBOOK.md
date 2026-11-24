# Riyeser online services: backups, restores and bad days

The online parts of Riyeser keep data in Supabase (PostgreSQL):
- **Riyeser Team** (chat, calls, companies). This has its own Supabase project.
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
   - Do this once for the Riyeser Team project and once for the As Built project.
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
| `TEAM_DB_URL` | Riyeser Team connection string |
| `ASBUILT_DB_URL` | As Built connection string |
| `BACKUP_PASSPHRASE` | the passphrase |

5. **Check it works**
   - Go to **Actions → Nightly backups → Run workflow** and tick "Also save this as the month's copy". Wait for the green tick.
   - Then go to **Actions → Restore drill → Run workflow**. A green tick means the backup restores and every row is there.

If a secret is missing, the jobs just say "not set up yet" and don't fail.

## Riyeser HQ (riyeser.com/hq): the staff back office

HQ runs on the Riyeser Team Supabase project. `team-chat.sql` already sets it up. HQ only ever sees account
information: companies, people counts, branches, linked PCs and versions, trials, Team Calls and downloads.
It never sees customers' messages, calls or books.

**Make yourself the first owner (once):**
1. Create your Riyeser account at riyeser.com/team, then turn on two-step sign-in there (🔐 Security).
2. In Supabase, open **SQL Editor** and run `select public.hq_make_owner('your@email', 'Your name');`
   This only works from the SQL Editor, never from a website.
3. Sign in at **riyeser.com/hq**. To add staff, open **HQ team**: each person needs a Riyeser account with two-step sign-in, and you choose their role.

| Role | Can do (defaults) |
|---|---|
| Owner | Everything, including HQ staff, settings, the HQ history and approving account removal |
| Finance | Companies, licences, refunds (approve and pay), free periods (give and approve), level 2 and 3 tickets |
| Support | Companies, notes, level 1 tickets, edit details, two-step resets, free periods (within the limit), entering refunds |
| Senior support | As Support, plus level 2 tickets, change owner, close and reopen businesses |
| Sales | Companies, notes, licences (view), tickets (view), free periods (within the limit) |
| Developer | Overview and downloads |

Each role is a set of **permissions**. On the HQ team tab an HQ owner can tick extra permissions on, or off, for one
person ("Permissions" beside them). The website hides what someone can't do, but the database is the real check.
Every HQ action is written to the HQ history, including opening a company or a ticket. Nobody can change or delete it,
not even the database owner. History has filters (who, what, business, dates) and **Download CSV**.

**Daily download counts:**
1. Make a long random token (5–6 random words).
2. In the SQL Editor, run `select public.hq_set_ingest_token('the token');`
3. Add the same token as the GitHub secret `HQ_INGEST_TOKEN`.
4. Run **Actions → HQ download counts** once to check it works.

The Downloads page shows live totals straight away. Per-day numbers start the day after the job's first run.

Download totals include a few copies fetched by Riyeser's own release checks, so treat small numbers as roughly right.

**Marking a company paid for Team Calls:** HQ → Companies → open the company → Team Calls → Paid until → Save.

## After this release: re-run team-chat.sql in Supabase SQL Editor

Riyeser HQ phase 1 (support, fix-up tools, permissions, inactive accounts, emails, refunds, free periods) needs the
latest database rules. Until you do this, the website keeps working: the new customer parts stay hidden, and HQ shows
"Run the latest team-chat.sql to switch this on".

1. Open Supabase → the Riyeser Team project → **SQL Editor** → **New query**.
2. Paste all of `website/team/team-chat.sql` (from the `module/desk-assistant` branch) and press **Run**.
   It is safe to run again: it only adds what's missing and never deletes data.
3. Check it says "Success". Then open riyeser.com/hq: the Support, Refunds, Approvals, Inactive accounts and Emails tabs now work.
4. Run **Actions → HQ jobs → Run workflow** once. It should finish green (emails stay queued until email is set up).

## Support in HQ

Customers click **Get help** on their Riyeser home page (riyeser.com/team; Riyeser Central's **Get help** opens
riyeser.com/team/?help). They choose a topic, write a subject and message, and get a number like **T-10234**.
They see Riyeser's replies on their home page (with a "new" badge) and by email once email is set up.

In HQ → **Support**:
- **Inbox filters:** New, Waiting on us, Waiting on customer, Done, Mine, Unassigned, Overdue, Escalated, Level 2, Level 3.
  Each ticket shows its age and the first-reply timer. It turns red after 24 hours without a first reply.
- **Search** finds ticket numbers, subjects, business names, Business IDs, emails and words in messages.
- **Reply to customer** emails them and puts the ticket on "Waiting on customer". When they reply, it goes back to "Waiting on us".
- **Internal note**: only Riyeser staff see it. Customers never do.
- **Saved replies**: insert a ready-made answer and edit it before sending. "Saved replies…" lets you add, change or remove them.
- The business's summary sits beside each ticket (plan, people, PCs, notes), with a button to open its company panel.
- Opening a ticket or a company is written to the HQ history ("ticket.viewed", "customer.viewed").

HQ never sees customers' chat messages or books. Support tickets are written to Riyeser, so staff reading them is fine.

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

## Refunds

Owners and admins (with two-step sign-in) can ask for a refund from their Riyeser home page: what it's for, the
period, the amount and currency (FJD, AUD, NZD or USD), and why. This also opens a billing help request for the
conversation. Support staff can enter one for a customer from their ticket.

In HQ → **Refunds**, with filters for New, Reviewing, Waiting for second approval, Approved – to pay, Paid and Declined:
1. **Approve**, **Partly approve** or **Decline**. Each needs a reason, and the customer sees it in their email.
2. **The two-person rule:** above the threshold (default **200**, in any currency), a second staff member with
   "Approve refunds" must also approve. The same person can't give both approvals. The database enforces this, not
   just the website. The HQ owner can change the threshold in HQ team → HQ settings.
3. **Mark as paid** with how it was paid (card refund, bank transfer, M-PAiSA or credit on account) and the reference.
   **Real card refunds come in phase 2** with the payment provider. For now, do the refund by hand (bank or card
   terminal), then record it here. Credit on account shows on the company panel as "Credit: FJD …".

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
- "Used" means anyone in the business signed in, opened riyeser.com/team, or Riyeser Central checked in.
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

Every hour it runs the support sweep. Once a day it also runs the inactive-accounts sweep. Then it sends queued
emails if email is set up. It uses the `TEAM_DB_URL` secret, the same one as the backups. If the database hasn't had
the latest `team-chat.sql` yet, it says so and stops without failing. When it fails, open the red step. A connection
error usually means `TEAM_DB_URL` changed. Run it again by hand with **Run workflow**.

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
2. In its SQL Editor, run `website/team/team-chat.sql` (for Riyeser Team).
3. Restore the data. Decrypt the newest good copy (as in `restore-drill.sh`), then run `pg_restore --no-owner --no-privileges --data-only -n auth -n public -d "<new connection string>" db.dump`.
4. Put the new project's URL and key into `website/team/config.js` and publish the website.
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
