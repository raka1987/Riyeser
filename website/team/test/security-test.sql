\set ON_ERROR_STOP on
-- Security and privacy tests (QA pass SEC-xxx). Run on an empty PostgreSQL 16 database: supabase-stub.sql, then
-- ../team-chat.sql, then this file. It ends with ALL SECURITY TESTS PASSED. Synthetic businesses and people only.
--   1. the database's own rules: row rules on every table, nothing for signed-out visitors, every SECURITY DEFINER
--      function pins its search_path, and a reviewed list of what signed-out visitors may run
--   2. another business (and someone in no business) calls EVERY function a signed-in person can run, with business
--      A's real ids: nothing of A comes back and nothing of A changes
--   3. Riyeser HQ: staff tools never read private chat, files, phone passwords or the online post box; each HQ role is
--      refused what it isn't allowed; without two-step sign-in nothing works
--   4. secrets: API key hashes, webhook secrets, relay keys and phone digests are never readable or returned
--   5. SEC-001 problem reports scrubbed of tokens, keys and user names; SEC-002 old call set-up messages removed
--   7. custom HQ roles: the hard limits can never be given (even by hand or direct RPC), no privilege escalation, the last Owner
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal2')::text, false); end $$;
create function pg_temp.as_user_aal1(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal1')::text, false); end $$;

-- ===== 1. The database's own rules
do $$ begin
  assert not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
    'every table has row rules: ' || (select string_agg(relname, ', ') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity);
  assert not exists (select 1 from information_schema.role_table_grants where table_schema in ('public', 'storage') and grantee in ('anon', 'PUBLIC')),
    'signed-out visitors have no table rights: ' || (select string_agg(distinct table_name, ', ') from information_schema.role_table_grants where table_schema in ('public', 'storage') and grantee in ('anon', 'PUBLIC'));
  assert not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
    'every SECURITY DEFINER function pins its search_path';
end $$;
-- What a signed-out visitor may run with the database's powers: each one reviewed (SEC-003). A new one fails here until it's reviewed.
do $$ declare extra text; begin
  select string_agg(p.proname, ', ' order by p.proname) into extra from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and p.proname not in ('guest_ticket', 'invite_info', 'track_install', 'track_visit', 'hq_record_downloads',
      'relay_enroll_claim', 'relay_leave', 'relay_sync', 'can_see_channel', 'is_admin', 'is_member', 'is_owner',
      'audit_change', 'ring_group_for_branch', 'ring_group_member_left',
      -- the free trial's anonymous PC record: one PC code's own dates only, earliest kept, rate-limited (trial guard)
      'pc_trial_seen');
  assert extra is null, 'unreviewed functions signed-out visitors can run: ' || extra;
end $$;

-- ===== Two businesses with private things in A
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_team('Sample Plumbing', 'Alex') as ws_a \gset
select invite_code as code_a from public.workspaces where id = :'ws_a' \gset
select id as gen_a from public.channels where workspace_id = :'ws_a' and name = 'general' \gset
insert into public.messages (channel_id, workspace_id, body) values (:'gen_a', :'ws_a', 'Morning team');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_team(:'code_a', 'Sam');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.open_dm(:'ws_a', '22222222-2222-2222-2222-222222222222') as dm_a \gset
insert into public.messages (channel_id, workspace_id, body) values (:'dm_a', :'ws_a', 'PRIVATE-DM pay rise approved');
select public.api_key_create(:'ws_a', 'Shop', 'secret', 'live', array['bookings:write'], '{}', '{}') as key_json \gset
select (:'key_json'::json ->> 'id') as key_a, (:'key_json'::json ->> 'key') as raw_key_a \gset
select public.api_webhook_create(:'ws_a', 'https://hooks.sample-plumbing.test/riyeser', array['booking.received'], 'live', 'Shop') as hook_json \gset
select (public.support_report(:'ws_a', '{"what_happened":"A problem","blocked":false,"log_lines":"A-LOG-LINE"}') ->> 'id') as ticket_a \gset
-- a PDF signing request in A (Riyeser PDF "Ask someone to sign"), sent, with its file in the private bucket
select (public.sign_request_create(:'ws_a', 'SIGN-DOC Lease for flat 4', 'SIGN-NOTE please sign', false, null, null,
  '[{"id":"s1","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.7,"w":0.3,"h":0.06}]', '[{"name":"Pat Signer","email":"pat.signer@client.test"}]') ->> 'id') as sign_a \gset
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'ws_a' || '/' || :'sign_a' || '/original.pdf', '{"size": 900}');
select public.sign_request_send(:'sign_a', repeat('a', 64), 900, 1);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.create_team('Corner Cafe', 'Kim') as ws_b \gset
reset role;
select set_config('test.ws_a', :'ws_a', false), set_config('test.ws_b', :'ws_b', false), set_config('test.raw_key', :'raw_key_a', false), set_config('test.ticket_a', :'ticket_a', false),
  set_config('test.hook', :'hook_json', false);

-- The calls: every function a signed-in person can run that takes an id, with A's real ids (a person, a chat, the private
-- chat, the key, the help request; A's business id for any other id) and harmless values for the rest.
create table pg_temp.ids (k text primary key, v text);
insert into pg_temp.ids values ('ws', :'ws_a'), ('person', '22222222-2222-2222-2222-222222222222'), ('channel', :'gen_a'), ('dm', :'dm_a'),
  ('key', :'key_a'), ('ticket', :'ticket_a'), ('signreq', :'sign_a');
create table pg_temp.out (who text, fn text, outcome text, result text);
grant select on pg_temp.ids to authenticated; grant insert, select on pg_temp.out to authenticated;
create function pg_temp.call_all(who text, name_re text, need_id boolean) returns void language plpgsql as $$
declare f record; a text; args text[]; i int; nm text; ty text; res text; ids jsonb := (select jsonb_object_agg(k, v) from pg_temp.ids);
begin
  for f in select p.oid, p.proname, p.proretset, coalesce(p.proargnames, '{}') names, p.proargtypes::oid[] types
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname ~ name_re
             and has_function_privilege(p.oid, 'execute') and p.prorettype <> 'trigger'::regtype
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
             and (not need_id or 'uuid'::regtype::oid = any (p.proargtypes::oid[])) order by p.proname loop
    args := '{}';
    for i in 1 .. coalesce(array_length(f.types, 1), 0) loop
      nm := lower(coalesce(f.names[i], '')); ty := format_type(f.types[array_lower(f.types, 1) + i - 1], null);
      a := case
        when ty = 'uuid' and nm ~ '(person|user|owner|staff|member|who|uid)' then quote_literal(ids ->> 'person') || '::uuid'
        when ty = 'uuid' and nm ~ '^(ch|channel|channel_id|chan)$' then quote_literal(ids ->> 'channel') || '::uuid'
        when ty = 'uuid' and nm ~ 'dm' then quote_literal(ids ->> 'dm') || '::uuid'
        when ty = 'uuid' and nm ~ 'key' then quote_literal(ids ->> 'key') || '::uuid'
        when ty = 'uuid' and nm ~ '(ticket|^t$)' then quote_literal(ids ->> 'ticket') || '::uuid'
        when ty = 'uuid' and nm ~ '^req' then quote_literal(ids ->> 'signreq') || '::uuid'
        when ty = 'uuid' then quote_literal(ids ->> 'ws') || '::uuid'
        when ty = 'uuid[]' then 'array[' || quote_literal(ids ->> 'person') || '::uuid]'
        when ty in ('integer', 'bigint', 'smallint', 'numeric') then '1'
        when ty = 'boolean' then 'true'
        when ty in ('jsonb', 'json') then quote_literal('{}') || '::' || ty
        when ty like '%[]' then quote_literal('{}') || '::' || ty
        when ty = 'date' then 'current_date'
        when ty like 'timestamp%' then 'now()'
        when ty = 'text' then quote_literal('x')
        else 'null::' || ty end;
      args := args || a;
    end loop;
    begin
      if f.proretset then
        execute format('select left(string_agg(x::text, '',''), 2000) from public.%I(%s) x', f.proname, array_to_string(args, ', ')) into res;
      else
        execute format('select left(public.%I(%s)::text, 2000)', f.proname, array_to_string(args, ', ')) into res;
      end if;
      insert into pg_temp.out values (who, f.proname, 'ran', res);
    exception when others then
      insert into pg_temp.out values (who, f.proname, 'refused', left(sqlerrm, 300));
    end;
  end loop;
end $$;
-- everything kept for business A, to prove nothing changed
create function pg_temp.digest(ws uuid) returns text language plpgsql as $$
declare t record; acc text := ''; part text; begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
           where c.table_schema = 'public' and c.column_name = 'workspace_id' and x.table_type = 'BASE TABLE' order by 1 loop
    execute format('select md5(coalesce(string_agg(r::text, ''|'' order by r::text), '''')) from public.%I r where workspace_id = $1', t.table_name) into part using ws;
    acc := acc || t.table_name || ':' || part || ';';
  end loop;
  execute 'select md5(coalesce(string_agg(r::text, ''|'' order by r::text), '''')) from public.workspaces r where id = $1' into part using ws;
  return md5(acc || part); end $$;
select pg_temp.digest(:'ws_a') as dig_a \gset
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$ begin
  if ok is not true then raise exception 'FAILED: %', what; end if; end $$;

-- ===== 2. Another business, and someone in no business, try everything on A
set statement_timeout = '10s';
set role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.call_all('B owner', '.', true);
select pg_temp.as_user('55555555-5555-5555-5555-555555555555');
select pg_temp.call_all('outsider', '.', true);
reset role;
reset statement_timeout;
do $$ declare bad text; n int; begin
  select count(*) into n from pg_temp.out;
  assert n > 300, 'the calls ran (' || n || ')';
  -- only these may answer at all, and they say nothing private: whether a business's Riyeser Link is on (calls_allowed),
  -- whether a person can be rung (link_rings: true/false), the size of a plan's file space (link_storage_limit), and
  -- "ignored" for an install count with a made-up id
  select string_agg(who || ' ' || fn || ' -> ' || coalesce(result, ''), '; ') into bad from pg_temp.out
   where outcome = 'ran' and coalesce(result, '') not in ('', '[]', '{}', 'false', '0', 'null', 'ignored')
     and not (fn in ('calls_allowed', 'link_rings') and result in ('true', 'false'))
     and not (fn = 'link_storage_limit' and result ~ '^[0-9]+$');
  assert bad is null, 'another business got something back from A: ' || bad;
  assert (select count(*) from pg_temp.out where fn ~ '^sign_request_' and outcome = 'refused' and result like 'That signing request isn''t yours%') >= 14
     and (select count(*) from pg_temp.out where fn in ('sign_quota', 'sign_requests_mine', 'sign_request_create') and outcome = 'refused') = 6,
    'every signing request function was tried on A''s request and refused';
  assert not exists (select 1 from pg_temp.out where result like '%PRIVATE-DM%' or result like '%Morning team%' or result like '%A-LOG-LINE%'
                     or result like '%Sample Plumbing%' or result like '%' || current_setting('test.raw_key') || '%'
                     or result like '%SIGN-%' or result like '%pat.signer%'), 'nothing of A in any answer (signing requests included)';
end $$;
select pg_temp.check(pg_temp.digest(:'ws_a') = :'dig_a', 'nothing of A changed');
-- and the tables themselves: B sees no row of A anywhere it is allowed to look
set role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ declare t record; n int; bad text := ''; begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
           where c.table_schema = 'public' and c.column_name = 'workspace_id' and x.table_type = 'BASE TABLE'
             and case when c.table_schema = 'public' then has_table_privilege(format('public.%I', c.table_name), 'select') end order by 1 loop
    execute format('select count(*) from public.%I where workspace_id = $1', t.table_name) into n using current_setting('test.ws_a')::uuid;
    if n > 0 then bad := bad || t.table_name || ' '; end if;
  end loop;
  assert bad = '', 'B reads A''s rows in: ' || bad;
  assert (select count(*) from public.workspaces where id = current_setting('test.ws_a')::uuid) = 0, 'B can''t see A';
  -- and B can't write into A's tables directly
  begin insert into public.channels (workspace_id, name, kind, created_by) values (current_setting('test.ws_a')::uuid, 'x', 'channel', auth.uid());
    raise exception 'B made a channel in A'; exception when insufficient_privilege then null; end;
  begin insert into public.branches (workspace_id, name) values (current_setting('test.ws_a')::uuid, 'x');
    raise exception 'B made a branch in A'; exception when insufficient_privilege or not_null_violation then null; end;
  update public.workspaces set name = 'hacked' where id = current_setting('test.ws_a')::uuid;
  update public.messages set body = 'hacked' where workspace_id = current_setting('test.ws_a')::uuid;
  delete from public.members where workspace_id = current_setting('test.ws_a')::uuid;
end $$;
-- staff (not an admin) and an owner without two-step sign-in can't use admin powers
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin
  assert not public.is_admin(current_setting('test.ws_a')::uuid), 'staff isn''t an admin';
  begin perform public.api_keys_list(current_setting('test.ws_a')::uuid); raise exception 'staff listed API keys';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.set_role(current_setting('test.ws_a')::uuid, auth.uid(), 'admin'); raise exception 'staff made themself admin';
  exception when others then assert sqlerrm like 'Only the team''s owner or an admin%', sqlerrm; end;
  begin update public.members set role = 'owner' where user_id = auth.uid(); raise exception 'staff changed their own role';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert (select role from public.members where user_id = '22222222-2222-2222-2222-222222222222') = 'member', 'staff still a member'; end $$;
set role authenticated;
select pg_temp.as_user_aal1('11111111-1111-1111-1111-111111111111');
do $$ begin
  assert not public.is_admin(current_setting('test.ws_a')::uuid) and not public.is_owner(current_setting('test.ws_a')::uuid), 'no admin powers without the code';
  begin perform public.api_keys_list(current_setting('test.ws_a')::uuid); raise exception 'owner without 2FA listed API keys';
  exception when others then assert sqlerrm like '%two-step sign-in%', sqlerrm; end;
end $$;
reset role;
select pg_temp.check(pg_temp.digest(:'ws_a') = :'dig_a', 'B''s direct writes changed nothing of A');

-- ===== 4. Secrets are never readable or returned
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ declare r text; t text; begin
  foreach t in array array['api_keys', 'api_webhooks', 'link_relay_devices', 'relay_servers', 'relay_cluster', 'relay_enrollments', 'hq_settings', 'link_office_reveals'] loop
    begin execute format('select count(*) from public.%I', t); if t <> 'link_office_reveals' then raise exception 'the owner read %', t; end if;
    exception when insufficient_privilege then null; end;
  end loop;
  r := public.api_keys_list(current_setting('test.ws_a')::uuid)::text;
  assert r like '%Shop%' and r not like '%key_hash%' and r not like '%' || current_setting('test.raw_key') || '%'
     and r not like '%' || encode(sha256(convert_to(current_setting('test.raw_key'), 'UTF8')), 'hex') || '%', 'keys list: name, never the key or its hash';
  r := public.api_webhooks_list(current_setting('test.ws_a')::uuid)::text;
  assert r like '%whsec_…%' and r not like '%' || (current_setting('test.hook')::json ->> 'secret') || '%', 'webhooks list: only the last 4 of the secret';
end $$;
reset role;
do $$ begin
  assert (select key_hash from public.api_keys limit 1) ~ '^[0-9a-f]{64}$' and not exists (select 1 from public.api_keys where key_hash = current_setting('test.raw_key')),
    'only a SHA-256 of the API key is kept';
  assert not exists (select 1 from public.audit_log where details::text like '%' || current_setting('test.raw_key') || '%'), 'the key isn''t in the history';
end $$;

-- ===== 3. Riyeser HQ
-- no HQ function reads private chat, reactions, files, call set-up, phone passwords, remote phones or the online post box
-- (deleting is allowed: hq_remove_accounts for the owner-approved removal of closed accounts, and the daily sweep)
do $$ declare bad text; begin
  select string_agg(p.proname, ', ') into bad from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^hq_' and p.proname <> 'hq_remove_accounts'
    and p.prosrc ~* '((?<!delete )from|join)\s+(public\.)?(messages|channel_members|message_reactions|channel_pins|reads|call_signals|link_office_reveals|link_relay_devices|api_inbox|api_catalog|api_stock|api_staff|api_open_times|api_requests|storage\.objects|sign_requests|sign_signers|sign_events|email_outbox[^;]*body_text)\M';
  assert bad is null, 'HQ functions that read private customer data: ' || bad;
  -- every HQ function checks the HQ role itself
  select string_agg(p.proname, ', ') into bad from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^hq_'
    and has_function_privilege('authenticated', p.oid, 'execute') and p.prorettype <> 'trigger'::regtype
    and p.prosrc !~ '(hq_need\(|hq_fix_start\(|hq_can\()'
    and p.proname not in ('hq_me', 'hq_record_downloads', 'hq_set_calls_paid',
      'hq_touch');   -- reviewed (HQ V2): checks HQ staff and two-step sign-in itself, and only keeps your own session going
  assert bad is null, 'HQ functions without a role check: ' || bad;
end $$;
insert into auth.users (id, email) values ('c0c0c0c0-0000-4000-8000-000000000001', 'hq-support@riyeser.test'), ('c0c0c0c0-0000-4000-8000-000000000002', 'hq-dev@riyeser.test'),
  ('c0c0c0c0-0000-4000-8000-000000000003', 'hq-sales@riyeser.test'), ('c0c0c0c0-0000-4000-8000-000000000004', 'hq-finance@riyeser.test'),
  ('c0c0c0c0-0000-4000-8000-000000000005', 'hq-owner@riyeser.test'), ('c0c0c0c0-0000-4000-8000-000000000006', 'hq-admin@riyeser.test');
insert into public.hq_staff (user_id, display_name, role) values ('c0c0c0c0-0000-4000-8000-000000000001', 'Sup', 'support'),
  ('c0c0c0c0-0000-4000-8000-000000000002', 'Dev', 'developer'), ('c0c0c0c0-0000-4000-8000-000000000003', 'Sal', 'sales'),
  ('c0c0c0c0-0000-4000-8000-000000000004', 'Fin', 'finance'), ('c0c0c0c0-0000-4000-8000-000000000005', 'Own', 'owner'),
  ('c0c0c0c0-0000-4000-8000-000000000006', 'Adm', 'admin');
truncate pg_temp.out;
set statement_timeout = '10s';
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); select pg_temp.call_all('support', '^hq_', false);
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002'); select pg_temp.call_all('developer', '^hq_', false);
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000003'); select pg_temp.call_all('sales', '^hq_', false);
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000004'); select pg_temp.call_all('finance', '^hq_', false);
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000006'); select pg_temp.call_all('admin', '^hq_', false);
select pg_temp.as_user_aal1('c0c0c0c0-0000-4000-8000-000000000005'); select pg_temp.call_all('owner without 2FA', '^hq_', false);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); select pg_temp.call_all('customer', '^hq_', false);
-- the HQ owner (every permission) on everything that only looks, with A's ids: for the password/secret check below
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
select pg_temp.call_all('HQ owner', '^hq_(company|companies|companies_page|business_list|ticket|tickets|support_inbox|emails|licences|billing|company_billing|company_link|company_page|company_licence|diagnostic|overview|history|audit_search|staff_list|team|handover|work_queue|attention|reports|signups|refunds|approvals|me|my_follow_ups|saved_replies|get_settings|payments_received|inactive_accounts|dup_check|dup_search|downloads|real_downloads|traffic|licence_businesses)$', false);
reset role;
reset statement_timeout;
create function pg_temp.refused(who text, fns text[]) returns text language sql as $$
  select string_agg(f, ', ') from unnest(fns) f
  where exists (select 1 from pg_temp.out o where o.who = refused.who and o.fn = f and (o.outcome = 'ran' or o.result not like 'Your HQ role can''t do that.%'))
     or not exists (select 1 from pg_temp.out o where o.who = refused.who and o.fn = f) $$;
do $$ declare bad text; begin
  -- developers: versions, downloads and diagnostics only; no customers, tickets, emails, licences, billing or history
  bad := pg_temp.refused('developer', array['hq_company', 'hq_companies', 'hq_company_page', 'hq_business_list', 'hq_tickets', 'hq_ticket',
    'hq_support_inbox', 'hq_emails', 'hq_licences', 'hq_billing', 'hq_company_billing', 'hq_payments_received', 'hq_refunds', 'hq_audit_search',
    'hq_history', 'hq_reset_2fa', 'hq_change_owner', 'hq_edit_business', 'hq_set_module', 'hq_message_customer', 'hq_company_link']);
  assert bad is null, 'developer not refused: ' || bad;
  -- support: no money (refund decisions/payments, plans, marking paid, billing details), staff, settings, history or removals
  bad := pg_temp.refused('support', array['hq_refund_decide', 'hq_refund_paid', 'hq_refund_second', 'hq_set_plan', 'hq_set_module',
    'hq_billing_mark_paid', 'hq_set_billing_entity', 'hq_set_staff', 'hq_set_staff_perms', 'hq_add_staff', 'hq_set_setting', 'hq_audit_search',
    'hq_history', 'hq_remove_accounts', 'hq_change_owner', 'hq_close_duplicate', 'hq_grant_storage', 'hq_billing_resend', 'hq_billing_entity_decide']);
  assert bad is null, 'support not refused: ' || bad;
  -- sales: no diagnostics, help-request replies, refunds, emails, 2FA resets, edits or history
  bad := pg_temp.refused('sales', array['hq_billing_resend', 'hq_billing_entity_decide', 'hq_diagnostic', 'hq_ticket_reply', 'hq_message_customer', 'hq_refunds', 'hq_emails', 'hq_reset_2fa',
    'hq_edit_business', 'hq_change_owner', 'hq_audit_search', 'hq_set_module', 'hq_set_staff']);
  assert bad is null, 'sales not refused: ' || bad;
  -- finance: no diagnostics, account fix-ups, staff, or Riyeser's own bank details (only the HQ Owner: SEC-011)
  bad := pg_temp.refused('finance', array['hq_diagnostic', 'hq_reset_2fa', 'hq_change_owner', 'hq_edit_business', 'hq_set_staff', 'hq_set_billing_entity']);
  assert bad is null, 'finance not refused: ' || bad;
  -- admin (HQ V2): runs the team, settings and history, but no money, no licences or billing, no bank details (SEC-011),
  -- no emailing invoices (SEC-010), no diagnostics or customer fix-ups, no removing accounts
  bad := pg_temp.refused('admin', array['hq_licences', 'hq_billing', 'hq_company_billing', 'hq_payments_received', 'hq_refunds', 'hq_refund_decide',
    'hq_refund_paid', 'hq_refund_second', 'hq_set_plan', 'hq_set_module', 'hq_quick_licence', 'hq_billing_mark_paid', 'hq_set_billing_entity',
    'hq_billing_resend', 'hq_diagnostic', 'hq_reset_2fa', 'hq_change_owner', 'hq_edit_business', 'hq_grant_offer', 'hq_ticket_reply', 'hq_remove_accounts']);
  assert bad is null, 'admin not refused: ' || bad;
  -- the HQ owner without two-step sign-in, and a customer: nothing at all (hq_me only says who you are)
  select string_agg(fn, ', ') into bad from pg_temp.out where who in ('owner without 2FA', 'customer') and fn not in ('hq_me')
    and (outcome = 'ran' or result not in ('Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.', 'Not allowed'));
  assert bad is null, 'HQ worked without two-step sign-in or for a customer: ' || bad;
  -- and no HQ answer, for any role, carries A's private chat or log of its own, or anything of a document sent for signing
  assert not exists (select 1 from pg_temp.out where result like '%PRIVATE-DM%' or result like '%Morning team%'), 'HQ answers never include chat';
  -- (HQ's Emails page shows each email's address and subject, as for every email; subjects never name the document)
  assert not exists (select 1 from pg_temp.out where result like '%SIGN-DOC%' or result like '%SIGN-NOTE%' or result like '%sign-docs%' or result like '%sign/?t=%'),
    'HQ answers never include a document sent for signing, its message, its file or a signing link';
end $$;
-- The owner's rule: support can trigger a reset but never sees, sets or receives any password or secret. No HQ answer (for
-- any role, including the HQ owner looking at A's business, PCs, phones, billing, tickets and emails), and no HQ function's
-- columns, carries a password, secret, key, token, digest or sealed copy; nor A's real API key or webhook secret.
do $$ declare bad text; begin
  select string_agg(distinct who || ' ' || fn, ', ') into bad from pg_temp.out where outcome = 'ran'
    and result ~* '"[a-z_]*(password|passwd|pwd|secret|sealed|ha1|key_hash|sync_key|api_key|token|private_key)[a-z_]*"\s*:'
    and result !~* '"(can_[a-z_]*|[a-z_]*_set|bank_ready)"';
  assert bad is null, 'HQ answers with a password or secret field: ' || bad;
  assert not exists (select 1 from pg_temp.out where strpos(coalesce(result, ''), current_setting('test.raw_key')) > 0
                     or strpos(coalesce(result, ''), current_setting('test.hook')::json ->> 'secret') > 0), 'no HQ answer has A''s API key or webhook secret';
  select string_agg(p.proname || '.' || a, ', ') into bad from pg_proc p, unnest(coalesce(p.proargnames, '{}')) a
   where p.pronamespace = 'public'::regnamespace and p.proname ~ '^hq_' and a ~* '(password|passwd|secret|sealed|ha1|key_hash|sync_key|token)'
     and p.proname not in ('hq_record_downloads', 'hq_set_ingest_token');   -- the download counter's own sign-in token (GitHub job), hashed at once
  assert bad is null, 'HQ functions with a password/secret column or argument: ' || bad;
  assert (select count(*) from pg_temp.out where who = 'HQ owner' and outcome = 'ran') >= 20, 'the HQ owner''s look-only calls ran';
end $$;
-- every HQ look at a customer is in the locked HQ history
do $$ begin
  assert exists (select 1 from public.hq_audit where action = 'customer.viewed'), 'viewing a customer is recorded';
  begin delete from public.hq_audit; raise exception 'HQ history deleted'; exception when others then assert sqlerrm not like 'HQ history deleted', sqlerrm; end;
end $$;

-- ===== 5. SEC-001: problem reports keep no passwords, tokens, keys or user names
set role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select (public.support_report(:'ws_a', jsonb_build_object('product', 'linkoffice', 'what_happened', 'Phones offline', 'blocked', false,
  'error_text', 'Sign-in failed: Authorization: Bearer abcdefgh12345678',
  'log_lines', E'10:00 GET https://api.example.test/v1?access_token=abc123secretvalue&x=1\n'
    || E'10:01 client_secret: shhh-1234\n10:02 SIP_PASSWORD=hunter2\n10:03 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZw\n'
    || E'10:04 key rk_' || 'live_' || repeat('0123456789abcdef', 3) || E' in config\n10:05 ENOENT open ''C:\\Users\\JaneCitizen\\AppData\\Local\\Temp\\x.exe''\n'
    || E'10:06 ftp://bob:pw1@files.example.test/backup\n10:07 Extension 101 connected from 192.168.1.20 (Yealink T46U)\n10:08 version 1.9.0 on 2026-11-28 pass=letmein'))
  ->> 'diag_id') as sec_diag \gset
reset role;
select log_lines as sec_log, error_text as sec_err from public.support_diagnostics where id = :'sec_diag' \gset
select set_config('test.sec_log', :'sec_log', false), set_config('test.sec_err', :'sec_err', false);
do $$ declare l text := current_setting('test.sec_log'); e text := current_setting('test.sec_err'); s text; begin
  foreach s in array array['abc123secretvalue', 'shhh-1234', 'hunter2', 'eyJhbGci', 'live_0123', 'JaneCitizen', 'bob:pw1', 'letmein', 'abcdefgh12345678'] loop
    assert strpos(l, s) = 0 and strpos(e, s) = 0, 'scrubbed: ' || s || ' in ' || l || ' / ' || e;
  end loop;
  assert strpos(l, 'C:\Users\[user]\AppData') > 0, 'the user name in a folder path is replaced: ' || l;
  assert l like '%connected from 192.168.1.20 (Yealink T46U)%' and l like '%version 1.9.0 on 2026-11-28%', 'technical details kept: ' || l;
  assert public.support_scrub('printer at a@b.test') = 'printer at a***@b.test', 'emails masked as before';
  assert public.support_scrub('password=hunter2 sent') = 'password [removed]', 'anything after "password" removed as before';
  assert public.support_scrub('tax 12 345 678 901 ok') = 'tax [number removed] ok', 'long numbers as before';
end $$;

-- ===== 5. SEC-002: call set-up messages are removed by the daily sweep once a day old
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
insert into public.call_signals (workspace_id, call_id, to_user, kind, payload)
  values (:'ws_a', gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'offer', '{"sdp":"c=IN IP4 203.0.113.7"}');
reset role;
update public.call_signals set created_at = now() - interval '2 days';
insert into public.call_signals (workspace_id, call_id, from_user, to_user, kind) values (:'ws_a', gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'ring');
do $$ declare r json; begin
  r := public.hq_traffic_sweep();
  assert (r ->> 'call_signals_removed')::int = 1, 'one old set-up message removed: ' || r::text;
  assert (select count(*) from public.call_signals) = 1, 'today''s is kept';
  r := public.hq_traffic_sweep();
  assert (r ->> 'call_signals_removed')::int = 0, 'safe to repeat';
end $$;

-- ===== SEC-004: a staff member with a linked PC can't act as another office's Riyeser Link Office
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.link_office_report(:'ws_a', 'office-front-0001', '{"pc_name":"FRONT-DESK","version":"1.0.0","state":"running","extensions":[{"extension":"101"}]}');
select public.link_command(:'ws_a', 'office-front-0001', 'new_password', '{"extension":"101"}') as office_cmd \gset
select set_config('test.office_cmd', :'office_cmd', false);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.link_device(:'ws_a', 'e5e5e5e5-0000-4000-8000-000000000001', 'SAMS-LAPTOP', 'win32', '1.9.0');
do $$ begin
  begin perform public.link_office_pending(current_setting('test.ws_a')::uuid, 'office-front-0001'); raise exception 'staff read the office''s changes';
  exception when others then assert sqlerrm like 'Sign in to Riyeser Link Office%', sqlerrm; end;
  begin perform public.link_office_done(current_setting('test.office_cmd')::uuid, true, null, null); raise exception 'staff answered the office''s change';
  exception when others then assert sqlerrm like 'That change isn''t for this business%', sqlerrm; end;
  begin perform public.link_office_report(current_setting('test.ws_a')::uuid, 'office-front-0001', '{"pc_name":"FAKE","state":"running"}'); raise exception 'staff reported as the office';
  exception when others then assert sqlerrm like 'Sign in to Riyeser Link Office%', sqlerrm; end;
  begin perform public.link_relay_token(current_setting('test.ws_a')::uuid, 'office-front-0001'); raise exception 'staff took the office''s relay pass';
  exception when others then assert sqlerrm like 'Sign in as the business''s owner or an admin%', sqlerrm; end;
  begin perform public.link_relay_report(current_setting('test.ws_a')::uuid, 'office-front-0001', '{"state":"connected"}'); raise exception 'staff reported the relay';
  exception when others then assert sqlerrm = 'Not allowed.', sqlerrm; end;
  -- their own (new) office still works, as before
  assert (public.link_office_report(current_setting('test.ws_a')::uuid, 'office-back-0002', '{"pc_name":"BACK-ROOM","state":"running"}') ->> 'ok')::boolean, 'a new office of their own';
  assert json_array_length(public.link_office_pending(current_setting('test.ws_a')::uuid, 'office-back-0002')) = 0, 'and its changes';
end $$;
reset role;
do $$ begin
  assert (select status from public.link_office_commands where id = current_setting('test.office_cmd')::uuid) = 'pending', 'the owner''s change is still waiting for the real office';
  assert (select pc_name from public.link_offices where office_id = 'office-front-0001') = 'FRONT-DESK', 'the office''s report unchanged';
end $$;
-- the owner (any owner or admin) can still act for every office; and an office whose reporter left can be taken over
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  assert json_array_length(public.link_office_pending(current_setting('test.ws_a')::uuid, 'office-back-0002')) = 0, 'owner polls the staff member''s office';
end $$;
reset role;
delete from public.members where workspace_id = :'ws_a' and user_id = '22222222-2222-2222-2222-222222222222';
update public.link_offices set reported_by = '22222222-2222-2222-2222-222222222222' where office_id = 'office-front-0001';
insert into public.members (workspace_id, user_id, display_name, role) values (:'ws_a', '44444444-4444-4444-4444-444444444444', 'Jordan', 'member');
insert into public.devices (id, workspace_id, user_id, device_name, platform) values (gen_random_uuid(), :'ws_a', '44444444-4444-4444-4444-444444444444', 'FRONT-DESK', 'win32');
set role authenticated;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
do $$ begin
  assert json_array_length(public.link_office_pending(current_setting('test.ws_a')::uuid, 'office-front-0001')) = 1, 'the reporter left: the new person''s PC takes over';
end $$;
reset role;

-- ===== SEC-009: Riyeser support (with the customer's "Let Riyeser help") can ask for a new phone password, never see one
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.link_support_allow(:'ws_a');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare c uuid; begin
  begin perform public.link_command(current_setting('test.ws_a')::uuid, 'office-front-0001', 'reveal_password',
      jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('D', 342), 'e', 'AQAB')));
    raise exception 'support asked to see a phone password';
  exception when others then assert sqlerrm like 'Riyeser support can''t see phone passwords%', sqlerrm; end;
  c := public.link_command(current_setting('test.ws_a')::uuid, 'office-front-0001', 'new_password', '{"extension":"101","password":"Typed-By-Support-1"}');
  perform set_config('test.hq_newpw', c::text, false);
  assert public.link_command_state(c)::text !~* '(password|sealed)"\s*:', 'support follows it: no password field';
end $$;
-- the office (the owner's Link Office) makes the password itself and says only "done"
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.link_office_done(current_setting('test.hq_newpw')::uuid, true, null, 'U2VhbGVkLWNvcHk=');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin
  assert public.link_command_state(current_setting('test.hq_newpw')::uuid) ->> 'status' = 'done', 'done';
  begin perform public.link_reveal_take(current_setting('test.hq_newpw')::uuid); raise exception 'support took a password';
  exception when others then assert sqlerrm like 'There''s no password waiting for you%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert (select data from public.link_office_commands where id = current_setting('test.hq_newpw')::uuid) = '{"extension": "101"}'::jsonb, 'nothing support typed reaches the office';
  assert not exists (select 1 from public.link_office_reveals where command_id = current_setting('test.hq_newpw')::uuid), 'no password copy kept';
  assert exists (select 1 from public.hq_audit where action = 'link.new_password' and actor = 'c0c0c0c0-0000-4000-8000-000000000001'
                 and workspace_id = current_setting('test.ws_a')::uuid), '"password reset requested by" Sup, in the HQ history';
  assert exists (select 1 from public.audit_log where action = 'link.new_password' and details ->> 'by' = 'Riyeser support'), 'and in the customer''s';
  -- no history, HQ history or email holds a password, secret or key (names of fields, or A's real values)
  assert not exists (select 1 from public.hq_audit where details::text ~* '"[a-z_]*(password|secret|sealed|ha1|key_hash|token)[a-z_]*"\s*:'
                     or details::text like '%Typed-By-Support-1%'), 'HQ history: no password or secret';
  assert not exists (select 1 from public.audit_log where details::text ~* '"[a-z_]*(password|secret|sealed|ha1|key_hash|token)[a-z_]*"\s*:'
                     or details::text like '%Typed-By-Support-1%' or strpos(details::text, current_setting('test.raw_key')) > 0), 'customer history: no password or secret';
  assert not exists (select 1 from public.email_outbox where strpos(coalesce(body_text, '') || coalesce(subject, ''), current_setting('test.raw_key')) > 0
                     or strpos(coalesce(body_text, ''), current_setting('test.hook')::json ->> 'secret') > 0 or body_text like '%Typed-By-Support-1%'), 'no email holds a key, secret or password';
end $$;

-- ===== PDF signing requests: only the sender and the signers (their own links); never HQ, the business's admins or others
do $$ declare bad text; begin
  -- the bucket's rules name only the sign_ checks (nothing for HQ), and nobody signed in or out can run the page's functions
  select string_agg(polname, ', ') into bad from pg_policy where polname like 'sign_docs%' and pg_get_expr(polqual, polrelid) || coalesce(pg_get_expr(polwithcheck, polrelid), '') ~ 'hq_';
  assert bad is null, 'the sign-docs rules let HQ in: ' || bad;
  select string_agg(p.proname, ', ') into bad from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^sign_(pub|do)_'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  assert bad is null, 'the signing page''s functions are open to visitors or signed-in people: ' || bad;
  assert not exists (select 1 from information_schema.role_table_grants where table_name in ('sign_requests', 'sign_signers', 'sign_events', 'sign_rate')
    and grantee in ('anon', 'authenticated', 'PUBLIC')), 'nobody reads the signing tables directly';
  assert (select token_hash from public.sign_signers where email = 'pat.signer@client.test') ~ '^[0-9a-f]{64}$', 'only the link''s SHA-256 is kept';
end $$;
-- HQ staff (every role, with two-step sign-in) can't read the file through the bucket either
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'sign-docs') = 0, 'the HQ owner can''t read a document sent for signing'; end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'sign-docs') = 0, 'support can''t read a document sent for signing'; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin assert (select count(*) from storage.objects where bucket_id = 'sign-docs') = 1, 'the sender can'; end $$;
-- ===== Trial guard: Riyeser online's anonymous PC record (pc_trials) and the HQ ticket's Trial history
reset role;
select set_config('test.pc1', repeat('a1', 32), false), set_config('test.pc2', repeat('b2', 32), false);
set role anon;
select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false);
do $$ declare r json; pc1 text := current_setting('test.pc1'); pc2 text := current_setting('test.pc2'); begin
  -- the table can't be read or written by signed-out visitors, only through pc_trial_seen
  begin perform count(*) from public.pc_trials; raise exception 'anon read pc_trials'; exception when insufficient_privilege then null; end;
  begin insert into public.pc_trials (pc_id, program, trial_start) values (pc1, 'suite', '2025-01-01'); raise exception 'anon wrote pc_trials';
  exception when insufficient_privilege then null; end;
  r := public.pc_trial_seen(pc1, 'suite', '2026-09-03T09:00:00Z', 'Central 1.9.0');
  assert (r ->> 'trial_start')::timestamptz = '2026-09-03T09:00:00Z', 'registered';
  assert (select array_agg(k order by k) from json_object_keys(r) k) = array['extra_days', 'first_seen', 'last_seen', 'program', 'trial_start'], 'only dates come back: ' || r::text;
  -- never moved later; an earlier one (a restored company file) wins
  r := public.pc_trial_seen(pc1, 'suite', '2026-11-20T00:00:00Z', null);
  assert (r ->> 'trial_start')::timestamptz = '2026-09-03T09:00:00Z', 'a later date never moves it later';
  r := public.pc_trial_seen(pc1, 'suite', '2026-08-01T00:00:00Z', null);
  assert (r ->> 'trial_start')::timestamptz = '2026-08-01T00:00:00Z', 'the earlier date wins';
  r := public.pc_trial_seen(pc1, 'suite', null, null);
  assert (r ->> 'trial_start')::timestamptz = '2026-08-01T00:00:00Z', 'look-up only';
  -- only that PC's dates: another PC code gets its own (or nothing), never pc1's
  r := public.pc_trial_seen(pc2, 'suite', null, null);
  assert r ->> 'trial_start' is null, 'a new PC: nothing, and nothing made';
  r := public.pc_trial_seen(pc2, 'suite', now() + interval '30 days', null);
  assert (r ->> 'trial_start')::timestamptz <= now() + interval '1 minute', 'a date in the future isn''t believed';
  assert (r ->> 'trial_start')::timestamptz > '2026-08-02', 'pc2 has its own date, not pc1''s';
  r := public.pc_trial_seen(pc1, 'estimate', null, null);
  assert r ->> 'trial_start' is null, 'per program: no Estimate trial started by a look-up';
  r := public.pc_trial_seen(pc2, 'suite', '1999-01-01', null);
  assert (r ->> 'trial_start')::timestamptz > '2024-01-01', 'a date before Riyeser''s trials isn''t believed';
  begin perform public.pc_trial_seen('ABC', 'suite', now(), null); raise exception 'a bad PC code was taken';
  exception when others then assert sqlerrm like 'That PC code isn''t right%', sqlerrm; end;
  begin perform public.pc_trial_seen(pc1, 'payroll; drop', now(), null); raise exception 'a bad program was taken';
  exception when others then assert sqlerrm like 'Unknown program%', sqlerrm; end;
end $$;
-- rate limits: 20 an hour per PC code (each call its own transaction, as over the internet)
do $$ declare i int; n int := 0; begin
  for i in 1 .. 25 loop
    begin perform public.pc_trial_seen(repeat('c3', 32), 'suite', '2026-10-01', null); n := n + 1;
    exception when others then assert sqlerrm like 'Too many requests%', sqlerrm; end;
  end loop;
  assert n = 20, 'per-PC limit: ' || n;
end $$;
reset role;   -- (request_client_ip is only for the database's own functions)
-- SEC-017: the client address is Cloudflare's CF-Connecting-IP, else the LAST X-Forwarded-For entry, never the first (a caller writes that)
do $$ begin
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.7, 203.0.113.9"}', true);
  assert public.request_client_ip() = '203.0.113.9', 'the last hop, not the spoofable first entry: ' || coalesce(public.request_client_ip(), 'null');
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.7, 203.0.113.9","cf-connecting-ip":"192.0.2.44"}', true);
  assert public.request_client_ip() = '192.0.2.44', 'CF-Connecting-IP first';
  perform set_config('request.headers', '{"x-forwarded-for":"not-an-ip"}', true);
  assert public.request_client_ip() is null, 'rubbish: no address';
end $$;
reset role;
-- signed-in people can't read the table either
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  begin perform count(*) from public.pc_trials; raise exception 'a customer read pc_trials'; exception when insufficient_privilege then null; end;
end $$;
-- a ticket with Central's report, including the trial record (and things that must be dropped)
select (public.support_report(:'ws_a', json_build_object('what_happened', 'My trial ended early', 'blocked', false, 'source', 'central',
  'trial', json_build_object('pc_id', current_setting('test.pc1'), 'latest_seen', '2026-11-20T00:00:00.000Z', 'clock_back', true, 'installs', 3,
    'machine_guid', 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f', 'user', 'C:\Users\alex\AppData',
    'programs', json_build_array(json_build_object('program', 'suite', 'start', '2026-08-01T00:00:00.000Z', 'ends', '2026-10-30T00:00:00.000Z', 'days_left', 0,
      'sources', json_build_object('licence_json', '2026-11-01T00:00:00.000Z', 'registry', '2026-08-01T00:00:00.000Z', 'company_file', 'C:\Users\alex\Books.db', 'online', '2026-08-01T00:00:00.000Z')),
      json_build_object('program', 'evil', 'start', '2026-08-01T00:00:00.000Z'))))::jsonb) ->> 'id') as ticket_t \gset
reset role;
select set_config('test.ticket_t', :'ticket_t', false);
do $$ declare t jsonb; begin
  select d.trial into t from public.support_diagnostics d join public.support_tickets x on x.diag_id = d.id where x.id = current_setting('test.ticket_t')::uuid;
  assert t ->> 'pc_id' = current_setting('test.pc1') and (t ->> 'installs')::int = 3 and (t ->> 'clock_back')::boolean, 'the trial record is kept: ' || t::text;
  assert t::text !~* '(machine_guid|f0e1d2c3|alex|Users|evil)', 'no MachineGuid, user names, paths or unknown programs: ' || t::text;
  assert t #>> '{programs,0,sources,company_file}' is null and t #>> '{programs,0,sources,registry}' = '2026-08-01T00:00:00.000Z', 'only dates as sources';
  assert public.support_scrub(t #>> '{programs,0,start}') = t #>> '{programs,0,start}', 'dates pass support_scrub unchanged';
end $$;
set role authenticated;
-- support (trials.view) sees it, with the online record for that PC only; it's in the HQ history
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare r json; begin
  assert (public.hq_ticket(current_setting('test.ticket_t')::uuid) ->> 'trial') = 'yes', 'the ticket says it has a trial record';
  r := public.hq_ticket_trial(current_setting('test.ticket_t')::uuid);
  assert r #>> '{report,pc_id}' = current_setting('test.pc1'), 'the report';
  assert json_array_length(r -> 'online') = 1 and (r #>> '{online,0,trial_start}')::timestamptz = '2026-08-01T00:00:00Z', 'that PC''s online record only: ' || (r -> 'online')::text;
  assert r::text not like '%' || current_setting('test.pc2') || '%', 'never another PC''s';
  assert r -> 'business' -> 'payroll' ->> 'status' is not null, 'the signed-in business''s server trial dates';
  assert not (r ->> 'can_extend')::boolean, 'support can''t extend';
  begin perform public.hq_trial_extend(current_setting('test.ticket_t')::uuid, 'suite', 14, 'Goodwill: ended early'); raise exception 'support extended a trial';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
  -- nothing without a ticket, or a ticket whose report has no trial record
  begin perform public.hq_ticket_trial(gen_random_uuid()); raise exception 'a trial with no ticket';
  exception when others then assert sqlerrm like 'That ticket doesn''t exist%', sqlerrm; end;
  begin perform public.hq_ticket_trial(current_setting('test.ticket_a')::uuid); raise exception 'a trial from a report without one';
  exception when others then assert sqlerrm like 'This ticket has no diagnostic report with a free-trial record%', sqlerrm; end;
end $$;
-- no other role: developer and sales (no trials.view) are refused; the ticket only says "hidden"
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.hq_ticket_trial(current_setting('test.ticket_t')::uuid); raise exception 'a developer saw a trial';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
  begin perform public.hq_trial_pcs(); raise exception 'a developer counted trial PCs'; exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000003');
do $$ begin
  assert (public.hq_ticket(current_setting('test.ticket_t')::uuid) ->> 'trial') = 'hidden', 'sales: hidden';
  begin perform public.hq_ticket_trial(current_setting('test.ticket_t')::uuid); raise exception 'sales saw a trial';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  begin perform public.hq_ticket_trial(current_setting('test.ticket_t')::uuid); raise exception 'a customer saw HQ''s trial history';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff%', sqlerrm; end;
end $$;
-- finance (licences.manage) extends it as a goodwill gesture, with a reason; the counts never show a PC code
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000004');
do $$ declare r json; c text; begin
  assert (public.hq_ticket_trial(current_setting('test.ticket_t')::uuid) ->> 'can_extend')::boolean, 'finance can extend';
  begin perform public.hq_trial_extend(current_setting('test.ticket_t')::uuid, 'suite', 14, ''); raise exception 'no reason';
  exception when others then assert sqlerrm like 'Say why%', sqlerrm; end;
  begin perform public.hq_trial_extend(current_setting('test.ticket_t')::uuid, 'suite', 400, 'Too many'); raise exception 'too many days';
  exception when others then assert sqlerrm like 'Choose between 1 and 90 days%', sqlerrm; end;
  r := public.hq_trial_extend(current_setting('test.ticket_t')::uuid, 'suite', 14, 'Goodwill: trial ended early');
  assert (r ->> 'extra_days')::int = 14 and (r ->> 'trial_start')::timestamptz = '2026-08-01T00:00:00Z', 'extended, the start unchanged: ' || r::text;
  c := public.hq_trial_pcs()::text;
  assert c like '%"program" : "suite"%' and c not like '%' || current_setting('test.pc1') || '%' and c !~ '[0-9a-f]{64}', 'counts only: ' || c;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.hq_audit where action = 'trial.viewed' and actor = 'c0c0c0c0-0000-4000-8000-000000000001'), 'each look is in the HQ history';
  assert exists (select 1 from public.hq_audit where action = 'trial.extended' and details ->> 'reason' = 'Goodwill: trial ended early'
    and (details ->> 'days')::int = 14 and length(details ->> 'pc') = 8), 'the extension is in the HQ history (a short PC code only)';
  assert (select extra_days from public.pc_trials where pc_id = current_setting('test.pc1') and program = 'suite') = 14, 'kept for the PC';
end $$;
-- the PC picks the extension up the next time it's online; the date still never moves later
set role anon;
do $$ declare r json; begin
  r := public.pc_trial_seen(current_setting('test.pc1'), 'suite', '2026-11-01T00:00:00Z', null);
  assert (r ->> 'extra_days')::int = 14 and (r ->> 'trial_start')::timestamptz = '2026-08-01T00:00:00Z', 'the PC gets +14 days: ' || r::text;
end $$;
reset role;   -- (the trial guard checks above end as a signed-out visitor)
-- ===== 6. HQ V2 first slice: the Admin role, staff emails, Finance's ticket levels, HQ sessions, job records
do $$ begin
  assert not ('support.level2' = any(public.hq_role_perms('finance'))) and not ('support.level3' = any(public.hq_role_perms('finance'))), 'finance: no level 2/3 tickets';
  assert 'staff.manage' = any(public.hq_role_perms('admin')) and not ('licences.view' = any(public.hq_role_perms('admin')))
     and not ('refunds.view' = any(public.hq_role_perms('admin'))) and not ('support.diagnostics' = any(public.hq_role_perms('admin'))), 'admin defaults';
end $$;
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000006');
do $$ declare t json; begin
  -- an admin can't make an owner or another admin, can't change an owner, and can't tick on a permission it doesn't have
  begin perform public.hq_add_staff('hq-sales@riyeser.test', 'Sal', 'admin'); raise exception 'admin made an admin';
  exception when others then assert sqlerrm like 'Only an HQ owner can make an owner or an admin.%', sqlerrm; end;
  begin perform public.hq_add_staff('hq-owner@riyeser.test', 'Own', 'support'); raise exception 'admin demoted the owner';
  exception when others then assert sqlerrm like 'Only an HQ owner can change an owner or an admin.%', sqlerrm; end;
  begin perform public.hq_set_staff('c0c0c0c0-0000-4000-8000-000000000005', 'support', true); raise exception 'admin changed the owner';
  exception when others then assert sqlerrm like 'Only an HQ owner can make or change%', sqlerrm; end;
  -- (custom roles: an admin may tick permissions for people now, but never one it doesn't have itself)
  begin perform public.hq_set_staff_perms('c0c0c0c0-0000-4000-8000-000000000003', array['licences.manage'], '{}'); raise exception 'admin ticked a permission';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (licences.manage)%', sqlerrm; end;
  begin perform public.hq_set_staff('c0c0c0c0-0000-4000-8000-000000000006', 'owner', true); raise exception 'admin made itself owner';
  exception when others then assert sqlerrm like 'You can''t change your own HQ access%', sqlerrm; end;
  -- ...but can run the rest of the team, and sees everyone's email (it manages the team)
  perform public.hq_set_staff('c0c0c0c0-0000-4000-8000-000000000003', 'sales', true);
  t := public.hq_team();
  assert (select count(*) from json_array_elements(t -> 'staff') x where x ->> 'email' is not null) = (select count(*) from json_array_elements(t -> 'staff')), 'admin sees staff emails';
end $$;
-- staff emails: only for whoever manages the team (and your own)
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare t json; begin
  t := public.hq_team();
  assert (select count(*) from json_array_elements(t -> 'staff') x where x ->> 'email' is not null) = 1
     and (select x ->> 'email' from json_array_elements(t -> 'staff') x where x ->> 'email' is not null) = 'hq-support@riyeser.test', 'support sees only its own email';
  assert (select count(*) from public.hq_staff_list() l where l.email is not null) = 1, 'staff list: only your own email';
end $$;
-- HQ sessions (owner's decision): 30 minutes without activity, or 12 hours after signing in, and the session has ended
create function pg_temp.as_session(u text, sid text, signed_in timestamptz) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal2', 'session_id', sid,
    'amr', json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from signed_in)::bigint),
                            json_build_object('method', 'password', 'timestamp', extract(epoch from signed_in)::bigint - 20)))::text, false); end $$;
-- signed in an hour ago and never used HQ since: already ended (30 minutes without activity)
select pg_temp.as_session('c0c0c0c0-0000-4000-8000-000000000001', 'sess-unused', now() - interval '1 hour');
do $$ begin assert public.hq_touch() ->> 'ended' = 'idle', 'unused for an hour'; end $$;
select pg_temp.as_session('c0c0c0c0-0000-4000-8000-000000000001', 'sess-fresh', now() - interval '10 minutes');
do $$ declare r json; begin
  r := public.hq_touch(); assert (r ->> 'ok')::boolean and (r ->> 'timed')::boolean, 'a fresh session is kept going: ' || r::text;
  perform public.hq_overview();                                         -- works
end $$;
reset role;
update public.hq_sessions set last_seen_at = now() - interval '31 minutes' where session_id = 'sess-fresh';
set role authenticated;
do $$ declare r json; begin
  begin perform public.hq_overview(); raise exception 'idle session still worked';
  exception when others then assert sqlerrm like 'Your HQ session has ended%', sqlerrm; end;
  r := public.hq_touch(); assert not (r ->> 'ok')::boolean and r ->> 'ended' = 'idle', 'an idle session isn''t brought back: ' || r::text;
  begin perform public.hq_work_queue(); raise exception 'idle session read the work queue';
  exception when others then assert sqlerrm like 'Your HQ session has ended%', sqlerrm; end;
end $$;
select pg_temp.as_session('c0c0c0c0-0000-4000-8000-000000000005', 'sess-old', now() - interval '12 hours 5 minutes');
do $$ declare r json; begin
  r := public.hq_touch(); assert not (r ->> 'ok')::boolean and r ->> 'ended' = 'max', '12 hours after signing in: ' || r::text;
  begin perform public.hq_team(); raise exception '12-hour session still worked';
  exception when others then assert sqlerrm like 'Your HQ session has ended%', sqlerrm; end;
  begin perform public.hq_set_billing_entity('{"name":"Riyeser"}'); raise exception 'owner changed bank details after 12 hours';
  exception when others then assert sqlerrm like 'Your HQ session has ended%' or sqlerrm like 'Your HQ role can''t do that%', sqlerrm; end;
end $$;
-- a customer (not HQ staff) gets nothing from hq_touch; the session rows can't be read by anyone signed in
select pg_temp.as_session('22222222-2222-2222-2222-222222222222', 'sess-fresh', now());
do $$ begin begin perform public.hq_touch(); raise exception 'customer touched';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff%', sqlerrm; end; end $$;
do $$ begin begin perform 1 from public.hq_sessions; raise exception 'sessions readable'; exception when insufficient_privilege then null; end; end $$;
-- backup and restore-test records: only the jobs (the database owner) write them; ops.view reads them
do $$ begin begin perform public.ops_record_run('backup', 'team', true, now(), '{}', null); raise exception 'website recorded a backup';
  exception when insufficient_privilege then null; end; end $$;
reset role;
select public.ops_record_run('backup', 'team', true, now() - interval '3 minutes', '{"bytes": 1234, "secret": "nope", "fingerprint": "ab12"}', 'https://github.com/x/y/actions/runs/1');
select public.ops_record_run('restore_drill', 'team', false, now(), '{"rows_backup": 10, "rows_restored": 9}', null);
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002');   -- developer: ops.view
do $$ declare r json; begin
  r := public.hq_ops_runs();
  assert json_array_length(r) = 2 and r::text not like '%nope%' and r::text like '%fingerprint%', 'runs: latest per job, secrets dropped: ' || r::text;
  assert (select (x ->> 'ok')::boolean from json_array_elements(r) x where x ->> 'job' = 'restore_drill') = false, 'a failed drill shows failed';
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000003');   -- sales: no ops.view
do $$ begin begin perform public.hq_ops_runs(); raise exception 'sales read job runs';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end; end $$;
reset role;

-- ===== 7. Custom HQ roles: what can never be given, no privilege escalation, the last Owner, two-step sign-in
-- (owner's request "give the option for admin to select roles"; owner's decision: a standard role, then tick or untick)
-- the hard limits aren't permissions at all, and the database refuses them even when someone writes the tables by hand
do $$ declare p text; begin
  assert not exists (select 1 from unnest(public.hq_all_perms()) q where public.hq_is_never_perm(q)),
    'no HQ permission is a password, secret, bank details, owner or two-step one';
  foreach p in array public.hq_never_perms() || array['sip.password_view', 'billing.bank_edit', 'owner.promote', 'support.secrets', 'two_step.skip'] loop
    assert public.hq_is_never_perm(p), 'never: ' || p;
    begin insert into public.hq_role_permissions values ('support', p); raise exception 'stored % in a role', p;
    exception when check_violation then null; end;
    begin update public.hq_staff set perms_add = array[p] where user_id = 'c0c0c0c0-0000-4000-8000-000000000001'; raise exception 'stored % for a person', p;
    exception when others then assert sqlerrm like 'That can never be given to anyone%', sqlerrm; end;
  end loop;
  begin insert into public.hq_role_permissions values ('support', 'made.up'); raise exception 'unknown permission stored';
  exception when check_violation then null; end;
  begin insert into public.hq_role_permissions values ('owner', 'overview.view'); raise exception 'ticks stored for the Owner role';
  exception when check_violation then null; end;
  begin delete from public.hq_roles where key = 'finance'; raise exception 'built-in role removed';
  exception when others then assert sqlerrm like 'Built-in HQ roles can''t be removed%', sqlerrm; end;
  begin update public.hq_roles set builtin = false where key = 'support'; raise exception 'built-in role made custom';
  exception when others then assert sqlerrm like 'Built-in HQ roles stay built in%', sqlerrm; end;
end $$;
-- ...and nobody can give them through any HQ function, the Owner included (direct RPC calls)
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ declare p text; begin
  foreach p in array array['passwords.view', 'sip_passwords.view', 'secrets.view', 'billing.bank_details', 'bank_details.manage',
      'owner.make', 'staff.make_owner', 'two_step.bypass', 'mfa.bypass', 'link.sip_password'] loop
    begin perform public.hq_role_save(null, 'Never ' || p, '', array['overview.view', p]); raise exception 'role with %', p;
    exception when others then assert sqlerrm like 'That can never be given to anyone (' || p || ')%', sqlerrm; end;
    begin perform public.hq_role_save('support', 'Support', '', array['overview.view', p]); raise exception 'support role with %', p;
    exception when others then assert sqlerrm like 'That can never be given to anyone%', sqlerrm; end;
    begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000001', 'support', array['overview.view', p]); raise exception 'person with %', p;
    exception when others then assert sqlerrm like 'That can never be given to anyone%', sqlerrm; end;
    begin perform public.hq_set_staff_perms('c0c0c0c0-0000-4000-8000-000000000001', array[p], null); raise exception 'extra %', p;
    exception when others then assert sqlerrm like 'That can never be given to anyone%', sqlerrm; end;
  end loop;
  -- the Owner role always has everything and can't be changed (nobody locks every Owner out)
  begin perform public.hq_role_save('owner', 'Owner', '', array['overview.view']); raise exception 'owner role changed';
  exception when others then assert sqlerrm like 'The Owner role always has every permission%', sqlerrm; end;
  -- a custom role with every permission there is, given to Sales: still no bank details, no making an Owner, no passwords
  perform set_config('test.allrole', public.hq_role_save(null, 'Everything but Owner', 'Every permission HQ has', array(select json_array_elements_text(public.hq_team() -> 'all'))), false);
  perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000003', current_setting('test.allrole'), null);
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000003');
do $$ begin
  assert (public.hq_me() ->> 'role_name') = 'Everything but Owner' and json_array_length(public.hq_me() -> 'perms') = json_array_length(public.hq_team() -> 'all'), 'every permission';
  begin perform public.hq_set_billing_entity('{"name":"Riyeser","bank_account":"00-0000"}'); raise exception 'changed bank details';
  exception when others then assert sqlerrm like '%Only the Riyeser HQ Owner%' or sqlerrm like 'Your HQ role can''t do that%', sqlerrm; end;
  begin perform public.hq_add_staff('hq-dev@riyeser.test', 'Dev', 'owner'); raise exception 'made an owner';
  exception when others then assert sqlerrm like 'Only an HQ owner can make an owner%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'owner', null); raise exception 'made an owner (access)';
  exception when others then assert sqlerrm like 'Only an HQ owner can make or change an owner%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000005', 'support', null); raise exception 'changed the owner';
  exception when others then assert sqlerrm like 'Only an HQ owner can make or change an owner%', sqlerrm; end;
  begin perform public.link_command(current_setting('test.ws_a')::uuid, 'office-front-0001', 'reveal_password',
      jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('D', 342), 'e', 'AQAB')));
    raise exception 'saw a phone password';
  exception when others then assert sqlerrm like 'Riyeser support can''t see phone passwords%', sqlerrm; end;
  -- and can't change its own access, or its own role
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000003', 'sales', null); raise exception 'changed own access';
  exception when others then assert sqlerrm like 'You can''t change your own HQ access%', sqlerrm; end;
  begin perform public.hq_role_save(current_setting('test.allrole'), 'Everything but Owner', '', '{}'); raise exception 'changed own role';
  exception when others then assert sqlerrm like 'You can''t change the role you have yourself%', sqlerrm; end;
end $$;
-- two-step sign-in can't be got around: the same person without it gets nothing at all
select pg_temp.as_user_aal1('c0c0c0c0-0000-4000-8000-000000000003');
do $$ begin
  begin perform public.hq_team(); raise exception 'HQ without two-step sign-in';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.%', sqlerrm; end;
  assert not (public.hq_me() ->> 'two_step')::boolean, 'hq_me says two-step sign-in is still needed';
  begin perform public.hq_role_save(null, 'Sneaky', '', array['overview.view']); raise exception 'made a role without two-step sign-in';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'support', null); raise exception 'changed access without two-step sign-in';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.%', sqlerrm; end;
end $$;
-- no privilege escalation: an admin (staff.manage, no money) can't give anything it doesn't have, through any function
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000006');
do $$ declare k text; begin
  begin perform public.hq_role_save(null, 'Money helper', '', array['overview.view', 'licences.manage']); raise exception 'role beyond admin';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (licences.manage)%', sqlerrm; end;
  begin perform public.hq_role_save('support', 'Support', '', array(select json_array_elements_text(public.hq_team() -> 'roles' -> 'support')) || array['refunds.approve']); raise exception 'support role beyond admin';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (refunds.approve)%', sqlerrm; end;
  begin perform public.hq_role_save('admin', 'Admin', '', array['overview.view']); raise exception 'admin changed the Admin role';
  exception when others then assert sqlerrm like 'Only the HQ Owner can change the Owner and Admin roles%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'developer', array['overview.view', 'refunds.pay']); raise exception 'extra beyond admin';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (refunds.pay)%', sqlerrm; end;
  begin perform public.hq_set_staff_perms('c0c0c0c0-0000-4000-8000-000000000002', array['audit.view', 'licences.view'], null); raise exception 'old extras beyond admin';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (licences.view)%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'finance', null); raise exception 'gave finance';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself%' or sqlerrm like 'Only the HQ Owner can give%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', current_setting('test.allrole'), null); raise exception 'gave everything';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself%' or sqlerrm like 'Only the HQ Owner can give%', sqlerrm; end;
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000006', 'admin', array['overview.view', 'licences.view']); raise exception 'admin raised itself';
  exception when others then assert sqlerrm like 'You can''t change your own HQ access%', sqlerrm; end;
  -- SEC-010: emailing invoices only from the Owner, never from an admin, even in a role it may otherwise change
  begin perform public.hq_role_save(null, 'Mailer', '', array['overview.view', 'invoices.email']); raise exception 'admin gave invoices.email';
  exception when others then assert sqlerrm like 'Only the HQ Owner can give "Email invoices and receipts"%', sqlerrm; end;
  begin perform public.hq_set_staff_perms('c0c0c0c0-0000-4000-8000-000000000002', array['invoices.email'], null); raise exception 'admin ticked invoices.email';
  exception when others then assert sqlerrm like 'Only the HQ Owner can give "Email invoices and receipts"%', sqlerrm; end;
  -- ...what it has itself it may give: a role inside its own permissions, given to the developer; taking away is allowed
  k := public.hq_role_save(null, 'Team helper', 'Looks after HQ history and emails', array['overview.view', 'audit.view', 'emails.view', 'ops.view']);
  perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', k, array['overview.view', 'audit.view', 'ops.view']);
  -- ...but it can't put them back to Developer: that has diagnostics, which the admin doesn't (the Owner does that below)
  begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'developer', null); raise exception 'admin gave diagnostics';
  exception when others then assert sqlerrm like 'You can only give permissions you have yourself (support.diagnostics)%', sqlerrm; end;
  -- taking away from someone with more (Everything -> Sales) is allowed, and switching them off
  perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000003', 'sales', null);
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin
  -- the Owner may give emailing invoices in a custom role (SEC-010: "unless the Owner explicitly grants it")
  perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000001', 'support', array(select json_array_elements_text(public.hq_team() -> 'roles' -> 'support')) || array['invoices.email']);
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare p jsonb := public.hq_me()::jsonb -> 'perms'; begin
  assert p ? 'invoices.email' and not p ? 'licences.manage' and (public.hq_me() ->> 'customised')::boolean, 'support can email invoices because the Owner said so';
  begin perform public.hq_billing_resend('RR-0', null, false); raise exception 'no such doc';
  exception when others then assert sqlerrm like 'There''s no invoice or receipt with that number%', sqlerrm; end;   -- past the permission check
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000001', 'support', null); end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin assert not (public.hq_me()::jsonb -> 'perms') ? 'invoices.email', 'back to standard: no emailing invoices';
  begin perform public.hq_billing_resend('RR-0', null, false); raise exception 'support emailed an invoice';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that%', sqlerrm; end; end $$;
-- the last Owner keeps full access: not by hand, not through HQ
reset role;
do $$ begin
  assert (select role from public.hq_staff where user_id = 'c0c0c0c0-0000-4000-8000-000000000003') = 'sales', 'sales again';
  begin update public.hq_staff set active = false where user_id = 'c0c0c0c0-0000-4000-8000-000000000005'; raise exception 'last owner switched off';
  exception when others then assert sqlerrm like 'At least one HQ Owner must keep full access%', sqlerrm; end;
  begin update public.hq_staff set role = 'admin' where user_id = 'c0c0c0c0-0000-4000-8000-000000000005'; raise exception 'last owner demoted';
  exception when others then assert sqlerrm like 'At least one HQ Owner must keep full access%', sqlerrm; end;
  begin delete from public.hq_staff where user_id = 'c0c0c0c0-0000-4000-8000-000000000005'; raise exception 'last owner removed';
  exception when others then assert sqlerrm like 'At least one HQ Owner must keep full access%', sqlerrm; end;
  begin update public.hq_staff set perms_remove = array['staff.manage'] where user_id = 'c0c0c0c0-0000-4000-8000-000000000005';
    assert 'staff.manage' = any(public.hq_staff_perms('c0c0c0c0-0000-4000-8000-000000000005')), 'an Owner''s ticks can''t be taken away';
    update public.hq_staff set perms_remove = '{}' where user_id = 'c0c0c0c0-0000-4000-8000-000000000005'; end;
end $$;
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin
  perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'owner', null);   -- a second Owner
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002');
do $$ begin
  perform public.hq_set_staff('c0c0c0c0-0000-4000-8000-000000000005', 'owner', false);       -- the other Owner may switch the first off
end $$;
reset role;
do $$ begin
  begin update public.hq_staff set role = 'developer' where user_id = 'c0c0c0c0-0000-4000-8000-000000000002'; raise exception 'now-last owner demoted';
  exception when others then assert sqlerrm like 'At least one HQ Owner must keep full access%', sqlerrm; end;
end $$;
set role authenticated;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002');
do $$ begin perform public.hq_set_staff('c0c0c0c0-0000-4000-8000-000000000005', 'owner', true); end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin perform public.hq_set_staff_access('c0c0c0c0-0000-4000-8000-000000000002', 'developer', null); end $$;
reset role;
do $$ begin
  assert (select count(*) from public.hq_staff where role = 'owner' and active) = 1, 'one Owner again';
  -- every change above is in the HQ history with before and after
  assert (select count(*) from public.hq_audit where action = 'staff.access' and details ? 'before' and details ? 'after'
          and details -> 'before' ? 'perms' and details -> 'after' ? 'perms') >= 6, 'access changes with before and after';
  assert exists (select 1 from public.hq_audit where action = 'role.created' and details ->> 'name' = 'Team helper' and actor = 'c0c0c0c0-0000-4000-8000-000000000006'), 'role created, by whom';
  assert not exists (select 1 from public.hq_audit where action like 'role.%' and details::text like '%@%'), 'no email addresses in the role history';
end $$;

select 'ALL SECURITY TESTS PASSED' as result;
