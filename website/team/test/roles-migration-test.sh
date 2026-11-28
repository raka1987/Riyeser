#!/bin/bash
# Custom HQ roles: the migration keeps everyone's HQ permissions exactly as they were.
# On an empty PostgreSQL 16 database: supabase-stub.sql, then team-chat.sql from BEFORE custom roles (git commit
# BEFORE_REF, default 26cbd1ae), HQ staff with every built-in role and some per-person ticks, a snapshot of what each can do;
# then this branch's team-chat.sql twice. Every person must still be able to do exactly the same (the one new permission,
# "Email invoices and receipts", only for those who had licences.manage, which included it before: SEC-010). Then the Owner's
# change to a built-in role must survive running team-chat.sql again. Ends with ALL ROLE MIGRATION TESTS PASSED.
# Usage: PSQL="psql -h /dev/shm -p 5499 -U postgres" website/team/test/roles-migration-test.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
BEFORE_REF=${BEFORE_REF:-26cbd1ae}
DB=roles_mig_$$
TMP=$(mktemp -d)
trap '$PSQL -q -c "drop database if exists $DB" postgres >/dev/null 2>&1; rm -rf "$TMP"' EXIT
git show "$BEFORE_REF:website/team/team-chat.sql" > "$TMP/before.sql"
$PSQL -q -c "create database $DB" postgres
run() { PGOPTIONS="-c client_min_messages=warning" $PSQL -q -v ON_ERROR_STOP=1 -d $DB "$@" > /dev/null; }
run -f website/team/test/supabase-stub.sql
run -f "$TMP/before.sql"
run <<'SQL'
insert into auth.users (id, email) select ('f0f0f0f0-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'm' || i || '@riyeser.test' from generate_series(1, 12) i;
insert into public.hq_staff (user_id, display_name, role, perms_add, perms_remove, active) values
  ('f0f0f0f0-0000-4000-8000-000000000001', 'Owner', 'owner', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000002', 'Admin', 'admin', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000003', 'Finance', 'finance', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000004', 'Support', 'support', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000005', 'Senior', 'senior', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000006', 'Sales', 'sales', '{}', '{}', true),
  ('f0f0f0f0-0000-4000-8000-000000000007', 'Developer', 'developer', '{}', '{}', true),
  -- per-person ticks: extras, removals, licences.manage both ways, and someone switched off
  ('f0f0f0f0-0000-4000-8000-000000000008', 'Sales + licences', 'sales', array['licences.manage', 'audit.view'], array['offers.grant'], true),
  ('f0f0f0f0-0000-4000-8000-000000000009', 'Finance - licences', 'finance', '{}', array['licences.manage', 'refunds.pay'], true),
  ('f0f0f0f0-0000-4000-8000-000000000010', 'Support + level 2', 'support', array['support.level2', 'reports.view'], array['people.reset_2fa'], true),
  ('f0f0f0f0-0000-4000-8000-000000000011', 'Admin off', 'admin', array['business.close'], '{}', false),
  ('f0f0f0f0-0000-4000-8000-000000000012', 'Second owner', 'owner', array['audit.view'], array['staff.manage'], true);
create table public.mig_before as
  select s.user_id, s.role, (select array_agg(p order by p) from unnest(public.hq_staff_perms(s.user_id)) p) as perms from public.hq_staff s;
create table public.mig_roles_before as select r, (select array_agg(p order by p) from unnest(public.hq_role_perms(r)) p) as perms
  from unnest(array['owner', 'admin', 'finance', 'support', 'senior', 'sales', 'developer']) r;
SQL
run -f website/team/team-chat.sql
run -f website/team/team-chat.sql
run <<'SQL'
do $$ declare b record; now_ text[]; was text[]; begin
  for b in select * from public.mig_before loop
    now_ := (select array_agg(p order by p) from unnest(public.hq_staff_perms(b.user_id)) p);
    was := b.perms;
    -- the same, apart from invoices.email, which comes exactly with the licences.manage it used to be part of
    assert coalesce(array_remove(now_, 'invoices.email'), '{}') = coalesce(was, '{}'),
      format('%s (%s): was %s, now %s', b.user_id, b.role, was, now_);
    assert coalesce('invoices.email' = any(now_), false) = coalesce('licences.manage' = any(was), false), format('%s: invoices.email follows licences.manage', b.user_id);
  end loop;
  for b in select * from public.mig_roles_before loop
    assert array_remove((select array_agg(p order by p) from unnest(public.hq_role_perms(b.r)) p), 'invoices.email') = b.perms, 'role ' || b.r;
  end loop;
  assert (select count(*) from public.mig_before) = 12 and (select count(*) from public.hq_roles where builtin) = 7, 'everyone checked; seven built-in roles';
  -- the Owner changes a built-in role...
  delete from public.hq_role_permissions where role_key = 'sales' and perm = 'offers.grant';
  update public.hq_roles set description = 'Changed by the Owner' where key = 'sales';
end $$;
SQL
run -f website/team/team-chat.sql
run <<'SQL'
do $$ begin
  -- ...and running team-chat.sql again keeps it
  assert not 'offers.grant' = any(public.hq_role_perms('sales')) and (select description from public.hq_roles where key = 'sales') = 'Changed by the Owner', 'the Owner''s change is kept';
  assert (select count(*) from public.hq_staff where 'invoices.email' = any(perms_add)) = 1, 'the invoices.email extra was added once only';
end $$;
SQL
echo "ALL ROLE MIGRATION TESTS PASSED"
