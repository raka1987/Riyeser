-- Riyeser Team: team chat for each business, in its OWN Supabase project (not the As Built one).
-- Paste all of this into Supabase → SQL Editor → New query → Run. Safe to run again: it only adds what's missing.
--
-- Each business is a "team" (workspace). People join with the team's invite code. Row-level security means a
-- person only ever sees the teams they belong to, the channels in those teams, and the direct messages they're in.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  invite_code text not null unique default upper(substr(md5(random()::text), 1, 8)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null default 'channel',  -- channel (whole team), private (chosen people), dm
  name text check (kind = 'dm' or length(trim(name)) between 1 and 40),
  topic text check (length(topic) <= 200),
  dm_key text,                       -- for direct messages: the two people's ids, sorted, so there's only one per pair
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  archived boolean not null default false,
  unique (workspace_id, dm_key)
);
-- Private channels (e.g. executives, sales): only the people added can see them. Safe to re-run.
alter table public.channels drop constraint if exists channels_kind_check;
alter table public.channels add constraint channels_kind_check check (kind in ('channel', 'private', 'dm'));

create table if not exists public.channel_members (   -- who is in a direct message or a private channel
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (channel_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted boolean not null default false
);
create index if not exists messages_channel_time on public.messages (channel_id, created_at desc);

create table if not exists public.reads (              -- how far each person has read in each channel
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

-- ---------------------------------------------------------------- who can see what
create or replace function public.is_member(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where workspace_id = ws and user_id = auth.uid())
$$;

create or replace function public.is_admin(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin'))
$$;

create or replace function public.can_see_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from channels c join members m on m.workspace_id = c.workspace_id and m.user_id = auth.uid()
    where c.id = ch and (c.kind = 'channel'
      or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = auth.uid())))
$$;

alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.reads enable row level security;

drop policy if exists ws_read on public.workspaces;
create policy ws_read on public.workspaces for select to authenticated using (public.is_member(id));
drop policy if exists ws_rename on public.workspaces;
create policy ws_rename on public.workspaces for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

drop policy if exists mem_read on public.members;
create policy mem_read on public.members for select to authenticated using (public.is_member(workspace_id));
drop policy if exists mem_rename_self on public.members;
create policy mem_rename_self on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists mem_remove on public.members;
create policy mem_remove on public.members for delete to authenticated
  using (user_id = auth.uid() and role <> 'owner' or public.is_admin(workspace_id) and role <> 'owner');

drop policy if exists ch_read on public.channels;
create policy ch_read on public.channels for select to authenticated using (public.can_see_channel(id));
drop policy if exists ch_add on public.channels;
create policy ch_add on public.channels for insert to authenticated
  with check (kind = 'channel' and public.is_member(workspace_id) and created_by = auth.uid());
drop policy if exists ch_edit on public.channels;
create policy ch_edit on public.channels for update to authenticated
  using (kind in ('channel', 'private') and public.can_see_channel(id) and (created_by = auth.uid() or public.is_admin(workspace_id)))
  with check (kind in ('channel', 'private') and public.is_member(workspace_id));

drop policy if exists cm_read on public.channel_members;
create policy cm_read on public.channel_members for select to authenticated using (public.can_see_channel(channel_id));
drop policy if exists cm_leave on public.channel_members;
create policy cm_leave on public.channel_members for delete to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.channels c where c.id = channel_id and c.kind = 'private'));

drop policy if exists msg_read on public.messages;
create policy msg_read on public.messages for select to authenticated using (public.can_see_channel(channel_id));
drop policy if exists msg_send on public.messages;
create policy msg_send on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_channel(channel_id)
              and workspace_id = (select workspace_id from public.channels where id = channel_id));
drop policy if exists msg_edit on public.messages;
create policy msg_edit on public.messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_see_channel(channel_id));

drop policy if exists rd_own on public.reads;
create policy rd_own on public.reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_see_channel(channel_id));

-- Messages can't be moved to another channel or person after they're sent; only the text and "deleted" change.
create or replace function public.messages_guard() returns trigger language plpgsql as $$
begin
  if new.channel_id <> old.channel_id or new.user_id <> old.user_id or new.workspace_id <> old.workspace_id
     or new.created_at <> old.created_at then
    raise exception 'Only the text of a message can be changed';
  end if;
  if new.body is distinct from old.body then new.edited_at := now(); end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before update on public.messages for each row execute function public.messages_guard();

-- ---------------------------------------------------------------- actions (each checks who's asking)
-- public.create_team is defined in the Calls section below (it also sets up branches and extensions).

-- public.join_team is defined in the Calls section below (it also sets up branches and extensions).

create or replace function public.new_invite_code(ws uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare c text := upper(substr(md5(random()::text), 1, 8));
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can do that'; end if;
  update workspaces set invite_code = c where id = ws;
  return c;
end $$;

create or replace function public.set_role(ws uuid, person uuid, new_role text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can do that'; end if;
  if new_role not in ('admin', 'member') then raise exception 'Choose admin or member'; end if;
  update members set role = new_role where workspace_id = ws and user_id = person and role <> 'owner';
end $$;

create or replace function public.open_dm(ws uuid, person uuid) returns uuid
  language plpgsql security definer set search_path = public as $$
declare ch uuid; k text;
begin
  if not is_member(ws) then raise exception 'You''re not in that team'; end if;
  if not exists (select 1 from members where workspace_id = ws and user_id = person) then
    raise exception 'That person isn''t in the team';
  end if;
  k := least(auth.uid()::text, person::text) || ':' || greatest(auth.uid()::text, person::text);
  select id into ch from channels where workspace_id = ws and dm_key = k;
  if ch is null then
    insert into channels (workspace_id, kind, dm_key, created_by) values (ws, 'dm', k, auth.uid()) returning id into ch;
    insert into channel_members (channel_id, user_id) values (ch, auth.uid()), (ch, person) on conflict do nothing;
  end if;
  return ch;
end $$;

-- A private channel: only the people chosen (and whoever makes it) can see it.
create or replace function public.create_private_channel(ws uuid, channel_name text, channel_topic text, people uuid[])
  returns uuid language plpgsql security definer set search_path = public as $$
declare ch uuid;
begin
  if not is_member(ws) then raise exception 'You''re not in that team'; end if;
  insert into channels (workspace_id, kind, name, topic, created_by)
    values (ws, 'private', trim(channel_name), nullif(trim(coalesce(channel_topic, '')), ''), auth.uid()) returning id into ch;
  insert into channel_members (channel_id, user_id)
    select ch, m.user_id from members m
    where m.workspace_id = ws and (m.user_id = auth.uid() or m.user_id = any(coalesce(people, '{}')))
    on conflict do nothing;
  return ch;
end $$;

-- Add or remove people in a private channel: its creator or a team owner/admin.
create or replace function public.set_channel_people(ch uuid, add_people uuid[], remove_people uuid[])
  returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from channels where id = ch;
  if c.id is null or c.kind <> 'private' then raise exception 'That isn''t a private channel'; end if;
  if not (is_admin(c.workspace_id) or (c.created_by = auth.uid() and can_see_channel(ch))) then
    raise exception 'Only whoever made this channel, or a team owner or admin, can change who''s in it';
  end if;
  insert into channel_members (channel_id, user_id)
    select ch, m.user_id from members m where m.workspace_id = c.workspace_id and m.user_id = any(coalesce(add_people, '{}'))
    on conflict do nothing;
  delete from channel_members where channel_id = ch and user_id = any(coalesce(remove_people, '{}'));
  if not exists (select 1 from channel_members where channel_id = ch) then
    raise exception 'A private channel needs at least one person in it';
  end if;
end $$;

-- Unread messages for each channel the person can see in a team.
create or replace function public.unread_counts(ws uuid) returns table (channel_id uuid, unread bigint)
  language sql stable security definer set search_path = public as $$
  select c.id, count(m.id)
  from channels c
  left join reads r on r.channel_id = c.id and r.user_id = auth.uid()
  left join messages m on m.channel_id = c.id and not m.deleted and m.user_id <> auth.uid()
       and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
  where c.workspace_id = ws and public.is_member(ws) and public.can_see_channel(c.id)
  group by c.id
$$;

revoke all on function public.new_invite_code(uuid),
  public.set_role(uuid, uuid, text), public.open_dm(uuid, uuid), public.unread_counts(uuid),
  public.create_private_channel(uuid, text, text, uuid[]), public.set_channel_people(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.new_invite_code(uuid),
  public.set_role(uuid, uuid, text), public.open_dm(uuid, uuid), public.unread_counts(uuid),
  public.create_private_channel(uuid, text, text, uuid[]), public.set_channel_people(uuid, uuid[], uuid[]) to authenticated;
grant select, insert, update, delete on public.workspaces, public.members, public.channels, public.channel_members,
  public.messages, public.reads to authenticated;
revoke all on public.workspaces, public.members, public.channels, public.channel_members, public.messages, public.reads
  from anon;

-- ---------------------------------------------------------------- live updates
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ---------------------------------------------------------------- only names and topics can be changed directly
-- (roles, premium and private/public are changed only through the checked actions above)
revoke update on public.workspaces, public.members, public.channels from authenticated;
grant update (name) on public.workspaces to authenticated;
grant update (display_name) on public.members to authenticated;
grant update (name, topic, archived) on public.channels to authenticated;

-- ================================================================ Riyeser Team Calls (premium)
-- Calls between people in a team, and to a branch (rings everyone there; the first to answer takes it).
-- The call itself goes directly between the two devices (WebRTC); these rows only carry the ringing and set-up.
-- Premium: free for the team's first 90 days, then only while calls_paid_until is in the future.
-- Riyeser sets that when a business pays:  update public.workspaces set calls_paid_until = '2027-12-31' where id = '…';
alter table public.workspaces add column if not exists calls_paid_until timestamptz;

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create table if not exists public.branch_members (
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (branch_id, user_id)
);
create table if not exists public.call_signals (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  call_id uuid not null,
  from_user uuid not null default auth.uid() references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ring', 'accept', 'decline', 'cancel', 'taken', 'offer', 'answer', 'ice', 'hangup', 'busy')),
  payload jsonb check (payload is null or length(payload::text) < 30000),
  created_at timestamptz not null default now()
);
create index if not exists call_signals_to on public.call_signals (to_user, created_at);

create or replace function public.calls_allowed(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspaces where id = ws
                 and (created_at > now() - interval '90 days' or calls_paid_until > now()))
$$;

create or replace function public.team_features(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object(
    'calls', public.calls_allowed(ws),
    'calls_paid', coalesce(w.calls_paid_until > now(), false),
    'calls_paid_until', w.calls_paid_until,
    'trial_days_left', greatest(0, 90 - extract(day from now() - w.created_at)::int))
  from workspaces w where w.id = ws and public.is_member(ws)
$$;

alter table public.branches enable row level security;
alter table public.branch_members enable row level security;
alter table public.call_signals enable row level security;

drop policy if exists br_read on public.branches;
create policy br_read on public.branches for select to authenticated using (public.is_member(workspace_id));
drop policy if exists br_admin on public.branches;
create policy br_admin on public.branches for all to authenticated
  using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));

drop policy if exists bm_read on public.branch_members;
create policy bm_read on public.branch_members for select to authenticated
  using (public.is_member((select workspace_id from public.branches where id = branch_id)));
drop policy if exists bm_admin on public.branch_members;
create policy bm_admin on public.branch_members for all to authenticated
  using (public.is_admin((select workspace_id from public.branches where id = branch_id)))
  with check (public.is_admin((select workspace_id from public.branches where id = branch_id))
              and exists (select 1 from public.members m join public.branches b on b.workspace_id = m.workspace_id
                          where b.id = branch_id and m.user_id = branch_members.user_id));

-- Only the two people on a call see its signals; only a team member can start one, only to someone in the same
-- team, and only while the team has calls.
drop policy if exists cs_read on public.call_signals;
create policy cs_read on public.call_signals for select to authenticated using (to_user = auth.uid() or from_user = auth.uid());
drop policy if exists cs_send on public.call_signals;
create policy cs_send on public.call_signals for insert to authenticated
  with check (from_user = auth.uid() and to_user <> auth.uid() and public.is_member(workspace_id)
              and exists (select 1 from public.members m where m.workspace_id = call_signals.workspace_id and m.user_id = to_user)
              and public.calls_allowed(workspace_id));
drop policy if exists cs_tidy on public.call_signals;
create policy cs_tidy on public.call_signals for delete to authenticated using (to_user = auth.uid() or from_user = auth.uid());

grant select, insert, update, delete on public.branches, public.branch_members to authenticated;
grant select, insert, delete on public.call_signals to authenticated;
revoke all on public.branches, public.branch_members, public.call_signals from anon;
revoke all on function public.calls_allowed(uuid), public.team_features(uuid) from public, anon;
grant execute on function public.calls_allowed(uuid), public.team_features(uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'call_signals') then
    alter publication supabase_realtime add table public.call_signals;
  end if;
end $$;

-- ---------------------------------------------------------------- branches, join codes and extensions
-- Easy set-up: no device IDs. Each branch has its own join code; staff type it once and are put in the company,
-- in that branch, with the next free extension in the branch's range (Head office 100: staff 101, 102…;
-- the next branch 200: staff 201…). Dialling a branch's number rings everyone in it. Whatever device someone is
-- signed in on is their extension.
alter table public.members add column if not exists extension int check (extension between 10 and 9999);
create unique index if not exists members_extension on public.members (workspace_id, extension) where extension is not null;
alter table public.branches add column if not exists code text;
alter table public.branches add column if not exists extension int check (extension between 10 and 9999);
create unique index if not exists branches_code on public.branches (code);
create unique index if not exists branches_extension on public.branches (workspace_id, extension) where extension is not null;
drop policy if exists mem_ext_admin on public.members;   -- extensions change only through set_extension (admins)

create or replace function public.make_branch_code(branch_name text) returns text
  language plpgsql volatile set search_path = public as $$
declare pre text := upper(left(regexp_replace(coalesce(branch_name, ''), '[^A-Za-z]', '', 'g') || 'BRN', 3)); c text;
begin
  loop
    c := pre || '-' || lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from branches where code = c);
  end loop;
  return c;
end $$;

-- The next free number after `base` (e.g. 101 after 100), within that hundred.
create or replace function public.next_extension(ws uuid, base int) returns int
  language sql stable security definer set search_path = public as $$
  select min(n) from generate_series(base + 1, base + 99) n
  where not exists (select 1 from members where workspace_id = ws and extension = n)
    and not exists (select 1 from branches where workspace_id = ws and extension = n)
$$;

create or replace function public.create_branch(ws uuid, branch_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare b uuid; ext int;
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can add a branch'; end if;
  select coalesce(max(extension), 0) + 100 into ext from branches where workspace_id = ws and extension % 100 = 0;
  if ext > 9900 then ext := null; end if;
  insert into branches (workspace_id, name, code, extension) values (ws, trim(branch_name), make_branch_code(branch_name), ext)
    returning id into b;
  return b;
end $$;

create or replace function public.new_branch_code(branch uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare c text; ws uuid; nm text;
begin
  select workspace_id, name into ws, nm from branches where id = branch;
  if ws is null or not is_admin(ws) then raise exception 'Only the team''s owner or an admin can do that'; end if;
  c := make_branch_code(nm);
  update branches set code = c where id = branch;
  return c;
end $$;

create or replace function public.set_extension(ws uuid, person uuid, ext int) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can change extensions'; end if;
  if ext is not null and (exists (select 1 from members where workspace_id = ws and extension = ext and user_id <> person)
                          or exists (select 1 from branches where workspace_id = ws and extension = ext)) then
    raise exception 'Extension % is already used', ext;
  end if;
  update members set extension = ext where workspace_id = ws and user_id = person;
end $$;

-- Put someone in a branch and give them the next free number in its range (if they don't have one yet).
create or replace function public.place_in_branch(b uuid, person uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare ws uuid; base int;
begin
  select workspace_id, extension into ws, base from branches where id = b;
  insert into branch_members (branch_id, user_id) values (b, person) on conflict do nothing;
  if base is not null then
    update members set extension = next_extension(ws, base)
      where workspace_id = ws and user_id = person and extension is null;
  end if;
end $$;

create or replace function public.create_team(team_name text, your_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare ws uuid; b uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into workspaces (name, created_by) values (trim(team_name), auth.uid()) returning id into ws;
  insert into members (workspace_id, user_id, display_name, role) values (ws, auth.uid(), trim(your_name), 'owner');
  insert into channels (workspace_id, kind, name, topic, created_by)
    values (ws, 'channel', 'general', 'Everyone in the team', auth.uid()),
           (ws, 'channel', 'jobs', 'Jobs, bookings and what''s on today', auth.uid());
  insert into branches (workspace_id, name, code, extension) values (ws, 'Head office', make_branch_code('Head office'), 100)
    returning id into b;
  perform place_in_branch(b, auth.uid());
  return ws;
end $$;

-- Join with the company's invite code, or with a branch's code (which also puts you in that branch).
create or replace function public.join_team(code text, your_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare ws uuid; b uuid; c text := upper(trim(code));
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id, workspace_id into b, ws from branches where branches.code = c;
  if ws is null then select id into ws from workspaces where invite_code = c; end if;
  if ws is null then raise exception 'That invite code isn''t right. Ask the person who invited you for the link again.'; end if;
  insert into members (workspace_id, user_id, display_name) values (ws, auth.uid(), trim(your_name))
    on conflict (workspace_id, user_id) do nothing;
  if b is not null then perform place_in_branch(b, auth.uid()); end if;
  return ws;
end $$;

revoke all on function public.create_team(text, text), public.join_team(text, text), public.create_branch(uuid, text),
  public.new_branch_code(uuid), public.set_extension(uuid, uuid, int), public.place_in_branch(uuid, uuid),
  public.next_extension(uuid, int), public.make_branch_code(text) from public, anon;
grant execute on function public.create_team(text, text), public.join_team(text, text), public.create_branch(uuid, text),
  public.new_branch_code(uuid), public.set_extension(uuid, uuid, int) to authenticated;
