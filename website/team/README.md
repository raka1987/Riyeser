# Riyeser Link (riyeser.com/link), formerly Riyeser Team

Free chat, plus **Riyeser Link Plus** (premium: +$20 a month per business, free for each team's first 90 days).

This folder is published twice, unchanged: at **riyeser.com/link/** (the address to use) and at **riyeser.com/team/**
(the old address, kept so older Riyeser Team desktop apps, Centrals, invite links and sign-up emails keep working).
`config.js` is therefore at both `/link/config.js` and `/team/config.js`. The folder, the database (`team-chat.sql`),
the `calls` licence module and the sign-in storage keep their old `team` names; only what people see changed.

## Setting it up (once)
1. supabase.com → New project (call it `riyeser-team`). This must NOT be the As Built project.
2. SQL Editor → New query → paste all of `team-chat.sql` → Run. Safe to run again after updates.
3. Authentication → Sign In / Providers: Email on, "Allow new users to sign up" on.
   Authentication → URL Configuration: Site URL `https://riyeser.com/link/`, and Redirect URLs
   `https://riyeser.com/link/`, `https://riyeser.com/team/` and `https://riyeser.com/hq/`.
4. Put the Project URL and Publishable key in `config.js`. Until then the page shows the demo.

## Marking a business as paid for Riyeser Link Plus
In SQL Editor (find the team by its name):

    update public.workspaces set calls_paid_until = '2027-12-31' where name = 'Sample Plumbing';

Calls work while `calls_paid_until` is in the future, or during the team's first 90 days. Nobody can change this
from the app.

## Calls
Calls go directly between devices (WebRTC); the database only carries the ringing (`call_signals`).
Optional relay servers for strict networks go in `config.js` as `iceServers: [...]`.

Tests: see `test/README.md`.
