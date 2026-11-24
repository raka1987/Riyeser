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

-- Two-step sign-in: a session that also passed an authenticator-app code is 'aal2'.
create or replace function public.mfa_ok() returns boolean
  language sql stable as $$ select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' $$;

-- Owners and admins can only use their admin powers after two-step sign-in (password + authenticator code).
create or replace function public.is_admin(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.mfa_ok() and exists (select 1 from members where workspace_id = ws and user_id = auth.uid() and role in ('owner', 'admin'))
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
  insert into workspaces (name, created_by, company_code) values (trim(team_name), auth.uid(), make_company_code()) returning id into ws;
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

-- ================================================================ Riyeser companies
-- One Company ID (e.g. RIY-7K3M-Q2) for the whole business, shared by every Riyeser program and PC. People and
-- PCs join by asking (like a friend request); an owner or admin approves them, choosing their job role and branches.
create or replace function public.make_company_code() returns text
  language plpgsql volatile set search_path = public as $$
declare abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text;   -- no 0/O or 1/I, so it's easy to read out
begin
  loop
    c := 'RIY-';
    for i in 1..4 loop c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    c := c || '-';
    for i in 1..2 loop c := c || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from workspaces where company_code = c);
  end loop;
  return c;
end $$;

alter table public.workspaces add column if not exists company_code text;
alter table public.workspaces add column if not exists legal_name text check (length(legal_name) <= 120);
alter table public.workspaces add column if not exists tax_number text check (length(tax_number) <= 40);
alter table public.workspaces add column if not exists address text check (length(address) <= 300);
alter table public.workspaces add column if not exists phone text check (length(phone) <= 40);
alter table public.workspaces add column if not exists email text check (length(email) <= 120);
alter table public.workspaces add column if not exists country text check (length(country) <= 60);
alter table public.workspaces add column if not exists require_approval boolean not null default false;
create unique index if not exists workspaces_company_code on public.workspaces (company_code);
update public.workspaces set company_code = public.make_company_code() where company_code is null;

alter table public.members add column if not exists job_role text not null default 'staff';
alter table public.members drop constraint if exists members_job_role_check;
alter table public.members add constraint members_job_role_check
  check (job_role in ('owner', 'manager', 'bookkeeper', 'sales', 'payroll', 'staff', 'readonly'));
update public.members set job_role = 'owner' where role = 'owner' and job_role = 'staff';

create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  email text,
  branch_id uuid references public.branches(id) on delete set null,
  note text check (length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz
);
create unique index if not exists join_requests_one_pending on public.join_requests (workspace_id, user_id) where status = 'pending';

create table if not exists public.devices (
  id uuid primary key,                         -- made on the PC once
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text check (length(device_name) <= 80),
  platform text check (length(platform) <= 40),
  app_version text check (length(app_version) <= 40),
  linked_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

alter table public.join_requests enable row level security;
alter table public.devices enable row level security;
drop policy if exists jr_read on public.join_requests;
create policy jr_read on public.join_requests for select to authenticated using (user_id = auth.uid() or public.is_admin(workspace_id));
drop policy if exists dv_read on public.devices;
create policy dv_read on public.devices for select to authenticated using (user_id = auth.uid() or public.is_admin(workspace_id));
drop policy if exists dv_unlink on public.devices;
create policy dv_unlink on public.devices for delete to authenticated using (user_id = auth.uid() or public.is_admin(workspace_id));
grant select on public.join_requests to authenticated;
grant select, delete on public.devices to authenticated;
revoke all on public.join_requests, public.devices from anon;

-- A new company: the team (with Head office on 100), its profile and Company ID. Joining it needs approval.
create or replace function public.create_company(company_name text, your_name text, profile jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare ws uuid; pr jsonb := coalesce(profile, '{}'::jsonb);
begin
  ws := create_team(company_name, your_name);
  update workspaces set require_approval = true, company_code = coalesce(company_code, make_company_code()),
    legal_name = nullif(trim(pr->>'legal_name'), ''), tax_number = nullif(trim(pr->>'tax_number'), ''),
    address = nullif(trim(pr->>'address'), ''), phone = nullif(trim(pr->>'phone'), ''),
    email = nullif(trim(pr->>'email'), ''), country = nullif(trim(pr->>'country'), '')
  where id = ws;
  update members set job_role = 'owner' where workspace_id = ws and user_id = auth.uid();
  return json_build_object('workspace_id', ws, 'company_code', (select company_code from workspaces where id = ws));
end $$;

create or replace function public.update_company(ws uuid, profile jsonb) returns void
  language plpgsql security definer set search_path = public as $$
declare pr jsonb := coalesce(profile, '{}'::jsonb);
begin
  if not is_admin(ws) then raise exception 'Only the company''s owner or an admin can change its details'; end if;
  update workspaces set
    name = coalesce(nullif(trim(pr->>'name'), ''), name),
    legal_name = case when pr ? 'legal_name' then nullif(trim(pr->>'legal_name'), '') else legal_name end,
    tax_number = case when pr ? 'tax_number' then nullif(trim(pr->>'tax_number'), '') else tax_number end,
    address = case when pr ? 'address' then nullif(trim(pr->>'address'), '') else address end,
    phone = case when pr ? 'phone' then nullif(trim(pr->>'phone'), '') else phone end,
    email = case when pr ? 'email' then nullif(trim(pr->>'email'), '') else email end,
    country = case when pr ? 'country' then nullif(trim(pr->>'country'), '') else country end,
    require_approval = coalesce((pr->>'require_approval')::boolean, require_approval)
  where id = ws;
end $$;

-- Ask to join with a Company ID (RIY-…), a branch code (LAU-…) or an invite code. Owners and admins approve.
create or replace function public.request_join(code text, your_name text, note text) returns json
  language plpgsql security definer set search_path = public as $$
declare ws uuid; b uuid; c text := upper(trim(code)); approval boolean; nm text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id, workspace_id into b, ws from branches where branches.code = c;
  if ws is null then select id into ws from workspaces where company_code = c or invite_code = c; end if;
  if ws is null then raise exception 'We couldn''t find a company with that ID. Check it with the person who gave it to you.'; end if;
  select name, require_approval into nm, approval from workspaces where id = ws;
  if exists (select 1 from members where workspace_id = ws and user_id = auth.uid()) then
    return json_build_object('status', 'member', 'company_name', nm, 'workspace_id', ws);
  end if;
  if not approval then
    perform join_team(c, your_name);
    return json_build_object('status', 'member', 'company_name', nm, 'workspace_id', ws);
  end if;
  insert into join_requests (workspace_id, user_id, display_name, email, branch_id, note)
    values (ws, auth.uid(), trim(your_name), (select email from auth.users where id = auth.uid()), b, nullif(trim(coalesce(note, '')), ''))
    on conflict (workspace_id, user_id) where status = 'pending'
    do update set display_name = excluded.display_name, branch_id = excluded.branch_id, note = excluded.note, created_at = now();
  return json_build_object('status', 'pending', 'company_name', nm, 'workspace_id', ws);
end $$;

create or replace function public.my_join_requests() returns table (id uuid, workspace_id uuid, company_name text, status text, created_at timestamptz)
  language sql stable security definer set search_path = public as $$
  select r.id, r.workspace_id, w.name, r.status, r.created_at from join_requests r join workspaces w on w.id = r.workspace_id
  where r.user_id = auth.uid() order by r.created_at desc limit 20
$$;

-- Put someone's branches exactly as listed (only branches of that company), giving extensions for new ones.
create or replace function public.set_person_branches(ws uuid, person uuid, branch_ids uuid[]) returns void
  language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  delete from branch_members bm using branches br
    where bm.branch_id = br.id and br.workspace_id = ws and bm.user_id = person and not (br.id = any(coalesce(branch_ids, '{}')));
  foreach b in array coalesce(branch_ids, '{}') loop
    if exists (select 1 from branches where id = b and workspace_id = ws) then perform place_in_branch(b, person); end if;
  end loop;
end $$;

-- Approve (with a job role, admin or not, and branches) or decline a request.
create or replace function public.decide_join(request uuid, approve boolean, job_role text, make_admin boolean, branch_ids uuid[])
  returns void language plpgsql security definer set search_path = public as $$
declare r join_requests;
begin
  select * into r from join_requests where id = request;
  if r.id is null or r.status <> 'pending' then raise exception 'That request has already been dealt with'; end if;
  if not is_admin(r.workspace_id) then raise exception 'Only the company''s owner or an admin can approve people'; end if;
  if approve then
    if coalesce(job_role, 'staff') not in ('manager', 'bookkeeper', 'sales', 'payroll', 'staff', 'readonly') then
      raise exception 'Choose a job role';
    end if;
    insert into members (workspace_id, user_id, display_name, role, job_role)
      values (r.workspace_id, r.user_id, r.display_name, case when make_admin then 'admin' else 'member' end, coalesce(job_role, 'staff'))
      on conflict (workspace_id, user_id) do nothing;
    perform set_person_branches(r.workspace_id, r.user_id,
      case when coalesce(array_length(branch_ids, 1), 0) > 0 then branch_ids when r.branch_id is not null then array[r.branch_id] else '{}' end);
  end if;
  update join_requests set status = case when approve then 'approved' else 'declined' end, decided_by = auth.uid(), decided_at = now()
    where id = request;
end $$;

-- Change what someone can do later: job role, admin or not, and which branches.
create or replace function public.set_access(ws uuid, person uuid, job_role text, make_admin boolean, branch_ids uuid[])
  returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(ws) then raise exception 'Only the company''s owner or an admin can change access'; end if;
  if not exists (select 1 from members where workspace_id = ws and user_id = person) then raise exception 'That person isn''t in the company'; end if;
  if exists (select 1 from members where workspace_id = ws and user_id = person and role = 'owner') then
    perform set_person_branches(ws, person, branch_ids); return;       -- the owner always stays owner
  end if;
  if job_role not in ('manager', 'bookkeeper', 'sales', 'payroll', 'staff', 'readonly') then raise exception 'Choose a job role'; end if;
  update members m set job_role = set_access.job_role, role = case when make_admin then 'admin' else 'member' end
    where m.workspace_id = ws and m.user_id = person;
  perform set_person_branches(ws, person, branch_ids);
end $$;

-- This PC, linked to the company (Riyeser Central calls this when it starts).
create or replace function public.link_device(ws uuid, device uuid, device_name text, platform text, app_version text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_member(ws) then raise exception 'You''re not in that company'; end if;
  insert into devices (id, workspace_id, user_id, device_name, platform, app_version)
    values (device, ws, auth.uid(), left(device_name, 80), left(platform, 40), left(app_version, 40))
  on conflict (id) do update set workspace_id = excluded.workspace_id, user_id = excluded.user_id, device_name = excluded.device_name,
    platform = excluded.platform, app_version = excluded.app_version, last_seen = now();
end $$;

create or replace function public.device_still_linked(ws uuid, device uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select is_member(ws) and exists (select 1 from devices where id = device and workspace_id = ws and user_id = auth.uid())
$$;

revoke all on function public.make_company_code(), public.create_company(text, text, jsonb), public.update_company(uuid, jsonb),
  public.request_join(text, text, text), public.my_join_requests(), public.set_person_branches(uuid, uuid, uuid[]),
  public.decide_join(uuid, boolean, text, boolean, uuid[]), public.set_access(uuid, uuid, text, boolean, uuid[]),
  public.link_device(uuid, uuid, text, text, text), public.device_still_linked(uuid, uuid) from public, anon;
grant execute on function public.create_company(text, text, jsonb), public.update_company(uuid, jsonb),
  public.request_join(text, text, text), public.my_join_requests(), public.decide_join(uuid, boolean, text, boolean, uuid[]),
  public.set_access(uuid, uuid, text, boolean, uuid[]), public.link_device(uuid, uuid, text, text, text),
  public.device_still_linked(uuid, uuid) to authenticated;


-- ================================================================ change history (who changed what, and when)
-- Written by the database itself; owners and admins can read their company's; nobody can edit or delete it.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  action text not null,
  details jsonb
);
create index if not exists audit_log_ws_time on public.audit_log (workspace_id, at desc);
alter table public.audit_log enable row level security;
drop policy if exists al_read on public.audit_log;
create policy al_read on public.audit_log for select to authenticated using (public.is_admin(workspace_id));
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

create or replace function public.audit_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare ws uuid; rec jsonb; old_j jsonb; new_j jsonb; act text;
begin
  old_j := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  new_j := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  rec := coalesce(new_j, old_j);
  ws := case tg_table_name
          when 'workspaces' then (rec ->> 'id')::uuid
          when 'branch_members' then (select workspace_id from branches where id = (rec ->> 'branch_id')::uuid)
          else (rec ->> 'workspace_id')::uuid end;
  act := tg_table_name || '.' || lower(tg_op);
  if tg_table_name = 'join_requests' then act := 'join_request.' || coalesce(new_j ->> 'status', 'changed'); end if;
  -- keep only what changed (and never the invite codes themselves)
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('was', old_j -> k, 'now', new_j -> k)) into rec
      from jsonb_object_keys(new_j) k where (old_j -> k) is distinct from (new_j -> k) and k not in ('last_seen');
    if rec is null then return null; end if;
  end if;
  rec := rec - 'invite_code' - 'code';
  insert into audit_log (workspace_id, action, details) values (ws, act, rec);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['workspaces', 'members', 'branches', 'branch_members', 'devices'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.audit_change()', t);
  end loop;
  drop trigger if exists audit_join_requests on public.join_requests;
  create trigger audit_join_requests after update on public.join_requests for each row execute function public.audit_change();
end $$;

-- ================================================================ Riyeser HQ (for Riyeser's own staff)
-- The back office for running Riyeser: companies, linked PCs and versions, trials, Team Calls, downloads, notes.
-- PRIVACY: HQ only sees account information. Nothing here reads customers' messages, chats, calls or books.
-- Staff need two-step sign-in. Make yourself the first owner in Supabase's SQL Editor (not from the website):
--   select public.hq_make_owner('you@example.com', 'Your name');
create table if not exists public.hq_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  role text not null check (role in ('owner', 'finance', 'support', 'sales', 'developer')),
  active boolean not null default true,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);
create table if not exists public.hq_notes (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  author uuid references auth.users(id) on delete set null,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create table if not exists public.hq_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  action text not null,
  details jsonb
);
create table if not exists public.downloads_daily (
  day date not null,
  asset text not null,
  total bigint not null check (total >= 0),       -- all-time downloads of that file name, across releases, that day
  primary key (day, asset)
);
create table if not exists public.hq_settings (key text primary key, value text);
alter table public.hq_staff enable row level security;
alter table public.hq_notes enable row level security;
alter table public.hq_audit enable row level security;
alter table public.downloads_daily enable row level security;
alter table public.hq_settings enable row level security;
revoke all on public.hq_staff, public.hq_notes, public.hq_audit, public.downloads_daily, public.hq_settings from anon, authenticated;
-- (no policies: everything goes through the checked hq_ functions below)

-- Staff role for this session, only after two-step sign-in. null = not HQ staff.
create or replace function public.hq_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from hq_staff where user_id = auth.uid() and active and public.mfa_ok()
$$;
create or replace function public.hq_need(roles text[]) returns void
  language plpgsql stable security definer set search_path = public as $$
begin
  if hq_role() is null then raise exception 'Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.'; end if;
  if not (hq_role() = 'owner' or hq_role() = any(roles)) then raise exception 'Your HQ role can''t do that.'; end if;
end $$;
create or replace function public.hq_log(act text, det jsonb) returns void
  language sql security definer set search_path = public as $$ insert into hq_audit (action, details) values (act, det) $$;

-- Who am I in HQ (also tells the website whether two-step sign-in is still needed)
create or replace function public.hq_me() returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('role', s.role, 'name', s.display_name, 'active', s.active, 'two_step', public.mfa_ok())
  from hq_staff s where s.user_id = auth.uid()
$$;

create or replace function public.hq_overview() returns json
  language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  perform hq_need(array['finance', 'support', 'sales', 'developer']);
  select json_build_object(
    'companies', (select count(*) from workspaces),
    'companies_7d', (select count(*) from workspaces where created_at > now() - interval '7 days'),
    'companies_30d', (select count(*) from workspaces where created_at > now() - interval '30 days'),
    'people', (select count(*) from members),
    'pcs', (select count(*) from devices),
    'pcs_active_7d', (select count(*) from devices where last_seen > now() - interval '7 days'),
    'pcs_active_30d', (select count(*) from devices where last_seen > now() - interval '30 days'),
    'requests_waiting', (select count(*) from join_requests where status = 'pending'),
    'calls_paid', (select count(*) from workspaces where calls_paid_until > now()),
    'calls_trial', (select count(*) from workspaces where created_at > now() - interval '90 days' and coalesce(calls_paid_until, '-infinity') <= now()),
    'trials_ending', (select coalesce(json_agg(t order by t.days_left), '[]') from (
        select w.id, w.name, w.company_code, 90 - extract(day from now() - w.created_at)::int as days_left from workspaces w
        where w.created_at between now() - interval '90 days' and now() - interval '76 days' and coalesce(w.calls_paid_until, '-infinity') <= now()) t),
    'versions', (select coalesce(json_agg(v order by v.pcs desc), '[]') from (
        select coalesce(app_version, 'unknown') as version, count(*) as pcs from devices where last_seen > now() - interval '30 days' group by 1) v),
    'countries', (select coalesce(json_agg(c order by c.companies desc), '[]') from (
        select coalesce(country, 'Not set') as country, count(*) as companies from workspaces group by 1) c),
    'signups_by_week', (select coalesce(json_agg(w order by w.week), '[]') from (
        select date_trunc('week', created_at)::date as week, count(*) as companies from workspaces
        where created_at > now() - interval '12 weeks' group by 1) w)
  ) into r;
  return r;
end $$;

create or replace function public.hq_companies(search text) returns table (
  id uuid, name text, company_code text, country text, created_at timestamptz, people bigint, branches bigint, pcs bigint,
  last_seen timestamptz, calls_paid_until timestamptz, trial_days_left int, owner_name text, owner_email text)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['finance', 'support', 'sales']);
  return query
  select w.id, w.name, w.company_code, w.country, w.created_at,
    (select count(*) from members m where m.workspace_id = w.id),
    (select count(*) from branches b where b.workspace_id = w.id),
    (select count(*) from devices d where d.workspace_id = w.id),
    (select max(d.last_seen) from devices d where d.workspace_id = w.id),
    w.calls_paid_until, greatest(0, 90 - extract(day from now() - w.created_at)::int),
    (select m.display_name from members m where m.workspace_id = w.id and m.role = 'owner' limit 1),
    (select u.email::text from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' limit 1)
  from workspaces w
  where coalesce(search, '') = '' or w.name ilike '%' || search || '%' or w.company_code ilike '%' || search || '%'
     or w.legal_name ilike '%' || search || '%' or w.tax_number ilike '%' || search || '%'
     or exists (select 1 from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and u.email::text ilike '%' || search || '%')
  order by w.created_at desc limit 500;
end $$;

-- One company: account information only (profile, people, branches, PCs, notes). Never messages or books.
create or replace function public.hq_company(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  perform hq_need(array['finance', 'support', 'sales']);
  select json_build_object(
    'profile', (select json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'legal_name', w.legal_name,
        'tax_number', w.tax_number, 'address', w.address, 'phone', w.phone, 'email', w.email, 'country', w.country,
        'created_at', w.created_at, 'calls_paid_until', w.calls_paid_until, 'require_approval', w.require_approval,
        'trial_days_left', greatest(0, 90 - extract(day from now() - w.created_at)::int)) from workspaces w where w.id = ws),
    'people', (select coalesce(json_agg(json_build_object('name', m.display_name, 'role', m.role, 'job_role', m.job_role,
        'extension', m.extension, 'email', u.email, 'joined', m.joined_at) order by m.joined_at), '[]')
        from members m join auth.users u on u.id = m.user_id where m.workspace_id = ws),
    'branches', (select coalesce(json_agg(json_build_object('name', b.name, 'extension', b.extension,
        'people', (select count(*) from branch_members bm where bm.branch_id = b.id)) order by b.extension), '[]') from branches b where b.workspace_id = ws),
    'pcs', (select coalesce(json_agg(json_build_object('name', d.device_name, 'platform', d.platform, 'version', d.app_version,
        'last_seen', d.last_seen, 'person', (select display_name from members m where m.workspace_id = ws and m.user_id = d.user_id))
        order by d.last_seen desc), '[]') from devices d where d.workspace_id = ws),
    'requests_waiting', (select count(*) from join_requests j where j.workspace_id = ws and j.status = 'pending'),
    'notes', (select coalesce(json_agg(json_build_object('body', n.body, 'at', n.created_at,
        'by', (select display_name from hq_staff s where s.user_id = n.author)) order by n.created_at desc), '[]') from hq_notes n where n.workspace_id = ws)
  ) into r;
  perform hq_log('company.viewed', json_build_object('workspace_id', ws)::jsonb);
  return r;
end $$;

create or replace function public.hq_set_calls_paid(ws uuid, until date) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['finance']);
  update workspaces set calls_paid_until = until::timestamptz + interval '1 day' - interval '1 second' where id = ws;
  perform hq_log('calls.paid_until', json_build_object('workspace_id', ws, 'until', until)::jsonb);
end $$;

create or replace function public.hq_add_note(ws uuid, body text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['finance', 'support', 'sales']);
  insert into hq_notes (workspace_id, author, body) values (ws, auth.uid(), trim(body));
  perform hq_log('note.added', json_build_object('workspace_id', ws)::jsonb);
end $$;

create or replace function public.hq_staff_list() returns table (user_id uuid, display_name text, role text, active boolean, email text, added_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['finance', 'support', 'sales', 'developer']);
  return query select s.user_id, s.display_name, s.role, s.active, u.email::text, s.added_at from hq_staff s join auth.users u on u.id = s.user_id order by s.added_at;
end $$;

-- Owners add staff (they need a Riyeser account first), change their role, or switch them off.
create or replace function public.hq_add_staff(staff_email text, staff_name text, staff_role text) returns void
  language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  perform hq_need(array[]::text[]);
  if staff_role not in ('owner', 'finance', 'support', 'sales', 'developer') then raise exception 'Choose a role'; end if;
  select id into uid from auth.users where lower(email::text) = lower(trim(staff_email));
  if uid is null then raise exception 'No Riyeser account with that email yet. Ask them to create one at riyeser.com/team first.'; end if;
  insert into hq_staff (user_id, display_name, role, added_by) values (uid, trim(staff_name), staff_role, auth.uid())
    on conflict (user_id) do update set display_name = excluded.display_name, role = excluded.role, active = true;
  perform hq_log('staff.added', json_build_object('email', staff_email, 'role', staff_role)::jsonb);
end $$;

create or replace function public.hq_set_staff(staff uuid, staff_role text, is_active boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array[]::text[]);
  if staff = auth.uid() then raise exception 'You can''t change your own HQ access. Ask another owner.'; end if;
  if staff_role not in ('owner', 'finance', 'support', 'sales', 'developer') then raise exception 'Choose a role'; end if;
  update hq_staff set role = staff_role, active = is_active where user_id = staff;
  perform hq_log('staff.changed', json_build_object('user_id', staff, 'role', staff_role, 'active', is_active)::jsonb);
end $$;

create or replace function public.hq_history() returns table (at timestamptz, who text, action text, details jsonb)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array[]::text[]);
  return query select a.at, coalesce((select display_name from hq_staff s where s.user_id = a.actor), 'Riyeser'), a.action, a.details
    from hq_audit a order by a.at desc limit 300;
end $$;

create or replace function public.hq_downloads(days int) returns table (day date, asset text, total bigint)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['finance', 'support', 'sales', 'developer']);
  return query select d.day, d.asset, d.total from downloads_daily d where d.day > current_date - least(greatest(days, 1), 730) order by d.day, d.asset;
end $$;

-- The daily GitHub job records download totals with a private token (set in the SQL Editor, see ops/RUNBOOK.md):
--   select public.hq_set_ingest_token('a long random token');
create or replace function public.hq_set_ingest_token(token text) returns void
  language sql security definer set search_path = public as $$
  insert into hq_settings (key, value) values ('ingest_token_sha256', encode(sha256(convert_to(token, 'UTF8')), 'hex'))
  on conflict (key) do update set value = excluded.value
$$;
create or replace function public.hq_record_downloads(token text, totals jsonb) returns int
  language plpgsql security definer set search_path = public as $$
declare n int := 0; k text;
begin
  if coalesce(token, '') = '' or encode(sha256(convert_to(token, 'UTF8')), 'hex') is distinct from (select value from hq_settings where key = 'ingest_token_sha256') then
    raise exception 'Not allowed';
  end if;
  for k in select jsonb_object_keys(totals) loop
    insert into downloads_daily (day, asset, total) values (current_date, left(k, 120), (totals ->> k)::bigint)
      on conflict (day, asset) do update set total = excluded.total;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Only from the SQL Editor (the database owner): make the first HQ owner.
create or replace function public.hq_make_owner(owner_email text, owner_name text) returns text
  language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email::text) = lower(trim(owner_email));
  if uid is null then raise exception 'No account with that email. Create one at riyeser.com/team first.'; end if;
  insert into hq_staff (user_id, display_name, role) values (uid, trim(owner_name), 'owner')
    on conflict (user_id) do update set role = 'owner', active = true;
  insert into hq_audit (actor, action, details) values (null, 'staff.owner_made', json_build_object('email', owner_email)::jsonb);
  return 'Done: ' || owner_email || ' is an HQ owner. Sign in at riyeser.com/hq with two-step sign-in.';
end $$;

revoke all on function public.hq_role(), public.hq_need(text[]), public.hq_log(text, jsonb), public.hq_me(), public.hq_overview(),
  public.hq_companies(text), public.hq_company(uuid), public.hq_set_calls_paid(uuid, date), public.hq_add_note(uuid, text),
  public.hq_staff_list(), public.hq_add_staff(text, text, text), public.hq_set_staff(uuid, text, boolean), public.hq_history(),
  public.hq_downloads(int), public.hq_set_ingest_token(text), public.hq_record_downloads(text, jsonb), public.hq_make_owner(text, text)
  from public, anon, authenticated;
grant execute on function public.hq_me(), public.hq_overview(), public.hq_companies(text), public.hq_company(uuid),
  public.hq_set_calls_paid(uuid, date), public.hq_add_note(uuid, text), public.hq_staff_list(), public.hq_add_staff(text, text, text),
  public.hq_set_staff(uuid, text, boolean), public.hq_history(), public.hq_downloads(int) to authenticated;
grant execute on function public.hq_record_downloads(text, jsonb) to anon, authenticated;
