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
-- A's owner still has exactly the messages A wrote (B's attempt didn't land)
select pg_temp.as_user('11111111-1111-1111-1111-111111111111'); set role authenticated;
do $$ begin assert not exists (select 1 from public.messages where body = 'hack'), 'no hack message'; end $$;
reset role;
select 'ALL CHAT DATABASE TESTS PASSED' as result;
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
