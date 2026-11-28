# Riyeser Link tests (formerly Riyeser Team)

- `rules-test.sql`: the database rules (each business only sees its own team, direct messages are private,
  only your own messages can be edited, wrong invite codes are refused, signed-out visitors see nothing).
  Run on an empty PostgreSQL 16 database: `supabase-stub.sql` (a stand-in for Supabase's sign-in), then
  `../team-chat.sql`, then `rules-test.sql`. It ends with `ALL CHAT DATABASE TESTS PASSED`.
- `security-test.sql`: security and privacy (same set-up as `rules-test.sql`, on its own empty database; it ends with
  `ALL SECURITY TESTS PASSED`). Row rules on every table, nothing for signed-out visitors, every SECURITY DEFINER function
  pins its search_path, and a reviewed list of what signed-out visitors may run; another business (and someone in no
  business) calls every function a signed-in person can run with business A's real ids and gets nothing back, and nothing
  of A changes; staff and an owner without two-step sign-in get no admin powers; Riyeser HQ functions never read private
  chat, files, call set-up, phone passwords or the online post box, every HQ function checks the role, each HQ role
  (support, developer, sales, finance) is refused what it isn't allowed, and nothing works without two-step sign-in;
  API key hashes, webhook secrets and relay keys are never readable; problem reports lose tokens, keys, passwords and
  the Windows user name in folder paths (SEC-001); the daily sweep removes call set-up messages over a day old (SEC-002);
  a staff member with a linked PC can't read, answer or report for another office's Riyeser Link Office or take its relay
  pass, while owners/admins can for every office and an office whose reporter left the business can be taken over (SEC-004).
  The owner's rule "support can trigger a reset but never sees, sets or receives any password": no HQ answer (every role,
  and the HQ owner looking at a business) and no HQ function's columns carry a password, secret, key, token, digest or
  sealed copy; Riyeser support can't Show a phone password, only Set a new password (Link Office makes it and says only
  "done"; nothing support typed reaches the office; "requested by" in both histories) (SEC-009); Sales and Support can't
  email invoices (SEC-010); Finance, Sales and Support can't change Riyeser's own billing and bank details (SEC-011:
  only the HQ Owner can). `rules-test.sql` covers SEC-009/010/011 too (the Billing entity: Finance refused, the Owner's
  change in force straight away, the same again writes nothing, the HQ history has who, when, before and after).
- `demo-test.js` and `signin-test.js` (Playwright): build the site (`node website/build-combined.mjs`), serve
  `website/public` on port 8090, then run them with node. The tests use the main address, /link/;
  `oldaddress-test.js` checks the old address, /team/, still works (`?signup`, `?join=`, a sign-in link's `#...`).
- `private-test.js`: private chats with chosen people. `calls-test.js`: real calls between browser tabs in the
  demo (fake microphone and camera): person to person, a ring group (first to answer), declining, the dial pad,
  branches and extensions, and Riyeser Link paused. Ring groups with chosen members: Management's one-time "Choose who
  answers each branch number" (Choose now, Keep as they are), only the chosen ring (someone in the branch but not chosen
  doesn't), a new group with its own number (a person's or a branch's number refused), Ring in order (the next after its
  seconds), Rotate (someone else first on the next call), Do not disturb skipped, nobody chosen → on to another group,
  a new branch with nobody chosen (not rung, the caller is told), staff can't open it; and the Ring groups page, the
  Management notice and the Calls card at 1280 at 125%, 1366, 1920 and 390, light and dark. Exits 1 on failure.
  `rules-test.sql` covers the database side: the upgrade (each branch's people, "check these", safe to repeat), a new
  branch with nobody chosen, `ring_group_save` (order, desk phones, numbers that clash, who may), `ring_group_plan`
  (only the chosen, in order, rotate, Do not disturb / Busy / At lunch / Unavailable / On a call skipped, the fallback),
  a group ring only reaching the chosen (`call_signals`), `ring_group_delete`, `ring_groups_confirm`, leaving the
  business, and another business seeing and changing nothing. Riyeser Link Office: `desktop/test/link-ringgroups.test.js`.
- `company-test.js`: Company ID, join requests (approve with job role and branch), people & access, company details,
  linked PCs, and ask-to-join → waiting → approved against a pretend server.
- `mfa-test.js`: two-step sign-in (set up with a QR code, the reminder for owners/admins, admin screens waiting for
  it, the code screen at sign-in with a wrong and a right code) and the change history.
- `help-test.js`: help requests and refunds on Riyeser home against a pretend Supabase: `?help` opens "Get help" after
  sign-in, the request is sent, a Riyeser reply shows as unread and the customer replies; an owner asks for a refund;
  a closed business sees the plain "closed" message; an admin (not the owner) sees no refunds (they show amounts); and the same pages against a database that hasn't had the latest
  `team-chat.sql` yet (the new parts hide, nothing breaks). Phone widths too.
- `rules-test.sql` also covers Riyeser HQ phase 1: support tickets (customers see only their own, never internal notes),
  escalations (by hand and by the 48-hour sweep), staff permissions, the locked HQ history, fix-up tools (2FA reset,
  change owner, close/reopen, duplicates: `hq_close_duplicate` closes only the account given, never deletes, re-checks the
  typed Company ID, the optional account kept (exists, not itself, not closed), the permission and two-step sign-in, needs
  the warnings accepted, writes the before/after, and Reopen removes the link; `hq_dup_check` suggests likely matches), inactive accounts (warnings, closing, never paid businesses, owner-approved
  removal), refunds (two-person rule) and free periods (supervisor approval).
- HQ: `../../hq/test-hq-dup.js` (🔁 Close as duplicate: nothing linked to start with, likely matches with why, search never
  offers itself or a closed one, this account's facts, typing its Company ID, the warnings incl. "you may be closing the wrong
  one", Reopen removes the link; 👑 Change owner starts empty; iPhone width).
- HQ: `../../hq/test-hq.js` (every tab in demo mode) and `../../hq/test-hq-ops.js` (Support, fix-ups, refunds with a
  second approver, free periods and Approvals, permissions, Inactive accounts, Emails, History filters and CSV, phone
  widths, and the "run the latest team-chat.sql" message on an older database).
- `phones-test.js`: the Phones page (Riyeser Link Office, desk phones) against a pretend Supabase: the set-up guide with
  no Link Office yet; the server address, extensions and desk phones from a heartbeat; a new phone → Give to… → the
  change is sent and done; Set up a phone by hand → Show (a one-off key goes out, the password comes back encrypted to
  it); Make a new password; Do not disturb; add by MAC; Let Riyeser help and End it now; Riyeser Link paused; an older
  database; phone widths. Exits 1 on failure. `rules-test.sql` covers the database side (who can report, read, send
  changes and take a password; the 5-minute window; HQ needs `link.support` plus the customer's grant, and can never Show a
  password, only Set a new password, which Link Office makes itself: SEC-009).
- HQ: `../../hq/test-hq-link.js` checks `hq-link.js` filling `#cpLink` (summary line, phones, no Show password, Set a new password, not set up).
- HQ customer page & reports: `rules-test.sql` also covers the customer page RPCs (contact details from sign-up, PCs'
  programs via `report_programs`, only for members and their own PCs), staff-started tickets ("Message customer": seen by
  the person it's to and the business's owners/admins only), logged calls and follow-ups, one-click licence actions (free
  time goes through free periods: the 31-day limit and Approvals), the Companies list (filters, sorting, pages, CSV
  export logged), Reports (`reports.view`), the work queue, team handover notes and the Riyeser account owner.
  `help-test.js` also checks a "Message from Riyeser" ticket and "Your details". HQ: `../../hq/test-hq-customer.js`.
  One PC counts once: `rules-test.sql` checks that linking or reporting marks older rows for the same computer name and person
  replaced (kept, never deleted), `retire_duplicate_pcs()` for the rows already there (safe to repeat), and that HQ counts only
  PCs not replaced and seen in 60 days. `test-hq-customer.js` opens "3 PCs" on the Programs tab (each PC's name, who linked
  it, last seen, programs and versions; "Older PCs (not seen since …)"). Riyeser Central: `desktop/test/program-reports.test.js`.
- `myphone-test.js`: ☎ My phone for every member against a pretend Supabase: a connected desk phone, no phone (the guide), Show my own
  password (through `link_my_reveal`, encrypted to a one-off key, taken once), Do not disturb, Report a phone issue (prefilled), Call
  someone, no extension, Riyeser Link off, no Link Office yet, an older database, the ways in, phone widths. `phones-test.js` also covers
  Set up your office phones (5 steps), the Desk phones list's four statuses, Add desk phone through to Online, Replace phone,
  Troubleshoot and Advanced setup being for admins only; `rules-test.sql` covers `link_my_*` and `name_phone`.
- Support workspace: `rules-test.sql` covers `support_report` (one diagnostic report and one ticket; logs, emails, long
  numbers and passwords scrubbed; a DG- reference from Central linked instead), diagnostics privacy (only whoever made a
  report reads it; other businesses can't; HQ needs `support.diagnostics`), the HQ inbox filters, product, planned
  release, linked bug, logged calls, the next promised update (the hourly sweep's internal reminder, once; Needs
  attention; the work queue), Still having an issue / Confirm fixed (only the ticket's business) and the rating (only
  once resolved). `help-test.js` covers Report an issue, "We'll update you by", Still having an issue, Confirm fixed,
  "How did we do?" and the `?help#T-…` email link. HQ: `../../hq/test-hq-support.js` (three columns, filters, assign,
  status, separate drafts with the audience line, Log a call, Next update, diagnostics, support notes, phone width).
  Riyeser Central: `desktop/test/diagnostics.test.js` (scrubbing, 200 lines / 64 KB, the preview is what's sent).
- `link-ui-test.js`: the Riyeser Link workspace (concept A: one list, one chat) in the demo and against a pretend Supabase: the
  slim top bar and two panels (All · Channels · People · Unread, one badge a row, pinned at the top, in folding sections), Calls (with Voicemail)
  and People as views, details (ⓘ) only when asked for; your status (Available, Busy / Do not disturb, At lunch, Away,
  Unavailable; 30 min / 1 hour / until a time, then back to Available; Away after 10 idle minutes; On a call and Offline
  can't be chosen) next to names; reactions, pins, New chat, files; the keypad only from Call or Calls; the call pill between
  two tabs (mute, hold, audio, end, nothing covered, "On a call" by itself and back afterwards); an incoming call (Answer /
  Decline, the 📞 title); Busy, At lunch and Unavailable don't ring (the caller is told; a ring the database refuses doesn't
  ring either); Management locked (a fresh code each time, the demo's code shown, locks after 15 idle minutes, Lock now, a
  reload); staff never see Management or any admin item; themes and contrast; phone width (Chats · Calls · People · Settings
  along the bottom, a chat full screen, the status menu); files (link-files); an older database. `rules-test.sql` covers
  presence, the new statuses and "until", no ringing on Busy / At lunch / Unavailable, desk phone "On a call", owner-only
  admins, reactions, pins and file rules.
- `channel-menu-test.js`: the ⋯ channel menu (header, hover and right-click in the list; on a phone the chat's own ⋯): Rename, Edit topic, Members, Mute,
  Pin, Leave / Join again, Archive (the in-page question, the folded Archived section, read-only, Unarchive); #general can't
  be archived, renamed or left; a member only sees what they may do; the details (ⓘ) only on demand (Ctrl + ]) and the
  filter chips; phone width; light and dark; against a
  pretend Supabase (channel_rename / channel_archive / channel_mute, the database's refusal in the dialog, an older
  database). `rules-test.sql` covers the database side (who may rename and archive, two-step sign-in for admins,
  #general, read-only archived channels, mute and leave are each person's own, another business can't touch any of it).
  Part 2: Mute for 1 hour / 8 hours / until tomorrow / a week / until turned back on (`channel_mute_until`; a timed mute ends by
  itself); a line in the chat for each change ("You renamed #office to #paper-work", topic, archived / brought back, added /
  removed / left a private channel), not counted as unread; the change history (renames, topics, archiving, who's in a private
  channel); the list's sections (Pinned, Channels, Direct messages, Archived) fold away, the list shrinks to icons (Ctrl + [) and
  the details stay open, all remembered with the account (`riyeser_prefs.ui`) and in the browser, including after a reload and
  from the account alone; the layout at 1280 at 125%, 1366, 1920 and 390, light and dark (nothing cut off or wrapping, no
  sideways scroll); a database with the channel menu but not part 2. `rules-test.sql`: the lines (only the database adds them,
  nobody edits them, from whoever made the change, none when nothing changed, not unread, not seen by another business),
  `channel.topic` / `channel.members` in the history, `channel_mute_until` (within a year), `set_channel_people` permissions.
- Every browser test takes `LINK_BASE=http://127.0.0.1:8091` to use another port. Confirmations are in-page now (`#askyes`).
- `pricing-test.js`: the website's prices (pricing v2: US dollars, per business per month, 3 users included in each program;
  Riyeser Link US$20 is a paid program; POS 1 till and unlimited cashiers, US$15 a till; bundles Shop US$59, Office US$59,
  Business US$99): the bundle cards, the price list (Link Office "With Riyeser Link", no price), the calculator's worked
  examples with a number per program (Plus + Payroll, 5 users = US$92; Link with 4 = US$27; Shop = US$59; Business = US$99;
  POS with 3 tills = US$59; the Business bundle tip; never Basics and Plus both; yearly and early bird), no FJD/AUD/NZD and nothing
  left of the old Link Plus on the website, free programs then paid ones each A to Z everywhere (menu, finder, cards, downloads, footer), the
  phone footer in Free and Paid columns and the home hero as one still picture on a phone. `rules-test.sql` checks the same
  sums in `riyeser_plan()`, `riyeser_bill()` and `company_monthly()`.
- `storage-test.js`: Riyeser Link file storage (20 GB a business with Riyeser Link, plus extra from HQ; nothing new uploads
  while Riyeser Link is paused): the bar and the 80% warning in Billing & Subscription, the plain message when an upload would
  go over, and HQ's File storage card, Grant extra storage and "Storage over 80%". `rules-test.sql` checks the upload rule,
  the limits, who can see the usage and that granting needs `licences.manage`, and that chat is read-only while Riyeser Link
  is off (no sending, editing or reactions), the free accountant, and the once-only 90-day Link trial for existing businesses.
- `pay-test.js`: paying for Riyeser against a pretend Supabase and a pretend `paypal` function, at desktop and 390px: every paid
  program's **Start free for 90 days** and **Buy now** (pricing rows and checklists, program pages) and the calculator's **Buy this
  plan** go to `/link/?signup&add=…` (the sign-up email's link keeps it); after sign-in **Add to my plan** opens for those programs
  (people, monthly or yearly, the total, the database's early bird); **Pay with PayPal** to PayPal and back ("Thanks, we're
  confirming your payment", then confirmed); **bank transfer** (the invoice, bank details, reference, printable invoice and
  receipt); **Billing** (next charge, a failed payment's grace date, invoices, history, Manage in PayPal, Cancel with the in-page
  question); PayPal not set up (bank transfer only); no bank details yet; admins can't pay or see billing; an older database;
  no browser pop-ups; and that `prices.mjs`, `team.js`, `hq.js` and `riyeser_price()` have the same prices.
  HQ: `../../hq/test-hq-pay.js` (Invoices & payments in demo mode: the PayPal card, failed payments and unpaid invoices in the
  work queue, Mark bank transfer paid, masked PayPal ids, the Billing entity and "Add your bank details", the Money tab).
  `rules-test.sql` covers the database side: only the owner quotes, pays and sees billing (admins, staff and other businesses
  can't; nobody reads the tables); bank invoices (licence off until HQ marks it paid; only `licences.manage`; the HQ history);
  the versioned Billing entity (old invoices keep old details); PayPal webhooks applied once each (duplicates, the same sale
  twice, wrong amount or currency, unknown subscriptions), a failed payment's grace, retry, cancel (works to the paid date),
  masked ids for HQ; only the service role records PayPal's side. The function itself: `supabase/functions/paypal` on `main`
  (`deno test supabase/functions/paypal`).
- `password-test.js`: passwords and email links against a pretend Supabase that keeps the account's password: the reset link
  asks for a new password (twice, at least 8; the code first when two-step sign-in is on), then the old one fails and the new one
  works and other devices are signed out (F17); 🔑 Change password (current password checked, a code when two-step sign-in is on);
  a confirm-your-email link shows "Email confirmed" then carries on, and an expired link says so (F1); Supabase's "email rate limit
  exceeded" becomes a plain message with info@riyeser.com (F2); two-step set-up works with one click right after the page loads
  and again after Later, removes unfinished set-ups, and a page signed in before it was turned on elsewhere catches up (S6).
- `speed-test.js`: the Riyeser home after sign-in and after a reload against a pretend Supabase where every call takes 300 ms
  (`LATENCY=`): on screen in under 2 seconds, plan and billing filled in soon after, Open Riyeser Link works (S4).
- `people-test.js`: joining and leaving against a pretend Supabase: an owner without two-step sign-in still sees how many are
  waiting (bell, Join requests, home) and the email link `?requests` opens Join requests (S7); the invite link says "Join
  {business} on Riyeser" and the join form has the person's name (S8); a removed person sees "You're no longer part of
  {business}", their old messages show "{name} (left)", and an empty name on the join form says what's missing (S59).
  `rules-test.sql` covers the database side: the owners/admins email (once), `join_request_count`, `invite_info`, an
  extension for people who join without a branch, `former_members` (members only; the removed person reads nothing).
- `chat-test.js`: chat details in the demo: a counter near the 4,000-character limit and longer text sent as a .txt file (S9); on
  a phone, Back from a conversation shows the chat list and Back again the Riyeser home (S49, pretend Supabase);
  more checks are added to it for the round-20 fix list (see its header).
  `people-test.js` also covers help without signing in (S3): `?help` signed out offers it first, the sign-in page links to it,
  `?contact` (Contact support on riyeser.com) opens it, the request number shows; `rules-test.sql` (end) covers `guest_ticket`
  (the auto-reply with the number, the limits, HQ sees who to reply to, HQ's reply is emailed).
- `paypal-live-test.js` (PAYPAL-LIVE): Add to my plan / Pay once PayPal is live, for an owner with a practice (PayPal sandbox)
  subscription, at 1366 and 390: "Pay with PayPal" shows (no "You already pay by PayPal", no "opening soon", no bank wording
  without Riyeser's bank details); on the free trial "Start paying when my free trial ends" (ticked: "Nothing is charged
  today. With PayPal, your first payment is on …") or "Buy now: start my paid plan today" (charged today, "Your remaining
  free days (N) end today"), sent once on a double click; Billing's "Practice payment (test): not a real subscription" with no
  link to PayPal's practice site and Remove on Riyeser's side only; Buy now on Your plan's trial rows and `?buy=now`.
  `rules-test.sql` and `security-test.sql` (PAYPAL-LIVE sections): a sandbox subscription doesn't block live, never a
  sandbox link once live, the HQ Owner's Clear practice payments (Owner only, audited, reversible, live orders untouched),
  Buy now (charged today, the trial ended when PayPal confirms the first payment), a double click gives one order.
  HQ: `../../hq/test-hq-practice.js` (demo with `?pplive`: Needs attention's "Add Riyeser's bank details to offer bank
  transfer" and "Practice payments to clear" for the Owner only, Clear practice payments and Put back on the Money tab,
  "Bought now (ended trial early)"). The paypal function's side: `supabase/functions/paypal/paypal_test.ts` on main.
- `payoff-test.js` (OWNER-PAYOFF): the ways to pay in Add to my plan against a pretend paypal function like the deployed one:
  a customer while PayPal is in sandbox (no PayPal; bank transfer only with details), HQ's owner in sandbox ("Pay with PayPal
  (practice: only you see this)", the status call carries the sign-in), live mode, bank transfer with and without details,
  and neither way open ("Online payments are opening soon…" with the trial's end date). `rules-test.sql`: `my_billing.bank_ready`.
- Website traffic: `rules-test.sql` checks `track_visit` (anyone can add a page view, only through it; addresses tidied,
  non-website pages ignored, values checked and cut short, 200 a session a day), that nobody reads `site_visits` directly,
  that `hq_traffic` needs `reports.view`, and the daily sweep (13 months of raw rows, daily totals kept). HQ:
  `../../hq/test-hq-traffic.js` (Reports → Website traffic in demo mode, and the website's tracking script).
- `a11y-test.js` (M21): small grey text on the home and pricing cards at least 4.5:1, heading levels in order, "Skip to content"
  first on Tab, Link's avatar initials at least 4.5:1, no button inside a button, a focus ring on "Search people", and the sign-in
  email box `autocomplete="username"`. With `AXE=path/to/axe.min.js` it also runs axe-core on those pages (all clean now).
- `csp-test.js`: the website's Content-Security-Policy (a `<meta>` on every page from build.mjs; scripts only by SHA-256): nothing
  refused on eight pages, fonts and images load, the phone menu, calculator, Help search and Sign in work, an injected script is refused.
- Online connections (the public API, `api_*`): `rules-test.sql` covers API keys (only owners and admins with two-step sign-in make,
  list, rename, limit and revoke them; staff and other businesses can't; the key is returned once and only its SHA-256 is kept, never in
  the change history; widget keys limited to availability/bookings/enquiries and a website address), `api_auth` (hash lookup, revoked,
  internet address lists, rate limits per key per minute, per visitor for widget keys, per business per day), the post box (Idempotency-Key
  replay and conflict, permissions, payload essentials, test keys marked test, plan gating), the PCs' claim/done/fail (only linked PCs, 10-minute
  lease, retries then failed, rejected, FOR UPDATE SKIP LOCKED with a second connection through `dblink`), published catalogue/stock/open times
  and free start times (a widget booking holds its time), webhooks (https only, the secret shown once, retries with backoff, turned off after
  3 days failing), the request log (addresses truncated, 30 days) and `api_sweep` (90/30 days). Needs the `dblink` extension (in PostgreSQL's contrib).
- `connections-test.js`: Management › Connections against a pretend Supabase answering the `api_*` functions: the fresh two-step code
  first (no `api_*` call before it), the Overview, + New key (presets, widget keys need a website and can't send orders, the key shown
  once with Copy, then only its prefix: never in the page, browser storage or the change history), rename, websites and addresses, revoke
  (the in-page question), the post box (filters, Try again), the request log (per key, refused only, Show older), webhooks (https only,
  the secret once, Send test, Deliveries, turned off → Turn back on), Add to your website (snippet, live preview), plan messages, the
  database's refusal, an older database (PGRST202), staff (nothing at all), no two-step sign-in, and 390px.
- `booking-page-test.js`: the hosted booking page (`website/book`, riyeser.com/book/<address>) against a pretend API (the
  `/v1/pages/…` routes). It serves `website/public` itself on 18732 the way GitHub Pages does (a missing file gets `404.html`,
  so the clean address works): the profile (name, colour, address, hours, services), service → who → day → time → details →
  request (no key, no cookies, a UUID Idempotency-Key) → confirmed; the time gone (409), a refused field (422), a dropped
  connection retried with the same key; unknown / switched off / paused / no Bookings licence; `/book/demo` and the owner's
  `?preview`; phone width, dark, keyboard only, a pale brand colour still readable, no storage. Run `node website/build.mjs` first.
  `connections-test.js` (13) covers the owner's side (Management → Connections → Booking page) and `rules-test.sql` the
  database (`booking_page_*`, `api_page_auth`, `api_page_profile`, the hidden page key, limits).
- `widget-test.js`: the booking widget (`website/widget/book.js`, served at `/widget/book.js`) on another website (8093) against a pretend
  API (8094) with real CORS, plus a website not on the key (8095): book a slot through to "confirmed", an idempotent retry after a cut-off
  answer (one booking), no free time, 409 slot gone, 402 plan, 422, 429, the enquiry form and the order button, dark, 390px, keyboard,
  no cookies or storage. Uses ports 8093-8095.
- `developers-test.js`: riyeser.com/developers/ (from `website/developers.mjs`): every page under the CSP, every endpoint with curl and
  JavaScript, the webhook signature known answer, the widget preview, help and footer links, the sitemap, 390px.
- `online-help-test.js` (node, no browser): the "Online connections" help guide (diagram, five set-up steps, where to paste the code, checklist, Send a test, Activity, problems); after a build it checks help/online.html too. `connections-test.js` step 12 covers the "Connect your website" guide on Management → Connections (checklist from `api_status`, Send a test through `api_send_test` / `api_event_status`).
- Real downloads and installs (HQ → Downloads): `rules-test.sql` covers `record_download` (the download function's
  service role only; values tidied; 30 a visitor an hour), `track_install` (anonymous; new/existing once per PC, the same
  update once, 50 notes a day), `install_link` (members only, once), `hq_real_downloads` (downloads.view; real = no
  bots, tests or staff, one person once a day per program; hidden counts; per day, program, country, page, release) and
  `hq_save_download_totals` (the daily job, owner only). `../../hq/test-hq-downloads.js`: the HQ page in demo mode
  (tiles, hidden counts, 30/90 days, a program's chart, by country and page, the staff tick, the raw GitHub section
  collapsed, an older database, a phone) and the website's `download/<program>.html` hand-off (asks the counter with
  staff/test/where-from, then the GitHub file; straight to GitHub when the counter is down). `csp-test.js` and
  `a11y-test.js` include the hand-off page. The function itself: `deno test supabase/functions/download` (branch main).
  Riyeser Central's side: `desktop/test/usage-counts.test.js`.
- `relay-remove-ui-test.js` (Link Office 1.3.1): Sites & relay — your relays (make main, stop using, Riyeser's can't be
  removed), each site's checklist from its reports, Advanced checks run on a chosen site's Link Office (test call, one
  check, raw details), Move to another PC (a set-up code), removing the last relay (a warning first, then switched off),
  and a phone (one column, big buttons). `rules-test.sql` covers the database side (set-up codes, own keys, takeover,
  removal and the changed cluster secret, last relay, `relay_leave`, `relay_check`). Screenshots go to the folder given.
- PDF signing requests (Riyeser PDF → Ask someone to sign): `sign-test.sql` (same set-up as `rules-test.sql`, on its own
  empty database; it ends with `ALL SIGNING TESTS PASSED`): only the sender sees and changes a request (not staff, not the
  business's owner, not another business, not someone who left), the private `sign-docs` bucket's rules (only that draft's
  sender uploads, once, at `<business>/<request>/original.pdf`; only the sender reads or deletes), only a SHA-256 of each
  emailed link is kept, signing in order (the next link is made when the one before signs), finishing (every field, "I
  agree to sign electronically", PNG signatures only, the date is the day signed), the trusted address and the whole
  forwarded chain recorded, completion (one copy at a time, the download links), decline with a reason, cancel, reminders
  (a new link; the old one stops; once a day), expiry (the sender's date or 30 days; the hourly `sign_sweep`), the monthly
  free quota (`sign.free_per_month`, last month's don't count), rate limits (wrong links per address, opens, actions;
  counters keep a hash, not the address), file clean-up (keep 30/90/365/730 days, drafts after 2 days, the history stays),
  and the audit trail can't be changed. `security-test.sql` also tries every signing function as another business and as
  someone in no business, checks no HQ function reads the signing tables, HQ staff can't read the bucket, and nobody signed
  in or out can run `sign_pub_*` (only the `sign` Edge Function's service role).
- `sign-page-test.js`: the signing page riyeser.com/sign/?t=… (`website/sign`) against a pretend `sign` function: sign
  (drawn and typed, every field, I agree), decline (a reason is needed), expired, a wrong link, a link of the wrong shape (never
  sent), completed (download), too many tries, a document whose fingerprint doesn't match; nothing loaded from elsewhere, no
  cookies or storage, no referrer, noindex and `Disallow: /sign/`, no CSP refusals, no sideways scrolling at 390, and with
  `AXE=…/axe.min.js` axe-core on each screen. Run after `node website/build-combined.mjs`: `node website/team/test/sign-page-test.js <shots>`.
  The function itself: `deno test --allow-env --allow-read --allow-net supabase/functions/sign` on branch main (with
  `SIGN_TEST_PG=postgres://…` it also runs end to end on a local database with this team-chat.sql). Riyeser PDF's side:
  `desktop/test/sign-request.test.js`.
- Trial guard (the free trial's anonymous PC record): `rules-test.sql` checks `pc_trial_seen` keeps the earliest date per
  PC code and program (a reinstall's later date never moves it later, a restored company file's older date wins, a look-up
  makes nothing, another PC gets nothing of this one's) and that `pc_trials` keeps only the PC code, program, dates and
  version. `security-test.sql` checks signed-out visitors and signed-in people can't read or write `pc_trials`, the reviewed
  anonymous function, dates before 2024 or in the future aren't believed, 20 calls an hour per PC code, the client address
  for rate limits is CF-Connecting-IP or the last X-Forwarded-For entry (never the first: SEC-017), a report's trial record
  keeps only the PC code, dates and counts (no MachineGuid, names or paths), the HQ ticket's Trial history needs
  `trials.view` (Support, Finance, Owner; not Developer, Sales or Senior), a ticket with the customer's report, and is in
  the HQ history; only Owner/Finance (`licences.manage`) extend it, with a reason; the counts never show a PC code.
  HQ: `../../hq/test-hq-trial.js` (the panel at 1366 and 390, the verdict, read-only, the extension, roles, Licences counts).
  Desktop: `desktop/test/trial-guard.test.js` (new PC, new Windows user, reinstall, deleted AppData, restored company
  file, clock rolled back, paid programs, signed-in businesses, demo mode, Report an issue).
- HQ layout: `../../hq/test-hq-layout.js` opens every page of the current HQ and of HQ V2 (`?v2=1`) at 1280, 1366, 1440,
  1920 and 390 px and fails on: anything scrolling sideways (the page or a box) except wide data tables (`data-wide`: a thin
  visible scrollbar, first column kept in view), a box with its own inner scrollbar (the Support inbox's list and thread
  are marked `data-vscroll`: panes on purpose), text cut off or squeezed into a sliver, table cells out of line, cards side
  by side of different heights (more than 1 px), and row menus (⋯) that open outside the window, behind something or inside
  a scrolling box. On the Overview it also puts big figures (US$64,512.50) and long captions in the count cards. Owner
  decisions behind it: "Assigned to" (a person, "You", or "Unassigned" with the team's tag and Assign to me) instead of
  "Owner: Finance"; test, demo and internal accounts left out of the current Overview (Needs attention, the count cards,
  Queue at a glance, Riyeser at a glance) unless "Include test accounts" is ticked (`hq_overview(boolean)`,
  `hq_attention(boolean)`, checked in `rules-test.sql`); Admin → Test accounts in the current layout.
- HQ sign-out: `../../hq/test-hq-signout.js` (against a pretend Supabase, both layouts and a phone): the account menu at the
  top right ("Sam · Owner") with Sign out and Sign out of all devices, the Sign out link at the foot of the left-hand menu;
  Sign out ends the session (logout, scope local; "all devices" scope global), forgets the stored session, lands on the
  sign-in screen; Back shows no HQ data; no HQ data calls afterwards; the old session's token is refused.
- Custom HQ roles (owner's request "give the option for admin to select roles"; owner's decision: a standard role for each
  person, then tick or untick for them). The database is the source of truth: `hq_roles` and `hq_role_permissions` (the seven
  built-in roles seeded once from the shipped lists, `hq_builtin_perms`; running `team-chat.sql` again keeps the Owner's
  changes), `hq_staff.role` a role key, `hq_can` = the role's ticks plus the person's extras minus their removals.
  `rules-test.sql` (end) checks every built-in role against the lists HQ had before (frozen in the test; "Email invoices and
  receipts", `invoices.email`, now its own permission, comes with `licences.manage` as before: SEC-010), creating, changing,
  duplicating and removing roles (a role people still have needs somewhere to move them), per-person ticks stored as the
  difference from the role, Reset to standard, and the HQ history (who, before and after). `security-test.sql` section 7: what
  can never be given (passwords and secrets SEC-009, bank details SEC-011, making an Owner, getting past two-step sign-in), not
  even by hand in the tables or by calling the functions directly; no privilege escalation (nobody but the Owner gives a
  permission they don't have, nobody but the Owner gives `invoices.email`); the last Owner keeps full access; nothing without
  two-step sign-in. `roles-migration-test.sh` loads `team-chat.sql` from before custom roles (commit `26cbd1ae`), adds staff
  with every role and per-person ticks, then this `team-chat.sql` twice, and checks everyone can still do exactly the same
  (`PSQL="psql -h … -U postgres" website/team/test/roles-migration-test.sh`; needs git). HQ: `../../hq/test-hq-roles.js`
  (People and Roles at 1366 and 390, the Admin's limits).
