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
  a closed business sees the plain "closed" message; and the same pages against a database that hasn't had the latest
  `team-chat.sql` yet (the new parts hide, nothing breaks). Phone widths too.
- `rules-test.sql` also covers Riyeser HQ phase 1: support tickets (customers see only their own, never internal notes),
  escalations (by hand and by the 48-hour sweep), staff permissions, the locked HQ history, fix-up tools (2FA reset,
  change owner, close/reopen, duplicates), inactive accounts (warnings, closing, never paid businesses, owner-approved
  removal), refunds (two-person rule) and free periods (supervisor approval).
- HQ: `../../hq/test-hq.js` (every tab in demo mode) and `../../hq/test-hq-ops.js` (Support, fix-ups, refunds with a
  second approver, free periods and Approvals, permissions, Inactive accounts, Emails, History filters and CSV, phone
  widths, and the "run the latest team-chat.sql" message on an older database).
