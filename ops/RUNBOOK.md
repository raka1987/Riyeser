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
