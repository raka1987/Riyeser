# Riyeser Link tests (formerly Riyeser Team)

- `rules-test.sql`: the database rules (each business only sees its own team, direct messages are private,
  only your own messages can be edited, wrong invite codes are refused, signed-out visitors see nothing).
  Run on an empty PostgreSQL 16 database: `supabase-stub.sql` (a stand-in for Supabase's sign-in), then
  `../team-chat.sql`, then `rules-test.sql`. It ends with `ALL CHAT DATABASE TESTS PASSED`.
- `demo-test.js` and `signin-test.js` (Playwright): build the site (`node website/build-combined.mjs`), serve
  `website/public` on port 8090, then run them with node. The tests use the main address, /link/;
  `oldaddress-test.js` checks the old address, /team/, still works (`?signup`, `?join=`, a sign-in link's `#...`).
- `private-test.js`: private chats with chosen people. `calls-test.js`: real calls between browser tabs in the
  demo (fake microphone and camera): person to person, a branch (first to answer), declining, the dial pad,
  branches and extensions, and the premium upsell.
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
  change owner, close/reopen, duplicates), inactive accounts (warnings, closing, never paid businesses, owner-approved
  removal), refunds (two-person rule) and free periods (supervisor approval).
- HQ: `../../hq/test-hq.js` (every tab in demo mode) and `../../hq/test-hq-ops.js` (Support, fix-ups, refunds with a
  second approver, free periods and Approvals, permissions, Inactive accounts, Emails, History filters and CSV, phone
  widths, and the "run the latest team-chat.sql" message on an older database).
- `phones-test.js`: the Phones page (Riyeser Link Office, desk phones) against a pretend Supabase: the set-up guide with
  no Link Office yet; the server address, extensions and desk phones from a heartbeat; a new phone → Give to… → the
  change is sent and done; Set up a phone by hand → Show (a one-off key goes out, the password comes back encrypted to
  it); Make a new password; Do not disturb; add by MAC; Let Riyeser help and End it now; the Link Plus upsell; an older
  database; phone widths. Exits 1 on failure. `rules-test.sql` covers the database side (who can report, read, send
  changes and take a password; the 5-minute window; HQ needs `link.support` plus the customer's grant).
- HQ: `../../hq/test-hq-link.js` checks `hq-link.js` filling `#cpLink` (summary line, phones, Show password, not set up).
- HQ customer page & reports: `rules-test.sql` also covers the customer page RPCs (contact details from sign-up, PCs'
  programs via `report_programs`, only for members and their own PCs), staff-started tickets ("Message customer": seen by
  the person it's to and the business's owners/admins only), logged calls and follow-ups, one-click licence actions (free
  time goes through free periods: the 31-day limit and Approvals), the Companies list (filters, sorting, pages, CSV
  export logged), Reports (`reports.view`), the work queue, team handover notes and the Riyeser account owner.
  `help-test.js` also checks a "Message from Riyeser" ticket and "Your details". HQ: `../../hq/test-hq-customer.js`.
- `myphone-test.js`: ☎ My phone for every member against a pretend Supabase: a connected desk phone, no phone (the guide), Show my own
  password (through `link_my_reveal`, encrypted to a one-off key, taken once), Do not disturb, Report a phone issue (prefilled), Call
  someone, no extension, Link Plus off, no Link Office yet, an older database, the ways in, phone widths. `phones-test.js` also covers
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
- `link-ui-test.js`: the Riyeser Link workspace (phase 1) in the demo and against a pretend Supabase: the panels (nav, list,
  conversation, People / Info), the status picker and Away after 10 idle minutes, reactions, pin and unpin, New chat, presence
  and extensions in the People panel, Quick dial, the floating call bar between two tabs (mute, hold, audio, end, chat while
  calling), an incoming call (Answer / Decline, the 📞 title, Do not disturb), themes (dark, light, match my computer, six
  accents, contrast checks), Admin / Settings hidden for members, phone width (one panel at a time), files (link-files) and an
  older database. Saves screenshots to the folder given. `rules-test.sql` covers presence, reactions, pins and file rules.
- `channel-menu-test.js`: the ⋯ channel menu (header, hover and right-click in the list): Rename, Edit topic, Members, Mute,
  Pin, Leave / Join again, Archive (the in-page question, the folded Archived section, read-only, Unarchive); #general can't
  be archived, renamed or left; a member only sees what they may do; folding the left menu, the right panel and each list
  section, remembered per person after a reload (Enter, Ctrl + [ and Ctrl + ]); phone width; light and dark; against a
  pretend Supabase (channel_rename / channel_archive / channel_mute, the database's refusal in the dialog, an older
  database). `rules-test.sql` covers the database side (who may rename and archive, two-step sign-in for admins,
  #general, read-only archived channels, mute and leave are each person's own, another business can't touch any of it).
- Every browser test takes `LINK_BASE=http://127.0.0.1:8091` to use another port. Confirmations are in-page now (`#askyes`).
- `pricing-test.js`: the website's prices (US dollars, per business per month, 3 users included in each program): the
  calculator's worked examples (US$7 for each person over 3, per paid program: 5 people with Accounting Plus + Payroll = US$92,
  Basics only = US$25, Link Plus with 4 people = US$46, Plus + Payroll + Link Plus with 5 people = US$145, never Basics and Plus both, yearly and early bird),
  no FJD/AUD/NZD on the website, free programs listed before paid ones (Central first), and the gold "★ Plus" marker on
  Riyeser Link. `rules-test.sql` checks the same sums in `riyeser_bill()` and `company_monthly()`.
- `storage-test.js`: Riyeser Link file storage (2 GB a business free, 20 GB with Link Plus, plus extra from HQ): the bar
  and the 80% warning in Billing & Subscription, the plain message when an upload would go over, and HQ's File storage
  card, Grant extra storage and "Storage over 80%". `rules-test.sql` checks the upload rule, the limits, who can see the
  usage and that granting needs `licences.manage`.
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
