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
insert into auth.users values ('99999999-9999-9999-9999-999999999999', 'riki@riyeser.test'), ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'help@riyeser.test');
-- only the database owner (SQL Editor) can make the first owner: a normal signed-in user can't
select pg_temp.as_user('99999999-9999-9999-9999-999999999999'); set role authenticated;
do $$ begin
  begin perform public.hq_make_owner('riki@riyeser.test', 'Riki'); raise exception 'made self owner';
  exception when insufficient_privilege then null; end;
  begin perform public.hq_overview(); raise exception 'non-staff saw HQ';
  exception when others then assert sqlerrm like 'Riyeser HQ is for Riyeser staff%', sqlerrm; end;
  begin perform count(*) from public.hq_staff; raise exception 'read staff table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select public.hq_make_owner('riki@riyeser.test', 'Riki');
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
-- HQ (Riki, owner): Basics paid for a year, POS trial extended, Payroll cancelled; 2 extra users; yearly
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
-- close as a duplicate
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');
select public.hq_close_duplicate((select id from public.hq_companies('Early bird 2') where name = 'Early bird 2'), (select id from public.hq_companies('Early bird 1') where name = 'Early bird 1'), 'Signed up twice', null);
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
do $$ begin begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'Accounting Basics', 'November', null, 50, 'FJD', 'mistake', 'x', null);
  raise exception 'a member asked for a refund';
  exception when others then assert sqlerrm like 'Only the business''s owner can%', sqlerrm; end; end $$;
-- an admin (Mere, with two-step sign-in) can't ask for one either
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
do $$ begin assert (select role from public.members where workspace_id = current_setting('test.ws_c')::uuid and user_id = auth.uid()) = 'admin', 'Mere is an admin';
  begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'Accounting Basics', 'November', null, 50, 'FJD', 'mistake', 'x', null);
  raise exception 'an admin asked for a refund';
  exception when others then assert sqlerrm like 'Only the business''s owner can%', sqlerrm; end; end $$;
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
select (public.request_refund(:'ws_c', 'Accounting Basics', 'November 2026', 'INV-0042', 350, 'FJD', 'duplicate', 'We were charged twice this month.', null) ->> 'id') as rf \gset
select (public.request_refund(:'ws_c', 'POS', 'October 2026', null, 50, 'FJD', 'didnt_work', 'The till never worked for us.', null) ->> 'id') as rf2 \gset
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
  assert (public.credit_json(current_setting('test.ws_c')::uuid) ->> 'FJD')::numeric = 350, 'credit on account';
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
  r := public.link_command(current_setting('test.ws_l')::uuid, 'office-0001-abcd', 'reveal_password', jsonb_build_object('extension', '101', 'key', jsonb_build_object('kty', 'RSA', 'n', repeat('D', 342), 'e', 'AQAB')));
  perform set_config('test.hqrev', r::text, false);
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.link_office_commands where by_riyeser) = 2, 'marked as Riyeser';
  assert exists (select 1 from public.hq_audit where action = 'link.reveal_password' and workspace_id = current_setting('test.ws_l')::uuid), 'HQ Show in the HQ history';
  assert exists (select 1 from public.hq_audit where action = 'link.support_allowed' and workspace_id = current_setting('test.ws_l')::uuid), 'allowing it is in the HQ history';
  assert exists (select 1 from public.audit_log where action = 'link.reveal_password' and actor is null and details ->> 'by' = 'Riyeser support'), 'customer sees "Riyeser support" showed it';
end $$;
select pg_temp.as_user_password_only('c0c0c0c0-0000-4000-8000-000000000003'); set role authenticated;
select public.link_office_done(current_setting('test.hqrev')::uuid, true, null, 'SFFTaG93bg==');
-- the customer ends it early: support can't take the password or send more
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000001');
select public.link_support_end(:'ws_l');
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-000000000005');
do $$ begin
  begin perform public.link_reveal_take(current_setting('test.hqrev')::uuid); raise exception 'took a password after access ended';
  exception when others then assert sqlerrm like 'You can''t see this business''s phone passwords any more%', sqlerrm; end;
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
select pg_temp.as_user('99999999-9999-9999-9999-999999999999');   -- Riki (owner)
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
  assert l::text !~* '"(monthly|price|prices|amount|estimate)"\s*:', format('no money in the licence: %s', l);
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
  assert (select count(*) from public.messages where channel_id = o) = 1, 'its messages are kept and readable';
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
  assert (select string_agg(action || ' ' || (details ->> 'name'), ', ' order by id) from public.audit_log where workspace_id = current_setting('cm.a')::uuid and action like 'channel.%')
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
-- the Billing entity: finance fills it in (with bank details); old invoices keep the old details, new ones get the new
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000005');
select public.hq_set_billing_entity('{"name": "Riyeser Pty Ltd", "address": "1 George St, Sydney NSW", "tax_label": "", "tax_number": "12 345 678 901",
  "email": "accounts@riyeser.test", "bank": {"account_name": "Riyeser Pty Ltd", "bank_name": "Westpac", "bsb": "032-000", "account_number": "123456", "junk": "x"}}');
do $$ declare h json := public.hq_billing(); begin
  assert (h ->> 'bank_ready')::boolean and h -> 'entity' ->> 'tax_label' = 'ABN' and h -> 'entity' -> 'bank' ->> 'junk' is null, 'bank ready, ABN label by default, only known fields';
end $$;
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
-- HQ sales (licences.view, not customers.edit) can send it again, but not change the business's email
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ declare a uuid := current_setting('pay.a')::uuid; r json; p json; begin
  r := public.hq_billing_resend(current_setting('pay.inv1'), null, false);
  assert json_array_length(r -> 'to') = 2, 'resent to the owner and the business email';
  r := public.hq_billing_resend(lower(current_setting('pay.inv1')), ' Right@PayCo.test ', false);
  assert r -> 'to' ->> 0 = 'right@payco.test' and not (r ->> 'contact_updated')::boolean, 'resent to another address';
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), 'not-an-email', false); raise exception 'bad email';
  exception when others then assert sqlerrm like 'Check the email address%', sqlerrm; end;
  begin perform public.hq_billing_resend(current_setting('pay.inv1'), 'x@payco.test', true); raise exception 'sales changed the email';
  exception when others then assert sqlerrm like 'Your HQ role can''t%', sqlerrm; end;
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
  assert exists (select 1 from public.hq_audit where action = 'billing.doc_resent' and workspace_id = a and actor = 'b1b1b1b1-0000-4000-8000-000000000006'
     and details -> 'to' ->> 0 = 'ri…@payco.test' and (details ->> 'other_address')::boolean), 'in the HQ history: who, where (shortened)';
  assert exists (select 1 from public.hq_audit where action = 'billing.doc_resent' and (details ->> 'contact_updated')::boolean
     and actor = 'b1b1b1b1-0000-4000-8000-000000000005'), 'the email change is in the history too';
end $$;
-- HQ Licences: real recurring money, installs per program, and the businesses on a program
set role authenticated;
select pg_temp.as_user('b1b1b1b1-0000-4000-8000-000000000006');
do $$ declare l json := public.hq_licences(); b json; begin
  assert (l ->> 'monthly_recurring')::numeric >= 46 and (l ->> 'recurring_count')::int >= 1, 'monthly recurring: the paid bank invoice still running (' || (l ->> 'monthly_recurring') || ')';
  assert (select count(*) from json_array_elements(l -> 'modules') x where x ->> 'installed' is not null) = 7, 'installs counted for each program';
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
reset role;
select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
