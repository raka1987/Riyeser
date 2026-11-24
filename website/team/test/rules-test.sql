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
  assert m = 20 + 20 + 2 * 5 + 10, format('monthly estimate: Basics 20 + Link Plus 20 (paid earlier) + 2 users 10 + 1 company 10 = 60, got %s', m);
  assert ((public.hq_licences()) ->> 'monthly_estimate')::numeric >= 60, 'total estimate';
  assert ((public.hq_licences()) ->> 'early_bird_left')::int = 100, 'early bird places';
end $$;
-- yearly + early bird: 60 a month list -> x 10/12 -> half = 25
select public.hq_set_plan(:'ws_c', 2, 1, 'yearly', true);
do $$ begin assert ((public.hq_company_licence(current_setting('test.ws_c')::uuid)) ->> 'monthly')::numeric = 25.00, 'yearly early bird'; end $$;
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

-- --- refunds (Island Traders: owner Jone, admin Mere; Vika is a plain member)
insert into auth.users values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'vika@c.test');
insert into public.members (workspace_id, user_id, display_name, role) values (:'ws_c', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'Vika', 'member');
select pg_temp.as_user('ffffffff-ffff-ffff-ffff-ffffffffffff'); set role authenticated;
do $$ begin begin perform public.request_refund(current_setting('test.ws_c')::uuid, 'Accounting Basics', 'November', null, 50, 'FJD', 'mistake', 'x', null);
  raise exception 'a member asked for a refund';
  exception when others then assert sqlerrm like 'Only the business''s owner or an admin%', sqlerrm; end; end $$;
select pg_temp.as_user('77777777-7777-7777-7777-777777777777');
select (public.request_refund(:'ws_c', 'Accounting Basics', 'November 2026', 'INV-0042', 350, 'FJD', 'duplicate', 'We were charged twice this month.', null) ->> 'id') as rf \gset
select (public.request_refund(:'ws_c', 'POS', 'October 2026', null, 50, 'FJD', 'didnt_work', 'The till never worked for us.', null) ->> 'id') as rf2 \gset
select set_config('test.rf', :'rf', false), set_config('test.rf2', :'rf2', false);
do $$ begin
  assert json_array_length(public.my_refunds(current_setting('test.ws_c')::uuid)) = 2, 'owner sees the requests';
  assert (public.my_refunds(current_setting('test.ws_c')::uuid) -> 0 ->> 'ref') ~ '^R-[0-9]{4,}$', 'refund number like R-1042';
  assert exists (select 1 from public.support_tickets where topic = 'billing' and subject like 'Refund request R-%'), 'a billing ticket for the conversation';
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
  assert (q -> 'counts' ->> 'new_signups') is not null and (q -> 'counts' ->> 'failed_payments') is null and (q -> 'counts' ->> 'open_complaints')::int >= 1, format('counts: %s', q -> 'counts');
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

-- A's owner still has exactly the messages A wrote (B's attempt didn't land)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert not exists (select 1 from public.messages where body = 'hack'), 'no hack message'; end $$;
reset role;
select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
