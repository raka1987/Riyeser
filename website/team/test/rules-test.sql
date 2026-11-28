\set ON_ERROR_STOP on
-- Signed in with two-step sign-in (aal2) unless a test says otherwise.
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal2')::text, false); end $$;
create function pg_temp.as_user_password_only(u text) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal1')::text, false); end $$;
set role authenticated;
-- Business A: owner creates the team; staff joins with the code
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_team('Sample Plumbing', 'Alex') as ws_a \gset
select invite_code as code_a from public.workspaces where id = :'ws_a' \gset
select id as gen_a from public.channels where workspace_id = :'ws_a' and name = 'general' \gset
insert into public.messages (channel_id, workspace_id, body) values (:'gen_a', :'ws_a', 'Morning team');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.join_team(lower(:'code_a'), 'Sam');
do $$ begin assert (select count(*) from public.messages) = 1, 'staff should see the general message'; end $$;
insert into public.messages (channel_id, workspace_id, body) values (:'gen_a', :'ws_a', 'On my way to Elm St');
-- Business B: a different owner sees nothing of A
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select public.create_team('Corner Cafe', 'Kim') as ws_b \gset
do $$ begin
  assert (select count(*) from public.workspaces) = 1, 'B sees only its own team';
  assert (select count(*) from public.messages) = 0, 'B sees none of A''s messages';
  assert (select count(*) from public.members) = 1, 'B sees only its own people';
end $$;
-- B can't write into A's channel, even knowing its id
select set_config('test.gen_a', :'gen_a', false), set_config('test.ws_a', :'ws_a', false);
do $$ begin
  begin
    insert into public.messages (channel_id, workspace_id, body) select id, workspace_id, 'hack' from public.channels limit 0;
    execute format('insert into public.messages (channel_id, workspace_id, body) values (%L, %L, %L)',
                   current_setting('test.gen_a', true), current_setting('test.ws_a', true), 'hack');
    raise exception 'B wrote into A';
  exception when insufficient_privilege then null;  -- refused by the row rules, as it should be
  end;
end $$;
select set_config('test.x','1',false);
-- and B can't read A's channel list or people by id either
do $$ begin assert (select count(*) from public.channels where id = current_setting('test.gen_a')::uuid) = 0, 'B cannot see A channel'; end $$;
-- direct messages: only the two people see them
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.open_dm(:'ws_a', '22222222-2222-2222-2222-222222222222') as dm \gset
do $$ begin assert public.open_dm((select id from public.workspaces limit 1), '22222222-2222-2222-2222-222222222222')
  = (select id from public.channels where kind='dm'), 'one DM per pair'; end $$;
insert into public.messages (channel_id, workspace_id, body) values (:'dm', :'ws_a', 'Private: your pay rise is approved');
-- M9: "Seen": Alex sees when Sam read the DM; nobody else can ask
select set_config('test.dm', :'dm', false);
do $$ begin assert public.dm_seen(current_setting('test.dm')::uuid) is null, 'M9 not read yet'; end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
insert into public.reads (channel_id) values (:'dm');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin assert public.dm_seen(current_setting('test.dm')::uuid) is not null, 'M9 Alex sees that Sam read it'; end $$;
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin assert public.dm_seen(current_setting('test.dm')::uuid) is null, 'M9 someone outside the DM learns nothing'; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select public.join_team(:'code_a', 'Jordan');
do $$ begin
  assert (select count(*) from public.messages) = 2, 'a third person sees the channel messages but not the DM';
  assert not exists (select 1 from public.messages where body like 'Private%'), 'DM hidden from others';
end $$;
-- unread counts: Jordan has 2 unread in #general, 0 after reading
do $$ begin assert (select unread from public.unread_counts((select id from public.workspaces limit 1)) u
  join public.channels c on c.id = u.channel_id where c.name = 'general') = 2, 'two unread'; end $$;
insert into public.reads (channel_id) values (:'gen_a');
do $$ begin assert (select unread from public.unread_counts((select id from public.workspaces limit 1)) u
  join public.channels c on c.id = u.channel_id where c.name = 'general') = 0, 'read'; end $$;
-- you can edit only your own messages, and can't move them
do $$ begin
  update public.messages set body = 'changed' where body = 'Morning team';
  assert not exists (select 1 from public.messages where body = 'changed'), 'cannot edit someone else''s message';
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
update public.messages set body = 'On my way to 4 Elm St' where body = 'On my way to Elm St';
do $$ begin assert (select edited_at is not null from public.messages where body = 'On my way to 4 Elm St'), 'edited time set'; end $$;
-- only admins make new invite codes; staff can't
do $$ begin
  begin perform public.new_invite_code((select id from public.workspaces limit 1)); raise exception 'staff made a code';
  exception when others then if sqlerrm = 'staff made a code' then raise; end if; end;
end $$;
-- a wrong code is refused with a plain message
do $$ begin
  begin perform public.join_team('NOPE1234', 'X'); raise exception 'joined with bad code';
  exception when others then assert sqlerrm like 'That invite code%', sqlerrm; end;
end $$;
-- signed-out visitors see nothing
reset role; set role anon; select pg_temp.as_user('');
do $$ begin
  begin perform count(*) from public.messages; raise exception 'anon read messages';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Private channels: the owner (Alex) makes "executives" with Sam only. Jordan (a member of A) can't see it.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
select public.create_private_channel(:'ws_a', 'executives', 'Owners and managers',
  array['22222222-2222-2222-2222-222222222222']::uuid[]) as exec_ch \gset
insert into public.messages (channel_id, workspace_id, body) values (:'exec_ch', :'ws_a', 'Exec only: Q3 margins');
select set_config('test.exec', :'exec_ch', false);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin assert exists (select 1 from public.messages where body = 'Exec only: Q3 margins'), 'Sam (added) sees it'; end $$;
-- Sam isn't an admin and didn't make it, so can't add people
do $$ begin
  begin perform public.set_channel_people(current_setting('test.exec')::uuid, array['44444444-4444-4444-4444-444444444444']::uuid[], null);
    raise exception 'Sam added someone';
  exception when others then if sqlerrm = 'Sam added someone' then raise; end if; end;
end $$;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
do $$ begin
  assert not exists (select 1 from public.channels where name = 'executives'), 'Jordan cannot see the private channel';
  assert not exists (select 1 from public.messages where body like 'Exec only%'), 'Jordan cannot read it';
end $$;
-- Jordan can't post into it, even knowing its id
do $$ begin
  begin
    insert into public.messages (channel_id, workspace_id, body)
      values (current_setting('test.exec')::uuid, (select workspace_id from public.members limit 1), 'sneaky');
    raise exception 'Jordan posted';
  exception when insufficient_privilege then null; end;
end $$;
-- the owner adds Jordan: now Jordan sees it; then Jordan leaves and can't again
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_channel_people(:'exec_ch', array['44444444-4444-4444-4444-444444444444']::uuid[], null);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
do $$ begin assert exists (select 1 from public.messages where body like 'Exec only%'), 'Jordan added, sees it'; end $$;
delete from public.channel_members where channel_id = :'exec_ch' and user_id = '44444444-4444-4444-4444-444444444444';
do $$ begin assert not exists (select 1 from public.channels where name = 'executives'), 'Jordan left'; end $$;
-- Jordan can't leave (delete from) a direct message he's not in, or remove others from the private channel
delete from public.channel_members where channel_id = :'exec_ch';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin assert (select count(*) from public.channel_members where channel_id = current_setting('test.exec')::uuid) = 2, 'Alex and Sam still in'; end $$;
-- the other business still sees nothing
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin assert not exists (select 1 from public.channels where kind = 'private'), 'B sees no private channels'; end $$;
reset role;

-- Nobody can promote themselves, or flip a private chat to public
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); set role authenticated;
do $$ begin
  begin update public.members set role = 'owner' where user_id = auth.uid(); raise exception 'self-promoted';
  exception when insufficient_privilege then null; end;
  begin update public.workspaces set calls_paid_until = now() + interval '10 years'; raise exception 'gave self premium';
  exception when insufficient_privilege then null; end;
  begin update public.channels set kind = 'channel' where kind = 'private'; raise exception 'made private public';
  exception when insufficient_privilege then null; end;
end $$;
update public.members set display_name = 'Sam T' where user_id = auth.uid();
do $$ begin assert (select display_name from public.members where user_id = auth.uid()) = 'Sam T', 'can rename self'; end $$;

-- ===== Calls (premium)
-- Branches: only admins make them; everyone in the team sees them
do $$ begin
  begin insert into public.branches (workspace_id, name) select workspace_id, 'Sneaky' from public.members limit 1; raise exception 'member made a branch';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_branch(:'ws_a', 'Lautoka branch') as br \gset
insert into public.branch_members (branch_id, user_id) values (:'br', '22222222-2222-2222-2222-222222222222'), (:'br', '44444444-4444-4444-4444-444444444444');
-- set-up: Head office is 100 with Alex on 101; Lautoka is 200 with its own join code
do $$ begin
  assert (select extension from public.branches where name = 'Head office') = 100, 'head office 100';
  assert (select extension from public.members where user_id = '11111111-1111-1111-1111-111111111111') = 101, 'owner on 101';
  assert (select extension from public.branches where name = 'Lautoka branch') = 200, 'second branch 200';
  assert (select code from public.branches where name = 'Lautoka branch') ~ '^LAU-[0-9]{4}$', 'branch code like LAU-1234';
end $$;
select code as lau_code from public.branches where name = 'Lautoka branch' \gset
-- an admin can't put someone from another business in a branch
do $$ begin
  begin insert into public.branch_members (branch_id, user_id) select id, '33333333-3333-3333-3333-333333333333' from public.branches limit 1; raise exception 'added outsider';
  exception when insufficient_privilege then null; end;
end $$;
do $$ begin assert (public.team_features((select id from public.workspaces limit 1)) ->> 'calls')::boolean, 'new team has the calls trial'; end $$;
-- Alex rings Sam: Sam sees the ring, Jordan doesn't
insert into public.call_signals (workspace_id, call_id, to_user, kind) values (:'ws_a', gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'ring');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin assert (select count(*) from public.call_signals where kind = 'ring') = 1, 'Sam sees the ring'; end $$;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
do $$ begin assert (select count(*) from public.call_signals) = 0, 'Jordan sees nothing of the Alex-Sam call'; end $$;
-- B can't ring anyone in A
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  begin insert into public.call_signals (workspace_id, call_id, to_user, kind)
        values ((select id from public.workspaces limit 1), gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'ring');
        raise exception 'B rang A';
  exception when insufficient_privilege then null; end;
end $$;
-- after the trial, without paying: no calls; with paying: calls again
reset role;
update public.workspaces set created_at = now() - interval '100 days' where id = :'ws_a';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin
  assert not (public.team_features((select id from public.workspaces limit 1)) ->> 'calls')::boolean, 'trial over';
  begin insert into public.call_signals (workspace_id, call_id, to_user, kind)
        values ((select id from public.workspaces limit 1), gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'ring');
        raise exception 'rang without calls';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.workspaces set calls_paid_until = now() + interval '30 days' where id = :'ws_a';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
insert into public.call_signals (workspace_id, call_id, to_user, kind) values (:'ws_a', gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'ring');
do $$ begin assert (public.team_features((select id from public.workspaces limit 1)) ->> 'calls_paid')::boolean, 'paid'; end $$;
reset role;

-- A new person joins with the Lautoka code: in the team, in the branch, on 201
reset role;
insert into auth.users values ('55555555-5555-5555-5555-555555555555', 'lautoka@a.test');
select pg_temp.as_user('55555555-5555-5555-5555-555555555555'); set role authenticated;
select public.join_team(lower(:'lau_code'), 'Lautoka front desk');
do $$ begin
  assert (select extension from public.members where user_id = auth.uid()) = 201, 'branch joiner gets 201';
  assert exists (select 1 from public.branch_members bm join public.branches b on b.id = bm.branch_id where b.name = 'Lautoka branch' and bm.user_id = auth.uid()), 'placed in Lautoka';
  begin update public.members set extension = 999 where user_id = auth.uid(); raise exception 'changed own extension';
  exception when insufficient_privilege then null; end;
  begin perform public.set_extension((select workspace_id from public.members where user_id = auth.uid()), auth.uid(), 999); raise exception 'non-admin set ext';
  exception when others then if sqlerrm = 'non-admin set ext' then raise; end if; end;
end $$;
-- the owner can renumber, but not onto a number that's taken
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_extension(:'ws_a', '55555555-5555-5555-5555-555555555555', 250);
do $$ begin
  begin perform public.set_extension((select id from public.workspaces limit 1), '55555555-5555-5555-5555-555555555555', 101); raise exception 'took 101';
  exception when others then assert sqlerrm like 'Extension 101 is already used%', sqlerrm; end;
end $$;
reset role;

-- ===== Companies: Company ID, join requests (approve like a friend request), access, linked PCs
reset role;
insert into auth.users values ('66666666-6666-6666-6666-666666666666', 'boss@c.test'), ('77777777-7777-7777-7777-777777777777', 'newbie@c.test');
select pg_temp.as_user('66666666-6666-6666-6666-666666666666'); set role authenticated;
select (public.create_company('Island Traders', 'Mere', '{"legal_name":"Island Traders Pte Ltd","tax_number":"50-12345-0-1","country":"Fiji"}'::jsonb)) as made \gset
select (:'made'::json ->> 'workspace_id') as ws_c, (:'made'::json ->> 'company_code') as code_c \gset
select set_config('test.ws_c', :'ws_c', false);
do $$ begin
  assert (select company_code from public.workspaces where name = 'Island Traders') ~ '^RIY-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$', 'company code format';
  assert (select tax_number from public.workspaces where name = 'Island Traders') = '50-12345-0-1', 'profile saved';
  assert (select job_role from public.members where user_id = auth.uid() and workspace_id = (select id from public.workspaces where name = 'Island Traders')) = 'owner', 'owner job role';
end $$;
select public.create_branch(:'ws_c', 'Nadi branch') as nadi \gset
select code as nadi_code from public.branches where id = :'nadi' \gset
select set_config('test.nadi_code', :'nadi_code', false), set_config('test.code_c', :'code_c', false);
-- someone asks to join with the Nadi branch code: pending, and they can't see anything yet
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
do $$ begin assert (public.request_join(current_setting('test.nadi_code'), 'Jone', 'New at Nadi') ->> 'status') = 'pending', 'pending'; end $$;
do $$ begin
  assert (select count(*) from public.workspaces where name = 'Island Traders') = 0, 'not in yet: cannot see the company';
  assert (select status from public.my_join_requests() limit 1) = 'pending', 'sees own pending request';
  assert (select company_name from public.my_join_requests() limit 1) = 'Island Traders', 'request shows the company name';
  begin perform public.decide_join((select id from public.join_requests limit 1), true, 'manager', true, null); raise exception 'approved self';
  exception when others then if sqlerrm = 'approved self' then raise; end if; end;
  begin perform public.link_device((select workspace_id from public.join_requests limit 1), gen_random_uuid(), 'PC', 'win32', '1'); raise exception 'linked before approval';
  exception when others then if sqlerrm = 'linked before approval' then raise; end if; end;
end $$;
-- asking twice keeps one request
do $$ begin perform public.request_join(current_setting('test.nadi_code'), 'Jone Vula', null);
  assert (select count(*) from public.my_join_requests() where status = 'pending') = 1, 'one pending request'; end $$;
-- S7: the owner is emailed once (not again when Jone asks again), and sees the count before two-step sign-in
reset role;
do $$ declare ws uuid := current_setting('test.ws_c')::uuid; begin
  assert (select count(*) from public.email_outbox where workspace_id = ws and template = 'join_request' and status = 'queued'
    and to_address = 'boss@c.test' and subject = 'Jone asked to join Island Traders on Riyeser' and body_text like '%newbie@c.test%'
    and body_text like '%New at Nadi%' and body_text like '%riyeser.com/link/?requests%') = 1, 'S7 the owner is emailed once';
end $$;
select pg_temp.as_user_password_only('66666666-6666-6666-6666-666666666666'); set role authenticated;
do $$ begin
  assert public.join_request_count(current_setting('test.ws_c')::uuid) = 1, 'S7 the owner sees 1 waiting, even before two-step sign-in';
  assert (select count(*) from public.join_requests where status = 'pending') = 0, 'S7 ...but not the names until two-step sign-in';
end $$;
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
do $$ begin
  assert public.join_request_count(current_setting('test.ws_c')::uuid) = 0, 'S7 the person asking sees no count';
  begin perform public.request_join(current_setting('test.nadi_code'), '  ', null); raise exception 'no name';
  exception when others then assert sqlerrm like 'Type your name%', sqlerrm; end;
end $$;
-- the owner sees it and approves as Sales in the Nadi branch
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select id as req from public.join_requests where status = 'pending' \gset
do $$ begin assert (select display_name from public.join_requests where status = 'pending') = 'Jone Vula', 'owner sees the request'; end $$;
select public.decide_join(:'req', true, 'sales', false, null);
do $$ begin
  assert (select job_role from public.members where user_id = '77777777-7777-7777-7777-777777777777') = 'sales', 'approved as sales';
  assert (select extension from public.members where user_id = '77777777-7777-7777-7777-777777777777') = 201, 'Nadi branch is 200, so 201';
end $$;
-- now Jone sees the company and links this PC; then the owner changes access to bookkeeper + admin, and removes the PC
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
select gen_random_uuid() as pc \gset
select set_config('test.pc', :'pc', false);
select public.link_device(:'ws_c', :'pc', 'Nadi front desk', 'win32', '1.7.0');
do $$ begin
  assert (select count(*) from public.workspaces where name = 'Island Traders') = 1, 'in now';
  assert public.device_still_linked((select id from public.workspaces where name = 'Island Traders'), (select id from public.devices limit 1)), 'linked';
  begin perform public.set_access((select id from public.workspaces where name = 'Island Traders'), auth.uid(), 'manager', true, null); raise exception 'raised own access';
  exception when others then if sqlerrm = 'raised own access' then raise; end if; end;
end $$;
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select public.set_access(:'ws_c', '77777777-7777-7777-7777-777777777777', 'bookkeeper', true, array[:'nadi']::uuid[]);
do $$ begin assert (select role || '/' || job_role from public.members where user_id = '77777777-7777-7777-7777-777777777777') = 'admin/bookkeeper', 'access changed'; end $$;
do $$ begin assert (select count(*) from public.devices) = 1, 'owner (admin) sees the company''s PCs'; end $$;
delete from public.devices where id = :'pc';
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
do $$ begin assert not public.device_still_linked((select id from public.workspaces where name = 'Island Traders'), current_setting('test.pc')::uuid), 'PC unlinked'; end $$;
-- a declined request: nothing given; and a wrong code is refused plainly
reset role;
insert into auth.users values ('88888888-8888-8888-8888-888888888888', 'stranger@c.test');
select pg_temp.as_user('88888888-8888-8888-8888-888888888888'); set role authenticated;
select public.request_join(:'code_c', 'Stranger', null);
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select public.decide_join((select id from public.join_requests where status = 'pending' limit 1), false, null, false, null);
select pg_temp.as_user('88888888-8888-8888-8888-888888888888');
do $$ begin
  assert (select status from public.my_join_requests() limit 1) = 'declined', 'declined';
  assert (select count(*) from public.workspaces) = 0, 'declined person sees nothing';
  begin perform public.request_join('RIY-NOPE-00', 'X', null); raise exception 'bad code worked';
  exception when others then assert sqlerrm like 'We couldn%', sqlerrm; end;
end $$;
reset role;
-- S8: joining with the Company ID (no branch) still gives an extension when approved; the invite page can show the name
insert into auth.users values ('5a5a5a5a-0000-4000-8000-000000000059', 'helper@c.test');
set role anon; select pg_temp.as_user('');
do $$ begin
  assert public.invite_info(current_setting('test.code_c')) ->> 'name' = 'Island Traders', 'S8 the invite page gets the business name';
  assert public.invite_info(lower(current_setting('test.nadi_code'))) ->> 'name' = 'Island Traders', 'S8 ...with a branch code too';
  assert public.invite_info('RIY-NOPE-00') is null and public.invite_info('') is null, 'S8 nothing for a wrong code';
end $$;
reset role; set role authenticated;
select pg_temp.as_user('5a5a5a5a-0000-4000-8000-000000000059');
select public.request_join(:'code_c', 'Hana Helper', null);
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select public.decide_join((select id from public.join_requests where status = 'pending' and user_id = '5a5a5a5a-0000-4000-8000-000000000059'), true, 'staff', false, null);
do $$ declare e int := (select extension from public.members where user_id = '5a5a5a5a-0000-4000-8000-000000000059');
begin assert e between 101 and 199 and e not in (select extension from public.members where user_id <> '5a5a5a5a-0000-4000-8000-000000000059' and extension is not null), 'S8 an extension of their own: ' || coalesce(e::text, 'none'); end $$;
-- S59: Hana writes, is removed; the others still see her name on it, she sees nothing
select pg_temp.as_user('5a5a5a5a-0000-4000-8000-000000000059');
insert into public.messages (channel_id, workspace_id, body)
  select id, workspace_id, 'Hana here' from public.channels where workspace_id = current_setting('test.ws_c')::uuid and name = 'general';
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
delete from public.members where workspace_id = :'ws_c' and user_id = '5a5a5a5a-0000-4000-8000-000000000059';
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
do $$ begin
  assert (select display_name from public.former_members(current_setting('test.ws_c')::uuid) where user_id = '5a5a5a5a-0000-4000-8000-000000000059') = 'Hana Helper', 'S59 her name stays for the business';
  assert (select count(*) from public.former_members(current_setting('test.ws_c')::uuid) where user_id = '77777777-7777-7777-7777-777777777777') = 0, 'S59 current members are not listed';
end $$;
select pg_temp.as_user('5a5a5a5a-0000-4000-8000-000000000059');
do $$ begin
  assert (select count(*) from public.former_members(current_setting('test.ws_c')::uuid)) = 0, 'S59 the removed person reads nothing';
  assert (select count(*) from public.messages where body = 'Hana here') = 0, 'S59 nor the messages';
end $$;
reset role;

-- ===== Two-step sign-in and change history
-- the owner with only a password: no admin powers (can't approve, can't change access, can't see the history)
select pg_temp.as_user_password_only('66666666-6666-6666-6666-666666666666'); set role authenticated;
do $$ begin
  begin perform public.create_branch((select id from public.workspaces where name = 'Island Traders'), 'Labasa'); raise exception 'admin without 2-step';
  exception when others then if sqlerrm = 'admin without 2-step' then raise; end if; end;
  assert (select count(*) from public.audit_log) = 0, 'no history without 2-step';
  assert (select count(*) from public.messages) >= 0, 'chat still works with a password only';
end $$;
-- with two-step sign-in: sees the history of what happened, and nobody can change it
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin
  assert exists (select 1 from public.audit_log where action = 'join_request.approved'), 'approval recorded';
  assert exists (select 1 from public.audit_log where action = 'members.update' and details ? 'job_role'), 'access change recorded';
  assert exists (select 1 from public.audit_log where action = 'devices.delete'), 'unlinked PC recorded';
  assert not exists (select 1 from public.audit_log where details::text like '%invite_code%'), 'codes not stored in history';
  assert (select count(distinct workspace_id) from public.audit_log) = 1, 'only this company''s history';
  begin delete from public.audit_log; raise exception 'deleted history';
  exception when insufficient_privilege then null; end;
  begin update public.audit_log set action = 'x'; raise exception 'edited history';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== Riyeser HQ (Riyeser's own staff)
reset role;
insert into auth.users values ('99999999-9999-9999-9999-999999999999', 'sam@riyeser.test'), ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'help@riyeser.test');
-- only the database owner (SQL Editor) can make the first owner: a normal signed-in user can't
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  begin perform public.hq_make_owner('sam@riyeser.test', 'Sam'); raise exception 'made self owner';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_overview(); raise exception 'non-staff saw HQ';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff%', sqlerrm; end;
  begin perform count(*) from public.hq_staff; raise exception 'read staff table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.hq_make_owner('sam@riyeser.test', 'Sam');
-- owner with only a password: nothing; with two-step: everything
select pg_temp.as_user_password_only('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  begin perform public.hq_overview(); raise exception 'HQ without two-step';
  exception when others then if sqlerrm = 'HQ without two-step' then raise; end if; end;
  assert (public.hq_me() ->> 'two_step')::boolean = false, 'tells the site two-step is needed';
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare o json; c json; begin
  o := public.hq_overview();
  assert (o ->> 'companies')::int >= 3, 'sees all companies';
  assert (select count(*) from public.hq_companies('island')) = 1, 'search by name';
  assert (select count(*) from public.hq_companies('RIY-')) >= 1, 'search by Company ID';
  c := public.hq_company((select id from public.hq_companies('island') limit 1));
  assert json_array_length(c -> 'people') >= 1 and json_array_length(c -> 'branches') >= 1, 'company detail';
  -- privacy: no message text anywhere in what HQ gets
  assert c::text not like '%Morning team%' and c::text not like '%Exec only%' and o::text not like '%Exec only%', 'no messages in HQ';
end $$;
select public.hq_set_calls_paid((select id from public.hq_companies('island') limit 1), '2027-06-30');
select public.hq_add_note((select id from public.hq_companies('island') limit 1), 'Called Mere: wants POS for Nadi.');
select public.hq_add_staff('help@riyeser.test', 'Help Desk', 'support');
do $$ begin
  assert (select (calls_paid_until at time zone 'UTC')::date from public.hq_companies('island')) = '2027-06-30', 'paid until set';
  assert (select count(*) from public.workspaces where name = 'Island Traders') = 0, 'HQ staff still can''t read customer tables directly';
  assert (select count(*) from public.hq_history() where action in ('licence.module', 'note.added', 'staff.added', 'customer.viewed')) >= 4, 'HQ history';
  begin perform public.hq_set_staff(auth.uid(), 'support', true); raise exception 'changed own access';
  exception when others then assert sqlerrm like 'You can%', sqlerrm; end;
end $$;
-- support staff: can look and add notes, can't change billing or staff, can't read the HQ history
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin
  assert (select count(*) from public.hq_companies('')) >= 3, 'support sees companies';
  perform public.hq_add_note((select id from public.hq_companies('island') limit 1), 'Helped with branch codes.');
  begin perform public.hq_set_calls_paid((select id from public.hq_companies('island') limit 1), '2030-01-01'); raise exception 'support set billing';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_add_staff('x@y.z', 'X', 'owner'); raise exception 'support added staff';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_history(); raise exception 'support read history';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
-- switched off: no access at all
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_staff('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'support', false);
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin begin perform public.hq_overview(); raise exception 'switched-off staff saw HQ';
  exception when others then if sqlerrm = 'switched-off staff saw HQ' then raise; end if; end; end $$;
-- download counts: only with the token
reset role;
select public.hq_set_ingest_token('test-token-123');
set role anon;
do $$ begin
  begin perform public.hq_record_downloads('wrong', '{"RiyeserCentral-Setup.exe": 10}'); raise exception 'wrong token accepted';
  exception when others then assert sqlerrm = 'Not allowed', sqlerrm; end;
  assert public.hq_record_downloads('test-token-123', '{"RiyeserCentral-Setup.exe": 120, "RiyeserPOS-Setup.exe": 33}') = 2, 'recorded';
end $$;
reset role;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin assert (select total from public.hq_downloads(30) where asset = 'RiyeserPOS-Setup.exe') = 33, 'downloads read back'; end $$;
reset role;

-- ===== Licences online
select pg_temp.as_user('66666666-6666-6666-6666-666666666666'); set role authenticated;   -- Island Traders' owner
do $$ declare l json; begin
  l := public.company_licence((select id from public.workspaces where name = 'Island Traders'));
  assert (l -> 'modules' -> 'basic' ->> 'status') = 'trial', 'new company: basic on trial';
  assert (l -> 'modules' -> 'basic' ->> 'days_left')::int between 85 and 90, 'about 90 days';
  assert (l -> 'seats' ->> 'included')::int = 3, 'three users included';
  assert (l ->> 'company_code') like 'RIY-%', 'company code';
  begin perform public.company_licence((select id from public.workspaces where name = 'Island Traders' limit 0)); exception when others then null; end;
end $$;
-- someone from another company can't read Island Traders' licence
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  begin perform public.company_licence(current_setting('test.ws_c')::uuid); raise exception 'read another licence';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
  begin perform public.hq_set_module(current_setting('test.ws_c')::uuid, 'pos', 'active', null, '2030-01-01'); raise exception 'customer set own licence';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
-- HQ (Sam, owner): Basics paid for a year, POS trial extended, Payroll cancelled; 2 extra users; yearly
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_module(:'ws_c', 'basic', 'active', null, (current_date + 365));
select public.hq_set_module(:'ws_c', 'pos', 'trial', (current_date + 30), null);
select public.hq_set_module(:'ws_c', 'payroll', 'cancelled', null, (current_date - 1));
select public.hq_set_plan(:'ws_c', 2, 1, 'monthly', false);
do $$ declare l json; m numeric; begin
  l := (public.hq_company_licence(current_setting('test.ws_c')::uuid)) -> 'licence';
  assert (l -> 'modules' -> 'basic' ->> 'status') = 'active' and (l -> 'modules' -> 'basic' ->> 'active')::boolean, 'basic paid';
  assert (l -> 'modules' -> 'pos' ->> 'days_left')::int = 30, 'pos trial extended to 30 days';
  assert (l -> 'modules' -> 'payroll' ->> 'status') = 'cancelled' and not (l -> 'modules' -> 'payroll' ->> 'active')::boolean, 'payroll cancelled, ended';
  assert (l ->> 'extra_companies')::int = 1, 'extra companies';
  m := ((public.hq_company_licence(current_setting('test.ws_c')::uuid)) ->> 'monthly')::numeric;
  assert m = (25 + 2 * 7) + (20 + 2 * 7) + 10, format('monthly estimate (US$): Basics 25 + Riyeser Link 20 (paid earlier), each with 3 + 2 extra users at 7, + 1 company 10 = 83, got %s', m);
  assert ((public.hq_licences()) ->> 'monthly_estimate')::numeric >= 83, 'total estimate';
  assert ((public.hq_licences()) ->> 'early_bird_left')::int = 100, 'early bird places';
end $$;
-- Prices are in US$ a month per business: each paid program includes 3 people, then US$7 a person for that program
do $$ begin
  assert public.riyeser_bill(array['plus', 'payroll'], 5, 0, 'monthly', false) = 92, '5 people with Plus + Payroll = (39 + 14) + (25 + 14) = 92';
  assert public.riyeser_bill(array['plus', 'payroll', 'calls'], 5, 0, 'monthly', false) = 126, 'Plus + Payroll + Riyeser Link, 5 people = 92 + 20 + 14 = 126';
  assert public.riyeser_bill(array['basic'], 3, 0, 'monthly', false) = 25, '3 people with Basics only = 25';
  assert public.riyeser_bill(array['basic'], 1, 0, 'monthly', false) = 25, 'fewer than 3 people is still 25';
  assert public.riyeser_bill(array['basic', 'plus'], 3, 0, 'monthly', false) = 39, 'Basics and Plus both on = the Plus price only';
  assert public.riyeser_bill(array['basic', 'plus'], 5, 0, 'monthly', false) = 53, 'Basics and Plus, 5 people: users counted once';
  assert public.riyeser_bill(array['calls'], 4, 0, 'monthly', false) = 27, 'Riyeser Link with 4 people = 20 + 7 = 27';
  assert public.riyeser_bill(array['plus', 'payroll'], 5, 0, 'yearly', false) = 920, 'yearly = 10 months';
  assert public.riyeser_bill(array['plus', 'payroll'], 5, 0, 'monthly', true) = 46, 'early bird = half';
  assert public.riyeser_bill(array['plus', 'payroll'], 5, 0, 'yearly', true) = 460, 'yearly early bird';
  assert public.riyeser_bill(array['calls'], 4, 0, 'yearly', false) = 270, 'Riyeser Link yearly';
  assert public.riyeser_bill(array['basic'], 3, 2, 'monthly', false) = 45, 'extra companies 10 each';
  assert public.riyeser_bill(array['basic'], 3, 1, 'monthly', true) = 22.5, 'early bird halves programs and users, not extra companies';
  assert public.riyeser_bill(array['payroll'], 3, 2, 'monthly', false) = 25, 'extra companies only count with Accounting';
  assert public.riyeser_bill(array['as_built', 'pos', 'bookings'], 3, 0, 'monthly', false) = 83, 'As Built 29, POS 29 and Bookings 25';
  assert public.riyeser_bill(array[]::text[], 9, 0, 'monthly', false) = 0, 'free tools only = 0';
  assert public.riyeser_bill(array['basic', 'basic', 'link', 'central', 'pdf'], 3, 0, 'monthly', false) = 25, 'free programs and repeats add nothing';
  assert public.riyeser_price('plus') = 39 and public.riyeser_price('calls') = 20 and public.riyeser_price('payroll') = 25 and public.riyeser_price('extra_user') = 7
    and public.riyeser_price('extra_till') = 15 and public.riyeser_price('bundle_business') = 99, 'price list';
  -- pricing v2 bundles: the bundle price replaces its programs' prices; extra users (US$7) and tills (US$15) still count
  assert public.riyeser_bill(array['basic', 'pos', 'calls'], 3, 0, 'monthly', false) = 59, 'Shop bundle = 59 (74 separately)';
  assert public.riyeser_bill(array['basic', 'pos', 'calls'], 5, 0, 'monthly', false) = 87, 'Shop, 5 people: 59 + 2 extra in Basics and Link (POS has unlimited cashiers) = 87';
  assert public.riyeser_bill(array['calls', 'payroll', 'basic'], 3, 0, 'monthly', false) = 59, 'Office bundle = 59 (70 separately)';
  assert public.riyeser_bill(array['plus', 'payroll', 'pos', 'bookings', 'calls'], 3, 0, 'monthly', false) = 99, 'Business bundle = 99 (138 separately)';
  assert public.riyeser_bill(array['plus', 'payroll', 'pos', 'bookings', 'calls', 'as_built'], 3, 0, 'monthly', false) = 128, 'Business + As Built = 128';
  assert public.riyeser_bill(array['basic', 'pos', 'payroll', 'calls'], 3, 0, 'monthly', false) = 84, 'Shop (saves most) + Payroll 25 = 84';
  assert public.riyeser_bill(array['basic', 'plus', 'pos', 'calls'], 3, 0, 'monthly', false) = 88, 'Plus instead of Basics: no Shop bundle, 39 + 29 + 20';
  assert public.riyeser_bill(array['plus', 'payroll', 'pos', 'bookings', 'calls'], 3, 0, 'monthly', true) = 49.5, 'early bird halves bundles too';
  assert public.riyeser_bill(array['plus', 'payroll', 'pos', 'bookings', 'calls'], 3, 0, 'yearly', false) = 990, 'Business yearly = 10 months';
  assert public.riyeser_bill(array['pos'], 9, 0, 'monthly', false) = 29, 'POS: unlimited cashiers';
  assert (public.riyeser_plan(array['pos'], 3, null, 3, 0, 'monthly', false) ->> 'total')::numeric = 59, 'POS with 3 tills = 29 + 2 x 15';
  assert (public.riyeser_plan(array['basic', 'pos', 'calls'], 3, '{"basic": 4, "calls": 8}', 2, 0, 'monthly', false) ->> 'total')::numeric = 59 + 7 + 35 + 15,
    'Shop with users per program (Basics 4, Link 8) and 2 tills';
  assert public.riyeser_plan(array['basic', 'pos', 'calls'], 3, null, 1, 0, 'monthly', false) ->> 'bundle' = 'shop', 'says which bundle';
end $$;
-- The same on a real company (undone after): 5 people with Plus + Payroll paid, Basics paid as well, Link Plus off -> 84
do $$ declare ws uuid := current_setting('test.ws_c')::uuid; m numeric; begin
  begin
    perform public.hq_set_module(ws, 'plus', 'active', null, current_date + 30);
    perform public.hq_set_module(ws, 'payroll', 'active', null, current_date + 30);
    perform public.hq_set_module(ws, 'calls', 'cancelled', null, null);
    perform public.hq_set_plan(ws, 2, 0, 'monthly', false);
    m := (public.hq_company_licence(ws) ->> 'monthly')::numeric;
    assert m = 92, format('Plus + Payroll, 5 people = 92 (Basics not counted with Plus), got %s', m);
    perform public.hq_set_plan(ws, 2, 0, 'yearly', false);
    m := (public.hq_company_licence(ws) ->> 'monthly')::numeric;
    assert m = 76.67, format('yearly: 920 a year = 76.67 a month, got %s', m);
    perform public.hq_set_plan(ws, 2, 0, 'monthly', true);
    m := (public.hq_company_licence(ws) ->> 'monthly')::numeric;
    assert m = 46, format('early bird: 46, got %s', m);
    raise exception 'undo the price check';
  exception when others then if sqlerrm <> 'undo the price check' then raise; end if; end;
end $$;
-- yearly + early bird: (Basics 39 + Riyeser Link 34) half = 36.50, + 1 company 10 = 46.50 a month list -> x 10/12 = 38.75
select public.hq_set_plan(:'ws_c', 2, 1, 'yearly', true);
do $$ begin assert ((public.hq_company_licence(current_setting('test.ws_c')::uuid)) ->> 'monthly')::numeric = 38.75,
  format('yearly early bird, got %s', (public.hq_company_licence(current_setting('test.ws_c')::uuid)) ->> 'monthly'); end $$;
-- Riyeser Link Plus (was Team Calls) via the licence: cancelled and unpaid -> no calls; the old button sets it paid again
select public.hq_set_module(:'ws_c', 'calls', 'cancelled', null, null);
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin assert not public.calls_allowed(current_setting('test.ws_c')::uuid), 'calls off when cancelled'; end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_calls_paid(:'ws_c', (current_date + 60));
do $$ begin assert public.calls_allowed(current_setting('test.ws_c')::uuid), 'calls on when paid'; end $$;
-- the early bird stops at 100 businesses
reset role;
do $$ declare i int; wid uuid; begin
  for i in 1..99 loop
    insert into public.workspaces (name, company_code) values ('Early bird ' || i, public.make_company_code()) returning id into wid;
    insert into public.company_plans (workspace_id, early_bird, early_bird_since) values (wid, true, current_date);
  end loop;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  assert ((public.hq_licences()) ->> 'early_bird_left')::int = 0, 'all 100 used';
  begin perform public.hq_set_plan((select id from public.hq_companies('harbour') limit 1), 0, 0, 'monthly', true); raise exception '101st early bird';
  exception when others then assert sqlerrm like 'The early bird offer is full%', sqlerrm; end;
end $$;
-- support staff can see licences but not change them
reset role; update public.hq_staff set active = true where display_name = 'Help Desk';
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin
  assert ((public.hq_licences()) ->> 'paying_companies')::int >= 1, 'support sees licences';
  begin perform public.hq_set_module(current_setting('test.ws_c')::uuid, 'pos', 'active', null, '2030-01-01'); raise exception 'support changed licence';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
reset role;

-- ===== Riyeser HQ phase 1: support tickets, escalations, fix-ups, permissions, audit, inactive accounts, emails, refunds, free periods
reset role;
-- (test helper: read the HQ history while acting as someone else)
create function pg_temp.audit(act text) returns setof public.hq_audit language sql security definer as $$ select * from public.hq_audit where action = act $$;
insert into auth.users values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'dev@riyeser.test'), ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'senior@riyeser.test'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'money@riyeser.test');
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_add_staff('dev@riyeser.test', 'Dev', 'developer');
select public.hq_add_staff('senior@riyeser.test', 'Senior Sam', 'senior');
select public.hq_add_staff('money@riyeser.test', 'Finance Fi', 'finance');
-- permissions: roles give defaults; the owner has everything
do $$ begin
  assert (public.hq_me() -> 'perms')::text like '%staff.manage%' and (public.hq_me() -> 'perms')::text like '%accounts.inactive%', 'owner has everything';
  assert ((public.hq_me()) -> 'perms')::text like '%support.level3%', 'hq_me lists permissions';
end $$;
select set_config('test.ws_b', :'ws_b', false), set_config('test.ws_a', :'ws_a', false);

-- --- tickets: Sam (staff at A), Jordan (staff at A) and Kim (B's owner, asking with no business)
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select (public.open_ticket(:'ws_a', 'program', 'POS won''t print', 'The receipt printer stopped after the update.') ->> 'id') as t_sam \gset
select set_config('test.t_sam', :'t_sam', false);
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select (public.open_ticket(:'ws_a', 'signin', 'Can''t sign in', 'It says my password is wrong.') ->> 'id') as t_jordan \gset
select set_config('test.t_jordan', :'t_jordan', false);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select (public.open_ticket(null, 'other', 'Question', 'Do you do payroll for NZ?') ->> 'id') as t_kim \gset
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin
  assert json_array_length(public.my_tickets()) = 1, 'Sam sees only his own ticket';
  assert (select count(*) from public.support_tickets) = 1, 'row rules: Sam reads only his ticket';
  assert (public.my_tickets() -> 0 ->> 'ref') ~ '^T-[0-9]{5,}$', 'ticket number like T-10234';
  begin perform public.my_ticket(current_setting('test.t_jordan')::uuid); raise exception 'Sam opened Jordan''s ticket';
  exception when others then assert sqlerrm like 'We couldn%', sqlerrm; end;
  begin perform public.reply_ticket(current_setting('test.t_jordan')::uuid, 'sneaky'); raise exception 'Sam replied to Jordan''s ticket';
  exception when others then assert sqlerrm like 'We couldn%', sqlerrm; end;
  begin perform public.hq_tickets(null, null); raise exception 'customer read the HQ inbox';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
-- the owner (Alex, two-step) sees the business's tickets; nobody else's
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin assert json_array_length(public.my_tickets()) = 2, 'owner sees the business''s 2 tickets, not Kim''s'; end $$;
select pg_temp.as_user_password_only('11111111-1111-1111-1111-111111111111');
do $$ begin assert json_array_length(public.my_tickets()) = 0, 'owner without two-step: only their own (none)'; end $$;
-- Help Desk (support): replies, adds an internal note
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ declare b json; begin
  b := public.hq_tickets('new', null);
  assert json_array_length(b -> 'tickets') = 3, 'support sees every new ticket';
  assert (b -> 'counts' ->> 'unassigned')::int = 3, 'counts';
  assert json_array_length(public.hq_tickets('all', 'printer') -> 'tickets') = 1, 'search finds the message text';
  perform public.hq_ticket_reply(current_setting('test.t_sam')::uuid, 'Thanks Sam. Try turning the printer off and on, then print a test page.', false, null);
  perform public.hq_ticket_reply(current_setting('test.t_sam')::uuid, 'INTERNAL: known driver bug in 1.7.0', true, null);
  assert (public.hq_ticket(current_setting('test.t_sam')::uuid) -> 'business' ->> 'people')::int >= 3, 'business summary beside the ticket';
  assert exists (select 1 from pg_temp.audit('ticket.viewed') where true), 'opening a ticket is logged';
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ declare t json; begin
  assert (public.my_tickets() -> 0 ->> 'unread')::int = 1, 'one unread reply';
  t := public.my_ticket(current_setting('test.t_sam')::uuid);
  assert json_array_length(t -> 'messages') = 2, 'customer sees question + reply, not the internal note';
  assert t::text not like '%INTERNAL%', 'internal note never shown';
  assert (t ->> 'status') = 'waiting_customer', 'waiting on the customer after a reply';
  assert (t -> 'messages' -> 1 ->> 'from') = 'Riyeser Support', 'staff names not shown';
  assert not exists (select 1 from public.support_messages where body like 'INTERNAL%'), 'row rules hide internal notes';
  assert (public.my_tickets() -> 0 ->> 'unread')::int = 0, 'read now';
  begin update public.support_messages set body = 'changed'; raise exception 'customer edited a message';
  exception when insufficient_privilege then null; end;
  begin delete from public.support_messages; raise exception 'customer deleted a message';
  exception when insufficient_privilege then null; end;
  begin update public.support_tickets set status = 'done'; raise exception 'customer changed status directly';
  exception when insufficient_privilege then null; end;
  begin perform level from public.support_tickets; raise exception 'customer read the level';
  exception when insufficient_privilege then null; end;
  perform public.reply_ticket(current_setting('test.t_sam')::uuid, 'Still not printing.');
  assert (public.my_ticket(current_setting('test.t_sam')::uuid) ->> 'status') = 'waiting_us', 'a reply re-opens it to waiting on us';
end $$;
reset role;
do $$ begin
  begin update public.support_messages set body = 'x'; raise exception 'owner edited a support message';
  exception when others then assert sqlerrm like 'Support messages can%', sqlerrm; end;
  begin delete from public.support_tickets; raise exception 'owner deleted a ticket';
  exception when others then assert sqlerrm like 'Rows in support_tickets are never deleted%', sqlerrm; end;
  assert (select count(*) from public.email_outbox where template = 'ticket_received') = 3, 'received emails queued';
  assert (select count(*) from public.email_outbox where template = 'ticket_reply' and to_address = 'staff@a.test') = 1, 'reply email to the customer';
end $$;

-- --- staff without permission are refused; the owner ticks one on
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); set role authenticated;
do $$ begin
  begin perform public.hq_tickets(null, null); raise exception 'developer read tickets';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_company(current_setting('test.ws_c')::uuid); raise exception 'developer opened a company';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_set_staff_perms('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', array['audit.view'], null); raise exception 'developer changed perms';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_staff_perms('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', array['support.view'], array['downloads.view']);
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
do $$ begin
  assert json_array_length(public.hq_tickets('all', null) -> 'tickets') = 3, 'ticked on: developer can read tickets';
  begin perform public.hq_downloads(30); raise exception 'ticked off but still works';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_ticket_reply(current_setting('test.t_sam')::uuid, 'hi', false, null); raise exception 'developer replied';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin
  begin perform public.hq_set_staff_perms('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', array['audit.view'], null); raise exception 'support changed perms';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
-- two-step still required: an owner with only a password can't do anything
select pg_temp.as_user_password_only('99999999-9999-9999-9999-999999999999');
do $$ begin begin perform public.hq_tickets(null, null); raise exception 'HQ without two-step';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;

-- --- escalation: by hand (support -> Senior), and the customer only sees "passed to our senior team"
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin
  begin perform public.hq_ticket_escalate(current_setting('test.t_sam')::uuid, 2, '', null); raise exception 'escalated without a reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  begin perform public.hq_ticket_escalate(current_setting('test.t_sam')::uuid, 2, 'Printer driver bug', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); raise exception 'assigned to someone who can''t work level 2';
  exception when others then assert sqlerrm like '%can''t work Senior%', sqlerrm; end;
  perform public.hq_ticket_escalate(current_setting('test.t_sam')::uuid, 2, 'Printer driver bug', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert (public.hq_ticket(current_setting('test.t_sam')::uuid) -> 'ticket' ->> 'level')::int = 2, 'now level 2';
  assert exists (select 1 from pg_temp.audit('ticket.escalated') where true and ticket like 'T-%'), 'escalation in the HQ history';
  begin perform public.hq_ticket_reply(current_setting('test.t_sam')::uuid, 'hello', false, null); raise exception 'support replied at level 2';
  exception when others then assert sqlerrm like 'This ticket is with Senior%', sqlerrm; end;
end $$;
select pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
do $$ begin
  assert json_array_length(public.hq_tickets('level2', null) -> 'tickets') = 1, 'level 2 inbox';
  perform public.hq_ticket_reply(current_setting('test.t_sam')::uuid, 'We''ve found the problem: a fix is coming in 1.7.1.', false, null);
  assert public.hq_ticket(current_setting('test.t_sam')::uuid)::text like '%Escalated to Senior by Help Desk: Printer driver bug%', 'internal note written';
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ declare t text := public.my_ticket(current_setting('test.t_sam')::uuid)::text; begin
  assert t like '%We''ve passed this to our senior team%', 'customer told it was passed on';
  assert t not like '%Printer driver bug%', 'internal reason never shown';
end $$;
-- automatic: Jordan's ticket has had no reply for 49 hours -> overdue and escalated to Senior
reset role;
update public.support_tickets set created_at = now() - interval '49 hours', last_customer_at = now() - interval '49 hours' where id = :'t_jordan';
set role authenticated;
do $$ begin begin perform public.hq_support_sweep(); raise exception 'a signed-in user ran the support sweep';
  exception when insufficient_privilege then null; end; end $$;
reset role;
do $$ declare r json; begin
  r := public.hq_support_sweep();
  assert (r ->> 'escalated')::int = 1, format('one escalated: %s', r);
  assert (select level from public.support_tickets where id = current_setting('test.t_jordan')::uuid) = 2, 'Jordan''s ticket is level 2';
  assert (select overdue_at is not null from public.support_tickets where id = current_setting('test.t_jordan')::uuid), 'flagged overdue';
  assert exists (select 1 from public.support_escalations where ticket_id = current_setting('test.t_jordan')::uuid and reason = 'No reply in 48 hours' and by_user is null), 'reason: No reply in 48 hours';
  assert ((public.hq_support_sweep()) ->> 'escalated')::int = 0, 'not escalated twice straight away';
  assert (select count(*) from public.support_tickets where level = 1 and id = current_setting('test.t_sam')::uuid) = 0, 'Sam''s stays where it is';
end $$;
-- the thresholds are settings the HQ owner can change (and nobody else)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin begin perform public.hq_set_setting('support.escalate_hours', 12); raise exception 'support changed a setting';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_setting('support.escalate_hours', 72);
do $$ begin assert (public.hq_get_settings() ->> 'support.escalate_hours')::numeric = 72, 'setting saved'; end $$;
select public.hq_set_setting('support.escalate_hours', 48);

-- --- the HQ history can't be changed or deleted, even by the database owner
reset role;
do $$ begin
  begin update public.hq_audit set action = 'x'; raise exception 'edited the HQ history';
  exception when others then assert sqlerrm like 'The HQ history can%', sqlerrm; end;
  begin delete from public.hq_audit; raise exception 'deleted the HQ history';
  exception when others then assert sqlerrm like 'The HQ history can%', sqlerrm; end;
  begin truncate public.hq_audit; raise exception 'emptied the HQ history';
  exception when others then assert sqlerrm like 'The HQ history can%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  begin update public.hq_audit set action = 'x'; raise exception 'staff edited history';
  exception when insufficient_privilege then null; end;
  assert json_array_length(public.hq_audit_search(null, 'ticket.', null, current_date - 1, current_date, false)) >= 3, 'history filters';
  assert json_array_length(public.hq_audit_search('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, null, null, null, false)) >= 3, 'filter by who';
  perform public.hq_audit_search(null, null, null, null, null, true);
  assert exists (select 1 from pg_temp.audit('audit.exported') where true), 'CSV download is logged';
end $$;

-- --- fix-up tools (Island Traders: owner Mere, admin Jone)
reset role; insert into auth.mfa_factors (user_id) values ('77777777-7777-7777-7777-777777777777');
select ref as t_sam_ref from public.support_tickets where id = :'t_sam' \gset
select set_config('test.t_sam_ref', :'t_sam_ref', false);
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin
  begin perform public.hq_edit_business(current_setting('test.ws_c')::uuid, '{"phone":"679 999 0000"}', '', null); raise exception 'edited without a reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  perform public.hq_edit_business(current_setting('test.ws_c')::uuid, '{"phone":"679 999 0000","country":"Fiji"}', 'Owner asked on the phone', current_setting('test.t_sam_ref'));
  assert exists (select 1 from pg_temp.audit('business.edited') where true and ticket = current_setting('test.t_sam_ref') and details::text not like '%679 999%'), 'edit audited with the ticket, no values';
  begin perform public.hq_reset_2fa(current_setting('test.ws_c')::uuid, '77777777-7777-7777-7777-777777777777', '', 'Lost phone', null); raise exception 'reset without identity check';
  exception when others then assert sqlerrm like 'Say how you checked%', sqlerrm; end;
  assert public.hq_reset_2fa(current_setting('test.ws_c')::uuid, '77777777-7777-7777-7777-777777777777', 'called back on the number on file', 'Lost phone', null) = 1, 'one authenticator removed';
  assert exists (select 1 from pg_temp.audit('people.reset_2fa') where true and details ->> 'identity_checked' = 'called back on the number on file'), '2FA reset audited';
  begin perform public.hq_change_owner(current_setting('test.ws_c')::uuid, '77777777-7777-7777-7777-777777777777', 'Sold the business', null); raise exception 'support changed owner';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_set_business_status(current_setting('test.ws_b')::uuid, 'closed', 'Asked to close', null); raise exception 'support closed a business';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from auth.mfa_factors where user_id = '77777777-7777-7777-7777-777777777777'), 'factors gone';
  assert exists (select 1 from public.email_outbox where template = 'mfa_reset' and to_address = 'newbie@c.test'), 'the person is told';
  assert (select phone from public.workspaces where id = current_setting('test.ws_c')::uuid) = '679 999 0000', 'details changed';
  assert exists (select 1 from public.audit_log where workspace_id = current_setting('test.ws_c')::uuid and action = 'workspaces.update' and actor is null), 'customer history shows Riyeser';
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_change_owner(:'ws_c', '77777777-7777-7777-7777-777777777777', 'Mere sold the business to Jone', null);
do $$ begin
  assert (select json_agg(x.role order by x.name) from json_to_recordset(public.hq_company(current_setting('test.ws_c')::uuid) -> 'people') x(name text, role text))::text = '["owner", "admin"]', 'Jone owner, Mere admin';
end $$;
-- close Corner Cafe: hidden from its people, licence not active, can't be joined; then reopen
select public.hq_set_business_status(:'ws_b', 'closed', 'Owner asked us to close it', null);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ declare l json; begin
  assert (select count(*) from public.workspaces) = 0, 'closed business hidden';
  assert (select count(*) from public.members) = 0, 'its people hidden';
  assert (select count(*) from public.my_closed_businesses()) = 1, 'told it is closed';
  l := public.company_licence(current_setting('test.ws_b')::uuid);
  assert not (l -> 'modules' -> 'basic' ->> 'active')::boolean and (l -> 'modules' -> 'basic' ->> 'status') = 'closed', 'licence not active';
  assert not public.calls_allowed(current_setting('test.ws_b')::uuid), 'no calls';
  assert json_array_length(public.my_tickets()) = 1, 'can still see their help request';
end $$;
reset role; select invite_code as code_b from public.workspaces where id = :'ws_b' \gset
select pg_temp.as_user('44444444-4444-4444-4444-444444444444'); set role authenticated;
do $$ begin begin perform public.join_team(current_setting('test.code_b', true), 'X'); exception when others then null; end; end $$;
select set_config('test.code_b', :'code_b', false);
do $$ begin begin perform public.join_team(current_setting('test.code_b'), 'X'); raise exception 'joined a closed business';
  exception when others then assert sqlerrm like 'This business is closed%', sqlerrm; end; end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ begin
  assert json_array_length(public.hq_business_list('', 'closed')) = 1, 'HQ filters by status';
  assert (public.hq_emails() ->> 'recent') like '%business_closed%', 'owner told (and the Emails view shows it)';
end $$;
select public.hq_set_business_status(:'ws_b', 'active', 'Reopened at the owner''s request', null);
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin assert (select count(*) from public.workspaces) = 1, 'reopened: visible again'; end $$;
-- close as a duplicate: closes THIS account; linking to the one kept is optional; nothing is deleted; Reopen undoes it.
-- Harbour Bakery (paid, used today) and Harbour Bakery (2) (signed up 2 days later, same owner, same tax number, unused);
-- Other Shop (another owner, the same tax number); Harbour Bakery old (closed).
reset role;
insert into auth.users values ('abd00000-0000-4000-8000-000000000001', 'baker@dup.test'), ('abd00000-0000-4000-8000-000000000002', 'other@dup.test');
insert into public.workspaces (id, name, company_code, created_at, last_active_at, tax_number, phone) values
  ('abd10000-0000-4000-8000-000000000001', 'Harbour Bakery', 'RIY-DUPA-01', now() - interval '20 days', now(), '12-345-678', '679 330 1234'),
  ('abd10000-0000-4000-8000-000000000002', 'Harbour Bakery (2)', 'RIY-DUPB-02', now() - interval '18 days', now() - interval '17 days', '12 345 678', null),
  ('abd10000-0000-4000-8000-000000000003', 'Other Shop', 'RIY-DUPC-03', now() - interval '300 days', now() - interval '30 days', '12345678', null),
  ('abd10000-0000-4000-8000-000000000004', 'Harbour Bakery old', 'RIY-DUPD-04', now() - interval '400 days', now() - interval '200 days', null, null);
update public.workspaces set status = 'closed', closed_at = now() - interval '100 days', closed_reason = 'inactive' where id = 'abd10000-0000-4000-8000-000000000004';
insert into public.members (workspace_id, user_id, display_name, role) values
  ('abd10000-0000-4000-8000-000000000001', 'abd00000-0000-4000-8000-000000000001', 'Baker', 'owner'),
  ('abd10000-0000-4000-8000-000000000002', 'abd00000-0000-4000-8000-000000000001', 'Baker', 'owner'),
  ('abd10000-0000-4000-8000-000000000003', 'abd00000-0000-4000-8000-000000000002', 'Other', 'owner'),
  ('abd10000-0000-4000-8000-000000000004', 'abd00000-0000-4000-8000-000000000001', 'Baker', 'owner');
insert into public.company_modules (workspace_id, module, status, paid_until) values ('abd10000-0000-4000-8000-000000000001', 'basic', 'active', current_date + 300);
insert into public.billing_orders (id, workspace_id, method, modules, people, billing, amount, status) values
  ('abd20000-0000-4000-8000-000000000001', 'abd10000-0000-4000-8000-000000000001', 'bank', '{basic}', 1, 'yearly', 120, 'paid');
insert into public.billing_payments (order_id, workspace_id, method, status, amount, at) values
  ('abd20000-0000-4000-8000-000000000001', 'abd10000-0000-4000-8000-000000000001', 'bank', 'completed', 120, now() - interval '400 days');
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ declare a uuid := 'abd10000-0000-4000-8000-000000000001'; b uuid := 'abd10000-0000-4000-8000-000000000002';
  c uuid := 'abd10000-0000-4000-8000-000000000003'; d uuid := 'abd10000-0000-4000-8000-000000000004'; r json; m json;
begin
  -- the screen: this account, its warnings, and likely matches (never every business; never itself; never a closed one)
  r := public.hq_dup_check(b);
  assert r -> 'this' ->> 'company_code' = 'RIY-DUPB-02' and r -> 'this' ->> 'owner_email' = 'baker@dup.test', 'this account and its owner';
  assert json_array_length(r -> 'risks') = 0, 'nothing risky about closing the unused copy';
  select x into m from json_array_elements(r -> 'matches') x where x ->> 'id' = a::text;
  assert m is not null and (m -> 'why')::text like '%Same owner email%' and (m -> 'why')::text like '%Similar name%'
    and (m -> 'why')::text like '%Same tax number%' and (m -> 'why')::text like '%Signed up 2 days apart%', 'Harbour Bakery suggested, with why: ' || coalesce((m -> 'why')::text, 'missing');
  assert (select x ->> 'id' from json_array_elements(r -> 'matches') x limit 1) = a::text, 'the best match first';
  assert exists (select 1 from json_array_elements(r -> 'matches') x where x ->> 'id' = c::text and (x -> 'why')::text = '["Same tax number"]'), 'same tax number, another owner';
  assert not exists (select 1 from json_array_elements(r -> 'matches') x where x ->> 'id' in (b::text, d::text)), 'not itself, not a closed one';
  assert json_array_length(r -> 'matches') <= 6, 'a handful, not a list of every business';
  assert (public.hq_dup_check(a) -> 'risks')::text like '%paid_invoices%' and (public.hq_dup_check(a) -> 'risks')::text like '%paid_programs%'
    and (public.hq_dup_check(a) -> 'risks')::text like '%recent%', 'the paid, busy one: three warnings';
  -- search: only by what's typed, never itself; a closed one says why it can't be kept
  assert json_array_length(public.hq_dup_search(b, '')) = 0 and json_array_length(public.hq_dup_search(b, 'h')) = 0, 'nothing until 2+ characters';
  assert not exists (select 1 from json_array_elements(public.hq_dup_search(b, 'Harbour')) x where x ->> 'id' = b::text), 'search: not itself';
  assert (select x ->> 'problem' from json_array_elements(public.hq_dup_search(b, 'RIY-DUPD')) x) like 'That account is closed%', 'search: a closed one says so';
  assert (select x ->> 'id' from json_array_elements(public.hq_dup_search(b, 'other@dup')) x) = c::text, 'search by owner email';
  -- the database re-checks everything
  begin perform public.hq_close_duplicate(b, b, 'Signed up twice', null, 'RIY-DUPB-02', true); raise exception 'kept itself';
  exception when others then assert sqlerrm like 'That''s this account%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, d, 'Signed up twice', null, 'RIY-DUPB-02', true); raise exception 'kept a closed one';
  exception when others then assert sqlerrm like 'That account is closed%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, gen_random_uuid(), 'Signed up twice', null, 'RIY-DUPB-02', true); raise exception 'kept a missing one';
  exception when others then assert sqlerrm like 'That business doesn''t exist%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, a, 'Signed up twice', null, 'RIY-DUPA-01', true); raise exception 'closed with the other one''s Company ID';
  exception when others then assert sqlerrm like 'Type this account''s Company ID (RIY-DUPB-02)%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, a, 'Signed up twice', null, null, true); raise exception 'closed without typing the Company ID';
  exception when others then assert sqlerrm like 'Type this account''s Company ID%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, c, 'Signed up twice', null, 'RIY-DUPB-02', false); raise exception 'kept another owner''s account without a warning';
  exception when others then assert sqlerrm like 'Check the warnings first%different owner%', sqlerrm; end;
  begin perform public.hq_close_duplicate(a, b, 'Signed up twice', null, 'RIY-DUPA-01', false); raise exception 'closed the paid one without a warning';
  exception when others then assert sqlerrm like 'Check the warnings first%paid invoice%wrong one%', sqlerrm; end;
  begin perform public.hq_close_duplicate(b, a, '', null, 'RIY-DUPB-02', false); raise exception 'closed without a reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  assert public.hq_company(a) -> 'profile' ->> 'status' = 'active' and public.hq_company(b) -> 'profile' ->> 'status' = 'active', 'nothing closed by the refusals';
end $$;
-- support (no business.close) and an HQ owner signed in with a password only: refused
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin
  begin perform public.hq_close_duplicate('abd10000-0000-4000-8000-000000000002', null, 'Signed up twice', null, 'RIY-DUPB-02', true); raise exception 'support closed a duplicate';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_dup_check('abd10000-0000-4000-8000-000000000002'); raise exception 'support saw the duplicate screen';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('99999999-9999-9999-9999-999999999999');
do $$ begin
  begin perform public.hq_close_duplicate('abd10000-0000-4000-8000-000000000002', null, 'Signed up twice', null, 'RIY-DUPB-02', true); raise exception 'closed without two-step';
  exception when others then assert sqlerrm like '%two-step%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert not has_function_privilege('authenticated', 'public.hq_dup_card(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.hq_dup_risks(uuid, uuid)', 'execute'), 'helpers are not callable';
  assert has_function_privilege('authenticated', 'public.hq_close_duplicate(uuid, uuid, text, text, text, boolean)', 'execute'), 'the tool is';
  assert not exists (select 1 from pg_proc where proname = 'hq_close_duplicate' and pronargs = 4), 'the old unchecked version is gone';
end $$;
-- the right way round: close the unused copy (Company ID typed in lower case), linked to the one kept
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_close_duplicate('abd10000-0000-4000-8000-000000000002', 'abd10000-0000-4000-8000-000000000001', 'Signed up twice', null, ' riy-dupb-02 ', false);
do $$ declare b uuid := 'abd10000-0000-4000-8000-000000000002'; p json := public.hq_company(b) -> 'profile'; begin
  assert p ->> 'status' = 'closed' and p ->> 'duplicate_of_name' = 'Harbour Bakery' and p ->> 'closed_reason' = 'Duplicate: Signed up twice', 'closed and linked';
  begin perform public.hq_close_duplicate(b, null, 'Again', null, 'RIY-DUPB-02', true); raise exception 'closed twice';
  exception when others then assert sqlerrm like 'This account is already closed%', sqlerrm; end;
  -- the kept one can't be closed as a duplicate of the one linked to it
  begin perform public.hq_close_duplicate('abd10000-0000-4000-8000-000000000001', b, 'Backwards', null, 'RIY-DUPA-01', true); raise exception 'kept a closed duplicate';
  exception when others then assert sqlerrm like 'That account is closed%', sqlerrm; end;
end $$;
reset role;
do $$ declare b uuid := 'abd10000-0000-4000-8000-000000000002'; a jsonb; begin
  -- nothing deleted or moved: the business, its people and the other business's payments are all still there
  assert exists (select 1 from public.workspaces where id = b and name = 'Harbour Bakery (2)' and tax_number = '12 345 678'), 'the business row is kept as it was';
  assert (select count(*) from public.members where workspace_id = b) = 1, 'its people are kept';
  assert (select count(*) from public.billing_payments where workspace_id = 'abd10000-0000-4000-8000-000000000001') = 1, 'the kept one''s payments untouched';
  select details into a from public.hq_audit where action = 'business.duplicate' and workspace_id = b order by at desc limit 1;
  assert a -> 'before' ->> 'status' = 'active' and a -> 'after' ->> 'status' = 'closed' and a -> 'after' ->> 'duplicate_of' = 'abd10000-0000-4000-8000-000000000001'
    and a ->> 'keep_company_code' = 'RIY-DUPA-01' and (a ->> 'data_deleted')::boolean = false and a -> 'risks_accepted' = '[]'::jsonb, 'HQ history: before and after';
  assert a::text not like '%baker@dup.test%' and a::text not like '%Baker%', 'no names or emails in the history';
  assert exists (select 1 from public.email_outbox where template = 'business_closed' and to_address = 'baker@dup.test'), 'the owner is told';
end $$;
-- Reopen undoes it: open again, the duplicate link and reason gone, and the history says which link was undone
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_set_business_status('abd10000-0000-4000-8000-000000000002', 'active', 'Closed the wrong one', null);
do $$ declare p json := public.hq_company('abd10000-0000-4000-8000-000000000002') -> 'profile'; begin
  assert p ->> 'status' = 'active' and p ->> 'duplicate_of' is null and p ->> 'closed_reason' is null and p ->> 'closed_at' is null, 'reopened: no link left';
end $$;
reset role;
do $$ begin
  assert (select details ->> 'was_duplicate_of' from public.hq_audit where action = 'business.reopened' and workspace_id = 'abd10000-0000-4000-8000-000000000002' order by at desc limit 1)
    = 'abd10000-0000-4000-8000-000000000001', 'the reopen records the link it undid';
end $$;
-- linking is optional: close this account with no link (the paid one, so its warnings are accepted), then reopen
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_close_duplicate('abd10000-0000-4000-8000-000000000001', null, 'Owner asked', null, 'RIY-DUPA-01', true);
reset role;
do $$ declare a jsonb; begin
  assert (select status = 'closed' and duplicate_of is null from public.workspaces where id = 'abd10000-0000-4000-8000-000000000001'), 'closed with no link';
  select details into a from public.hq_audit where action = 'business.duplicate' and workspace_id = 'abd10000-0000-4000-8000-000000000001';
  assert a -> 'risks_accepted' ?& array['paid_invoices', 'paid_programs', 'recent'] and (a -> 'facts' ->> 'paid_invoices')::int = 1, 'the accepted warnings are in the history';
  assert (select count(*) from public.company_modules where workspace_id = 'abd10000-0000-4000-8000-000000000001') = 1, 'its programs are kept';
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_set_business_status('abd10000-0000-4000-8000-000000000001', 'active', 'Closed by mistake', null);
-- (the earlier sample) Early bird 2 is a duplicate of Early bird 1
reset role; select company_code as eb2_code from public.workspaces where name = 'Early bird 2' \gset
set role authenticated;
select public.hq_close_duplicate((select id from public.hq_companies('Early bird 2') where name = 'Early bird 2'), (select id from public.hq_companies('Early bird 1') where name = 'Early bird 1'), 'Signed up twice', null, :'eb2_code', true);
do $$ begin
  assert (select (x ->> 'duplicate_of_name') from (select public.hq_company((select id from public.hq_companies('Early bird 2') where name = 'Early bird 2')) -> 'profile' as x) y) = 'Early bird 1', 'duplicate link';
end $$;
reset role;

-- --- inactive accounts
reset role;
insert into auth.users values ('e1e1e1e1-0000-4000-8000-000000000001', 'w30@d.test'), ('e1e1e1e1-0000-4000-8000-000000000002', 'w7@d.test'),
  ('e1e1e1e1-0000-4000-8000-000000000003', 'due@d.test'), ('e1e1e1e1-0000-4000-8000-000000000004', 'late@d.test');
insert into public.workspaces (id, name, company_code, last_active_at, created_at, phone) values
  ('f0000000-0000-4000-8000-000000000001', 'Quiet 30', public.make_company_code(), now() - interval '12 months' + interval '20 days', now() - interval '2 years', null),
  ('f0000000-0000-4000-8000-000000000002', 'Quiet 7', public.make_company_code(), now() - interval '12 months' + interval '3 days', now() - interval '2 years', null),
  ('f0000000-0000-4000-8000-000000000003', 'Quiet due', public.make_company_code(), now() - interval '12 months' - interval '1 day', now() - interval '3 years', '330 0000'),
  ('f0000000-0000-4000-8000-000000000004', 'Quiet late', public.make_company_code(), now() - interval '13 months', now() - interval '3 years', null);
insert into public.members (workspace_id, user_id, display_name, role) values
  ('f0000000-0000-4000-8000-000000000001', 'e1e1e1e1-0000-4000-8000-000000000001', 'Owner Thirty', 'owner'),
  ('f0000000-0000-4000-8000-000000000002', 'e1e1e1e1-0000-4000-8000-000000000002', 'Owner Seven', 'owner'),
  ('f0000000-0000-4000-8000-000000000003', 'e1e1e1e1-0000-4000-8000-000000000003', 'Pat Sample', 'owner'),
  ('f0000000-0000-4000-8000-000000000004', 'e1e1e1e1-0000-4000-8000-000000000004', 'Owner Late', 'owner');
update public.workspaces set warned_7_at = now() - interval '8 days' where id = 'f0000000-0000-4000-8000-000000000003';
insert into public.channels (id, workspace_id, kind, name) values ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'channel', 'general');
insert into public.messages (channel_id, workspace_id, user_id, body) values ('f1000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'e1e1e1e1-0000-4000-8000-000000000003', 'Pat''s private note');
-- Sample Plumbing pays for Riyeser Link Plus: never closed, however long it's quiet
update public.workspaces set last_active_at = now() - interval '2 years' where id = :'ws_a';
set role authenticated;
do $$ begin begin perform public.hq_inactivity_sweep(); raise exception 'a signed-in user ran the sweep';
  exception when insufficient_privilege then null; end; end $$;
reset role;
do $$ declare r json; begin
  r := public.hq_inactivity_sweep();
  assert (r ->> 'warned_30')::int = 1 and (r ->> 'warned_7')::int = 2 and (r ->> 'closed')::int = 1, format('sweep: %s', r);
  assert exists (select 1 from public.email_outbox where template = 'inactive_warning_30' and to_address = 'w30@d.test'), '30-day warning queued';
  assert exists (select 1 from public.email_outbox where template = 'inactive_warning_7' and to_address = 'w7@d.test'), '7-day warning queued';
  assert exists (select 1 from public.email_outbox where template = 'inactive_warning_7' and to_address = 'late@d.test'), 'overdue: warned first, not closed';
  assert (select status from public.workspaces where name = 'Quiet late') = 'active', 'not closed without a warning';
  assert (select status || '/' || closed_reason from public.workspaces where name = 'Quiet due') = 'closed/inactive', 'closed at 12 months';
  assert (select status from public.workspaces where id = current_setting('test.ws_a')::uuid) = 'active', 'paid business never closed';
  assert not exists (select 1 from public.email_outbox where to_address = 'owner@a.test' and template like 'inactive%'), 'paid business not warned';
  r := public.hq_inactivity_sweep();
  assert (r ->> 'warned_30')::int = 0 and (r ->> 'warned_7')::int = 0, 'no repeat warnings';
end $$;
-- signing in, or the website's touch, resets the clock
update auth.users set last_sign_in_at = now() where id = 'e1e1e1e1-0000-4000-8000-000000000001';
select pg_temp.as_user('e1e1e1e1-0000-4000-8000-000000000002'); set role authenticated;
select public.touch_activity();
reset role;
do $$ begin
  assert (select last_active_at > now() - interval '1 minute' from public.workspaces where name = 'Quiet 30'), 'sign-in resets the clock';
  assert (select last_active_at > now() - interval '1 minute' from public.workspaces where name = 'Quiet 7'), 'touch_activity resets the clock';
  assert not exists (select 1 from public.audit_log where action = 'workspaces.update' and details ? 'last_active_at'), 'activity isn''t change history';
end $$;
-- 2 years after closing: ready for removal (not removed)
update public.workspaces set closed_at = now() - interval '25 months' where name = 'Quiet due';
select public.hq_inactivity_sweep();
do $$ begin assert (select removal_state from public.workspaces where name = 'Quiet due') = 'ready', 'ready for removal';
  assert (select phone from public.workspaces where name = 'Quiet due') = '330 0000', 'nothing removed automatically'; end $$;
insert into public.support_tickets (id, workspace_id, opened_by, subject) values ('f2000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'e1e1e1e1-0000-4000-8000-000000000003', 'Pat''s question');
insert into public.support_messages (ticket_id, author, body) values ('f2000000-0000-4000-8000-000000000003', 'e1e1e1e1-0000-4000-8000-000000000003', 'Pat''s phone is 021 000');
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin
  assert json_array_length(public.hq_inactive_accounts() -> 'ready') = 1, 'Inactive accounts view: ready for removal';
  begin perform public.hq_remove_accounts(array['f0000000-0000-4000-8000-000000000003']::uuid[], 'Closed 2 years'); raise exception 'support removed accounts';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ begin
  begin perform public.hq_remove_accounts(array['f0000000-0000-4000-8000-000000000001']::uuid[], 'Not ready'); raise exception 'removed an active account';
  exception when others then assert sqlerrm like 'Only accounts marked%', sqlerrm; end;
  begin perform public.hq_remove_accounts(array['f0000000-0000-4000-8000-000000000003']::uuid[], ''); raise exception 'removed without a reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  assert public.hq_remove_accounts(array['f0000000-0000-4000-8000-000000000003']::uuid[], 'Closed 2 years, owner approved') = 1, 'removed one';
end $$;
reset role;
do $$ begin
  assert (select body from public.messages where workspace_id = 'f0000000-0000-4000-8000-000000000003') = '[removed]', 'message bodies removed';
  assert (select display_name from public.members where workspace_id = 'f0000000-0000-4000-8000-000000000003') = 'Removed person', 'names removed';
  assert (select name || coalesce(phone, '') from public.workspaces where id = 'f0000000-0000-4000-8000-000000000003') = 'Removed business', 'business details removed';
  assert (select body from public.support_messages where ticket_id = 'f2000000-0000-4000-8000-000000000003') = '[removed]', 'ticket text removed';
  assert (select subject from public.support_tickets where id = 'f2000000-0000-4000-8000-000000000003') = '[removed]', 'ticket subject removed';
  assert (select count(*) from public.workspaces where id = 'f0000000-0000-4000-8000-000000000003') = 1, 'rows kept (never deleted)';
  assert exists (select 1 from auth.users where id = 'e1e1e1e1-0000-4000-8000-000000000003'), 'login account not deleted here';
  assert exists (select 1 from pg_temp.audit('accounts.removed') where true and details::text not like '%Pat%'), 'anonymous record kept';
  assert not exists (select 1 from public.audit_log where workspace_id = 'f0000000-0000-4000-8000-000000000003' and details::text like '%Pat%'), 'history scrubbed';
end $$;

-- --- refunds (Island Traders: owner Jone, admin Mere; Vika is a plain member). Only the owner: refunds show amounts.
insert into auth.users values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'vika@c.test');
insert into public.members (workspace_id, user_id, display_name, role) values (:'ws_c', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'Vika', 'member');
select pg_temp.as_user('ffffffff-ffff-ffff-ffff-ffffffffffff'); set role authenticated;
do $$ begin begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'Accounting Basics', 'November', null, 50, 'USD', 'mistake', 'x', null);
  raise exception 'a member asked for a refund';
  exception when others then assert sqlerrm like 'Only the business''s owner can%', sqlerrm; end; end $$;
-- an admin (Mere, with two-step sign-in) can't ask for one either
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin assert (select role from public.members where workspace_id = current_setting('test.ws_c')::uuid and user_id = auth.uid()) = 'admin', 'Mere is an admin';
  begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'Accounting Basics', 'November', null, 50, 'USD', 'mistake', 'x', null);
  raise exception 'an admin asked for a refund';
  exception when others then assert sqlerrm like 'Only the business''s owner can%', sqlerrm; end; end $$;
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
select (public.request_refund(:'ws_c', 'Accounting Basics', 'November 2026', 'INV-0042', 350, 'USD', 'duplicate', 'We were charged twice this month.', null) ->> 'id') as rf \gset
select (public.request_refund(:'ws_c', 'POS', 'October 2026', null, 50, 'USD', 'didnt_work', 'The till never worked for us.', null) ->> 'id') as rf2 \gset
select set_config('test.rf', :'rf', false), set_config('test.rf2', :'rf2', false);
do $$ begin
  assert json_array_length(public.my_refunds(current_setting('test.ws_c')::uuid)) = 2, 'owner sees the requests';
  assert (public.my_refunds(current_setting('test.ws_c')::uuid) -> 0 ->> 'ref') ~ '^R-[0-9]{4,}$', 'refund number like R-1042';
  assert exists (select 1 from public.support_tickets where topic = 'billing' and subject like 'Refund request R-%'), 'a billing ticket for the conversation';
end $$;
-- the admin sees none of them (no amounts), through the action or the table
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin
  assert json_array_length(public.my_refunds(current_setting('test.ws_c')::uuid)) = 0, 'an admin sees no refund requests';
  assert (select count(*) from public.refund_requests) = 0, 'row rules: an admin reads no refund rows';
end $$;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  assert json_array_length(public.my_refunds(current_setting('test.ws_c')::uuid)) = 0, 'another business sees nothing';
  assert (select count(*) from public.refund_requests) = 0, 'row rules: nothing of Island Traders''';
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin
  assert json_array_length(public.hq_refunds('new') -> 'refunds') = 2, 'support can see refunds';
  begin perform public.hq_refund_decide(current_setting('test.rf')::uuid, 'approve', null, 'Double charge confirmed'); raise exception 'support approved a refund';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ begin
  begin perform public.hq_refund_decide(current_setting('test.rf')::uuid, 'approve', null, ''); raise exception 'approved without a reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  perform public.hq_refund_decide(current_setting('test.rf')::uuid, 'approve', null, 'Double charge confirmed in the bank statement');
  assert json_array_length(public.hq_refunds('second') -> 'refunds') = 1, 'over 200: waiting for a second approval';
  assert json_array_length(public.hq_approvals() -> 'refunds') = 1, 'in the Approvals queue';
  begin perform public.hq_refund_second(current_setting('test.rf')::uuid, 'me again'); raise exception 'same person approved twice';
  exception when others then assert sqlerrm like 'The same person can''t give both approvals%', sqlerrm; end;
  begin perform public.hq_refund_paid(current_setting('test.rf')::uuid, 'bank', 'TX1'); raise exception 'paid before the second approval';
  exception when others then assert sqlerrm like 'This refund needs a second approval%', sqlerrm; end;
end $$;
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
do $$ begin assert (public.my_refunds(current_setting('test.ws_c')::uuid) -> 1 ->> 'status') in ('reviewing', 'submitted'), 'customer doesn''t see half-approved as approved'; end $$;
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd');
select public.hq_refund_second(:'rf', 'Checked');
select public.hq_refund_paid(:'rf', 'credit', null);
select public.hq_refund_decide(:'rf2', 'decline', null, 'POS was used every day in October');
reset role;
do $$ begin
  assert (select status from public.refund_requests where id = current_setting('test.rf')::uuid) = 'paid', 'paid';
  assert (public.credit_json(current_setting('test.ws_c')::uuid) ->> 'USD')::numeric = 350, 'credit on account';
  assert exists (select 1 from pg_temp.audit('refund.approved') where true) and exists (select 1 from pg_temp.audit('refund.second_approved') where true)
     and exists (select 1 from pg_temp.audit('refund.paid') where true) and exists (select 1 from pg_temp.audit('refund.declined') where true), 'refund steps audited';
  assert exists (select 1 from public.email_outbox where template = 'refund_declined') and exists (select 1 from public.email_outbox where template = 'refund_paid')
     and exists (select 1 from public.email_outbox where template = 'refund_received'), 'refund emails queued';
  begin update public.refund_requests set second_approver = decided_by where id = current_setting('test.rf')::uuid; raise exception 'one person, two approvals';
  exception when check_violation then null; end;
  begin delete from public.refund_requests; raise exception 'deleted refunds';
  exception when others then assert sqlerrm like 'Rows in refund_requests are never deleted%', sqlerrm; end;
end $$;

-- --- free periods: up to 31 days apply straight away; longer waits for a supervisor (not the same person)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ declare o json; before date; begin
  before := (public.hq_company_licence(current_setting('test.ws_c')::uuid) -> 'licence' -> 'modules' -> 'pos' ->> 'trial_ends')::date;
  o := public.hq_grant_offer(current_setting('test.ws_c')::uuid, 'trial', array['pos'], 14, 'days', 'goodwill', 'Sorry about the printer trouble', null);
  assert (o ->> 'status') = 'applied' and (o ->> 'ref') ~ '^O-[0-9]{4,}$', format('applied straight away: %s', o);
  assert (public.hq_company_licence(current_setting('test.ws_c')::uuid) -> 'licence' -> 'modules' -> 'pos' ->> 'trial_ends')::date = before + 14, 'POS trial 14 days longer';
  before := (public.hq_company_licence(current_setting('test.ws_c')::uuid) -> 'licence' -> 'modules' -> 'basic' ->> 'paid_until')::date;
  o := public.hq_grant_offer(current_setting('test.ws_c')::uuid, 'paid', array['basic'], 3, 'months', 'retention', 'Thinking of leaving', null);
  assert (o ->> 'status') = 'waiting', 'over the limit: waits';
  perform set_config('test.offer', o ->> 'id', false); perform set_config('test.basic_before', before::text, false);
  assert (public.hq_company_licence(current_setting('test.ws_c')::uuid) -> 'licence' -> 'modules' -> 'basic' ->> 'paid_until')::date = before, 'not applied while waiting';
  begin perform public.hq_decide_offer((o ->> 'id')::uuid, true, null); raise exception 'support approved';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
do $$ begin begin perform public.hq_grant_offer(current_setting('test.ws_c')::uuid, 'trial', array['pos'], 7, 'days', 'other', 'test it', null); raise exception 'developer granted';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare o json; begin
  assert json_array_length(public.hq_approvals() -> 'offers') = 1, 'waiting in Approvals';
  o := public.hq_grant_offer(current_setting('test.ws_c')::uuid, 'account', null, 60, 'days', 'promotion', 'Launch promotion', null);
  begin perform public.hq_decide_offer((o ->> 'id')::uuid, true, null); raise exception 'approved own free period';
  exception when others then assert sqlerrm like 'The same person can''t ask for and approve%', sqlerrm; end;
  begin perform public.hq_decide_offer((o ->> 'id')::uuid, false, 'Promotion not running yet'); raise exception 'declined own free period';
  exception when others then assert sqlerrm like 'The same person can''t ask for and approve%', sqlerrm; end;
end $$;
reset role;
do $$ begin assert (select status from public.offers where reason = 'Launch promotion') = 'waiting', 'own request can''t be decided by yourself'; end $$;
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd'); set role authenticated;
do $$ declare m json; begin
  perform public.hq_decide_offer(current_setting('test.offer')::uuid, true, null);
  assert (public.hq_company_licence(current_setting('test.ws_c')::uuid) -> 'licence' -> 'modules' -> 'basic' ->> 'paid_until')::date
         = (current_setting('test.basic_before')::date + interval '3 months')::date, 'approved and applied: 3 more months';
  perform public.hq_decide_offer((select (x ->> 'id')::uuid from json_array_elements(public.hq_approvals() -> 'offers') x limit 1), false, 'Promotion not running yet');
  m := public.hq_approvals() -> 'month';
  assert (m ->> 'count')::int = 2 and (m -> 'by_reason' ->> 'goodwill')::int = 14, format('summary: %s', m);
  assert json_array_length(public.hq_company(current_setting('test.ws_c')::uuid) -> 'extra' -> 'offers') = 3, 'company panel shows offers';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.email_outbox where template = 'free_period') = 2, 'customer told twice (14 days, 3 months)';
  assert exists (select 1 from public.email_outbox where template = 'free_period' and body_text like 'Hi,%Good news: we''ve added 14 free days to POS — now free until %'), 'email wording';
  assert not exists (select 1 from public.email_outbox where body_text like '%printer trouble%'), 'internal reasons never emailed';
  assert exists (select 1 from pg_temp.audit('offer.approved') where true) and exists (select 1 from pg_temp.audit('offer.declined') where true), 'offers audited';
  begin delete from public.offers; raise exception 'deleted offers'; exception when others then assert sqlerrm like 'Rows in offers are never deleted%', sqlerrm; end;
end $$;
-- ===== HQ customer page & reports
reset role;
update auth.users set raw_user_meta_data = '{"riyeser_signup": {"you": "Alex Sample", "phone": "+679 330 1234", "country": "Fiji", "biz": {"name": "Sample Plumbing", "tax_number": "50-12345"}}, "riyeser_prefs": {"secret_pref": "do-not-show"}}'
  where id = '11111111-1111-1111-1111-111111111111';
update auth.users set raw_user_meta_data = '{"riyeser_signup": {"you": "Jordan", "phone": "021 555 0101"}}' where id = '44444444-4444-4444-4444-444444444444';
-- reports.view: owners, finance and senior support by default; not support, sales or developers
do $$ begin
  assert 'reports.view' = any(public.hq_all_perms()), 'new permission listed';
  assert 'reports.view' = any(public.hq_staff_perms('99999999-9999-9999-9999-999999999999')), 'owner';
  assert 'reports.view' = any(public.hq_staff_perms('dddddddd-dddd-dddd-dddd-dddddddddddd')), 'finance';
  assert 'reports.view' = any(public.hq_staff_perms('cccccccc-cccc-cccc-cccc-cccccccccccc')), 'senior';
  assert not 'reports.view' = any(public.hq_staff_perms('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')), 'not support';
  assert not 'reports.view' = any(coalesce(public.hq_staff_perms('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), '{}')), 'not developer';
  assert not 'reports.view' = any(public.hq_role_perms('sales')), 'not sales';
end $$;

-- --- Riyeser Central reports the programs on each PC: only someone in the business, only for a PC they linked
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
select public.link_device(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000001', 'Front desk PC', 'win32', '1.8.1');
select public.report_programs(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000001',
  '[{"id": "central", "version": "1.8.1"}, {"id": "pos", "version": "1.4.0"}, {"id": "pos", "version": "1.4.0"}, {"id": "BAD id; drop", "version": "x"}, "junk"]');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  begin perform public.report_programs(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001', '[{"id": "pos", "version": "9"}]');
    raise exception 'someone from another business reported programs';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin
  begin perform public.report_programs(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001', '[{"id": "pos", "version": "9"}]');
    raise exception 'reported programs for someone else''s PC';
  exception when others then assert sqlerrm like 'Link this PC to the company first%', sqlerrm; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.report_programs(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001', '[]'); raise exception 'anon reported';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare p jsonb; begin
  select programs into p from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001';
  assert p = '[{"id": "central", "version": "1.8.1"}, {"id": "pos", "version": "1.4.0"}]'::jsonb, format('programs stored cleanly: %s', p);
  assert (select programs_at is not null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001'), 'when';
end $$;
-- the {id: version} form works too
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
select public.report_programs(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000001', '{"central": "1.8.1", "pos": "1.4.1", "invoices": "2.0.0"}');
reset role;
do $$ begin assert (select jsonb_array_length(programs) from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001') = 3, 'object form'; end $$;

-- --- the customer page: contact person (with what they typed at sign-up), people, PCs with programs; never messages
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ declare c json; begin
  c := public.hq_company_page(current_setting('test.ws_a')::uuid);
  assert (c -> 'owner' ->> 'name') = 'Alex' and (c -> 'owner' ->> 'phone') = '+679 330 1234', format('owner contact: %s', c -> 'owner');
  assert (c -> 'owner' -> 'signup' ->> 'biz') = 'Sample Plumbing' and (c -> 'owner' -> 'signup' ->> 'tax_number') = '50-12345', 'sign-up details';
  assert c::text not like '%do-not-show%', 'only sign-up fields, nothing else kept with the account';
  assert json_array_length(c -> 'people') >= 3 and (c -> 'people' -> 0 ->> 'role') = 'owner', format('people, owner first: %s', c -> 'people');
  assert (select count(*) from json_array_elements(c -> 'people') p where p ->> 'phone' = '021 555 0101') = 1, 'phone from sign-up';
  assert (select count(*) from json_array_elements(c -> 'pcs') d where json_array_length(d -> 'programs') = 3) = 1, 'PC programs';
  assert (c -> 'licence' -> 'modules' -> 'pos' ->> 'status') is not null, 'licence';
  assert c::text not like '%Morning team%' and c::text not like '%Private: your pay rise%', 'no chat messages on the customer page';
end $$;
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
do $$ begin begin perform public.hq_company_page(current_setting('test.ws_a')::uuid); raise exception 'developer opened the customer page';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin begin perform public.hq_company_page(current_setting('test.ws_a')::uuid); raise exception 'customer opened HQ';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;

-- --- One PC counts once: Central's Fresh start links the same PC again under a new id; the older row is marked replaced
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
select public.link_device(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000002', 'front desk PC ', 'win32', '1.8.8');
reset role;
do $$ begin
  assert (select retired_at is not null and replaced_by = 'e1e1e1e1-0000-4000-8000-000000000002' from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001'),
    'the older link of the same PC (same name, same person) is marked replaced';
  assert (select retired_at is null and replaced_by is null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000002'), 'the new link counts';
  assert (select programs is not null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001'), 'the old row is kept as it was, never deleted';
end $$;
-- someone else's PC with the same name, and another of the owner's PCs, stay separate
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); set role authenticated;
select public.link_device(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000003', 'Front desk PC', 'win32', '1.8.8');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.link_device(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000004', 'Office laptop', 'win32', '1.8.8');
-- the old id reporting again (an old Central still running) takes over, and the new one takes it back
select public.report_programs(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000001', '{"central": "1.8.7"}');
reset role;
do $$ begin
  assert (select retired_at is null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001')
     and (select replaced_by = 'e1e1e1e1-0000-4000-8000-000000000001' from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000002'), 'reporting in marks the other row replaced';
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
select public.report_programs(:'ws_a', 'e1e1e1e1-0000-4000-8000-000000000002',
  '{"central": "1.8.8", "payroll": "2.2.3", "team": "1.1.0", "accounting-basics": "2.3.0"}');
reset role;
do $$ begin
  assert (select retired_at is not null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000001'), 'back to the newest';
  assert (select retired_at is null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000003'), 'another person''s PC with the same name stays';
  assert (select retired_at is null from public.devices where id = 'e1e1e1e1-0000-4000-8000-000000000004'), 'a PC with another name stays';
end $$;
-- the duplicates already in the database: same business, person and name, the most recently seen one stays (safe to repeat)
insert into public.devices (id, workspace_id, user_id, device_name, platform, app_version, linked_at, last_seen) values
  ('e1e1e1e1-0000-4000-8000-0000000000a1', :'ws_a', '22222222-2222-2222-2222-222222222222', 'Back office', 'win32', '1.8.5', now() - interval '40 days', now() - interval '30 days'),
  ('e1e1e1e1-0000-4000-8000-0000000000a2', :'ws_a', '22222222-2222-2222-2222-222222222222', 'BACK OFFICE', 'win32', '1.8.7', now() - interval '20 days', now() - interval '1 day'),
  ('e1e1e1e1-0000-4000-8000-0000000000a3', :'ws_a', '22222222-2222-2222-2222-222222222222', 'Back office', 'win32', '1.8.6', now() - interval '30 days', now() - interval '25 days');
do $$ declare n int; begin
  n := public.retire_duplicate_pcs();
  assert n = 2, format('two older rows marked: %s', n);
  assert (select retired_at is null from public.devices where id = 'e1e1e1e1-0000-4000-8000-0000000000a2'), 'the most recently seen stays';
  assert (select count(*) from public.devices where id in ('e1e1e1e1-0000-4000-8000-0000000000a1', 'e1e1e1e1-0000-4000-8000-0000000000a3')
          and retired_at is not null and replaced_by = 'e1e1e1e1-0000-4000-8000-0000000000a2') = 2, 'the older two are replaced by it';
  assert public.retire_duplicate_pcs() = 0, 'running it again changes nothing';
  assert (select count(*) from public.devices where workspace_id = current_setting('test.ws_a')::uuid and retired_at is not null
          and lower(trim(device_name)) = 'front desk pc' and user_id = '11111111-1111-1111-1111-111111111111') = 1, 'and leaves the rows already sorted out';
end $$;
-- not seen for 61 days: not counted either
update public.devices set last_seen = now() - interval '61 days' where id = 'e1e1e1e1-0000-4000-8000-000000000004';
select count(*) as pcs_expected from public.devices d where d.workspace_id = :'ws_a' and d.retired_at is null and d.last_seen > now() - interval '60 days' \gset
do $$ begin assert has_function_privilege('authenticated', 'public.retire_duplicate_pcs()', 'execute') = false
  and has_function_privilege('authenticated', 'public.retire_older_pcs(uuid, uuid)', 'execute') = false, 'only the database marks PCs replaced'; end $$;
select set_config('test.pcs_expected', :'pcs_expected', false);
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ declare c json; n int := current_setting('test.pcs_expected')::int; r json; begin
  c := public.hq_company_page(current_setting('test.ws_a')::uuid);
  assert (select count(*) from json_array_elements(c -> 'pcs') d where (d ->> 'active')::boolean) = n, format('the page marks %s PCs active: %s', n, c -> 'pcs');
  assert (select (d ->> 'active')::boolean = false and d ->> 'replaced_by' = 'e1e1e1e1-0000-4000-8000-000000000002' and d ->> 'retired_at' is not null
          from json_array_elements(c -> 'pcs') d where d ->> 'id' = 'e1e1e1e1-0000-4000-8000-000000000001'), 'the replaced PC is there, not active, with what replaced it';
  assert (select (d ->> 'active')::boolean = false from json_array_elements(c -> 'pcs') d where d ->> 'id' = 'e1e1e1e1-0000-4000-8000-000000000004'), 'not seen in 60 days: not active';
  assert (select (d ->> 'active')::boolean and d ->> 'name' = 'front desk PC ' and d ->> 'person' = 'Alex'
            and (d -> 'programs')::jsonb @> '[{"id": "payroll", "version": "2.2.3"}]'
          from json_array_elements(c -> 'pcs') d where d ->> 'id' = 'e1e1e1e1-0000-4000-8000-000000000002'), 'the PC: its name, who linked it, programs and versions';
  assert (select count(*) from json_array_elements(c -> 'pcs') d where (d ->> 'active')::boolean and (d -> 'programs')::jsonb @> '[{"id": "payroll"}]') = 1, 'Payroll on one PC';
  assert (select count(*) from json_array_elements(c -> 'pcs') d where (d ->> 'active')::boolean and (d -> 'programs')::jsonb @> '[{"id": "pos"}]') = 0, 'the old PC''s programs aren''t counted';
  assert (select (c2.pcs)::int from public.hq_companies('Sample Plumbing') c2 where c2.id = current_setting('test.ws_a')::uuid) = n, 'the companies list counts active PCs';
  r := public.hq_companies_page('Sample Plumbing', '{}', null, null, 1, 50, false);
  assert (select (x ->> 'pcs')::int from json_array_elements(r -> 'rows') x where (x ->> 'id')::uuid = current_setting('test.ws_a')::uuid) = n, 'and the paged list';
end $$;

-- --- Message customer: a ticket Riyeser starts, seen only by the person it's to (and the business's owners/admins)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select (public.hq_message_customer(:'ws_a', '44444444-4444-4444-4444-444444444444', 'billing', 'Your trial ends soon', 'Hi Jordan, would you like help choosing a plan?') ->> 'id') as t_staff \gset
select set_config('test.t_staff', :'t_staff', false);
do $$ declare r json; begin
  r := public.hq_message_customer(current_setting('test.ws_a')::uuid, null, 'other', 'Welcome to Riyeser', 'Hi, we''re here if you need a hand setting up.');
  perform set_config('test.t_welcome', r ->> 'id', false);
  begin perform public.hq_message_customer(current_setting('test.ws_a')::uuid, '33333333-3333-3333-3333-333333333333', 'other', 'Hi', 'Hello');
    raise exception 'messaged someone outside the business';
  exception when others then assert sqlerrm like 'Choose someone who is in this business%', sqlerrm; end;
  begin perform public.hq_message_customer(current_setting('test.ws_a')::uuid, null, 'other', '', 'Hello'); raise exception 'no subject';
  exception when others then assert sqlerrm like 'Add a subject%', sqlerrm; end;
end $$;
select pg_temp.as_user('cccccccc-cccc-cccc-cccc-cccccccccccc');
do $$ begin assert (select count(*) from json_array_elements(public.hq_tickets('waiting_customer', 'trial ends') -> 'tickets')) = 1, 'in the HQ inbox'; end $$;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
do $$ declare t json; begin
  select x into t from json_array_elements(public.my_tickets()) x where x ->> 'id' = current_setting('test.t_staff');
  assert t is not null and (t ->> 'from_riyeser')::boolean and (t ->> 'mine')::boolean, format('Jordan sees the message from Riyeser: %s', t);
  assert (t ->> 'unread')::int = 1, 'unread';
  t := public.my_ticket(current_setting('test.t_staff')::uuid);
  assert (t ->> 'from_riyeser')::boolean and (t -> 'messages' -> 0 ->> 'staff')::boolean and (t -> 'messages' -> 0 ->> 'from') = 'Riyeser Support', 'first message is from staff';
  assert not exists (select 1 from json_array_elements(public.my_tickets()) x where x ->> 'id' = current_setting('test.t_welcome')), 'not the one to the owner';
  perform public.reply_ticket(current_setting('test.t_staff')::uuid, 'Yes please, call me tomorrow.');
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin
  assert not exists (select 1 from json_array_elements(public.my_tickets()) x where x ->> 'id' in (current_setting('test.t_staff'), current_setting('test.t_welcome'))), 'Sam (a member) sees neither';
  begin perform public.my_ticket(current_setting('test.t_staff')::uuid); raise exception 'Sam opened it';
  exception when others then assert sqlerrm like 'We couldn%', sqlerrm; end;
end $$;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  assert not exists (select 1 from json_array_elements(public.my_tickets()) x where x ->> 'id' in (current_setting('test.t_staff'), current_setting('test.t_welcome'))), 'another business sees neither';
  begin perform public.my_ticket(current_setting('test.t_staff')::uuid); raise exception 'Kim opened it';
  exception when others then assert sqlerrm like 'We couldn%', sqlerrm; end;
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  assert (select count(*) from json_array_elements(public.my_tickets()) x where x ->> 'id' in (current_setting('test.t_staff'), current_setting('test.t_welcome'))) = 2, 'the owner sees both';
end $$;
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
do $$ begin begin perform public.hq_message_customer(current_setting('test.ws_a')::uuid, null, 'other', 'Hi', 'Hello'); raise exception 'developer messaged';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
reset role;
do $$ begin
  assert (select status from public.support_tickets where id = current_setting('test.t_staff')::uuid) = 'waiting_us', 'the reply puts it back with us';
  assert (select staff_started and first_reply_at is not null and assignee = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' from public.support_tickets where id = current_setting('test.t_staff')::uuid), 'staff-started';
  assert exists (select 1 from public.email_outbox where template = 'staff_message' and to_user = '44444444-4444-4444-4444-444444444444'
    and body_text like 'Hi Jordan,%would you like help choosing a plan?%Your help requests%' and status = 'queued'), 'emailed through the outbox';
  assert exists (select 1 from pg_temp.audit('ticket.started') where true), 'audited';
end $$;

-- --- logged calls, notes and follow-ups
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
select public.hq_note_add(:'ws_a', 'call', 'Asked about POS pricing for a second till', 'in', 'Alex', current_date + 2, false) as call_id \gset
select set_config('test.call_id', :'call_id', false);
select public.hq_note_add(:'ws_a', 'note', 'Prefers email to phone calls', null, null, null, true);
do $$ declare c json; f json; begin
  begin perform public.hq_note_add(current_setting('test.ws_a')::uuid, 'call', 'x', null, null, null, false); raise exception 'call without direction';
  exception when others then assert sqlerrm like 'Choose whether they called us%', sqlerrm; end;
  begin perform public.hq_note_add(current_setting('test.ws_a')::uuid, 'note', 'x', null, null, current_date - 1, false); raise exception 'follow-up in the past';
  exception when others then assert sqlerrm like 'Choose a follow-up date%', sqlerrm; end;
  f := public.hq_my_follow_ups();
  assert json_array_length(f) = 1 and (f -> 0 ->> 'business') = 'Sample Plumbing' and (f -> 0 ->> 'contact') = 'Alex', format('my follow-ups: %s', f);
  c := public.hq_company_page(current_setting('test.ws_a')::uuid);
  assert (c -> 'notes' -> 0 ->> 'pinned')::boolean and (c -> 'notes' -> 0 ->> 'body') = 'Prefers email to phone calls', 'pinned note first';
  assert (select count(*) from json_array_elements(c -> 'timeline') x where x ->> 'kind' = 'call' and x ->> 'status' = 'follow_up') = 1, 'call in the timeline';
  assert (select count(*) from json_array_elements(c -> 'timeline') x where x ->> 'kind' = 'ticket' and (x ->> 'by_staff')::boolean) = 2, 'staff-started tickets in the timeline';
  assert (select count(*) from json_array_elements(c -> 'timeline') x where x ->> 'kind' = 'email' and x ->> 'title' like 'Your trial ends soon%') = 1, 'emails in the timeline';
  assert (c -> 'timeline' -> 0 ->> 'at') >= (c -> 'timeline' -> 1 ->> 'at'), 'newest first';
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ begin assert json_array_length(public.hq_my_follow_ups()) = 0, 'follow-ups are per staff member'; end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select public.hq_follow_up_done(:'call_id');
do $$ begin
  assert json_array_length(public.hq_my_follow_ups()) = 0, 'ticked off';
  begin perform public.hq_follow_up_done(current_setting('test.call_id')::bigint); raise exception 'done twice';
  exception when others then assert sqlerrm like 'That follow-up is already done%', sqlerrm; end;
end $$;
select public.hq_note_add(:'ws_a', 'call', 'Call back about the second till', 'out', 'Alex', current_date, false);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin begin perform public.hq_note_add(current_setting('test.ws_a')::uuid, 'note', 'sneaky', null, null, null, false); raise exception 'customer wrote an HQ note';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;
reset role;
do $$ begin assert exists (select 1 from pg_temp.audit('call.logged') where (details ->> 'follow_up') is not null) and exists (select 1 from pg_temp.audit('follow_up.done') where true), 'audited'; end $$;
-- the owner-approved removal also blanks who a call was with
do $$ declare i bigint; begin
  insert into public.hq_notes (workspace_id, author, body, kind, direction, contact) values (current_setting('test.ws_b')::uuid, null, 'Rang Kim', 'call', 'out', 'Kim') returning id into i;
  perform set_config('riyeser.removing', 'on', true);
  update public.hq_notes set body = '[removed]' where id = i;
  perform set_config('riyeser.removing', 'off', true);
  assert (select contact is null and body = '[removed]' from public.hq_notes where id = i), 'contact blanked';
end $$;

-- --- one-click licence actions: free time goes through free periods (the 31-day limit and supervisor approval)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ declare o json; before date; waiting int; begin
  before := (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'bookings' ->> 'trial_ends')::date;
  o := public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'bookings', 'extend', 30, null, 'goodwill', 'Setting up took a while', current_setting('test.t_sam_ref'));
  assert (o ->> 'status') = 'applied' and (o ->> 'ref') like 'O-%', format('+30 days applied: %s', o);
  assert (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'bookings' ->> 'trial_ends')::date = greatest(before, current_date) + 30, '+30 days';
  o := public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'payroll', 'extend', 90, null, 'retention', 'Wants to try a full quarter', null);
  assert (o ->> 'status') = 'waiting', format('+90 days is over the limit: waits for a supervisor: %s', o);
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'extend', 7, null, 'goodwill', '', null); raise exception 'no reason';
  exception when others then assert sqlerrm like 'Give a reason%', sqlerrm; end;
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'extend', 7, null, 'payment', 'Paid by bank', null); raise exception 'wrong category';
  exception when others then assert sqlerrm like 'Choose a reason%', sqlerrm; end;
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'extend', 7, null, 'goodwill', 'For the printer', 'T-1'); raise exception 'bad ticket';
  exception when others then assert sqlerrm like 'There''s no ticket%', sqlerrm; end;
  -- support can't set paid-until, pause or cancel (licences.manage)
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'paid_until', null, current_date + 365, 'payment', 'Paid by bank', null); raise exception 'support set paid-until';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'pause', null, null, 'non_payment', 'Card declined', null); raise exception 'support paused';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare o json; l json; begin
  assert (select count(*) from json_array_elements(public.hq_approvals() -> 'offers') x where x ->> 'business' = 'Sample Plumbing' and (x ->> 'days')::int = 90) = 1, 'in Approvals';
  o := public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'paid_until', null, current_date + 365, 'payment', 'Paid a year by bank transfer', null);
  l := public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence';
  assert (l -> 'modules' -> 'pos' ->> 'status') = 'active' and (l -> 'modules' -> 'pos' ->> 'paid_until')::date = current_date + 365, 'paid until a year';
  -- +7 days on a paid program: free time on its paid period
  o := public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'extend', 7, null, 'goodwill', 'Printer trouble', null);
  assert (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'pos' ->> 'paid_until')::date = current_date + 372, 'paid period +7';
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'paid_until', null, current_date - 3, 'payment', 'Backdated', null); raise exception 'paid until in the past';
  exception when others then assert sqlerrm like 'Choose a date from today on%', sqlerrm; end;
  -- cancel: works to the end of what's paid; pause: stops now; unlock a lapsed paid program: paid for 30 days
  perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'cancel', null, null, 'customer_asked', 'Closing the second shop', null);
  l := public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence';
  assert (l -> 'modules' -> 'pos' ->> 'status') = 'cancelled' and (l -> 'modules' -> 'pos' ->> 'active')::boolean, 'cancelled, works to the end';
  perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'pause', null, null, 'non_payment', 'Card declined', null);
  assert not ((public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'pos' ->> 'active')::boolean), 'paused: stops now';
  perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'pos', 'unlock', null, null, 'goodwill', 'Paying next week', null);
  l := public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence';
  assert (l -> 'modules' -> 'pos' ->> 'status') = 'active' and (l -> 'modules' -> 'pos' ->> 'days_left')::int = 30, 'unlocked: paid for 30 days';
  -- a trial that ended: pause the As Built trial, then Unlock now gives it 30 days (as a free period, within the limit)
  if (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'as_built' ->> 'status') = 'trial' then
    perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'as_built', 'pause', null, null, 'correction', 'Test the trial end', null);
  end if;
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'as_built', 'pause', null, null, 'correction', 'Again', null); raise exception 'paused an ended trial';
  exception when others then assert sqlerrm like '%isn''t running%', sqlerrm; end;
  assert (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'as_built' ->> 'status') = 'ended', 'trial ended';
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ declare o json; begin
  o := public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'as_built', 'unlock', null, null, 'goodwill', 'Wants another look', null);
  assert (o ->> 'status') = 'applied', format('unlocked as a free period: %s', o);
  assert (public.hq_company_licence(current_setting('test.ws_a')::uuid) -> 'licence' -> 'modules' -> 'as_built' ->> 'days_left')::int = 30, 'trial to 30 days';
  begin perform public.hq_quick_licence(current_setting('test.ws_a')::uuid, 'as_built', 'unlock', null, null, 'goodwill', 'Again', null); raise exception 'unlocked twice';
  exception when others then assert sqlerrm like '%already on its trial%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from pg_temp.audit('licence.paid_until') where details ->> 'reason_category' = 'payment' and details -> 'was' ->> 'status' is not null), 'paid-until audited';
  assert exists (select 1 from pg_temp.audit('licence.paused') where true) and exists (select 1 from pg_temp.audit('licence.cancelled') where true)
     and exists (select 1 from pg_temp.audit('licence.unlocked') where true), 'pause, cancel, unlock audited';
  assert (select count(*) from public.offers where workspace_id = current_setting('test.ws_a')::uuid) = 4, 'free time went through free periods';
  assert (select paid_since from public.company_modules where workspace_id = current_setting('test.ws_a')::uuid and module = 'pos') = current_date, 'paid since';
end $$;

-- --- the Companies list: filters, sorting and server-side pages
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ declare p1 json; p2 json; n int; r json; begin
  n := (select count(*) from public.hq_companies(''));
  p1 := public.hq_companies_page('', '{}', 'name', false, 1, 2, false);
  p2 := public.hq_companies_page('', '{}', 'name', false, 2, 2, false);
  assert (p1 ->> 'total')::int >= 100 and (p1 ->> 'total')::int = n, format('total count: %s of %s', p1 ->> 'total', n);
  assert json_array_length(p1 -> 'rows') = 2 and json_array_length(p2 -> 'rows') = 2, 'two a page';
  assert lower(p1 -> 'rows' -> 0 ->> 'name') <= lower(p1 -> 'rows' -> 1 ->> 'name') and lower(p1 -> 'rows' -> 1 ->> 'name') <= lower(p2 -> 'rows' -> 0 ->> 'name'), 'sorted by name across pages';
  assert (p1 -> 'rows' -> 0 ->> 'id') <> (p2 -> 'rows' -> 0 ->> 'id'), 'page 2 is different';
  assert (public.hq_companies_page('', '{}', null, null, 1, 1000, false) ->> 'per_page')::int = 200, 'at most 200 a page';
  assert json_array_length(public.hq_companies_page('', '{}', null, null, 1, null, false) -> 'rows') = 50, '50 a page by default';
  r := public.hq_companies_page('island', '{}', null, null, 1, 50, false);
  assert (r ->> 'total')::int = 1 and (r -> 'rows' -> 0 ->> 'name') = 'Island Traders', 'search';
  r := public.hq_companies_page('', '{"plan": "paid"}', 'plan', true, 1, 200, false);
  assert (r ->> 'total')::int >= 2 and not exists (select 1 from json_array_elements(r -> 'rows') x where (x ->> 'paid_n')::int = 0), 'paying only';
  assert (r -> 'rows' -> 0 ->> 'paid_n')::int >= (r -> 'rows' -> 1 ->> 'paid_n')::int, 'sorted by plan, most first';
  r := public.hq_companies_page('', '{"plan": "trial", "trial_days": 30}', 'trial', false, 1, 200, false);
  assert not exists (select 1 from json_array_elements(r -> 'rows') x where (x ->> 'paid_n')::int > 0 or (x ->> 'trial_days')::int > 30), 'trial ending in 30 days';
  r := public.hq_companies_page('', '{"status": "closed"}', null, null, 1, 200, false);
  assert not exists (select 1 from json_array_elements(r -> 'rows') x where x ->> 'status' <> 'closed'), 'status filter';
  r := public.hq_companies_page('', '{"open_tickets": true}', 'tickets', true, 1, 200, false);
  assert (r ->> 'total')::int >= 1 and not exists (select 1 from json_array_elements(r -> 'rows') x where (x ->> 'tickets_open')::int = 0), 'open tickets';
  r := public.hq_companies_page('', '{"follow_up": true}', null, null, 1, 200, false);
  assert exists (select 1 from json_array_elements(r -> 'rows') x where x ->> 'name' = 'Sample Plumbing'), 'needs follow-up';
  r := public.hq_companies_page('', '{"country": "Fiji"}', null, null, 1, 200, false);
  assert not exists (select 1 from json_array_elements(r -> 'rows') x where coalesce(x ->> 'country', '') <> 'Fiji'), 'country';
  r := public.hq_companies_page('sample plumbing', '{}', null, null, 1, 50, false);
  assert (r -> 'rows' -> 0 ->> 'phone') = '+679 330 1234' and (r -> 'rows' -> 0 ->> 'owner_name') = 'Alex', 'owner and phone';
  r := public.hq_companies_page('', '{"inactive_days": 30}', null, null, 1, 200, false);
  assert not exists (select 1 from json_array_elements(r -> 'rows') x where (x ->> 'last_active_at')::timestamptz > now() - interval '30 days'), 'inactive 30 days';
  perform public.hq_companies_page('', '{"plan": "paid"}', null, null, 1, 5000, true);
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin begin perform public.hq_companies_page('', '{}', null, null, 1, 50, false); raise exception 'customer listed businesses';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;
reset role;
do $$ begin assert exists (select 1 from pg_temp.audit('customers.exported') where true), 'CSV export is logged'; end $$;

-- --- Reports (reports.view) and the HQ home
reset role;
select set_config('test.ws_b', :'ws_b', false);
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_set_module(:'ws_b', 'pos', 'trial', (current_date + 2), null);
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin begin perform public.hq_reports(current_date - 30, current_date); raise exception 'support read reports';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd');
do $$ declare r json; begin
  r := public.hq_reports(current_date - 90, current_date);
  assert (r -> 'funnel' ->> 'signed_up')::int >= 5 and (r -> 'funnel' ->> 'business')::int >= 3 and (r -> 'funnel' ->> 'pc_linked')::int >= 1
     and (r -> 'funnel' ->> 'program_used')::int >= 1, format('funnel: %s', r -> 'funnel');
  assert json_array_length(r -> 'signups_by_week') >= 1 and json_array_length(r -> 'trials_by_week') >= 1, 'weekly';
  assert exists (select 1 from json_array_elements(r -> 'trials_ending') x where x ->> 'name' = 'Corner Cafe' and (x ->> 'days_left')::int = 2), 'trials ending';
  assert exists (select 1 from json_array_elements(r -> 'conversion') x where x ->> 'module' = 'pos' and (x ->> 'paid_30')::int >= 1), 'conversion';
  assert (select (x ->> 'estimate')::numeric from json_array_elements(r -> 'revenue_by_month') x order by x ->> 'month' desc limit 1) >= 40, format('revenue estimate: %s', r -> 'revenue_by_month');
  assert json_array_length(r -> 'leaving_by_month') >= 3 and (r -> 'support' ->> 'opened')::int >= 3, 'leaving and support';
  assert (r -> 'support' -> 'open_by_status') is not null and (r -> 'support' ->> 'median_first_reply_hours') is not null, 'support numbers';
  assert exists (select 1 from json_array_elements(r -> 'staff_week') x where x ->> 'who' = 'Help Desk' and (x ->> 'changes')::int >= 5), 'staff activity';
  assert r::text not like '%Morning team%', 'no chat in reports';
  begin perform public.hq_reports(current_date, current_date - 5); raise exception 'backwards range';
  exception when others then assert sqlerrm like 'Choose a start date%', sqlerrm; end;
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ declare a json; begin
  a := public.hq_attention();
  assert (a ->> 'unassigned')::int >= 0 and (a ->> 'overdue') is not null, 'tickets';
  assert exists (select 1 from json_array_elements(a -> 'trials_3d') x where x ->> 'name' = 'Corner Cafe'), format('trials ending in 3 days: %s', a -> 'trials_3d');
  assert json_array_length(a -> 'follow_ups') = 1 and (a -> 'follow_ups' -> 0 ->> 'due')::boolean, 'my follow-up due today';
  assert (a ->> 'approvals') is null, 'support doesn''t approve, so no approvals count';
end $$;
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd');
do $$ begin assert (public.hq_attention() ->> 'approvals')::int >= 1, 'finance sees approvals waiting'; end $$;
reset role;

-- --- the Riyeser account owner, team handover, the work queue and sign-ups
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
select public.hq_set_owner(:'ws_a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ declare c json; r json; begin
  c := public.hq_company_page(current_setting('test.ws_a')::uuid);
  assert (c -> 'profile' ->> 'hq_owner_name') = 'Help Desk', 'Riyeser owner on the customer page';
  r := public.hq_companies_page('', '{"mine": true}', null, null, 1, 50, false);
  assert (r ->> 'total')::int = 1 and (r -> 'rows' -> 0 ->> 'hq_owner_name') = 'Help Desk', format('My customers: %s', r ->> 'total');
  assert (r -> 'rows' -> 0 ->> 'next_follow_up') is not null and (c -> 'next_follow_up' ->> 'date') is not null, 'next promised follow-up';
  begin perform public.hq_set_owner(current_setting('test.ws_a')::uuid, '11111111-1111-1111-1111-111111111111'); raise exception 'a customer as Riyeser owner';
  exception when others then assert sqlerrm like 'Choose someone on the HQ team%', sqlerrm; end;
end $$;
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
do $$ begin begin perform public.hq_set_owner(current_setting('test.ws_a')::uuid, null); raise exception 'developer set the owner';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select public.hq_handover_add('Harbour complaint: update the customer after 3 pm', null) as ho \gset
select set_config('test.ho', :'ho', false);
do $$ declare h json; q json; s json; begin
  h := public.hq_handover();
  assert (h -> 0 ->> 'note') like 'Harbour complaint%' and (h -> 0 ->> 'by') = 'Help Desk' and not (h -> 0 ->> 'done')::boolean, 'handover note';
  perform public.hq_handover_done(current_setting('test.ho')::bigint);
  begin perform public.hq_handover_done(current_setting('test.ho')::bigint); raise exception 'done twice';
  exception when others then assert sqlerrm like 'That handover note is already done%', sqlerrm; end;
  begin perform public.hq_handover_add('  ', null); raise exception 'empty handover';
  exception when others then assert sqlerrm like 'Write the handover%', sqlerrm; end;
  q := public.hq_work_queue();
  assert (q -> 'counts' ->> 'new_signups') is not null and (q -> 'counts' ->> 'failed_payments')::int = 0 and (q -> 'counts' ->> 'open_complaints')::int >= 1, format('counts: %s', q -> 'counts');
  assert exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'issue' like '%complaint' and x ->> 'action' = 'Reply'), 'complaints in the queue';
  assert exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'action' = 'Extend' and x ->> 'business' = 'Corner Cafe'), format('renewals in the queue: %s', q -> 'queue');
  assert exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'action' = 'Follow up'), 'my follow-ups in the queue';
  assert not exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'action' = 'Approve'), 'support doesn''t approve';
  s := public.hq_signups(30);
  assert exists (select 1 from json_array_elements(s) x where x ->> 'name' = 'Corner Cafe' and (x ->> 'email_verified')::boolean and (x ->> 'on_trial')::boolean
    and not (x ->> 'pc_linked')::boolean and not (x ->> 'program_used')::boolean), 'sign-up stages: not set up yet';
  assert exists (select 1 from json_array_elements(s) x where x ->> 'name' = 'Island Traders' and (x ->> 'paying')::boolean), 'sign-up stages: paying';
  assert s::text not like '%Morning team%', 'no chat in sign-ups';
end $$;
reset role;
do $$ begin
  assert exists (select 1 from pg_temp.audit('customer.owner_set') where details ->> 'now' = 'Help Desk') and exists (select 1 from pg_temp.audit('handover.added') where true)
    and exists (select 1 from pg_temp.audit('handover.done') where true), 'owner and handover audited';
  begin delete from public.hq_handover_notes; raise exception 'deleted handover'; exception when others then assert sqlerrm like 'Rows in hq_handover_notes are never deleted%', sqlerrm; end;
end $$;
-- privacy: none of HQ's new views contain customers' chat messages
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  assert public.hq_company(current_setting('test.ws_a')::uuid)::text not like '%Morning team%', 'no chat in the company panel';
  assert public.hq_tickets('all', null)::text not like '%Morning team%', 'no chat in the inbox';
end $$;
reset role;

-- ===== Riyeser Link Office: status, phones, changes from the web, one-off password Show, "Let Riyeser help"
reset role;
insert into auth.users values ('c0c0c0c0-0000-4000-8000-000000000001', 'boss@link.test'), ('c0c0c0c0-0000-4000-8000-000000000002', 'desk@link.test'),
  ('c0c0c0c0-0000-4000-8000-000000000003', 'frontpc@link.test'), ('c0c0c0c0-0000-4000-8000-000000000004', 'nosy@link.test'),
  ('c0c0c0c0-0000-4000-8000-000000000005', 'phones@riyeser.test'), ('c0c0c0c0-0000-4000-8000-000000000006', 'books@riyeser.test'),
  ('c0c0c0c0-0000-4000-8000-000000000007', 'code@riyeser.test');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
select (public.create_company('Sample Phones Co', 'Pat', '{"country":"Fiji"}'::jsonb) ->> 'workspace_id') as ws_l \gset
select set_config('test.ws_l', :'ws_l', false);
reset role;
insert into public.members (workspace_id, user_id, display_name, role) values (:'ws_l', 'c0c0c0c0-0000-4000-8000-000000000002', 'Desk Staff', 'member'),
  (:'ws_l', 'c0c0c0c0-0000-4000-8000-000000000003', 'Front PC', 'member');
insert into public.devices (id, workspace_id, user_id, device_name) values (gen_random_uuid(), :'ws_l', 'c0c0c0c0-0000-4000-8000-000000000003', 'Office PC');
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_add_staff('phones@riyeser.test', 'Phone Help', 'support');
select public.hq_add_staff('books@riyeser.test', 'Books Fin', 'finance');
select public.hq_add_staff('code@riyeser.test', 'Code Dev', 'developer');
reset role;
do $$ begin
  assert 'link.support' = any(public.hq_all_perms()), 'link.support is a permission';
  assert 'link.support' = any(public.hq_role_perms('support')) and 'link.support' = any(public.hq_role_perms('senior')), 'support and senior have it';
  assert not ('link.support' = any(public.hq_role_perms('finance'))), 'finance does not';
end $$;
-- the heartbeat (from the PC linked to the business). Calls are counted, never listed.
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare r json; ws uuid := current_setting('test.ws_l')::uuid; begin
  r := public.link_office_report(ws, 'office-0001-abcd', jsonb_build_object(
    'office_id', 'office-0001-abcd', 'pc_name', 'OFFICE-PC', 'version', '1.1.0', 'state', 'running', 'addresses', jsonb_build_array('192.168.1.20', 'not an address'),
    'sip_port', 5060, 'address_stable', false, 'pc_mac', 'AA:BB:CC:DD:EE:FF', 'licence', jsonb_build_object('active', true, 'state', 'trial', 'text', 'Free trial · 40 days left'),
    'counts', jsonb_build_object('people', 3, 'phones_assigned', 2, 'phones_connected', 1, 'calls_in_progress', 1),
    'calls', jsonb_build_array(jsonb_build_object('from', '101', 'to', '0412345678')),
    'phones', jsonb_build_array(jsonb_build_object('mac', '00:15:65:AA:BB:CC', 'vendor', 'yealink', 'model', 'T31P', 'extension', '101', 'assigned', true, 'registered', true,
        'last_registered', '2026-11-24T09:58:00Z', 'ip', '192.168.1.31', 'password', 'NotStored123'),
      jsonb_build_object('mac', '000b82112233', 'vendor', 'grandstream', 'assigned', false, 'ip', '192.168.1.40'),
      jsonb_build_object('mac', 'nonsense')),
    'extensions', jsonb_build_array(jsonb_build_object('extension', '101', 'name', 'Pat', 'type', 'person', 'registered', 1, 'desk_phones', 1, 'dnd', false),
      jsonb_build_object('extension', '100', 'name', 'Head office', 'type', 'group', 'members', 2))));
  assert (r ->> 'ok')::boolean and (r ->> 'pending')::int = 0, format('reported: %s', r);
  perform public.link_office_report(ws, 'office-0001-abcd', '{"pc_name":"OFFICE-PC","version":"1.1.0","addresses":["192.168.1.20"],"sip_port":5060,"address_stable":false,"phones":[{"mac":"001565aabbcc","extension":"101","assigned":true,"registered":true,"ip":"192.168.1.31"},{"mac":"000b82112233","vendor":"grandstream","assigned":false}],"extensions":[{"extension":"101","name":"Pat","registered":1}],"counts":{"people":3,"calls_in_progress":1}}');
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.link_offices) = 1 and (select count(*) from public.link_office_phones) = 2, 'one office, two phones (bad MAC dropped, no duplicates)';
  assert (select addresses from public.link_offices) = array['192.168.1.20'], 'only real addresses kept';
  assert not (select address_stable from public.link_offices), 'not stable';
  assert (select to_jsonb(o)::text from public.link_offices o) not like '%0412345678%', 'no numbers dialled kept';
  assert (select coalesce(string_agg(to_jsonb(p)::text, ''), '') from public.link_office_phones p) not like '%NotStored%', 'nothing extra kept from a phone';
  assert (select counts ->> 'calls_in_progress' from public.link_offices) = '1', 'calls in progress: a count only';
end $$;
-- Link Office 1.2.0: the PC's names and its last address changes (each checked; anything else dropped)
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; o json; begin
  perform public.link_office_report(ws, 'office-0001-abcd', '{"pc_name":"OFFICE-PC","version":"1.2.0","addresses":["192.168.1.20"],"sip_port":5060,"address_stable":false,"mdns_name":"Riyeser-Office.local","router_name":"office-pc.lan","phone_server":"-bad name; drop","address_changes":[{"from":"192.168.1.9","to":"192.168.1.20","at":"2026-11-27T01:00:00Z","source":"os","extra":"x"},{"from":"nope","to":"192.168.1.20"},{"from":"192.168.1.8","to":"192.168.1.9","at":"2026-11-20T01:00:00Z"}],"phones":[{"mac":"001565aabbcc","extension":"101","assigned":true,"registered":true,"ip":"192.168.1.31"},{"mac":"000b82112233","vendor":"grandstream","assigned":false}],"extensions":[{"extension":"101","name":"Pat","registered":1}],"counts":{"people":3,"calls_in_progress":1}}');
  o := (public.link_status(ws) -> 'offices') -> 0;
  assert o ->> 'mdns_name' = 'riyeser-office.local' and o ->> 'router_name' = 'office-pc.lan', format('names kept: %s', o);
  assert o ->> 'phone_server' is null, 'a bad phone server name is dropped';
  assert json_array_length(o -> 'address_changes') = 2 and (o -> 'address_changes' -> 0 ->> 'from') = '192.168.1.9'
    and (o -> 'address_changes' -> 0) ->> 'source' is null, format('address changes: real ones only, listed fields only: %s', o -> 'address_changes');
end $$;
reset role;
-- someone who isn't in the business can't report or read; a member without an admin role or linked PC can't report
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000004'); set role authenticated;
do $$ begin
  begin perform public.link_office_report(current_setting('test.ws_l')::uuid, 'office-0001-abcd', '{}'); raise exception 'stranger reported';
  exception when others then assert sqlerrm like 'Sign in to Riyeser Link Office%', sqlerrm; end;
  begin perform public.link_status(current_setting('test.ws_l')::uuid); raise exception 'stranger read status';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
  begin perform public.link_office_pending(current_setting('test.ws_l')::uuid, 'office-0001-abcd'); raise exception 'stranger polled';
  exception when others then assert sqlerrm like 'Sign in to Riyeser Link Office%', sqlerrm; end;
  assert (select count(*) from public.link_offices) = 0 and (select count(*) from public.link_office_phones) = 0, 'stranger sees no offices';
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.link_office_report(current_setting('test.ws_l')::uuid, 'office-0002-abcd', '{}'); raise exception 'plain member reported';
  exception when others then assert sqlerrm like 'Sign in to Riyeser Link Office%', sqlerrm; end;
  -- members see their own business's offices
  assert (select count(*) from public.link_offices) = 1 and (select count(*) from public.link_office_phones) = 2, 'member sees the office and phones';
  assert json_array_length(public.link_status(current_setting('test.ws_l')::uuid) -> 'offices') = 1, 'member sees the status';
  assert (public.link_status(current_setting('test.ws_l')::uuid) -> 'offices' -> 0 ->> 'pc_name') = 'OFFICE-PC', 'pc name';
  -- only two-step admins can send changes
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'member sent a change';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  assert (select count(*) from public.link_office_commands) = 0, 'members can''t see changes';
end $$;
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'owner without 2-step sent a change';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.link_support_allow(current_setting('test.ws_l')::uuid); raise exception 'let Riyeser help without 2-step';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- the owner with two-step: changes go to the office, which applies them and says how it went
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; a uuid; b uuid; begin
  a := public.link_command(ws, 'office-0001-abcd', 'assign_phone', '{"mac":"00-0B-82-11-22-33","extension":"102"}');
  b := public.link_command(ws, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}');
  perform public.link_command(ws, 'office-0001-abcd', 'add_phone', '{"mac":"000413445566","vendor":"snom","extension":"101"}');
  perform public.link_command(ws, 'office-0001-abcd', 'new_password', '{"extension":"101"}');
  perform public.link_command(ws, 'office-0001-abcd', 'unassign_phone', '{"mac":"001565aabbcc"}');
  perform set_config('test.cmd_a', a::text, false); perform set_config('test.cmd_b', b::text, false);
  assert (select data ->> 'mac' from public.link_office_commands where id = a) = '000b82112233', 'MAC tidied';
  assert (public.link_command_state(a) ->> 'status') = 'pending', 'pending';
  begin perform public.link_command(ws, 'office-0001-abcd', 'assign_phone', '{"mac":"12345","extension":"102"}'); raise exception 'bad MAC';
  exception when others then assert sqlerrm like 'That isn''t a MAC address%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'add_phone', '{"mac":"000413445566","vendor":"acme","extension":"101"}'); raise exception 'bad maker';
  exception when others then assert sqlerrm like 'Choose the phone''s maker%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-9999-zzzz', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'unknown office';
  exception when others then assert sqlerrm like 'That Riyeser Link Office hasn''t been in touch%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'reboot_pc', '{}'); raise exception 'unknown kind';
  exception when others then assert sqlerrm like 'Riyeser Link Office doesn''t know%', sqlerrm; end;
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.set_dnd' and details ->> 'extension' = '101'), 'changes are in the history';
end $$;
-- B's owner can't send changes to this business
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'other owner sent a change';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.link_command_state(current_setting('test.cmd_a')::uuid); raise exception 'other owner read a change';
  exception when others then assert sqlerrm like 'That change isn''t one of yours%', sqlerrm; end;
end $$;
-- the office picks them up and answers
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
do $$ declare p json; begin
  p := public.link_office_pending(current_setting('test.ws_l')::uuid, 'office-0001-abcd');
  assert json_array_length(p) = 5 and (p -> 0 ->> 'kind') = 'assign_phone', format('five waiting: %s', p);
  perform public.link_office_done(current_setting('test.cmd_a')::uuid, true, null, null);
  perform public.link_office_done(current_setting('test.cmd_b')::uuid, false, 'No one has that extension.', null);
  assert json_array_length(public.link_office_pending(current_setting('test.ws_l')::uuid, 'office-0001-abcd')) = 3, 'three left';
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin
  assert (public.link_command_state(current_setting('test.cmd_a')::uuid) ->> 'status') = 'done', 'done';
  assert (public.link_command_state(current_setting('test.cmd_b')::uuid) ->> 'error') = 'No one has that extension.', 'failed with a plain reason';
end $$;
-- Show password: the browser's one-off public key goes to the office; the office sends back the password encrypted to it
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; r uuid; begin
  begin perform public.link_command(ws, 'office-0001-abcd', 'reveal_password', '{"extension":"101"}'); raise exception 'show with no key';
  exception when others then assert sqlerrm like 'This browser can''t show passwords safely%', sqlerrm; end;
  r := public.link_command(ws, 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('A', 342), 'e', 'AQAB', 'd', 'PRIVATE')));
  perform set_config('test.rev', r::text, false);
  assert (select data -> 'key' ->> 'd' from public.link_office_commands where id = r) is null, 'only the public part of the key is kept';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.reveal_password' and actor = auth.uid()), 'every Show is in the history';
end $$;
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
select public.link_office_done(current_setting('test.rev')::uuid, true, null, 'U2NyYW1ibGVkUGFzc3dvcmQ=');
-- another admin (or anyone else) can't take it; the asker can, once
reset role;
update public.members set role = 'admin' where workspace_id = :'ws_l' and user_id = 'c0c0c0c0-0000-4000-8000-000000000002';
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000002'); set role authenticated;
do $$ begin
  begin perform public.link_reveal_take(current_setting('test.rev')::uuid); raise exception 'another admin took the password';
  exception when others then assert sqlerrm like 'There''s no password waiting for you%', sqlerrm; end;
  assert (select count(*) from public.link_office_reveals) = 0, 'another admin can''t see the row';
  assert not (public.link_command_state(current_setting('test.rev')::uuid) ->> 'ready')::boolean, 'not ready for someone else';
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ begin
  assert (public.link_command_state(current_setting('test.rev')::uuid) ->> 'ready')::boolean, 'ready for the asker';
  assert (select count(*) from public.link_office_reveals) = 1, 'the asker sees the row';
  begin perform sealed from public.link_office_reveals; raise exception 'read the scrambled password directly';
  exception when insufficient_privilege then null; end;
  assert public.link_reveal_take(current_setting('test.rev')::uuid) = 'U2NyYW1ibGVkUGFzc3dvcmQ=', 'taken';
  assert public.link_reveal_take(current_setting('test.rev')::uuid) is null, 'only once';
end $$;
reset role;
do $$ begin assert (select sealed from public.link_office_reveals where command_id = current_setting('test.rev')::uuid) is null, 'blanked straight after'; end $$;
-- one not taken in time: blanked after 5 minutes, and the row is no longer visible
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
select public.link_command(:'ws_l', 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('B', 342), 'e', 'AQAB'))) as rev2 \gset
select set_config('test.rev2', :'rev2', false);
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
select public.link_office_done(:'rev2', true, null, 'QW5vdGhlck9uZQ==');
reset role;
update public.link_office_reveals set created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' where command_id = :'rev2';
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ begin
  assert (select count(*) from public.link_office_reveals where command_id = current_setting('test.rev2')::uuid) = 0, 'expired: not visible';
  assert public.link_reveal_take(current_setting('test.rev2')::uuid) is null, 'expired: nothing to take';
end $$;
-- an office that answers too late gets nothing stored
select public.link_command(:'ws_l', 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('C', 342), 'e', 'AQAB'))) as rev3 \gset
reset role;
update public.link_office_commands set created_at = now() - interval '4 minutes 59 seconds' where id = :'rev3';
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
select public.link_office_done(:'rev3', true, null, 'TGF0ZQ==');
reset role;
do $$ begin
  -- no password copy outlives the 5 minutes: after any check-in, every expired or read one is blank
  perform public.link_sweep();
  assert not exists (select 1 from public.link_office_reveals where sealed is not null and (expires_at <= now() or read_at is not null)), 'nothing persists past the window';
  assert not exists (select 1 from public.link_office_reveals where expires_at > created_at + interval '5 minutes'), 'never kept longer than 5 minutes';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name like 'link_%' and column_name ilike '%password%'), 'no password column anywhere';
  assert not exists (select 1 from public.link_office_commands where data::text ilike '%password%'), 'no password in any change';
  assert not exists (select 1 from public.audit_log where details::text like '%U2NyYW1ibGVk%' or details::text like '%QW5vdGhlck9uZQ%'), 'never in the history';
end $$;
-- HQ: hq_company_link needs customers.view; sending changes needs link.support AND the customer's "Let Riyeser help"
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000007'); set role authenticated;
do $$ begin
  begin perform public.hq_company_link(current_setting('test.ws_l')::uuid); raise exception 'developer saw the phones';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000006');
do $$ declare j json; begin
  j := public.hq_company_link(current_setting('test.ws_l')::uuid);
  assert (j -> 'offices' -> 0 ->> 'pc_name') = 'OFFICE-PC' and json_array_length(j -> 'offices' -> 0 -> 'phones') = 2, format('finance sees the summary: %s', j);
  assert not (j ->> 'can_help')::boolean and (j ->> 'support') is null, 'finance can''t help; no access given';
  assert j::text not ilike '%password%' and j::text not like '%sealed%', 'no passwords in HQ';
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":false}'); raise exception 'finance sent a change';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin
  assert (public.hq_company_link(current_setting('test.ws_l')::uuid) ->> 'can_help')::boolean, 'support can help';
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":false}'); raise exception 'support sent a change without the customer allowing it';
  exception when others then assert sqlerrm like 'Ask the customer to press ''Let Riyeser help''%', sqlerrm; end;
  begin perform public.link_support_allow(current_setting('test.ws_l')::uuid); raise exception 'support let itself in';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- the owner presses "Let Riyeser help": 1 hour, in both histories
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
do $$ declare r json; begin
  r := public.link_support_allow(current_setting('test.ws_l')::uuid);
  assert (r ->> 'until')::timestamptz between now() + interval '59 minutes' and now() + interval '61 minutes', 'one hour';
  assert (public.link_status(current_setting('test.ws_l')::uuid) -> 'support' ->> 'until') is not null, 'the Phones page shows it';
  assert exists (select 1 from public.audit_log where action = 'link.support_allowed'), 'in the business''s history';
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ declare c uuid; r uuid; begin
  assert (public.hq_company_link(current_setting('test.ws_l')::uuid) -> 'support' ->> 'until') is not null, 'HQ sees until when';
  c := public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":false}');
  assert (public.link_command_state(c) ->> 'status') = 'pending', 'support can follow its own change';
  -- SEC-009: support never sees a phone password: no Show; Set a new password asks Link Office to make one itself
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('D', 342), 'e', 'AQAB')));
    raise exception 'support asked to see a password';
  exception when others then assert sqlerrm like 'Riyeser support can''t see phone passwords%', sqlerrm; end;
  r := public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'new_password', '{"extension":"101","password":"Chosen123"}');
  perform set_config('test.hqrev', r::text, false);
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.link_office_commands where by_riyeser) = 2, 'marked as Riyeser';
  assert not exists (select 1 from public.link_office_commands where by_riyeser and kind = 'reveal_password'), 'no Show by Riyeser';
  assert (select data from public.link_office_commands where id = current_setting('test.hqrev')::uuid) = '{"extension": "101"}'::jsonb, 'only the extension goes to the office (nothing support typed)';
  assert exists (select 1 from public.hq_audit where action = 'link.new_password' and workspace_id = current_setting('test.ws_l')::uuid and actor = 'c0c0c0c0-0000-4000-8000-000000000005'), 'the reset in the HQ history, with who asked';
  assert exists (select 1 from public.hq_audit where action = 'link.support_allowed' and workspace_id = current_setting('test.ws_l')::uuid), 'allowing it is in the HQ history';
  assert exists (select 1 from public.audit_log where action = 'link.new_password' and actor is null and details ->> 'by' = 'Riyeser support'), 'customer sees "Riyeser support" asked for a new password';
end $$;
-- the office makes the password itself and only says "done" (a sealed copy is ignored: nothing is kept for anyone)
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
select public.link_office_done(current_setting('test.hqrev')::uuid, true, null, 'SFFTaG93bg==');
reset role;
do $$ begin
  assert (select status from public.link_office_commands where id = current_setting('test.hqrev')::uuid) = 'done', 'done';
  assert not exists (select 1 from public.link_office_reveals where command_id = current_setting('test.hqrev')::uuid), 'no password copy kept';
end $$;
set role authenticated;
-- the customer ends it early: support can't take the password or send more
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
select public.link_support_end(:'ws_l');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin
  begin perform public.link_reveal_take(current_setting('test.hqrev')::uuid); raise exception 'support took a password';
  exception when others then assert sqlerrm like 'There''s no password waiting for you%', sqlerrm; end;
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'support sent a change after it ended';
  exception when others then assert sqlerrm like 'Ask the customer%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.audit_log where action = 'link.support_ended') and exists (select 1 from public.hq_audit where action = 'link.support_ended'), 'ending is in both histories';
end $$;
-- an expired grant counts for nothing
reset role;
insert into public.link_support_access (workspace_id, granted_by, granted_at, expires_at) values (:'ws_l', 'c0c0c0c0-0000-4000-8000-000000000001', now() - interval '2 hours', now() - interval '1 hour');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005'); set role authenticated;
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'set_dnd', '{"extension":"101","on":true}'); raise exception 'expired grant worked';
  exception when others then assert sqlerrm like 'Ask the customer%', sqlerrm; end;
end $$;
-- signed-out visitors: nothing
reset role; set role anon;
do $$ begin
  begin perform public.link_status(current_setting('test.ws_l')::uuid); raise exception 'anon read status';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.link_offices; raise exception 'anon read offices';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== Riyeser Link: My phone (everyone sees their own extension, phones and password; Do not disturb for themselves)
reset role;
insert into auth.users values ('c0c0c0c0-0000-4000-8000-000000000008', 'kai@link.test'), ('c0c0c0c0-0000-4000-8000-000000000009', 'noext@link.test');
insert into public.members (workspace_id, user_id, display_name, role, extension) values (:'ws_l', 'c0c0c0c0-0000-4000-8000-000000000008', 'Kai Member', 'member', 102),
  (:'ws_l', 'c0c0c0c0-0000-4000-8000-000000000009', 'No Ext', 'member', null);
update public.members set extension = 101 where workspace_id = :'ws_l' and user_id = 'c0c0c0c0-0000-4000-8000-000000000001';
-- a fresh heartbeat: Kai's desk phone (named, with a location, settings fetched) and the owner's
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
select public.link_office_report(:'ws_l', 'office-0001-abcd', '{"pc_name":"OFFICE-PC","state":"running","addresses":["192.168.1.20"],"sip_port":5060,"licence":{"active":true},
  "counts":{"calls_made":3},
  "phones":[{"mac":"001565aabbcc","extension":"101","assigned":true,"registered":true},
            {"mac":"001565112233","vendor":"Yealink","model":"T31P","extension":"102","assigned":true,"registered":false,"name":"Reception<b>","location":"Head office","note":"S/N BP1","provisioned_at":"2026-11-24T09:00:00Z"},
            {"mac":"000b82998877","assigned":false}],
  "extensions":[{"extension":"100","name":"Head office","type":"group","members":2},{"extension":"101","name":"Pat","type":"person"},{"extension":"102","name":"Kai Member","type":"person","dnd":true}]}');
reset role;
do $$ begin
  assert (select name from public.link_office_phones where mac = '001565112233') = 'Receptionb', 'name kept, cleaned';
  assert (select location from public.link_office_phones where mac = '001565112233') = 'Head office', 'location kept';
  assert (select provisioned_at from public.link_office_phones where mac = '001565112233') = '2026-11-24T09:00:00Z', 'last settings fetch kept';
  assert (select counts ->> 'calls_made' from public.link_offices) = '3', 'calls made: a count only';
end $$;
-- a member, with only a password (no two-step sign-in), sees their own extension and phone, and no one else's
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
do $$ declare j json; ws uuid := current_setting('test.ws_l')::uuid; begin
  j := public.link_my_phone(ws);
  assert j ->> 'extension' = '102', format('my extension: %s', j);
  assert json_array_length(j -> 'phones') = 1 and (j -> 'phones' -> 0 ->> 'mac') = '001565112233', 'only my phone';
  assert (j -> 'phones' -> 0 ->> 'name') = 'Receptionb', 'its name';
  assert j -> 'office' ->> 'address' = '192.168.1.20' and (j -> 'office' ->> 'sip_port')::int = 5060 and (j -> 'office' ->> 'online')::boolean, 'server, port, online';
  assert (j ->> 'dnd')::boolean, 'my Do not disturb';
  assert j -> 'first_group' ->> 'name' = 'Head office' and j -> 'first_group' ->> 'extension' = '100', 'first ring group';
  assert j ->> 'owner_name' = 'Pat', 'who to ask';
  assert j::text not like '%password%' and j::text not like '%sealed%', 'no passwords';
  -- the admin tools stay admin-only
  begin perform public.link_command(ws, 'office-0001-abcd', 'set_dnd', '{"extension":"102","on":false}'); raise exception 'member used link_command';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'name_phone', '{"mac":"001565112233","name":"Mine"}'); raise exception 'member named a phone';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
  begin perform public.link_my_reveal(ws, '{"kty":"RSA","n":"short","e":"AQAB"}'); raise exception 'weak key';
  exception when others then assert sqlerrm like 'This browser can''t show passwords safely%', sqlerrm; end;
end $$;
-- Show my password: the change is for MY extension, whatever else is asked
select public.link_my_reveal(:'ws_l', jsonb_build_object('kty', 'RSA', 'n', repeat('K', 342), 'e', 'AQAB', 'd', 'PRIVATE', 'extension', '101')) as myrev \gset
select set_config('test.myrev', :'myrev', false);
do $$ begin
  assert (public.link_command_state(current_setting('test.myrev')::uuid) ->> 'status') = 'pending', 'I can follow my own Show';
end $$;
reset role;
do $$ begin
  assert (select data ->> 'extension' from public.link_office_commands where id = current_setting('test.myrev')::uuid) = '102', 'only my extension';
  assert (select data -> 'key' ->> 'd' from public.link_office_commands where id = current_setting('test.myrev')::uuid) is null, 'only the public key kept';
  assert exists (select 1 from public.audit_log where action = 'link.reveal_own' and actor = 'c0c0c0c0-0000-4000-8000-000000000008' and details ->> 'extension' = '102'), 'in the history as link.reveal_own';
end $$;
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
select public.link_office_done(:'myrev', true, null, 'S2FpUGFzc3dvcmQ=');
-- someone else in the business can't follow it or take it
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000009'); set role authenticated;
do $$ begin
  begin perform public.link_command_state(current_setting('test.myrev')::uuid); raise exception 'another member followed my Show';
  exception when others then assert sqlerrm like 'That change isn''t one of yours%', sqlerrm; end;
  begin perform public.link_reveal_take(current_setting('test.myrev')::uuid); raise exception 'another member took my password';
  exception when others then assert sqlerrm like 'There''s no password waiting for you%', sqlerrm; end;
  -- no extension: nothing to show or change
  begin perform public.link_my_reveal(current_setting('test.ws_l')::uuid, jsonb_build_object('kty', 'RSA', 'n', repeat('N', 342), 'e', 'AQAB')); raise exception 'no extension but showed';
  exception when others then assert sqlerrm like 'You don''t have an extension yet%', sqlerrm; end;
  begin perform public.link_my_dnd(current_setting('test.ws_l')::uuid, true); raise exception 'no extension but DND';
  exception when others then assert sqlerrm like 'You don''t have an extension yet%', sqlerrm; end;
  assert (public.link_my_phone(current_setting('test.ws_l')::uuid) ->> 'extension') is null, 'no extension';
  assert json_array_length(public.link_my_phone(current_setting('test.ws_l')::uuid) -> 'phones') = 0, 'and no phones';
end $$;
-- I take it once
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
do $$ begin
  assert (public.link_command_state(current_setting('test.myrev')::uuid) ->> 'ready')::boolean, 'ready for me';
  assert public.link_reveal_take(current_setting('test.myrev')::uuid) = 'S2FpUGFzc3dvcmQ=', 'taken';
  assert public.link_reveal_take(current_setting('test.myrev')::uuid) is null, 'only once';
end $$;
-- one not taken in time expires
select public.link_my_reveal(:'ws_l', jsonb_build_object('kty', 'RSA', 'n', repeat('L', 342), 'e', 'AQAB')) as myrev2 \gset
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
select public.link_office_done(:'myrev2', true, null, 'TGF0ZQ==');
reset role;
update public.link_office_reveals set created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' where command_id = :'myrev2';
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
select set_config('test.myrev2', :'myrev2', false);
do $$ begin assert public.link_reveal_take(current_setting('test.myrev2')::uuid) is null, 'expired: nothing to take'; end $$;
reset role;
do $$ begin assert (select sealed from public.link_office_reveals where command_id = current_setting('test.myrev2')::uuid) is null, 'expired copy blanked'; end $$;
-- my extension changes before I take it: I can't take the old one's password
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
select public.link_my_reveal(:'ws_l', jsonb_build_object('kty', 'RSA', 'n', repeat('M', 342), 'e', 'AQAB')) as myrev3 \gset
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003');
select public.link_office_done(:'myrev3', true, null, 'T2xkRXh0');
reset role;
update public.members set extension = 105 where workspace_id = :'ws_l' and user_id = 'c0c0c0c0-0000-4000-8000-000000000008';
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
select set_config('test.myrev3', :'myrev3', false);
do $$ begin
  begin perform public.link_reveal_take(current_setting('test.myrev3')::uuid); raise exception 'took a password for an extension that is not mine any more';
  exception when others then assert sqlerrm like 'You can''t see this business''s phone passwords any more%', sqlerrm; end;
end $$;
reset role;
update public.members set extension = 102 where workspace_id = :'ws_l' and user_id = 'c0c0c0c0-0000-4000-8000-000000000008';
-- Do not disturb for myself only
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
select public.link_my_dnd(:'ws_l', false) as mydnd \gset
reset role;
select set_config('test.mydnd', :'mydnd', false);
do $$ begin
  assert (select data from public.link_office_commands where id = current_setting('test.mydnd')::uuid) = '{"on": false, "extension": "102"}'::jsonb, 'set_dnd for my extension';
  assert exists (select 1 from public.audit_log where action = 'link.set_dnd_own' and actor = 'c0c0c0c0-0000-4000-8000-000000000008'), 'in the history';
end $$;
-- the owner, without two-step sign-in, can show their OWN password, but not anyone else's (admin rules unchanged)
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare c uuid; begin
  c := public.link_my_reveal(current_setting('test.ws_l')::uuid, jsonb_build_object('kty', 'RSA', 'n', repeat('P', 342), 'e', 'AQAB'));
  assert (public.link_command_state(c) ->> 'kind') = 'reveal_password', 'own Show without two-step';
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '102', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('P', 342), 'e', 'AQAB')));
    raise exception 'owner without two-step showed someone else''s';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
reset role;
do $$ begin assert (select data ->> 'extension' from public.link_office_commands where kind = 'reveal_password' order by created_at desc limit 1) = '101', 'the owner''s own'; end $$;
-- too many at once from one person
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000008'); set role authenticated;
do $$ declare i int; begin
  for i in 1..4 loop perform public.link_my_dnd(current_setting('test.ws_l')::uuid, true); end loop;
  begin perform public.link_my_dnd(current_setting('test.ws_l')::uuid, true); raise exception 'no limit';
  exception when others then assert sqlerrm like 'You''ve asked a few times already%', sqlerrm; end;
end $$;
-- someone from another business: nothing
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin
  begin perform public.link_my_phone(current_setting('test.ws_l')::uuid); raise exception 'outsider read my phone';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
  begin perform public.link_my_dnd(current_setting('test.ws_l')::uuid, true); raise exception 'outsider DND';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
end $$;
reset role; set role anon;
do $$ begin
  begin perform public.link_my_phone(current_setting('test.ws_l')::uuid); raise exception 'anon read my phone';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- name_phone (Desk phones list): owners and admins with two-step sign-in, checked and tidied
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; c uuid; begin
  c := public.link_command(ws, 'office-0001-abcd', 'name_phone', '{"mac":"00:15:65:11:22:33","name":" Front counter ","branch":"Head office","note":"S/N BP78459236","extra":"x"}');
  assert (select data from public.link_office_commands where id = c) = '{"mac": "001565112233", "name": "Front counter", "branch": "Head office", "note": "S/N BP78459236"}'::jsonb, 'tidied';
  assert exists (select 1 from public.audit_log where action = 'link.name_phone' and details ->> 'name' = 'Front counter'), 'in the history';
  begin perform public.link_command(ws, 'office-0001-abcd', 'name_phone', '{"mac":"001565112233","name":"x","branch":"Nowhere"}'); raise exception 'unknown branch';
  exception when others then assert sqlerrm like 'Choose the location from your branches%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'name_phone', json_build_object('mac', '001565112233', 'name', repeat('n', 41))::jsonb); raise exception 'long name';
  exception when others then assert sqlerrm like 'Give the phone a short name%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'name_phone', '{"mac":"001565112233","name":"<script>"}'); raise exception 'markup in a name';
  exception when others then assert sqlerrm like 'Give the phone a short name%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'name_phone', '{"mac":"nope","name":"Desk"}'); raise exception 'bad MAC';
  exception when others then assert sqlerrm like 'That isn''t a MAC address%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'name_phone', '{"mac":"001565112233","name":"Desk"}'); raise exception 'named without two-step';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
reset role;

-- Link Office 1.2.3: many phones at once (bulk_phones), each phone's own page (phone_action, phone_settings), the office's
-- summary back, and the extra phone details in the heartbeat. Owners and admins with two-step sign-in only.
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; o json; ph json; begin
  perform public.link_office_report(ws, 'office-0001-abcd', '{"pc_name":"OFFICE-PC","version":"1.2.3","addresses":["192.168.1.20"],"sip_port":5060,"phones":[
    {"mac":"001565aabbcc","vendor":"Yealink","extension":"101","assigned":true,"registered":true,"ip":"192.168.1.31","firmware":"124.86.0.40","registered_since":"2026-11-27T08:00:00Z","last_seen":"2026-11-27T09:00:00Z","shared":false,
     "settings":{"label":"Front","timezone":"+12","timeFormat":"24","language":"English","ringtone":3,"ringVolume":9,"dnd":"person","lineKeys":[{"type":"speed","value":"102","label":"Bo"},{"value":"1; drop","label":"x"}],"password":"NotStored","evil":"<x>"}},
    {"mac":"000b82112233","vendor":"Grandstream","assigned":false,"ignored":true,"firmware":"bad firmware <x>"},
    {"mac":"000413445566","vendor":"Snom","assigned":true,"extension":"110","ignored":true,"shared":true}],"extensions":[{"extension":"101","name":"Pat","registered":1,"shared":false}],"counts":{"people":3,"ignored_phones":1}}');
  o := (public.link_status(ws) -> 'offices') -> 0;
  select p into ph from json_array_elements(o -> 'phones') p where p ->> 'mac' = '001565aabbcc';
  assert ph ->> 'firmware' = '124.86.0.40' and ph ->> 'registered_since' is not null and ph ->> 'last_seen' is not null, format('firmware and times: %s', ph);
  assert (ph -> 'settings') ->> 'label' = 'Front' and (ph -> 'settings') ->> 'timezone' = '+12' and ((ph -> 'settings') ->> 'ringtone')::int = 3, format('settings kept: %s', ph -> 'settings');
  assert json_array_length((ph -> 'settings') -> 'lineKeys') = 1, 'only real speed-dial keys';
  assert (ph -> 'settings')::text not like '%NotStored%' and (ph -> 'settings')::text not like '%evil%', 'nothing else kept from settings';
  select p into ph from json_array_elements(o -> 'phones') p where p ->> 'mac' = '000b82112233';
  assert (ph ->> 'ignored')::boolean and ph ->> 'firmware' is null, format('ignored new phone, bad firmware dropped: %s', ph);
  select p into ph from json_array_elements(o -> 'phones') p where p ->> 'mac' = '000413445566';
  assert not (ph ->> 'ignored')::boolean and (ph ->> 'shared')::boolean, 'a phone given to someone is never "ignored"; shared kept';
end $$;
reset role;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_l')::uuid; c uuid; big jsonb; begin
  -- Add several phones: rows checked and cut to size; up to 500; bigger than other changes are allowed to be
  c := public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"add","auto":true,"start":"201","rows":[{"macText":"00:15:65:12:34:56","model":"Yealink T31P","ext":"","person":"Pat","name":"Front","location":"Head office","extra":"x"},{"macText":"not-a-mac","ext":"9999"}]}');
  assert (select data from public.link_office_commands where id = c) = '{"action":"add","auto":true,"shared":false,"start":"201","rows":[{"line":1,"macText":"00:15:65:12:34:56","model":"Yealink T31P","person":"Pat","name":"Front","location":"Head office"},{"line":2,"macText":"not-a-mac"}]}'::jsonb,
    format('rows tidied: %s', (select data from public.link_office_commands where id = c));
  perform set_config('test.bulk_add', c::text, false);
  select jsonb_build_object('action', 'add', 'rows', jsonb_agg(jsonb_build_object('macText', lpad(to_hex(i), 12, '0'), 'model', 'Yealink T31P', 'name', 'Desk ' || i, 'location', 'Head office'))) into big from generate_series(1, 500) i;
  perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', big);
  select jsonb_build_object('action', 'add', 'rows', jsonb_agg(jsonb_build_object('macText', lpad(to_hex(i), 12, '0')))) into big from generate_series(1, 501) i;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', big); raise exception '501 rows';
  exception when others then assert sqlerrm like 'Add up to 500 phones%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"add","rows":[]}'); raise exception 'no rows';
  exception when others then assert sqlerrm like 'Paste or import at least one%', sqlerrm; end;
  -- one action for many phones: MACs tidied; give each to a person, or number them in order
  c := public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"give","macs":["00-0B-82-11-22-33","000413445566"],"to":{"00:0B:82:11:22:33":"102"},"auto":false}');
  assert (select data from public.link_office_commands where id = c) = '{"action":"give","macs":["000413445566","000b82112233"],"to":{"000b82112233":"102"},"auto":false}'::jsonb, format('give tidied: %s', (select data from public.link_office_commands where id = c));
  c := public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"location","macs":["001565aabbcc"],"location":"Head office"}');
  assert (select data ->> 'location' from public.link_office_commands where id = c) = 'Head office', 'move location';
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"location","macs":["001565aabbcc"],"location":"Nowhere"}'); raise exception 'unknown branch';
  exception when others then assert sqlerrm like 'Choose the location from your branches%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"remove","macs":["001565aabbcc","nope"]}'); raise exception 'a bad MAC in the list';
  exception when others then assert sqlerrm like 'That isn''t a MAC address%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"remove","macs":[]}'); raise exception 'nothing ticked';
  exception when others then assert sqlerrm like 'Tick at least one phone%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"factory_reset","macs":["001565aabbcc"]}'); raise exception 'unknown action';
  exception when others then assert sqlerrm like 'Riyeser Link Office doesn''t know%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'bulk_phones', '{"action":"give","macs":["001565aabbcc"],"to":{"001565aabbcc":"1 or 1"}}'); raise exception 'bad extension';
  exception when others then assert sqlerrm like 'Choose who each phone is for%', sqlerrm; end;
  -- each phone's page: restart, find, move to a shared phone; settings kept to what's allowed
  c := public.link_command(ws, 'office-0001-abcd', 'phone_action', '{"mac":"00:15:65:AA:BB:CC","action":"restart"}');
  assert (select data from public.link_office_commands where id = c) = '{"mac":"001565aabbcc","action":"restart"}'::jsonb, 'restart';
  c := public.link_command(ws, 'office-0001-abcd', 'phone_action', '{"mac":"001565aabbcc","action":"move","shared_name":"Reception"}');
  assert (select data ->> 'shared_name' from public.link_office_commands where id = c) = 'Reception', 'move to a new shared phone';
  begin perform public.link_command(ws, 'office-0001-abcd', 'phone_action', '{"mac":"001565aabbcc","action":"move"}'); raise exception 'move to nobody';
  exception when others then assert sqlerrm like 'Choose who the phone is for%', sqlerrm; end;
  begin perform public.link_command(ws, 'office-0001-abcd', 'phone_action', '{"mac":"001565aabbcc","action":"wipe"}'); raise exception 'unknown phone action';
  exception when others then assert sqlerrm like 'Riyeser Link Office doesn''t know%', sqlerrm; end;
  c := public.link_command(ws, 'office-0001-abcd', 'phone_settings', '{"mac":"001565aabbcc","settings":{"label":"Front","timezone":"+99","language":"Klingon","ringVolume":"9","lineKeys":[{"value":"102","label":"Bo"}],"admin_password":"x"}}');
  assert (select data -> 'settings' from public.link_office_commands where id = c) = '{"label":"Front","ringVolume":9,"lineKeys":[{"type":"speed","value":"102","label":"Bo"}]}'::jsonb,
    format('settings checked: %s', (select data -> 'settings' from public.link_office_commands where id = c));
  perform set_config('test.cmd_set', c::text, false);
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.bulk_phones' and details ->> 'action' = 'give' and (details ->> 'phones')::int = 2), 'bulk changes in the history, with how many phones';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.phone_action' and details ->> 'action' = 'restart'), 'phone actions in the history';
end $$;
-- without two-step, or someone outside the business: nothing
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'bulk_phones', '{"action":"remove","macs":["001565aabbcc"]}'); raise exception 'bulk without two-step';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000004'); set role authenticated;
do $$ begin
  begin perform public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'phone_action', '{"mac":"001565aabbcc","action":"find"}'); raise exception 'stranger rang a phone';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- the office says what it did: a short summary, kept with the change and in the history; an older office's answer still works
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
do $$ begin
  perform public.link_office_done(current_setting('test.bulk_add')::uuid, true, null, null, '{"summary":"Added 1 phone, 1 didn''t work: not-a-mac isn''t a MAC address.","added":1,"skipped":[],"failed":[{"mac":"not-a-mac","why":"not a MAC address"}],"password":"x"}');
  perform public.link_office_done(current_setting('test.cmd_set')::uuid, true, null, null);
end $$;
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare st json; begin
  st := public.link_command_state(current_setting('test.bulk_add')::uuid);
  assert st ->> 'status' = 'done' and (st -> 'result') ->> 'summary' like 'Added 1 phone%' and ((st -> 'result') ->> 'added')::int = 1, format('summary: %s', st);
  assert (st -> 'result')::text not like '%password%', 'only the summary fields are kept';
  assert exists (select 1 from public.audit_log where action = 'link.bulk_done' and details ->> 'summary' like 'Added 1 phone%'), 'the summary is in the history';
  assert public.link_command_state(current_setting('test.cmd_set')::uuid) ->> 'status' = 'done', 'settings done (4-argument answer)';
end $$;
reset role;

-- ===== Support workspace: Report an issue, diagnostics privacy, Still having an issue / Confirm fixed, rating, promised updates
-- Sam (staff at A) reports an issue from Riyeser Central: one diagnostic report and one ticket, scrubbed
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); set role authenticated;
select public.support_report(:'ws_a', jsonb_build_object('source', 'central', 'product', 'payroll', 'product_version', '2.8.1',
  'what_happened', 'Payroll export times out after the update', 'blocked', true, 'error_text', 'Export timed out (sam.sample@a.test)',
  'os', 'Windows 11 Pro (10.0.22631)', 'central_version', '1.8.3', 'programs', '[{"id":"payroll","version":"2.8.1"},{"id":"central","version":"1.8.3"}]'::jsonb,
  'log_lines', E'10:00 export started for jo@sample.test\n10:01 bank account 123456789 checked\n10:02 password=hunter2 sent\n10:03 tax 12 345 678 901 ok\n10:04 version 2.8.1 on 2026-11-24',
  'log_source', 'C:\Users\sam\AppData\Payroll log')) as rep \gset
select set_config('test.rep_t', (:'rep'::json ->> 'id'), false), set_config('test.rep_d', (:'rep'::json ->> 'diag_id'), false), set_config('test.rep_ref', (:'rep'::json ->> 'diag_ref'), false);
do $$ declare d record; begin
  assert current_setting('test.rep_ref') ~ '^DG-[0-9]{4,}$', 'a reference like DG-4821';
  select * into d from public.support_diagnostics where id = current_setting('test.rep_d')::uuid;
  assert d.id is not null, 'Sam reads his own report';
  assert d.log_lines like '%j***@sample.test%' and d.log_lines not like '%jo@sample.test%', 'emails masked';
  assert d.log_lines not like '%123456789%' and d.log_lines like '%[number removed]%', 'long numbers masked';
  assert d.log_lines not like '%hunter2%' and d.log_lines like '%password [removed]%', 'anything after "password" masked';
  assert d.log_lines not like '%12 345 678 901%', 'grouped tax numbers masked';
  assert d.log_lines like '%2.8.1 on 2026-11-24%', 'versions and dates kept';
  assert d.error_text = 'Export timed out (s***@a.test)', d.error_text;
  assert d.log_source !~ '[\\/:]', 'no folder path kept';
  assert d.source = 'central' and d.product = 'payroll' and d.product_version = '2.8.1' and jsonb_array_length(d.programs) = 2, 'details kept';
  assert (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'diag_ref') = d.ref and (public.my_ticket(current_setting('test.rep_t')::uuid) -> 'messages' -> 0 ->> 'body') like '%Work blocked: Yes%', 'customer sees the reference';
  begin perform public.support_report(current_setting('test.ws_b')::uuid, '{"what_happened":"x"}'); raise exception 'reported for another business';
  exception when others then assert sqlerrm like 'You''re not in that business%', sqlerrm; end;
  begin perform public.support_report(current_setting('test.ws_a')::uuid, '{"product":"pos"}'); raise exception 'no description';
  exception when others then assert sqlerrm like 'Say what happened%', sqlerrm; end;
  -- direct inserts: only your own, only for your business
  begin insert into public.support_diagnostics (workspace_id, created_by, product) values (current_setting('test.ws_b')::uuid, auth.uid(), 'pos'); raise exception 'inserted for B';
  exception when insufficient_privilege then null; end;
  begin insert into public.support_diagnostics (workspace_id, created_by, product) values (current_setting('test.ws_a')::uuid, '11111111-1111-1111-1111-111111111111', 'pos'); raise exception 'inserted as Alex';
  exception when insufficient_privilege then null; end;
  insert into public.support_diagnostics (workspace_id, product, log_lines) values (current_setting('test.ws_a')::uuid, 'pos', 'printer at a@b.test');
  assert (select log_lines from public.support_diagnostics where product = 'pos') = 'printer at a***@b.test', 'own report inserted directly, scrubbed too';
  begin update public.support_diagnostics set os = 'x'; raise exception 'changed a report';
  exception when insufficient_privilege then null; end;
end $$;
-- the website form can link the reference from Central (only this business's)
do $$ declare r json; begin
  r := public.support_report(current_setting('test.ws_a')::uuid, jsonb_build_object('product', 'payroll', 'what_happened', 'Same again today', 'blocked', 'no', 'diag_ref', lower(current_setting('test.rep_ref'))));
  assert (r ->> 'diag_ref') = current_setting('test.rep_ref'), 'linked to the Central report';
  assert (select count(*) from public.support_diagnostics) = 2, 'no new report made (the Central one and the direct one)';
  assert (select not work_blocked from public.support_tickets where id = (r ->> 'id')::uuid), 'not blocked';
  perform set_config('test.rep_t2', r ->> 'id', false);
  begin perform public.support_report(current_setting('test.ws_a')::uuid, '{"what_happened":"x","diag_ref":"DG-1"}'); raise exception 'unknown reference';
  exception when others then assert sqlerrm like 'We couldn''t find diagnostic reference DG-1%', sqlerrm; end;
end $$;
reset role;
do $$ declare t record; begin
  select * into t from public.support_tickets where id = current_setting('test.rep_t')::uuid;
  assert (select priority from public.support_tickets where id = current_setting('test.rep_t2')::uuid) = 'normal', 'not blocked: normal priority';
  assert t.product = 'payroll' and t.work_blocked and t.priority = 'high' and t.diag_id = current_setting('test.rep_d')::uuid and t.status = 'new' and t.who_acts = 'riyeser', 'ticket: product, work blocked bumps the priority, diagnostic';
  assert exists (select 1 from public.email_outbox where template = 'ticket_received' and body_text like '%riyeser.com/link/?help#T-%'), 'the email links to the portal';
  assert exists (select 1 from public.audit_log where action = 'support.reported' and details ->> 'diagnostic' = current_setting('test.rep_ref')), 'in the business''s history';
end $$;
-- diagnostics privacy: another business's people, and other people in the same business, can't read it
select pg_temp.as_user('33333333-3333-3333-3333-333333333333'); set role authenticated;
do $$ begin
  assert (select count(*) from public.support_diagnostics) = 0, 'B reads none of A''s reports';
  begin perform public.hq_diagnostic(current_setting('test.rep_ref')); raise exception 'customer used the HQ lookup';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert (select count(*) from public.support_diagnostics) = 0, 'reports are read only by whoever made them'; end $$;
reset role; set role anon;
do $$ begin begin perform count(*) from public.support_diagnostics; raise exception 'anon read reports'; exception when insufficient_privilege then null; end; end $$;
reset role;
-- HQ: support.diagnostics needed (support, senior, developer and owner have it; finance doesn't)
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd'); set role authenticated;
do $$ begin
  begin perform public.hq_diagnostic(current_setting('test.rep_ref')); raise exception 'finance read a diagnostic';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
  assert (public.hq_ticket(current_setting('test.rep_t')::uuid) -> 'diagnostic')::text = 'null' and (public.hq_ticket(current_setting('test.rep_t')::uuid) ->> 'diag_hidden')::boolean, 'hidden on the ticket too';
end $$;
select pg_temp.as_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); set role authenticated;
do $$ begin assert (public.hq_diagnostic(current_setting('test.rep_ref')) -> 'diagnostic' ->> 'product_version') = '2.8.1', 'developer looks it up'; end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ declare r json; begin
  r := public.hq_ticket(current_setting('test.rep_t')::uuid);
  assert (r -> 'diagnostic' ->> 'ref') = current_setting('test.rep_ref') and (r -> 'diagnostic' ->> 'line_count')::int = 5, 'support sees it on the ticket';
  assert (r -> 'ticket' ->> 'product') = 'payroll' and (r -> 'ticket' ->> 'who_acts') = 'riyeser', 'product and who acts';
  assert json_array_length(r -> 'staff') >= 3, 'staff to assign';
  assert exists (select 1 from json_array_elements(public.hq_support_inbox('all', '', jsonb_build_object('product', 'payroll')) -> 'tickets') x where x ->> 'id' = current_setting('test.rep_t')), 'product filter';
  assert not exists (select 1 from json_array_elements(public.hq_support_inbox('all', '', jsonb_build_object('product', 'pos')) -> 'tickets') x where x ->> 'id' = current_setting('test.rep_t')), 'other products filtered out';
  assert exists (select 1 from json_array_elements(public.hq_support_inbox('all', current_setting('test.rep_ref'), null) -> 'tickets') x where x ->> 'id' = current_setting('test.rep_t')), 'search by DG reference';
  -- product, planned release, linked bug, a logged call, owner, status
  perform public.hq_ticket_set(current_setting('test.rep_t')::uuid, '{"planned_release":"Payroll 2.8.2","bug_ref":"BUG-7719","bug_url":"https://github.com/example/issues/7719"}');
  begin perform public.hq_ticket_set(current_setting('test.rep_t')::uuid, '{"bug_url":"javascript:alert(1)"}'); raise exception 'bad link';
  exception when others then assert sqlerrm like 'The bug link must start with https://%', sqlerrm; end;
  begin perform public.hq_ticket_set(current_setting('test.rep_t')::uuid, '{"product":"spaceship"}'); raise exception 'bad product';
  exception when others then assert sqlerrm like 'Choose a product%', sqlerrm; end;
  perform public.hq_ticket_log_call(current_setting('test.rep_t')::uuid, 'out', 'Sam', 'Rang to say we can reproduce it');
  perform public.hq_ticket_assign(current_setting('test.rep_t')::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  perform public.hq_ticket_status(current_setting('test.rep_t')::uuid, 'investigating');
  r := public.hq_ticket(current_setting('test.rep_t')::uuid);
  assert (r -> 'ticket' ->> 'planned_release') = 'Payroll 2.8.2' and (r -> 'ticket' ->> 'bug_ref') = 'BUG-7719', 'saved';
  assert exists (select 1 from json_array_elements(r -> 'messages') x where x ->> 'kind' = 'call' and (x ->> 'internal')::boolean), 'the call is in the thread, staff only';
  begin perform public.hq_ticket_next_update(current_setting('test.rep_t')::uuid, now() - interval '1 hour', null); raise exception 'next update in the past';
  exception when others then assert sqlerrm like 'Choose a time from now on%', sqlerrm; end;
  perform public.hq_ticket_next_update(current_setting('test.rep_t')::uuid, now() + interval '2 hours', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  assert (public.hq_ticket(current_setting('test.rep_t')::uuid) -> 'ticket' ->> 'next_update_owner_name') = 'Senior Sam', 'next update owner';
end $$;
-- the customer sees "We'll update you by", never the call or who at Riyeser
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); set role authenticated;
do $$ declare r json; begin
  r := public.my_ticket(current_setting('test.rep_t')::uuid);
  assert (r ->> 'next_update_due') is not null and (r ->> 'status') = 'investigating', 'promised update shown';
  assert not exists (select 1 from json_array_elements(r -> 'messages') x where x ->> 'body' like 'Rang to say%'), 'logged calls are staff only';
  assert r::text not like '%Senior Sam%', 'no staff names';
end $$;
-- the hourly sweep: an overdue promised update gets an internal reminder, once, and shows in Needs attention
reset role;
update public.support_tickets set next_update_due = now() - interval '10 minutes' where id = current_setting('test.rep_t')::uuid;
do $$ declare r json; n int; begin
  n := (select count(*) from public.email_outbox);
  r := public.hq_support_sweep();
  assert (r ->> 'updates_overdue')::int = 1, r::text;
  assert exists (select 1 from public.support_messages where ticket_id = current_setting('test.rep_t')::uuid and internal and author is null and body like 'Reminder: the next update%'), 'internal reminder in the thread';
  assert exists (select 1 from public.email_outbox where template = 'staff_update_due' and to_user = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and workspace_id is null), 'reminder queued for the owner (staff)';
  assert not exists (select 1 from public.email_outbox where id > 0 and template = 'staff_update_due' and to_user = '22222222-2222-2222-2222-222222222222'), 'the customer isn''t emailed';
  assert (select count(*) from public.email_outbox) = n + 1, 'one email only';
  r := public.hq_support_sweep();
  assert (r ->> 'updates_overdue')::int = 0, 'reminded once';
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin
  assert (public.hq_attention() ->> 'updates_overdue')::int >= 1, 'Needs attention counts overdue updates';
  assert exists (select 1 from json_array_elements(public.hq_work_queue() -> 'queue') x where x ->> 'kind' = 'update' and x ->> 'ref' = current_setting('test.rep_t')), 'in the work queue';
  assert exists (select 1 from json_array_elements(public.hq_support_inbox('overdue', '', null) -> 'tickets') x where x ->> 'id' = current_setting('test.rep_t') and (x ->> 'update_overdue')::boolean), 'Overdue update tab';
  perform public.hq_ticket_reply(current_setting('test.rep_t')::uuid, 'Fixed in Payroll 2.8.2. Please update and try again.', false, 'waiting_customer');
end $$;
-- Still having an issue / Confirm fixed: only the ticket's business
select pg_temp.as_user('33333333-3333-3333-3333-333333333333'); set role authenticated;
do $$ begin
  begin perform public.ticket_still_issue(current_setting('test.rep_t')::uuid, 'not mine'); raise exception 'B reopened A''s ticket';
  exception when others then assert sqlerrm like 'We couldn''t find that help request%', sqlerrm; end;
  begin perform public.ticket_confirm_fixed(current_setting('test.rep_t')::uuid); raise exception 'B closed A''s ticket';
  exception when others then assert sqlerrm like 'We couldn''t find that help request%', sqlerrm; end;
  begin perform public.ticket_rate(current_setting('test.rep_t')::uuid, 5, null); raise exception 'B rated A''s ticket';
  exception when others then assert sqlerrm like 'We couldn''t find that help request%', sqlerrm; end;
end $$;
select pg_temp.as_user('44444444-4444-4444-4444-444444444444'); set role authenticated;   -- Jordan: same business, not his, not an admin
do $$ begin
  begin perform public.ticket_confirm_fixed(current_setting('test.rep_t')::uuid); raise exception 'Jordan closed Sam''s ticket';
  exception when others then assert sqlerrm like 'We couldn''t find that help request%', sqlerrm; end;
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222'); set role authenticated;
do $$ begin
  assert (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'who_acts') = 'customer', 'customer to act';
  begin perform public.ticket_rate(current_setting('test.rep_t')::uuid, 5, 'quick'); raise exception 'rated before resolved';
  exception when others then assert sqlerrm like 'You can rate this once it''s resolved%', sqlerrm; end;
  perform public.ticket_still_issue(current_setting('test.rep_t')::uuid, 'Updated, still times out');
  assert (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'status') = 'waiting_us' and (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'who_acts') = 'riyeser', 'back with Riyeser';
end $$;
reset role;
do $$ begin assert (select assignee from public.support_tickets where id = current_setting('test.rep_t')::uuid) = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'still in the owner''s queue'; end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin assert exists (select 1 from json_array_elements(public.hq_support_inbox('mine', '', null) -> 'tickets') x where x ->> 'id' = current_setting('test.rep_t') and x ->> 'who_acts' = 'riyeser'), 'in My tickets as Riyeser to act'; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;   -- Alex, A's owner, may confirm it
do $$ begin
  perform public.ticket_confirm_fixed(current_setting('test.rep_t')::uuid);
  assert (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'status') = 'done', 'resolved';
  begin perform public.ticket_rate(current_setting('test.rep_t')::uuid, 6, null); raise exception 'six stars';
  exception when others then assert sqlerrm like 'Choose 1 to 5 stars%', sqlerrm; end;
  perform public.ticket_rate(current_setting('test.rep_t')::uuid, 5, 'Quick and clear, thanks');
  assert (public.my_ticket(current_setting('test.rep_t')::uuid) ->> 'rating')::int = 5, 'rated';
end $$;
reset role;
do $$ begin
  assert (select resolved_at is not null and rating_comment = 'Quick and clear, thanks' and who_acts is null from public.support_tickets where id = current_setting('test.rep_t')::uuid), 'stored';
  assert exists (select 1 from public.audit_log where action = 'support.fixed') and exists (select 1 from public.audit_log where action = 'support.reopened'), 'customer actions in the history';
  assert exists (select 1 from pg_temp.audit('ticket.next_update')) and exists (select 1 from pg_temp.audit('ticket.call')) and exists (select 1 from pg_temp.audit('diagnostic.viewed')), 'HQ actions audited';
  assert (select known_issue_id is null and fixed_in_version is null from public.support_tickets where id = current_setting('test.rep_t')::uuid), 'later: known issues and releases';
end $$;
-- HQ still can't read chat messages or books
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ begin assert (select count(*) from public.messages) = 0, 'HQ staff see no chat messages'; end $$;
reset role;

-- ===== Riyeser Link: workspace (presence, reactions, pins, files)
-- A fresh business (Pip owner, Quinn member, Rua member) and another business (Sol). Made directly, as the database owner.
reset role;
insert into auth.users (id, email) values ('a7a7a7a1-0000-4000-8000-000000000001', 'pip@lk.test'), ('a7a7a7a2-0000-4000-8000-000000000002', 'quinn@lk.test'),
  ('a7a7a7a3-0000-4000-8000-000000000003', 'rua@lk.test'), ('a7a7a7a4-0000-4000-8000-000000000004', 'sol@lk.test');
do $$ declare a uuid; b uuid; g uuid; p uuid; m uuid; pm uuid; begin
  insert into public.workspaces (name) values ('Sample Link Co') returning id into a;
  insert into public.workspaces (name) values ('Other Link Co') returning id into b;
  insert into public.members (workspace_id, user_id, display_name, role) values (a, 'a7a7a7a1-0000-4000-8000-000000000001', 'Pip', 'owner'),
    (a, 'a7a7a7a2-0000-4000-8000-000000000002', 'Quinn', 'member'), (a, 'a7a7a7a3-0000-4000-8000-000000000003', 'Rua', 'member'),
    (b, 'a7a7a7a4-0000-4000-8000-000000000004', 'Sol', 'owner');
  insert into public.channels (workspace_id, kind, name) values (a, 'channel', 'general') returning id into g;
  insert into public.channels (workspace_id, kind, name) values (a, 'private', 'managers') returning id into p;
  insert into public.channel_members values (p, 'a7a7a7a1-0000-4000-8000-000000000001'), (p, 'a7a7a7a2-0000-4000-8000-000000000002');
  insert into public.messages (channel_id, workspace_id, user_id, body) values (g, a, 'a7a7a7a1-0000-4000-8000-000000000001', 'Morning all') returning id into m;
  insert into public.messages (channel_id, workspace_id, user_id, body) values (p, a, 'a7a7a7a1-0000-4000-8000-000000000001', 'Managers only') returning id into pm;
  perform set_config('lk.a', a::text, false), set_config('lk.b', b::text, false), set_config('lk.g', g::text, false), set_config('lk.p', p::text, false),
    set_config('lk.m', m::text, false), set_config('lk.pm', pm::text, false);
end $$;
set role authenticated;

-- presence: I set my own; everyone in the business sees it; another business sees nothing and can't set it here
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
do $$ declare a uuid := current_setting('lk.a')::uuid; begin
  perform public.link_presence_set(a, 'dnd', 'dnd', 'At the Elm St job', false);
  perform public.link_presence_set(a, 'dnd', 'dnd', 'At the Elm St job', true);
  assert (select count(*) from public.presence) = 1, 'one row for Quinn';
  assert (select status || '/' || manual || '/' || custom_text || '/' || on_call || '/' || fresh from public.link_presence(a)) = 'dnd/dnd/At the Elm St job/true/true', 'Quinn sees their own status';
  begin perform public.link_presence_set(a, 'sleeping', null, null, false); raise exception 'bad status';
  exception when others then assert sqlerrm like 'Choose Available%', sqlerrm; end;
  begin perform public.link_presence_set(a, 'busy', null, '<b>hi</b>', false); raise exception 'markup';
  exception when others then assert sqlerrm like 'Keep your status short%', sqlerrm; end;
  begin insert into public.presence (workspace_id, user_id, status) values (a, 'a7a7a7a3-0000-4000-8000-000000000003', 'away'); raise exception 'wrote someone else''s presence';
  exception when insufficient_privilege then null; end;
  begin update public.presence set status = 'available'; raise exception 'updated presence directly';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ declare a uuid := current_setting('lk.a')::uuid; begin
  perform public.link_presence_set(a, 'away', null, null, false);
  assert (select count(*) from public.presence) = 2, 'Rua sees both in the business';
  assert (select manual from public.link_presence(a) where user_id = 'a7a7a7a2-0000-4000-8000-000000000002') is null, 'someone else''s manual choice stays theirs';
  assert (select status from public.link_presence(a) where user_id = 'a7a7a7a2-0000-4000-8000-000000000002') = 'dnd', 'Rua sees Quinn is DND';
  assert (select away_since is not null from public.presence where user_id = 'a7a7a7a3-0000-4000-8000-000000000003'), 'away since';
end $$;
select pg_temp.as_user('a7a7a7a4-0000-4000-8000-000000000004');
do $$ declare a uuid := current_setting('lk.a')::uuid; begin
  assert (select count(*) from public.presence) = 0, 'another business sees no presence';
  assert (select count(*) from public.link_presence(a)) = 0, 'nor through the function';
  begin perform public.link_presence_set(a, 'available', null, null, false); raise exception 'set presence in another business';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
end $$;
reset role; set role anon; select pg_temp.as_user('');
do $$ begin
  begin perform count(*) from public.presence; raise exception 'anon read presence'; exception when insufficient_privilege then null; end;
  begin perform public.link_presence_set(current_setting('lk.a')::uuid, 'available', null, null, false); raise exception 'anon set presence';
  exception when insufficient_privilege then null; end;
end $$;
reset role; set role authenticated;

-- reactions: only people who can see the message, only as themselves, only their own taken back
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
insert into public.message_reactions (message_id, emoji) select current_setting('lk.m')::uuid, '👍';
insert into public.message_reactions (message_id, emoji) select current_setting('lk.pm')::uuid, '✅';
do $$ begin
  assert (select channel_id::text from public.message_reactions where emoji = '👍') = current_setting('lk.g'), 'the chat comes from the message';
  begin insert into public.message_reactions (message_id, emoji) values (current_setting('lk.m')::uuid, '🤡'); raise exception 'odd emoji';
  exception when check_violation then null; end;
  begin insert into public.message_reactions (message_id, user_id, emoji) values (current_setting('lk.m')::uuid, 'a7a7a7a3-0000-4000-8000-000000000003', '🎉'); raise exception 'reacted as Rua';
  exception when insufficient_privilege then null; end;
  begin insert into public.message_reactions (message_id, emoji, channel_id, workspace_id)
    values (current_setting('lk.m')::uuid, '❤️', current_setting('lk.p')::uuid, current_setting('lk.b')::uuid);
    assert (select channel_id::text from public.message_reactions where emoji = '❤️') = current_setting('lk.g'), 'a made-up chat is replaced by the real one';
  end;
end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ begin
  assert (select count(*) from public.message_reactions) = 2, 'Rua (not in managers) sees the #general reactions only';
  begin insert into public.message_reactions (message_id, emoji) values (current_setting('lk.pm')::uuid, '👀'); raise exception 'reacted in a private chat';
  exception when others then if sqlerrm = 'reacted in a private chat' then raise; end if; end;
  delete from public.message_reactions where emoji = '👍';
  assert (select count(*) from public.message_reactions where emoji = '👍') = 1, 'Rua can''t take back Quinn''s reaction';
  insert into public.message_reactions (message_id, emoji) values (current_setting('lk.m')::uuid, '👍');
  delete from public.message_reactions where emoji = '👍' and user_id = auth.uid();
  assert (select count(*) from public.message_reactions where emoji = '👍') = 1, 'Rua took back their own';
end $$;
select pg_temp.as_user('a7a7a7a4-0000-4000-8000-000000000004');
do $$ begin
  assert (select count(*) from public.message_reactions) = 0, 'another business sees no reactions';
  begin insert into public.message_reactions (message_id, emoji) values (current_setting('lk.m')::uuid, '😂'); raise exception 'outsider reacted';
  exception when others then if sqlerrm = 'outsider reacted' then raise; end if; end;
end $$;

-- pins: my own, only for chats I can see
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
insert into public.channel_pins (channel_id) values (current_setting('lk.g')::uuid);
do $$ begin
  begin insert into public.channel_pins (channel_id) values (current_setting('lk.p')::uuid); raise exception 'pinned a private chat I''m not in';
  exception when insufficient_privilege then null; end;
  begin insert into public.channel_pins (user_id, channel_id) values ('a7a7a7a2-0000-4000-8000-000000000002', current_setting('lk.g')::uuid); raise exception 'pinned for Quinn';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
do $$ begin
  assert (select count(*) from public.channel_pins) = 0, 'Quinn can''t see Rua''s pins';
  delete from public.channel_pins;
end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ begin
  assert (select count(*) from public.channel_pins) = 1, 'Quinn couldn''t remove Rua''s pin';
  delete from public.channel_pins where channel_id = current_setting('lk.g')::uuid;
  assert (select count(*) from public.channel_pins) = 0, 'unpinned';
end $$;

-- files: only into, and out of, chats I can see; a message's files must be in its own chat; can't be swapped later
do $$ declare a text := current_setting('lk.a'); g text := current_setting('lk.g'); p text := current_setting('lk.p'); f text; begin
  f := a || '/' || g || '/' || 'abcdef0123456789' || '/report.pdf';
  insert into storage.objects (bucket_id, name) values ('link-files', f);
  insert into public.messages (channel_id, workspace_id, body, files) values (g::uuid, a::uuid, '📎 report.pdf', jsonb_build_array(jsonb_build_object('path', f, 'name', 'report.pdf', 'size', 1200)));
  begin insert into storage.objects (bucket_id, name) values ('link-files', a || '/' || p || '/abcdef0123456789/x.pdf'); raise exception 'uploaded into a private chat I''m not in';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects (bucket_id, name) values ('link-files', current_setting('lk.b') || '/' || g || '/abcdef0123456789/x.pdf'); raise exception 'wrong business in the path';
  exception when insufficient_privilege then null; end;
  begin insert into storage.objects (bucket_id, name) values ('link-files', 'anything.pdf'); raise exception 'odd path';
  exception when insufficient_privilege then null; end;
  begin insert into public.messages (channel_id, workspace_id, body, files) values (g::uuid, a::uuid, 'x', jsonb_build_array(jsonb_build_object('path', a || '/' || p || '/abcdef0123456789/x.pdf', 'name', 'x.pdf', 'size', 5)));
    raise exception 'pointed at a file in another chat';
  exception when others then assert sqlerrm like 'That file isn''t in this chat%', sqlerrm; end;
  begin insert into public.messages (channel_id, workspace_id, body, files) values (g::uuid, a::uuid, 'x', jsonb_build_array(jsonb_build_object('path', f, 'name', 'big.zip', 'size', 26214401)));
    raise exception 'over 25 MB';
  exception when others then assert sqlerrm like 'That file isn''t in this chat%', sqlerrm; end;
  begin update public.messages set files = '[{"path":"x","name":"y","size":1}]' where body = '📎 report.pdf'; raise exception 'swapped a file';
  exception when others then assert sqlerrm like 'Files can''t be changed%', sqlerrm; end;
  update public.messages set body = '📎 report.pdf (final)' where body = '📎 report.pdf';
  assert (select count(*) from storage.objects) = 1, 'Rua sees the #general file';
end $$;
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
insert into storage.objects (bucket_id, name) select 'link-files', current_setting('lk.a') || '/' || current_setting('lk.p') || '/0123456789abcdef/plan.pdf';
do $$ begin assert (select count(*) from storage.objects) = 2, 'Quinn (in managers) sees both files'; end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ begin
  assert (select count(*) from storage.objects) = 1, 'Rua can''t see the managers file';
  begin update storage.objects set name = name || 'x'; raise exception 'changed a file'; exception when insufficient_privilege then null; end;
  begin delete from storage.objects; raise exception 'removed a file'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('a7a7a7a4-0000-4000-8000-000000000004');
do $$ begin assert (select count(*) from storage.objects) = 0, 'another business sees no files'; end $$;

-- file storage: 20 GB a business with Riyeser Link, plus extra from HQ. Going over is refused; with Link off nothing new can
-- be uploaded (read-only); nothing is deleted.
reset role;
insert into public.company_modules (workspace_id, module, status) values (current_setting('lk.a')::uuid, 'calls', 'cancelled')
  on conflict (workspace_id, module) do update set status = 'cancelled', paid_until = null;
update public.workspaces set calls_paid_until = null where id = current_setting('lk.a')::uuid;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003'); set role authenticated;   -- Rua (member)
do $$ declare a text := current_setting('lk.a'); g text := current_setting('lk.g'); gb bigint := 1073741824; begin
  assert public.link_storage_limit(a::uuid) = 20 * gb, 'Riyeser Link: 20 GB';
  assert not public.link_storage_fits(a::uuid, 1), 'Link off: no room for anything new';
  begin insert into storage.objects (bucket_id, name, metadata) values ('link-files', a || '/' || g || '/aaaaaaaa00000000/off.zip', jsonb_build_object('size', 10));
    raise exception 'uploaded with Link off';
  exception when insufficient_privilege then null; end;
end $$;
-- Riyeser Link on (trial): uploads up to 20 GB
reset role;
update public.company_modules set status = 'trial', trial_ends = current_date + 10 where workspace_id = current_setting('lk.a')::uuid and module = 'calls';
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare a text := current_setting('lk.a'); g text := current_setting('lk.g'); gb bigint := 1073741824; begin
  insert into storage.objects (bucket_id, name, metadata) values ('link-files', a || '/' || g || '/aaaaaaaa11111111/big1.zip', jsonb_build_object('size', gb + gb / 2));
  assert public.link_storage_used(a::uuid) = gb + gb / 2, format('used counts the sizes: %s', public.link_storage_used(a::uuid));
  assert public.link_storage_fits(a::uuid, gb / 4) and not public.link_storage_fits(a::uuid, 19 * gb), 'room for a quarter GB, not 19 more';
  begin insert into storage.objects (bucket_id, name, metadata) values ('link-files', a || '/' || g || '/aaaaaaaa22222222/huge.zip', jsonb_build_object('size', 19 * gb));
    raise exception 'went over 20 GB';
  exception when insufficient_privilege then null; end;
  insert into storage.objects (bucket_id, name, metadata) values ('link-files', a || '/' || g || '/aaaaaaaa33333333/small.zip', jsonb_build_object('size', gb / 4));
  begin perform public.link_storage_json(a::uuid); raise exception 'a member saw the storage panel';
  exception when others then assert sqlerrm like 'Only owners and admins%', sqlerrm; end;
end $$;
select pg_temp.as_user('a7a7a7a1-0000-4000-8000-000000000001');   -- Pip (owner)
do $$ declare j json; begin
  j := public.link_storage_json(current_setting('lk.a')::uuid);
  assert (j ->> 'used')::bigint = 1879048192 and (j ->> 'limit')::bigint = 21474836480 and (j ->> 'pct')::numeric = 8.8 and (j ->> 'plus')::boolean, format('storage panel: %s', j);
end $$;
select pg_temp.as_user('a7a7a7a4-0000-4000-8000-000000000004');   -- Sol, another business
do $$ begin
  begin perform public.link_storage_used(current_setting('lk.a')::uuid); raise exception 'saw another business''s storage';
  exception when others then assert sqlerrm like 'You''re not in that company%', sqlerrm; end;
  begin perform public.link_storage_json(current_setting('lk.a')::uuid); raise exception 'saw another business''s storage panel';
  exception when others then assert sqlerrm like 'Only owners and admins%', sqlerrm; end;
  assert public.link_storage_used(current_setting('lk.b')::uuid) = 0, 'own business: nothing yet';
end $$;
-- a 1 GB file fits too
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare a text := current_setting('lk.a'); gb bigint := 1073741824; begin
  insert into storage.objects (bucket_id, name, metadata) values ('link-files', a || '/' || current_setting('lk.g') || '/aaaaaaaa22222222/big2.zip', jsonb_build_object('size', gb));
end $$;
-- HQ: extra storage needs licences.manage and a reason, and is in the HQ history
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');   -- Help Desk (support)
do $$ begin
  assert ((public.hq_company_page(current_setting('lk.a')::uuid) -> 'storage') ->> 'limit')::bigint = 20::bigint * 1073741824, 'support sees the storage card';
  begin perform public.hq_grant_storage(current_setting('lk.a')::uuid, 5, 'Big drawings'); raise exception 'support granted storage';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');   -- Sam (owner)
do $$ declare j json; gb bigint := 1073741824; a uuid := current_setting('lk.a')::uuid; begin
  begin perform public.hq_grant_storage(a, 5, ''); raise exception 'no reason';
  exception when others then assert sqlerrm like 'Say why%', sqlerrm; end;
  j := public.hq_grant_storage(a, 5, 'Lots of site drawings');
  assert (j ->> 'limit')::bigint = 25 * gb and (j ->> 'extra_gb')::int = 5, format('Riyeser Link 20 + 5 extra: %s', j);
  assert exists (select 1 from pg_temp.audit('licence.storage') x where x.details ->> 'reason' = 'Lots of site drawings'), 'in the HQ history';
  j := public.hq_company_page(a) -> 'storage';
  assert (j ->> 'used')::bigint = gb * 11 / 4, format('HQ storage card: %s', j);
end $$;
-- Riyeser Link ends: still 20 + extra GB, nothing is deleted, and "over 80%" finds it in HQ's Companies list
reset role;
insert into storage.objects (bucket_id, name, metadata) select 'link-files', current_setting('lk.a') || '/' || current_setting('lk.g') || '/aaaaaaaa44444444/site.zip',
  jsonb_build_object('size', 17::bigint * 1073741824);
update public.company_modules set status = 'cancelled', trial_ends = null where workspace_id = current_setting('lk.a')::uuid and module = 'calls';
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare r json; a uuid := current_setting('lk.a')::uuid; begin
  perform public.hq_grant_storage(a, 1, 'Back to a small extra');
  assert public.link_storage_limit(a) = 21::bigint * 1073741824, '20 GB + 1 extra';
  assert (select count(*) from storage.objects where name like a::text || '/%' and bucket_id = 'link-files') >= 4, 'files kept';
  r := public.hq_companies_page('Sample Link', '{"storage_80": true}', 'name', false, 1, 50, false);
  assert (r ->> 'total')::int = 1 and ((r -> 'rows' -> 0) ->> 'storage_pct')::numeric > 80, format('storage over 80%%: %s', r -> 'rows');
  r := public.hq_companies_page('Other Link', '{"storage_80": true}', 'name', false, 1, 50, false);
  assert (r ->> 'total')::int = 0, 'Other Link Co is under 80%';
end $$;
-- No prices or money for people in the business: the licence they read has programs, dates and seats only;
-- the money functions are HQ's alone (the owner sees prices on the website and in Plan & billing, not from the database).
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003'); set role authenticated;   -- Rua (member)
do $$ declare l json; a uuid := current_setting('lk.a')::uuid; begin
  l := public.company_licence(a);
  assert (l -> 'modules' -> 'calls' ->> 'status') is not null and (l -> 'seats') is not null, 'programs, dates and seats are there';
  -- (the programs are keyed by their ids, and one program is Riyeser Estimate, id 'estimate': check money keys outside them)
  assert (l::jsonb - 'modules')::text !~* '"(monthly|price|prices|amount|estimate)"\s*:', format('no money in the licence: %s', l);
  assert not exists (select 1 from jsonb_each(l::jsonb -> 'modules') e where e.value::text ~* '"(monthly|price|prices|amount|estimate)"\s*:'),
    format('no money in the licence''s programs: %s', l);
  begin perform public.company_monthly(a); raise exception 'a member read the monthly estimate';
  exception when insufficient_privilege then null; end;
  begin perform public.riyeser_people(a); raise exception 'a member read the people paid for';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_company_licence(a); raise exception 'a member read HQ''s licence and estimate';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert (select public = false and file_size_limit = 26214400 from storage.buckets where id = 'link-files'), 'a private bucket, 25 MB';
  assert (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('presence', 'message_reactions')) = 2, 'live updates';
  assert exists (select 1 from pg_constraint where conname = 'call_signals_kind_check' and pg_get_constraintdef(oid) like '%hold%'), 'hold signal';
end $$;

-- --- Signed licences: the licence function names a PC only when it's linked to the business, for people in it
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_a')::uuid; begin
  assert public.licence_device_linked(ws, 'e1e1e1e1-0000-4000-8000-000000000001'), 'a PC linked to the business';
  assert not public.licence_device_linked(ws, 'e1e1e1e1-0000-4000-8000-0000000000ff'), 'a PC that was never linked';
  assert not public.licence_device_linked((select id from public.workspaces where name = 'Corner Cafe'), 'e1e1e1e1-0000-4000-8000-000000000001'), 'linked to another business';
end $$;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
do $$ begin assert public.licence_device_linked(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001'), 'anyone in the business (not only who linked it)'; end $$;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
do $$ begin
  assert not public.licence_device_linked(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001'), 'someone from another business learns nothing';
  assert not public.licence_device_linked((select id from public.workspaces where name = 'Corner Cafe'), 'e1e1e1e1-0000-4000-8000-000000000001'), 'another business''s PC';
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.licence_device_linked(current_setting('test.ws_a')::uuid, 'e1e1e1e1-0000-4000-8000-000000000001'); raise exception 'anon checked a PC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== Riyeser Link: the channel menu (rename, topic, archive / bring back, mute, leave; #general protected)
-- Channel Menu Co: Ola (owner), Pita (admin), Mele (member, made #jobs), Tui (member). Vai owns another business.
reset role;
insert into auth.users (id, email) values ('c4c4c4c1-0000-4000-8000-000000000001', 'ola@cm.test'), ('c4c4c4c2-0000-4000-8000-000000000002', 'pita@cm.test'),
  ('c4c4c4c3-0000-4000-8000-000000000003', 'mele@cm.test'), ('c4c4c4c4-0000-4000-8000-000000000004', 'tui@cm.test'), ('c4c4c4c5-0000-4000-8000-000000000005', 'vai@cm.test');
do $$ declare a uuid; b uuid; g uuid; j uuid; o uuid; x uuid; d uuid; m uuid; begin
  insert into public.workspaces (name) values ('Channel Menu Co') returning id into a;
  insert into public.workspaces (name) values ('Other Menu Co') returning id into b;
  insert into public.members (workspace_id, user_id, display_name, role) values (a, 'c4c4c4c1-0000-4000-8000-000000000001', 'Ola', 'owner'),
    (a, 'c4c4c4c2-0000-4000-8000-000000000002', 'Pita', 'admin'), (a, 'c4c4c4c3-0000-4000-8000-000000000003', 'Mele', 'member'),
    (a, 'c4c4c4c4-0000-4000-8000-000000000004', 'Tui', 'member'), (b, 'c4c4c4c5-0000-4000-8000-000000000005', 'Vai', 'owner');
  insert into public.channels (workspace_id, kind, name, created_by) values (a, 'channel', 'general', 'c4c4c4c1-0000-4000-8000-000000000001') returning id into g;
  insert into public.channels (workspace_id, kind, name, created_by) values (a, 'channel', 'jobs', 'c4c4c4c3-0000-4000-8000-000000000003') returning id into j;
  insert into public.channels (workspace_id, kind, name, created_by) values (a, 'channel', 'office', 'c4c4c4c1-0000-4000-8000-000000000001') returning id into o;
  insert into public.channels (workspace_id, kind, name, created_by) values (a, 'private', 'execs', 'c4c4c4c1-0000-4000-8000-000000000001') returning id into x;
  insert into public.channel_members values (x, 'c4c4c4c1-0000-4000-8000-000000000001'), (x, 'c4c4c4c4-0000-4000-8000-000000000004');
  insert into public.channels (workspace_id, kind, dm_key, created_by) values (a, 'dm', 'cm-dm', 'c4c4c4c4-0000-4000-8000-000000000004') returning id into d;
  insert into public.channel_members values (d, 'c4c4c4c3-0000-4000-8000-000000000003'), (d, 'c4c4c4c4-0000-4000-8000-000000000004');
  insert into public.messages (channel_id, workspace_id, user_id, body) values (o, a, 'c4c4c4c4-0000-4000-8000-000000000004', 'Invoices are on the desk') returning id into m;
  perform set_config('cm.a', a::text, false), set_config('cm.g', g::text, false), set_config('cm.j', j::text, false), set_config('cm.o', o::text, false),
    set_config('cm.x', x::text, false), set_config('cm.d', d::text, false), set_config('cm.m', m::text, false);
  -- a second #general can't be made
  begin insert into public.channels (workspace_id, kind, name) values (a, 'channel', 'general'); raise exception 'two generals';
  exception when others then assert sqlerrm like 'There''s already a #general%', sqlerrm; end;
end $$;
set role authenticated;

-- Mele made #jobs, so Mele can rename it and change its topic (the name is tidied: "Site Jobs" becomes site-jobs)
select pg_temp.as_user('c4c4c4c3-0000-4000-8000-000000000003');
do $$ declare j uuid := current_setting('cm.j')::uuid; begin
  assert public.channel_can_manage(j) and not public.channel_can_manage(current_setting('cm.o')::uuid), 'Mele manages #jobs only';
  perform public.channel_rename(j, '#Site Jobs', '  Bookings and call-outs ');
  assert (select name || '|' || topic from public.channels where id = j) = 'site-jobs|Bookings and call-outs', 'renamed and topic set';
  perform public.channel_rename(j, null, '');
  assert (select name = 'site-jobs' and topic is null from public.channels where id = j), 'topic cleared, name kept';
  begin perform public.channel_rename(j, 'bad/name!', null); raise exception 'bad name';
  exception when others then assert sqlerrm like 'Use up to 40%', sqlerrm; end;
  begin perform public.channel_rename(j, 'General', null); raise exception 'renamed to general';
  exception when others then assert sqlerrm like 'There''s already a #general%', sqlerrm; end;
  begin perform public.channel_rename(j, null, repeat('x', 201)); raise exception 'long topic';
  exception when others then assert sqlerrm like 'Keep the topic%', sqlerrm; end;
end $$;
-- Tui (a member who didn't make them) can't rename or archive, through the action or directly
select pg_temp.as_user('c4c4c4c4-0000-4000-8000-000000000004');
do $$ declare j uuid := current_setting('cm.j')::uuid; o uuid := current_setting('cm.o')::uuid; begin
  assert not public.channel_can_manage(j), 'Tui can''t manage #site-jobs';
  begin perform public.channel_rename(j, 'tuis', null); raise exception 'Tui renamed';
  exception when others then assert sqlerrm like 'Only whoever made this channel%', sqlerrm; end;
  begin perform public.channel_archive(o, true); raise exception 'Tui archived';
  exception when others then assert sqlerrm like 'Only whoever made this channel%', sqlerrm; end;
  update public.channels set name = 'tuis' where id = o;
  assert (select name from public.channels where id = o) = 'office', 'a direct rename by Tui changes nothing';
  begin update public.channels set archived = true where id = o; raise exception 'Tui archived directly';
  exception when insufficient_privilege then null; end;
  begin perform public.channel_rename(current_setting('cm.d')::uuid, 'x', null); raise exception 'renamed a DM';
  exception when others then assert sqlerrm like 'Direct messages don''t%', sqlerrm; end;
end $$;
-- #general: not archived, not renamed, not left, by anyone (even the owner)
select pg_temp.as_user('c4c4c4c1-0000-4000-8000-000000000001');
do $$ declare g uuid := current_setting('cm.g')::uuid; begin
  assert public.channel_can_manage(g), 'the owner manages #general (its topic)';
  begin perform public.channel_archive(g, true); raise exception 'archived general';
  exception when others then assert sqlerrm like '#general is where everyone%', sqlerrm; end;
  begin perform public.channel_rename(g, 'everyone', null); raise exception 'renamed general';
  exception when others then assert sqlerrm like '#general keeps its name%', sqlerrm; end;
  begin update public.channels set name = 'everyone' where id = g; raise exception 'renamed general directly';
  exception when others then assert sqlerrm like '#general keeps its name%', sqlerrm; end;
  perform public.channel_rename(g, 'general', 'Everyone at Channel Menu Co');
  assert (select topic from public.channels where id = g) = 'Everyone at Channel Menu Co', 'the topic of #general can change';
  begin perform public.channel_leave(g); raise exception 'left general';
  exception when others then assert sqlerrm like '#general is for everyone%', sqlerrm; end;
end $$;
-- An admin archives #office: hidden for everyone, read-only, nothing deleted; only with two-step sign-in
select pg_temp.as_user_password_only('c4c4c4c2-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.channel_archive(current_setting('cm.o')::uuid, true); raise exception 'archived without two-step';
  exception when others then assert sqlerrm like 'Only whoever made this channel%', sqlerrm; end;
end $$;
select pg_temp.as_user('c4c4c4c2-0000-4000-8000-000000000002');
do $$ declare o uuid := current_setting('cm.o')::uuid; begin
  perform public.channel_archive(o, true);
  assert (select archived and archived_by = auth.uid() and archived_at > now() - interval '1 minute' from public.channels where id = o), 'archived, by Pita, now';
  perform public.channel_archive(o, true);   -- again: nothing changes
end $$;
select pg_temp.as_user('c4c4c4c4-0000-4000-8000-000000000004');
do $$ declare o uuid := current_setting('cm.o')::uuid; begin
  assert (select archived from public.channels where id = o), 'Tui still sees #office, as archived';
  assert (select count(*) from public.messages where channel_id = o and system is null) = 1, 'its messages are kept and readable';
  assert (select body from public.messages where channel_id = o and system ->> 'kind' = 'archive') = 'archived this channel', 'Tui sees the "archived" line';
  begin insert into public.messages (channel_id, workspace_id, body) values (o, current_setting('cm.a')::uuid, 'still here?'); raise exception 'posted in archived';
  exception when others then assert sqlerrm like 'This channel is archived%', sqlerrm; end;
  begin update public.messages set body = 'edited' where id = current_setting('cm.m')::uuid; raise exception 'edited in archived';
  exception when others then assert sqlerrm like 'This channel is archived%', sqlerrm; end;
  begin insert into public.message_reactions (message_id, emoji) values (current_setting('cm.m')::uuid, '👍'); raise exception 'reacted in archived';
  exception when others then assert sqlerrm like 'This channel is archived%', sqlerrm; end;
  begin perform public.channel_archive(o, false); raise exception 'Tui brought it back';
  exception when others then assert sqlerrm like 'Only whoever made this channel%', sqlerrm; end;
end $$;
-- Ola made #office, so Ola can bring it back; then posting works again. The History shows both.
select pg_temp.as_user('c4c4c4c1-0000-4000-8000-000000000001');
do $$ declare o uuid := current_setting('cm.o')::uuid; begin
  begin perform public.channel_rename(o, 'old-office', null); raise exception 'renamed while archived';
  exception when others then assert sqlerrm like 'This channel is archived. Bring it back first%', sqlerrm; end;
  perform public.channel_archive(o, false);
  assert (select not archived and archived_at is null and archived_by is null from public.channels where id = o), 'brought back';
  insert into public.messages (channel_id, workspace_id, body) values (o, current_setting('cm.a')::uuid, 'Back in business');
  assert (select string_agg(action || ' ' || (details ->> 'name'), ', ' order by id) from public.audit_log where workspace_id = current_setting('cm.a')::uuid and action in ('channel.rename', 'channel.archive', 'channel.unarchive'))
    = 'channel.rename #site-jobs, channel.archive #office, channel.unarchive #office', 'history of renames and archiving';
end $$;
-- Mute and Leave are each person's own
select pg_temp.as_user('c4c4c4c4-0000-4000-8000-000000000004');
do $$ declare j uuid := current_setting('cm.j')::uuid; x uuid := current_setting('cm.x')::uuid; begin
  perform public.channel_mute(j, true); perform public.channel_mute(current_setting('cm.d')::uuid, true);
  assert (select count(*) from public.channel_prefs where muted) = 2, 'Tui muted #site-jobs and the DM';
  perform public.channel_mute(current_setting('cm.d')::uuid, false);
  assert (select count(*) from public.channel_prefs where muted) = 1, 'and unmuted the DM';
  begin insert into public.channel_prefs (channel_id, muted) values (current_setting('cm.g')::uuid, true); raise exception 'wrote prefs directly';
  exception when insufficient_privilege then null; end;
  perform public.channel_leave(j);
  assert (select left_at is not null from public.channel_prefs where channel_id = j), 'left #site-jobs';
  assert exists (select 1 from public.channels where id = j), 'an everyone channel can still be found to join again';
  perform public.channel_rejoin(j);
  assert (select left_at is null and muted from public.channel_prefs where channel_id = j), 'joined again, still muted';
  begin perform public.channel_leave(current_setting('cm.d')::uuid); raise exception 'left a DM';
  exception when others then assert sqlerrm like 'You can''t leave a direct message%', sqlerrm; end;
  perform public.channel_leave(x);
  assert not exists (select 1 from public.channels where id = x), 'left the private #execs: can''t see it';
  begin perform public.channel_leave(x); raise exception 'left twice';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
end $$;
select pg_temp.as_user('c4c4c4c3-0000-4000-8000-000000000003');
do $$ begin assert not exists (select 1 from public.channel_prefs), 'Mele sees none of Tui''s mutes'; end $$;
-- the last person in a private channel can't leave it empty; an admin who isn't in it can't archive it
select pg_temp.as_user('c4c4c4c1-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.channel_leave(current_setting('cm.x')::uuid); raise exception 'left it empty';
  exception when others then assert sqlerrm like 'You''re the only person%', sqlerrm; end;
end $$;
select pg_temp.as_user('c4c4c4c2-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.channel_archive(current_setting('cm.x')::uuid, true); raise exception 'archived a private chat I''m not in';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
end $$;
-- Part 2: the line each change leaves in the chat, the change history, mute for a while, people in and out of a private channel
select pg_temp.as_user('c4c4c4c3-0000-4000-8000-000000000003');
do $$ declare j uuid := current_setting('cm.j')::uuid; begin
  assert (select string_agg(system ->> 'kind' || ':' || body, ' | ' order by created_at, body) from public.messages where channel_id = j and system is not null)
    = 'topic:changed the topic to: Bookings and call-outs | topic:cleared the topic | rename:renamed #jobs to #site-jobs', 'Mele sees the lines for #site-jobs';
  assert (select bool_and(user_id = auth.uid()) from public.messages where channel_id = j and system is not null), 'each line is from whoever made the change';
  perform public.channel_rename(j, 'site-jobs', null);   -- nothing changed: no new line
  assert (select count(*) from public.messages where channel_id = j and system is not null) = 3, 'no line when nothing changes';
  -- nobody can write a line themselves, or change one
  begin insert into public.messages (channel_id, workspace_id, body, system) values (j, current_setting('cm.a')::uuid, 'renamed #x to #y', '{"kind": "rename"}');
    raise exception 'wrote a system line';
  exception when others then assert sqlerrm like 'Only Riyeser Link adds%', sqlerrm; end;
  begin update public.messages set body = 'renamed it to #fun' where channel_id = j and system ->> 'kind' = 'rename'; raise exception 'edited a system line';
  exception when others then assert sqlerrm like 'This line can''t be changed%', sqlerrm; end;
  begin perform public.channel_note(j, current_setting('cm.a')::uuid, 'rename', '{}', 'x'); raise exception 'called channel_note';
  exception when insufficient_privilege then null; end;
  assert not exists (select 1 from public.messages where channel_id = j and system is not null and body like '%#fun%'), 'the line is unchanged';
  -- members can't read the change history
  assert not exists (select 1 from public.audit_log), 'Mele (a member) reads no change history';
end $$;
select pg_temp.as_user('c4c4c4c1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('cm.a')::uuid; x uuid := current_setting('cm.x')::uuid; begin
  -- the owner's change history has the topic changes too
  assert (select count(*) from public.audit_log where workspace_id = a and action = 'channel.topic') = 3, 'three topic changes in the history';
  -- people in and out of the private #execs (Tui left it earlier): added, then removed, each a line and in the history
  perform public.set_channel_people(x, array['c4c4c4c3-0000-4000-8000-000000000003'::uuid, 'c4c4c4c4-0000-4000-8000-000000000004'::uuid], '{}');
  perform public.set_channel_people(x, '{}', array['c4c4c4c3-0000-4000-8000-000000000003'::uuid]);
  perform public.set_channel_people(x, '{}', array['c4c4c4c5-0000-4000-8000-000000000005'::uuid]);   -- not in it: nothing to record
  assert (select string_agg(body, ' | ' order by created_at, body) from public.messages where channel_id = x and system is not null)
    = 'left | added Mele, Tui | removed Mele', 'the lines in #execs';
  assert (select string_agg((details -> 'added')::text || (details -> 'removed')::text, ' | ' order by id) from public.audit_log where workspace_id = a and action = 'channel.members')
    = '["Mele", "Tui"][] | []["Mele"]', 'who was added and removed, in the history';
end $$;
-- Tui: mute for a while (within a year), and an unmute clears the time
select pg_temp.as_user('c4c4c4c4-0000-4000-8000-000000000004');
do $$ declare g uuid := current_setting('cm.g')::uuid; x uuid := current_setting('cm.x')::uuid; begin
  assert exists (select 1 from public.messages where channel_id = x and system ->> 'kind' = 'add'), 'Tui, added back, sees the line';
  assert (select unread from public.unread_counts(current_setting('cm.a')::uuid) where channel_id = current_setting('cm.j')::uuid) = 0,
    'the lines in #site-jobs aren''t unread messages for Tui';
  perform public.channel_mute_until(g, now() + interval '8 hours');
  assert (select muted and muted_until > now() + interval '7 hours' from public.channel_prefs where channel_id = g), 'muted for 8 hours';
  perform public.channel_mute_until(g, null);
  assert (select muted and muted_until is null from public.channel_prefs where channel_id = g), 'muted until turned back on';
  begin perform public.channel_mute_until(g, now() - interval '1 minute'); raise exception 'muted until the past';
  exception when others then assert sqlerrm like 'Choose a time in the next year%', sqlerrm; end;
  begin perform public.channel_mute_until(g, now() + interval '400 days'); raise exception 'muted for over a year';
  exception when others then assert sqlerrm like 'Choose a time in the next year%', sqlerrm; end;
  perform public.channel_mute_until(g, now() + interval '1 hour'); perform public.channel_mute(g, false);
  assert (select not muted and muted_until is null from public.channel_prefs where channel_id = g), 'unmuted: no time left over';
  begin update public.messages set system = '{"kind": "rename"}' where id = current_setting('cm.m')::uuid; raise exception 'made a message a system line';
  exception when others then assert sqlerrm like 'This line can''t be changed%', sqlerrm; end;
  -- a member who didn't make #execs can't change who's in it
  begin perform public.set_channel_people(x, array['c4c4c4c3-0000-4000-8000-000000000003'::uuid], '{}'); raise exception 'Tui added someone';
  exception when others then assert sqlerrm like 'Only whoever made this channel%', sqlerrm; end;
end $$;
-- another business: no mute, no people changes, no lines to read
select pg_temp.as_user('c4c4c4c5-0000-4000-8000-000000000005');
do $$ begin
  begin perform public.channel_mute_until(current_setting('cm.j')::uuid, now() + interval '1 hour'); raise exception 'Vai muted for a while';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
  begin perform public.set_channel_people(current_setting('cm.x')::uuid, array['c4c4c4c5-0000-4000-8000-000000000005'::uuid], '{}'); raise exception 'Vai joined #execs';
  exception when others then assert sqlerrm like 'That isn''t a private channel%' or sqlerrm like 'Only whoever%', sqlerrm; end;
  assert not exists (select 1 from public.messages where system is not null and workspace_id = current_setting('cm.a')::uuid), 'Vai reads none of the lines';
end $$;
-- another business can't touch any of it, and signed-out visitors can't call the actions
select pg_temp.as_user('c4c4c4c5-0000-4000-8000-000000000005');
do $$ declare j uuid := current_setting('cm.j')::uuid; begin
  assert not public.channel_can_manage(j), 'Vai manages nothing here';
  begin perform public.channel_rename(j, 'vai', null); raise exception 'Vai renamed';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
  begin perform public.channel_archive(j, true); raise exception 'Vai archived';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
  begin perform public.channel_mute(j, true); raise exception 'Vai muted';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
  begin perform public.channel_leave(j); raise exception 'Vai left';
  exception when others then assert sqlerrm like 'That channel isn''t there%', sqlerrm; end;
end $$;
reset role; set role anon; select pg_temp.as_user('');
do $$ begin
  begin perform public.channel_archive(current_setting('cm.j')::uuid, true); raise exception 'anon archived';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ================================================================ Payments (PayPal subscriptions, bank transfer invoices)
-- Pay Co: Lisi (owner), Ana (admin), Tom (member). Viliami owns Other Pay Co. HQ: Fina (finance), Sol (sales: can look, not mark paid).
reset role;
insert into auth.users (id, email) values ('b1b1b1b1-0000-4000-8000-000000000001', 'lisi@pay.test'), ('b1b1b1b1-0000-4000-8000-000000000002', 'ana@pay.test'),
  ('b1b1b1b1-0000-4000-8000-000000000003', 'tom@pay.test'), ('b1b1b1b1-0000-4000-8000-000000000004', 'viliami@pay.test'),
  ('b1b1b1b1-0000-4000-8000-000000000005', 'fina@riyeser.test'), ('b1b1b1b1-0000-4000-8000-000000000006', 'sol@riyeser.test');
insert into public.hq_staff (user_id, display_name, role) values ('b1b1b1b1-0000-4000-8000-000000000005', 'Fina', 'finance'), ('b1b1b1b1-0000-4000-8000-000000000006', 'Sol', 'sales');
do $$ declare a uuid; b uuid; begin
  insert into public.workspaces (name) values ('Pay Co') returning id into a;
  insert into public.workspaces (name) values ('Other Pay Co') returning id into b;
  insert into public.members (workspace_id, user_id, display_name, role) values (a, 'b1b1b1b1-0000-4000-8000-000000000001', 'Lisi', 'owner'),
    (a, 'b1b1b1b1-0000-4000-8000-000000000002', 'Ana', 'admin'), (a, 'b1b1b1b1-0000-4000-8000-000000000003', 'Tom', 'member'),
    (b, 'b1b1b1b1-0000-4000-8000-000000000004', 'Viliami', 'owner');
  perform set_config('pay.a', a::text, false), set_config('pay.b', b::text, false), set_config('pay.te', (current_date + 90)::text, false);
end $$;
set role authenticated;
-- the early bird is full (100 businesses, above): the quote is the normal price
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare q json := public.billing_quote(current_setting('pay.a')::uuid, array['plus', 'payroll'], 5, 'monthly'); begin
  assert not (q ->> 'early_bird')::boolean and (q ->> 'due_now')::numeric = 92, 'no early bird once 100 have it';
end $$;
reset role; update public.company_plans set early_bird = false where workspace_id in (select id from public.workspaces where name like 'Early bird %'); set role authenticated;
-- the owner (even before two-step sign-in) gets a quote from the same price list as the website, early bird included
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pay.a')::uuid; q json; begin
  q := public.billing_quote(a, array['plus', 'payroll'], 5, 'monthly');
  assert (q ->> 'amount')::numeric = 92 and (q ->> 'amount')::numeric = public.riyeser_bill(array['plus', 'payroll'], 5, 0, 'monthly', false), 'quote = riyeser_bill = 92';
  assert (q ->> 'early_bird')::boolean and (q ->> 'first_amount')::numeric = 46 and (q ->> 'early_cycles')::int = 12, 'early bird: half for 12 months';
  q := public.billing_quote(a, array['basic', 'plus', 'plus', 'link'], 3, 'yearly');
  assert (q ->> 'amount')::numeric = 390 and json_array_length(q -> 'modules') = 1, 'Basics and Plus = Plus only; free programs ignored; yearly = 10 months';
  -- pricing v2: users per program, POS tills, bundles; Riyeser Link counts at least everyone in the business
  q := public.billing_quote(a, array['basic', 'pos', 'calls'], 3, 'monthly', '{"basic": 5, "calls": 1}', 3);
  assert (q ->> 'bundle') = 'shop' and (q ->> 'tills')::int = 3 and (q -> 'users' ->> 'calls')::int = (select count(*) from public.members where workspace_id = a)
    and (q ->> 'amount')::numeric = 59 + 14 + 7 * greatest(0, (q -> 'users' ->> 'calls')::int - 3) + 30, format('Shop bundle quote: %s', q);
  assert json_array_length(q -> 'lines') = 1 and (q -> 'lines' -> 0 ->> 'name') = 'Shop bundle', 'one bundle line';
  q := public.billing_quote(a, array['plus', 'payroll', 'pos', 'bookings', 'calls'], 3, 'monthly');
  assert (q ->> 'bundle') = 'business' and (q ->> 'bundle_saves')::numeric = 39, format('Business bundle saves 39: %s', q);
  begin perform public.billing_quote(a, array['plus'], 3, 'weekly'); raise exception 'weekly';
  exception when others then assert sqlerrm like 'Choose monthly or yearly%', sqlerrm; end;
  begin perform public.billing_start(a, array['link', 'pdf'], 3, 'monthly', 'bank'); raise exception 'free only';
  exception when others then assert sqlerrm like 'Choose at least one paid program%', sqlerrm; end;
end $$;
-- admins, staff and other businesses can't pay, quote or see billing; nobody reads the tables directly
do $$ declare u text; a uuid := current_setting('pay.a')::uuid; begin
  foreach u in array array['b1b1b1b1-0000-4000-8000-000000000002', 'b1b1b1b1-0000-4000-8000-000000000003', 'b1b1b1b1-0000-4000-8000-000000000004'] loop
    perform pg_temp.as_user(u);
    begin perform public.billing_quote(a, array['plus'], 3, 'monthly'); raise exception 'quoted';
    exception when others then assert sqlerrm like 'Only the business owner%', u || ': ' || sqlerrm; end;
    begin perform public.billing_start(a, array['plus'], 3, 'monthly', 'bank'); raise exception 'paid';
    exception when others then assert sqlerrm like 'Only the business owner%', u || ': ' || sqlerrm; end;
    begin perform public.my_billing(a); raise exception 'saw billing';
    exception when others then assert sqlerrm like 'Only the business owner%', u || ': ' || sqlerrm; end;
    begin perform public.billing_cancel_start(a); raise exception 'cancelled';
    exception when others then assert sqlerrm like 'Only the business owner%', u || ': ' || sqlerrm; end;
  end loop;
  begin perform count(*) from public.billing_orders; raise exception 'read orders';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.billing_payments; raise exception 'read payments';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.billing_entities; raise exception 'read entities';
  exception when insufficient_privilege then null; end;
end $$;
-- only the paypal function (service role) records PayPal's side: not a signed-in person
do $$ begin
  begin perform public.billing_paypal_event('WH-x', 'PAYMENT.SALE.COMPLETED', '{}', 'live'); raise exception 'fake webhook';
  exception when insufficient_privilege then null; end;
  begin perform public.billing_paypal_created(gen_random_uuid(), 'I-ABCDEFGH', 'live'); raise exception 'fake created';
  exception when insufficient_privilege then null; end;
end $$;
reset role; set role anon; select pg_temp.as_user('');
do $$ begin
  begin perform public.billing_start(current_setting('pay.a')::uuid, array['plus'], 3, 'monthly', 'bank'); raise exception 'anon paid';
  exception when insufficient_privilege then null; end;
end $$;
reset role; set role authenticated;

-- ---- bank transfer: an invoice; the licence is NOT on until HQ marks it paid (the free trial carries on)
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pay.a')::uuid; o json; b json; begin
  o := public.billing_start(a, array['plus', 'payroll'], 5, 'monthly', 'bank');
  assert o ->> 'ref' like 'RI-1%' and o ->> 'status' = 'pending' and (o ->> 'amount')::numeric = 92 and (o ->> 'total')::numeric = 46, 'invoice for 46 (early bird of 92)';
  assert (o ->> 'due_date')::date = current_date + 14 and o -> 'seller' ->> 'name' = 'Riyeser' and o -> 'seller' ->> 'tax_label' = 'ABN', 'due in 14 days, seller from the Billing entity';
  assert coalesce(o -> 'seller' -> 'bank' ->> 'account_number', '') = '', 'bank details blank until HQ adds them';
  assert not (public.my_billing(a) ->> 'bank_ready')::boolean, 'OWNER-PAYOFF: no bank details yet, so no bank transfer offered';
  perform set_config('pay.inv1', o ->> 'ref', false);
  b := public.my_billing(a);
  assert json_array_length(b -> 'orders') = 1 and b -> 'licence' -> 'modules' -> 'plus' ->> 'status' = 'trial', 'not paid yet: still the free trial';
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000004');
do $$ declare b json := public.my_billing(current_setting('pay.b')::uuid); begin
  assert json_array_length(b -> 'orders') = 0 and json_array_length(b -> 'payments') = 0, 'another business sees none of it';
end $$;
-- HQ: sales can see it (in the work queue), but only licences.manage (Owner, Finance) marks it paid
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ declare h json := public.hq_billing(); q json := public.hq_work_queue(); begin
  assert json_array_length(h -> 'unpaid') >= 1 and not (h ->> 'bank_ready')::boolean and not (h ->> 'can_mark_paid')::boolean, 'sales sees unpaid invoices';
  assert exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'kind' = 'invoice' and x ->> 'ref' = current_setting('pay.inv1')), 'unpaid invoice in the work queue';
  -- "Assigned to": a person or nobody, never the team's name; the team says whose queue it's in
  assert exists (select 1 from json_array_elements(q -> 'queue') x where x ->> 'kind' = 'invoice' and x ->> 'team' = 'Finance' and x ->> 'owner' <> 'Finance'), 'invoice: Finance team, not "Owner: Finance"';
  begin perform public.hq_billing_mark_paid(current_setting('pay.inv1'), 'BANK REF 1', 46); raise exception 'sales marked paid';
  exception when others then assert sqlerrm like 'Your HQ role can''t%', sqlerrm; end;
  begin perform public.hq_set_billing_entity('{"name": "Sol Pty Ltd"}'); raise exception 'sales changed the entity';
  exception when others then assert sqlerrm like 'Your HQ role can''t%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000005');
do $$ begin
  begin perform public.hq_billing(); raise exception 'HQ without two-step';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
do $$ declare a uuid := current_setting('pay.a')::uuid; r json; te date; begin
  begin perform public.hq_billing_mark_paid(current_setting('pay.inv1'), 'BANK REF 1', 20); raise exception 'short payment';
  exception when others then assert sqlerrm like 'The invoice is for US$46.00%', sqlerrm; end;
  begin perform public.hq_billing_mark_paid(current_setting('pay.inv1'), '', 46); raise exception 'no reference';
  exception when others then assert sqlerrm like 'Type the bank''s reference%', sqlerrm; end;
  te := current_setting('pay.te')::date;
  r := public.hq_billing_mark_paid(lower(current_setting('pay.inv1')), 'WESTPAC 88123', 46);
  assert (r ->> 'paid_until')::date = (te + interval '1 month')::date, 'paid time starts when the free trial ends';
  assert r ->> 'receipt' like 'RR-1%', 'a receipt number';
  begin perform public.hq_billing_mark_paid(current_setting('pay.inv1'), 'AGAIN', 46); raise exception 'paid twice';
  exception when others then assert sqlerrm like 'That invoice is already paid%', sqlerrm; end;
end $$;
reset role;
do $$ declare a uuid := current_setting('pay.a')::uuid; begin
  assert (select status from public.company_modules where workspace_id = a and module = 'plus') = 'active', 'Plus switched on';
  assert (select status from public.company_modules where workspace_id = a and module = 'payroll') = 'active', 'Payroll switched on';
  assert (public.licence_json(a) -> 'modules' -> 'payroll' ->> 'active')::boolean, 'the signed licence sees it';
  assert (select extra_users from public.company_plans where workspace_id = a) = 2 and (select early_bird from public.company_plans where workspace_id = a), 'plan: 2 extra users, early bird';
  assert exists (select 1 from public.email_outbox where workspace_id = a and template = 'billing_paid'), 'the owner is emailed';
  assert exists (select 1 from public.hq_audit where action = 'billing.bank_paid' and workspace_id = a and actor = 'b1b1b1b1-0000-4000-8000-000000000005'), 'in the HQ history, with who';
  begin delete from public.billing_payments where workspace_id = a; raise exception 'deleted a payment';
  exception when others then assert sqlerrm like 'Rows in billing_payments are never deleted%', sqlerrm; end;
end $$;
set role authenticated;
-- the Billing entity: ONLY the HQ Owner enters or changes it (SEC-011, the owner's decision); old invoices keep the old
-- details, new ones get the new. Finance is refused; the Owner's change is in force straight away and in the HQ history.
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
do $$ begin
  assert not (public.hq_billing() ->> 'can_edit_entity')::boolean, 'finance: read-only';
  begin perform public.hq_set_billing_entity('{"name": "Fina Pty Ltd", "bank": {"account_number": "999999"}}'); raise exception 'finance changed the bank details';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that. Only the Riyeser HQ Owner can change%', sqlerrm; end;
  begin perform public.hq_billing_entity_decide(1, true); raise exception 'finance approved something';
  exception when others then assert sqlerrm like 'Billing details don''t wait for approval any more%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('99999999-9999-9999-9999-999999999999');
do $$ begin
  begin perform public.hq_set_billing_entity('{"name": "Riyeser Pty Ltd"}'); raise exception 'owner without two-step';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_billing_entity('{"name": "Riyeser Pty Ltd", "address": "1 George St, Sydney NSW", "tax_label": "", "tax_number": "12 345 678 901",
  "email": "accounts@riyeser.test", "bank": {"account_name": "Riyeser Pty Ltd", "bank_name": "Westpac", "bsb": "032-000", "account_number": "123456", "junk": "x"}}');
-- the same again: nothing new (safe to repeat)
select public.hq_set_billing_entity('{"name": "Riyeser Pty Ltd", "address": "1 George St, Sydney NSW", "tax_label": "", "tax_number": "12 345 678 901",
  "email": "accounts@riyeser.test", "bank": {"account_name": "Riyeser Pty Ltd", "bank_name": "Westpac", "bsb": "032-000", "account_number": "123456"}}');
do $$ declare h json := public.hq_billing(); begin
  assert (h ->> 'can_edit_entity')::boolean, 'the Owner can edit';
  assert (h ->> 'bank_ready')::boolean and h -> 'entity' ->> 'tax_label' = 'ABN' and h -> 'entity' -> 'bank' ->> 'junk' is null, 'in force straight away: bank ready, ABN label by default, only known fields';
  assert json_typeof(h -> 'entity_pending') = 'null', 'nothing ever waits';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.billing_entities where details ->> 'name' = 'Riyeser Pty Ltd') = 1, 'one new version';
  assert (select count(*) from public.billing_entity_changes where status = 'approved' and proposed_by = '99999999-9999-9999-9999-999999999999') = 1, 'kept as a record';
  assert not exists (select 1 from public.billing_entities where details ->> 'name' like 'Fina%'), 'nothing from Finance';
  assert exists (select 1 from public.hq_audit where action = 'billing.entity_changed' and actor = '99999999-9999-9999-9999-999999999999'
     and details -> 'before' ->> 'name' = 'Riyeser' and details -> 'after' -> 'bank' ->> 'bsb' = '032-000'), 'in the HQ history: who, when, before and after';
  begin delete from public.billing_entity_changes; raise exception 'deleted a change'; exception when others then assert sqlerrm not like 'deleted a change', sqlerrm; end;
end $$;
set role authenticated;
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pay.a')::uuid; b json; o json; begin
  b := public.my_billing(a);
  assert (select x -> 'seller' ->> 'name' from json_array_elements(b -> 'orders') x where x ->> 'ref' = current_setting('pay.inv1')) = 'Riyeser', 'old invoice keeps the old seller';
  assert (select x -> 'seller' ->> 'name' from json_array_elements(b -> 'payments') x limit 1) = 'Riyeser', 'old receipt keeps the old seller';
  assert b -> 'seller' ->> 'name' = 'Riyeser Pty Ltd', 'the current seller';
  assert (b ->> 'bank_ready')::boolean and b -> 'seller' -> 'bank' is null, 'OWNER-PAYOFF: bank transfer offered once the details are in; the numbers only come on an invoice';
  o := public.billing_start(a, array['pos'], 3, 'yearly', 'bank');
  assert o -> 'seller' -> 'bank' ->> 'bsb' = '032-000' and o -> 'seller' ->> 'tax_number' = '12 345 678 901', 'a new invoice has the new details and bank';
  assert (o ->> 'early_bird')::boolean and (o ->> 'total')::numeric = 145 and (o ->> 'amount')::numeric = 290, 'still early bird (in its 12 months): half of 290';
  perform public.billing_cancel_invoice(a, o ->> 'ref');
  begin perform public.billing_cancel_invoice(a, o ->> 'ref'); raise exception 'cancelled twice';
  exception when others then assert sqlerrm like 'That invoice is already%', sqlerrm; end;
end $$;

-- ---- PayPal: the function starts it; webhooks (each applied once) do the rest
-- S10: the first charge is when the free trial ends (PayPal's start_time), never today while it's free
do $$ declare a uuid := current_setting('pay.a')::uuid; q json; te date := current_setting('pay.te')::date; o json; begin
  q := public.billing_quote(a, array['calls'], 4, 'monthly');
  assert (q ->> 'charge_from')::date = te and not (q ->> 'charged_today')::boolean, 'S10 on a free trial: first charge when it ends ' || (q ->> 'charge_from');
  -- S10: open bank transfer invoices before PayPal: one for the same program, one for another
  o := public.billing_start(a, array['calls'], 4, 'monthly', 'bank'); perform set_config('pay.s10same', o ->> 'ref', false);
  o := public.billing_start(a, array['bookings'], 3, 'monthly', 'bank'); perform set_config('pay.s10other', o ->> 'ref', false);
end $$;
do $$ declare a uuid := current_setting('pay.a')::uuid; o json; begin
  o := public.billing_start(a, array['calls'], 4, 'monthly', 'paypal');
  assert (o ->> 'starts_on')::date = current_setting('pay.te')::date, 'S10 the PayPal order starts when the trial ends: ' || (o ->> 'starts_on');
  assert (o ->> 'amount')::numeric = 27 and (o ->> 'first_amount')::numeric = 13.5 and (o ->> 'early_cycles')::int = 12, 'Riyeser Link, 4 people: 27, early bird 13.50';
  perform set_config('pay.o1', o ->> 'id', false);
  o := public.billing_start(a, array['calls'], 4, 'monthly', 'paypal');   -- started again: the first (never approved) is replaced
  perform set_config('pay.o2', o ->> 'id', false);
  assert (select count(*) from json_array_elements(public.my_billing(a) -> 'orders') x where x ->> 'method' = 'paypal') = 1, 'one PayPal start shows';
end $$;
reset role; set role service_role;
select public.billing_paypal_created(current_setting('pay.o2')::uuid, 'I-PAYCO0SUB123456', 'sandbox');
select public.billing_paypal_event('WH-1', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id": "I-PAYCO0SUB123456", "status": "ACTIVE", "billing_info": {"next_billing_time": "2027-01-24T10:00:00Z"}}', 'sandbox') = 'activated' as activated \gset
reset role;
select set_config('pay.act', :'activated', false);
do $$ begin assert current_setting('pay.act')::boolean, 'the service role applies a webhook'; end $$;
do $$ declare a uuid := current_setting('pay.a')::uuid; r text; te date := current_setting('pay.te')::date; g date; begin
  begin perform public.billing_paypal_created(current_setting('pay.o1')::uuid, 'I-OLDONE00000', 'sandbox'); raise exception 'replaced one taken';
  exception when others then assert sqlerrm like 'That payment isn''t waiting%', sqlerrm; end;
  assert public.billing_paypal_event('WH-1', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id": "I-PAYCO0SUB123456"}', 'sandbox') = 'duplicate', 'the same event twice: ignored';
  assert (public.module_state(a, 'calls') ->> 'status') = 'trial', 'activated alone switches nothing on: the payment does';
  -- S10: PayPal for Link Plus replaces the open bank invoice for Link Plus (and says so), not the one for Bookings
  assert (select status from public.billing_orders where ref = current_setting('pay.s10same')) = 'void', 'S10 the bank invoice for the same program is cancelled';
  assert exists (select 1 from public.email_outbox where workspace_id = a and template = 'billing_invoice_replaced' and status = 'queued'
     and subject like '%' || current_setting('pay.s10same') || '%'), 'S10 the owner is told that invoice is cancelled';
  assert (select status from public.billing_orders where ref = current_setting('pay.s10other')) = 'pending', 'S10 an invoice for other programs stays open';
  update public.billing_orders set status = 'void', cancelled_at = now() where ref = current_setting('pay.s10other');   -- tidy: later counts
  -- S10: a program whose trial is over is charged today (and the page says so); with one still on trial, still today
  if not exists (select 1 from public.company_modules where workspace_id = a and module = 'bookings') then
    perform public.licence_set_module(a, 'bookings', 'trial', current_date - 1, null);
    assert (public.billing_terms(a, array['bookings'], 3, 'monthly') ->> 'charged_today')::boolean, 'S10 trial over: charged today';
    assert (public.billing_terms(a, array['bookings', 'calls'], 3, 'monthly') ->> 'charge_from')::date = current_date, 'S10 one trial over: today';
    delete from public.company_modules where workspace_id = a and module = 'bookings';
  end if;
  r := public.billing_paypal_event('WH-2', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0001", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "13.50", "currency": "USD"}}', 'sandbox');
  assert r = 'paid', r;
  -- S10: every PayPal payment's receipt is emailed (queued in email_outbox until email sending is set up)
  assert exists (select 1 from public.email_outbox e join public.billing_payments p on e.body_text like '%Receipt: ' || p.ref || '%'
     where p.provider_ref = 'SALE-0001' and e.template = 'billing_paid' and e.status = 'queued'), 'S10 the PayPal receipt email is queued';
  assert (select paid_until from public.company_modules where workspace_id = a and module = 'calls') = (te + interval '1 month')::date, 'Link Plus paid from the end of its trial';
  assert public.billing_paypal_event('WH-2', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0001", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "13.50", "currency": "USD"}}', 'sandbox') = 'duplicate', 'duplicate webhook';
  assert public.billing_paypal_event('WH-2b', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0001", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "13.50", "currency": "USD"}}', 'sandbox') = 'duplicate payment', 'same sale, new event id: counted once';
  assert public.billing_paypal_event('WH-3', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0002", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "5.00", "currency": "USD"}}', 'sandbox') = 'amount mismatch', 'too little: recorded, not applied';
  assert public.billing_paypal_event('WH-3b', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0003", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "13.50", "currency": "AUD"}}', 'sandbox') = 'amount mismatch', 'wrong currency: not applied';
  assert (select paid_until from public.company_modules where workspace_id = a and module = 'calls') = (te + interval '1 month')::date, 'mismatches extended nothing';
  assert (select count(*) from public.billing_payments where workspace_id = a and method = 'paypal' and status = 'completed') = 1, 'one PayPal payment';
  -- a failed payment: a grace period to an exact date (7 days), then a retry that works
  r := public.billing_paypal_event('WH-4', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', '{"id": "I-PAYCO0SUB123456", "billing_info": {"last_failed_payment": {"amount": {"value": "13.50"}}}}', 'sandbox');
  assert r = 'payment failed', r;
  select grace_until into g from public.billing_orders where id = current_setting('pay.o2')::uuid;
  assert g = current_date + 7 and (select status from public.billing_orders where id = current_setting('pay.o2')::uuid) = 'payment_failed', 'grace until today + 7';
  assert exists (select 1 from public.email_outbox where workspace_id = a and template = 'billing_failed' and body_text like '%' || to_char(g, 'FMDD Month YYYY') || '%'), 'the email gives the date';
  assert public.billing_paypal_event('WH-5', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-0004", "billing_agreement_id": "I-PAYCO0SUB123456", "amount": {"total": "13.50", "currency": "USD"}}', 'sandbox') = 'paid', 'retry paid';
  assert (select status from public.billing_orders where id = current_setting('pay.o2')::uuid) = 'active'
     and (select grace_until from public.billing_orders where id = current_setting('pay.o2')::uuid) is null, 'back to active, no grace';
  assert (select paid_until from public.company_modules where workspace_id = a and module = 'calls') = (te + interval '2 months')::date, 'a second month';
  assert public.billing_paypal_event('WH-6', 'BILLING.SUBSCRIPTION.CREATED', '{"id": "I-PAYCO0SUB123456"}', 'sandbox') = 'ignored', 'other events ignored';
  assert public.billing_paypal_event('WH-7', 'PAYMENT.SALE.COMPLETED', '{"id": "SALE-9", "billing_agreement_id": "I-NOT0OURS", "amount": {"total": "99", "currency": "USD"}}', 'sandbox') = 'unknown subscription', 'not ours';
end $$;
reset role; set role authenticated;
-- a second PayPal subscription while one is running is refused; cancelling needs two-step sign-in
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pay.a')::uuid; b json; begin
  begin perform public.billing_start(a, array['pos'], 3, 'monthly', 'paypal'); raise exception 'two subscriptions';
  exception when others then assert sqlerrm like 'You already pay by PayPal%', sqlerrm; end;
  begin perform public.billing_cancel_start(a); raise exception 'cancelled without two-step';
  exception when others then assert sqlerrm like 'Turn on two-step sign-in%', sqlerrm; end;
  b := public.my_billing(a);
  assert b -> 'subscription' ->> 'status' = 'active' and (b -> 'subscription' ->> 'next_amount')::numeric = 13.5, 'next charge: early bird 13.50';
  assert b ->> 'paypal_manage_url' like 'https://www.sandbox.paypal.com/%', 'manage link for sandbox';
  assert (select count(*) from json_array_elements(b -> 'payments') x where x ->> 'status' = 'failed') >= 1, 'failed payment in the history';
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare c json := public.billing_cancel_start(current_setting('pay.a')::uuid); begin
  assert c ->> 'subscription_id' = 'I-PAYCO0SUB123456' and c ->> 'env' = 'sandbox', 'what the function tells PayPal';
end $$;
-- HQ: PayPal ids masked except the last 6; the PayPal status card
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ declare c json := public.hq_company_billing(current_setting('pay.a')::uuid); h json := public.hq_billing(); t text; begin
  t := c::text;
  assert t not like '%I-PAYCO0SUB123456%' and t not like '%SALE-0001%', 'no full PayPal ids in HQ';
  assert (select x ->> 'paypal_id' from json_array_elements(c -> 'orders') x where x ->> 'method' = 'paypal') = '…123456', 'subscription id masked';
  assert exists (select 1 from json_array_elements(c -> 'payments') x where x ->> 'provider_ref' = '…E-0001'), 'sale id masked';
  assert h -> 'paypal' ->> 'env' = 'sandbox' and h -> 'paypal' ->> 'last_webhook_at' is not null, 'PayPal status: sandbox, last webhook';
  assert (public.hq_company_page(current_setting('pay.a')::uuid) -> 'extra' -> 'billing') is not null, 'on the customer page';
end $$;
-- PayPal says it's cancelled: everything works until the end of what's paid, then stops
reset role;
do $$ declare a uuid := current_setting('pay.a')::uuid; pu date; begin
  select paid_until into pu from public.company_modules where workspace_id = a and module = 'calls';
  assert public.billing_paypal_event('WH-8', 'BILLING.SUBSCRIPTION.CANCELLED', '{"id": "I-PAYCO0SUB123456"}', 'sandbox') = 'cancelled', 'cancelled';
  perform public.billing_paypal_cancelled(current_setting('pay.o2')::uuid);   -- the function's own call after cancelling: no harm twice
  assert (public.module_state(a, 'calls') ->> 'status') = 'cancelled' and (public.module_state(a, 'calls') ->> 'active')::boolean
     and (public.module_state(a, 'calls') ->> 'paid_until')::date = pu, 'cancelled: works until the paid date';
  assert public.billing_paypal_event('WH-9', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', '{"id": "I-PAYCO0SUB123456"}', 'sandbox') = 'payment failed', 'a late failure';
  assert (select status from public.billing_orders where id = current_setting('pay.o2')::uuid) = 'cancelled', 'stays cancelled';
  assert (select count(*) from public.billing_events) = 11, 'every event kept, once each';
end $$;
reset role;
-- the Billing entity can't be changed or removed in place (new versions only)
do $$ begin
  begin update public.billing_entities set details = '{}'; raise exception 'edited an entity';
  exception when others then assert sqlerrm like 'Rows in billing_entities%', sqlerrm; end;
end $$;

-- ---- the customer's copy of every invoice and receipt: kept as issued; the owner and HQ only; send it again
reset role;
do $$ declare a uuid := current_setting('pay.a')::uuid; d jsonb; n int; begin
  select doc into d from public.billing_documents where ref = current_setting('pay.inv1');
  assert d ->> 'kind' = 'invoice' and d -> 'buyer' ->> 'name' = 'Pay Co' and d -> 'buyer' -> 'contact' ->> 'name' = 'Lisi'
     and d -> 'buyer' -> 'contact' ->> 'email' = 'lisi@pay.test', 'invoice copy: the business and its contact';
  assert (d ->> 'total')::numeric = 46 and jsonb_array_length(d -> 'lines') = 3 and d -> 'seller' ->> 'name' = 'Riyeser'
     and d ->> 'what' = 'Accounting Plus, Payroll · 5 people · monthly', 'invoice copy: lines (2 programs + early bird), total, seller';
  assert (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(d -> 'lines') x) = 46, 'the lines add up';
  select doc into d from public.billing_documents where kind = 'receipt' and workspace_id = a and doc ->> 'method' = 'bank';
  assert (d ->> 'total')::numeric = 46 and d ->> 'order_ref' = current_setting('pay.inv1') and d ->> 'period_to' is not null
     and d -> 'lines' -> 0 ->> 'text' like '%(early bird)', 'bank receipt copy: amount, invoice, period';
  assert exists (select 1 from public.email_outbox where workspace_id = a and template = 'billing_paid' and to_address = 'lisi@pay.test'
     and body_text like '%Receipt: ' || (d ->> 'ref') || '%' and body_text like '%US$46.00%' and body_text like '%Accounting Plus, Payroll%'
     and body_text like '%riyeser.com/link/?receipt=' || (d ->> 'ref') || '%'), 'receipt email: number, amount, what, link';
  select count(*) into n from public.billing_documents where workspace_id = a and kind = 'receipt' and doc ->> 'method' = 'paypal';
  assert n = 2, 'a copy for each PayPal payment (not for failed or mismatched ones): ' || n;
  assert (select count(*) from public.email_outbox where workspace_id = a and template = 'billing_paid') = 3, 'every payment is emailed';
  assert exists (select 1 from public.billing_documents where workspace_id = a and doc ->> 'method_ref' = '…E-0001'), 'PayPal id masked on the receipt';
  -- details change later: the copies don't
  update public.workspaces set name = 'Pay Co Renamed', email = 'accounts@payco.test' where id = a;
  assert (select doc -> 'buyer' ->> 'name' from public.billing_documents where ref = current_setting('pay.inv1')) = 'Pay Co', 'the copy keeps the old name';
  begin update public.billing_documents set doc = '{}' where workspace_id = a; raise exception 'edited a receipt';
  exception when others then assert sqlerrm like 'Invoices and receipts are kept exactly as issued%', sqlerrm; end;
  begin delete from public.billing_documents where workspace_id = a; raise exception 'deleted a receipt';
  exception when others then assert sqlerrm like 'Invoices and receipts are kept exactly as issued%', sqlerrm; end;
  assert public.billing_contacts(a) @> array['lisi@pay.test', 'accounts@payco.test'] and cardinality(public.billing_contacts(a)) = 2, 'billing emails: owner + business email';
end $$;
set role authenticated;
select pg_temp.as_user_password_only('b1b1b1b1-0000-4000-8000-000000000001');
do $$ declare b json := public.my_billing(current_setting('pay.a')::uuid); begin
  assert (select x -> 'doc' ->> 'ref' from json_array_elements(b -> 'orders') x where x ->> 'ref' = current_setting('pay.inv1')) = current_setting('pay.inv1'), 'the owner has the invoice copy';
  assert (select count(*) from json_array_elements(b -> 'payments') x where x -> 'doc' ->> 'kind' = 'receipt') = 3, 'and each receipt copy';
  begin perform count(*) from public.billing_documents; raise exception 'read documents';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), null, false); raise exception 'customer resent';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
  begin perform public.hq_payments_received(7); raise exception 'customer saw payments';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
-- SEC-010: HQ sales (licences.view) can look at it but not email it anywhere; Finance (licences.manage) sends it again
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ begin
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), null, false); raise exception 'sales resent an invoice';
  exception when others then assert sqlerrm like 'Your HQ role can''t%', sqlerrm; end;
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), 'x@elsewhere.test', false); raise exception 'sales sent an invoice to another address';
  exception when others then assert sqlerrm like 'Your HQ role can''t%', sqlerrm; end;
  assert not (public.hq_billing() ->> 'can_send_docs')::boolean, 'sales: no send buttons';
  assert json_array_length(public.hq_company_billing(current_setting('pay.a')::uuid) -> 'orders') >= 1, 'sales can still look';
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
do $$ declare a uuid := current_setting('pay.a')::uuid; r json; p json; begin
  assert (public.hq_billing() ->> 'can_send_docs')::boolean, 'finance: send buttons';
  r := public.hq_billing_resend(current_setting('pay.inv1'), null, false);
  assert json_array_length(r -> 'to') = 2, 'resent to the owner and the business email';
  r := public.hq_billing_resend(lower(current_setting('pay.inv1')), ' Right@PayCo.test ', false);
  assert r -> 'to' ->> 0 = 'right@payco.test' and not (r ->> 'contact_updated')::boolean, 'resent to another address';
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), 'not-an-email', false); raise exception 'bad email';
  exception when others then assert sqlerrm like 'Check the email address%', sqlerrm; end;
  begin perform public.hq_billing_resend('RR-0', null, false); raise exception 'no such doc';
  exception when others then assert sqlerrm like 'There''s no invoice or receipt%', sqlerrm; end;
  p := public.hq_payments_received(7);
  assert (p ->> 'count')::int = 3 and (p ->> 'total')::numeric = 73 and (p ->> 'days')::int = 7, format('payments received in 7 days: 3, US$73 (13.50 + 13.50 + 46): %s', p);
  assert (select count(*) from json_array_elements(public.hq_company_billing(a) -> 'payments') x where x -> 'doc' ->> 'kind' = 'receipt') = 3, 'HQ sees the copies';
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
do $$ declare a uuid := current_setting('pay.a')::uuid; begin
  perform public.hq_billing_resend(current_setting('pay.inv1'), 'fixed@payco.test', true);
end $$;
reset role;
do $$ declare a uuid := current_setting('pay.a')::uuid; begin
  assert (select email from public.workspaces where id = a) = 'fixed@payco.test', 'finance (licences.manage) fixed the business email';
  assert (select count(*) from public.email_outbox where workspace_id = a and template = 'billing_resend') = 4, 'each resend queued';
  assert exists (select 1 from public.email_outbox where workspace_id = a and template = 'billing_resend' and to_address = 'right@payco.test'
     and subject = 'Your Riyeser invoice ' || current_setting('pay.inv1') and body_text like '%?invoice=' || current_setting('pay.inv1') || '%'), 'the invoice email';
  assert exists (select 1 from public.hq_audit where action = 'billing.doc_resent' and workspace_id = a and actor = 'b1b1b1b1-0000-4000-8000-000000000005'
     and details -> 'to' ->> 0 = 'ri…@payco.test' and (details ->> 'other_address')::boolean), 'in the HQ history: who, where (shortened)';
  assert exists (select 1 from public.hq_audit where action = 'billing.doc_resent' and (details ->> 'contact_updated')::boolean
     and actor = 'b1b1b1b1-0000-4000-8000-000000000005'), 'the email change is in the history too';
end $$;
-- HQ Licences: real recurring money, installs per program, and the businesses on a program
set role authenticated;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ declare l json := public.hq_licences(); b json; begin
  assert (l ->> 'monthly_recurring')::numeric >= 46 and (l ->> 'recurring_count')::int >= 1, 'monthly recurring: the paid bank invoice still running (' || (l ->> 'monthly_recurring') || ')';
  assert (select count(*) from json_array_elements(l -> 'modules') x where x ->> 'installed' is not null) = 8, 'installs counted for each program (with Riyeser Estimate)';
  b := public.hq_licence_businesses('plus', 'paid');
  assert exists (select 1 from json_array_elements(b) x where x ->> 'id' = current_setting('pay.a') and x ->> 'status' = 'active' and x ->> 'until' is not null), 'Pay Co is on Accounting Plus, paid';
  assert not exists (select 1 from json_array_elements(public.hq_licence_businesses('plus', 'trial')) x where x ->> 'id' = current_setting('pay.a')), 'and not on its trial';
  begin perform public.hq_licence_businesses('plus', 'weird'); raise exception 'bad status';
  exception when others then assert sqlerrm like 'Choose paid, trial or ended%', sqlerrm; end;
  begin perform public.hq_licence_businesses('nope', 'paid'); raise exception 'bad program';
  exception when others then assert sqlerrm like 'Choose a program%', sqlerrm; end;
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.hq_licence_businesses('plus', 'paid'); raise exception 'customer listed businesses';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
reset role;
select 'payments ok' as billing;

-- ===== Website traffic: anyone can add a page view only through track_visit; only HQ with reports.view reads it
reset role; set role anon; select pg_temp.as_user('');
select public.track_visit('tab0000000000001', '/index.html', 'www.Google.com', 'Facebook', 'Social', 'Spring sale', 'phone', 'Chrome', 'en-AU', 'Fiji');
select public.track_visit('tab0000000000001', '/pricing.html?x=1#top', 'riyeser.com', null, null, null, 'phone', 'Chrome', 'en-AU', 'Fiji');
select public.track_visit('tab0000000000002', '/programs/payroll.html', '', null, null, null, 'desktop', 'Firefox', 'en', 'Australia');
select public.track_visit('TAB0000000000003', '/pricing', 'news.example.org', repeat('x', 500), null, null, 'fridge', 'Netscape<script>', 'not a language', '<b>');
-- ignored: not a website page, no session, a bad session id
select public.track_visit('tab0000000000004', '/hq/', null);
select public.track_visit('tab0000000000004', '/link/?signup', null);
select public.track_visit('tab0000000000004', '/wp-admin/install.php', null);
select public.track_visit('tab0000000000004', 'https://evil.test/', null);
select public.track_visit(null, '/', null);
select public.track_visit('a b', '/', null);
do $$ begin
  begin perform count(*) from public.site_visits; raise exception 'anon read site_visits';
  exception when insufficient_privilege then null; end;
  begin insert into public.site_visits (session_id, path) values ('tab0000000000009', '/'); raise exception 'anon inserted directly';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_traffic(current_date - 7, current_date); raise exception 'anon read traffic';
  exception when insufficient_privilege then null; when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
  begin perform public.hq_traffic_sweep(); raise exception 'anon ran the sweep';
  exception when insufficient_privilege then null; end;
end $$;
-- the per-session limit: 200 page views a day
do $$ begin for i in 1..230 loop perform public.track_visit('flood00000000001', '/', null); end loop; end $$;
reset role;
do $$ begin
  assert (select count(*) from public.site_visits where session_id = 'flood00000000001') = 200, 'rate limit per session';
  assert (select count(*) from public.site_visits where session_id <> 'flood00000000001') = 4, format('only the 4 real page views: %s', (select json_agg(path) from public.site_visits));
  assert (select string_agg(path, ' ' order by id) from public.site_visits where session_id <> 'flood00000000001') = '/ /pricing /programs/payroll /pricing', 'paths tidied';
  assert (select referrer_host from public.site_visits where session_id = 'tab0000000000001' order by id limit 1) = 'google.com', 'referrer: host only, no www';
  assert (select referrer_host from public.site_visits where session_id = 'tab0000000000001' order by id desc limit 1) is null, 'our own site is not a referrer';
  assert (select utm_source || '/' || utm_medium || '/' || utm_campaign from public.site_visits where session_id = 'tab0000000000001' order by id limit 1) = 'facebook/social/Spring sale', 'utm';
  assert (select row(length(utm_source), device, browser, lang, region, session_id)::text from public.site_visits where session_id = 'tab0000000000003')
    = '(60,,,,,tab0000000000003)', 'bad values dropped or cut short';
  assert not exists (select 1 from information_schema.columns where table_name = 'site_visits' and column_name ~ 'ip|agent|user'), 'no IP or user agent column';
end $$;
-- signed-in customers can't read it either; HQ without reports.view can't; with it, it can
insert into public.site_visits (at, session_id, path) values (now() - interval '14 months', 'old0000000000001', '/'), (now() - interval '20 days', 'prev000000000001', '/');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin
  begin perform count(*) from public.site_visits; raise exception 'customer read site_visits';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_traffic(current_date - 7, current_date); raise exception 'customer read traffic';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ begin begin perform public.hq_traffic(current_date - 7, current_date); raise exception 'support read traffic';
  exception when others then assert sqlerrm like 'Your HQ role%', sqlerrm; end; end $$;
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd');
do $$ declare r json; y json; begin
  r := public.hq_traffic(current_date - 6, current_date);
  assert (r ->> 'visits')::int = 4 and (r ->> 'views')::int = 204, format('totals: %s %s', r ->> 'visits', r ->> 'views');
  assert (r -> 'prev' ->> 'visits')::int = 0 and json_array_length(r -> 'series') = 7 and r ->> 'bucket' = 'day', 'previous period and days';
  assert exists (select 1 from json_array_elements(r -> 'pages') x where x ->> 'path' = '/pricing' and (x ->> 'views')::int = 2), 'top pages';
  assert exists (select 1 from json_array_elements(r -> 'referrers') x where x ->> 'host' = 'google.com' and (x ->> 'visits')::int = 1), 'referrers';
  assert exists (select 1 from json_array_elements(r -> 'campaigns') x where x ->> 'campaign' = 'Spring sale'), 'campaigns';
  assert exists (select 1 from json_array_elements(r -> 'regions') x where x ->> 'k' = 'Fiji'), 'regions';
  assert (r -> 'funnel' ->> 'pricing')::int = 2 and (r -> 'funnel' ->> 'signups') is not null and (r -> 'funnel' ->> 'paid') is not null, format('funnel: %s', r -> 'funnel');
  y := public.hq_traffic(current_date - 364, current_date);
  assert y ->> 'bucket' = 'week' and (y ->> 'visits')::int = 5 and json_array_length(y -> 'series') between 52 and 54, 'a year, by week';
  begin perform public.hq_traffic(current_date, current_date - 5); raise exception 'backwards range';
  exception when others then assert sqlerrm like 'Choose a start date%', sqlerrm; end;
  begin perform count(*) from public.site_visits; raise exception 'HQ read the raw table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (public.hq_traffic_sweep() ->> 'deleted')::int = 1, 'the daily sweep removes views over 13 months old';
  assert not exists (select 1 from public.site_visits where session_id = 'old0000000000001') and exists (select 1 from public.site_visits where session_id = 'prev000000000001'), 'and keeps the rest';
end $$;
-- the daily totals keep the history after the raw page views are gone (and hold no session ids)
select pg_temp.as_user('dddddddd-dddd-dddd-dddd-dddddddddddd'); set role authenticated;
do $$ begin
  assert (public.hq_traffic(current_date - 600, current_date) ->> 'visits')::int = 6, 'the 14-month-old visit is still in the daily totals';
  begin perform count(*) from public.site_traffic_daily; raise exception 'HQ read the daily table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert not exists (select 1 from information_schema.columns where table_name = 'site_traffic_daily' and column_name like '%session%'), 'no session ids in the totals'; end $$;
select 'website traffic ok' as traffic;

-- A's owner still has exactly the messages A wrote (B's attempt didn't land)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert not exists (select 1 from public.messages where body = 'hack'), 'no hack message'; end $$;
reset role;
reset role;
-- S3: help without signing in: a ticket and an automatic email with its number; replies go by email; limits
reset role; set role anon; select pg_temp.as_user('');
select (public.guest_ticket('Mere Guest', ' Mere@Guest.test ', 'signin', 'Can''t sign in', 'I forgot which email I used.') ->> 'ref') as g_ref \gset
select set_config('test.g_ref', :'g_ref', false);
do $$ begin
  assert current_setting('test.g_ref') like 'T-%', 'S3 a ticket number';
  begin perform public.guest_ticket('X', 'not-an-email', 'other', 'Hi', 'Hi'); raise exception 'bad email';
  exception when others then assert sqlerrm like 'Type your email%', sqlerrm; end;
  begin perform public.guest_ticket('', 'a@b.test', 'other', 'Hi', 'Hi'); raise exception 'no name';
  exception when others then assert sqlerrm like 'Type your name%', sqlerrm; end;
  perform public.guest_ticket('Mere Guest', 'mere@guest.test', 'other', 'Two', 'Second');
  perform public.guest_ticket('Mere Guest', 'mere@guest.test', 'other', 'Three', 'Third');
  begin perform public.guest_ticket('Mere Guest', 'mere@guest.test', 'other', 'Four', 'Fourth'); raise exception 'no limit';
  exception when others then assert sqlerrm like 'You''ve sent a few%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.email_outbox where template = 'ticket_received' and to_address = 'mere@guest.test' and status = 'queued'
    and subject like '%' || current_setting('test.g_ref') || '%' and body_text like '%request number is ' || current_setting('test.g_ref') || '%'), 'S3 the auto-reply has the ticket number';
end $$;
select set_config('test.g_id', (select id::text from public.support_tickets where ref = current_setting('test.g_ref')), false);
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); set role authenticated;
do $$ declare id uuid := current_setting('test.g_id')::uuid; t json; begin
  t := public.hq_ticket(id);
  assert t -> 'ticket' ->> 'opened_by_email' = 'mere@guest.test' and (t -> 'ticket' ->> 'guest')::boolean and t -> 'ticket' ->> 'opened_by_name' = 'Mere Guest', 'S3 HQ sees who to reply to';
  assert t -> 'messages' -> 0 ->> 'from' = 'Mere Guest <mere@guest.test> (not signed in)', 'S3 HQ sees it is from a guest';
  perform public.hq_ticket_reply(id, 'Hi Mere, it''s the one you got our receipts on.', false, null);
end $$;
reset role;
do $$ begin
  assert exists (select 1 from public.email_outbox where template = 'ticket_reply' and to_address = 'mere@guest.test' and body_text like '%receipts on%'), 'S3 the reply is emailed';
end $$;
reset role;
-- Pricing v2: Riyeser Link is a paid program (module 'calls'). Off: chat is read-only (reading works, sending, editing
-- and reactions don't); nothing is deleted.
select set_config('v2.ws', :'ws_a', false), set_config('v2.gen', :'gen_a', false);
insert into public.company_modules (workspace_id, module, status) values (:'ws_a', 'calls', 'cancelled')
  on conflict (workspace_id, module) do update set status = 'cancelled', paid_until = null, trial_ends = null;
update public.workspaces set calls_paid_until = null where id = :'ws_a';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ declare ws uuid := current_setting('v2.ws')::uuid; ch uuid := current_setting('v2.gen')::uuid; f json; begin
  f := public.team_features(ws);
  assert not (f ->> 'link')::boolean and f ->> 'link_status' = 'cancelled', format('Link off: %s', f);
  assert (select count(*) from public.messages where channel_id = ch) > 0, 'old messages still readable';
  begin insert into public.messages (channel_id, workspace_id, body) values (ch, ws, 'still on?'); raise exception 'sent with Link off';
  exception when insufficient_privilege then null; end;
  begin update public.messages set body = 'changed' where channel_id = ch and user_id = auth.uid(); raise exception 'edited with Link off';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.company_modules set status = 'trial', trial_ends = current_date + 30 where workspace_id = :'ws_a' and module = 'calls';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ declare ws uuid := current_setting('v2.ws')::uuid; ch uuid := current_setting('v2.gen')::uuid; begin
  assert (public.team_features(ws) ->> 'link')::boolean, 'Link on (trial)';
  insert into public.messages (channel_id, workspace_id, body) values (ch, ws, 'Back on Riyeser Link');
end $$;
reset role;
-- the accountant or bookkeeper is free: one of them doesn't count as a Link user
do $$ declare ws uuid := current_setting('v2.ws')::uuid; n int := (select count(*) from public.members where workspace_id = current_setting('v2.ws')::uuid); begin
  assert public.link_people(ws) = n, 'everyone counts';
  update public.members set job_role = 'bookkeeper' where workspace_id = ws and role <> 'owner'
    and user_id = (select user_id from public.members where workspace_id = ws and role <> 'owner' order by joined_at limit 1);
  assert public.link_people(ws) = n - 1, 'the bookkeeper is free';
  assert public.module_label('calls') = 'Riyeser Link', 'calls is shown as Riyeser Link';
  update public.members set job_role = 'staff' where workspace_id = ws and job_role = 'bookkeeper';
end $$;
-- Existing businesses that used Link chat for free get 90 days from when the new file is first run, once.
do $$ declare old uuid; paid uuid; long uuid; begin
  insert into public.workspaces (name, company_code, created_at) values ('V2 old', public.make_company_code(), now() - interval '400 days') returning id into old;
  insert into public.workspaces (name, company_code, created_at) values ('V2 paid', public.make_company_code(), now() - interval '400 days') returning id into paid;
  insert into public.workspaces (name, company_code, created_at) values ('V2 long', public.make_company_code(), now() - interval '400 days') returning id into long;
  insert into public.company_modules (workspace_id, module, status, paid_until) values (paid, 'calls', 'active', current_date + 100);
  insert into public.company_modules (workspace_id, module, status, trial_ends) values (long, 'calls', 'trial', current_date + 120);
  assert not public.calls_allowed(old), 'an old business: Link off before the change';
  delete from public.riyeser_once where key = 'pricing_v2_link_trial';
  perform public.pricing_v2_link_trial();
  assert (public.module_state(old, 'calls') ->> 'trial_ends')::date = current_date + 90 and public.calls_allowed(old), '90 days from now';
  assert (select status = 'active' and paid_until = current_date + 100 from public.company_modules where workspace_id = paid and module = 'calls'), 'paid: unchanged';
  assert (public.module_state(long, 'calls') ->> 'trial_ends')::date = current_date + 120, 'a longer trial is kept';
  update public.company_modules set trial_ends = current_date + 5 where workspace_id = old and module = 'calls';
  perform public.pricing_v2_link_trial();   -- re-running the file: nothing is reset
  assert (public.module_state(old, 'calls') ->> 'trial_ends')::date = current_date + 5, 'only once';
end $$;
-- ===== Riyeser Link: your status (At lunch until 1pm, Busy / Do not disturb doesn't ring, On a call from a desk phone)
-- and admins: only the owner can make or take away an admin. Uses Sample Link Co (Pip owner, Quinn and Rua members).
reset role; set role authenticated;
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
do $$ declare a uuid := current_setting('lk.a')::uuid; begin
  perform public.link_status_set(a, 'lunch', 'lunch', 'Back at 1', false, now() + interval '1 hour');
  assert (select status || '/' || manual || '/' || (until_at > now()) from public.link_presence(a) where user_id = auth.uid()) = 'lunch/lunch/true', 'At lunch until a time';
  begin perform public.link_status_set(a, 'offline', 'offline', null, false, null); raise exception 'chose Offline';
  exception when others then assert sqlerrm like 'Choose Available%set by themselves%', sqlerrm; end;
  begin perform public.link_status_set(a, 'lunch', 'lunch', null, false, now() + interval '9 days'); raise exception 'until in 9 days';
  exception when others then assert sqlerrm like 'Choose an "until" time%', sqlerrm; end;
  begin perform public.link_status_set(a, 'sleeping', null, null, false, null); raise exception 'bad status';
  exception when others then assert sqlerrm like 'Choose Available%', sqlerrm; end;
end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ declare a uuid := current_setting('lk.a')::uuid; q uuid := 'a7a7a7a2-0000-4000-8000-000000000002'; begin
  assert (select status from public.link_presence(a) where user_id = q) = 'lunch', 'Rua sees Quinn is at lunch';
  assert (select manual from public.link_presence(a) where user_id = q) is null, 'but not what Quinn chose';
  assert not public.link_rings(a, q), 'At lunch doesn''t ring';
  begin insert into public.call_signals (workspace_id, call_id, to_user, kind) values (a, gen_random_uuid(), q, 'ring'); raise exception 'rang someone at lunch';
  exception when insufficient_privilege then null; end;
end $$;
-- Busy / Do not disturb and Unavailable don't ring either; Away and Available do
select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
do $$ declare a uuid := current_setting('lk.a')::uuid; q uuid := 'a7a7a7a2-0000-4000-8000-000000000002'; st text; begin
  foreach st in array array['dnd', 'unavailable', 'away', 'available'] loop
    perform public.link_status_set(a, st, st, null, false, null);
    assert public.link_rings(a, q) = (st in ('away', 'available')), 'rings when ' || st;
  end loop;
  assert (select manual from public.presence where user_id = q) is null, 'Available is stored as no choice';
  perform public.link_status_set(a, 'dnd', 'dnd', null, false, null);
end $$;
select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ declare a uuid := current_setting('lk.a')::uuid; q uuid := 'a7a7a7a2-0000-4000-8000-000000000002'; begin
  begin insert into public.call_signals (workspace_id, call_id, to_user, kind) values (a, gen_random_uuid(), q, 'ring'); raise exception 'rang someone on Do not disturb';
  exception when insufficient_privilege then null; end;
  insert into public.call_signals (workspace_id, call_id, to_user, kind) values (a, gen_random_uuid(), q, 'cancel');   -- other signals still go
end $$;
-- the "until" time passes: Available again, and calls ring
reset role;
update public.presence set manual = 'lunch', status = 'lunch', until_at = now() - interval '1 minute' where user_id = 'a7a7a7a2-0000-4000-8000-000000000002';
set role authenticated; select pg_temp.as_user('a7a7a7a3-0000-4000-8000-000000000003');
do $$ declare a uuid := current_setting('lk.a')::uuid; q uuid := 'a7a7a7a2-0000-4000-8000-000000000002'; begin
  assert (select status from public.link_presence(a) where user_id = q) = 'available', 'until passed: Available';
  assert public.link_rings(a, q), 'until passed: rings';
  insert into public.call_signals (workspace_id, call_id, to_user, kind) values (a, gen_random_uuid(), q, 'ring');
end $$;
-- On a call on a desk phone: Riyeser Link Office says the extension is in a call (yes or no only)
reset role;
update public.members set extension = 301 where user_id = 'a7a7a7a3-0000-4000-8000-000000000003' and workspace_id = current_setting('lk.a')::uuid;
set role authenticated; select pg_temp.as_user('a7a7a7a1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('lk.a')::uuid; r uuid := 'a7a7a7a3-0000-4000-8000-000000000003'; begin
  perform public.link_office_report(a, 'office-lk01-abcd', '{"state":"running","extensions":[{"extension":"301","name":"Rua","in_call":true,"number":"0400111222"},{"extension":"302","name":"Nobody"}]}');
  assert (select e ->> 'in_call' from public.link_offices o, jsonb_array_elements(o.extensions) e where o.workspace_id = a and e ->> 'extension' = '301') = 'true', 'in_call kept';
  assert not exists (select 1 from public.link_offices o, jsonb_array_elements(o.extensions) e where o.workspace_id = a and e ? 'number'), 'nothing else about the call is kept';
  assert (select desk_call from public.link_presence(a) where user_id = r), 'Rua is On a call on the desk phone';
  assert not (select desk_call from public.link_presence(a) where user_id = 'a7a7a7a2-0000-4000-8000-000000000002'), 'Quinn isn''t';
  perform public.link_office_report(a, 'office-lk01-abcd', '{"state":"running","extensions":[{"extension":"301","name":"Rua","in_call":false}]}');
  assert not (select desk_call from public.link_presence(a) where user_id = r), 'call over';
end $$;
reset role;
update public.link_offices set extensions = '[{"extension":"301","in_call":true}]', last_seen = now() - interval '20 minutes' where office_id = 'office-lk01-abcd';
set role authenticated; select pg_temp.as_user('a7a7a7a1-0000-4000-8000-000000000001');
do $$ begin assert not public.link_desk_call(current_setting('lk.a')::uuid, 'a7a7a7a3-0000-4000-8000-000000000003'), 'an office not heard from for 20 minutes doesn''t count'; end $$;
select pg_temp.as_user('a7a7a7a4-0000-4000-8000-000000000004');
do $$ begin assert (select count(*) from public.link_presence(current_setting('lk.a')::uuid)) = 0, 'another business sees no status'; end $$;
-- Admins: only the owner makes or takes away an admin; an admin can't, and can't remove another admin
select pg_temp.as_user('a7a7a7a1-0000-4000-8000-000000000001');
select public.set_access(current_setting('lk.a')::uuid, 'a7a7a7a2-0000-4000-8000-000000000002', 'manager', true, '{}');
select public.set_access(current_setting('lk.a')::uuid, 'a7a7a7a3-0000-4000-8000-000000000003', 'staff', true, '{}');
reset role;
insert into auth.users (id, email) values ('a7a7a7a5-0000-4000-8000-000000000005', 'tui@lk.test');
insert into public.join_requests (workspace_id, user_id, display_name) values (current_setting('lk.a')::uuid, 'a7a7a7a5-0000-4000-8000-000000000005', 'Tui');
set role authenticated; select pg_temp.as_user('a7a7a7a2-0000-4000-8000-000000000002');
do $$ declare a uuid := current_setting('lk.a')::uuid; rq uuid; begin
  begin perform public.set_access(a, 'a7a7a7a3-0000-4000-8000-000000000003', 'staff', false, '{}'); raise exception 'admin took admin away';
  exception when others then assert sqlerrm like 'Only the owner can make someone an admin%', sqlerrm; end;
  perform public.set_access(a, 'a7a7a7a3-0000-4000-8000-000000000003', 'sales', true, '{}');   -- the job role, yes
  assert (select job_role || '/' || role from public.members where workspace_id = a and user_id = 'a7a7a7a3-0000-4000-8000-000000000003') = 'sales/admin', 'job changed, still admin';
  delete from public.members where workspace_id = a and user_id = 'a7a7a7a3-0000-4000-8000-000000000003';
  assert exists (select 1 from public.members where workspace_id = a and user_id = 'a7a7a7a3-0000-4000-8000-000000000003'), 'an admin can''t remove another admin';
  select id into rq from public.join_requests where workspace_id = a and status = 'pending';
  begin perform public.decide_join(rq, true, 'staff', true, '{}'); raise exception 'admin made a new admin';
  exception when others then assert sqlerrm like 'Only the owner can make someone an admin%', sqlerrm; end;
  perform public.decide_join(rq, true, 'staff', false, '{}');
  assert (select role from public.members where workspace_id = a and user_id = 'a7a7a7a5-0000-4000-8000-000000000005') = 'member', 'approved as staff';
  delete from public.members where workspace_id = a and user_id = 'a7a7a7a5-0000-4000-8000-000000000005';
  assert not exists (select 1 from public.members where workspace_id = a and user_id = 'a7a7a7a5-0000-4000-8000-000000000005'), 'an admin can remove a member';
end $$;
select pg_temp.as_user('a7a7a7a1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('lk.a')::uuid; begin
  perform public.set_access(a, 'a7a7a7a3-0000-4000-8000-000000000003', 'staff', false, '{}');
  assert (select role from public.members where workspace_id = a and user_id = 'a7a7a7a3-0000-4000-8000-000000000003') = 'member', 'the owner takes admin away';
end $$;
-- ===== Riyeser online connections (the public API): keys, post box, published data, webhooks, log, limits =====
reset role;
-- (on Supabase the service role can read every table; the stand-in gives it the same for these checks)
grant select on public.api_keys, public.api_inbox, public.api_webhook_deliveries, public.api_webhooks to service_role;
grant update on public.api_webhook_deliveries to service_role;
insert into auth.users (id, email) values ('a9a9a9a1-0000-4000-8000-000000000001', 'owner@api.test'), ('a9a9a9a2-0000-4000-8000-000000000002', 'staff@api.test'),
  ('a9a9a9a3-0000-4000-8000-000000000003', 'other@api.test'), ('a9a9a9a4-0000-4000-8000-000000000004', 'admin@api.test');
set role authenticated;
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
select set_config('api.ws', public.create_team('Online Salon', 'Ola')::text, false);
select set_config('api.code', (select invite_code from public.workspaces where id = current_setting('api.ws')::uuid), false);
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
select public.join_team(current_setting('api.code'), 'Sid');
select public.link_device(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', 'FRONT-DESK', 'windows', '1.0');
select pg_temp.as_user('a9a9a9a4-0000-4000-8000-000000000004');
select public.join_team(current_setting('api.code'), 'Ade');
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
select public.link_device(current_setting('api.ws')::uuid, 'a9a9a9d2-0000-4000-8000-000000000002', 'BACK-OFFICE', 'windows', '1.0');
select public.set_access(current_setting('api.ws')::uuid, 'a9a9a9a4-0000-4000-8000-000000000004', 'manager', true, '{}');
select pg_temp.as_user('a9a9a9a3-0000-4000-8000-000000000003');
select set_config('api.ws_x', public.create_team('Other Shop', 'Oz')::text, false);

-- Keys: only owners and admins with two-step sign-in; the key is returned once and only its SHA-256 is kept
select pg_temp.as_user_password_only('a9a9a9a1-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.api_key_create(current_setting('api.ws')::uuid, 'Shop', 'secret', 'live', array['orders:write'], '{}', '{}'); raise exception 'aal1 made a key';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin, signed in with two-step%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.api_key_create(current_setting('api.ws')::uuid, 'Shop', 'secret', 'live', array['orders:write'], '{}', '{}'); raise exception 'staff made a key';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.api_keys_list(current_setting('api.ws')::uuid); raise exception 'staff listed keys';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.api_requests_list(current_setting('api.ws')::uuid, null, 10, null); raise exception 'staff read the request log';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
select set_config('api.k1', (public.api_key_create(current_setting('api.ws')::uuid, ' Website shop ', 'secret', 'live',
  array['orders:write', 'bookings:write', 'enquiries:write', 'customers:write', 'quotes:write', 'payments:write', 'stock:read', 'prices:read',
        'catalog:read', 'availability:read'], '{}', '{}'))::text, false);
do $$ declare j jsonb := current_setting('api.k1')::jsonb; raw text := j ->> 'key'; begin
  assert raw ~ '^rk_live_[0-9a-f]{48}$', 'live secret key format: ' || raw;
  assert j ->> 'prefix' = left(raw, 16) || '…', 'prefix shown: ' || (j ->> 'prefix');
  assert j ->> 'name' = 'Website shop', 'name trimmed';
end $$;
-- the key itself is nowhere in the database: only its hash (and the hash isn't in the change history either)
reset role;
do $$ declare j jsonb := current_setting('api.k1')::jsonb; raw text := j ->> 'key'; begin
  assert (select key_hash from public.api_keys where id = (j ->> 'id')::uuid) = encode(sha256(convert_to(raw, 'UTF8')), 'hex'), 'SHA-256 kept';
  assert not exists (select 1 from public.api_keys k where to_jsonb(k)::text like '%' || substr(raw, 9) || '%'), 'raw key not stored';
  assert not exists (select 1 from public.audit_log a where a.details::text like '%' || substr(raw, 9, 20) || '%'
                       or a.details::text like '%' || encode(sha256(convert_to(raw, 'UTF8')), 'hex') || '%'), 'no key or hash in the history';
  assert exists (select 1 from public.audit_log where workspace_id = current_setting('api.ws')::uuid and action = 'api_key.create'
                   and details ->> 'name' = 'Website shop'), 'key creation in the change history';
end $$;
set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare l json := public.api_keys_list(current_setting('api.ws')::uuid); begin
  assert json_array_length(l) = 1, 'one key listed';
  assert not (l -> 0)::jsonb ? 'key' and not (l -> 0)::jsonb ? 'key_hash', 'the list never has the key or its hash';
end $$;
-- the admin (two-step) can manage keys too; another business can't see them
select pg_temp.as_user('a9a9a9a4-0000-4000-8000-000000000004');
do $$ begin assert json_array_length(public.api_keys_list(current_setting('api.ws')::uuid)) = 1, 'admin lists keys'; end $$;
select pg_temp.as_user('a9a9a9a3-0000-4000-8000-000000000003');
do $$ begin
  begin perform public.api_keys_list(current_setting('api.ws')::uuid); raise exception 'other business listed keys';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
  begin perform public.api_key_revoke(current_setting('api.ws')::uuid, (current_setting('api.k1')::jsonb ->> 'id')::uuid); raise exception 'other business revoked';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- no table is readable directly, signed in or not
do $$ declare t text; begin
  foreach t in array array['api_keys', 'api_inbox', 'api_requests', 'api_webhooks', 'api_webhook_deliveries', 'api_catalog', 'api_stock',
                           'api_open_times', 'api_staff', 'api_booking_settings', 'api_rate', 'api_published'] loop
    begin execute format('select count(*) from public.%I', t); raise exception 'authenticated read %', t;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
set role anon;
do $$ declare t text; begin
  foreach t in array array['api_keys', 'api_inbox', 'api_requests', 'api_webhooks', 'api_catalog', 'api_stock', 'api_open_times'] loop
    begin execute format('select count(*) from public.%I', t); raise exception 'anon read %', t;
    exception when insufficient_privilege then null; end;
  end loop;
  begin perform public.api_auth(repeat('a', 64), null); raise exception 'anon ran api_auth'; exception when insufficient_privilege then null; end;
  begin perform public.api_keys_list(current_setting('api.ws')::uuid); raise exception 'anon listed keys'; exception when insufficient_privilege then null; end;
end $$;
set role authenticated;
do $$ begin
  begin perform public.api_auth(repeat('a', 64), null); raise exception 'a signed-in person ran api_auth'; exception when insufficient_privilege then null; end;
  begin perform public.api_submit(gen_random_uuid(), 'order', '{}', null, null, null); raise exception 'signed in ran api_submit'; exception when insufficient_privilege then null; end;
  begin perform public.api_webhooks_due(10, null); raise exception 'signed in took deliveries'; exception when insufficient_privilege then null; end;
  begin perform public.api_sweep(); raise exception 'signed in swept'; exception when insufficient_privilege then null; end;
end $$;

-- Widget keys: only availability:read, bookings:write, enquiries:write, and only with a website address
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('api.ws')::uuid; j json; begin
  begin perform public.api_key_create(ws, 'Widget', 'widget', 'live', array['bookings:write', 'orders:write'], array['https://salon.example.com'], '{}'); raise exception 'widget with orders';
  exception when others then assert sqlerrm like 'A widget key is seen by everyone%', sqlerrm; end;
  begin perform public.api_key_create(ws, 'Widget', 'widget', 'live', array['bookings:write'], '{}', '{}'); raise exception 'widget without a website';
  exception when others then assert sqlerrm like 'Add the website address%', sqlerrm; end;
  begin perform public.api_key_create(ws, 'Widget', 'widget', 'live', array['bookings:write'], array['https://salon.example.com/book'], '{}'); raise exception 'origin with a path';
  exception when others then assert sqlerrm like 'Website addresses look like%', sqlerrm; end;
  begin perform public.api_key_create(ws, 'Widget', 'widget', 'live', array['bookings:write'], array['http://localhost:3000'], '{}'); raise exception 'localhost on a live key';
  exception when others then assert sqlerrm like 'Website addresses look like%', sqlerrm; end;
  begin perform public.api_key_create(ws, 'X', 'secret', 'live', array['everything:write'], '{}', '{}'); raise exception 'unknown scope';
  exception when others then assert sqlerrm like 'Unknown permission%', sqlerrm; end;
  begin perform public.api_key_create(ws, 'X', 'secret', 'live', array['orders:write'], '{}', array['not-an-ip']); raise exception 'bad ip';
  exception when others then assert sqlerrm like 'Internet addresses look like%', sqlerrm; end;
  j := public.api_key_create(ws, 'Booking widget', 'widget', 'live', array['availability:read', 'bookings:write', 'enquiries:write'],
         array['https://Salon.Example.com/', 'https://*.example.com'], '{}');
  assert j ->> 'key' ~ '^rk_pub_live_[0-9a-f]{48}$', 'widget key format';
  assert (j -> 'allowed_origins')::jsonb = '["https://salon.example.com", "https://*.example.com"]', 'origins tidied';
  perform set_config('api.kw', j::text, false);
  j := public.api_key_create(ws, 'Test shop', 'secret', 'test', array['orders:write', 'enquiries:write'], array['http://localhost:3000'], '{}');
  assert j ->> 'key' ~ '^rk_test_[0-9a-f]{48}$', 'test key format';
  perform set_config('api.kt', j::text, false);
  j := public.api_key_create(ws, 'Office server', 'secret', 'live', array['enquiries:write'], '{}', array['203.0.113.0/24', '2001:db8::/32']);
  perform set_config('api.ki', j::text, false);
  -- rename and change access: in the change history
  perform public.api_key_rename(ws, (j ->> 'id')::uuid, 'Office server (Sydney)');
  assert exists (select 1 from json_array_elements(public.api_keys_list(ws)) k where k ->> 'name' = 'Office server (Sydney)'), 'renamed';
end $$;

-- api_auth (the Edge Function, as the service role): from the hash; wrong keys refused; the internet address list
reset role; set role service_role;
do $$ declare k1 jsonb := current_setting('api.k1')::jsonb; ki jsonb := current_setting('api.ki')::jsonb; a json; begin
  a := public.api_auth(encode(sha256(convert_to(k1 ->> 'key', 'UTF8')), 'hex'), '198.51.100.20');
  assert a ->> 'key_id' = k1 ->> 'id' and a ->> 'workspace_id' = current_setting('api.ws') and a ->> 'mode' = 'live', 'api_auth finds the key: ' || a::text;
  assert (a -> 'rate' ->> 'limit')::int = 120, 'default per-minute limit';
  assert public.api_auth(encode(sha256(convert_to((k1 ->> 'key') || 'x', 'UTF8')), 'hex'), null) #>> '{error,code}' = 'invalid_key', 'wrong key';
  assert public.api_auth('not-a-hash; drop table api_keys', null) #>> '{error,code}' = 'invalid_key', 'junk refused';
  a := public.api_auth(encode(sha256(convert_to(ki ->> 'key', 'UTF8')), 'hex'), '198.51.100.20');
  assert a #>> '{error,code}' = 'ip_not_allowed', 'address not on the list: ' || a::text;
  assert public.api_auth(encode(sha256(convert_to(ki ->> 'key', 'UTF8')), 'hex'), null) #>> '{error,code}' = 'ip_not_allowed', 'no address, refused';
  assert public.api_auth(encode(sha256(convert_to(ki ->> 'key', 'UTF8')), 'hex'), '203.0.113.99') ->> 'key_id' = ki ->> 'id', 'IPv4 on the list';
  assert public.api_auth(encode(sha256(convert_to(ki ->> 'key', 'UTF8')), 'hex'), '2001:db8:5::1') ->> 'key_id' = ki ->> 'id', 'IPv6 on the list';
end $$;
reset role;
do $$ begin assert exists (select 1 from public.api_keys where id = (current_setting('api.k1')::jsonb ->> 'id')::uuid and last_used_at is not null), 'last used'; end $$;

-- Rate limits: per key per minute, per visitor address for widget keys, per business per day
reset role;
insert into public.hq_settings (key, value) values ('api.key_per_minute', '2'), ('api.widget_ip_per_minute', '2') on conflict (key) do update set value = excluded.value;
delete from public.api_rate;
set role service_role;
do $$ declare h text := encode(sha256(convert_to(current_setting('api.k1')::jsonb ->> 'key', 'UTF8')), 'hex');
  hw text := encode(sha256(convert_to(current_setting('api.kw')::jsonb ->> 'key', 'UTF8')), 'hex'); limited int := 0; a json; i int; begin
  -- 6 calls with a limit of 2 a minute: even across a minute boundary, some are refused
  for i in 1..6 loop a := public.api_auth(h, '198.51.100.20'); if a #>> '{error,code}' = 'rate_limited' then limited := limited + 1; end if; end loop;
  assert limited >= 1, 'per-minute limit';
  limited := 0;
  for i in 1..6 loop a := public.api_auth(hw, '192.0.2.10'); if a #>> '{error,code}' = 'rate_limited' then limited := limited + 1; end if; end loop;
  assert limited >= 1, 'widget per-visitor limit';
  assert public.api_auth(hw, '192.0.3.10') ->> 'key_id' is not null, 'another visitor isn''t limited by the first';
end $$;
reset role;
delete from public.hq_settings where key in ('api.key_per_minute', 'api.widget_ip_per_minute');
insert into public.hq_settings (key, value) values ('api.workspace_per_day', '3') on conflict (key) do update set value = excluded.value;
delete from public.api_rate;
set role service_role;
do $$ declare h text := encode(sha256(convert_to(current_setting('api.k1')::jsonb ->> 'key', 'UTF8')), 'hex'); a json; i int; begin
  for i in 1..4 loop a := public.api_auth(h, null); end loop;
  assert a #>> '{error,code}' = 'daily_limit', 'per-day limit: ' || a::text;
end $$;
reset role;
delete from public.hq_settings where key = 'api.workspace_per_day';
delete from public.api_rate;

-- The post box: a booking, with Idempotency-Key replay and conflict; a missing permission; test keys marked test
set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; kt uuid := (current_setting('api.kt')::jsonb ->> 'id')::uuid;
  ki uuid := (current_setting('api.ki')::jsonb ->> 'id')::uuid; a json; b json; h1 text := repeat('1', 64); h2 text := repeat('2', 64); begin
  a := public.api_submit(k1, 'order', '{"customer":{"name":"Pat","email":"pat@example.com"},"items":[{"sku":"MUG","quantity":2}]}', 'ord-1001', h1, 'api');
  assert a ->> 'id' is not null and a ->> 'status' = 'waiting' and not (a ->> 'replay')::boolean and not (a ->> 'test')::boolean, 'order in: ' || a::text;
  b := public.api_submit(k1, 'order', '{"customer":{"name":"Pat","email":"pat@example.com"},"items":[{"sku":"MUG","quantity":2}]}', 'ord-1001', h1, 'api');
  assert b ->> 'id' = a ->> 'id' and (b ->> 'replay')::boolean, 'same Idempotency-Key, same body: the first answer';
  b := public.api_submit(k1, 'order', '{"customer":{"name":"Pat"},"items":[{"sku":"MUG","quantity":3}]}', 'ord-1001', h2, 'api');
  assert b #>> '{error,code}' = 'idempotency_conflict', 'same key, different body: refused';
  assert (select count(*) from public.api_inbox where idempotency_key = 'ord-1001') = 1, 'only one';
  b := public.api_submit(k1, 'order', '{"customer":{"name":"Pat"},"items":[{"sku":"MUG","quantity":1}]}', 'bad key with spaces', h2, 'api');
  assert b #>> '{error,code}' = 'invalid_idempotency_key', 'idempotency key checked';
  b := public.api_submit(ki, 'order', '{"customer":{"name":"Pat"},"items":[{"sku":"MUG","quantity":1}]}', null, h2, 'api');
  assert b #>> '{error,code}' = 'missing_scope', 'a key without orders:write: ' || b::text;
  b := public.api_submit(k1, 'order', '{"customer":{"name":"Pat"},"items":[]}', null, h2, 'api');
  assert b #>> '{error,code}' = 'invalid_payload', 'empty order refused';
  b := public.api_submit(k1, 'booking', '{"customer":{"name":"Pat"},"service":"CUT","start":"next tuesday"}', null, h2, 'api');
  assert b #>> '{error,code}' = 'invalid_payload', 'bad start refused';
  b := public.api_submit(k1, 'invoice_payment', '{"invoice_ref":"INV-7","amount":-5}', null, h2, 'api');
  assert b #>> '{error,code}' = 'invalid_payload', 'negative payment refused';
  b := public.api_submit(kt, 'enquiry', '{"customer":{"name":"Tess","email":"t@example.com"},"message":"Do you do gift cards?"}', 'enq-1', h1, 'api');
  assert (b ->> 'test')::boolean, 'test key: marked test';
  b := public.api_submit(k1, 'enquiry', '{"customer":{"name":"Lee","phone":"021 555 0101"},"message":"Quote for a deck?"}', 'enq-1', h1, 'api');
  assert not (b ->> 'replay')::boolean, 'Idempotency-Keys are per key';
  b := public.api_submit(k1, 'quote_accept', '{"quote_ref":"Q-1042","accepted_by":{"name":"Lee"}}', null, h1, 'api');
  assert b ->> 'status' = 'waiting', 'quote acceptance in';
  b := public.api_submit(k1, 'invoice_payment', '{"invoice_ref":"INV-77","amount":120.5,"method":"card"}', null, h1, 'api');
  assert b ->> 'status' = 'waiting', 'invoice payment in';
  b := public.api_submit(k1, 'customer', '{"name":"Max","email":"max@example.com"}', null, h1, 'api');
  assert b ->> 'status' = 'waiting', 'customer in';
  perform set_config('api.ord', a ->> 'id', false);
end $$;

-- Plan gating: what the business's licence allows
reset role;
insert into public.company_modules (workspace_id, module, status, trial_ends)
  select current_setting('api.ws')::uuid, 'bookings', 'trial', current_date - 1;
set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; b json; begin
  b := public.api_submit(k1, 'booking', '{"customer":{"name":"Pat"},"service":"CUT","start":"2030-01-01T09:00:00Z"}', null, repeat('3', 64), 'api');
  assert b #>> '{error,code}' = 'bookings_licence_required', 'Bookings trial over: ' || b::text;
  assert public.api_read(k1, 'availability', '{}') #>> '{error,code}' = 'bookings_licence_required', 'open times need Bookings too';
  assert public.api_submit(k1, 'enquiry', '{"customer":{"name":"Pat"},"message":"Hi"}', null, repeat('3', 64), 'api') ->> 'status' = 'waiting', 'enquiries still fine';
end $$;
reset role;
insert into public.company_modules (workspace_id, module, status, paid_until)
  select current_setting('api.ws')::uuid, m, 'cancelled', current_date - 1 from unnest(array['pos', 'basic', 'plus']) m;
set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; begin
  assert public.api_submit(k1, 'order', '{"customer":{"name":"Pat"},"items":[{"sku":"A","quantity":1}]}', null, repeat('3', 64), 'api') #>> '{error,code}'
    = 'pos_or_accounting_licence_required', 'orders need POS or Accounting';
  assert public.api_read(k1, 'stock', '{}') #>> '{error,code}' = 'pos_or_accounting_licence_required', 'stock needs POS or Accounting';
  assert public.api_read(k1, 'prices', '{}') ->> 'items' is not null, 'prices still fine';
end $$;
reset role;
insert into public.company_modules (workspace_id, module, status, paid_until)
  select current_setting('api.ws')::uuid, m, 'cancelled', current_date - 1 from unnest(array['calls', 'payroll', 'as_built']) m;
set role service_role;
do $$ begin
  assert public.api_submit((current_setting('api.k1')::jsonb ->> 'id')::uuid, 'enquiry', '{"customer":{"name":"Pat"},"message":"Hi"}', null, repeat('3', 64), 'api')
    #>> '{error,code}' = 'plan_required', 'no program at all: plan_required';
end $$;
reset role;
-- back on: POS paid, Bookings paid
delete from public.company_modules where workspace_id = current_setting('api.ws')::uuid;
insert into public.company_modules (workspace_id, module, status, paid_until)
  select current_setting('api.ws')::uuid, m, 'active', current_date + 30 from unnest(array['pos', 'bookings']) m;
update public.workspaces set status = 'suspended' where id = current_setting('api.ws')::uuid;
set role service_role;
do $$ begin
  assert public.api_auth(encode(sha256(convert_to(current_setting('api.k1')::jsonb ->> 'key', 'UTF8')), 'hex'), null) #>> '{error,code}' = 'business_closed', 'a paused business: closed';
end $$;
reset role;
update public.workspaces set status = 'active' where id = current_setting('api.ws')::uuid;

-- The PCs: claim (oldest first, taken for 10 minutes), done, fail with retry / rejected; only linked PCs
set role authenticated;
select pg_temp.as_user('a9a9a9a3-0000-4000-8000-000000000003');
do $$ begin
  begin perform public.api_inbox_claim(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', null, 10); raise exception 'another business claimed';
  exception when others then assert sqlerrm like 'Link this PC to the business first%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a4-0000-4000-8000-000000000004');
do $$ begin
  begin perform public.api_inbox_claim(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', null, 10); raise exception 'someone else''s PC id';
  exception when others then assert sqlerrm like 'Link this PC to the business first%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; c json; e jsonb; begin
  c := public.api_inbox_claim(ws, d1, array['order'], 10);
  assert json_array_length(c) = 1 and c -> 0 ->> 'id' = current_setting('api.ord'), 'only orders: ' || c::text;
  e := (c -> 0)::jsonb;
  assert e ->> 'kind' = 'order' and e -> 'payload' -> 'customer' ->> 'name' = 'Pat' and e ->> 'key_name' = 'Website shop' and (e ->> 'attempts')::int = 1, 'what the PC gets';
  assert json_array_length(public.api_inbox_claim(ws, d1, array['order'], 10)) = 0, 'taken: not given again';
  c := public.api_inbox_claim(ws, d1, null, 2);
  assert json_array_length(c) = 2, 'max_items';
  assert (select count(*) from json_array_elements(c) x where (x ->> 'test')::boolean) = 1, 'the test enquiry is first and marked test';
  perform public.api_inbox_done(ws, d1, current_setting('api.ord')::uuid, '{"reference":"POS-0042","state":"accepted","message":"Thanks! Ready in 20 minutes.<script>"}');
  begin perform public.api_inbox_done(ws, d1, current_setting('api.ord')::uuid, '{}'); raise exception 'done twice';
  exception when others then assert sqlerrm like 'This PC hasn''t taken that one%', sqlerrm; end;
  perform set_config('api.c2', c::text, false);
end $$;
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d2 uuid := 'a9a9a9d2-0000-4000-8000-000000000002'; c json := current_setting('api.c2')::json; begin
  begin perform public.api_inbox_done(ws, d2, (c -> 0 ->> 'id')::uuid, '{}'); raise exception 'another PC finished it';
  exception when others then assert sqlerrm like 'This PC hasn''t taken that one%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; c json := current_setting('api.c2')::json; r json; begin
  r := public.api_inbox_fail(ws, d1, (c -> 0 ->> 'id')::uuid, 'Accounting was busy', true, null);
  assert r ->> 'status' = 'waiting', 'retry: back in the post box';
  r := public.api_inbox_fail(ws, d1, (c -> 1 ->> 'id')::uuid, 'Not something we do', false, '{"state":"declined","message":"Sorry, we don''t do gift cards."}');
  assert r ->> 'status' = 'rejected', 'rejected';
end $$;
-- the retried one isn't given again straight away (it waits a minute); a PC that went quiet for 10 minutes lets go
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; c json := current_setting('api.c2')::json; got json; begin
  got := public.api_inbox_claim(ws, d1, null, 100);
  assert not exists (select 1 from json_array_elements(got) x where x ->> 'id' = c -> 0 ->> 'id'), 'retry waits';
  perform set_config('api.c3', got::text, false);
end $$;
reset role;
update public.api_inbox set available_at = now() - interval '1 second' where id = (current_setting('api.c2')::json -> 0 ->> 'id')::uuid;
update public.api_inbox set taken_at = now() - interval '11 minutes' where id = (current_setting('api.c3')::json -> 0 ->> 'id')::uuid;
set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d2 uuid := 'a9a9a9d2-0000-4000-8000-000000000002'; got json; i int; r json; id1 uuid := (current_setting('api.c2')::json -> 0 ->> 'id')::uuid; begin
  got := public.api_inbox_claim(ws, d2, null, 100);
  assert exists (select 1 from json_array_elements(got) x where x ->> 'id' = id1::text), 'retry due: taken again';
  assert exists (select 1 from json_array_elements(got) x where x ->> 'id' = current_setting('api.c3')::json -> 0 ->> 'id'), 'stale (11 minutes): another PC takes it';
end $$;
-- five tries, then failed (run as the database, signed in as the owner, so the wait can be skipped each time)
reset role;
do $$ declare ws uuid := current_setting('api.ws')::uuid; d2 uuid := 'a9a9a9d2-0000-4000-8000-000000000002'; i int; r json; id1 uuid := (current_setting('api.c2')::json -> 0 ->> 'id')::uuid; begin
  perform set_config('request.jwt.claim.sub', 'a9a9a9a1-0000-4000-8000-000000000001', false);
  perform set_config('request.jwt.claims', '{"sub":"a9a9a9a1-0000-4000-8000-000000000001","aal":"aal2"}', false);
  for i in 1..10 loop
    r := public.api_inbox_fail(ws, d2, id1, 'Still busy', true, null);
    exit when r ->> 'status' = 'failed';
    update public.api_inbox set available_at = now() where id = id1;
    perform public.api_inbox_claim(ws, d2, null, 100);
  end loop;
  assert r ->> 'status' = 'failed' and (r ->> 'attempts')::int = 5, 'failed after 5 tries: ' || r::text;
  assert (public.api_inbox_counts(ws, d2) ->> 'failed')::int = 1, 'counts';
  -- the owner can send it round again
  assert public.api_inbox_retry(ws, id1) ->> 'status' = 'waiting', 'retry by the owner';
  assert exists (select 1 from json_array_elements(public.api_inbox_recent(ws, null, 50)) x where x ->> 'customer_name' = 'Pat'), 'recent list';
end $$;
-- FOR UPDATE SKIP LOCKED: while another PC is in the middle of taking a row, it's skipped, not waited for
reset role;
create extension if not exists dblink;
do $$ declare c json; locked uuid; begin
  update public.api_inbox set status = 'waiting', available_at = now(), taken_by = null where workspace_id = current_setting('api.ws')::uuid and status = 'taken';
  select id into locked from public.api_inbox where workspace_id = current_setting('api.ws')::uuid and status = 'waiting' order by created_at limit 1;
  perform dblink_connect('other_pc', 'dbname=' || current_database());
  perform dblink_exec('other_pc', 'begin');
  perform * from dblink('other_pc', format('select 1 from public.api_inbox where id = %L for update', locked)) as t(x int);
  perform set_config('request.jwt.claim.sub', 'a9a9a9a2-0000-4000-8000-000000000002', false);
  perform set_config('request.jwt.claims', '{"sub":"a9a9a9a2-0000-4000-8000-000000000002","aal":"aal2"}', false);
  c := public.api_inbox_claim(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', null, 100);
  assert json_array_length(c) >= 1, 'others taken';
  assert not exists (select 1 from json_array_elements(c) x where x ->> 'id' = locked::text), 'the locked row was skipped';
  perform dblink_exec('other_pc', 'rollback');
  perform dblink_disconnect('other_pc');
end $$;
-- a PC that was replaced (Fresh start) can't take anything
reset role;
update public.devices set retired_at = now() where id = 'a9a9a9d1-0000-4000-8000-000000000001';
set role authenticated; select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.api_inbox_claim(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', null, 10); raise exception 'a replaced PC claimed';
  exception when others then assert sqlerrm like 'Link this PC%', sqlerrm; end;
  perform public.link_device(current_setting('api.ws')::uuid, 'a9a9a9d1-0000-4000-8000-000000000001', 'FRONT-DESK', 'windows', '1.0');
end $$;

-- What the website sees of an event: status and the cleaned result, never the payload
reset role; set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; kw uuid := (current_setting('api.kw')::jsonb ->> 'id')::uuid; e json; begin
  e := public.api_read(k1, 'event', json_build_object('id', current_setting('api.ord'))::jsonb);
  assert e ->> 'status' = 'done' and e -> 'result' ->> 'reference' = 'POS-0042' and e -> 'result' ->> 'state' = 'accepted', 'event status: ' || e::text;
  assert e -> 'result' ->> 'message' = 'Thanks! Ready in 20 minutes.script', 'message tidied';
  assert not (e::jsonb ? 'payload'), 'no payload';
  assert public.api_read(kw, 'event', json_build_object('id', current_setting('api.ord'))::jsonb) #>> '{error,code}' = 'not_found', 'a widget key only sees its own';
  assert public.api_read(k1, 'event', '{"id":"not-a-uuid"}') #>> '{error,code}' = 'not_found', 'junk id';
end $$;

-- Published data: catalogue, stock (stock.changed to webhooks), open times -> free start times
reset role; set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
select set_config('api.hook', public.api_webhook_create(current_setting('api.ws')::uuid, 'https://hooks.example.com/riyeser', array['stock.changed', 'order.ready', 'booking.received'], 'live', 'Shop')::text, false);
do $$ declare ws uuid := current_setting('api.ws')::uuid; h jsonb := current_setting('api.hook')::jsonb; begin
  assert h ->> 'secret' ~ '^whsec_[0-9a-f]{48}$', 'secret shown once';
  assert not (public.api_webhooks_list(ws) -> 0)::jsonb ? 'secret', 'the list never shows the secret';
  begin perform public.api_webhook_create(ws, 'http://hooks.example.com/x', array['stock.changed'], 'live', null); raise exception 'http allowed';
  exception when others then assert sqlerrm like 'The address must start with https://%', sqlerrm; end;
  begin perform public.api_webhook_create(ws, 'https://localhost/x', array['stock.changed'], 'live', null); raise exception 'localhost allowed';
  exception when others then assert sqlerrm like 'Use the public web address%', sqlerrm; end;
  begin perform public.api_webhook_create(ws, 'https://169.254.169.254/latest', array['stock.changed'], 'live', null); raise exception 'IP allowed';
  exception when others then assert sqlerrm like 'Use the public web address%', sqlerrm; end;
  begin perform public.api_webhook_create(ws, 'https://a.example.com/x', array['stock.stolen'], 'live', null); raise exception 'unknown event';
  exception when others then assert sqlerrm like 'Unknown event%', sqlerrm; end;
end $$;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; r json; begin
  begin perform public.api_webhooks_list(ws); raise exception 'staff saw webhooks'; exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
  r := public.api_publish_catalog(ws, d1, '[{"sku":"MUG","name":"Blue mug","price":12.5,"currency":"nzd","tax_rate":15},
      {"sku":"CUT","type":"service","name":"Haircut","price":45,"currency":"NZD","duration_minutes":60},
      {"sku":"OLD","name":"Old thing","price":1,"active":false},
      {"sku":"bad sku!","name":"Nope","price":1}, {"sku":"NEG","name":"Negative","price":-1}]', true);
  assert (r ->> 'saved')::int = 3 and json_array_length(r -> 'skipped') = 2, 'catalogue: bad ones skipped: ' || r::text;
  r := public.api_publish_stock(ws, d1, '[{"sku":"MUG","quantity":4},{"sku":"CUP","quantity":0}]', true);
  assert (r ->> 'changed')::int = 2, 'stock changes';
  r := public.api_publish_stock(ws, d1, '[{"sku":"MUG","quantity":3}]', false);
  assert (r ->> 'changed')::int = 1 and (r ->> 'removed')::int = 0, 'partial stock update';
  r := public.api_publish_availability(ws, d1, '{"timezone":"Pacific/Auckland","slot_minutes":30,"min_notice_minutes":0,"days_ahead":30}',
    '[{"ref":"amy","name":"Amy","services":["CUT"]},{"ref":"bo","name":"Bo","services":["COLOUR"]}]',
    json_build_array(json_build_object('staff_ref', 'amy', 'start', (current_date + 2)::timestamp at time zone 'Pacific/Auckland' + interval '9 hours',
                                                         'end', (current_date + 2)::timestamp at time zone 'Pacific/Auckland' + interval '12 hours'),
                     json_build_object('staff_ref', 'bo', 'start', (current_date + 2)::timestamp at time zone 'Pacific/Auckland' + interval '9 hours',
                                                         'end', (current_date + 2)::timestamp at time zone 'Pacific/Auckland' + interval '12 hours'))::jsonb,
    now(), now() + interval '30 days');
  assert (r ->> 'open_times_saved')::int = 2 and (r ->> 'staff_saved')::int = 2, 'availability saved: ' || r::text;
  begin perform public.api_publish_availability(ws, d1, '{"timezone":"Mars/Olympus"}', null, null, null, null); raise exception 'bad tz';
  exception when others then assert sqlerrm like 'Unknown time zone%', sqlerrm; end;
end $$;
reset role; set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; kw uuid := (current_setting('api.kw')::jsonb ->> 'id')::uuid; r json; s json; d date := current_date + 2; b json; begin
  r := public.api_read(k1, 'prices', '{}');
  assert json_array_length(r -> 'items') = 2 and r -> 'items' -> 1 ->> 'currency' = 'NZD', 'prices: active only, currency upper-cased: ' || r::text;
  r := public.api_read(k1, 'catalog', '{"limit":2}');
  assert json_array_length(r -> 'items') = 2 and r ->> 'next' = 'MUG', 'catalogue pages: ' || r::text;
  r := public.api_read(k1, 'catalog', '{"limit":2,"after":"MUG"}');
  assert json_array_length(r -> 'items') = 1 and r ->> 'next' is null, 'last page';
  r := public.api_read(k1, 'stock', '{"skus":["MUG","CUP"]}');
  assert r -> 'items' -> 1 ->> 'quantity' = '3.000' and not (r -> 'items' -> 0 ->> 'in_stock')::boolean, 'stock: ' || r::text;
  assert public.api_read(kw, 'stock', '{}') #>> '{error,code}' = 'missing_scope', 'a widget key can''t read stock';
  r := public.api_read(kw, 'availability', '{}');
  assert r ->> 'timezone' = 'Pacific/Auckland' and json_array_length(r -> 'services') = 1 and json_array_length(r -> 'staff') = 2, 'availability: ' || r::text;
  s := public.api_read(kw, 'slots', json_build_object('service', 'CUT', 'from', d, 'days', 1)::jsonb);
  assert json_array_length(s -> 'slots') = 5, '09:00 to 11:00 every 30 minutes (only Amy does cuts): ' || s::text;
  assert s -> 'slots' -> 0 ->> 'local_start' = d::text || 'T09:00' and s -> 'slots' -> 0 -> 'staff' ->> 0 = 'amy', 'local time and staff';
  assert public.api_read(kw, 'slots', '{"service":"NOPE"}') #>> '{error,code}' = 'not_found', 'unknown service';
  assert public.api_read(kw, 'slots', '{"service":"CUT","from":"soon"}') #>> '{error,code}' = 'invalid_request', 'bad date';
  -- a widget can only book a time that's free; the booking then holds it until the PC takes it
  b := public.api_submit(kw, 'booking', json_build_object('customer', json_build_object('name', 'Kai', 'phone', '021 1'), 'service', 'CUT', 'staff', 'amy',
         'start', (s -> 'slots' -> 1 ->> 'start'))::jsonb, 'w-1', repeat('4', 64), 'api');
  assert b ->> 'status' = 'waiting', 'widget booking at a free time: ' || b::text;
  assert (select source from public.api_inbox where id = (b ->> 'id')::uuid) = 'widget', 'marked widget';
  assert (select payload ->> 'end' from public.api_inbox where id = (b ->> 'id')::uuid) is not null, 'end filled in from the service';
  s := public.api_read(kw, 'slots', json_build_object('service', 'CUT', 'from', d, 'days', 1)::jsonb);
  assert json_array_length(s -> 'slots') = 2, 'the booked hour is held: ' || s::text;
  b := public.api_submit(kw, 'booking', json_build_object('customer', json_build_object('name', 'Kim'), 'service', 'CUT', 'staff', 'amy',
         'start', ((d::timestamp at time zone 'Pacific/Auckland') + interval '9 hours 30 minutes'))::jsonb, 'w-2', repeat('4', 64), 'api');
  assert b #>> '{error,code}' = 'slot_not_available', 'the same time again: ' || b::text;
  b := public.api_submit(kw, 'booking', json_build_object('customer', json_build_object('name', 'Kim'), 'service', 'CUT',
         'start', ((d::timestamp at time zone 'Pacific/Auckland') + interval '9 hours 45 minutes'))::jsonb, 'w-3', repeat('4', 64), 'api');
  assert b #>> '{error,code}' = 'slot_not_available', 'not a start time';
  assert public.api_submit(kw, 'order', '{"customer":{"name":"Kim"},"items":[{"sku":"MUG","quantity":1}]}', null, repeat('4', 64), 'api') #>> '{error,code}' = 'missing_scope', 'widget can''t order';
  -- webhooks queued: booking.received and two stock.changed (not order.ready: the PC hasn't said so)
  assert (select count(*) from public.api_webhook_deliveries where workspace_id = current_setting('api.ws')::uuid and event = 'stock.changed') = 2, 'stock.changed queued';
  assert (select count(*) from public.api_webhook_deliveries where workspace_id = current_setting('api.ws')::uuid and event = 'booking.received') = 1, 'booking.received queued';
  assert (select payload -> 'data' -> 'items' -> 0 ->> 'sku' from public.api_webhook_deliveries where event = 'stock.changed' order by created_at desc limit 1) = 'MUG', 'what changed';
end $$;
-- the PC says the order is ready: order.ready to the webhook; the website sees state "ready"
reset role; set role authenticated; select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; r json; begin
  r := public.api_notify(ws, d1, 'order.ready', current_setting('api.ord')::uuid, '{"reference":"POS-0042","message":"Ready at the counter"}');
  assert (r ->> 'queued')::int = 1, 'order.ready queued';
  begin perform public.api_notify(ws, d1, 'booking.confirmed', current_setting('api.ord')::uuid, '{}'); raise exception 'wrong kind';
  exception when others then assert sqlerrm like 'That event is a order%', sqlerrm; end;
  begin perform public.api_notify(ws, d1, 'stock.changed', null, '{}'); raise exception 'PCs announce stock by publishing';
  exception when others then assert sqlerrm like 'Unknown event%', sqlerrm; end;
end $$;
reset role; set role service_role;
do $$ declare e json := public.api_read((current_setting('api.k1')::jsonb ->> 'id')::uuid, 'event', json_build_object('id', current_setting('api.ord'))::jsonb); begin
  assert e -> 'result' ->> 'state' = 'ready' and e -> 'result' ->> 'message' = 'Ready at the counter', 'state ready: ' || e::text;
end $$;

-- The dispatcher: due deliveries (locked while sending), retries with backoff, delivered
do $$ declare a json; b json; d uuid; i int; begin
  a := public.api_webhooks_due(100, null);
  assert json_array_length(a) = 4, 'four due: ' || json_array_length(a);
  assert a -> 0 ->> 'secret' = current_setting('api.hook')::jsonb ->> 'secret' and a -> 0 ->> 'url' = 'https://hooks.example.com/riyeser', 'url and secret for signing';
  assert a -> 0 -> 'payload' ->> 'type' is not null and a -> 0 -> 'payload' ->> 'id' is not null, 'body';
  b := public.api_webhooks_due(100, null);
  assert json_array_length(b) = 0, 'being sent: not given again';
  d := (a -> 0 ->> 'id')::uuid;
  perform public.api_webhook_result(d, false, 500, 'Internal Server Error');
  assert (select status || ':' || attempts from public.api_webhook_deliveries where id = d) = 'pending:1', 'retry later';
  assert (select next_at > now() + interval '50 seconds' from public.api_webhook_deliveries where id = d), 'backoff';
  for i in 1..3 loop perform public.api_webhook_result((a -> i ->> 'id')::uuid, true, 200, null); end loop;
  assert (select count(*) from public.api_webhook_deliveries where status = 'delivered') = 3, 'delivered';
  for i in 2..8 loop
    update public.api_webhook_deliveries set next_at = now() where id = d;
    perform public.api_webhooks_due(100, null);
    perform public.api_webhook_result(d, false, null, 'timeout');
  end loop;
  assert (select status || ':' || attempts from public.api_webhook_deliveries where id = d) = 'failed:8', 'failed after 8 tries';
  assert (select failing_since is not null from public.api_webhooks where id = (current_setting('api.hook')::jsonb ->> 'id')::uuid), 'failing shown';
end $$;
reset role;
update public.api_webhooks set failing_since = now() - interval '4 days' where id = (current_setting('api.hook')::jsonb ->> 'id')::uuid;
set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare id uuid; begin perform public.api_webhook_ping(current_setting('api.ws')::uuid, (current_setting('api.hook')::jsonb ->> 'id')::uuid); end $$;
reset role; set role service_role;
do $$ declare a json := public.api_webhooks_due(100, null); begin
  assert json_array_length(a) = 1 and a -> 0 ->> 'event' = 'ping', 'ping';
  perform public.api_webhook_result((a -> 0 ->> 'id')::uuid, false, 503, 'down');
  assert not (select active from public.api_webhooks where id = (current_setting('api.hook')::jsonb ->> 'id')::uuid), 'failing 3 days: turned off';
end $$;
reset role; set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('api.ws')::uuid; h uuid := (current_setting('api.hook')::jsonb ->> 'id')::uuid; j json; begin
  j := public.api_webhook_update(ws, h, null, null, true);
  assert (j ->> 'active')::boolean and j ->> 'failing_since' is null, 'turned back on';
  j := public.api_webhook_rotate(ws, h);
  assert j ->> 'secret' <> current_setting('api.hook')::jsonb ->> 'secret', 'new secret';
  assert json_array_length(public.api_webhook_deliveries_list(ws, h, 50)) >= 5, 'delivery log';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'api_webhook.rotate'), 'rotate in history';
end $$;

-- The request log: written by the function, addresses truncated; owners and admins read their own; 30 days kept
reset role; set role service_role;
do $$ declare k1 uuid := (current_setting('api.k1')::jsonb ->> 'id')::uuid; begin
  perform public.api_log_request(k1, 'post', '/v1/orders?email=pat@example.com', 202, 41, '203.0.113.77', null);
  perform public.api_log_request(k1, 'GET', '/v1/stock', 429, 3, '2001:db8:1:2::5', 'rate_limited');
  perform public.api_log_request(gen_random_uuid(), 'GET', '/v1/stock', 401, 3, '203.0.113.1', 'invalid_key');   -- no such key: not logged
end $$;
reset role; set role authenticated; select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ declare l json := public.api_requests_list(current_setting('api.ws')::uuid, null, 10, null); begin
  assert json_array_length(l) = 2, 'two lines';
  assert l -> 1 ->> 'ip' = '203.0.113.0' and l -> 1 ->> 'path' = '/v1/orders' and l -> 1 ->> 'method' = 'POST', 'IPv4 truncated, no query: ' || l::text;
  assert l -> 0 ->> 'ip' = '2001:db8:1::' and l -> 0 ->> 'code' = 'rate_limited', 'IPv6 truncated';
  assert (public.api_overview(current_setting('api.ws')::uuid) -> 'allowed' ->> 'bookings')::boolean, 'overview';
end $$;
select pg_temp.as_user('a9a9a9a3-0000-4000-8000-000000000003');
do $$ begin
  begin perform public.api_requests_list(current_setting('api.ws')::uuid, null, 10, null); raise exception 'other business read the log';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;

-- Revoked keys stop at once
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
select public.api_key_revoke(current_setting('api.ws')::uuid, (current_setting('api.kt')::jsonb ->> 'id')::uuid);
reset role; set role service_role;
do $$ begin
  assert public.api_auth(encode(sha256(convert_to(current_setting('api.kt')::jsonb ->> 'key', 'UTF8')), 'hex'), null) #>> '{error,code}' = 'key_revoked', 'revoked';
  assert public.api_submit((current_setting('api.kt')::jsonb ->> 'id')::uuid, 'enquiry', '{"customer":{"name":"A"},"message":"x"}', null, null, 'api') #>> '{error,code}' = 'invalid_key', 'revoked can''t submit';
end $$;
reset role;
do $$ begin assert exists (select 1 from public.audit_log where action = 'api_key.revoke'), 'revoke in history'; end $$;

-- Tidying up: finished post box items after 90 days, never-collected ones marked failed, log and deliveries after 30
update public.api_inbox set updated_at = now() - interval '91 days' where id = current_setting('api.ord')::uuid;
insert into public.api_inbox (workspace_id, kind, payload, created_at) values (current_setting('api.ws')::uuid, 'enquiry', '{"message":"old"}', now() - interval '95 days');
update public.api_requests set at = now() - interval '31 days' where path = '/v1/orders';
update public.api_webhook_deliveries set created_at = now() - interval '31 days' where status = 'delivered';
insert into public.api_rate values ('k:old', 5, now() - interval '1 minute');
set role service_role;
do $$ declare r json := public.api_sweep(); begin
  assert (r ->> 'inbox_removed')::int = 1 and (r ->> 'inbox_expired')::int = 1 and (r ->> 'requests_removed')::int = 1
     and (r ->> 'deliveries_removed')::int = 3 and (r ->> 'rate_removed')::int >= 1, 'sweep: ' || r::text;
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.api_inbox where id = current_setting('api.ord')::uuid), 'old done one removed';
  assert (select status from public.api_inbox where payload ->> 'message' = 'old') = 'failed', 'never collected: failed';
  assert (select count(*) from public.api_requests) = 1, 'recent log kept';
end $$;
reset role;
-- ===== Online connections: api_status (is it set up? which PC syncs?) and "Send a test" =====
-- a linked PC (even a staff member's) sees where things stand; another business can't
set role authenticated;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; j json; begin
  j := public.api_status(ws, d1);
  assert (j ->> 'set_up')::boolean, 'keys exist: set up ' || j::text;
  assert (j -> 'keys' ->> 'active')::int >= 1, 'active keys counted';
  assert j -> 'published' ->> 'catalog_at' is not null and (j -> 'published' ->> 'catalog_items')::int >= 1, 'published seen';
  assert j -> 'sync_pc' ->> 'name' = 'FRONT-DESK' and (j -> 'sync_pc' ->> 'this_pc')::boolean, 'the PC that syncs: ' || j::text;
  assert j ->> 'last_request_at' is not null and j ->> 'checked_at' is not null, 'last request';
  begin perform public.api_status(ws, 'a9a9a9d2-0000-4000-8000-000000000002'); raise exception 'someone else''s PC';
  exception when others then assert sqlerrm like 'Link this PC to the business first%', sqlerrm; end;
  -- a live item isn't readable by a PC through api_event_status (only tests are)
  begin perform public.api_event_status(ws, d1, (select id from public.api_inbox where workspace_id = ws and mode = 'live' limit 1));
    raise exception 'PC read a live item';
  exception when others then null; end;
end $$;
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
reset role;
do $$ begin assert exists (select 1 from public.api_inbox where workspace_id = current_setting('api.ws')::uuid and mode = 'live'), 'has live items'; end $$;
set role authenticated;
-- owners/admins (two-step) can use it without a PC
select pg_temp.as_user('a9a9a9a1-0000-4000-8000-000000000001');
do $$ begin assert (public.api_status(current_setting('api.ws')::uuid, null) ->> 'set_up')::boolean, 'admin without a PC'; end $$;
select pg_temp.as_user('a9a9a9a3-0000-4000-8000-000000000003');
do $$ begin
  begin perform public.api_status(current_setting('api.ws')::uuid, null); raise exception 'other business saw status';
  exception when others then assert sqlerrm like 'Link this PC to the business first%', sqlerrm; end;
  begin perform public.api_send_test(current_setting('api.ws')::uuid, null, 'enquiry'); raise exception 'other business sent a test';
  exception when others then assert sqlerrm like 'Link this PC to the business first%', sqlerrm; end;
end $$;
-- a brand new business with nothing connected: not set up; a test goes through the post box, as a test
select public.link_device(current_setting('api.ws_x')::uuid, 'a9a9a9d3-0000-4000-8000-000000000003', 'SHOP-PC', 'windows', '1.0');
do $$ declare ws uuid := current_setting('api.ws_x')::uuid; d uuid := 'a9a9a9d3-0000-4000-8000-000000000003'; j json; t json; c json; e json; begin
  j := public.api_status(ws, d);
  assert not (j ->> 'set_up')::boolean and (j -> 'keys' ->> 'active')::int = 0 and j ->> 'sync_pc' is null
     and (j -> 'inbox' ->> 'waiting')::int = 0 and j ->> 'last_request_at' is null, 'nothing connected: ' || j::text;
  begin perform public.api_send_test(ws, d, 'booking'); raise exception 'test booking without a service';
  exception when others then assert sqlerrm like 'There''s no service published yet%', sqlerrm; end;
  begin perform public.api_send_test(ws, d, 'refund'); raise exception 'unknown kind';
  exception when others then assert sqlerrm like 'Choose a test booking, enquiry or order request.%', sqlerrm; end;
  t := public.api_send_test(ws, d, 'enquiry');
  assert (t ->> 'test')::boolean and t ->> 'kind' = 'enquiry' and t ->> 'status' = 'waiting', 'test sent: ' || t::text;
  j := public.api_status(ws, d);
  assert not (j ->> 'set_up')::boolean, 'a test alone isn''t "set up"';
  assert (j -> 'inbox' ->> 'waiting')::int = 1 and (j -> 'inbox' ->> 'test_waiting')::int = 1, 'the test waits';
  c := public.api_inbox_claim(ws, d, null, 20);
  assert json_array_length(c) = 1 and (c -> 0 ->> 'test')::boolean and c -> 0 ->> 'source' = 'test'
     and c -> 0 #>> '{payload,customer,name}' like 'Test Customer%', 'claimed as a test: ' || c::text;
  e := public.api_event_status(ws, d, (t ->> 'id')::uuid);
  assert e ->> 'status' = 'taken' and e ->> 'taken_by_pc' = 'SHOP-PC' and e ->> 'error' is null, 'event status: ' || e::text;
  perform public.api_inbox_done(ws, d, (t ->> 'id')::uuid, '{"state":"received","message":"Thanks (test)"}');
  assert public.api_event_status(ws, d, (t ->> 'id')::uuid) ->> 'status' = 'done', 'done';
  assert public.api_status(ws, d) -> 'sync_pc' ->> 'name' = 'SHOP-PC', 'the PC that took it';
  t := public.api_send_test(ws, d, 'order');
  assert t ->> 'kind' = 'enquiry', 'an order request is an enquiry with order_ metadata';
end $$;
reset role;
do $$ begin
  assert (select payload #>> '{metadata,order_sku}' from public.api_inbox where workspace_id = current_setting('api.ws_x')::uuid
          and payload ->> 'subject' = 'Test order request') = 'TEST-ITEM', 'order request with a placeholder item';
  assert (select count(*) from public.api_inbox where workspace_id = current_setting('api.ws_x')::uuid and (mode <> 'test' or key_id is not null)) = 0,
    'tests are always test mode with no key';
end $$;
set role authenticated;
-- a test booking in a business with a published service: one of its free times (or tomorrow), the service's length
select pg_temp.as_user('a9a9a9a2-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('api.ws')::uuid; d1 uuid := 'a9a9a9d1-0000-4000-8000-000000000001'; t json; i int; begin
  t := public.api_send_test(ws, d1, 'booking');
  assert t ->> 'kind' = 'booking', 'test booking: ' || t::text;
  for i in 1..19 loop perform public.api_send_test(ws, d1, 'enquiry'); end loop;
  begin perform public.api_send_test(ws, d1, 'enquiry'); raise exception '21 tests in an hour';
  exception when others then assert sqlerrm like 'That''s a lot of tests%', sqlerrm; end;
end $$;
reset role;
do $$ declare p jsonb; begin
  select payload into p from public.api_inbox where workspace_id = current_setting('api.ws')::uuid and mode = 'test' and kind = 'booking'
    and source = 'test' order by created_at desc limit 1;
  assert p ->> 'service' = 'CUT' and (p ->> 'end')::timestamptz - (p ->> 'start')::timestamptz = interval '60 minutes'
     and (p ->> 'start')::timestamptz > now(), 'test booking payload: ' || p::text;
end $$;

-- ===== Riyeser Estimate (module 'estimate'): its 90-day trial starts on first use, then US$20 a month (no bundle)
reset role;
do $$ declare w uuid; d uuid; s json; begin
  select workspace_id, id into w, d from public.devices order by linked_at nulls last limit 1;
  update public.workspaces set status = 'active' where id = w;
  delete from public.company_modules where workspace_id = w and module = 'estimate';
  s := public.module_state(w, 'estimate');
  assert (s ->> 'status') = 'trial' and (s ->> 'active')::boolean and (s ->> 'trial_ends') is null
    and (s ->> 'starts_on_first_use')::boolean and (s ->> 'days_left')::int = 90, format('not started yet: %s', s);
  assert (public.licence_json(w) -> 'modules' -> 'estimate' ->> 'status') = 'trial', 'Riyeser Central gets Estimate';
  assert public.module_label('estimate') = 'Riyeser Estimate', 'its name';
  update public.devices set programs = '[{"id": "central", "version": "2.0.0"}]' where id = d;
  assert not exists (select 1 from public.company_modules where workspace_id = w and module = 'estimate'), 'no trial without the program';
  update public.devices set programs = '[{"id": "central", "version": "2.0.0"}, {"id": "estimate", "version": "2.11.0"}]' where id = d;
  s := public.module_state(w, 'estimate');
  assert (s ->> 'trial_ends')::date = current_date + 90 and (s ->> 'days_left')::int = 90, format('first use starts 90 days: %s', s);
  update public.company_modules set trial_ends = current_date + 10 where workspace_id = w and module = 'estimate';
  update public.devices set programs = programs where id = d;     -- reported again later: the trial isn't restarted
  assert (public.module_state(w, 'estimate') ->> 'trial_ends')::date = current_date + 10, 'a running trial is never restarted';
  update public.company_modules set trial_ends = current_date - 1 where workspace_id = w and module = 'estimate';
  assert (public.module_state(w, 'estimate') ->> 'status') = 'ended', 'after the trial: ended (read-only on the PC)';
  assert public.riyeser_price('estimate') = 20, 'Riyeser Estimate: US$20 a month';
  delete from public.company_modules where workspace_id = w and module = 'estimate';
  perform set_config('test.est_ws', w::text, false);
  assert public.billing_mods(array['estimate', 'basic']) = array['basic', 'estimate'], 'billable, in the usual order';
  assert public.riyeser_bill(array['estimate'], 3, 0, 'monthly', false) = 20, 'Estimate alone, 3 users: US$20';
  assert public.riyeser_bill(array['estimate'], 5, 0, 'monthly', false) = 34, 'Estimate with 5 users: 20 + 2 x 7';
  assert public.riyeser_bill(array['estimate'], 3, 0, 'yearly', false) = 200, 'yearly: 10 months';
  assert public.riyeser_bill(array['estimate'], 3, 0, 'monthly', true) = 10, 'early bird: half';
  assert public.riyeser_bill(array['basic', 'pos', 'calls', 'estimate'], 3, 0, 'monthly', false) = 79, 'Shop bundle (59) + Estimate (20)';
  assert public.riyeser_plan(array['basic', 'pos', 'calls', 'estimate'], 3, null, 1, 0, 'monthly', false) ->> 'bundle' = 'shop', 'the bundle stays Shop';
  assert not exists (select 1 from public.riyeser_bundles() b where 'estimate' = any (b.mods)), 'not in any bundle';
  begin insert into public.company_modules (workspace_id, module) values (w, 'nope'); raise exception 'unknown program allowed';
  exception when check_violation then null; end;
end $$;
set role authenticated;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ begin
  -- HQ Licences: a business that hasn't used Estimate yet isn't counted as on its trial
  assert not exists (select 1 from json_array_elements(public.hq_licence_businesses('estimate', 'trial')) x
                     where x ->> 'id' = current_setting('test.est_ws')), 'not started: not listed on trial';
  assert exists (select 1 from json_array_elements(public.hq_licences() -> 'modules') x where x ->> 'module' = 'estimate'), 'Estimate has a row';
end $$;
-- ===== Ring groups with chosen members: only the chosen ring; skipped statuses; order and rotate; what happens if
-- nobody answers; numbers don't clash; the upgrade keeps the branch's people and asks once; other businesses can't see.
reset role;
insert into auth.users (id, email) values ('a3a3a3a3-1111-4000-8000-000000000001', 'ana@rg.test'), ('a3a3a3a3-1111-4000-8000-000000000002', 'sam@rg.test'),
  ('a3a3a3a3-1111-4000-8000-000000000003', 'tom@rg.test'), ('a3a3a3a3-1111-4000-8000-000000000004', 'una@rg.test'),
  ('a3a3a3a3-1111-4000-8000-000000000005', 'vic@rg.test'), ('a3a3a3a3-1111-4000-8000-000000000009', 'owner@rg2.test');
set role authenticated;
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
select public.create_team('Ring Test Co', 'Ana') as rg_ws \gset
select set_config('test.rg_ws', :'rg_ws', false);
select invite_code as rg_code from public.workspaces where id = :'rg_ws' \gset
select code as rg_hcode from public.branches where workspace_id = :'rg_ws' and name = 'Head office' \gset
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000002'); select public.join_team(:'rg_hcode', 'Sam');
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000003'); select public.join_team(:'rg_hcode', 'Tom');
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000004'); select public.join_team(:'rg_hcode', 'Una');
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000005'); select public.join_team(:'rg_code', 'Vic');
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid; g json; begin
  select id into h from public.ring_groups where workspace_id = ws and branch_id is not null;
  assert h is not null, 'Head office has its own ring group';
  assert (select count(*) from public.branch_members bm join public.branches b on b.id = bm.branch_id where b.workspace_id = ws) = 4, 'four people in Head office';
  assert (select count(*) from public.ring_group_members where group_id = h) = 0, 'a new branch''s number has nobody chosen (not everyone in the branch)';
  assert not (select needs_review from public.ring_groups where id = h), 'a new branch isn''t "check these" (nothing was there before)';
  g := public.ring_group_plan(ws, h);
  assert json_array_length(g -> 'ring') = 0, 'nobody chosen: nobody rings';
  assert g ->> 'fallback' = 'missed', 'and it ends as a missed call';
  perform set_config('test.rg_h', h::text, false);
end $$;

-- the upgrade: a branch from before ring groups gets a group with the people who were in it, marked "check these"
reset role;
select public.ring_groups_upgrade() as rg_none \gset
do $$ begin assert current_setting('test.rg_h') is not null; end $$;
delete from public.ring_groups where id = current_setting('test.rg_h')::uuid;
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid; begin
  assert public.ring_groups_upgrade() = 4, 'the upgrade puts the 4 people in the branch into its group';
  assert public.ring_groups_upgrade() = 0, 'running it again changes nothing';
  select id into h from public.ring_groups where workspace_id = ws and branch_id is not null;
  assert (select needs_review from public.ring_groups where id = h), 'upgraded groups ask "Choose who answers each branch number"';
  assert (select extension from public.ring_groups where id = h) = 100, 'the branch''s number';
  perform set_config('test.rg_h', h::text, false);
end $$;
set role authenticated;
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; g json; begin
  g := public.ring_group_plan(ws, h);
  assert json_array_length(g -> 'ring') = 3, 'after the upgrade everyone else in the branch still rings (not the caller)';
  assert public.ring_groups_confirm(ws) = 1, 'These are right: confirmed';
  assert not (select needs_review from public.ring_groups where id = h), 'the notice goes away';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'ring_group.confirm'), 'in the change history';
end $$;

-- choose who answers: only Sam and Una (Tom is in the branch but not chosen), in order
select set_config('test.u_sam', 'a3a3a3a3-1111-4000-8000-000000000002', false), set_config('test.u_tom', 'a3a3a3a3-1111-4000-8000-000000000003', false),
  set_config('test.u_una', 'a3a3a3a3-1111-4000-8000-000000000004', false), set_config('test.u_vic', 'a3a3a3a3-1111-4000-8000-000000000005', false);
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; g json;
  sam uuid := current_setting('test.u_sam'); tom uuid := current_setting('test.u_tom'); una uuid := current_setting('test.u_una'); begin
  perform public.ring_group_save(ws, h, jsonb_build_object('strategy', 'order', 'ring_seconds', 10, 'timeout_seconds', 40),
    jsonb_build_array(jsonb_build_object('user_id', una), jsonb_build_object('user_id', sam), jsonb_build_object('phone_ext', '150', 'phone_name', 'Reception')));
  g := public.ring_group_plan(ws, h);
  assert (g -> 'ring') ->> 0 = una::text and (g -> 'ring') ->> 1 = sam::text and json_array_length(g -> 'ring') = 2, 'only the chosen, in the chosen order';
  assert g ->> 'strategy' = 'order' and (g ->> 'ring_seconds')::int = 10 and (g ->> 'timeout_seconds')::int = 40, 'ring in order, 10 s each, 40 s in all';
  assert (g -> 'phones') -> 0 ->> 'extension' = '150', 'the shared desk phone (Reception) is in it for Riyeser Link Office';
  assert not exists (select 1 from json_array_elements_text(g -> 'ring') x where x = tom::text), 'Tom (in the branch, not chosen) doesn''t ring';
  assert (select name from public.branches where id = (select branch_id from public.ring_groups where id = h)) = 'Head office', 'the branch keeps its people';
  assert (select count(*) from public.branch_members bm where bm.branch_id = (select branch_id from public.ring_groups where id = h)) = 4, '…all four of them';
  assert json_array_length((select (x -> 'members') from json_array_elements(public.ring_groups_list(ws)) x where x ->> 'id' = h::text)) = 3, 'the list shows 3 members';
  -- a desk phone can't be a person's number or a group's number
  begin perform public.ring_group_save(ws, h, '{}', jsonb_build_array(jsonb_build_object('phone_ext', (select extension::text from public.members where workspace_id = ws and user_id = tom))));
    raise exception 'a person''s number as a desk phone'; exception when raise_exception then if sqlerrm not like '%belongs to a person%' then raise; end if; end;
  begin perform public.ring_group_save(ws, h, '{}', jsonb_build_array(jsonb_build_object('user_id', 'a3a3a3a3-1111-4000-8000-000000000009')));
    raise exception 'someone from outside'; exception when raise_exception then if sqlerrm not like '%from your business%' then raise; end if; end;
  begin perform public.ring_group_save(ws, h, '{"fallback":"voicemail"}', '[]'); raise exception 'voicemail allowed';
    exception when raise_exception then if sqlerrm not like '%Voicemail is coming%' then raise; end if; end;
end $$;

-- the call itself: a group ring reaches only the chosen; a direct call to Tom still works
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; c uuid := gen_random_uuid(); begin
  insert into public.call_signals (workspace_id, call_id, to_user, kind, payload) values (ws, c, current_setting('test.u_sam')::uuid, 'ring', jsonb_build_object('group', h));
  begin
    insert into public.call_signals (workspace_id, call_id, to_user, kind, payload) values (ws, c, current_setting('test.u_tom')::uuid, 'ring', jsonb_build_object('group', h));
    raise exception 'Tom rang for a group he isn''t chosen for';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.call_signals (workspace_id, call_id, to_user, kind, payload) values (ws, c, current_setting('test.u_tom')::uuid, 'ring', jsonb_build_object('group', 'not-a-group'));
    raise exception 'a made-up group rang';
  exception when insufficient_privilege then null; end;
  insert into public.call_signals (workspace_id, call_id, to_user, kind, payload) values (ws, gen_random_uuid(), current_setting('test.u_tom')::uuid, 'ring', '{"from_name":"Ana"}');
  insert into public.call_signals (workspace_id, call_id, to_user, kind) values (ws, c, current_setting('test.u_tom')::uuid, 'taken');   -- other signals aren't limited
end $$;

-- Do not disturb, Busy, At lunch, Unavailable and On a call are skipped
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000004');
select public.link_status_set(:'rg_ws', 'dnd', 'dnd', null, false, null);
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000002');
select public.link_status_set(:'rg_ws', 'available', null, null, true, null);
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; g json; begin
  g := public.ring_group_plan(ws, h);
  assert json_array_length(g -> 'ring') = 0, 'Una on Do not disturb and Sam on a call: nobody rings';
  assert exists (select 1 from json_array_elements(g -> 'skipped') x where x ->> 'user_id' = current_setting('test.u_una') and x ->> 'why' = 'dnd'), 'Una skipped: Do not disturb';
  assert exists (select 1 from json_array_elements(g -> 'skipped') x where x ->> 'user_id' = current_setting('test.u_sam') and x ->> 'why' = 'on_call'), 'Sam skipped: on a call';
  begin
    insert into public.call_signals (workspace_id, call_id, to_user, kind, payload) values (ws, gen_random_uuid(), current_setting('test.u_una')::uuid, 'ring', jsonb_build_object('group', h));
    raise exception 'Do not disturb rang for a group';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000004'); select public.link_status_set(:'rg_ws', 'lunch', 'lunch', null, false, null);
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000002'); select public.link_status_set(:'rg_ws', 'unavailable', 'unavailable', null, false, null);
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
do $$ declare g json := public.ring_group_plan(current_setting('test.rg_ws')::uuid, current_setting('test.rg_h')::uuid); begin
  assert (select string_agg(x ->> 'why', ',' order by x ->> 'why') from json_array_elements(g -> 'skipped') x) = 'lunch,unavailable', 'At lunch and Unavailable skipped';
end $$;
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000004'); select public.link_status_set(:'rg_ws', 'busy', 'busy', null, false, now() - interval '30 seconds');
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000002'); select public.link_status_set(:'rg_ws', 'available', null, null, false, null);
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000001');
do $$ declare g json := public.ring_group_plan(current_setting('test.rg_ws')::uuid, current_setting('test.rg_h')::uuid); begin
  assert json_array_length(g -> 'ring') = 2, 'Busy whose "until" has passed and Available both ring again';
end $$;

-- Rotate: the next person goes first each time
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; firsts text := '';
  sam uuid := current_setting('test.u_sam'); tom uuid := current_setting('test.u_tom'); una uuid := current_setting('test.u_una'); begin
  perform public.ring_group_save(ws, h, '{"strategy":"rotate"}', jsonb_build_array(jsonb_build_object('user_id', sam), jsonb_build_object('user_id', tom), jsonb_build_object('user_id', una)));
  for i in 1..4 loop firsts := firsts || ((public.ring_group_plan(ws, h) -> 'ring') ->> 0) || ' '; end loop;
  assert firsts = format('%s %s %s %s ', sam, tom, una, sam), 'rotate: Sam, Tom, Una, then Sam again (' || firsts || ')';
  assert json_array_length(public.ring_group_plan(ws, h) -> 'ring') = 3, 'rotate still rings everyone chosen, just starting further on';
end $$;

-- extra groups with their own number; numbers never clash
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; h uuid := current_setting('test.rg_h')::uuid; s uuid; r uuid; g json; tomx int; b uuid; begin
  select extension into tomx from public.members where workspace_id = ws and user_id = current_setting('test.u_tom')::uuid;
  begin perform public.ring_group_save(ws, null, jsonb_build_object('name', 'Sales', 'extension', tomx::text), '[]'); raise exception 'took Tom''s number';
    exception when raise_exception then if sqlerrm not like '%already used%' then raise; end if; end;
  begin perform public.ring_group_save(ws, null, '{"name":"Sales","extension":"100"}', '[]'); raise exception 'took the branch''s number';
    exception when raise_exception then if sqlerrm not like '%already used%' then raise; end if; end;
  begin perform public.ring_group_save(ws, null, '{"name":"Sales","extension":"2000"}', '[]'); raise exception 'four digits';
    exception when raise_exception then if sqlerrm not like '%3 digits%' then raise; end if; end;
  begin perform public.ring_group_save(ws, null, '{"name":"","extension":"300"}', '[]'); raise exception 'no name';
    exception when raise_exception then if sqlerrm not like '%name%' then raise; end if; end;
  s := public.ring_group_save(ws, null, '{"name":"Sales","extension":"300"}', jsonb_build_array(jsonb_build_object('user_id', current_setting('test.u_vic'))));
  begin perform public.ring_group_save(ws, null, '{"name":"Reception","extension":"300"}', '[]'); raise exception 'two groups on 300';
    exception when raise_exception then if sqlerrm not like '%already used%' then raise; end if; end;
  r := public.ring_group_save(ws, null, '{"name":"Reception","extension":"301"}', '[]');
  begin perform public.set_extension(ws, current_setting('test.u_tom')::uuid, 300); raise exception 'a person on a group''s number';
    exception when raise_exception then if sqlerrm not like '%already used%' then raise; end if; end;
  assert public.ring_group_save(ws, s, '{"name":"Sales team","extension":"300"}', '[]') = s, 'a group keeps its own number when saved again';
  b := public.create_branch(ws, 'Shop 2');
  assert (select extension from public.branches where id = b) = 200, 'a new branch gets 200';
  b := public.create_branch(ws, 'Shop 3');
  assert (select extension from public.branches where id = b) = 400, 'the next branch skips 300 (Sales)';
  assert (select count(*) from public.ring_group_members rm join public.ring_groups g2 on g2.id = rm.group_id where g2.branch_id = b) = 0, 'new branch: nobody chosen';
  -- if nobody answers: another group, or one person; never itself
  perform public.ring_group_save(ws, h, jsonb_build_object('strategy', 'all', 'fallback', 'group', 'fallback_group', s), '[]');
  g := public.ring_group_plan(ws, h);
  assert g ->> 'fallback' = 'group' and g ->> 'fallback_group' = s::text, 'nobody chosen at Head office: on to Sales';
  begin perform public.ring_group_save(ws, h, jsonb_build_object('fallback', 'group', 'fallback_group', h), '[]'); raise exception 'falls back to itself';
    exception when raise_exception then if sqlerrm not like '%another group%' then raise; end if; end;
  perform public.ring_group_save(ws, r, jsonb_build_object('name', 'Reception', 'extension', '301', 'fallback', 'person', 'fallback_user', current_setting('test.u_tom')), '[]');
  assert public.link_group_rings(ws, r::text, current_setting('test.u_tom')::uuid), 'the person it falls back to can be rung for the group';
  assert not public.link_group_rings(ws, r::text, current_setting('test.u_una')::uuid), 'nobody else can';
  -- a branch's own group can't be removed; an extra one can, and whatever fell back to it ends as missed
  begin perform public.ring_group_delete(ws, h); raise exception 'removed a branch number'; exception when raise_exception then if sqlerrm not like '%branch%' then raise; end if; end;
  perform public.ring_group_delete(ws, s);
  assert (select fallback from public.ring_groups where id = h) = 'missed', 'falling back to a removed group: missed';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'ring_group.delete'), 'removing is in the history';
  perform set_config('test.rg_r', r::text, false);
end $$;

-- only owners and admins with two-step sign-in change groups; nobody writes the tables directly
select pg_temp.as_user_password_only('a3a3a3a3-1111-4000-8000-000000000001');
do $$ begin perform public.ring_group_save(current_setting('test.rg_ws')::uuid, null, '{"name":"X","extension":"500"}', '[]'); raise exception 'aal1 admin saved';
  exception when raise_exception then if sqlerrm not like '%two-step%' then raise; end if; end $$;
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000003');
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; begin
  begin perform public.ring_group_save(ws, current_setting('test.rg_h')::uuid, '{}', '[]'); raise exception 'staff saved';
    exception when raise_exception then if sqlerrm not like '%owner or an admin%' then raise; end if; end;
  begin perform public.ring_groups_confirm(ws); raise exception 'staff confirmed'; exception when raise_exception then if sqlerrm not like '%owner or an admin%' then raise; end if; end;
  begin insert into public.ring_group_members (group_id, user_id) values (current_setting('test.rg_h')::uuid, auth.uid()); raise exception 'staff added themselves';
    exception when insufficient_privilege then null; end;
  begin update public.ring_groups set strategy = 'all' where workspace_id = ws; raise exception 'staff changed a group';
    exception when insufficient_privilege then null; end;
  assert json_array_length(public.ring_groups_list(ws)) = 4, 'staff can see the groups (to call them)';
  assert (public.ring_group_plan(ws, current_setting('test.rg_h')::uuid) ->> 'name') = 'Head office', 'and call them';
end $$;

-- another business sees and changes nothing
select pg_temp.as_user('a3a3a3a3-1111-4000-8000-000000000009');
select public.create_team('Other Rings Ltd', 'Olga') as rg_ws2 \gset
select set_config('test.rg_ws2', :'rg_ws2', false);
do $$ declare ws uuid := current_setting('test.rg_ws')::uuid; begin
  assert json_array_length(public.ring_groups_list(ws)) = 0, 'another business lists none of them';
  assert (select count(*) from public.ring_groups) = 1, 'and reads only its own (Head office)';
  assert (select count(*) from public.ring_group_members) = 0, 'and none of the members';
  begin perform public.ring_group_plan(ws, current_setting('test.rg_h')::uuid); raise exception 'planned another business''s call';
    exception when raise_exception then if sqlerrm not like '%not in that company%' then raise; end if; end;
  begin perform public.ring_group_save(ws, current_setting('test.rg_h')::uuid, '{}', '[]'); raise exception 'changed another business';
    exception when raise_exception then if sqlerrm not like '%owner or an admin%' then raise; end if; end;
  begin perform public.ring_group_plan(current_setting('test.rg_ws2')::uuid, current_setting('test.rg_h')::uuid); raise exception 'used A''s group from B';
    exception when raise_exception then if sqlerrm not like '%isn''t there%' then raise; end if; end;
end $$;

-- someone who leaves the business leaves its groups
reset role;
delete from public.members where workspace_id = current_setting('test.rg_ws')::uuid and user_id = current_setting('test.u_tom')::uuid;
do $$ begin
  assert not exists (select 1 from public.ring_group_members where user_id = current_setting('test.u_tom')::uuid), 'Tom is out of every group';
  assert (select fallback from public.ring_groups where id = current_setting('test.rg_r')::uuid) = 'missed', 'a group that fell back to Tom ends as missed';
end $$;
set role authenticated;

-- ===== The Riyeser relay: registering relays, passes for Link Office, revoking, TURN, phones at home, the relay's own sync
reset role;
insert into auth.users values ('d0d0d0d0-0000-4000-8000-000000000001', 'boss@relay.test'), ('d0d0d0d0-0000-4000-8000-000000000002', 'staff@relay.test'),
  ('d0d0d0d0-0000-4000-8000-000000000003', 'nadipc@relay.test'), ('d0d0d0d0-0000-4000-8000-000000000004', 'other@relay.test');
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
select (public.create_company('Relay Plumbing', 'Ana', '{"country":"Fiji"}'::jsonb) ->> 'workspace_id') as ws_r \gset
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000004');
select (public.create_company('Other Cafe', 'Oli', '{"country":"Fiji"}'::jsonb) ->> 'workspace_id') as ws_o \gset
select set_config('test.ws_r', :'ws_r', false), set_config('test.ws_o', :'ws_o', false);
reset role;
insert into public.members (workspace_id, user_id, display_name, role, extension) values (:'ws_r', 'd0d0d0d0-0000-4000-8000-000000000002', 'Sam Staff', 'member', 102),
  (:'ws_r', 'd0d0d0d0-0000-4000-8000-000000000003', 'Nadi PC', 'member', 201);
insert into public.devices (id, workspace_id, user_id, device_name) values (gen_random_uuid(), :'ws_r', 'd0d0d0d0-0000-4000-8000-000000000003', 'NADI-PC');
-- apps can't register relays or read the secret; only the SQL editor (here: the database owner) can
set role authenticated;
do $$ begin
  begin perform public.relay_register('evil', 'evil.example', 'X', 'x'); raise exception 'app registered a relay';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.relay_cluster; raise exception 'app read the relay secret';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.relay_servers; raise exception 'app read the relays';
  exception when insufficient_privilege then null; end;
  begin perform public.relay_key('office-token'); raise exception 'app made a relay key';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.relay_register('syd1', 'relay.riyeser.test', 'Suva head office', 'test-relay-secret-0123456789abcdef0123456789');
select public.relay_register('mel1', 'backup.riyeser.test', 'Sydney', 'test-relay-secret-0123456789abcdef0123456789', 2);
do $$ begin
  begin perform public.relay_register('bad1', 'bad.riyeser.test', 'X', 'a-completely-different-secret-0123456789abc'); raise exception 'a second secret was accepted';
  exception when others then assert sqlerrm like 'This relay''s secret is different%', sqlerrm; end;
  -- the same pass the relay's own test checks (relay/test/relay.test.js): the two sides make it the same way
  assert public.relay_sign(public.relay_key('office-token'), jsonb_build_object('v', 1, 'r', 'syd1', 'ws', 'aaaaaaaa-0000-4000-8000-000000000001', 'o', 'lo-suva-0001', 'g', 1, 'exp', 4102444800))
    = 'eyJnIjogMSwgIm8iOiAibG8tc3V2YS0wMDAxIiwgInIiOiAic3lkMSIsICJ2IjogMSwgIndzIjogImFhYWFhYWFhLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsICJleHAiOiA0MTAyNDQ0ODAwfQ.nhcgHsepBLiMXHM75t5YocDIXmtRETfbZyQ9Y3In-eo', format('the pass made here: %s', public.relay_sign(public.relay_key('office-token'), jsonb_build_object('v', 1, 'r', 'syd1', 'ws', 'aaaaaaaa-0000-4000-8000-000000000001', 'o', 'lo-suva-0001', 'g', 1, 'exp', 4102444800)));
  assert public.relay_turn_secret() = encode(hmac('turn', 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), 'coturn/relay TURN secret';
end $$;
-- the Nadi PC reports (as before); the relay is still off, so no pass
select pg_temp.as_user_password_only('d0d0d0d0-0000-4000-8000-000000000003'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  perform public.link_office_report(ws, 'lo-nadi-0002', '{"pc_name":"NADI-PC","version":"1.3.0","addresses":["192.168.1.20"],"sip_port":5060}');
  perform public.link_office_report(ws, 'lo-suva-0001', '{"pc_name":"SUVA-PC","version":"1.3.0","addresses":["192.168.1.20"],"sip_port":5060}');
  assert not (public.link_relay_config(ws) ->> 'enabled')::boolean, 'off until switched on';
  assert jsonb_array_length(public.link_relay_config(ws) -> 'relays') = 2, 'both relays listed';
  assert (public.link_relay_config(ws) -> 'relays' -> 0 ->> 'id') = 'syd1', 'main relay first';
  begin perform public.link_relay_token(ws, 'lo-nadi-0002'); raise exception 'pass while off';
  exception when others then assert sqlerrm like 'The Riyeser relay is switched off%', sqlerrm; end;
  begin perform public.link_relay_set(ws, true); raise exception 'a member switched the relay on';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  assert (public.link_relay_set(ws, true) ->> 'enabled')::boolean, 'owner switched it on';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_on'), 'in the history';
end $$;
-- passes for each relay (6 hours), for the linked PC; never for someone outside the business
select pg_temp.as_user_password_only('d0d0d0d0-0000-4000-8000-000000000003');
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; t jsonb; body text; p jsonb; begin
  t := public.link_relay_token(ws, 'lo-nadi-0002');
  assert t -> 'tokens' ? 'syd1' and t -> 'tokens' ? 'mel1', format('a pass per relay: %s', t);
  body := split_part(t -> 'tokens' ->> 'syd1', '.', 1);
  p := convert_from(decode(translate(body, '-_', '+/') || repeat('=', (4 - length(body) % 4) % 4), 'base64'), 'utf8')::jsonb;
  assert p ->> 'r' = 'syd1' and p ->> 'o' = 'lo-nadi-0002' and p ->> 'ws' = ws::text and (p ->> 'g')::int = 1, format('pass: %s', p);
  assert (p ->> 'exp')::bigint between extract(epoch from now()) + 6 * 3600 - 5 and extract(epoch from now()) + 6 * 3600 + 5, '6 hours';
  begin perform public.link_relay_token(ws, 'lo-nobody-999'); raise exception 'pass for an unknown office';
  exception when others then assert sqlerrm like 'This Riyeser Link Office hasn''t been in touch%', sqlerrm; end;
  perform public.link_relay_report(ws, 'lo-nadi-0002', '{"state":"connected","relay":"syd1","region":"Suva head office","rtt_ms":42,"backup":false,"udp":"ok","extra":"dropped"}');
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000002');
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  begin perform public.link_relay_token(ws, 'lo-nadi-0002'); raise exception 'plain member got a pass';
  exception when others then assert sqlerrm like 'Sign in as the business''s owner%', sqlerrm; end;
  -- members see the sites and how they're connected
  assert (public.link_relay_status(ws) -> 'offices' -> 0 -> 'relay' ->> 'rtt_ms') = '42', format('status: %s', public.link_relay_status(ws));
  assert (public.link_relay_status(ws) -> 'offices' -> 0 -> 'relay') ->> 'extra' is null, 'only the listed fields';
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000004');
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  begin perform public.link_relay_token(ws, 'lo-nadi-0002'); raise exception 'another business got a pass';
  exception when others then assert sqlerrm like 'Sign in as the business''s owner%', sqlerrm; end;
  begin perform public.link_relay_config(ws); raise exception 'another business read the config';
  exception when others then assert sqlerrm like 'You''re not in this business%', sqlerrm; end;
  begin perform public.link_relay_turn(ws); raise exception 'another business got TURN';
  exception when others then assert sqlerrm like 'You''re not in this business%', sqlerrm; end;
  begin perform public.link_relay_revoke(ws, 'lo-nadi-0002'); raise exception 'another business revoked';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- the relay's own sync: a wrong signature is refused; the right one gets only businesses with the relay on
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); r jsonb; b jsonb; begin
  begin perform public.relay_sync('syd1', ts, 'deadbeef', '{}'); raise exception 'unsigned sync';
  exception when others then assert sqlerrm like 'Not a relay of Riyeser''s%', sqlerrm; end;
  begin perform public.relay_sync('syd1', ts - 900, encode(hmac(('syd1|' || (ts - 900))::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{}'); raise exception 'old sync';
  exception when others then assert sqlerrm like 'Not a relay of Riyeser''s%', sqlerrm; end;
  r := public.relay_sync('syd1', ts, encode(hmac(('syd1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'),
    jsonb_build_object('version', '1.0.0', 'public_ip', '203.0.113.7', 'cert', jsonb_build_object('sha256', repeat('AB:', 31) || 'AB', 'self_signed', true),
      'ports', jsonb_build_object('turn', 3478, 'sip_tls', 5061), 'offices', jsonb_build_array(jsonb_build_object('ws', current_setting('test.ws_r'), 'office', 'lo-nadi-0002', 'since', '2026-11-27T01:00:00Z'))));
  assert jsonb_array_length(r -> 'businesses') = 1, format('only Relay Plumbing: %s', r);
  b := r -> 'businesses' -> 0;
  assert b ->> 'ws' = current_setting('test.ws_r') and jsonb_array_length(b -> 'offices') = 2, format('its offices: %s', b);
  assert (r -> 'relays' -> 0 ->> 'id') = 'mel1' and (r -> 'relays' -> 0 ->> 'url') = 'wss://backup.riyeser.test/relay/v1', 'the other relays of the cluster';
  assert exists (select 1 from jsonb_array_elements(b -> 'groups') g where g ->> 'ext' = '100'), format('ring groups: %s', b -> 'groups');
end $$;
reset role;
do $$ begin
  assert (select public_ip from public.relay_servers where id = 'syd1') = '203.0.113.7', 'the relay''s address is kept';
  assert (select self_signed and cert_sha256 like 'AB:%' from public.relay_servers where id = 'syd1'), 'and its certificate';
  assert (select relay_seen ->> 'relay' from public.link_offices where office_id = 'lo-nadi-0002') = 'syd1', 'which relay the office is on';
end $$;
-- revoking: the generation moves on (old passes stop matching); no pass while revoked; allowed again with a new generation
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  perform public.link_relay_revoke(ws, 'lo-nadi-0002');
  assert (public.link_relay_status(ws) -> 'offices' -> 0 ->> 'revoked')::boolean, 'shows as disconnected';
  assert (public.link_relay_config(ws) -> 'relays' -> 0 ->> 'pin') = repeat('AB:', 31) || 'AB', 'a self-signed relay''s certificate is pinned';
end $$;
select pg_temp.as_user_password_only('d0d0d0d0-0000-4000-8000-000000000003');
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; begin
  begin perform public.link_relay_token(ws, 'lo-nadi-0002'); raise exception 'pass while revoked';
  exception when others then assert sqlerrm like 'This office has been disconnected%', sqlerrm; end;
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001');
select public.link_relay_revoke(:'ws_r', 'lo-nadi-0002', true);
reset role;
do $$ begin
  assert (select relay_gen from public.link_offices where office_id = 'lo-nadi-0002') = 3, 'revoked and allowed: generation 3';
  assert exists (select 1 from public.audit_log where action = 'link.relay_office_revoked') and exists (select 1 from public.audit_log where action = 'link.relay_office_allowed'), 'both in the history';
end $$;
-- TURN for browser and app calls: 12 hours, the TURN REST API kind (what the relay's TURN server checks)
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000002'); set role authenticated;
do $$ declare t jsonb; s jsonb; begin
  t := public.link_relay_turn(current_setting('test.ws_r')::uuid);
  s := t -> 'ice_servers' -> 0;
  assert jsonb_array_length(t -> 'ice_servers') = 1, format('only relays that report a TURN port: %s', t);
  assert split_part(s ->> 'username', ':', 2) = replace('d0d0d0d0-0000-4000-8000-000000000002', '-', ''), 'username has who it is for';
  assert (split_part(s ->> 'username', ':', 1))::bigint between extract(epoch from now()) + 43190 and extract(epoch from now()) + 43210, '12 hours';
  assert s ->> 'credential' = encode(hmac(s ->> 'username', encode(hmac('turn', 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), 'sha1'), 'base64'), 'password = HMAC-SHA1(turn secret, username)';
  assert (s -> 'urls')::text like '%turn:relay.riyeser.test:3478?transport=udp%' and (s -> 'urls')::text like '%turn:203.0.113.7:3478%', format('urls: %s', s -> 'urls');
  assert (s -> 'urls')::text not like '%turns:%', 'no TURN over TLS with a self-signed certificate (browsers wouldn''t trust it)';
  assert (s -> 'urls')::text not like '%google%', 'nothing outside';
end $$;
-- phones at home: a member for their own extension, an admin for anyone; the password is shown once and never kept
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; d jsonb; begin
  d := public.link_relay_device_add(ws, '102', 'Sam''s mobile');
  assert d ->> 'username' ~ '^r[a-z0-9]{10}$' and length(d ->> 'password') = 20 and d ->> 'server' = 'relay.riyeser.test' and (d ->> 'port')::int = 5061, format('details: %s', d - 'password');
  assert d ->> 'prov_url' like 'https://relay.riyeser.test/prov/%', 'a one-time set-up link';
  perform set_config('test.dev_pw', d ->> 'password', false); perform set_config('test.dev_user', d ->> 'username', false); perform set_config('test.dev_id', d ->> 'id', false);
  begin perform public.link_relay_device_add(ws, '201', 'Not mine'); raise exception 'member set up someone else''s phone';
  exception when others then assert sqlerrm like 'Only an owner or admin%', sqlerrm; end;
  assert jsonb_array_length(public.link_relay_status(ws) -> 'devices') = 1, 'sees their own phone';
  assert public.link_relay_status(ws)::text not like '%' || current_setting('test.dev_pw') || '%', 'never the password again';
end $$;
reset role;
do $$ begin
  assert (select ha1 from public.link_relay_devices where username = current_setting('test.dev_user')) = md5(current_setting('test.dev_user') || ':riyeser-relay:' || current_setting('test.dev_pw')), 'only the HA1 is kept';
  assert not exists (select 1 from public.link_relay_devices d where to_jsonb(d)::text like '%' || current_setting('test.dev_pw') || '%'), 'no password stored';
  assert not exists (select 1 from public.audit_log a where a.details::text like '%' || current_setting('test.dev_pw') || '%'), 'no password in the history';
  assert exists (select 1 from public.audit_log where action = 'link.relay_phone_added' and details ->> 'extension' = '102'), 'in the history';
end $$;
-- the relay gets the phone (HA1, for SIP digest); another business's owner can't add or remove it
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); r jsonb; begin
  r := public.relay_sync('mel1', ts, encode(hmac(('mel1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), jsonb_build_object('phones', jsonb_build_array(current_setting('test.dev_user'))));
  assert (r -> 'businesses' -> 0 -> 'devices' -> 0 ->> 'user') = current_setting('test.dev_user') and (r -> 'businesses' -> 0 -> 'devices' -> 0 ->> 'ext') = '102', format('device: %s', r -> 'businesses' -> 0 -> 'devices');
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000004'); set role authenticated;
do $$ begin
  begin perform public.link_relay_device_add(current_setting('test.ws_r')::uuid, '102', 'x'); raise exception 'another business added a phone';
  exception when others then assert sqlerrm like 'Only an owner or admin%', sqlerrm; end;
  begin perform public.link_relay_device_remove(current_setting('test.ws_r')::uuid, current_setting('test.dev_id')::uuid); raise exception 'another business removed a phone';
  exception when others then assert sqlerrm like 'Only an owner or admin%', sqlerrm; end;
end $$;
-- a relay just for one business (its own machine) never sees anyone else's
reset role;
select public.relay_register('own1', 'pbx.othercafe.test', 'Other Cafe office', 'test-relay-secret-0123456789abcdef0123456789', 1, :'ws_o');
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); r jsonb; begin
  r := public.relay_sync('own1', ts, encode(hmac(('own1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{}');
  assert jsonb_array_length(r -> 'businesses') = 0, format('Other Cafe has the relay off, and Relay Plumbing isn''t its business: %s', r -> 'businesses');
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.link_relay_config(current_setting('test.ws_r')::uuid) -> 'relays') x where x ->> 'id' = 'own1'), 'another business''s own relay isn''t offered';
  perform public.link_relay_device_remove(current_setting('test.ws_r')::uuid, current_setting('test.dev_id')::uuid);
  assert jsonb_array_length(public.link_relay_status(current_setting('test.ws_r')::uuid) -> 'devices') = 0, 'removed';
  -- switching the relay off: no more passes, and the relay's plan no longer has the business
  perform public.link_relay_set(current_setting('test.ws_r')::uuid, false);
end $$;
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); begin
  assert jsonb_array_length(public.relay_sync('syd1', ts, encode(hmac(('syd1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{}') -> 'businesses') = 0, 'switched off: not in the plan';
end $$;

select set_config('test.ws_a', :'ws_a', false);
-- ===== Real downloads and installs: only the download function (service role) records a download, anyone may send an
-- install note through track_install, only members link an install to their business, only HQ (downloads.view) reads them
reset role; set role anon; select pg_temp.as_user('');
do $$ begin
  begin perform public.record_download('central', 'riyeser-1', 'FJ', '/', repeat('a', 32), 'Chrome', true, false, false, false); raise exception 'anon recorded a download';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.download_events; raise exception 'anon read download_events';
  exception when insufficient_privilege then null; end;
  begin insert into public.install_events (install_id, kind) values (gen_random_uuid(), 'new'); raise exception 'anon inserted an install directly';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_real_downloads(30); raise exception 'anon read the counts';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_save_download_totals('{"a.exe": 1}'); raise exception 'anon saved totals';
  exception when insufficient_privilege then null; end;
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'new', '', array['central', 'pos', 'POS', 'bad id!'], '1.9.0', 'Windows 11', 'Fiji', false) = 'ok', 'a new install';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'new', '', array['central'], '1.9.0', 'Windows 11', 'Fiji', false) = 'already', 'sent twice: counted once';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'existing', '', array['central'], '1.9.0', 'Windows 11', 'Fiji', false) = 'already', 'new, then existing: still once';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'update', 'pos@1.4.2', '{}', '1.9.0', 'Windows 11', null, false) = 'ok', 'an update';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'update', 'pos@1.4.2', '{}', '1.9.0', 'Windows 11', null, false) = 'already', 'the same update twice';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000001', 'add', 'invoices', '{}', '1.9.0', 'Windows 11', null, false) = 'ok', 'a program added';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000002', 'existing', '', array['central'], '1.8.0', 'Windows 10', null, false) = 'ok', 'a PC that had Central before counting began';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000003', 'new', '', array['central'], '1.9.0', 'Windows 11', null, true) = 'ok', 'a test install (demo or CI)';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000004', 'update', 'not a program', '{}') = 'ignored', 'a bad update detail is ignored';
  assert public.track_install('0d0d0d0d-0000-4000-8000-000000000004', 'deleted', '', '{}') = 'ignored', 'an unknown kind is ignored';
  assert public.track_install(null, 'new', '', '{}') = 'ignored', 'no install id';
  begin perform public.install_link('0d0d0d0d-0000-4000-8000-000000000001', current_setting('test.ws_a')::uuid); raise exception 'anon linked an install';
  exception when insufficient_privilege then null; end;
end $$;
do $$ begin for i in 1..60 loop perform public.track_install('0d0d0d0d-0000-4000-8000-000000000005', 'add', 'p' || i, '{}'); end loop; end $$;
reset role;
do $$ begin
  assert (select count(*) from public.install_events where install_id = '0d0d0d0d-0000-4000-8000-000000000005') = 50, 'at most 50 notes an install a day';
  assert (select programs from public.install_events where install_id = '0d0d0d0d-0000-4000-8000-000000000001' and kind = 'new') = array['central', 'pos'], 'programs tidied';
  assert (select country from public.install_events where install_id = '0d0d0d0d-0000-4000-8000-000000000001' and kind = 'new') = 'Fiji', 'the business''s country';
  assert not exists (select 1 from information_schema.columns where table_name in ('download_events', 'install_events') and column_name ~ 'ip|agent|user|device|email'), 'no IP, browser details, user or device columns';
end $$;
delete from public.install_events where install_id = '0d0d0d0d-0000-4000-8000-000000000005';
-- the download function's calls (as the service role)
set role service_role;
do $$ begin
  assert public.record_download('central', 'riyeser-2026.11.27-60', 'fj', '/programs/central.html', repeat('a1', 16), 'Chrome', true, false, false, false) = 'ok', 'a download';
  assert public.record_download('central', 'riyeser-2026.11.27-60', 'FJ', '/downloads', repeat('a1', 16), 'Chrome', true, false, false, false) = 'ok', 'the same person again (kept, counted once)';
  assert public.record_download('pos', 'riyeser-2026.11.27-60', 'AU', 'www.Google.com', repeat('b2', 16), 'Safari', true, false, false, false) = 'ok', 'another person, from Google';
  assert public.record_download('pos', 'riyeser-2026.11.27-60', 'XX', 'riyeser.com', repeat('c3', 16), 'Other', false, true, false, false) = 'ok', 'a robot';
  assert public.record_download('pos', 'bad tag <x>', null, 'https://evil.test/a', repeat('d4', 16), 'Netscape', true, false, true, false) = 'ok', 'a test';
  assert public.record_download('central', null, null, '/wp-admin', repeat('e5', 16), null, true, false, false, true) = 'ok', 'staff';
  assert public.record_download('Not A Program!', null, null, null, repeat('f6', 16), null, true, false, false, false) = 'ignored', 'a bad program';
  assert public.record_download('central', null, null, null, 'raw 1.2.3.4', null, true, false, false, false) = 'ignored', 'never a raw address';
  for i in 1..40 loop perform public.record_download('central', null, null, null, repeat('99', 16), null, true, false, false, false); end loop;
  begin perform public.hq_real_downloads(30); raise exception 'the service role read the counts';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%' or sqlstate = '42501', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.download_events where visitor = repeat('99', 16)) = 30, 'at most 30 a visitor an hour';
  assert (select country || ' ' || referrer from public.download_events where visitor = repeat('a1', 16) order by id limit 1) = 'FJ /programs/central', 'country upper case, page tidied';
  assert (select referrer from public.download_events where visitor = repeat('b2', 16)) = 'google.com', 'another website: its name only';
  assert (select row(country, referrer, browser)::text from public.download_events where visitor = repeat('c3', 16)) = '(,,Other)', 'unknown country and our own site dropped';
  assert (select row(release_tag, referrer, browser)::text from public.download_events where visitor = repeat('d4', 16)) = '(,,)', 'bad values dropped';
end $$;
-- linking: only a member of that business, and only installs not linked yet
select pg_temp.as_user('33333333-3333-3333-3333-333333333333'); set role authenticated;
do $$ begin begin perform public.install_link('0d0d0d0d-0000-4000-8000-000000000001', current_setting('test.ws_a')::uuid); raise exception 'another business linked an install';
  exception when others then assert sqlerrm like 'You''re not in this business%', sqlerrm; end; end $$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
do $$ begin
  assert public.install_link('0d0d0d0d-0000-4000-8000-000000000001', current_setting('test.ws_a')::uuid) = 3, 'the install''s notes are tied to the business';
  assert public.install_link('0d0d0d0d-0000-4000-8000-000000000001', current_setting('test.ws_a')::uuid) = 0, 'once';
  begin perform public.hq_real_downloads(30); raise exception 'a customer read the counts';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end;
  begin perform count(*) from public.install_events; raise exception 'a customer read install_events';
  exception when insufficient_privilege then null; end;
end $$;
-- HQ (support has downloads.view)
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
do $$ declare r json; p json; begin
  r := public.hq_real_downloads(30);
  assert (r ->> 'real')::int = 3, format('real: a1 once for central, b2 for pos, 99 once: %s', r ->> 'real');
  assert (r ->> 'raw')::int = 36, format('raw: %s', r ->> 'raw');
  assert (r -> 'hidden' ->> 'tests')::int = 1 and (r -> 'hidden' ->> 'staff')::int = 1 and (r -> 'hidden' ->> 'bots')::int = 1, format('hidden: %s', r -> 'hidden');
  assert (r -> 'hidden' ->> 'repeats')::int = 30, format('repeats: %s', r -> 'hidden');
  assert (r -> 'installs' ->> 'new')::int = 1 and (r -> 'installs' ->> 'existing')::int = 1 and (r -> 'installs' ->> 'updates')::int = 1
    and (r -> 'installs' ->> 'added')::int = 1 and (r -> 'installs' ->> 'linked')::int = 1 and (r -> 'hidden' ->> 'install_tests')::int = 1, format('installs: %s', r -> 'installs');
  assert json_array_length(r -> 'series') = 30 and ((r -> 'series' -> 29) ->> 'real')::int = 3, 'a day each, today has 3';
  select x into p from json_array_elements(r -> 'programs') x where x ->> 'program' = 'pos';
  assert (p ->> 'real')::int = 1 and (p ->> 'raw')::int = 3 and (p ->> 'installs')::int = 1 and (p ->> 'updates')::int = 1, format('pos: %s', p);
  assert exists (select 1 from json_array_elements(r -> 'countries') x where x ->> 'country' = 'FJ' and (x ->> 'real')::int = 1), 'by country';
  assert exists (select 1 from json_array_elements(r -> 'referrers') x where x ->> 'referrer' = 'google.com'), 'by page or website';
  assert exists (select 1 from json_array_elements(r -> 'program_series') x where x ->> 'program' = 'central'), 'per program per day';
  assert (public.hq_real_downloads(5000) ->> 'days')::int = 365 and (public.hq_real_downloads(1) ->> 'days')::int = 7, 'ranges kept to 7..365 days';
  begin perform count(*) from public.download_events; raise exception 'HQ read the raw table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert public.hq_save_download_totals('{"RiyeserCentral-Setup.exe": 120, "bad": "x"}') = 1, 'the daily job saves GitHub totals (owner only)';
  assert (select total from public.downloads_daily where asset = 'RiyeserCentral-Setup.exe' and day = current_date) = 120, 'saved';
end $$;
select 'real downloads ok' as downloads;
-- ===== Your booking page (riyeser.com/book/<address>): settings, the hidden page key, the public profile, bookings =====
reset role;
grant select on public.booking_pages to service_role;
insert into auth.users (id, email) values ('b0b0b0b1-0000-4000-8000-000000000001', 'owner@bp.test'), ('b0b0b0b2-0000-4000-8000-000000000002', 'staff@bp.test'),
  ('b0b0b0b3-0000-4000-8000-000000000003', 'other@bp.test'), ('b0b0b0b4-0000-4000-8000-000000000004', 'solo@bp.test');
set role authenticated;
select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
select set_config('bp.ws', public.create_team('Harbour Hair Studio!', 'Hana')::text, false);
select set_config('bp.code', (select invite_code from public.workspaces where id = current_setting('bp.ws')::uuid), false);
select public.link_device(current_setting('bp.ws')::uuid, 'b0b0b0d1-0000-4000-8000-000000000001', 'SALON-PC', 'windows', '1.0');
select pg_temp.as_user('b0b0b0b2-0000-4000-8000-000000000002');
select public.join_team(current_setting('bp.code'), 'Sione');
select pg_temp.as_user('b0b0b0b3-0000-4000-8000-000000000003');
select set_config('bp.ws_x', public.create_team('Other Barber', 'Oli')::text, false);
reset role;
update public.workspaces set address = '12 Marine Drive, Suva', phone = '+679 330 1234' where id = current_setting('bp.ws')::uuid;
-- a personal account (no business): no booking page
insert into public.workspaces (name, kind) values ('Solo person', 'personal') returning set_config('bp.ws_p', id::text, false);
insert into public.members (workspace_id, user_id, role, display_name) values (current_setting('bp.ws_p')::uuid, 'b0b0b0b4-0000-4000-8000-000000000004', 'owner', 'Solo');
set role authenticated;

-- off until switched on; only owners and admins with two-step sign-in
select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
do $$ declare g json := public.booking_page_get(current_setting('bp.ws')::uuid); begin
  assert g -> 'page' is null or json_typeof(g -> 'page') = 'null', 'no page until it is saved: ' || g::text;
  assert g ->> 'suggested_slug' = 'harbour-hair-studio', 'an address from the name: ' || (g ->> 'suggested_slug');
  assert (g ->> 'allowed')::boolean, 'Bookings on its trial: allowed';
end $$;
select pg_temp.as_user_password_only('b0b0b0b1-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.booking_page_save(current_setting('bp.ws')::uuid, '{"enabled": true}'); raise exception 'aal1 switched the page on';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin, signed in with two-step%', sqlerrm; end;
end $$;
select pg_temp.as_user('b0b0b0b2-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.booking_page_get(current_setting('bp.ws')::uuid); raise exception 'staff read the booking page settings';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.booking_page_save(current_setting('bp.ws')::uuid, '{"enabled": true}'); raise exception 'staff switched it on';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
end $$;
select pg_temp.as_user('b0b0b0b4-0000-4000-8000-000000000004');
do $$ begin
  begin perform public.booking_page_save(current_setting('bp.ws_p')::uuid, '{"enabled": true}'); raise exception 'a personal account got a booking page';
  exception when others then assert sqlerrm like 'Booking pages are for businesses%' or sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
-- addresses: tidied, reserved words refused, unique
select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('bp.ws')::uuid; c json; begin
  c := public.booking_page_slug_check(ws, '  Harbour  Hair!! ');
  assert (c ->> 'ok')::boolean and c ->> 'slug' = 'harbour-hair', 'tidied: ' || c::text;
  c := public.booking_page_slug_check(ws, 'ab'); assert not (c ->> 'ok')::boolean and c ->> 'message' like 'The address needs at least 3%', c::text;
  c := public.booking_page_slug_check(ws, 'Riyeser'); assert not (c ->> 'ok')::boolean and c ->> 'message' like '%kept for Riyeser%', c::text;
  c := public.booking_page_slug_check(ws, repeat('a', 41)); assert not (c ->> 'ok')::boolean, 'too long';
  begin perform public.booking_page_save(ws, '{"slug": "admin"}'); raise exception 'reserved address saved';
  exception when others then assert sqlerrm like '%kept for Riyeser%', sqlerrm; end;
  begin perform public.booking_page_save(ws, '{"logo": "data:image/svg+xml;base64,PHN2Zz4="}'); raise exception 'svg logo';
  exception when others then assert sqlerrm like 'The logo must be a PNG%', sqlerrm; end;
  begin perform public.booking_page_save(ws, '{"colour": "red"}'); raise exception 'bad colour';
  exception when others then assert sqlerrm like 'The colour looks like%', sqlerrm; end;
  begin perform public.booking_page_save(ws, jsonb_build_object('intro', repeat('x', 301))); raise exception 'long intro';
  exception when others then assert sqlerrm like 'The welcome text%', sqlerrm; end;
end $$;
select pg_temp.as_user('b0b0b0b3-0000-4000-8000-000000000003');
do $$ declare g json; begin
  g := public.booking_page_save(current_setting('bp.ws_x')::uuid, '{"slug": "harbour-hair", "enabled": false}');
  assert g -> 'page' ->> 'slug' = 'harbour-hair' and not (g -> 'page' ->> 'enabled')::boolean, 'other business took harbour-hair (off)';
  begin perform public.booking_page_get(current_setting('bp.ws')::uuid); raise exception 'other business read our page';
  exception when others then assert sqlerrm like 'Only the business''s owner%', sqlerrm; end;
end $$;
select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('bp.ws')::uuid; c json; g json; begin
  c := public.booking_page_slug_check(ws, 'harbour-hair'); assert not (c ->> 'ok')::boolean and c ->> 'message' like '%is taken%', 'taken: ' || c::text;
  begin perform public.booking_page_save(ws, '{"slug": "Harbour Hair"}'); raise exception 'took a taken address';
  exception when others then assert sqlerrm like '%is taken%', sqlerrm; end;
  -- switch it on: one tick. The page key is made behind the scenes and never shown
  g := public.booking_page_save(ws, '{"enabled": true, "intro": " Walk-ins welcome too. ", "colour": "#0E7C86", "logo": "data:image/png;base64,iVBORw0KGgo=", "show_staff": true}');
  assert (g -> 'page' ->> 'enabled')::boolean and (g -> 'page' ->> 'working')::boolean, 'on and working: ' || g::text;
  assert g -> 'page' ->> 'slug' = 'harbour-hair-studio' and g -> 'page' ->> 'intro' = 'Walk-ins welcome too.' and g -> 'page' ->> 'colour' = '#0e7c86', 'saved: ' || g::text;
  assert g::text not like '%rk\_%' and g::text !~ '"key|key_id|key_hash', 'no key in what the owner sees: ' || g::text;
  assert json_array_length(public.api_keys_list(ws)) = 0, 'the page key is not in the API keys list';
  assert (public.api_overview(ws) -> 'keys' ->> 'active')::int = 0 and (public.api_overview(ws) -> 'booking_page' ->> 'enabled')::boolean, 'nor in the counts';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'booking_page.on'), 'switching on is in the change history';
end $$;
reset role;
do $$ declare k public.api_keys; begin
  select * into k from public.api_keys where workspace_id = current_setting('bp.ws')::uuid and internal = 'booking_page';
  assert k.id is not null and k.kind = 'widget' and k.scopes = array['availability:read', 'bookings:write'] and k.mode = 'live', 'a page key with only free times and bookings';
  assert (select key_id from public.booking_pages where workspace_id = current_setting('bp.ws')::uuid) = k.id, 'the page uses it';
  perform set_config('bp.key', k.id::text, false);
end $$;
set role authenticated; select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
do $$ declare ws uuid := current_setting('bp.ws')::uuid; begin
  begin perform public.api_key_revoke(ws, current_setting('bp.key')::uuid); raise exception 'revoked the page key from the keys screen';
  exception when others then assert sqlerrm like 'That key isn''t there%', sqlerrm; end;
  begin perform public.api_key_rename(ws, current_setting('bp.key')::uuid, 'Mine'); raise exception 'renamed the page key';
  exception when others then assert sqlerrm like 'That key isn''t there%', sqlerrm; end;
  begin perform public.api_key_set_access(ws, current_setting('bp.key')::uuid, array['https://evil.example.com'], '{}'); raise exception 'changed the page key''s websites';
  exception when others then assert sqlerrm like 'That key isn''t there%', sqlerrm; end;
end $$;
-- nothing is readable directly, and the Edge Function's calls are only for the service role
do $$ begin
  begin perform count(*) from public.booking_pages; raise exception 'authenticated read booking_pages'; exception when insufficient_privilege then null; end;
  begin perform public.api_page_auth('harbour-hair-studio', null); raise exception 'signed in ran api_page_auth'; exception when insufficient_privilege then null; end;
  begin perform public.api_page_profile(current_setting('bp.key')::uuid); raise exception 'signed in ran api_page_profile'; exception when insufficient_privilege then null; end;
end $$;
set role anon;
do $$ begin
  begin perform count(*) from public.booking_pages; raise exception 'anon read booking_pages'; exception when insufficient_privilege then null; end;
  begin perform public.api_page_auth('harbour-hair-studio', null); raise exception 'anon ran api_page_auth'; exception when insufficient_privilege then null; end;
  begin perform public.booking_page_get(current_setting('bp.ws')::uuid); raise exception 'anon read the settings'; exception when insufficient_privilege then null; end;
end $$;

-- the PC publishes services, staff and free times (Riyeser Bookings through Central)
set role authenticated; select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
select public.api_publish_catalog(current_setting('bp.ws')::uuid, 'b0b0b0d1-0000-4000-8000-000000000001',
  '[{"sku": "CUT", "type": "service", "name": "Cut & style", "price": 45, "currency": "FJD", "duration_minutes": 45},
    {"sku": "KIDS", "type": "service", "name": "Kids cut", "price": 25, "currency": "FJD", "duration_minutes": 30},
    {"sku": "SHAMPOO", "type": "product", "name": "Shampoo", "price": 18, "currency": "FJD"}]', true);
select public.api_publish_availability(current_setting('bp.ws')::uuid, 'b0b0b0d1-0000-4000-8000-000000000001',
  '{"timezone": "Pacific/Fiji", "slot_minutes": 15, "min_notice_minutes": 0, "days_ahead": 30}',
  '[{"ref": "amy", "name": "Amy", "services": []}, {"ref": "old", "name": "Gone", "services": [], "active": false}]',
  jsonb_build_array(jsonb_build_object('staff_ref', 'amy', 'start', date_trunc('day', now()) + interval '2 days' - interval '12 hours' + interval '9 hours',
                                       'end', date_trunc('day', now()) + interval '2 days' - interval '12 hours' + interval '17 hours')),
  now() - interval '1 day', now() + interval '30 days');

-- api_page_auth (the Edge Function, service role): from the address; unknown, switched off and personal give the same answer
reset role; set role service_role;
do $$ declare a json; p json; begin
  a := public.api_page_auth('harbour-hair-studio', '198.51.100.7');
  assert a ->> 'key_id' = current_setting('bp.key') and a ->> 'workspace_id' = current_setting('bp.ws') and a ->> 'kind' = 'widget' and a ->> 'mode' = 'live', 'found: ' || a::text;
  assert (a -> 'allowed_origins')::jsonb = '["https://riyeser.com", "https://www.riyeser.com"]', 'only riyeser.com: ' || (a -> 'allowed_origins')::text;
  assert (public.api_page_auth('no-such-page', '198.51.100.7') -> 'error' ->> 'code') = 'page_not_found', 'unknown address';
  assert (public.api_page_auth('no-such-page', '198.51.100.7') -> 'origins')::jsonb ? 'https://riyeser.com', 'a refusal says which websites may read it (CORS)';
  assert (public.api_page_auth('harbour-hair', '198.51.100.7') -> 'error' ->> 'code') = 'page_not_found', 'a page that is switched off';
  assert (public.api_page_auth('Bad Slug!', '198.51.100.7') -> 'error' ->> 'code') = 'page_not_found', 'not an address';
  -- the public profile: only what a customer needs
  p := public.api_page_profile(current_setting('bp.key')::uuid);
  assert p ->> 'name' = 'Harbour Hair Studio!' and p ->> 'slug' = 'harbour-hair-studio' and p ->> 'colour' = '#0e7c86' and p ->> 'intro' = 'Walk-ins welcome too.', 'profile: ' || p::text;
  assert p ->> 'address' = '12 Marine Drive, Suva' and p ->> 'phone' = '+679 330 1234' and p ->> 'timezone' = 'Pacific/Fiji' and (p ->> 'accepting')::boolean, 'contact and time zone';
  assert json_array_length(p -> 'services') = 2 and (p -> 'services')::text like '%"price" : 45%' and (p -> 'services')::text not like '%SHAMPOO%', 'services only (not products), with prices: ' || (p -> 'services')::text;
  assert json_array_length(p -> 'staff') = 1 and p -> 'staff' -> 0 ->> 'name' = 'Amy', 'active staff only';
  assert json_array_length(p -> 'hours') = 1 and p -> 'hours' -> 0 ->> 'open' ~ '^\d\d:\d\d$', 'opening hours from the open times: ' || (p -> 'hours')::text;
  assert p::text not like '%owner@bp.test%' and p::text not like '%Hana%' and p::text not like '%invite%' and p::text not like '%key%', 'nothing private: ' || p::text;
end $$;
-- a booking through the page key: only a free time, lands in the post box as a widget booking, seen by the PC
do $$ declare s json; r json; bad json; t text; begin
  s := public.api_read(current_setting('bp.key')::uuid, 'slots', jsonb_build_object('service', 'CUT', 'from', to_char((now() + interval '1 day') at time zone 'Pacific/Fiji', 'YYYY-MM-DD'), 'days', 7));
  assert json_array_length(s -> 'slots') > 10, 'free times for the page: ' || left(s::text, 200);
  t := s -> 'slots' -> 0 ->> 'start';
  bad := public.api_submit(current_setting('bp.key')::uuid, 'booking', jsonb_build_object('service', 'CUT', 'start', (t::timestamptz + interval '7 minutes'),
    'customer', jsonb_build_object('name', 'Mele', 'phone', '+679 777 1234')), 'bp-1', repeat('a', 64), 'page');
  assert bad -> 'error' ->> 'code' = 'slot_not_available', 'a time that isn''t free is refused: ' || bad::text;
  r := public.api_submit(current_setting('bp.key')::uuid, 'booking', jsonb_build_object('service', 'CUT', 'staff', 'amy', 'start', t,
    'customer', jsonb_build_object('name', 'Mele', 'phone', '+679 777 1234'), 'metadata', jsonb_build_object('channel', 'booking_page')), 'bp-2', repeat('b', 64), 'page');
  assert r ->> 'status' = 'waiting' and not (r ->> 'test')::boolean, 'booked: ' || r::text;
  perform set_config('bp.ev', r ->> 'id', false);
  assert (select source from public.api_inbox where id = (r ->> 'id')::uuid) = 'widget', 'arrives like a widget booking (to confirm)';
  assert (public.api_read(current_setting('bp.key')::uuid, 'event', jsonb_build_object('id', r ->> 'id')) ->> 'status') = 'waiting', 'the page can follow its own booking';
  -- the time is held: it is no longer offered
  s := public.api_read(current_setting('bp.key')::uuid, 'slots', jsonb_build_object('service', 'CUT', 'from', to_char((now() + interval '1 day') at time zone 'Pacific/Fiji', 'YYYY-MM-DD'), 'days', 7, 'staff', 'amy'));
  assert not exists (select 1 from json_array_elements(s -> 'slots') x where x ->> 'start' = t), 'the booked time is held';
end $$;
-- visitor limits: 40 a minute from one address (any page address, known or not)
do $$ declare i int; a json; begin
  for i in 1..45 loop a := public.api_page_auth(case when i % 2 = 0 then 'harbour-hair-studio' else 'guess-' || i end, '203.0.113.99'); end loop;
  assert a -> 'error' ->> 'code' = 'rate_limited' and (a ->> 'retry_after')::int between 0 and 60, 'one visitor address is limited: ' || a::text;
  assert public.api_page_auth('harbour-hair-studio', '198.51.100.8') ->> 'key_id' = current_setting('bp.key'), 'other visitors are not';
end $$;
reset role;
-- the business's linked PC collects it like any widget booking
set role authenticated; select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
do $$ declare c json; begin
  c := public.api_inbox_claim(current_setting('bp.ws')::uuid, 'b0b0b0d1-0000-4000-8000-000000000001', array['booking'], 10);
  assert json_array_length(c) = 1 and c -> 0 ->> 'id' = current_setting('bp.ev') and c -> 0 ->> 'key_name' = 'Booking page', 'the PC gets it: ' || c::text;
  assert (public.api_status(current_setting('bp.ws')::uuid, 'b0b0b0d1-0000-4000-8000-000000000001') ->> 'set_up')::boolean, 'Central sees connections are set up';
  assert (public.booking_page_get(current_setting('bp.ws')::uuid) ->> 'bookings_7d')::int = 1, 'one booking from the page this week';
  -- hide prices, staff and contact details
  perform public.booking_page_save(current_setting('bp.ws')::uuid, '{"show_prices": false, "show_staff": false, "show_contact": false, "logo": ""}');
end $$;
reset role; set role service_role;
do $$ declare p json := public.api_page_profile(current_setting('bp.key')::uuid); begin
  assert p -> 'services' -> 0 ->> 'price' is null and json_array_length(p -> 'staff') = 0 and p ->> 'address' is null and p ->> 'phone' is null and p ->> 'logo' is null, 'hidden: ' || p::text;
end $$;
reset role;
-- licence: without Riyeser Bookings the page says it isn't taking bookings (no services shown)
insert into public.company_modules (workspace_id, module, status, trial_ends) values (current_setting('bp.ws')::uuid, 'bookings', 'trial', current_date - 1)
  on conflict (workspace_id, module) do update set status = 'trial', trial_ends = current_date - 1;
set role service_role;
do $$ declare p json := public.api_page_profile(current_setting('bp.key')::uuid); begin
  assert not (p ->> 'accepting')::boolean and p ->> 'reason' = 'bookings_licence_required' and json_array_length(p -> 'services') = 0, 'not accepting: ' || p::text;
end $$;
reset role;
update public.company_modules set trial_ends = current_date + 30 where workspace_id = current_setting('bp.ws')::uuid and module = 'bookings';
-- switched off: the address stops answering (and the key stays unusable from anywhere else)
set role authenticated; select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
select public.booking_page_save(current_setting('bp.ws')::uuid, '{"enabled": false}');
reset role; set role service_role;
do $$ begin
  assert public.api_page_auth('harbour-hair-studio', '198.51.100.9') -> 'error' ->> 'code' = 'page_not_found', 'switched off: not found';
  assert public.api_page_profile(current_setting('bp.key')::uuid) -> 'error' ->> 'code' = 'page_not_found', 'no profile when off';
end $$;
reset role;
do $$ begin assert exists (select 1 from public.audit_log where workspace_id = current_setting('bp.ws')::uuid and action = 'booking_page.off'), 'switching off is in the history'; end $$;
-- on again: the same key (nothing new to set up); a closed business answers business_closed
set role authenticated; select pg_temp.as_user('b0b0b0b1-0000-4000-8000-000000000001');
select public.booking_page_save(current_setting('bp.ws')::uuid, '{"enabled": true}');
reset role;
do $$ begin assert (select count(*) from public.api_keys where workspace_id = current_setting('bp.ws')::uuid and internal = 'booking_page') = 1, 'one page key, reused'; end $$;
update public.workspaces set status = 'suspended' where id = current_setting('bp.ws')::uuid;
set role service_role;
do $$ begin assert public.api_page_auth('harbour-hair-studio', '198.51.100.10') -> 'error' ->> 'code' = 'business_closed', 'a paused business'; end $$;
reset role;
update public.workspaces set status = 'active' where id = current_setting('bp.ws')::uuid;
-- ===== 1.3.1: changing or removing the relay PC (set-up codes, own keys, takeover, removal, last relay, revocation)
reset role;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
select public.link_relay_set(:'ws_r', true);
-- a set-up code: owner with two-step only; never for another business's relay
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; c jsonb; begin
  c := public.link_relay_enroll_code(ws, 'Suva head office');
  assert c ->> 'code' ~ '^RLY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$', format('code: %s', c);
  assert c ->> 'host' is null, 'no web name by default (zero-DNS)';
  perform set_config('test.code1', c ->> 'code', false); perform set_config('test.new1', c ->> 'relay_id', false);
  begin perform public.link_relay_enroll_code(ws, 'X', 'own1'); raise exception 'moved another business''s relay';
  exception when others then assert sqlerrm like 'Choose one of your business''s own relays%', sqlerrm; end;
  begin perform public.link_relay_enroll_code(ws, 'X', 'syd1'); raise exception 'moved Riyeser''s shared relay';
  exception when others then assert sqlerrm like 'Choose one of your business''s own relays%', sqlerrm; end;
  begin perform public.link_relay_enroll_code(ws, 'X', null, 'not a name'); raise exception 'bad web name';
  exception when others then assert sqlerrm like 'That web name%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('d0d0d0d0-0000-4000-8000-000000000001');
do $$ begin
  begin perform public.link_relay_enroll_code(current_setting('test.ws_r')::uuid, 'X'); raise exception 'aal1 made a relay code';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.link_relay_manage(current_setting('test.ws_r')::uuid, 'syd1', 'off'); raise exception 'aal1 switched a relay off';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000002');
do $$ begin
  begin perform public.link_relay_enroll_code(current_setting('test.ws_r')::uuid, 'X'); raise exception 'a member made a relay code';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
end $$;
-- the new PC claims it (Link Office, maybe not signed in at all): its own key, once; wrong and used codes refused
set role anon;
do $$ declare k jsonb; begin
  begin perform public.relay_enroll_claim('RLY-AAAA-BBBB-CCCC'); raise exception 'a made-up code worked';
  exception when others then assert sqlerrm like 'That set-up code isn''t right%', sqlerrm; end;
  k := public.relay_enroll_claim(lower(current_setting('test.code1')));
  assert k ->> 'relay_id' = current_setting('test.new1') and length(k ->> 'key') = 64 and not (k ->> 'dns')::boolean, format('claimed: %s', k - 'key');
  assert k ->> 'host' like '%.relay.invalid', 'a name that never resolves (sites use the address)';
  perform set_config('test.key1', k ->> 'key', false);
  begin perform public.relay_enroll_claim(current_setting('test.code1')); raise exception 'a code worked twice';
  exception when others then assert sqlerrm like 'That set-up code isn''t right%', sqlerrm; end;
  begin perform count(*) from public.relay_enrollments; raise exception 'anon read the codes';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select k ->> 'key' from (select null::jsonb k) x) is null;
  assert (select sync_key from public.relay_servers where id = current_setting('test.new1')) = current_setting('test.key1'), 'its own key';
  assert (select sync_key from public.relay_servers where id = current_setting('test.new1')) <> (select secret from public.relay_cluster), 'never the cluster secret';
  assert (select managed_by from public.relay_servers where id = current_setting('test.new1')) = current_setting('test.ws_r')::uuid, 'looked after by the business';
  assert not exists (select 1 from public.audit_log a where a.details::text like '%' || current_setting('test.key1') || '%'), 'no key in the history';
end $$;
-- it checks in with its own key, gets the cluster's keys (never the secret), and reports its address: sites use it
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); r jsonb; begin
  begin perform public.relay_sync(current_setting('test.new1'), ts, encode(hmac((current_setting('test.new1') || '|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{}');
    raise exception 'an enrolled relay signed with the cluster secret';
  exception when others then assert sqlerrm like 'Not a relay of Riyeser''s%', sqlerrm; end;
  r := public.relay_sync(current_setting('test.new1'), ts, encode(hmac((current_setting('test.new1') || '|' || ts)::text, current_setting('test.key1'), 'sha256'), 'hex'),
    '{"version":"1.1.0","public_ip":"198.51.100.20","cert":{"sha256":"CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD","self_signed":true}}');
  assert r -> 'keys' ->> 'office' = encode(hmac('office-token', 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), format('the office key: %s', r -> 'keys');
  assert r -> 'keys' ->> 'turn' = encode(hmac('turn', 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), 'the TURN key';
  assert r::text not like '%test-relay-secret-0123456789abcdef0123456789%', 'never the secret itself';
  assert jsonb_array_length(r -> 'businesses') = 1, format('serves the business: %s', r -> 'businesses');
  assert (r -> 'businesses' -> 0 ->> 'ws') = current_setting('test.ws_r'), 'only its own business';
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; c jsonb; x jsonb; begin
  c := public.link_relay_config(ws);
  select e into x from jsonb_array_elements(c -> 'relays') e where e ->> 'id' = current_setting('test.new1');
  assert x ->> 'url' = 'wss://198.51.100.20/link/v1' and x ->> 'addr' = '198.51.100.20' and x ->> 'pin' like 'CD:%', format('no web name: the address and the certificate: %s', x);
  assert (x ->> 'managed')::boolean, 'the business looks after it';
  assert jsonb_array_length(public.link_relay_status(ws) -> 'manage') = 3, format('admins see every relay they could use: %s', public.link_relay_status(ws) -> 'manage');
  -- make it the main relay, then switch Riyeser's Sydney one off for this business
  perform public.link_relay_manage(ws, current_setting('test.new1'), 'main');
  assert (public.link_relay_config(ws) -> 'relays' -> 0 ->> 'id') = current_setting('test.new1'), 'now first';
  perform public.link_relay_manage(ws, 'syd1', 'off');
  assert not exists (select 1 from jsonb_array_elements(public.link_relay_config(ws) -> 'relays') e where e ->> 'id' = 'syd1'), 'switched off for us';
  assert exists (select 1 from jsonb_array_elements(public.link_relay_status(ws) -> 'manage') e where e ->> 'id' = 'syd1' and (e ->> 'off')::boolean), 'still listed for admins, as off';
  begin perform public.link_relay_manage(ws, 'mel1', 'remove'); raise exception 'removed Riyeser''s relay';
  exception when others then assert sqlerrm like 'This relay is Riyeser''s%', sqlerrm; end;
  begin perform public.link_relay_manage(ws, 'own1', 'off'); raise exception 'touched another business''s relay';
  exception when others then assert sqlerrm like 'That relay isn''t one your business uses%', sqlerrm; end;
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_made_main') and exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_switched_off'), 'in the history';
end $$;
-- Sydney's sync plan no longer has this business; Melbourne's still does
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); begin
  assert jsonb_array_length(public.relay_sync('syd1', ts, encode(hmac(('syd1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{"version":"1.1.0"}') -> 'businesses') = 0, 'switched off: not in Sydney''s plan';
  assert jsonb_array_length(public.relay_sync('mel1', ts, encode(hmac(('mel1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{"version":"1.1.0"}') -> 'businesses') = 1, 'still in Melbourne''s';
end $$;
-- Other Cafe's own relay has checked in on an old version: the secret isn't changed while it couldn't follow
reset role;
update public.relay_servers set version = '1.0.0', last_seen = now() where id = 'own1';
-- move the relay to another PC: the new PC takes over its place once it checks in; the old one is removed then
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare c jsonb; begin
  c := public.link_relay_enroll_code(current_setting('test.ws_r')::uuid, '', current_setting('test.new1'));
  assert c ->> 'replaces' = current_setting('test.new1'), 'moves it';
  perform set_config('test.code2', c ->> 'code', false); perform set_config('test.new2', c ->> 'relay_id', false);
end $$;
set role anon;
do $$ declare k jsonb; ts bigint := floor(extract(epoch from now())); r jsonb; begin
  k := public.relay_enroll_claim(current_setting('test.code2'));
  assert (k ->> 'priority')::int = 1 and k ->> 'region' = 'Suva head office', format('same place and priority: %s', k - 'key');
  perform set_config('test.key2', k ->> 'key', false);
  -- not yet checked in: the old one is still there
  assert exists (select 1 from jsonb_array_elements(public.relay_sync(current_setting('test.new1'), ts, encode(hmac((current_setting('test.new1') || '|' || ts)::text, current_setting('test.key1'), 'sha256'), 'hex'), '{"version":"1.1.0"}') -> 'relays') e where e ->> 'id' = current_setting('test.new2')), 'the old one sees the new one';
  r := public.relay_sync(current_setting('test.new2'), ts, encode(hmac((current_setting('test.new2') || '|' || ts)::text, current_setting('test.key2'), 'sha256'), 'hex'), '{"version":"1.1.0","public_ip":"198.51.100.30"}');
  begin perform public.relay_sync(current_setting('test.new1'), ts, encode(hmac((current_setting('test.new1') || '|' || ts)::text, current_setting('test.key1'), 'sha256'), 'hex'), '{}');
    raise exception 'the old PC still checks in';
  exception when others then assert sqlerrm like '%RELAY_REMOVED%', sqlerrm; end;
end $$;
reset role;
do $$ begin
  assert (select relays[1] from public.link_relay_settings where workspace_id = current_setting('test.ws_r')::uuid) = current_setting('test.new2'), 'took the old one''s place in the order';
  assert (select epoch from public.relay_cluster) = 1, 'secret not changed while Other Cafe''s relay is too old to follow';
  assert exists (select 1 from public.audit_log where action = 'link.relay_moved' and details ->> 'to' = current_setting('test.new2')), 'in the history';
end $$;
-- Other Cafe updates its relay: now removing a relay changes the secret, and the keys copied from it stop working
update public.relay_servers set version = '1.1.0' where id = 'own1';
select set_config('test.office_key_before', encode(public.relay_key('office-token'), 'hex'), false);
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; r jsonb; begin
  -- the last relay of the business: Melbourne is still on, so not the last; switch Melbourne off first (confirm)
  begin perform public.link_relay_manage(ws, 'mel1', 'off'); exception when others then raise exception 'not the last: %', sqlerrm; end;
  begin perform public.link_relay_manage(ws, current_setting('test.new2'), 'remove'); raise exception 'the last relay went without a warning';
  exception when others then assert sqlerrm like 'LAST_RELAY:%', sqlerrm; end;
  assert (public.link_relay_config(ws) ->> 'enabled')::boolean, 'still on after the warning';
  r := public.link_relay_manage(ws, current_setting('test.new2'), 'remove', true);
  assert (r -> 'result' ->> 'rotated')::boolean, format('the secret was changed: %s', r -> 'result');
  assert not (public.link_relay_config(ws) ->> 'enabled')::boolean, 'the last relay removed: switched off for the business';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_off' and details ->> 'reason' like 'the last relay%'), 'switched off, in the history';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_removed'), 'removed, in the history';
end $$;
set role anon;
do $$ declare ts bigint := floor(extract(epoch from now())); r jsonb; begin
  -- the removed PC's own key no longer works at all
  begin perform public.relay_sync(current_setting('test.new2'), ts, encode(hmac((current_setting('test.new2') || '|' || ts)::text, current_setting('test.key2'), 'sha256'), 'hex'), '{}');
    raise exception 'a removed relay checked in';
  exception when others then assert sqlerrm like '%RELAY_REMOVED%', sqlerrm; end;
  -- the relays that stay still check in with what they had (Sydney: the old secret is now its own key) and get the new keys
  r := public.relay_sync('syd1', ts, encode(hmac(('syd1|' || ts)::text, 'test-relay-secret-0123456789abcdef0123456789', 'sha256'), 'hex'), '{"version":"1.1.0"}');
  assert r -> 'keys' ->> 'office' <> current_setting('test.office_key_before') and (r -> 'keys' ->> 'epoch')::int = 2, format('new keys: %s', r -> 'keys');
  assert not exists (select 1 from jsonb_array_elements(r -> 'relays') e where e ->> 'id' = current_setting('test.new2')), 'the others stop listing it';
end $$;
reset role;
do $$ begin
  assert (select sync_key from public.relay_servers where id = 'syd1') = 'test-relay-secret-0123456789abcdef0123456789', 'Sydney keeps its key';
  assert (select secret from public.relay_cluster) <> 'test-relay-secret-0123456789abcdef0123456789', 'a new cluster secret';
end $$;
-- the relay PC leaving by itself (uninstalled), signed with its key
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare c jsonb; begin c := public.link_relay_enroll_code(current_setting('test.ws_r')::uuid, 'Nadi'); perform set_config('test.code3', c ->> 'code', false); end $$;
set role anon;
do $$ declare k jsonb; ts bigint := floor(extract(epoch from now())); begin
  k := public.relay_enroll_claim(current_setting('test.code3'));
  begin perform public.relay_leave(k ->> 'relay_id', ts, 'deadbeef'); raise exception 'left without its key';
  exception when others then assert sqlerrm like 'Not a relay of Riyeser''s%', sqlerrm; end;
  assert (public.relay_leave(k ->> 'relay_id', ts, encode(hmac((k ->> 'relay_id' || '|' || ts)::text, k ->> 'key', 'sha256'), 'hex')) ->> 'removed')::boolean, 'left';
  begin perform public.relay_sync(k ->> 'relay_id', ts, encode(hmac((k ->> 'relay_id' || '|' || ts)::text, k ->> 'key', 'sha256'), 'hex'), '{}'); raise exception 'still there after leaving';
  exception when others then assert sqlerrm like '%RELAY_REMOVED%', sqlerrm; end;
end $$;
-- the checklist from each site's report: only the known shapes are kept; and a remote check from the website
reset role;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000003'); set role authenticated;
select public.link_relay_report(:'ws_r', 'lo-nadi-0002', '{"state":"connected","checks":[{"k":"reach","s":"ok","t":"42 ms"},{"k":"udp","s":"fail","t":"UDP blocked"},{"k":"BAD KEY","s":"ok"},{"k":"x","s":"maybe"}],"test":{"rtt_ms":61,"loss":0,"ok":true,"at":"2026-11-27T00:00:00Z"},"host":false}');
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000001'); set role authenticated;
do $$ declare ws uuid := current_setting('test.ws_r')::uuid; o jsonb; cid uuid; begin
  select e into o from jsonb_array_elements(public.link_relay_status(ws) -> 'offices') e where e ->> 'office_id' = 'lo-nadi-0002';
  assert jsonb_array_length(o -> 'relay' -> 'checks') = 2, format('only good steps kept: %s', o -> 'relay' -> 'checks');
  assert (o -> 'relay' -> 'test' ->> 'rtt_ms')::int = 61, 'the last test call';
  cid := public.link_command(ws, 'lo-nadi-0002', 'relay_check', '{"action":"run_check","step":"udp","junk":"x"}');
  assert (select data from public.link_office_commands where id = cid) = '{"action":"run_check","step":"udp"}'::jsonb, 'only the known fields';
  assert exists (select 1 from public.audit_log where workspace_id = ws and action = 'link.relay_check' and details ->> 'action' = 'run_check'), 'remote checks are in the history';
  begin perform public.link_command(ws, 'lo-nadi-0002', 'relay_check', '{"action":"format_disk"}'); raise exception 'unknown action sent';
  exception when others then assert sqlerrm like 'Riyeser Link Office doesn''t know how to do that%', sqlerrm; end;
end $$;
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-000000000004'); set role authenticated;
do $$ begin
  begin perform public.link_command(current_setting('test.ws_r')::uuid, 'lo-nadi-0002', 'relay_check', '{"action":"details"}'); raise exception 'another business ran a check';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  begin perform public.link_relay_enroll_code(current_setting('test.ws_r')::uuid, 'X'); raise exception 'another business made a relay code';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end;
  -- its own business: its own relay is the only one it may remove, and Relay Plumbing's relays never show
  assert not exists (select 1 from jsonb_array_elements(public.link_relay_status(current_setting('test.ws_o')::uuid) -> 'manage') e where e ->> 'managed' = 'true'), 'own1 was registered by Riyeser: not managed';
end $$;
reset role;
-- ---------------- the free trial's anonymous PC record (trial guard): earliest date per PC code and program, never later
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false);
do $$ declare p1 text := repeat('d4', 32); p2 text := repeat('e5', 32); r json; begin
  begin perform count(*) from public.pc_trials; raise exception 'anon read pc_trials'; exception when insufficient_privilege then null; end;
  r := public.pc_trial_seen(p1, 'suite', '2026-09-03T09:00:00Z', '1.9.0');
  assert (r ->> 'trial_start')::timestamptz = '2026-09-03T09:00:00Z' and (r ->> 'extra_days')::int = 0, 'first seen: ' || r::text;
  r := public.pc_trial_seen(p1, 'suite', '2026-10-15T00:00:00Z', '1.9.1');   -- a reinstall that lost its dates
  assert (r ->> 'trial_start')::timestamptz = '2026-09-03T09:00:00Z', 'reinstall: same trial';
  r := public.pc_trial_seen(p1, 'suite', '2026-07-01T00:00:00Z', null);      -- an older company file restored
  assert (r ->> 'trial_start')::timestamptz = '2026-07-01T00:00:00Z', 'the older date wins';
  r := public.pc_trial_seen(p1, 'estimate', '2026-10-01T00:00:00Z', null);   -- per program
  assert (r ->> 'trial_start')::timestamptz = '2026-10-01T00:00:00Z' and r ->> 'program' = 'estimate', 'Estimate has its own';
  r := public.pc_trial_seen(p2, 'suite', null, null);
  assert r ->> 'trial_start' is null, 'another PC: nothing of p1''s';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.pc_trials where pc_id = repeat('d4', 32)) = 2, 'one row per program';
  assert (select app_version from public.pc_trials where pc_id = repeat('d4', 32) and program = 'suite') = '1.9.1', 'the latest version seen';
  assert not exists (select 1 from public.pc_trials where pc_id = repeat('e5', 32)), 'a look-up makes nothing';
  assert (select array_agg(column_name::text order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'pc_trials')
    = array['app_version', 'extra_days', 'first_seen', 'last_seen', 'pc_id', 'program', 'trial_start'], 'nothing else is kept (no names, emails or data)';
end $$;

-- ===== HQ V2 first slice: US dollars only for new refunds and credits; test accounts left out of HQ's figures
-- (Sam is the HQ owner, signed in with two-step sign-in; tokens here have no session id, so the HQ session timer isn't used)
reset role;
-- an older refund in Fiji dollars (made before the rule): still there, can still be reviewed, approved and paid as credit
alter table public.refund_requests disable trigger refund_requests_usd;
insert into public.refund_requests (workspace_id, requested_by, for_what, period, amount, currency, reason_category, explanation)
  select current_setting('test.ws_c')::uuid, '77777777-7777-7777-7777-777777777777', 'Payroll', 'August 2026', 40, 'FJD', 'mistake', 'Older refund in FJD'
  returning id as old_rf \gset
alter table public.refund_requests enable trigger refund_requests_usd;
select set_config('test.old_rf', :'old_rf', false);
select set_config('test.any_ticket', (select id::text from public.support_tickets order by created_at limit 1), false);
select pg_temp.as_user('77777777-7777-7777-7777-777777777777'); set role authenticated;
do $$ begin
  -- the customer asks in another currency: refused, in plain words
  begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'POS', 'November 2026', null, 20, 'AUD', 'mistake', 'Wrong till', null);
    raise exception 'an AUD refund was made';
  exception when others then assert sqlerrm like 'Riyeser charges in US dollars%', sqlerrm; end;
  -- and the older FJD one is still readable as it was
  assert exists (select 1 from json_array_elements(public.my_refunds(current_setting('test.ws_c')::uuid)::json) x where x ->> 'currency' = 'FJD' and (x ->> 'amount')::numeric = 40),
    'the older FJD refund is still shown';
end $$;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare r json; begin
  begin perform public.hq_refund_create(current_setting('test.any_ticket')::uuid, 'POS', 'November 2026', null, 20, 'NZD', 'mistake', 'x'); raise exception 'HQ made an NZD refund';
  exception when others then assert sqlerrm like 'Riyeser charges in US dollars%', sqlerrm; end;
  r := public.hq_refund_create(current_setting('test.any_ticket')::uuid, 'POS', 'November 2026', null, 20, 'USD', 'mistake', 'Charged twice');   -- US dollars: fine
  perform public.hq_refund_review(current_setting('test.old_rf')::uuid);
  perform public.hq_refund_decide(current_setting('test.old_rf')::uuid, 'approve', null, 'Older refund, paid as credit');
  perform public.hq_refund_paid(current_setting('test.old_rf')::uuid, 'credit', null);
end $$;
reset role;
do $$ begin
  assert (select status from public.refund_requests where id = current_setting('test.old_rf')::uuid) = 'paid', 'the older FJD refund could still be paid';
  assert exists (select 1 from public.account_credits where refund_id = current_setting('test.old_rf')::uuid and currency = 'FJD' and amount = 40), 'its credit keeps its own currency';
  begin insert into public.account_credits (workspace_id, amount, currency, note) values (current_setting('test.ws_c')::uuid, 5, 'FJD', 'goodwill'); raise exception 'an FJD credit was added';
  exception when others then assert sqlerrm like 'Riyeser charges in US dollars%', sqlerrm; end;
  begin update public.refund_requests set currency = 'AUD' where id = current_setting('test.old_rf')::uuid; raise exception 'currency changed to AUD';
  exception when others then assert sqlerrm like 'Riyeser charges in US dollars%', sqlerrm; end;
end $$;
-- test accounts: hq_kpis leaves them out unless asked; marking one is in the HQ history and needs test_accounts.manage
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ declare a json; b json; c json; ws uuid := current_setting('test.ws_c')::uuid; begin
  a := public.hq_kpis(false);
  assert (a ->> 'currency') = 'USD' and (a ->> 'test_accounts')::int = 0 and (a ->> 'businesses')::int >= 1 and a ->> 'mrr' is not null, 'kpis: ' || a::text;
  begin perform public.hq_set_account_kind(ws, 'pretend', 'x x x'); raise exception 'odd kind';
  exception when others then assert sqlerrm like 'Choose customer, test, demo or internal%', sqlerrm; end;
  begin perform public.hq_set_account_kind(ws, 'test', ''); raise exception 'no reason';
  exception when others then assert sqlerrm like 'Say why%', sqlerrm; end;
  perform public.hq_set_account_kind(ws, 'test', 'Our own QA business');
  perform public.hq_set_account_kind(ws, 'test', 'Our own QA business');   -- the same again writes nothing
  b := public.hq_kpis(false); c := public.hq_kpis(true);
  assert (b ->> 'test_accounts')::int = 1 and (b ->> 'businesses')::int = (a ->> 'businesses')::int - 1, 'a test account is left out: ' || b::text;
  assert (c ->> 'businesses')::int = (a ->> 'businesses')::int and (c ->> 'include_test')::boolean, 'and counted with the switch on: ' || c::text;
  assert (select count(*) from json_array_elements(public.hq_test_accounts()) x where (x ->> 'id')::uuid = ws) = 1, 'listed as a test account';
  assert (select count(*) from json_array_elements(public.hq_work_queue() -> 'queue') x where x::jsonb ? 'account_kind') = json_array_length(public.hq_work_queue() -> 'queue'), 'queue items say their kind';
  -- the current Overview's "Riyeser at a glance" and "Queue at a glance" leave it out too, unless asked; the old calls count everything
  assert (public.hq_overview(false) ->> 'companies')::int = (public.hq_overview() ->> 'companies')::int - 1
    and (public.hq_overview(true) ->> 'companies')::int = (public.hq_overview() ->> 'companies')::int and not (public.hq_overview(false) ->> 'include_test')::boolean, 'overview without test accounts: ' || public.hq_overview(false)::text;
  assert (public.hq_attention(false) ->> 'unassigned')::int <= (public.hq_attention(true) ->> 'unassigned')::int
    and (public.hq_attention(true) ->> 'unassigned')::int = (public.hq_attention() ->> 'unassigned')::int, 'attention without test accounts';
  perform public.hq_set_account_kind(ws, 'customer', 'Back to a real customer');
end $$;
select pg_temp.as_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');   -- Help Desk (support): can't mark accounts; sees the figures it may see
do $$ declare k json; begin
  begin perform public.hq_set_account_kind(current_setting('test.ws_c')::uuid, 'test', 'not allowed'); raise exception 'support marked a test account';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
  k := public.hq_kpis(false);
  assert k ->> 'open_tickets' is not null and k ->> 'mrr' is not null, 'support: tickets, and money (it has licences.view): ' || k::text;
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.hq_audit where action = 'account.kind') = 2, 'each change of kind is in the HQ history once';
end $$;
-- ===== Custom HQ roles (owner's request: "give the option for admin to select roles"; owner's decision: a standard role,
-- then tick or untick for the person). The built-in roles come from the database now (hq_roles / hq_role_permissions).
reset role;
-- the lists HQ had before custom roles, frozen here (from hq_role_perms before this change): after the migration every built-in
-- role must give exactly these, plus "Email invoices and receipts" where it had licences.manage (SEC-010 split it out)
create function pg_temp.legacy_all() returns text[] language sql as $$
  select array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
    'people.change_owner', 'business.close', 'licences.view', 'licences.manage', 'support.view', 'support.reply', 'support.assign',
    'support.saved_replies', 'support.escalate', 'support.level2', 'support.level3', 'refunds.view', 'refunds.request',
    'refunds.approve', 'refunds.pay', 'offers.grant', 'offers.approve', 'emails.view', 'emails.manage', 'accounts.inactive',
    'staff.manage', 'audit.view', 'settings.manage', 'link.support', 'reports.view', 'support.diagnostics', 'ops.view', 'test_accounts.manage', 'trials.view'] $$;
create function pg_temp.legacy(r text) returns text[] language sql as $$
  select case r
    when 'owner' then pg_temp.legacy_all()
    when 'finance' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'licences.view', 'licences.manage',
      'support.view', 'support.reply', 'support.escalate', 'refunds.view', 'refunds.approve', 'refunds.pay',
      'offers.grant', 'offers.approve', 'emails.view', 'reports.view', 'trials.view']
    when 'admin' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'emails.view', 'emails.manage',
      'audit.view', 'staff.manage', 'settings.manage', 'ops.view', 'test_accounts.manage']
    when 'support' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
      'licences.view', 'support.view', 'support.reply', 'support.assign', 'support.saved_replies', 'support.escalate', 'refunds.view',
      'refunds.request', 'offers.grant', 'emails.view', 'link.support', 'support.diagnostics', 'ops.view', 'trials.view']
    when 'senior' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
      'people.change_owner', 'business.close', 'licences.view', 'support.view', 'support.reply', 'support.assign', 'support.saved_replies',
      'support.escalate', 'support.level2', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'emails.manage', 'link.support', 'reports.view',
      'support.diagnostics', 'ops.view', 'test_accounts.manage']
    when 'sales' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'licences.view', 'support.view', 'offers.grant']
    when 'developer' then array['overview.view', 'downloads.view', 'support.diagnostics', 'ops.view'] end $$;
create function pg_temp.sorted(a text[]) returns text[] language sql as $$ select array(select distinct x from unnest(a) x order by 1) $$;
create function pg_temp.expect(r text) returns text[] language sql as $$
  select pg_temp.sorted(pg_temp.legacy(r) || case when 'licences.manage' = any(pg_temp.legacy(r)) then array['invoices.email'] else '{}' end) $$;
insert into auth.users (id, email) select ('e0e0e0e0-0000-4000-8000-00000000000' || i)::uuid, 'role' || i || '@riyeser.test' from generate_series(1, 9) i;
insert into public.hq_staff (user_id, display_name, role) values
  ('e0e0e0e0-0000-4000-8000-000000000001', 'R Owner', 'owner'), ('e0e0e0e0-0000-4000-8000-000000000002', 'R Admin', 'admin'),
  ('e0e0e0e0-0000-4000-8000-000000000003', 'R Finance', 'finance'), ('e0e0e0e0-0000-4000-8000-000000000004', 'R Support', 'support'),
  ('e0e0e0e0-0000-4000-8000-000000000005', 'R Senior', 'senior'), ('e0e0e0e0-0000-4000-8000-000000000006', 'R Sales', 'sales'),
  ('e0e0e0e0-0000-4000-8000-000000000007', 'R Developer', 'developer');
do $$ declare r text; i int := 0; begin
  -- the seven built-in roles are there once, marked built in, in the usual order
  assert (select array_agg(key order by sort) from public.hq_roles where builtin) = array['owner', 'admin', 'finance', 'support', 'senior', 'sales', 'developer'], 'built-in roles';
  assert (select count(*) from public.hq_roles where builtin) = 7, 'seeded once (team-chat.sql was run twice)';
  assert pg_temp.sorted(public.hq_all_perms()) = pg_temp.sorted(pg_temp.legacy_all() || array['invoices.email']), 'one new permission: invoices.email';
  foreach r in array array['owner', 'admin', 'finance', 'support', 'senior', 'sales', 'developer'] loop
    i := i + 1;
    assert pg_temp.sorted(public.hq_staff_perms(('e0e0e0e0-0000-4000-8000-00000000000' || i)::uuid)) = pg_temp.expect(r),
      'built-in role ' || r || ' unchanged: ' || array_to_string(public.hq_staff_perms(('e0e0e0e0-0000-4000-8000-00000000000' || i)::uuid), ',');
    assert pg_temp.sorted(public.hq_role_perms(r)) = pg_temp.expect(r), 'hq_role_perms ' || r;
    assert pg_temp.sorted(public.hq_builtin_perms(r)) = pg_temp.expect(r), 'shipped ticks ' || r;
    assert pg_temp.sorted(public.hq_legacy_role_perms(r)) = pg_temp.sorted(pg_temp.legacy(r)) or r = 'owner', 'legacy list kept ' || r;
  end loop;
  assert not exists (select 1 from public.hq_role_permissions where role_key = 'owner'), 'nothing stored for the Owner role (always everything)';
  -- per-person extras work as before: role + ticked on - ticked off
  update public.hq_staff set perms_add = array['audit.view'], perms_remove = array['offers.grant'] where user_id = 'e0e0e0e0-0000-4000-8000-000000000006';
  assert public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000006') = pg_temp.sorted(array_remove(pg_temp.legacy('sales'), 'offers.grant') || array['audit.view']), 'extras as before';
  update public.hq_staff set perms_add = '{}', perms_remove = '{}' where user_id = 'e0e0e0e0-0000-4000-8000-000000000006';
end $$;
-- (as Sam, the HQ Owner, but as the database owner so the checks can read the tables; security-test.sql calls these as a
-- signed-in person)
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare t json; k text; k2 text; r json; begin
  t := public.hq_team();
  assert json_array_length(t -> 'role_list') >= 7 and (t -> 'role_list' -> 0 ->> 'key') = 'owner' and (t -> 'role_list' -> 0 ->> 'builtin')::boolean, 'role list, built-in first';
  assert (select x ->> 'people' from json_array_elements(t -> 'role_list') x where x ->> 'key' = 'finance')::int >= 2, 'people per role';
  assert (t -> 'owner_only')::text = '["invoices.email"]', 'owner-only permissions listed';
  assert (select count(*) from json_array_elements(t -> 'staff') x where x ->> 'role_name' is null) = 0, 'everyone''s role has a name';
  -- create a role: name, description, ticks
  k := public.hq_role_save(null, 'Billing helper', 'Looks after invoices and payments, no refunds', array['overview.view', 'customers.view', 'licences.view', 'invoices.email']);
  assert k like 'c\_%', 'custom key: ' || k;
  assert (select name from public.hq_roles where key = k) = 'Billing helper' and not (select builtin from public.hq_roles where key = k), 'saved';
  -- names are unique (built-in ones too), and built-in roles keep theirs
  begin perform public.hq_role_save(null, 'billing HELPER', '', array['overview.view']); raise exception 'duplicate name';
  exception when others then assert sqlerrm like 'There''s already a role called%', sqlerrm; end;
  begin perform public.hq_role_save(null, 'Finance', '', array['overview.view']); raise exception 'built-in name reused';
  exception when others then assert sqlerrm like 'There''s already a role called%', sqlerrm; end;
  begin perform public.hq_role_save('sales', 'Sales team', '', array['overview.view']); raise exception 'built-in renamed';
  exception when others then assert sqlerrm like 'Built-in roles keep their names%', sqlerrm; end;
  begin perform public.hq_role_save(null, '  ', '', array['overview.view']); raise exception 'no name';
  exception when others then assert sqlerrm like 'Give the role a name%', sqlerrm; end;
  begin perform public.hq_role_save(null, 'Odd', '', array['made.up']); raise exception 'unknown permission';
  exception when others then assert sqlerrm like 'Unknown permission: made.up%', sqlerrm; end;
  -- duplicate a built-in one (the page sends its ticks under a new name)
  k2 := public.hq_role_save(null, 'Support (nights)', 'Support, without two-step sign-in resets', array_remove(public.hq_role_perms('support'), 'people.reset_2fa'));
  -- the Owner may change a built-in role's ticks; people with it follow
  perform public.hq_role_save('developer', 'Developer', 'Diagnostics and operations', public.hq_role_perms('developer') || array['audit.view']);
  assert 'audit.view' = any(public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000007')), 'a role change reaches its people';
  perform public.hq_role_save('developer', 'Developer', 'The overview, downloads, sanitised diagnostic reports and system operations. No customer list.', public.hq_builtin_perms('developer'));
  assert public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000007') = pg_temp.expect('developer'), 'back to the standard ticks';
  -- a standard role for a person, then tick or untick: only the difference is kept, and the person shows as customised
  r := public.hq_set_staff_access('e0e0e0e0-0000-4000-8000-000000000004', 'support',
         array_remove(public.hq_role_perms('support'), 'people.reset_2fa') || array['business.close']);
  assert (r -> 'perms_add')::text = '["business.close"]' and (r -> 'perms_remove')::text = '["people.reset_2fa"]', 'only the difference: ' || r::text;
  assert (select perms_add = array['business.close'] and perms_remove = array['people.reset_2fa'] from public.hq_staff where user_id = 'e0e0e0e0-0000-4000-8000-000000000004'), 'stored';
  assert 'business.close' = any(public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000004')) and not 'people.reset_2fa' = any(public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000004')), 'effective';
  -- Reset to standard (perms null)
  perform public.hq_set_staff_access('e0e0e0e0-0000-4000-8000-000000000004', 'support', null);
  assert public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000004') = pg_temp.expect('support')
     and (select perms_add = '{}' and perms_remove = '{}' from public.hq_staff where user_id = 'e0e0e0e0-0000-4000-8000-000000000004'), 'reset to standard';
  -- a custom role for someone (with emailing invoices: the Owner may give it, SEC-010)
  perform public.hq_set_staff_access('e0e0e0e0-0000-4000-8000-000000000006', k, null);
  perform public.hq_set_staff_access('e0e0e0e0-0000-4000-8000-000000000005', k2, null);
  assert public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000006') = pg_temp.sorted(array['overview.view', 'customers.view', 'licences.view', 'invoices.email']), 'custom role';
  -- adding someone with a custom role works too
  perform public.hq_add_staff('role8@riyeser.test', 'R Eight', k2);
  -- removing a role that still has people asks where they go
  begin perform public.hq_role_delete(k, null); raise exception 'removed a role with people';
  exception when others then assert sqlerrm like 'Some people still have this role (1). Choose a role to move them to first.%', sqlerrm; end;
  begin perform public.hq_role_delete(k, k); raise exception 'moved to itself';
  exception when others then assert sqlerrm like 'Choose another role%', sqlerrm; end;
  begin perform public.hq_role_delete('sales', 'support'); raise exception 'removed a built-in role';
  exception when others then assert sqlerrm like 'Built-in HQ roles can''t be removed%', sqlerrm; end;
  assert public.hq_role_delete(k, 'sales') = 1, 'one person moved';
  assert (select role from public.hq_staff where user_id = 'e0e0e0e0-0000-4000-8000-000000000006') = 'sales'
     and public.hq_staff_perms('e0e0e0e0-0000-4000-8000-000000000006') = pg_temp.expect('sales'), 'moved, with the standard ticks';
  assert not exists (select 1 from public.hq_roles where key = k) and not exists (select 1 from public.hq_role_permissions where role_key = k), 'gone';
  assert public.hq_role_delete(public.hq_role_save(null, 'Empty one', '', '{}'), null) = 0, 'a role nobody has goes straight away';
end $$;
reset role;
do $$ begin
  -- the HQ history: who, and before and after, for every role change and assignment
  assert exists (select 1 from pg_temp.audit('role.created') a where a.details ->> 'name' = 'Billing helper' and a.actor = '99999999-9999-9999-9999-999999999999'
     and a.details -> 'after' -> 'perms' ? 'invoices.email'), 'role.created';
  assert exists (select 1 from pg_temp.audit('role.changed') a where a.details ->> 'role' = 'developer' and a.details -> 'after' -> 'perms' ? 'audit.view'
     and not a.details -> 'before' -> 'perms' ? 'audit.view'), 'role.changed before/after';
  assert exists (select 1 from pg_temp.audit('staff.access') a where a.details ->> 'user_id' = 'e0e0e0e0-0000-4000-8000-000000000004'
     and a.details -> 'after' -> 'added' ? 'business.close' and a.details -> 'before' -> 'perms' ? 'people.reset_2fa' and not a.details -> 'after' -> 'perms' ? 'people.reset_2fa'), 'staff.access before/after';
  assert exists (select 1 from pg_temp.audit('staff.access') a where a.details ->> 'why' = 'role.deleted' and a.details -> 'after' ->> 'role' = 'sales'), 'the move is in the history';
  assert exists (select 1 from pg_temp.audit('role.deleted') a where a.details ->> 'name' = 'Billing helper' and a.details ->> 'moved_to' = 'sales' and (a.details ->> 'moved')::int = 1), 'role.deleted';
  assert exists (select 1 from pg_temp.audit('staff.added') a where a.details ->> 'email' = 'role8@riyeser.test' and a.details -> 'perms' is not null), 'staff.added with permissions';
end $$;
-- staff changed through the older functions are in the history with before and after too
set role authenticated;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_set_staff('e0e0e0e0-0000-4000-8000-000000000003', 'finance', false);
select public.hq_set_staff('e0e0e0e0-0000-4000-8000-000000000003', 'finance', true);
reset role;
do $$ begin
  assert exists (select 1 from pg_temp.audit('staff.changed') a where a.details ->> 'user_id' = 'e0e0e0e0-0000-4000-8000-000000000003'
     and (a.details -> 'before' ->> 'active')::boolean and not (a.details -> 'after' ->> 'active')::boolean and jsonb_array_length(a.details -> 'after' -> 'perms') = 0), 'switched off: before/after';
end $$;

-- ================================================================ PAYPAL-LIVE: practice (sandbox) payments once PayPal is live, Buy now
-- Practice Co (Pita, owner) paid by PayPal's practice site (sandbox) before PayPal went live, and paid POS by bank transfer.
-- Then PayPal goes live: the practice subscription must not block a real one, never links to PayPal's practice site, can be
-- removed on Riyeser's side only, and only the HQ Owner clears the practice paid time (audited, reversible, live untouched).
-- Buy Now Co (Bree) buys now: charged today, the trial ends when PayPal confirms the first payment.
reset role;
insert into auth.users (id, email) values ('d1d1d1d1-0000-4000-8000-000000000001', 'pita@practice.test'), ('d1d1d1d1-0000-4000-8000-000000000002', 'bree@buynow.test');
do $$ declare a uuid; b uuid; begin
  insert into public.workspaces (name) values ('Practice Co') returning id into a;
  insert into public.workspaces (name) values ('Buy Now Co') returning id into b;
  insert into public.members (workspace_id, user_id, display_name, role) values (a, 'd1d1d1d1-0000-4000-8000-000000000001', 'Pita', 'owner'),
    (b, 'd1d1d1d1-0000-4000-8000-000000000002', 'Bree', 'owner');
  perform set_config('pl.a', a::text, false), set_config('pl.b', b::text, false), set_config('pl.te', (current_date + 90)::text, false);
  insert into public.hq_settings (key, value) values ('paypal.env', 'sandbox') on conflict (key) do update set value = excluded.value;
end $$;
set role authenticated;
select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pl.a')::uuid; o json; begin
  o := public.billing_start(a, array['pos'], 3, 'monthly', 'bank');
  perform set_config('pl.bank', o ->> 'ref', false), set_config('pl.banktotal', o ->> 'total', false);
  o := public.billing_start(a, array['basic', 'payroll'], 3, 'monthly', 'paypal');
  perform set_config('pl.op', o ->> 'id', false), set_config('pl.opref', o ->> 'ref', false), set_config('pl.optotal', o ->> 'total', false);
end $$;
reset role; set role service_role;
select public.billing_paypal_created(current_setting('pl.op')::uuid, 'I-PRACTICE00001', 'sandbox');
select public.billing_paypal_event('PL-1', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id": "I-PRACTICE00001", "status": "ACTIVE"}', 'sandbox');
select public.billing_paypal_event('PL-2', 'PAYMENT.SALE.COMPLETED', json_build_object('id', 'SALE-PRAC-1', 'billing_agreement_id', 'I-PRACTICE00001',
  'amount', json_build_object('total', current_setting('pl.optotal'), 'currency', 'USD'))::jsonb, 'sandbox');
reset role;
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
select public.hq_billing_mark_paid(current_setting('pl.bank'), 'PRACTICE CO BANK 1', current_setting('pl.banktotal')::numeric);
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; te date := current_setting('pl.te')::date; begin
  assert (select paid_until from public.company_modules where workspace_id = a and module = 'basic') = (te + interval '1 month')::date, 'practice payment: basic paid from the trial end';
  assert (select trial_ends_before ->> 'basic' from public.billing_orders where id = current_setting('pl.op')::uuid) = te::text, 'PAYPAL-LIVE the trial end before paying is kept';
  assert (select status from public.company_modules where workspace_id = a and module = 'pos') = 'active', 'POS paid by bank';
end $$;
-- still practice mode: the practice subscription is the subscription (and blocks a second one), with the practice site's link
set role authenticated; select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pl.a')::uuid; b json := public.my_billing(a); begin
  assert b -> 'subscription' ->> 'ref' = current_setting('pl.opref') and b ->> 'practice_subscription' is null, 'sandbox: the practice subscription is the subscription';
  assert b ->> 'paypal_manage_url' like 'https://www.sandbox.paypal.com/%', 'sandbox: the practice site';
  begin perform public.billing_start(a, array['bookings'], 3, 'monthly', 'paypal'); raise exception 'two in sandbox';
  exception when others then assert sqlerrm like 'You already pay by PayPal%', sqlerrm; end;
end $$;
-- PayPal goes live: the paypal function tells the database (service role only)
do $$ begin
  begin perform public.billing_paypal_env_now('live'); raise exception 'a signed-in person set the PayPal env';
  exception when insufficient_privilege then null; end;
end $$;
reset role; set role service_role;
do $$ begin
  begin perform public.billing_paypal_env_now('pretend'); raise exception 'bad env taken'; exception when others then assert sqlerrm = 'bad env', sqlerrm; end;
end $$;
select public.billing_paypal_env_now('live');
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; begin
  assert public.billing_paypal_live(), 'PAYPAL-LIVE the database knows PayPal is live';
  perform set_config('pl.live_before', (select md5(string_agg(o::text, '|' order by o.id)) from public.billing_orders o where o.workspace_id = a and o.paypal_env is distinct from 'sandbox'), false);
end $$;
set role authenticated; select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pl.a')::uuid; b json := public.my_billing(a); q json; o json; o2 json; te date := current_setting('pl.te')::date; c json; begin
  assert b ->> 'subscription' is null, 'PAYPAL-LIVE a practice subscription is not "you already pay by PayPal" once live: ' || coalesce(b ->> 'subscription', 'null');
  assert b -> 'practice_subscription' ->> 'ref' = current_setting('pl.opref') and (b -> 'practice_subscription' ->> 'practice')::boolean, 'PAYPAL-LIVE it comes as the practice subscription';
  assert b ->> 'paypal_manage_url' not like '%sandbox%' and b::text not like '%sandbox.paypal.com%', 'PAYPAL-LIVE never a link to PayPal''s practice site once live';
  assert b ->> 'paypal_env' = 'live', 'the env';
  assert (select count(*) from json_array_elements_text(b -> 'practice_modules') x where x in ('basic', 'payroll')) = 2
     and not exists (select 1 from json_array_elements_text(b -> 'practice_modules') x where x = 'pos'), 'PAYPAL-LIVE practice-only programs listed (not the bank-paid POS)';
  assert (select bool_and((x ->> 'practice')::boolean) from json_array_elements(b -> 'payments') x where x ->> 'method' = 'paypal')
     and (select bool_and(not (x ->> 'practice')::boolean) from json_array_elements(b -> 'payments') x where x ->> 'method' = 'bank'), 'PAYPAL-LIVE practice payments labelled in the history';
  -- quotes: the practice paid time doesn't delay a real first charge (option A, for paying), the bank-paid POS still does
  q := public.billing_quote(a, array['basic'], 3, 'monthly');
  assert (q ->> 'charge_from')::date = te and not (q ->> 'charged_today')::boolean, 'PAYPAL-LIVE real first charge at the trial end, not after the practice paid time: ' || q::text;
  q := public.billing_quote(a, array['pos'], 3, 'monthly');
  assert (q ->> 'charge_from')::date = (b -> 'licence' -> 'modules' -> 'pos' ->> 'paid_until')::date, 'bank-paid time still counts';
  -- the owner's own small real test: subscribe to one program (default: the first payment when its trial ends)
  o := public.billing_start(a, array['bookings'], 3, 'monthly', 'paypal');
  o2 := public.billing_start(a, array['bookings'], 3, 'monthly', 'paypal');   -- a double click: the same order (one PayPal subscription)
  assert o ->> 'id' = o2 ->> 'id', 'PAYPAL-LIVE a double click gives one order';
  assert (o ->> 'starts_on')::date = te and not (o ->> 'buy_now')::boolean, 'PAYPAL-LIVE default: the first payment waits for the trial end';
  perform set_config('pl.ol', o ->> 'id', false), set_config('pl.olref', o ->> 'ref', false), set_config('pl.oltotal', o ->> 'total', false);
  c := public.billing_cancel_start(a);
  assert c ->> 'env' = 'sandbox' and (c ->> 'practice')::boolean, 'only the practice one to cancel yet: the function is told it''s practice';
end $$;
reset role; set role service_role;
select public.billing_paypal_created(current_setting('pl.ol')::uuid, 'I-LIVEPAYCO0001', 'live');
select public.billing_paypal_created(current_setting('pl.ol')::uuid, 'I-LIVEPAYCO0001', 'live');   -- the double click's second call: fine
select public.billing_paypal_event('PL-3', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id": "I-LIVEPAYCO0001", "status": "ACTIVE"}', 'live');
reset role;
set role authenticated; select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');
do $$ declare a uuid := current_setting('pl.a')::uuid; b json := public.my_billing(a); c json; begin
  assert b -> 'subscription' ->> 'ref' = current_setting('pl.olref') and b -> 'subscription' ->> 'status' = 'active', 'the real subscription is the subscription';
  assert b ->> 'paypal_manage_url' = 'https://www.paypal.com/myaccount/autopay/', 'the real PayPal';
  c := public.billing_cancel_start(a);
  assert c ->> 'env' = 'live' and c ->> 'subscription_id' = 'I-LIVEPAYCO0001', 'cancel picks the real one first';
  -- removing the practice subscription: Riyeser's side only (no PayPal call: this isn't the paypal function)
  begin perform public.billing_practice_cancel(current_setting('pl.b')::uuid); raise exception 'removed another business''s';
  exception when others then assert sqlerrm like 'Only the business owner%', sqlerrm; end;
  perform public.billing_practice_cancel(a);
  assert (select x ->> 'status' from json_array_elements(public.my_billing(a) -> 'orders') x where x ->> 'id' = current_setting('pl.op')) = 'cancelled', 'PAYPAL-LIVE practice subscription removed';
  assert (select x ->> 'status' from json_array_elements(public.my_billing(a) -> 'orders') x where x ->> 'id' = current_setting('pl.ol')) = 'active', 'the live one untouched';
  assert public.my_billing(a) ->> 'practice_subscription' is null, 'gone from billing';
  begin perform public.billing_practice_cancel(a); raise exception 'removed twice';
  exception when others then assert sqlerrm like 'There''s no practice subscription%', sqlerrm; end;
end $$;
select pg_temp.as_user_password_only('d1d1d1d1-0000-4000-8000-000000000001');
do $$ begin begin perform public.billing_practice_cancel(current_setting('pl.a')::uuid); raise exception 'no two-step';
  exception when others then assert sqlerrm like 'Turn on two-step sign-in%', sqlerrm; end; end $$;
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; begin
  perform set_config('pl.live_before', (select md5(string_agg(o::text, '|' order by o.id)) from public.billing_orders o where o.workspace_id = a and o.paypal_env is distinct from 'sandbox'), false);
  perform set_config('pl.pos_before', (select row(c.*)::text from public.company_modules c where c.workspace_id = a and c.module = 'pos'), false);
  perform set_config('pl.basic_before', (select row(c.*)::text from public.company_modules c where c.workspace_id = a and c.module = 'basic'), false);
end $$;
-- HQ: practice businesses listed for the Owner; only the HQ Owner clears (Finance, Sales, the Owner without two-step: no)
set role authenticated; select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare h json := public.hq_billing(); n json := public.hq_attention(); c json := public.hq_company_billing(current_setting('pl.a')::uuid); begin
  assert exists (select 1 from json_array_elements(h -> 'practice_businesses') x where x ->> 'business' = 'Practice Co'), 'PAYPAL-LIVE HQ lists businesses with practice payments';
  assert (h ->> 'can_clear_practice')::boolean and (c -> 'practice' ->> 'can_clear')::boolean and json_array_length(c -> 'practice' -> 'orders') = 1, 'the Owner can clear';
  assert (n ->> 'practice_to_clear')::int >= 1 and n ->> 'bank_missing' = 'false', 'Needs attention: practice payments to clear; bank details are in: ' || n::text;
  -- the Overview calls hq_attention(include_test): the same two items are there, with or without test accounts
  assert (public.hq_attention(false) ->> 'practice_to_clear')::int = (n ->> 'practice_to_clear')::int and public.hq_attention(false) ->> 'bank_missing' = 'false'
     and (public.hq_attention(true) ->> 'practice_to_clear')::int = (n ->> 'practice_to_clear')::int, 'hq_attention(boolean) has them too';
end $$;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');   -- Fina (finance)
do $$ declare n json := public.hq_attention(); begin
  begin perform public.hq_billing_clear_practice(current_setting('pl.a')::uuid); raise exception 'finance cleared';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
  begin perform public.hq_billing_restore_practice(current_setting('pl.a')::uuid); raise exception 'finance restored';
  exception when others then assert sqlerrm like 'Your HQ role can''t do that.%', sqlerrm; end;
  assert n ->> 'bank_missing' is null and n ->> 'practice_to_clear' is null and not (public.hq_billing() ->> 'can_clear_practice')::boolean, 'not the Owner: no such items';
  assert public.hq_attention(false) ->> 'bank_missing' is null and public.hq_attention(false) ->> 'practice_to_clear' is null, 'not the Owner: hq_attention(boolean) neither';
end $$;
select pg_temp.as_user_password_only('99999999-9999-9999-9999-999999999999');
do $$ begin begin perform public.hq_billing_clear_practice(current_setting('pl.a')::uuid); raise exception 'owner without two-step';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;
select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');   -- the business owner isn't HQ
do $$ begin begin perform public.hq_billing_clear_practice(current_setting('pl.a')::uuid); raise exception 'customer cleared';
  exception when others then assert sqlerrm like 'Riyeser HQ is for%', sqlerrm; end; end $$;
reset role;
do $$ begin assert not exists (select 1 from public.hq_audit where action = 'billing.practice_cleared'), 'nothing cleared by the refusals'; end $$;
-- the Owner clears: practice orders void (test), practice-paid programs back to their free trial, live and bank untouched
set role authenticated; select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ declare a uuid := current_setting('pl.a')::uuid; r json; te date := current_setting('pl.te')::date; begin
  r := public.hq_billing_clear_practice(a);
  assert (r -> 'orders' ->> 0) = current_setting('pl.opref'), 'cleared the practice order: ' || r::text;
  assert r -> 'licence' -> 'basic' ->> 'status' = 'trial' and (r -> 'licence' -> 'basic' ->> 'trial_ends')::date = te, 'PAYPAL-LIVE basic back on its free trial to ' || te;
  assert r -> 'licence' -> 'payroll' ->> 'status' = 'trial', 'payroll too';
  begin perform public.hq_billing_clear_practice(a); raise exception 'cleared twice';
  exception when others then assert sqlerrm like 'This business has no practice%', sqlerrm; end;
end $$;
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; begin
  assert (select status from public.billing_orders where id = current_setting('pl.op')::uuid) = 'void'
     and (select practice_status_before from public.billing_orders where id = current_setting('pl.op')::uuid) = 'cancelled', 'PAYPAL-LIVE practice order void (test), its status kept';
  assert (select md5(string_agg(o::text, '|' order by o.id)) from public.billing_orders o where o.workspace_id = a and o.paypal_env is distinct from 'sandbox') = current_setting('pl.live_before'),
    'PAYPAL-LIVE live and bank orders untouched';
  assert (select row(c.*)::text from public.company_modules c where c.workspace_id = a and c.module = 'pos') = current_setting('pl.pos_before'), 'bank-paid POS untouched';
  assert (select count(*) from public.billing_payments where workspace_id = a) = 2, 'payments kept (never deleted)';
  assert exists (select 1 from public.hq_audit where action = 'billing.practice_cleared' and workspace_id = a and actor = '99999999-9999-9999-9999-999999999999'
     and details -> 'orders' ->> 0 = current_setting('pl.opref') and details -> 'before' -> 'basic' ->> 'status' = 'cancelled' and details -> 'before' -> 'basic' ->> 'paid_until' is not null and details -> 'after' -> 'basic' ->> 'status' = 'trial'),
    'PAYPAL-LIVE in the HQ history: who, which orders, before and after: ' || (select string_agg(actor::text || ' ' || details::text, ' / ') from public.hq_audit where action = 'billing.practice_cleared');
end $$;
set role authenticated; select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000001');
do $$ declare b json := public.my_billing(current_setting('pl.a')::uuid); begin
  assert json_array_length(b -> 'practice_modules') = 0 and b -> 'licence' -> 'modules' -> 'basic' ->> 'status' = 'trial', 'the owner sees the trial again';
  assert exists (select 1 from json_array_elements(b -> 'orders') x where x ->> 'ref' = current_setting('pl.opref') and (x ->> 'practice')::boolean and x ->> 'practice_cleared_at' is not null),
    'the cleared practice order still shows, as practice';
end $$;
-- the Owner can put it back exactly; and once a real payment has come in since, can't
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_billing_restore_practice(current_setting('pl.a')::uuid);
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; begin
  assert (select (c.status, c.paid_until, c.trial_ends)::text from public.company_modules c where c.workspace_id = a and c.module = 'basic')
     = (select (c.status, c.paid_until, c.trial_ends)::text from (select (current_setting('pl.basic_before')::public.company_modules).*) c), 'PAYPAL-LIVE put back exactly: basic as it was';
  assert (select status from public.billing_orders where id = current_setting('pl.op')::uuid) = 'cancelled' and exists (select 1 from public.hq_audit where action = 'billing.practice_restored' and workspace_id = a), 'order back, in the history';
end $$;
set role authenticated; select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_billing_clear_practice(current_setting('pl.a')::uuid);
reset role; set role service_role;
select public.billing_paypal_event('PL-4', 'PAYMENT.SALE.COMPLETED', json_build_object('id', 'SALE-LIVE-1', 'billing_agreement_id', 'I-LIVEPAYCO0001',
  'amount', json_build_object('total', current_setting('pl.oltotal'), 'currency', 'USD'))::jsonb, 'live');
reset role;
set role authenticated; select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
do $$ begin begin perform public.hq_billing_restore_practice(current_setting('pl.a')::uuid); raise exception 'restored over a real payment';
  exception when others then assert sqlerrm like 'A real payment came in after%', sqlerrm; end; end $$;
reset role;
do $$ declare a uuid := current_setting('pl.a')::uuid; te date := current_setting('pl.te')::date; begin
  assert (select paid_until from public.company_modules where workspace_id = a and module = 'bookings') = (te + interval '1 month')::date, 'the real payment: bookings from its trial end';
  assert (select status from public.company_modules where workspace_id = a and module = 'basic') = 'trial', 'basic stays on its trial';
end $$;
-- Buy now (Buy Now Co): charged today; the trial ends only when PayPal confirms the first payment; the default still waits
set role authenticated; select pg_temp.as_user('d1d1d1d1-0000-4000-8000-000000000002');
do $$ declare b uuid := current_setting('pl.b')::uuid; q json; o json; begin
  q := public.billing_quote(b, array['plus'], 3, 'monthly');
  assert not (q ->> 'charged_today')::boolean and (q ->> 'charge_from')::date = current_setting('pl.te')::date, 'default: first payment when the trial ends';
  q := public.billing_quote(b, array['plus'], 3, 'monthly', null, 1, true);
  assert (q ->> 'charged_today')::boolean and (q ->> 'charge_from')::date = current_date and (q ->> 'buy_now')::boolean and (q ->> 'trial_days_left')::int = 90,
    'PAYPAL-LIVE buy now: charged today, 90 free days end today: ' || q::text;
  o := public.billing_start(b, array['plus'], 3, 'monthly', 'paypal', null, 1, true);
  assert (o ->> 'starts_on')::date = current_date and (o ->> 'buy_now')::boolean, 'PAYPAL-LIVE buy now order starts today (the function sends no later start_time)';
  perform set_config('pl.bn', o ->> 'id', false), set_config('pl.bntotal', o ->> 'total', false);
end $$;
reset role; set role service_role;
select public.billing_paypal_created(current_setting('pl.bn')::uuid, 'I-BUYNOW0000001', 'live');
select public.billing_paypal_event('PL-5', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id": "I-BUYNOW0000001", "status": "ACTIVE"}', 'live');
reset role;
do $$ begin assert public.module_state(current_setting('pl.b')::uuid, 'plus') ->> 'status' = 'trial', 'buy now: still the trial until PayPal confirms the money'; end $$;
set role service_role;
select public.billing_paypal_event('PL-6', 'PAYMENT.SALE.COMPLETED', json_build_object('id', 'SALE-BUYNOW-1', 'billing_agreement_id', 'I-BUYNOW0000001',
  'amount', json_build_object('total', current_setting('pl.bntotal'), 'currency', 'USD'))::jsonb, 'live');
reset role;
do $$ declare b uuid := current_setting('pl.b')::uuid; o public.billing_orders; begin
  select * into o from public.billing_orders where id = current_setting('pl.bn')::uuid;
  assert public.module_state(b, 'plus') ->> 'status' = 'active' and (public.module_state(b, 'plus') ->> 'paid_until')::date = (current_date + interval '1 month')::date,
    'PAYPAL-LIVE buy now: paid from today (the trial ended today): ' || (public.module_state(b, 'plus'))::text;
  assert o.trial_ends_before ->> 'plus' = current_setting('pl.te') and o.paid_through = (current_date + interval '1 month')::date, 'the trial it ended is recorded';
  assert (select trial_ends from public.company_modules where workspace_id = b and module = 'basic') is null
     and public.module_state(b, 'basic') ->> 'status' = 'trial', 'PAYPAL-LIVE only the programs bought now: Basics still on its trial';
end $$;
set role authenticated; select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
do $$ declare c json := public.hq_company_billing(current_setting('pl.b')::uuid); begin
  assert (select (x ->> 'buy_now')::boolean and x -> 'trial_ends_before' ->> 'plus' is not null from json_array_elements(c -> 'orders') x where x ->> 'method' = 'paypal'), 'HQ sees Bought now (ended trial early)';
end $$;
reset role;
-- back to practice mode for anything after this
update public.hq_settings set value = 'sandbox' where key = 'paypal.env';

select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
