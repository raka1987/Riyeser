// Runs the real migrations in an in-memory Postgres (PGlite) with a tiny stand-in for Supabase's auth schema,
// then checks the row level security and the admin dashboard as a customer, a staff member and a stranger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const dir = new URL('../supabase/migrations/', import.meta.url);
const SUPABASE_STANDIN = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`;

const CUST = '11111111-1111-1111-1111-111111111111', STAFF = '22222222-2222-2222-2222-222222222222', OTHER = '33333333-3333-3333-3333-333333333333';

async function setup() {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  await db.exec(`
    insert into auth.users values ('${CUST}', 'cust@shop.fj'), ('${STAFF}', 'me@riyeser.com'), ('${OTHER}', 'other@x.com');
    insert into accounts (id, email, created_at) values ('${CUST}', 'cust@shop.fj', now() - interval '3 days'), ('${STAFF}', 'me@riyeser.com', now()), ('${OTHER}', 'other@x.com', now());
    insert into admins values ('${STAFF}');
    insert into prices values ('pri_b', 'basics', 'Basics monthly', 'month', 2000, 'AUD'), ('pri_p', 'pos', 'POS yearly', 'year', 20000, 'AUD');
    insert into subscriptions (id, account_id, status, items, period_ends_at) values
      ('sub_1', '${CUST}', 'active', '[{"product":"basics","price":"pri_b","quantity":1}]', now() + interval '5 days'),
      ('sub_2', '${OTHER}', 'past_due', '[{"product":"pos","price":"pri_p","quantity":1}]', now() - interval '1 day');
    insert into payments (id, account_id, status, total, tax, currency, origin, billed_at) values
      ('txn_1', '${CUST}', 'completed', 2200, 200, 'AUD', 'web', now()), ('txn_2', '${OTHER}', 'completed', 22000, 2000, 'AUD', 'web', now() - interval '40 days');
    insert into devices (account_id, id, versions, usage) values
      ('${CUST}', 'pc1', '{"central":"1.4.0"}', '{"invoices":48,"pos_sales":450}'),
      ('${OTHER}', 'pc2', '{"central":"1.3.0"}', '{"invoices":45}');`);
  return db;
}
async function as(db, who, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${who}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

test('customers see only their own rows; settings and prices are public', async () => {
  const db = await setup();
  await as(db, CUST, async () => {
    assert.equal((await db.query('select * from subscriptions')).rows.length, 1);
    assert.equal((await db.query('select * from payments')).rows[0].id, 'txn_1');
    assert.equal((await db.query('select * from accounts')).rows.length, 1);
    assert.equal((await db.query('select * from webhook_events')).rows.length, 0);
    assert.equal((await db.query("select value from settings where key = 'caps'")).rows[0].value.basic, 50);
    await assert.rejects(db.query(`select admin_dashboard()`), /admins only/);
    // can't make themselves an admin or change the caps
    await assert.rejects(db.query(`insert into admins values ('${CUST}')`));
    const upd = await db.query(`update settings set value = '{"basic": 999999}' where key = 'caps' returning key`);
    assert.equal(upd.rows.length, 0);
  });
});

test('chats: customer writes, staff answer, internal notes stay internal', async () => {
  const db = await setup();
  const conv = await as(db, CUST, async () => {
    const c = (await db.query(`insert into conversations (account_id, subject) values ('${CUST}', 'Printing receipts') returning id`)).rows[0].id;
    // pretending to be staff is ignored
    await db.query(`insert into messages (conversation_id, body, from_staff, internal) values ($1, 'How do I print?', true, true)`, [c]);
    await assert.rejects(db.query(`insert into conversations (account_id) values ('${OTHER}')`)); // not for someone else
    return c;
  });
  await as(db, STAFF, async () => {
    const m = (await db.query('select * from messages')).rows;
    assert.equal(m.length, 1); assert.equal(m[0].from_staff, false); assert.equal(m[0].internal, false);
    assert.equal((await db.query('select unread_staff from conversations')).rows[0].unread_staff, true);
    await db.query(`insert into messages (conversation_id, body) values ($1, 'Setup → Printer. I will call you.')`, [conv]);
    await db.query(`insert into messages (conversation_id, body, internal) values ($1, 'Customer on old version 1.3, update first', true)`, [conv]);
    await db.query(`update conversations set unread_staff = false where id = $1`, [conv]);
  });
  await as(db, CUST, async () => {
    const m = (await db.query('select body, from_staff from messages order by id')).rows;
    assert.deepEqual(m.map((r) => r.from_staff), [false, true]); // the internal note is hidden
    assert.equal((await db.query('select unread_customer from conversations')).rows[0].unread_customer, true);
    await db.query(`update conversations set unread_customer = false where id = $1`, [conv]);
    await assert.rejects(db.query(`update conversations set status = 'closed' where id = $1`, [conv]), /not allowed/);
  });
  await as(db, OTHER, async () => {
    assert.equal((await db.query('select * from conversations')).rows.length, 0);
    assert.equal((await db.query('select * from messages')).rows.length, 0);
    await assert.rejects(db.query(`insert into messages (conversation_id, body) values ($1, 'hi')`, [conv]));
  });
});

test('admin dashboard: money, sign-ups, renewals, failed cards and who is near the cap', async () => {
  const db = await setup();
  const d = await as(db, STAFF, async () => (await db.query('select admin_dashboard(30) as d')).rows[0].d);
  assert.equal(d.kpis.mrrCents, 2000 + Math.round(20000 / 12));
  assert.equal(d.kpis.paying, 2); assert.equal(d.kpis.accounts, 3); assert.equal(d.kpis.pastDue, 1); assert.equal(d.kpis.activePcs, 2);
  assert.equal(d.signupsByDay.length, 30); assert.equal(d.signupsByDay.reduce((n, x) => n + x.n, 0), 3);
  assert.equal(d.revenueByMonth.length, 12); assert.equal(d.revenueByMonth.at(-1).cents, 2000);
  assert.equal(d.renewalsDue.length, 1); assert.equal(d.renewalsDue[0].email, 'cust@shop.fj');
  assert.equal(d.pastDueList[0].email, 'other@x.com');
  // cust pays for Basics, so only their POS count is a lead; other@ isn't paying for Basics (45 of 50 = 90%)
  assert.deepEqual(d.nearCap.map((n) => `${n.email} ${n.what}`).sort(), ['cust@shop.fj pos_sales', 'other@x.com invoices']);
  assert.equal(d.versions['central 1.4.0'], 1);
});
