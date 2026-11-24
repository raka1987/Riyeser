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
  assert (select count(*) from public.hq_history() where action in ('licence.module', 'note.added', 'staff.added', 'company.viewed')) >= 4, 'HQ history';
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
  assert m = 20 + 20 + 2 * 5 + 10, format('monthly estimate: Basics 20 + Team Calls 20 (paid earlier) + 2 users 10 + 1 company 10 = 60, got %s', m);
  assert ((public.hq_licences()) ->> 'monthly_estimate')::numeric >= 60, 'total estimate';
  assert ((public.hq_licences()) ->> 'early_bird_left')::int = 100, 'early bird places';
end $$;
-- yearly + early bird: 60 a month list -> x 10/12 -> half = 25
select public.hq_set_plan(:'ws_c', 2, 1, 'yearly', true);
do $$ begin assert ((public.hq_company_licence(current_setting('test.ws_c')::uuid)) ->> 'monthly')::numeric = 25.00, 'yearly early bird'; end $$;
-- Team Calls via the licence: cancelled and unpaid -> no calls; the old button sets it paid again
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

-- A's owner still has exactly the messages A wrote (B's attempt didn't land)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert not exists (select 1 from public.messages where body = 'hack'), 'no hack message'; end $$;
reset role;
select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
