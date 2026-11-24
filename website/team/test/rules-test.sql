\set ON_ERROR_STOP on
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
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
do $$ begin
  assert (select company_code from public.workspaces where name = 'Island Traders') ~ '^RIY-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$', 'company code format';
  assert (select tax_number from public.workspaces where name = 'Island Traders') = '50-12345-0-1', 'profile saved';
  assert (select job_role from public.members where user_id = auth.uid() and workspace_id = (select id from public.workspaces where name = 'Island Traders')) = 'owner', 'owner job role';
end $$;
select public.create_branch(:'ws_c', 'Nadi branch') as nadi \gset
select code as nadi_code from public.branches where id = :'nadi' \gset
select set_config('test.nadi_code', :'nadi_code', false);
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

-- A's owner still has exactly the messages A wrote (B's attempt didn't land)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert not exists (select 1 from public.messages where body = 'hack'), 'no hack message'; end $$;
reset role;
select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
