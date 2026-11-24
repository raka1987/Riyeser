# Riyeser Team tests

- `rules-test.sql`: the database rules (each business only sees its own team, direct messages are private,
  only your own messages can be edited, wrong invite codes are refused, signed-out visitors see nothing).
  Run on an empty PostgreSQL 16 database: `supabase-stub.sql` (a stand-in for Supabase's sign-in), then
  `../team-chat.sql`, then `rules-test.sql`. It ends with `ALL CHAT DATABASE TESTS PASSED`.
- `demo-test.js` and `signin-test.js` (Playwright): build the site (`node website/build-combined.mjs`), serve
  `website/public` on port 8090, then run them with node.
