\set ON_ERROR_STOP on
-- PDF signing requests (Riyeser PDF "Ask someone to sign"). Run on an empty PostgreSQL 16 database: supabase-stub.sql,
-- then ../team-chat.sql (twice is fine), then this file. It ends with ALL SIGNING TESTS PASSED. Synthetic people only.
--   the sender only (not staff, not the owner of the business, not another business, not HQ), the bucket's rules,
--   only a SHA-256 of each link is kept, the order of signing, finishing, declining, cancelling, reminders (a new link,
--   the old one stops), expiry, the monthly free quota (an HQ setting), the public endpoints' rate limits, the
--   clean-up of files, the audit trail that can't be changed, and the signed-out / signed-in roles can't run sign_pub_*.
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal2')::text, false); end $$;
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$ begin
  if ok is not true then raise exception 'FAILED: %', what; end if; end $$;
-- the raw token in the newest email to this address (only the outbox has it, until it's sent)
create function pg_temp.link_for(addr text) returns text language sql as $$
  select substring(body_text from 'riyeser\.com/sign/\?t=([0-9a-f]+)') from public.email_outbox
  where to_address = addr and body_text ~ 'riyeser\.com/sign/\?t=' order by id desc limit 1 $$;
create function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.h(text) to service_role, authenticated;
grant delete on storage.objects to authenticated;
insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'left@a.test');

set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_team('Sample Plumbing', 'Alex') as ws_a \gset
select invite_code as code_a from public.workspaces where id = :'ws_a' \gset
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); select public.join_team(:'code_a', 'Sam');
select pg_temp.as_user('66666666-6666-6666-6666-666666666666'); select public.join_team(:'code_a', 'Lee');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.create_team('Corner Cafe', 'Kim') as ws_b \gset

-- ===== the sender makes a request: two signers in order, fields for each
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check((public.sign_quota(:'ws_a') ->> 'used')::int = 0 and (public.sign_quota(:'ws_a') ->> 'limit')::int = 10, 'quota: 0 of 10 to start');
select pg_temp.check((public.sign_settings() ->> 'keep_days')::int = 365 and (public.sign_settings() ->> 'expiry_days')::int = 30, 'defaults: keep 1 year, links 30 days');
select public.sign_request_create(:'ws_a', 'Service agreement', 'Please sign by Friday.', true, null, null,
  '[{"id":"s1","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.7,"w":0.3,"h":0.06},{"id":"d1","kind":"date","signer":1,"page":1,"x":0.5,"y":0.7,"w":0.2,"h":0.04},
    {"id":"s2","kind":"signature","signer":2,"page":2,"x":0.1,"y":0.7,"w":0.3,"h":0.06},{"id":"n2","kind":"name","signer":2,"page":2,"x":0.5,"y":0.7,"w":0.3,"h":0.04},
    {"id":"i2","kind":"initials","signer":2,"page":1,"x":0.85,"y":0.9,"w":0.1,"h":0.05}]',
  '[{"name":"Pat Client","email":"pat@client.test"},{"name":"Jo Witness","email":"Jo@Witness.test"}]') as req1_json \gset
select (:'req1_json'::json ->> 'id') as req1, (:'req1_json'::json ->> 'path') as path1 \gset
select pg_temp.check(:'path1' = :'ws_a' || '/' || :'req1' || '/original.pdf', 'the upload path is <business>/<request>/original.pdf');
-- refused: bad emails, the same email twice, a signer with no field, a field off the page, a bad end date, too many signers
do $$ declare ws uuid := (select id from public.workspaces where name = 'Sample Plumbing'); f text := '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]'; begin
  begin perform public.sign_request_create(ws, 'X', null, false, null, null, f::jsonb, '[{"name":"A","email":"not-an-email"}]'); raise exception 'bad email';
  exception when others then assert sqlerrm like 'Check the email address for A%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, null, null, '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05},{"id":"b","kind":"signature","signer":2,"page":1,"x":0.1,"y":0.3,"w":0.2,"h":0.05}]',
    '[{"name":"A","email":"a@x.test"},{"name":"B","email":"A@x.test"}]'); raise exception 'same email';
  exception when others then assert sqlerrm like 'Each signer needs their own email%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, null, null, f::jsonb, '[{"name":"A","email":"a@x.test"},{"name":"B","email":"b@x.test"}]'); raise exception 'no field';
  exception when others then assert sqlerrm like 'Place at least one field for B%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, null, null, '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.9,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"A","email":"a@x.test"}]'); raise exception 'off page';
  exception when others then assert sqlerrm like 'One of the fields isn''t right%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, now() + interval '2 years', null, f::jsonb, '[{"name":"A","email":"a@x.test"}]'); raise exception 'end date';
  exception when others then assert sqlerrm like 'Choose an end date%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, null, 7, f::jsonb, '[{"name":"A","email":"a@x.test"}]'); raise exception 'keep';
  exception when others then assert sqlerrm like 'Choose how long to keep the files%', sqlerrm; end;
  begin perform public.sign_request_create(ws, 'X', null, false, null, null, f::jsonb, (select jsonb_agg(jsonb_build_object('name', 'P' || i, 'email', 'p' || i || '@x.test')) from generate_series(1, 11) i));
    raise exception 'eleven signers'; exception when others then assert sqlerrm like 'Up to 10 people can sign%', sqlerrm; end;
end $$;

-- ===== the bucket: only this draft's sender can upload, at exactly its path, once
reset role;
select pg_temp.check((select public from storage.buckets where id = 'sign-docs') = false and (select allowed_mime_types from storage.buckets where id = 'sign-docs') = array['application/pdf'],
  'the sign-docs bucket is private and PDF only');
set role authenticated;
select set_config('test.path1', :'path1', false), set_config('test.ws_a', :'ws_a', false), set_config('test.req1', :'req1', false), set_config('test.ws_b', :'ws_b', false);
set role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', current_setting('test.path1'), '{"size": 100}');
  raise exception 'staff of the same business uploaded the sender''s file';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', current_setting('test.path1'), '{"size": 100}');
  raise exception 'another business uploaded';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', current_setting('test.ws_a') || '/' || current_setting('test.req1') || '/other.pdf', '{"size": 100}');
  raise exception 'uploaded somewhere else';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.sign_request_send(current_setting('test.req1')::uuid, repeat('a', 64), 1000, 2);
  raise exception 'sent before the upload';
exception when others then assert sqlerrm like 'The PDF hasn''t finished uploading%', sqlerrm; end $$;
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'path1', '{"size": 1000}');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'sign-docs') = 1, 'the sender can read their own file');
do $$ begin
  perform public.sign_request_send(current_setting('test.req1')::uuid, repeat('a', 64), 1000, 1);
  raise exception 'a field on page 2 of a 1-page PDF';
exception when others then assert sqlerrm like 'A field is on a page the PDF doesn''t have%', sqlerrm; end $$;
select public.sign_request_send(:'req1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, 2);
do $$ begin
  insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', current_setting('test.path1') || '2', '{"size": 100}');
  raise exception 'uploaded after sending';
exception when insufficient_privilege then null; end $$;
select pg_temp.check((public.sign_quota(:'ws_a') ->> 'used')::int = 1, 'quota: 1 used');

-- ===== only the sender sees it: not staff, not another business, not someone who left
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select pg_temp.check(public.sign_requests_mine(:'ws_a')::text = '[]', 'staff in the same business see none of the owner''s requests');
select pg_temp.check((select count(*) from storage.objects where bucket_id = 'sign-docs') = 0, 'staff can''t read the file');
do $$ begin
  begin perform public.sign_request_history(current_setting('test.req1')::uuid); raise exception 'staff read the history';
  exception when others then assert sqlerrm like 'That signing request isn''t yours%', sqlerrm; end;
  begin perform public.sign_request_cancel(current_setting('test.req1')::uuid); raise exception 'staff cancelled';
  exception when others then assert sqlerrm like 'That signing request isn''t yours%', sqlerrm; end;
  begin perform count(*) from public.sign_requests; raise exception 'read the table';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.sign_signers; raise exception 'read the signers';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  begin perform public.sign_requests_mine(current_setting('test.ws_a')::uuid); raise exception 'B listed A';
  exception when others then assert sqlerrm like 'You''re not in that business%', sqlerrm; end;
  begin perform public.sign_quota(current_setting('test.ws_a')::uuid); raise exception 'B read A''s quota';
  exception when others then assert sqlerrm like 'You''re not in that business%', sqlerrm; end;
  begin perform public.sign_request_file(current_setting('test.req1')::uuid); raise exception 'B found the file';
  exception when others then assert sqlerrm like 'That signing request isn''t yours%', sqlerrm; end;
  assert (select count(*) from storage.objects where bucket_id = 'sign-docs') = 0, 'B can''t read the file';
end $$;
-- nobody signed in can run the public page's functions; signed-out visitors can't either
do $$ begin
  begin perform public.sign_pub_open(repeat('a', 64), '203.0.113.9', null, 'x'); raise exception 'a signed-in person ran sign_pub_open';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.sign_pub_finish(repeat('a', 64), '1.1.1.1', null, 'x', '{}', true, 'drawn', null); raise exception 'anon ran sign_pub_finish';
  exception when insufficient_privilege then null; end;
  begin perform public.sign_request_create(gen_random_uuid(), 'x', null, false, null, null, '[]', '[]'); raise exception 'anon made a request';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== links: only a SHA-256 is kept; the first signer only (in order)
select pg_temp.link_for('pat@client.test') as tok1 \gset
select pg_temp.check(length(:'tok1') = 64, 'the email has a 64-character link');
select pg_temp.check((select token_hash from public.sign_signers where email = 'pat@client.test') = pg_temp.h(:'tok1'), 'the signer row keeps the SHA-256 of the link');
select pg_temp.check(not exists (select 1 from public.sign_signers s where s.token_hash = :'tok1' or s::text like '%' || :'tok1' || '%')
  and not exists (select 1 from public.sign_events e where e::text like '%' || :'tok1' || '%')
  and not exists (select 1 from public.sign_requests r where r::text like '%' || :'tok1' || '%'), 'the link itself is in no signing table');
select pg_temp.check((select token_hash from public.sign_signers where email = 'jo@witness.test') is null
  and (select status from public.sign_signers where email = 'jo@witness.test') = 'waiting', 'in order: the second signer has no link yet');
select pg_temp.check((select count(*) from public.email_outbox where template = 'sign.request') = 1, 'one email so far');
select pg_temp.check((select subject from public.email_outbox where template = 'sign.request') = 'Please sign a document from Sample Plumbing'
  and (select body_text from public.email_outbox where template = 'sign.request') like '%Alex at Sample Plumbing has asked you to sign "Service agreement"%'
  and (select body_text from public.email_outbox where template = 'sign.request') like '%electronic signature with an audit trail%'
  and (select sign_request_id from public.email_outbox where template = 'sign.request') = :'req1', 'the email: who asked, the wording, and its request');

-- ===== the signing page (service role, as the Edge Function)
set role service_role;
select pg_temp.check(public.sign_pub_open(pg_temp.h('wrong-token'), '203.0.113.9', null, 'Test') ->> 'state' = 'unknown', 'a wrong link: unknown');
select pg_temp.check(public.sign_pub_open('not-a-hash', '203.0.113.9', null, 'Test') ->> 'state' = 'unknown', 'not even a hash: unknown');
select public.sign_pub_open(pg_temp.h(:'tok1'), '203.0.113.9', '198.51.100.1, 203.0.113.9', 'Mozilla/5.0 Test') as open1 \gset
select pg_temp.check(:'open1'::jsonb ->> 'state' = 'ready' and :'open1'::jsonb -> 'request' ->> 'company' = 'Sample Plumbing'
  and jsonb_array_length(:'open1'::jsonb -> 'fields') = 2 and :'open1'::jsonb ->> 'sha256' = repeat('a', 64), 'the right link: ready, with only this signer''s 2 fields');
select pg_temp.check(:'open1'::jsonb::text not like '%Jo Witness%' and :'open1'::jsonb::text not like '%witness.test%', 'nothing about the other signer');
select pg_temp.check(public.sign_pub_doc(pg_temp.h(:'tok1'), '203.0.113.9') ->> 'path' = :'path1', 'the page may show the original');
reset role;
select pg_temp.check((select status from public.sign_signers where email = 'pat@client.test') = 'viewed', 'Viewed');
select pg_temp.check((select ip from public.sign_events where event = 'viewed') = '203.0.113.9', 'viewed: the address the function trusts');
select set_config('test.tok1h', pg_temp.h(:'tok1'), false);
set role service_role;
do $$ declare t text := current_setting('test.tok1h'); png text := 'data:image/png;base64,iVBORw0KGgo='; r jsonb; begin
  assert public.sign_pub_finish(t, '203.0.113.9', null, 'UA', jsonb_build_object('s1', png), false, 'drawn', null) ->> 'error' like 'Tick "I agree to sign electronically" first%', 'refused';
  assert public.sign_pub_finish(t, '203.0.113.9', null, 'UA', '{}', true, 'drawn', null) ->> 'error' like 'Adopt your signature%', 'refused';
  assert public.sign_pub_finish(t, '203.0.113.9', null, 'UA', jsonb_build_object('s1', 'data:text/html;base64,PHNjcmlwdD4='), true, 'drawn', null) ->> 'error' like 'Adopt your signature%', 'refused';
  r := public.sign_pub_finish(t, '203.0.113.9', '198.51.100.1, 203.0.113.9', 'Mozilla/5.0 Test', jsonb_build_object('s1', png, 'd1', 'ignored', 'extra', 'x'), true, 'drawn', null);
  assert r ->> 'state' = 'signed' and r ->> '_complete' is null, 'signed, waiting for the next: ' || r::text;
  assert public.sign_pub_open(t, '203.0.113.9', null, 'UA') ->> 'state' = 'signed', 'their link now says signed';
  assert public.sign_pub_finish(t, '203.0.113.9', null, 'UA', jsonb_build_object('s1', png), true, 'drawn', null) ->> 'error' like 'You''ve already signed%', 'refused';
end $$;
reset role;
select pg_temp.check((select vals from public.sign_signers where email = 'pat@client.test') ?& array['s1', 'd1']
  and not ((select vals from public.sign_signers where email = 'pat@client.test') ? 'extra'), 'only this signer''s fields are kept');
select pg_temp.check((select vals ->> 'd1' from public.sign_signers where email = 'pat@client.test') = to_char((now() at time zone 'utc')::date, 'FMDD Mon YYYY'),
  'the date is the day signed, not what was typed');
select pg_temp.check((select ip || '|' || ip_chain || '|' || user_agent from public.sign_signers where email = 'pat@client.test') = '203.0.113.9|198.51.100.1, 203.0.113.9|Mozilla/5.0 Test',
  'signed: the trusted address, the whole forwarded chain and the browser are kept');
select pg_temp.link_for('jo@witness.test') as tok2 \gset
select pg_temp.check((select token_hash from public.sign_signers where email = 'jo@witness.test') = pg_temp.h(:'tok2'), 'now the second signer has a link');
select set_config('test.tok2h', pg_temp.h(:'tok2'), false);
set role service_role;
do $$ declare t text := current_setting('test.tok2h'); png text := 'data:image/png;base64,iVBORw0KGgo='; r jsonb; c jsonb; begin
  assert jsonb_array_length(public.sign_pub_open(t, '198.51.100.20', null, 'UA2') -> 'fields') = 3, 'the second signer''s 3 fields';
  assert public.sign_pub_finish(t, '198.51.100.20', null, 'UA2', jsonb_build_object('s2', png, 'i2', png, 'n2', E'Jo\u0007'), true, 'typed', null) ->> 'error' like 'Fill in every field first%', 'refused';
  r := public.sign_pub_finish(t, '198.51.100.20', null, 'UA2', jsonb_build_object('s2', png, 'i2', png, 'n2', 'Jo Witness'), true, 'typed', null);
  assert r ->> 'state' = 'finishing' and r ->> '_complete' = current_setting('test.req1'), 'everyone signed: finishing ' || r::text;
  c := public.sign_pub_claim(current_setting('test.req1')::uuid);
  assert jsonb_array_length(c -> 'signers') = 2 and c ->> 'original_sha256' = repeat('a', 64) and c ->> 'sender_email' = 'owner@a.test'
    and jsonb_array_length(c -> 'events') >= 6, 'the bundle for the certificate: ' || left(c::text, 300);
  assert public.sign_pub_claim(current_setting('test.req1')::uuid) is null, 'only one copy is made at a time';
  begin perform public.sign_pub_complete(current_setting('test.req1')::uuid, 'elsewhere/signed.pdf', repeat('b', 64), repeat('c', 64)); raise exception 'stored somewhere else';
  exception when others then assert sqlerrm like 'That signed copy isn''t right%', sqlerrm; end;
  r := public.sign_pub_complete(current_setting('test.req1')::uuid, current_setting('test.ws_a') || '/' || current_setting('test.req1') || '/signed.pdf', repeat('b', 64), repeat('c', 64));
  assert r ->> 'state' = 'completed', 'completed';
  assert public.sign_pub_complete(current_setting('test.req1')::uuid, current_setting('test.ws_a') || '/' || current_setting('test.req1') || '/signed.pdf', repeat('d', 64), repeat('d', 64)) ->> 'state' = 'completed', 'twice: no change';
  assert public.sign_pub_open(t, '198.51.100.20', null, 'UA2') ->> 'state' = 'completed', 'the signer''s link: completed (download)';
  assert public.sign_pub_doc(t, '198.51.100.20') ->> 'path' like '%/signed.pdf', 'and it gives the signed copy';
end $$;
reset role;
select pg_temp.check((select signed_sha256 from public.sign_requests where id = :'req1') = repeat('b', 64), 'the first signed copy''s hash stays');
select pg_temp.check((select count(*) from public.email_outbox where template = 'sign.completed') = 3, 'completed: both signers and the sender are emailed');
select pg_temp.check((select count(*) from public.sign_signers where request_id = :'req1' and copy_hash ~ '^[0-9a-f]{64}$' and copy_until > now() + interval '29 days') = 2,
  'each signer gets a download link for 30 days (only its hash kept)');
select pg_temp.check((select files_delete_at::date from public.sign_requests where id = :'req1') = (now() + interval '365 days')::date, 'files kept 1 year from completion');
select pg_temp.link_for('pat@client.test') as copy1 \gset
set role service_role;
select pg_temp.check(public.sign_pub_open(pg_temp.h(:'copy1'), '203.0.113.9', null, 'UA') ->> 'state' = 'completed', 'the download link from the completion email works');
reset role;
-- the sender sees it, and can download it (the bucket's rule)
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.sign_requests_mine(:'ws_a') as mine \gset
select pg_temp.check(:'mine'::jsonb -> 0 ->> 'status' = 'completed' and :'mine'::jsonb -> 0 -> 'signers' -> 1 ->> 'status' = 'signed'
  and :'mine'::text not like '%token%' and :'mine'::text not like '%iVBOR%' and :'mine'::text not like '%203.0.113%', 'the sender''s list: statuses, no links, signatures or addresses');
select pg_temp.check(public.sign_request_file(:'req1') ->> 'signed' like '%/signed.pdf', 'the sender gets the signed copy''s path');
select pg_temp.check(json_array_length(public.sign_request_history(:'req1')) >= 8, 'the sender sees the history');
reset role;

-- ===== the audit trail can't be changed or deleted
do $$ begin
  begin update public.sign_events set ip = '0.0.0.0'; raise exception 'history changed'; exception when others then assert sqlerrm like 'The signing history can''t be changed%', sqlerrm; end;
  begin delete from public.sign_events; raise exception 'history deleted'; exception when others then assert sqlerrm like 'The signing history can''t be changed%', sqlerrm; end;
end $$;

-- ===== decline (unordered: both signers get links at once)
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select (public.sign_request_create(:'ws_a', 'Quote 42', null, false, null, 90,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05},{"id":"b","kind":"signature","signer":2,"page":1,"x":0.1,"y":0.3,"w":0.2,"h":0.05}]',
  '[{"name":"Ana Buyer","email":"ana@buyer.test"},{"name":"Ben Buyer","email":"ben@buyer.test"}]') ->> 'id') as req2 \gset
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'ws_a' || '/' || :'req2' || '/original.pdf', '{"size": 500}');
select public.sign_request_send(:'req2', repeat('e', 64), 500, 1);
reset role;
select pg_temp.check(pg_temp.link_for('ana@buyer.test') is not null and pg_temp.link_for('ben@buyer.test') is not null, 'not in order: both have links');
select pg_temp.h(pg_temp.link_for('ana@buyer.test')) as ana, pg_temp.h(pg_temp.link_for('ben@buyer.test')) as ben \gset
set role service_role;
select pg_temp.check(public.sign_pub_open(:'ana', '192.0.2.5', null, 'UA') ->> 'state' = 'ready', 'Ana opens it');
do $$ begin
  assert public.sign_pub_decline(current_setting('test.none', true), '192.0.2.5', null, 'UA', 'x') ->> 'error' like 'This link isn''t working%', 'refused';
end $$;
select public.sign_pub_decline(:'ana', '192.0.2.5', null, 'UA', 'The price is wrong.') ->> 'state' as st \gset
select pg_temp.check(:'st' = 'you_declined', 'Ana declined');
select pg_temp.check(public.sign_pub_open(:'ana', '192.0.2.5', null, 'UA') ->> 'state' = 'you_declined', 'Ana''s link: you declined');
select pg_temp.check(public.sign_pub_open(:'ben', '192.0.2.6', null, 'UA') ->> 'state' = 'declined', 'Ben''s link: declined, can''t be signed');
reset role;
select pg_temp.check((select status from public.sign_requests where id = :'req2') = 'declined'
  and (select files_delete_at::date from public.sign_requests where id = :'req2') = (now() + interval '90 days')::date, 'declined; files kept the 90 days chosen');
select pg_temp.check((select body_text from public.email_outbox where template = 'sign.declined' order by id desc limit 1) like '%Their reason: The price is wrong.%'
  and (select to_address from public.email_outbox where template = 'sign.declined' order by id desc limit 1) = 'owner@a.test', 'the sender is emailed the reason');

-- ===== cancel, and reminders (a new link; the old one stops)
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select (public.sign_request_create(:'ws_a', 'Lease', null, false, null, null,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"Cam Tenant","email":"cam@tenant.test"}]') ->> 'id') as req3 \gset
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'ws_a' || '/' || :'req3' || '/original.pdf', '{"size": 500}');
select public.sign_request_send(:'req3', repeat('f', 64), 500, 1);
reset role;
select set_config('test.req3', :'req3', false);
select pg_temp.h(pg_temp.link_for('cam@tenant.test')) as cam1 \gset
update public.sign_signers set sent_at = now() - interval '2 days' where request_id = :'req3';
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check(public.sign_request_remind(:'req3') = 1, 'a reminder went to Cam');
do $$ begin
  perform public.sign_request_remind(current_setting('test.req3')::uuid); raise exception 'two reminders in a day';
exception when others then assert sqlerrm like 'A reminder was sent in the last day%', sqlerrm; end $$;
reset role;
select pg_temp.h(pg_temp.link_for('cam@tenant.test')) as cam2 \gset
select pg_temp.check(:'cam1' <> :'cam2' and (select body_text from public.email_outbox where template = 'sign.reminder' order by id desc limit 1) like '%any earlier link for this request has stopped working%', 'the reminder has a new link');
set role service_role;
select pg_temp.check(public.sign_pub_open(:'cam1', '192.0.2.7', null, 'UA') ->> 'state' = 'unknown' and public.sign_pub_open(:'cam2', '192.0.2.7', null, 'UA') ->> 'state' = 'ready', 'the old link stops, the new one works');
reset role;
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.sign_request_cancel(:'req3');
reset role;
set role service_role;
select pg_temp.check(public.sign_pub_open(:'cam2', '192.0.2.7', null, 'UA') ->> 'state' = 'cancelled', 'cancelled: the link says so');
select pg_temp.check(public.sign_pub_doc(:'cam2', '192.0.2.7') ->> 'state' = 'closed', 'and no document');
reset role;
select pg_temp.check((select count(*) from public.email_outbox where template = 'sign.cancelled' and to_address = 'cam@tenant.test') = 1, 'Cam is told it was cancelled');
select pg_temp.check(not exists (select 1 from public.email_outbox where sign_request_id = :'req3' and status = 'queued' and template in ('sign.request', 'sign.reminder'))
  and not exists (select 1 from public.email_outbox where sign_request_id = :'req3' and status = 'failed' and body_text ~ 'sign/\?t='), 'unsent link emails for a cancelled request are not sent, and lose the link');

-- ===== expiry: at the date the sender set (or 30 days)
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select (public.sign_request_create(:'ws_a', 'Form', null, false, now() + interval '3 days', null,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"Dee Late","email":"dee@late.test"}]') ->> 'id') as req4 \gset
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'ws_a' || '/' || :'req4' || '/original.pdf', '{"size": 500}');
select public.sign_request_send(:'req4', repeat('1', 64), 500, 1);
reset role;
select pg_temp.check((select expires_at::date from public.sign_requests where id = :'req4') = (now() + interval '3 days')::date, 'the sender''s own end date');
select pg_temp.check((select expires_at::date from public.sign_requests where id = :'req1') = (now() + interval '30 days')::date, 'by default 30 days');
select pg_temp.h(pg_temp.link_for('dee@late.test')) as dee \gset
select set_config('test.dee', :'dee', false);
update public.sign_requests set expires_at = now() - interval '1 minute' where id = :'req4';
set role service_role;
do $$ begin
  assert public.sign_pub_finish(current_setting('test.dee'), '192.0.2.8', null, 'UA', '{}', true, 'drawn', null) ->> 'error' like 'This request has expired%', 'refused';
end $$;
select pg_temp.check(public.sign_pub_open(:'dee', '192.0.2.8', null, 'UA') ->> 'state' = 'expired', 'past its end date: expired');
reset role;
select pg_temp.check((select status from public.sign_requests where id = :'req4') = 'expired'
  and exists (select 1 from public.email_outbox where template = 'sign.expired' and sign_request_id = :'req4'), 'expired, and the sender is told');
-- the hourly sweep expires the rest by itself
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select (public.sign_request_create(:'ws_a', 'Old form', null, false, null, null,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"Eve Slow","email":"eve@slow.test"}]') ->> 'id') as req5 \gset
insert into storage.objects (bucket_id, name, metadata) values ('sign-docs', :'ws_a' || '/' || :'req5' || '/original.pdf', '{"size": 500}');
select public.sign_request_send(:'req5', repeat('2', 64), 500, 1);
reset role;
update public.sign_requests set expires_at = now() - interval '1 minute' where id = :'req5';
update public.email_outbox set status = 'sent' where sign_request_id is not null;
select public.sign_sweep() as sweep \gset
select pg_temp.check((:'sweep'::jsonb ->> 'expired')::int = 1 and (select status from public.sign_requests where id = :'req5') = 'expired', 'the sweep expires it');
select pg_temp.check(not exists (select 1 from public.email_outbox e join public.sign_requests r on r.id = e.sign_request_id
  where r.status in ('declined', 'cancelled', 'expired') and e.body_text ~ 'riyeser\.com/sign/\?t='), 'sent emails of closed requests lose their links');
select pg_temp.check(exists (select 1 from public.email_outbox where template = 'sign.completed' and body_text ~ 'riyeser\.com/sign/\?t='), 'a completed request''s download links stay for now');

-- ===== rate limits on the public endpoints
set role service_role;
do $$ declare i int; good text := current_setting('test.tok2h'); begin
  for i in 1 .. 30 loop perform public.sign_pub_open(md5(i::text) || md5(i::text), '198.51.100.66', null, 'bot'); end loop;
  assert public.sign_pub_open(good, '198.51.100.66', null, 'bot') ->> 'state' = 'busy', 'after 30 wrong links an address is told to wait, even with a right link';
  assert public.sign_pub_open(good, '198.51.100.67', null, 'UA') ->> 'state' = 'completed', 'another address is fine';
  for i in 1 .. 120 loop perform public.sign_pub_open(good, '198.51.100.68', null, 'UA'); end loop;
  assert public.sign_pub_open(good, '198.51.100.68', null, 'UA') ->> 'state' = 'busy', 'more than 120 opens in 10 minutes from one address: wait';
  for i in 1 .. 30 loop assert public.sign_pub_decline(good, '198.51.100.69', null, 'UA', 'no') ->> 'error' like 'This request is closed%', 'refused, and counted'; end loop;
  assert public.sign_pub_decline(good, '198.51.100.69', null, 'UA', 'no') ->> 'error' like 'Too many tries from here%', 'then: too many tries';
end $$;
reset role;
select pg_temp.check(not exists (select 1 from public.sign_rate where rkey like '%198.51.100%'), 'the counters keep a hash, not the address');

-- ===== the monthly free quota (an HQ setting)
insert into public.hq_settings (key, value) values ('sign.free_per_month', '5') on conflict (key) do update set value = excluded.value;
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check((public.sign_quota(:'ws_a') ->> 'used')::int = 5 and (public.sign_quota(:'ws_a') ->> 'left')::int = 0, 'quota: 5 of 5 used');
do $$ begin
  perform public.sign_request_create(current_setting('test.ws_a')::uuid, 'One more', null, false, null, null,
    '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"F","email":"f@x.test"}]');
  raise exception 'over the quota';
exception when others then assert sqlerrm like 'Your business has sent its 5 free signing requests this month%', sqlerrm; end $$;
reset role;
update public.sign_requests set sent_at = sent_at - interval '40 days', created_at = created_at - interval '40 days' where id = :'req5';
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.check((public.sign_quota(:'ws_a') ->> 'used')::int = 4, 'last month''s don''t count');
-- another business has its own quota
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.check((public.sign_quota(:'ws_b') ->> 'used')::int = 0, 'B''s quota is its own');
reset role;
select pg_temp.check((public.hq_settings_json() ->> 'sign.free_per_month')::int = 5, 'the HQ settings show it');
delete from public.hq_settings where key = 'sign.free_per_month';

-- ===== keep / delete the files
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.sign_request_keep(:'req1', 30);
do $$ begin
  perform public.sign_request_keep(current_setting('test.req1')::uuid, 12); raise exception 'odd keep';
exception when others then assert sqlerrm like 'Choose 30 days%', sqlerrm; end $$;
reset role;
select pg_temp.check((select files_delete_at::date from public.sign_requests where id = :'req1') = (now() + interval '30 days')::date, 'keep 30 days from completion');
update public.sign_requests set files_delete_at = now() - interval '1 minute' where id = :'req1';
-- an abandoned draft (never sent) is cleaned up after 2 days
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select (public.sign_request_create(:'ws_a', 'Draft', null, false, null, null,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"G","email":"g@x.test"}]') ->> 'id') as draft \gset
reset role;
update public.sign_requests set created_at = now() - interval '3 days' where id = :'draft';
set role service_role;
select public.sign_pub_files_due(20) as due \gset
select pg_temp.check(jsonb_array_length(:'due'::jsonb) = 2 and :'due'::text like '%' || :'req1' || '%' and :'due'::text like '%signed.pdf%' and :'due'::text like '%' || :'draft' || '%', 'due: the completed request (both files) and the old draft');
select pg_temp.check(jsonb_array_length(public.sign_pub_files_due(20)) = 0, 'claimed: not handed out twice');
select public.sign_pub_files_gone(array[:'req1', :'draft']::uuid[]);
reset role;
select pg_temp.check((select files_deleted_at is not null from public.sign_requests where id = :'req1')
  and not exists (select 1 from public.sign_signers where request_id = :'req1' and vals is not null), 'files deleted: the signatures go too');
select pg_temp.check(not exists (select 1 from public.sign_requests where id = :'draft'), 'the old draft is gone');
select pg_temp.check((select count(*) from public.sign_events where request_id = :'req1') >= 9, 'the history stays');
set role service_role;
select pg_temp.check(public.sign_pub_open(current_setting('test.tok2h'), '203.0.113.50', null, 'UA') ->> 'state' = 'gone', 'the signer''s link: the files have been deleted');
reset role;
-- the sender's Delete files now: only when the files are really gone
set role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  perform public.sign_request_forget(current_setting('test.req3')::uuid); raise exception 'forgot with the file still there';
exception when others then assert sqlerrm like 'The files are still there%', sqlerrm; end $$;
delete from storage.objects where bucket_id = 'sign-docs' and name = :'ws_a' || '/' || :'req3' || '/original.pdf';
select public.sign_request_forget(:'req3');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
delete from storage.objects where bucket_id = 'sign-docs' and name = :'ws_a' || '/' || :'req2' || '/original.pdf';
reset role;
select pg_temp.check((select files_deleted_at from public.sign_requests where id = :'req3') is not null, 'Delete files now');
select pg_temp.check(exists (select 1 from storage.objects where name = :'ws_a' || '/' || :'req2' || '/original.pdf'), 'staff can''t delete the sender''s file');

-- ===== someone who leaves the business loses access to their requests
set role authenticated;
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select (public.sign_request_create(:'ws_a', 'Lee''s doc', null, false, null, null,
  '[{"id":"a","kind":"signature","signer":1,"page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]', '[{"name":"H","email":"h@x.test"}]') ->> 'id') as req6 \gset
select pg_temp.check(json_array_length(public.sign_requests_mine(:'ws_a')) = 0, 'a draft isn''t listed');
reset role;
delete from public.members where user_id = '66666666-6666-6666-6666-666666666666';
set role authenticated;
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
reset role;
select set_config('test.req6', :'req6', false);
set role authenticated;
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin
  perform public.sign_request_history(current_setting('test.req6')::uuid); raise exception 'left, still read it';
exception when others then assert sqlerrm like 'That signing request isn''t yours%', sqlerrm; end $$;
reset role;

select 'ALL SIGNING TESTS PASSED' as result;
