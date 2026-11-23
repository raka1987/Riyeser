# Riyeser server: accounts, subscriptions and payments

The small cloud side of Riyeser. The programs still keep every invoice, sale and pay run on the customer's own PC.
This server only knows who the customer is, what they've paid for, and which PCs and versions they use.

```
Customer in Riyeser Central ──sign in (email code)──▶ Supabase Auth
            │  "what am I allowed?"                     │
            ▼                                           ▼
   functions/plan ──signed plan pass──▶ Central writes %APPDATA%\Riyeser\licence.json ──▶ every Riyeser program
   functions/checkout ──▶ Paddle checkout (riyeser.com/pay.html) ──▶ customer pays
   Paddle ──webhook──▶ functions/paddle-webhook ──▶ subscriptions + payments tables
   functions/portal ──▶ Paddle customer portal (change card, receipts, cancel)
```

- **No manual steps after setup.** Paddle charges the card each month or year and sends a webhook. The next time Central
  checks (on opening, every 6 hours, and every 20 seconds for 10 minutes after a checkout), the programs unlock or lock.
- **Failed card:** Paddle retries and emails the customer. The program keeps working with a warning until 14 days after
  the paid period ends (`GRACE_DAYS` in `supabase/functions/_shared/billing.mjs`).
- **Cancelled:** keeps working until the end of the period they paid for.
- **Offline:** a plan pass works for 30 days without internet.
- **Free allowances** (`settings` table, key `caps`, change any time without a new app):
  Basics 50 invoices, POS 500 sales, Payroll 4 pay runs, As Built 3 projects, Accounting Plus 90 days. A warning shows from 80%.

## What's here

| Path | What it does |
|---|---|
| `supabase/migrations/…_billing.sql` | Tables: accounts, devices, prices, subscriptions, payments, webhook_events, settings, admins. Row level security: customers see only their own rows, admins see all. |
| `supabase/functions/_shared/billing.mjs` | The rules (signature check, Paddle event → rows, what's paid until when, signing the pass). Tested in `test/`. |
| `supabase/functions/paddle-webhook` | Receives Paddle events. Checks the signature, stores every event once, and updates subscriptions and payments. |
| `supabase/functions/plan` | Called by Central. Records the PC's check-in (counts and versions only) and returns the signed plan pass. |
| `supabase/functions/checkout` | Called by Central. Makes a Paddle checkout for the chosen programs, tagged with the account id. |
| `supabase/functions/portal` | Called by Central. Opens Paddle's customer portal. |
| `supabase/migrations/…_admin_and_chats.sql` | Chats (conversations, messages, staff-only internal notes) and `admin_dashboard()`, the one call behind the admin page. |
| `admin/` | The admin page (plain HTML + JS). Publish it at riyeser.com/admin/. With no config it shows sample data. |
| `web/pay.html` | Paddle's "default payment link" page. Goes on riyeser.com as `/pay.html`. |
| `scripts/make-signing-key.mjs` | Makes the key pair that signs plan passes. |

Tests: `cd server && npm install && npm test` (Node 22). The SQL tests run the real migrations in an in-memory Postgres (PGlite) and check who can see what. Type check: `DENO_NO_PACKAGE_JSON=1 deno check supabase/functions/*/index.ts`.

## Setting it up (needs your own accounts)

Do it all in **sandbox** first. Nothing here charges anyone until step 8.

1. **Paddle sandbox account** at sandbox-vendors.paddle.com. In *Catalog → Products*, make one product per program
   (Accounting Basics, Accounting Plus, POS, Payroll, As Built, Extra user, Extra company), each with a monthly and a yearly
   price in AUD. Note each price id (`pri_…`).
2. **Supabase project**: make a new project for Riyeser accounts. Keep it separate from As Built's project so a problem
   in one can't touch the other. Use the Pro plan before going live, because free projects pause when idle.
3. **Database**: `supabase link --project-ref <ref>` then `supabase db push`. Then add the prices:
   `insert into prices (paddle_price_id, product, interval) values ('pri_…', 'basics', 'month'), …;`
4. **Signing key**: `node server/scripts/make-signing-key.mjs`. Keep the private line secret.
5. **Secrets** (`supabase secrets set …`):
   - `PASS_SIGNING_KEY`: the private key from step 4
   - `PADDLE_API_KEY`: Paddle → Developer tools → Authentication → API key
   - `PADDLE_WEBHOOK_SECRET`: from step 6
   - `PADDLE_ENV`: `sandbox` now, `live` at step 8
6. **Functions**: `supabase functions deploy paddle-webhook plan checkout portal`. In Paddle → Developer tools →
   Notifications, add `https://<ref>.supabase.co/functions/v1/paddle-webhook` for all `subscription.*`,
   `transaction.*` and `customer.*` events. Copy its secret key into `PADDLE_WEBHOOK_SECRET`.
7. **Central and the website**:
   - `desktop/src/core/cloud.json`: the project URL, the publishable (anon) key and the public key from step 4.
     All three are safe to publish.
   - `web/pay.html`: the Paddle client-side token. Publish it as riyeser.com/pay.html and set it as Paddle's default
     payment link.
   - Supabase → Authentication → Email templates: make the sign-in email show `{{ .Token }}` (the 6-digit code). Add your
     own email sender (SMTP) on riyeser.com so codes don't land in spam.
8. **Test, then go live**: buy with a Paddle test card, check the program unlocks, then cancel and refund it. Then repeat
   steps 1, 5 and 6 on the live Paddle account (Paddle checks your business and website first), set `PADDLE_ENV=live`,
   and make one real purchase and refund.

## The admin page (`admin/`)

- **Overview:** monthly recurring revenue, paying customers, sign-ups, PCs active this week, failed payments, chats
  waiting; sign-ups per day and revenue per month; who is near a free limit; renewals in the next 14 days; latest payments;
  Central versions in use.
- **Customers:** search by email; each customer's subscriptions, payments, PCs (versions and usage counts), chats and a
  staff-only note.
- **Chats:** every "Message us" conversation from Riyeser Central. Reply, add internal notes (never shown to the
  customer), mark done.
- **Downloads & traffic:** installer downloads from GitHub Releases (live), and a link to the website traffic dashboard.

Try it now with sample data: open `server/admin/index.html` through any local web server (for example
`python3 -m http.server` in `server/admin`).

To switch it on: fill in `admin/config.js` (project URL and publishable key), publish the folder at riyeser.com/admin/,
add each price's `amount` (cents) to the `prices` table so revenue adds up, and make yourself an admin. Sign in once in
Central first, so your account exists, then run:
`insert into admins (account_id) select id from accounts where email = 'you@…';`

Website traffic: add riyeser.com to Cloudflare Web Analytics (free, no cookies), paste its script tag into the
website's page template, and put the dashboard link in `admin/config.js` → `trafficUrl`.
