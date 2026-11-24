-- Riyeser Link (formerly Riyeser Team): chat for each business, in its OWN Supabase project (not the As Built one).
-- Only what people see was renamed: tables, functions and the 'calls' module keep their names, so this stays safe to re-run.
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
-- Account status: HQ can suspend or close a business (nothing is ever deleted), and when anyone last used it.
alter table public.workspaces add column if not exists status text not null default 'active';
do $$ begin
  alter table public.workspaces add constraint workspaces_status check (status in ('active', 'suspended', 'closed'));
exception when duplicate_object then null; end $$;
alter table public.workspaces add column if not exists closed_at timestamptz;
alter table public.workspaces add column if not exists closed_reason text check (length(closed_reason) <= 300);
alter table public.workspaces add column if not exists closed_by uuid references auth.users(id) on delete set null;
alter table public.workspaces add column if not exists duplicate_of uuid references public.workspaces(id) on delete set null;
alter table public.workspaces add column if not exists last_active_at timestamptz;
alter table public.workspaces add column if not exists warned_30_at timestamptz;
alter table public.workspaces add column if not exists warned_7_at timestamptz;
alter table public.workspaces add column if not exists removal_state text check (removal_state in ('ready', 'removed'));
alter table public.workspaces add column if not exists removal_ready_at timestamptz;
alter table public.workspaces add column if not exists removed_at timestamptz;

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
  select exists (select 1 from members m join workspaces w on w.id = m.workspace_id
                 where m.workspace_id = ws and m.user_id = auth.uid() and w.status = 'active')
$$;

-- Two-step sign-in: a session that also passed an authenticator-app code is 'aal2'.
create or replace function public.mfa_ok() returns boolean
  language sql stable as $$ select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' $$;

-- Owners and admins can only use their admin powers after two-step sign-in (password + authenticator code).
create or replace function public.is_admin(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.mfa_ok() and exists (select 1 from members m join workspaces w on w.id = m.workspace_id
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin') and w.status = 'active')
$$;

create or replace function public.can_see_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from channels c join members m on m.workspace_id = c.workspace_id and m.user_id = auth.uid()
      join workspaces w on w.id = c.workspace_id and w.status = 'active'
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

-- ================================================================ Riyeser Link Plus calls (premium; was Team Calls)
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
  if (select status from workspaces where id = ws) <> 'active' then raise exception 'This business is closed. Contact Riyeser support.'; end if;
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
-- Who it's for: 'personal' (just me: an individual, freelancer or sole trader) or 'business' (a family business or a team).
alter table public.workspaces add column if not exists kind text not null default 'business';
do $$ begin
  alter table public.workspaces add constraint workspaces_kind check (kind in ('personal', 'business'));
exception when duplicate_object then null; end $$;

create or replace function public.create_company(company_name text, your_name text, profile jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare ws uuid; pr jsonb := coalesce(profile, '{}'::jsonb);
begin
  ws := create_team(company_name, your_name);
  update workspaces set require_approval = true, company_code = coalesce(company_code, make_company_code()),
    legal_name = nullif(trim(pr->>'legal_name'), ''), tax_number = nullif(trim(pr->>'tax_number'), ''),
    address = nullif(trim(pr->>'address'), ''), phone = nullif(trim(pr->>'phone'), ''),
    email = nullif(trim(pr->>'email'), ''), country = nullif(trim(pr->>'country'), ''),
    kind = case when pr->>'kind' = 'personal' then 'personal' else 'business' end
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
    require_approval = coalesce((pr->>'require_approval')::boolean, require_approval),
    kind = case when pr->>'kind' in ('personal', 'business') then pr->>'kind' else kind end
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
  if (select status from workspaces where id = ws) <> 'active' then raise exception 'This business is closed. Contact Riyeser support.'; end if;
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
  language plpgsql volatile security definer set search_path = public as $$
declare linked boolean;
begin
  linked := exists (select 1 from members where workspace_id = ws and user_id = auth.uid())
            and exists (select 1 from devices where id = device and workspace_id = ws and user_id = auth.uid());
  -- Riyeser Central checks in: the business is in use (at most one write an hour)
  if linked then
    update workspaces set last_active_at = now()
      where id = ws and status = 'active' and (last_active_at is null or last_active_at < now() - interval '1 hour');
  end if;
  return linked;
end $$;

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
  if current_setting('riyeser.removing', true) = 'on' then return null; end if;   -- owner-approved anonymising
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
      from jsonb_object_keys(new_j) k where (old_j -> k) is distinct from (new_j -> k)
        and k not in ('last_seen', 'last_active_at', 'warned_30_at', 'warned_7_at', 'removal_ready_at');
    if rec is null then return null; end if;
  end if;
  rec := rec - 'invite_code' - 'code';
  insert into audit_log (workspace_id, action, details, actor)
    values (ws, act, rec, case when current_setting('riyeser.by_hq', true) = 'on' then null else auth.uid() end);   -- HQ fixes show as "Riyeser"
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
-- The back office for running Riyeser: companies, linked PCs and versions, trials, Riyeser Link Plus, downloads, notes.
-- PRIVACY: HQ only sees account information. Nothing here reads customers' messages, chats, calls or books.
-- Staff need two-step sign-in. Make yourself the first owner in Supabase's SQL Editor (not from the website):
--   select public.hq_make_owner('you@example.com', 'Your name');
create table if not exists public.hq_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 60),
  role text not null check (role in ('owner', 'finance', 'support', 'senior', 'sales', 'developer')),
  active boolean not null default true,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);
-- Roles give default permissions; an owner can tick extra ones on (perms_add) or off (perms_remove) per person.
alter table public.hq_staff add column if not exists perms_add text[] not null default '{}';
alter table public.hq_staff add column if not exists perms_remove text[] not null default '{}';
alter table public.hq_staff drop constraint if exists hq_staff_role_check;
alter table public.hq_staff add constraint hq_staff_role_check check (role in ('owner', 'finance', 'support', 'senior', 'sales', 'developer'));
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
-- Which business and ticket each HQ action was about (for filters and the company panel's own history).
alter table public.hq_audit add column if not exists workspace_id uuid;   -- no foreign key: the history outlives everything
alter table public.hq_audit add column if not exists ticket text;
create index if not exists hq_audit_at on public.hq_audit (at desc);
create index if not exists hq_audit_ws on public.hq_audit (workspace_id, at desc);
create index if not exists hq_audit_actor on public.hq_audit (actor, at desc);
-- The HQ history can't be changed or deleted by anyone, the database owner included.
create or replace function public.hq_audit_locked() returns trigger language plpgsql as $$
begin raise exception 'The HQ history can''t be changed or deleted.'; end $$;
drop trigger if exists hq_audit_locked on public.hq_audit;
create trigger hq_audit_locked before update or delete on public.hq_audit for each row execute function public.hq_audit_locked();
drop trigger if exists hq_audit_no_truncate on public.hq_audit;
create trigger hq_audit_no_truncate before truncate on public.hq_audit for each statement execute function public.hq_audit_locked();
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
-- Permissions. Every HQ function checks one (or one of several) with hq_need; the website only hides buttons.
create or replace function public.hq_all_perms() returns text[] language sql immutable as $$
  select array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
    'people.change_owner', 'business.close', 'licences.view', 'licences.manage', 'support.view', 'support.reply', 'support.assign',
    'support.saved_replies', 'support.escalate', 'support.level2', 'support.level3', 'refunds.view', 'refunds.request',
    'refunds.approve', 'refunds.pay', 'offers.grant', 'offers.approve', 'emails.view', 'emails.manage', 'accounts.inactive',
    'staff.manage', 'audit.view', 'settings.manage', 'link.support', 'reports.view', 'support.diagnostics']
$$;
create or replace function public.hq_role_perms(r text) returns text[] language sql immutable as $$
  select case r
    when 'owner' then public.hq_all_perms()
    when 'finance' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'licences.view', 'licences.manage',
      'support.view', 'support.reply', 'support.level2', 'support.level3', 'support.escalate', 'refunds.view', 'refunds.approve', 'refunds.pay',
      'offers.grant', 'offers.approve', 'emails.view', 'reports.view']
    when 'support' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
      'licences.view', 'support.view', 'support.reply', 'support.assign', 'support.saved_replies', 'support.escalate', 'refunds.view',
      'refunds.request', 'offers.grant', 'emails.view', 'link.support', 'support.diagnostics']
    when 'senior' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'customers.edit', 'people.reset_2fa',
      'people.change_owner', 'business.close', 'licences.view', 'support.view', 'support.reply', 'support.assign', 'support.saved_replies',
      'support.escalate', 'support.level2', 'refunds.view', 'refunds.request', 'offers.grant', 'emails.view', 'emails.manage', 'link.support', 'reports.view',
      'support.diagnostics']
    when 'sales' then array['overview.view', 'downloads.view', 'customers.view', 'customers.notes', 'licences.view', 'support.view', 'offers.grant']
    when 'developer' then array['overview.view', 'downloads.view', 'support.diagnostics']
    else '{}'::text[] end
$$;
-- What a staff member can do: their role's defaults, plus ticked extras, minus ticked-off ones. Owners can do everything.
create or replace function public.hq_staff_perms(uid uuid) returns text[]
  language sql stable security definer set search_path = public as $$
  select case when s.role = 'owner' then public.hq_all_perms() else
    array(select distinct p from unnest(public.hq_role_perms(s.role) || s.perms_add) p
          where not (p = any(s.perms_remove)) and p = any(public.hq_all_perms()) order by 1) end
  from hq_staff s where s.user_id = uid and s.active
$$;
create or replace function public.hq_perms() returns text[]
  language sql stable security definer set search_path = public as $$
  select case when public.mfa_ok() then public.hq_staff_perms(auth.uid()) end
$$;
create or replace function public.hq_can(perm text) returns boolean
  language sql stable security definer set search_path = public as $$ select coalesce(perm = any(public.hq_perms()), false) $$;
-- hq_need(array['a.b', 'c.d']): you need at least one of these permissions. (The argument is still called "roles"
-- so the database can update it in place; it now holds permission names.)
create or replace function public.hq_need(roles text[]) returns void
  language plpgsql stable security definer set search_path = public as $$
begin
  if hq_role() is null then raise exception 'Riyeser HQ is for Riyeser staff, signed in with two-step sign-in.'; end if;
  if not coalesce(hq_perms() && roles, false) then raise exception 'Your HQ role can''t do that.'; end if;
end $$;
-- Every HQ action is written here. Never put personal details in it: it is kept for good, even after an account is removed.
create or replace function public.hq_log(act text, det jsonb) returns void
  language sql security definer set search_path = public as $$
  insert into hq_audit (action, details, workspace_id, ticket)
  values (act, det, case when det ->> 'workspace_id' ~ '^[0-9a-f-]{36}$' then (det ->> 'workspace_id')::uuid end, nullif(det ->> 'ticket', ''))
$$;

-- Who am I in HQ (also tells the website whether two-step sign-in is still needed)
create or replace function public.hq_me() returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('role', s.role, 'name', s.display_name, 'active', s.active, 'two_step', public.mfa_ok(),
    'perms', case when s.active then public.hq_staff_perms(s.user_id) end)
  from hq_staff s where s.user_id = auth.uid()
$$;

create or replace function public.hq_overview() returns json
  language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  perform hq_need(array['overview.view']);
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
  perform hq_need(array['customers.view']);
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
  perform hq_need(array['customers.view']);
  select json_build_object(
    'profile', (select json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'legal_name', w.legal_name,
        'tax_number', w.tax_number, 'address', w.address, 'phone', w.phone, 'email', w.email, 'country', w.country,
        'created_at', w.created_at, 'calls_paid_until', w.calls_paid_until, 'require_approval', w.require_approval,
        'trial_days_left', greatest(0, 90 - extract(day from now() - w.created_at)::int), 'kind', w.kind,
        'status', w.status, 'closed_at', w.closed_at, 'closed_reason', w.closed_reason, 'last_active_at', w.last_active_at,
        'duplicate_of', w.duplicate_of, 'duplicate_of_name', (select d.name from workspaces d where d.id = w.duplicate_of),
        'removal_state', w.removal_state) from workspaces w where w.id = ws),
    'people', (select coalesce(json_agg(json_build_object('user_id', m.user_id, 'name', m.display_name, 'role', m.role, 'job_role', m.job_role,
        'extension', m.extension, 'email', u.email, 'joined', m.joined_at, 'two_step', public.has_two_step(m.user_id)) order by m.joined_at), '[]')
        from members m join auth.users u on u.id = m.user_id where m.workspace_id = ws),
    'branches', (select coalesce(json_agg(json_build_object('name', b.name, 'extension', b.extension,
        'people', (select count(*) from branch_members bm where bm.branch_id = b.id)) order by b.extension), '[]') from branches b where b.workspace_id = ws),
    'pcs', (select coalesce(json_agg(json_build_object('name', d.device_name, 'platform', d.platform, 'version', d.app_version,
        'last_seen', d.last_seen, 'person', (select display_name from members m where m.workspace_id = ws and m.user_id = d.user_id))
        order by d.last_seen desc), '[]') from devices d where d.workspace_id = ws),
    'requests_waiting', (select count(*) from join_requests j where j.workspace_id = ws and j.status = 'pending'),
    'notes', (select coalesce(json_agg(json_build_object('body', n.body, 'at', n.created_at,
        'by', (select display_name from hq_staff s where s.user_id = n.author)) order by n.created_at desc), '[]') from hq_notes n where n.workspace_id = ws),
    'extra', public.hq_company_extra(ws)
  ) into r;
  perform hq_log('customer.viewed', json_build_object('workspace_id', ws)::jsonb);
  return r;
end $$;

create or replace function public.hq_set_calls_paid(ws uuid, until date) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['licences.manage']);
  update workspaces set calls_paid_until = until::timestamptz + interval '1 day' - interval '1 second' where id = ws;
  perform hq_log('calls.paid_until', json_build_object('workspace_id', ws, 'until', until)::jsonb);
end $$;

create or replace function public.hq_add_note(ws uuid, body text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['customers.notes']);
  insert into hq_notes (workspace_id, author, body) values (ws, auth.uid(), trim(body));
  perform hq_log('note.added', json_build_object('workspace_id', ws)::jsonb);
end $$;

create or replace function public.hq_staff_list() returns table (user_id uuid, display_name text, role text, active boolean, email text, added_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['overview.view']);
  return query select s.user_id, s.display_name, s.role, s.active, u.email::text, s.added_at from hq_staff s join auth.users u on u.id = s.user_id order by s.added_at;
end $$;

-- Owners add staff (they need a Riyeser account first), change their role, or switch them off.
create or replace function public.hq_add_staff(staff_email text, staff_name text, staff_role text) returns void
  language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  perform hq_need(array['staff.manage']);
  if staff_role not in ('owner', 'finance', 'support', 'senior', 'sales', 'developer') then raise exception 'Choose a role'; end if;
  if staff_role = 'owner' and hq_role() <> 'owner' then raise exception 'Only an HQ owner can make another owner.'; end if;
  select id into uid from auth.users where lower(email::text) = lower(trim(staff_email));
  if uid is null then raise exception 'No Riyeser account with that email yet. Ask them to create one at riyeser.com/link first.'; end if;
  insert into hq_staff (user_id, display_name, role, added_by) values (uid, trim(staff_name), staff_role, auth.uid())
    on conflict (user_id) do update set display_name = excluded.display_name, role = excluded.role, active = true;
  perform hq_log('staff.added', json_build_object('email', staff_email, 'role', staff_role)::jsonb);
end $$;

create or replace function public.hq_set_staff(staff uuid, staff_role text, is_active boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['staff.manage']);
  if staff = auth.uid() then raise exception 'You can''t change your own HQ access. Ask another owner.'; end if;
  if staff_role not in ('owner', 'finance', 'support', 'senior', 'sales', 'developer') then raise exception 'Choose a role'; end if;
  if hq_role() <> 'owner' and (staff_role = 'owner' or (select role from hq_staff where user_id = staff) = 'owner') then
    raise exception 'Only an HQ owner can change an owner.'; end if;
  update hq_staff set role = staff_role, active = is_active where user_id = staff;
  perform hq_log('staff.changed', json_build_object('user_id', staff, 'role', staff_role, 'active', is_active)::jsonb);
end $$;

create or replace function public.hq_history() returns table (at timestamptz, who text, action text, details jsonb)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['audit.view']);
  return query select a.at, coalesce((select display_name from hq_staff s where s.user_id = a.actor), 'Riyeser'), a.action, a.details
    from hq_audit a order by a.at desc limit 300;
end $$;

create or replace function public.hq_downloads(days int) returns table (day date, asset text, total bigint)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['downloads.view']);
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
  if uid is null then raise exception 'No account with that email. Create one at riyeser.com/link first.'; end if;
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

-- ================================================================ Licences online (per company, per program)
-- Paid programs: basic (Accounting Basics), plus (Accounting Plus), payroll, pos, bookings, as_built, calls (Riyeser Link Plus).
-- Free programs (Central, Invoices, PDF, Desk Assistant, Riyeser Link chat) aren't listed: they're always free.
-- With no row, a program is on its free trial: 90 days from when the company joined Riyeser online.
-- Riyeser HQ (owners, finance) sets each one: trial (with its end date), active (paid until), or cancelled.
-- Riyeser Central reads company_licence() and the programs on the PC unlock what's active.
create table if not exists public.company_modules (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  module text not null check (module in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls')),
  status text not null default 'trial' check (status in ('trial', 'active', 'cancelled')),
  trial_ends date,
  paid_until date,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, module)
);
create table if not exists public.company_plans (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  extra_users int not null default 0 check (extra_users between 0 and 10000),
  extra_companies int not null default 0 check (extra_companies between 0 and 1000),
  billing text not null default 'monthly' check (billing in ('monthly', 'yearly')),
  early_bird boolean not null default false,
  early_bird_since date,
  updated_at timestamptz not null default now()
);
alter table public.company_modules enable row level security;
alter table public.company_plans enable row level security;
revoke all on public.company_modules, public.company_plans from anon, authenticated;   -- read through company_licence()

-- One program's state today: {status, active, trial_ends, paid_until, days_left}
create or replace function public.module_state(ws uuid, mod text) returns json
  language plpgsql stable security definer set search_path = public as $$
declare m company_modules; joined date; te date; st text; act boolean; left_days int; wst text;
begin
  select created_at::date, status into joined, wst from workspaces where id = ws;
  -- a suspended or closed business: nothing is active online (the books on its PCs are never touched)
  if wst is distinct from 'active' then
    return json_build_object('status', 'closed', 'active', false, 'trial_ends', null, 'paid_until', null, 'days_left', null);
  end if;
  select * into m from company_modules where workspace_id = ws and module = mod;
  if m.module is null or m.status = 'trial' then
    te := coalesce(m.trial_ends, joined + 90);
    act := te >= current_date; st := case when act then 'trial' else 'ended' end;
    left_days := case when act then te - current_date end;
  elsif m.status = 'active' then
    act := m.paid_until is null or m.paid_until >= current_date; st := case when act then 'active' else 'ended' end;
    left_days := case when act and m.paid_until is not null then m.paid_until - current_date end;
  else   -- cancelled: works until the end of what was paid for
    act := m.paid_until is not null and m.paid_until >= current_date; st := 'cancelled';
    left_days := case when act then m.paid_until - current_date end;
  end if;
  return json_build_object('status', st, 'active', act, 'trial_ends', case when m.module is null or m.status = 'trial' then te end,
                           'paid_until', m.paid_until, 'days_left', left_days);
end $$;

create or replace function public.licence_json(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object(
    'workspace_id', w.id, 'company_code', w.company_code, 'checked_at', now(), 'business_status', w.status,
    'modules', (select json_object_agg(m, public.module_state(w.id, m)) from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m),
    'seats', json_build_object('included', 3, 'extra', coalesce(p.extra_users, 0), 'used', (select count(*) from members where workspace_id = w.id)),
    'extra_companies', coalesce(p.extra_companies, 0), 'billing', coalesce(p.billing, 'monthly'), 'early_bird', coalesce(p.early_bird, false))
  from workspaces w left join company_plans p on p.workspace_id = w.id where w.id = ws
$$;

-- For anyone in the company (Riyeser Central asks this to unlock the programs on the PC).
create or replace function public.company_licence(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from members where workspace_id = ws and user_id = auth.uid()) then raise exception 'You''re not in that company'; end if;
  return licence_json(ws);
end $$;

-- Team Calls is now the 'calls' program (the old calls_paid_until still counts, for companies set up before).
create or replace function public.calls_allowed(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((public.module_state(ws, 'calls') ->> 'active')::boolean, false)
      or exists (select 1 from workspaces where id = ws and calls_paid_until > now())
$$;
create or replace function public.team_features(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('calls', public.calls_allowed(ws),
    'calls_paid', (public.module_state(ws, 'calls') ->> 'status') = 'active' or coalesce(w.calls_paid_until > now(), false),
    'calls_paid_until', coalesce((public.module_state(ws, 'calls') ->> 'paid_until'), w.calls_paid_until::date::text),
    'trial_days_left', coalesce((public.module_state(ws, 'calls') ->> 'days_left')::int, 0))
  from workspaces w where w.id = ws and public.is_member(ws)
$$;

-- HQ: set one program for a company (owners and finance).
-- The licence change itself (no permission check: only called by checked hq_ functions).
create or replace function public.licence_set_module(ws uuid, mod text, new_status text, trial_end date, paid_to date) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if new_status not in ('trial', 'active', 'cancelled') then raise exception 'Choose trial, active or cancelled'; end if;
  if new_status = 'trial' and trial_end is null then raise exception 'A trial needs an end date'; end if;
  if new_status = 'active' and paid_to is null then raise exception 'Active needs a paid-until date'; end if;
  insert into company_modules (workspace_id, module, status, trial_ends, paid_until)
    values (ws, mod, new_status, trial_end, paid_to)
  on conflict (workspace_id, module) do update set status = excluded.status, trial_ends = excluded.trial_ends,
    paid_until = excluded.paid_until, updated_at = now();
  if mod = 'calls' then update workspaces set calls_paid_until = case when new_status = 'active' then paid_to + time '23:59:59' end where id = ws; end if;
end $$;
revoke all on function public.licence_set_module(uuid, text, text, date, date) from public, anon, authenticated;

create or replace function public.hq_set_module(ws uuid, mod text, new_status text, trial_end date, paid_to date) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['licences.manage']);
  perform licence_set_module(ws, mod, new_status, trial_end, paid_to);
  perform hq_log('licence.module', json_build_object('workspace_id', ws, 'module', mod, 'status', new_status, 'trial_ends', trial_end, 'paid_until', paid_to)::jsonb);
end $$;

-- HQ: extra users, extra companies, monthly or yearly, early bird (first 100 businesses only).
create or replace function public.hq_set_plan(ws uuid, users_extra int, companies_extra int, billing_period text, is_early_bird boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare was boolean;
begin
  perform hq_need(array['licences.manage']);
  select early_bird into was from company_plans where workspace_id = ws;
  if is_early_bird and not coalesce(was, false) and (select count(*) from company_plans where early_bird) >= 100 then
    raise exception 'The early bird offer is full: 100 businesses already have it.';
  end if;
  insert into company_plans (workspace_id, extra_users, extra_companies, billing, early_bird, early_bird_since)
    values (ws, users_extra, companies_extra, billing_period, is_early_bird, case when is_early_bird then current_date end)
  on conflict (workspace_id) do update set extra_users = excluded.extra_users, extra_companies = excluded.extra_companies,
    billing = excluded.billing, early_bird = excluded.early_bird,
    early_bird_since = case when excluded.early_bird then coalesce(company_plans.early_bird_since, current_date) end, updated_at = now();
  perform hq_log('licence.plan', json_build_object('workspace_id', ws, 'extra_users', users_extra, 'extra_companies', companies_extra,
    'billing', billing_period, 'early_bird', is_early_bird)::jsonb);
end $$;

-- The old "Team Calls paid until" button now sets the calls program.
create or replace function public.hq_set_calls_paid(ws uuid, until date) returns void
  language plpgsql security definer set search_path = public as $$
begin perform hq_set_module(ws, 'calls', 'active', null, until); end $$;

-- Riyeser list prices, in US dollars a month per business. This is the one place they're set: change a number here,
-- re-run this file, and every HQ estimate follows. Free programs (Central, Invoices, PDF, Desk Assistant, Link chat) cost 0.
create or replace function public.riyeser_price(item text) returns numeric
  language sql immutable set search_path = public as $$
  select (case item
    when 'basic' then 25 when 'plus' then 39 when 'payroll' then 25 when 'pos' then 29 when 'bookings' then 25
    when 'calls' then 39 when 'as_built' then 29
    when 'users_included' then 3     -- people included in each paid program
    when 'extra_user' then 5         -- each person over that, for each paid program
    when 'extra_company' then 10     -- each extra company in Accounting
    else 0 end)::numeric
$$;

-- One bill at list prices (US$). Each paid program: its price, plus US$5 for each person over 3 (for that program).
-- Accounting Plus includes Basics, so Basics is never counted as well. Extra companies count only with Accounting.
-- Yearly = 10 months. Early bird = half the program and user amounts (the caller says if it's still in its 12 months).
create or replace function public.riyeser_bill(mods text[], people int, extra_companies int, billing text, early_bird boolean) returns numeric
  language sql immutable set search_path = public as $$
  with m as (select distinct x from unnest(coalesce(mods, '{}'::text[])) x
             where x = any (array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls'])
               and not (x = 'basic' and 'plus' = any (mods)))
  select round((
      coalesce((select sum(public.riyeser_price(x)
                           + public.riyeser_price('extra_user') * greatest(0, coalesce(people, 0) - public.riyeser_price('users_included'))) from m), 0)
        * case when coalesce(early_bird, false) then 0.5 else 1 end
      + case when exists (select 1 from m where x in ('basic', 'plus'))
             then public.riyeser_price('extra_company') * greatest(0, coalesce(extra_companies, 0)) else 0 end)
    * case when billing = 'yearly' then 10 else 1 end, 2)
$$;

-- How many people a business pays for: everyone in it, or its licence seats (3 + extra users set in HQ) if that's more.
create or replace function public.riyeser_people(ws uuid) returns int
  language sql stable security definer set search_path = public as $$
  select greatest((select count(*) from members where workspace_id = ws)::int,
                  3 + coalesce((select extra_users from company_plans where workspace_id = ws), 0))
$$;

-- What each company pays per month, at list prices in US$ (an estimate: payments aren't connected yet).
-- Paid programs only (not trials). Yearly billing is shown as its monthly share (10 months over 12).
create or replace function public.company_monthly(ws uuid) returns numeric
  language sql stable security definer set search_path = public as $$
  select round(public.riyeser_bill(
      array(select m from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m
            where (public.module_state(ws, m) ->> 'status') = 'active'),
      public.riyeser_people(ws), coalesce(p.extra_companies, 0), 'monthly',
      coalesce(p.early_bird, false) and p.early_bird_since > current_date - 365)
    * case when coalesce(p.billing, 'monthly') = 'yearly' then 10.0 / 12 else 1 end, 2)
  from (select 1) x left join company_plans p on p.workspace_id = ws
$$;

create or replace function public.hq_licences() returns json
  language plpgsql stable security definer set search_path = public as $$
declare r json;
begin
  perform hq_need(array['licences.view']);
  select json_build_object(
    'monthly_estimate', coalesce((select sum(public.company_monthly(id)) from workspaces), 0),
    'paying_companies', (select count(*) from workspaces w where public.company_monthly(w.id) > 0),
    'early_bird_used', (select count(*) from company_plans where early_bird),
    'early_bird_left', greatest(0, 100 - (select count(*) from company_plans where early_bird)),
    'modules', (select json_agg(json_build_object('module', m,
        'active_paid', (select count(*) from workspaces w where (public.module_state(w.id, m) ->> 'status') = 'active'),
        'on_trial', (select count(*) from workspaces w where (public.module_state(w.id, m) ->> 'status') = 'trial'),
        'ended', (select count(*) from workspaces w where (public.module_state(w.id, m) ->> 'status') in ('ended', 'cancelled', 'closed')))) 
      from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m),
    'ending_soon', (select coalesce(json_agg(x order by x.days_left), '[]') from (
        select w.id, w.name, w.company_code, m as module, (public.module_state(w.id, m) ->> 'status') as status,
               (public.module_state(w.id, m) ->> 'days_left')::int as days_left
        from workspaces w, unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m
        where (public.module_state(w.id, m) ->> 'days_left')::int between 0 and 14) x)
  ) into r;
  return r;
end $$;

-- HQ company detail now includes the licence and the monthly estimate.
create or replace function public.hq_company_licence(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['licences.view']);
  return json_build_object('licence', licence_json(ws), 'monthly', company_monthly(ws));
end $$;

revoke all on function public.module_state(uuid, text), public.licence_json(uuid), public.company_licence(uuid),
  public.hq_set_module(uuid, text, text, date, date), public.hq_set_plan(uuid, int, int, text, boolean), public.company_monthly(uuid),
  public.hq_licences(), public.hq_company_licence(uuid), public.riyeser_people(uuid) from public, anon;
grant execute on function public.company_licence(uuid), public.hq_set_module(uuid, text, text, date, date),
  public.hq_set_plan(uuid, int, int, text, boolean), public.hq_licences(), public.hq_company_licence(uuid) to authenticated;
revoke all on function public.module_state(uuid, text), public.licence_json(uuid), public.company_monthly(uuid), public.riyeser_people(uuid) from authenticated;

-- ================================================================ Riyeser HQ, phase 1
-- Support tickets (with escalations), fix-up tools, staff permissions, the full staff audit trail, inactive accounts,
-- the email outbox, refund requests and free periods (one "Approvals" queue for both).
-- Rules: nothing here deletes customer data. The only removal is the owner-approved anonymising of long-closed
-- accounts (hq_remove_accounts). HQ never sees customers' chat messages or books; support tickets are written
-- to Riyeser, so HQ seeing those is fine.

-- ---------------------------------------------------------------- activity (for inactive accounts)
update public.workspaces w set last_active_at = greatest(w.created_at,
    coalesce((select max(d.last_seen) from public.devices d where d.workspace_id = w.id), w.created_at))
  where w.last_active_at is null;
alter table public.workspaces alter column last_active_at set default now();
create index if not exists workspaces_status_active on public.workspaces (status, last_active_at);

-- The website calls this once per visit after sign-in (at most one write an hour).
create or replace function public.touch_activity() returns void
  language sql security definer set search_path = public as $$
  update workspaces set last_active_at = now()
  where status = 'active' and (last_active_at is null or last_active_at < now() - interval '1 hour')
    and id in (select workspace_id from members where user_id = auth.uid())
$$;
-- Signing in counts too (Supabase sets auth.users.last_sign_in_at at each sign-in).
create or replace function public.activity_on_sign_in() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update workspaces set last_active_at = now()
    where status = 'active' and (last_active_at is null or last_active_at < now() - interval '1 hour')
      and id in (select workspace_id from members where user_id = new.id);
  end if;
  return new;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at') then
    drop trigger if exists riyeser_activity_on_sign_in on auth.users;
    create trigger riyeser_activity_on_sign_in after update of last_sign_in_at on auth.users
      for each row execute function public.activity_on_sign_in();
  end if;
exception when insufficient_privilege then raise notice 'Sign-in activity trigger skipped (no permission on auth.users).';
end $$;

-- Two-step sign-in turned on? (for HQ's people list)
create or replace function public.has_two_step(uid uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $$
begin
  return exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.status::text = 'verified');
exception when undefined_table then return null;
end $$;

-- Members of a closed or suspended business: what to tell them at sign-in.
create or replace function public.my_closed_businesses() returns table (id uuid, name text, status text)
  language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.status from members m join workspaces w on w.id = m.workspace_id
  where m.user_id = auth.uid() and w.status <> 'active'
$$;

-- Paying for any program right now? Paid businesses are never closed for being inactive.
create or replace function public.is_paying(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_modules m where m.workspace_id = ws
                   and ((m.status = 'active' and (m.paid_until is null or m.paid_until >= current_date))
                     or (m.status = 'cancelled' and m.paid_until >= current_date)))
      or exists (select 1 from workspaces w where w.id = ws and w.calls_paid_until > now())
$$;

-- ---------------------------------------------------------------- settings the HQ owner can change
create or replace function public.hq_setting_num(k text, dflt numeric) returns numeric
  language sql stable security definer set search_path = public as $$
  select coalesce((select value::numeric from hq_settings where key = k and value ~ '^[0-9]+(\.[0-9]+)?$'), dflt)
$$;
create or replace function public.hq_settings_json() returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object(
    'support.overdue_hours', public.hq_setting_num('support.overdue_hours', 24),
    'support.escalate_hours', public.hq_setting_num('support.escalate_hours', 48),
    'refunds.two_person_threshold', public.hq_setting_num('refunds.two_person_threshold', 200),
    'offers.self_limit_days', public.hq_setting_num('offers.self_limit_days', 31))
$$;
create or replace function public.hq_get_settings() returns json
  language plpgsql stable security definer set search_path = public as $$
begin perform hq_need(array['overview.view']); return hq_settings_json(); end $$;
create or replace function public.hq_set_setting(setting text, val numeric) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['settings.manage']);
  if setting not in ('support.overdue_hours', 'support.escalate_hours', 'refunds.two_person_threshold', 'offers.self_limit_days') then
    raise exception 'That isn''t a setting HQ can change.'; end if;
  if val is null or val <= 0 or val > 100000 then raise exception 'Choose a number above 0.'; end if;
  insert into hq_settings (key, value) values (setting, val::text) on conflict (key) do update set value = excluded.value;
  perform hq_log('settings.changed', jsonb_build_object('setting', setting, 'value', val));
end $$;

-- ---------------------------------------------------------------- email outbox (dormant until a provider is chosen)
-- Only HQ functions and jobs add to it. The daily GitHub job (hq-jobs.yml) sends what's queued, once set up.
create table if not exists public.email_outbox (
  id bigint generated always as identity primary key,
  to_address text check (length(to_address) <= 320),
  to_user uuid,
  subject text not null check (length(subject) between 1 and 200),
  body_text text not null check (length(body_text) <= 20000),
  body_html text check (length(body_html) <= 60000),
  template text not null check (length(template) <= 40),
  workspace_id uuid,
  ticket_id uuid,
  refund_id uuid,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'held')),
  attempts int not null default 0,
  last_error text check (length(last_error) <= 500),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists email_outbox_status on public.email_outbox (status, id);
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated;

create or replace function public.email_esc(t text) returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;
create or replace function public.email_html(subj text, body text) returns text language sql immutable as $$
  select '<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:Segoe UI,Arial,sans-serif;color:#2c3a5a">'
    || '<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="font-weight:800;font-size:20px;color:#0f1d3d;margin-bottom:14px">Riyeser</div>'
    || '<div style="background:#fff;border:1px solid #e3e8f1;border-radius:12px;padding:20px 22px;line-height:1.55;font-size:15px">'
    || '<h1 style="font-size:18px;color:#0f1d3d;margin:0 0 12px">' || public.email_esc(subj) || '</h1>'
    || replace(public.email_esc(body), E'\n', '<br>')
    || '</div><p style="font-size:12px;color:#64708a;margin-top:14px">Riyeser Support &middot; riyeser.com</p></div></body></html>'
$$;
-- Queue one email. With no usable address it's 'held' (HQ can see it and send it again later).
create or replace function public.queue_email(to_uid uuid, to_addr text, tmpl text, subj text, body text, ws uuid, ticket uuid, refund uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare a text := coalesce(nullif(trim(coalesce(to_addr, '')), ''), (select email::text from auth.users where id = to_uid));
begin
  if current_setting('riyeser.removing', true) = 'on' then return; end if;
  insert into email_outbox (to_address, to_user, subject, body_text, body_html, template, workspace_id, ticket_id, refund_id, status)
  values (a, to_uid, left(subj, 200), left(body, 19000) || E'\n\nRiyeser Support\nriyeser.com', email_html(left(subj, 200), left(body, 19000)),
          tmpl, ws, ticket, refund, case when a is null or a !~ '^[^@\s]+@[^@\s]+$' then 'held' else 'queued' end);
end $$;
-- To the business's owner(s).
create or replace function public.queue_email_owners(ws uuid, tmpl text, subj text, body text) returns void
  language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  for o in select user_id from members where workspace_id = ws and role = 'owner' loop
    perform queue_email(o, null, tmpl, subj, body, ws, null, null);
  end loop;
end $$;

-- HQ "Emails" view: counts, recent, held and failed (no message bodies).
create or replace function public.hq_emails() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['emails.view']);
  return json_build_object(
    'counts', (select json_build_object('queued', count(*) filter (where status = 'queued'), 'sent', count(*) filter (where status = 'sent'),
        'failed', count(*) filter (where status = 'failed'), 'held', count(*) filter (where status = 'held'),
        'sent_7d', count(*) filter (where status = 'sent' and sent_at > now() - interval '7 days')) from email_outbox),
    'recent', (select coalesce(json_agg(x order by x.id desc), '[]') from (select id, to_address, subject, template, status, attempts, created_at, sent_at
        from email_outbox order by id desc limit 60) x),
    'problems', (select coalesce(json_agg(x order by x.id desc), '[]') from (select id, to_address, subject, template, status, attempts, last_error, created_at
        from email_outbox where status in ('held', 'failed') order by id desc limit 100) x));
end $$;
create or replace function public.hq_email_resend(email_id bigint) returns void
  language plpgsql security definer set search_path = public as $$
declare a text;
begin
  perform hq_need(array['emails.manage']);
  select coalesce(o.to_address, (select email::text from auth.users where id = o.to_user)) into a from email_outbox o
    where o.id = email_id and o.status in ('held', 'failed');
  if not found then raise exception 'Only held or failed emails can be sent again.'; end if;
  if a is null then raise exception 'That email has no address to send to.'; end if;
  update email_outbox set status = 'queued', attempts = 0, last_error = null, to_address = a where id = email_id;
  perform hq_log('email.resend', jsonb_build_object('email_id', email_id));
end $$;

-- ---------------------------------------------------------------- support tickets
create sequence if not exists public.support_ticket_no start 10234;
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.support_ticket_no'),
  ref text generated always as ('T-' || number::text) stored,
  workspace_id uuid references public.workspaces(id) on delete set null,      -- empty for people with no business
  opened_by uuid references auth.users(id) on delete set null,
  topic text not null default 'other' check (topic in ('billing', 'signin', 'program', 'other')),
  subject text not null check (length(trim(subject)) between 1 and 150),
  status text not null default 'new' check (status in ('new', 'waiting_us', 'waiting_customer', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee uuid references auth.users(id) on delete set null,
  level int not null default 1 check (level between 1 and 3),                  -- 1 Support, 2 Senior / technical, 3 Management
  created_at timestamptz not null default now(),
  first_reply_at timestamptz,
  updated_at timestamptz not null default now(),
  last_customer_at timestamptz,
  last_staff_at timestamptz,
  overdue_at timestamptz,
  escalated_at timestamptz
);
create index if not exists support_tickets_opener on public.support_tickets (opened_by, updated_at desc);
create index if not exists support_tickets_ws on public.support_tickets (workspace_id, updated_at desc);
create index if not exists support_tickets_status on public.support_tickets (status, updated_at desc);
create table if not exists public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id),
  author uuid references auth.users(id) on delete set null,      -- empty: Riyeser itself (automatic notes)
  is_staff boolean not null default false,
  internal boolean not null default false,                         -- a staff-only note: customers never see it
  body text not null check (length(trim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  check (is_staff or not internal)
);
create index if not exists support_messages_ticket on public.support_messages (ticket_id, id);
create table if not exists public.support_reads (
  ticket_id uuid not null references public.support_tickets(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (ticket_id, user_id)
);
create table if not exists public.support_saved_replies (
  id bigint generated always as identity primary key,
  title text not null check (length(trim(title)) between 1 and 80),
  body text not null check (length(trim(body)) between 1 and 5000),
  active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.support_escalations (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id),
  from_level int not null, to_level int not null,
  by_user uuid references auth.users(id) on delete set null,     -- empty: the automatic support sweep
  reason text not null check (length(reason) <= 500),
  at timestamptz not null default now()
);
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_reads enable row level security;
alter table public.support_saved_replies enable row level security;
alter table public.support_escalations enable row level security;
revoke all on public.support_tickets, public.support_messages, public.support_reads, public.support_saved_replies,
  public.support_escalations from anon, authenticated;
revoke all on sequence public.support_ticket_no from anon, authenticated;

-- ---------------------------------------------------------------- the Support workspace: products, diagnostics, promised updates
-- Which product a ticket is about, the next update Riyeser promised the customer (when and who), a planned release
-- (free text for now), the developer bug it's linked to, the diagnostic report, and whether the customer's work is blocked.
-- After it's resolved the customer can rate it (1 to 5). known_issue_id and fixed_in_version are for the known issues
-- board and release tracking (later releases): nullable and unused for now. who_acts: who has to do something next.
-- Diagnostic reports hold technical details only (product, versions, Windows version, error, scrubbed log lines), never
-- customer records. Emails, long numbers and anything after "password" are masked again here, whoever sends them.
create or replace function public.support_scrub(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})', '\1***@\2', 'g'),
    '\m(password|passwd|pwd|secret|token|api[_ -]?key)\M.*', '\1 [removed]', 'gin'),
    '\m\d{4}([ -]\d{4}){3}\M', '[number removed]', 'g'),
    '\m\d{2,3}([ -]\d{3}){2,}\M', '[number removed]', 'g'),
    '\d{7,}', '[number removed]', 'g')
$$;
create or replace function public.support_products() returns text[] language sql immutable as $$
  select array['central', 'accounting', 'invoices', 'pos', 'bookings', 'payroll', 'link', 'linkoffice', 'pdf', 'desk', 'website', 'other']
$$;
create or replace function public.product_label(p text) returns text language sql immutable as $$
  select case p when 'central' then 'Riyeser Central' when 'accounting' then 'Accounting' when 'invoices' then 'Invoices' when 'pos' then 'POS'
    when 'bookings' then 'Bookings' when 'payroll' then 'Payroll' when 'link' then 'Riyeser Link' when 'linkoffice' then 'Link Office'
    when 'pdf' then 'Riyeser PDF' when 'desk' then 'Desk Assistant' when 'website' then 'riyeser.com' else 'Something else' end
$$;
create sequence if not exists public.support_diag_no start 4821;
create table if not exists public.support_diagnostics (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.support_diag_no'),
  ref text generated always as ('DG-' || number::text) stored,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  source text not null default 'web' check (source in ('central', 'web')),
  product text not null default 'other',
  product_version text check (length(product_version) <= 40),
  error_text text check (length(error_text) <= 500),          -- the error message or code, if any
  os text check (length(os) <= 120),                           -- e.g. "Windows 11 Pro (10.0.22631)"
  central_version text check (length(central_version) <= 40),
  programs jsonb not null default '[]'::jsonb,                 -- Riyeser programs on that PC: [{"id": "payroll", "version": "2.8.1"}]
  log_lines text check (length(log_lines) <= 65536),           -- the last lines of the program's technical log (200 at most)
  log_source text check (length(log_source) <= 80),            -- which log, e.g. "Riyeser Link Office log" (never a folder path)
  reported_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists support_diagnostics_ws on public.support_diagnostics (workspace_id, created_at desc);
alter table public.support_diagnostics enable row level security;
revoke all on public.support_diagnostics from anon, authenticated;
-- Customers insert and read only their own reports (Report an issue normally goes through support_report below).
grant select, insert on public.support_diagnostics to authenticated;
grant usage on sequence public.support_diag_no to authenticated;
drop policy if exists sd_read on public.support_diagnostics;
create policy sd_read on public.support_diagnostics for select to authenticated using (created_by = auth.uid());
drop policy if exists sd_insert on public.support_diagnostics;
create policy sd_insert on public.support_diagnostics for insert to authenticated
  with check (created_by = auth.uid() and public.is_member(workspace_id));
-- Every report is tidied before it's saved: scrubbed, at most 200 log lines (64 KB), programs as [{id, version}].
create or replace function public.support_diagnostics_clean() returns trigger language plpgsql as $$
declare lines text[];
begin
  if tg_op = 'UPDATE' then
    if current_setting('riyeser.removing', true) = 'on' then return new; end if;
    raise exception 'Diagnostic reports can''t be changed.';
  end if;
  new.created_at := now();
  if new.product is null or not (new.product = any(public.support_products())) then new.product := 'other'; end if;
  new.error_text := nullif(left(public.support_scrub(new.error_text), 500), '');
  new.product_version := nullif(left(trim(coalesce(new.product_version, '')), 40), '');
  new.os := nullif(left(trim(coalesce(new.os, '')), 120), '');
  new.central_version := nullif(left(trim(coalesce(new.central_version, '')), 40), '');
  new.log_source := nullif(left(regexp_replace(coalesce(new.log_source, ''), '[\\/:]', ' ', 'g'), 80), '');
  if new.reported_at is null or new.reported_at > now() + interval '1 day' or new.reported_at < now() - interval '30 days' then new.reported_at := now(); end if;
  if coalesce(new.log_lines, '') = '' then new.log_lines := null;
  else
    lines := regexp_split_to_array(public.support_scrub(new.log_lines), E'\r?\n');
    if array_length(lines, 1) > 200 then lines := lines[array_length(lines, 1) - 199 : array_length(lines, 1)]; end if;
    new.log_lines := right(array_to_string(lines, E'\n'), 65536);
  end if;
  new.programs := (select coalesce(jsonb_agg(jsonb_build_object('id', y.pid, 'version', y.ver) order by y.pid), '[]') from (
    select distinct on (e ->> 'id') e ->> 'id' as pid, left(nullif(trim(coalesce(e ->> 'version', '')), ''), 40) as ver
    from jsonb_array_elements(case jsonb_typeof(new.programs) when 'array' then new.programs
           when 'object' then (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'version', v)), '[]') from jsonb_each_text(new.programs) x(k, v))
           else '[]'::jsonb end) e
    where jsonb_typeof(e) = 'object' and coalesce(e ->> 'id', '') ~ '^[a-z0-9-]{1,40}$' order by e ->> 'id' limit 60) y);
  return new;
end $$;
drop trigger if exists support_diagnostics_clean on public.support_diagnostics;
create trigger support_diagnostics_clean before insert or update on public.support_diagnostics for each row execute function public.support_diagnostics_clean();

alter table public.support_tickets add column if not exists product text;
do $$ begin
  alter table public.support_tickets add constraint support_tickets_product check (product = any(public.support_products()));
exception when duplicate_object then null; end $$;
alter table public.support_tickets add column if not exists next_update_due timestamptz;
alter table public.support_tickets add column if not exists next_update_owner uuid references auth.users(id) on delete set null;
alter table public.support_tickets add column if not exists update_reminded_at timestamptz;
alter table public.support_tickets add column if not exists planned_release text check (length(planned_release) <= 80);
alter table public.support_tickets add column if not exists bug_ref text check (length(bug_ref) <= 80);
alter table public.support_tickets add column if not exists bug_url text check (bug_url ~ '^https://[^[:space:]]{3,}$' and length(bug_url) <= 300);
alter table public.support_tickets add column if not exists diag_id uuid references public.support_diagnostics(id) on delete set null;
alter table public.support_tickets add column if not exists work_blocked boolean not null default false;
alter table public.support_tickets add column if not exists resolved_at timestamptz;
alter table public.support_tickets add column if not exists rating int check (rating between 1 and 5);
alter table public.support_tickets add column if not exists rating_comment text check (length(rating_comment) <= 1000);
alter table public.support_tickets add column if not exists rated_at timestamptz;
-- later: the known issues board (one known issue, many tickets) and release tracking (the version with the fix)
alter table public.support_tickets add column if not exists known_issue_id uuid;
alter table public.support_tickets add column if not exists fixed_in_version text check (length(fixed_in_version) <= 40);
-- Statuses: New, Investigating, In progress (waiting_us: back with Riyeser, e.g. the customer replied), Waiting on customer, Resolved (done).
alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check check (status in ('new', 'investigating', 'waiting_us', 'waiting_customer', 'done'));
alter table public.support_tickets add column if not exists who_acts text generated always as
  (case when status = 'done' then null when status = 'waiting_customer' then 'customer' else 'riyeser' end) stored;
create index if not exists support_tickets_update_due on public.support_tickets (next_update_due) where status <> 'done' and next_update_due is not null;
create index if not exists support_tickets_product on public.support_tickets (product, updated_at desc);
grant select (product, work_blocked, next_update_due, resolved_at, rating, rating_comment, who_acts) on public.support_tickets to authenticated;
-- Logged phone calls sit in the ticket's thread as staff-only entries.
alter table public.support_messages add column if not exists kind text not null default 'message';
do $$ begin
  alter table public.support_messages add constraint support_messages_kind check (kind in ('message', 'call'));
exception when duplicate_object then null; end $$;
alter table public.support_messages add column if not exists call_direction text check (call_direction in ('in', 'out'));
alter table public.support_messages add column if not exists call_with text check (length(call_with) <= 120);

-- Can this customer see this ticket? Their own, or (owners and admins, after two-step sign-in) their business's.
create or replace function public.can_see_ticket(t uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from support_tickets s where s.id = t and auth.uid() is not null
                 and (s.opened_by = auth.uid() or (s.workspace_id is not null and public.is_admin(s.workspace_id))))
$$;
drop policy if exists st_read on public.support_tickets;
create policy st_read on public.support_tickets for select to authenticated
  using (opened_by = auth.uid() or (workspace_id is not null and public.is_admin(workspace_id)));
drop policy if exists sm_read on public.support_messages;
create policy sm_read on public.support_messages for select to authenticated using (not internal and public.can_see_ticket(ticket_id));
-- Customers read only these columns (never who at Riyeser is assigned, levels or internal notes); writes go through functions.
grant select (id, number, ref, workspace_id, opened_by, topic, subject, status, created_at, updated_at, first_reply_at,
  last_customer_at, last_staff_at) on public.support_tickets to authenticated;
grant select (id, ticket_id, is_staff, internal, body, created_at) on public.support_messages to authenticated;

-- Nobody can edit or delete a support message (only the owner-approved anonymising can blank it).
create or replace function public.support_messages_locked() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Support messages can''t be changed or deleted.'; end if;
  if current_setting('riyeser.removing', true) = 'on' then return new; end if;
  if new.body is distinct from old.body or new.ticket_id <> old.ticket_id or new.is_staff <> old.is_staff
     or new.internal <> old.internal or new.created_at <> old.created_at or (new.author is not null and new.author is distinct from old.author) then
    raise exception 'Support messages can''t be changed or deleted.';
  end if;
  return new;   -- (only a deleted login account's id becoming empty gets through)
end $$;
drop trigger if exists support_messages_locked on public.support_messages;
create trigger support_messages_locked before update or delete on public.support_messages for each row execute function public.support_messages_locked();
create or replace function public.no_delete() returns trigger language plpgsql as $$
begin raise exception 'Rows in % are never deleted.', tg_table_name; end $$;
do $$ declare t text; begin
  foreach t in array array['support_tickets', 'support_escalations', 'email_outbox'] loop
    execute format('drop trigger if exists no_delete on public.%I', t);
    execute format('create trigger no_delete before delete on public.%I for each row execute function public.no_delete()', t);
  end loop;
end $$;

create or replace function public.level_name(l int) returns text language sql immutable as $$
  select case l when 1 then 'Support' when 2 then 'Senior' when 3 then 'Management' else 'Level ' || l end
$$;

-- Customers: ask for help (with or without a business).
create or replace function public.open_ticket(ws uuid, help_topic text, help_subject text, message text) returns json
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; uid uuid := auth.uid(); tp text := coalesce(nullif(help_topic, ''), 'other');
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if ws is not null and not exists (select 1 from members where workspace_id = ws and user_id = uid) then
    raise exception 'You''re not in that business'; end if;
  if tp not in ('billing', 'signin', 'program', 'other') then tp := 'other'; end if;
  if length(trim(coalesce(help_subject, ''))) = 0 or length(trim(coalesce(message, ''))) = 0 then
    raise exception 'Add a subject and a message, then send it again.'; end if;
  if (select count(*) from support_tickets where opened_by = uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You''ve sent a lot of help requests today. Reply to one of them instead and we''ll pick it up.'; end if;
  insert into support_tickets (workspace_id, opened_by, topic, subject, status, last_customer_at)
    values (ws, uid, tp, left(trim(help_subject), 150), 'new', now()) returning * into t;
  insert into support_messages (ticket_id, author, body) values (t.id, uid, left(trim(message), 5000));
  insert into support_reads (ticket_id, user_id) values (t.id, uid) on conflict do nothing;
  perform queue_email(uid, null, 'ticket_received', 'We''ve got your help request (' || t.ref || ')',
    'Hi,' || E'\n\n' || 'Thanks for getting in touch. We''ve got your help request "' || t.subject || '" (' || t.ref || ').' || E'\n\n'
    || 'We''ll reply by email, and you''ll see our answer on your Riyeser home page under "Your help requests":' || E'\n'
    || 'https://riyeser.com/link/?help#' || t.ref || E'\n\n' || 'To add anything, open the request there and reply.', ws, t.id, null);
  return json_build_object('id', t.id, 'ref', t.ref);
end $$;

create or replace function public.reply_ticket(ticket uuid, message text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  if length(trim(coalesce(message, ''))) = 0 then raise exception 'Write a message first.'; end if;
  insert into support_messages (ticket_id, author, body) values (ticket, auth.uid(), left(trim(message), 5000));
  update support_tickets set status = 'waiting_us', last_customer_at = now(), updated_at = now() where id = ticket;
  insert into support_reads (ticket_id, user_id) values (ticket, auth.uid()) on conflict (ticket_id, user_id) do update set read_at = now();
end $$;

-- Customers' list, with how many Riyeser replies they haven't read.
create or replace function public.my_tickets() returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.updated_at desc), '[]') from (
    select t.id, t.ref, t.subject, t.topic, t.status, t.workspace_id, w.name as business, t.opened_by = auth.uid() as mine,
      t.created_at, t.updated_at,
      (select count(*) from support_messages m where m.ticket_id = t.id and m.is_staff and not m.internal
         and m.created_at > coalesce((select r.read_at from support_reads r where r.ticket_id = t.id and r.user_id = auth.uid()), '-infinity')) as unread
    from support_tickets t left join workspaces w on w.id = t.workspace_id
    where auth.uid() is not null and (t.opened_by = auth.uid() or (t.workspace_id is not null and public.is_admin(t.workspace_id)))
    order by t.updated_at desc limit 50) x
$$;
-- One request and its conversation (never internal notes, never staff names), and mark it read.
create or replace function public.my_ticket(ticket uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare r json;
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  select json_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject, 'topic', t.topic, 'status', t.status, 'created_at', t.created_at,
    'messages', (select coalesce(json_agg(json_build_object('id', m.id, 'staff', m.is_staff, 'mine', m.author = auth.uid(),
        'from', case when m.is_staff then 'Riyeser Support'
                     else coalesce((select display_name from members mm where mm.workspace_id = t.workspace_id and mm.user_id = m.author), 'You') end,
        'body', m.body, 'at', m.created_at) order by m.id), '[]') from support_messages m where m.ticket_id = t.id and not m.internal))
    into r from support_tickets t where t.id = ticket;
  insert into support_reads (ticket_id, user_id) values (ticket, auth.uid()) on conflict (ticket_id, user_id) do update set read_at = now();
  return r;
end $$;

-- HQ: who can work a level. Level 1 needs support.reply, level 2 support.level2, level 3 support.level3.
create or replace function public.level_perm(l int) returns text language sql immutable as $$
  select case l when 1 then 'support.reply' when 2 then 'support.level2' else 'support.level3' end
$$;
create or replace function public.hq_can_work(l int) returns boolean
  language sql stable security definer set search_path = public as $$ select public.hq_can(public.level_perm(l)) $$;
create or replace function public.staff_can_work(uid uuid, l int) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.level_perm(l) = any(public.hq_staff_perms(uid)), false)
$$;
create or replace function public.staff_name(uid uuid) returns text
  language sql stable security definer set search_path = public as $$ select display_name from hq_staff where user_id = uid $$;

create or replace function public.hq_tickets(box text, search text) returns json
  language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(search, '')), ''); od numeric := hq_setting_num('support.overdue_hours', 24); r json;
begin
  perform hq_need(array['support.view']);
  with t as (
    select t.*, w.name as business, w.status as business_status,
      (t.overdue_at is not null or (t.first_reply_at is null and t.status <> 'done' and t.created_at < now() - make_interval(secs => od * 3600))) as is_overdue,
      exists (select 1 from support_escalations e where e.ticket_id = t.id) as was_escalated
    from support_tickets t left join workspaces w on w.id = t.workspace_id
    where q is null or t.ref ilike '%' || q || '%' or t.subject ilike '%' || q || '%' or w.name ilike '%' || q || '%' or w.company_code ilike '%' || q || '%'
       or exists (select 1 from auth.users u where u.id = t.opened_by and u.email::text ilike '%' || q || '%')
       or exists (select 1 from support_messages m where m.ticket_id = t.id and m.body ilike '%' || q || '%')
  ), boxed as (
    select t.*, (case coalesce(box, 'open')
      when 'new' then t.status = 'new' when 'waiting_us' then t.status = 'waiting_us' when 'waiting_customer' then t.status = 'waiting_customer'
      when 'done' then t.status = 'done' when 'mine' then t.status <> 'done' and t.assignee = auth.uid()
      when 'unassigned' then t.status <> 'done' and t.assignee is null when 'escalated' then t.status <> 'done' and t.level > 1
      when 'level2' then t.status <> 'done' and t.level = 2 when 'level3' then t.status <> 'done' and t.level = 3
      when 'overdue' then t.status <> 'done' and t.is_overdue when 'all' then true
      else t.status <> 'done' end) as inbox from t)
  select json_build_object(
    'tickets', (select coalesce(json_agg(json_build_object('id', b.id, 'ref', b.ref, 'subject', b.subject, 'topic', b.topic, 'status', b.status,
        'priority', b.priority, 'level', b.level, 'assignee', b.assignee, 'assignee_name', staff_name(b.assignee),
        'workspace_id', b.workspace_id, 'business', b.business, 'business_status', b.business_status,
        'opened_by_name', (select display_name from members m where m.workspace_id = b.workspace_id and m.user_id = b.opened_by),
        'opened_by_email', (select email::text from auth.users u where u.id = b.opened_by),
        'created_at', b.created_at, 'first_reply_at', b.first_reply_at, 'updated_at', b.updated_at, 'last_customer_at', b.last_customer_at,
        'overdue', b.is_overdue, 'escalated', b.was_escalated) order by b.updated_at desc), '[]')
      from (select * from boxed where inbox order by updated_at desc limit 300) b),
    'counts', (select json_build_object('new', count(*) filter (where status = 'new'), 'waiting_us', count(*) filter (where status = 'waiting_us'),
        'waiting_customer', count(*) filter (where status = 'waiting_customer'), 'done', count(*) filter (where status = 'done'),
        'mine', count(*) filter (where status <> 'done' and assignee = auth.uid()), 'unassigned', count(*) filter (where status <> 'done' and assignee is null),
        'escalated', count(*) filter (where status <> 'done' and level > 1), 'level2', count(*) filter (where status <> 'done' and level = 2),
        'level3', count(*) filter (where status <> 'done' and level = 3), 'overdue', count(*) filter (where status <> 'done' and is_overdue)) from t),
    'overdue_hours', od) into r;
  return r;
end $$;

-- The business's summary shown beside a ticket (and in the company panel).
create or replace function public.business_summary(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  return (select json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'status', w.status, 'kind', w.kind,
    'country', w.country, 'last_active_at', w.last_active_at,
    'people', (select count(*) from members m where m.workspace_id = w.id), 'pcs', (select count(*) from devices d where d.workspace_id = w.id),
    'paid', (select coalesce(json_agg(m), '[]') from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m
             where (public.module_state(w.id, m) ->> 'status') = 'active'),
    'trial', (select coalesce(json_agg(m), '[]') from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m
             where (public.module_state(w.id, m) ->> 'status') = 'trial'),
    'monthly', public.company_monthly(w.id), 'credit', public.credit_json(w.id),
    'notes', (select coalesce(json_agg(json_build_object('body', n.body, 'at', n.created_at, 'by', public.staff_name(n.author)) order by n.created_at desc), '[]')
              from (select * from hq_notes where workspace_id = w.id order by created_at desc limit 5) n))
  from workspaces w where w.id = ws);
end $$;

create or replace function public.hq_ticket(ticket uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; r json;
begin
  perform hq_need(array['support.view']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  select json_build_object(
    'ticket', json_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject, 'topic', t.topic, 'status', t.status, 'priority', t.priority,
      'level', t.level, 'assignee', t.assignee, 'assignee_name', staff_name(t.assignee), 'workspace_id', t.workspace_id, 'created_at', t.created_at,
      'first_reply_at', t.first_reply_at, 'updated_at', t.updated_at, 'last_customer_at', t.last_customer_at, 'last_staff_at', t.last_staff_at,
      'overdue_at', t.overdue_at, 'opened_by', t.opened_by, 'staff_started', t.staff_started,
      'opened_by_name', (select display_name from members m where m.workspace_id = t.workspace_id and m.user_id = t.opened_by),
      'opened_by_email', (select email::text from auth.users u where u.id = t.opened_by),
      'product', t.product, 'who_acts', t.who_acts, 'work_blocked', t.work_blocked, 'next_update_due', t.next_update_due,
      'next_update_owner', t.next_update_owner, 'next_update_owner_name', staff_name(t.next_update_owner),
      'update_overdue', t.status <> 'done' and t.next_update_due < now(), 'planned_release', t.planned_release, 'bug_ref', t.bug_ref, 'bug_url', t.bug_url,
      'resolved_at', t.resolved_at, 'rating', t.rating, 'rating_comment', t.rating_comment, 'known_issue_id', t.known_issue_id,
      'fixed_in_version', t.fixed_in_version, 'diag_id', t.diag_id),
    'diagnostic', case when t.diag_id is not null and hq_can('support.diagnostics') then
        (select support_diag_json(d) from support_diagnostics d where d.id = t.diag_id) end,
    'diag_hidden', t.diag_id is not null and not hq_can('support.diagnostics'),
    'pcs', case when t.workspace_id is not null then (select coalesce(json_agg(json_build_object('name', d.device_name, 'platform', d.platform,
        'version', d.app_version, 'programs', coalesce(d.programs, '[]'::jsonb), 'programs_at', d.programs_at, 'last_seen', d.last_seen) order by d.last_seen desc), '[]')
        from devices d where d.workspace_id = t.workspace_id) end,
    'support_notes', case when t.workspace_id is not null then (select coalesce(json_agg(json_build_object('id', n.id, 'body', n.body, 'at', n.created_at,
        'by', staff_name(n.author)) order by n.created_at desc), '[]') from hq_notes n where n.workspace_id = t.workspace_id and n.pinned) end,
    'staff', (select coalesce(json_agg(json_build_object('user_id', s.user_id, 'name', s.display_name, 'can_work', staff_can_work(s.user_id, t.level))
        order by s.display_name), '[]') from hq_staff s where s.active),
    'messages', (select coalesce(json_agg(json_build_object('id', m.id, 'staff', m.is_staff, 'internal', m.internal, 'body', m.body, 'at', m.created_at,
        'kind', m.kind, 'call_direction', m.call_direction, 'call_with', m.call_with,
        'from', case when m.author is null then 'Riyeser (automatic)' when m.is_staff then coalesce(staff_name(m.author), 'Riyeser staff')
                     else coalesce((select display_name from members mm where mm.workspace_id = t.workspace_id and mm.user_id = m.author),
                                   (select email::text from auth.users u where u.id = m.author), 'Customer') end) order by m.id), '[]')
      from support_messages m where m.ticket_id = t.id),
    'escalations', (select coalesce(json_agg(json_build_object('from', e.from_level, 'to', e.to_level, 'by', coalesce(staff_name(e.by_user), 'Automatic'),
        'reason', e.reason, 'at', e.at) order by e.id), '[]') from support_escalations e where e.ticket_id = t.id),
    'business', case when t.workspace_id is not null then business_summary(t.workspace_id) end,
    'refunds', (select coalesce(json_agg(json_build_object('id', f.id, 'ref', f.ref, 'status', f.status, 'amount', f.amount, 'currency', f.currency)), '[]')
      from refund_requests f where f.ticket_id = t.id),
    'can_work', hq_can_work(t.level)) into r;
  perform hq_log('ticket.viewed', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id,
    'diagnostic', case when t.diag_id is not null and hq_can('support.diagnostics') then (select ref from support_diagnostics where id = t.diag_id) end));
  return r;
end $$;

create or replace function public.hq_ticket_reply(ticket uuid, message text, as_note boolean, then_status text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; st text := coalesce(nullif(then_status, ''), 'waiting_customer');
begin
  perform hq_need(array['support.reply']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if not hq_can_work(t.level) then raise exception 'This ticket is with % (level %). Someone who works that level needs to reply.', level_name(t.level), t.level; end if;
  if length(trim(coalesce(message, ''))) = 0 then raise exception 'Write a message first.'; end if;
  insert into support_messages (ticket_id, author, is_staff, internal, body) values (ticket, auth.uid(), true, coalesce(as_note, false), left(trim(message), 5000));
  if coalesce(as_note, false) then
    update support_tickets set updated_at = now() where id = ticket;
    perform hq_log('ticket.note', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id));
    return;
  end if;
  if st not in ('waiting_customer', 'waiting_us', 'investigating', 'done') then st := 'waiting_customer'; end if;
  update support_tickets set first_reply_at = coalesce(first_reply_at, now()), last_staff_at = now(), updated_at = now(), status = st,
    resolved_at = case when st = 'done' then coalesce(resolved_at, now()) end, assignee = coalesce(assignee, auth.uid()) where id = ticket;
  if t.opened_by is not null then
    perform queue_email(t.opened_by, null, 'ticket_reply', 'Re: ' || t.subject || ' (' || t.ref || ')',
      'Hi,' || E'\n\n' || 'Riyeser Support has replied to your help request ' || t.ref || ':' || E'\n\n' || trim(message) || E'\n\n'
      || 'To reply, or to tell us it''s fixed, open it here:' || E'\n' || 'https://riyeser.com/link/?help#' || t.ref, t.workspace_id, t.id, null);
  end if;
  perform hq_log('ticket.replied', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'status', st));
end $$;

create or replace function public.hq_ticket_status(ticket uuid, new_status text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  perform hq_need(array['support.reply']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if not hq_can_work(t.level) then raise exception 'This ticket is with % (level %).', level_name(t.level), t.level; end if;
  if new_status not in ('new', 'investigating', 'waiting_us', 'waiting_customer', 'done') then raise exception 'Choose a status'; end if;
  update support_tickets set status = new_status, updated_at = now(),
    resolved_at = case when new_status = 'done' then coalesce(resolved_at, now()) end where id = ticket;
  perform hq_log('ticket.status', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'was', t.status, 'now', new_status));
end $$;

create or replace function public.hq_ticket_priority(ticket uuid, new_priority text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  perform hq_need(array['support.reply', 'support.assign']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if new_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Choose a priority'; end if;
  update support_tickets set priority = new_priority, updated_at = now() where id = ticket;
  perform hq_log('ticket.priority', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'was', t.priority, 'now', new_priority));
end $$;

-- Assign (or unassign with null). Anyone who can work the level can take it themselves; assigning others needs support.assign.
create or replace function public.hq_ticket_assign(ticket uuid, staff uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  perform hq_need(array['support.view']);
  if not (hq_can('support.assign') or (staff = auth.uid() and hq_can('support.reply'))) then raise exception 'Your HQ role can''t do that.'; end if;
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if staff is not null and not staff_can_work(staff, t.level) then
    raise exception '% can''t work % tickets (level %).', coalesce(staff_name(staff), 'That person'), level_name(t.level), t.level; end if;
  update support_tickets set assignee = staff, updated_at = now() where id = ticket;
  perform hq_log('ticket.assigned', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'to', staff_name(staff)));
end $$;

-- Escalate or de-escalate: a reason is required; it's an internal note. Customers only see "passed to our senior team".
create or replace function public.ticket_move_level(t support_tickets, to_level int, why text, by_uid uuid, assign_to uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare up boolean := to_level > t.level; who text := coalesce(staff_name(by_uid), 'Riyeser'); new_assignee uuid;
begin
  new_assignee := case when assign_to is not null then assign_to
                       when t.assignee is not null and staff_can_work(t.assignee, to_level) then t.assignee end;
  insert into support_escalations (ticket_id, from_level, to_level, by_user, reason) values (t.id, t.level, to_level, by_uid, left(why, 500));
  update support_tickets set level = to_level, assignee = new_assignee, updated_at = now(),
    escalated_at = case when up then now() else escalated_at end,
    status = case when status = 'done' then 'waiting_us' else status end where id = t.id;
  insert into support_messages (ticket_id, author, is_staff, internal, body) values (t.id, by_uid, true, true,
    case when up then 'Escalated' else 'De-escalated' end || ' to ' || level_name(to_level)
    || case when by_uid is null then ' automatically' else ' by ' || who end || ': ' || left(why, 500));
  if up then
    insert into support_messages (ticket_id, author, is_staff, internal, body)
      values (t.id, null, true, false, 'We''ve passed this to our senior team. They''ll reply here.');
  end if;
  perform hq_log(case when up then 'ticket.escalated' else 'ticket.deescalated' end,
    jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'from', t.level, 'to', to_level, 'reason', left(why, 500), 'auto', by_uid is null));
end $$;
create or replace function public.hq_ticket_escalate(ticket uuid, to_level int, reason text, assign_to uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  perform hq_need(array['support.escalate']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if to_level not between 1 and 3 or to_level = t.level then raise exception 'Choose a different level.'; end if;
  if length(trim(coalesce(reason, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  if to_level < t.level and not hq_can_work(t.level) then raise exception 'Only someone who works % tickets can send it back.', level_name(t.level); end if;
  if assign_to is not null and not staff_can_work(assign_to, to_level) then
    raise exception '% can''t work % tickets.', coalesce(staff_name(assign_to), 'That person'), level_name(to_level); end if;
  perform ticket_move_level(t, to_level, trim(reason), auth.uid(), assign_to);
end $$;

-- Saved replies
create or replace function public.hq_saved_replies() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['support.view']);
  return (select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'updated_at', updated_at) order by title), '[]')
          from support_saved_replies where active);
end $$;
create or replace function public.hq_save_reply(reply_id bigint, title text, body text) returns bigint
  language plpgsql security definer set search_path = public as $$
declare i bigint := reply_id;
begin
  perform hq_need(array['support.saved_replies']);
  if i is null then
    insert into support_saved_replies (title, body, updated_by) values (trim(title), trim(body), auth.uid()) returning id into i;
  else
    update support_saved_replies s set title = trim(hq_save_reply.title), body = trim(hq_save_reply.body), updated_by = auth.uid(), updated_at = now() where s.id = i;
  end if;
  perform hq_log('saved_reply.saved', jsonb_build_object('id', i, 'title', trim(title)));
  return i;
end $$;
create or replace function public.hq_retire_reply(reply_id bigint) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['support.saved_replies']);
  update support_saved_replies set active = false, updated_by = auth.uid(), updated_at = now() where id = reply_id;
  perform hq_log('saved_reply.retired', jsonb_build_object('id', reply_id));
end $$;

-- Hourly job: flag tickets not first-replied in 24 hours; escalate ones waiting on us 48 hours (settings change both).
create or replace function public.hq_support_sweep() returns json
  language plpgsql security definer set search_path = public as $$
declare od numeric := hq_setting_num('support.overdue_hours', 24); eh numeric := hq_setting_num('support.escalate_hours', 48);
        n_over int; n_esc int := 0; n_upd int := 0; t support_tickets;
begin
  for t in select * from support_tickets s where s.status <> 'done' and s.next_update_due is not null and s.next_update_due < now()
      and (s.update_reminded_at is null or s.update_reminded_at < s.next_update_due) loop
    update support_tickets set update_reminded_at = now() where id = t.id;
    insert into support_messages (ticket_id, author, is_staff, internal, body) values (t.id, null, true, true,
      'Reminder: the next update to the customer was due ' || to_char(t.next_update_due at time zone 'UTC', 'FMDay DD Mon, FMHH12:MI am') || ' UTC'
      || coalesce(' (' || staff_name(t.next_update_owner) || ')', '') || '. Reply to the customer, then set the next update.');
    if t.next_update_owner is not null then
      perform queue_email(t.next_update_owner, null, 'staff_update_due', 'Update overdue: ' || t.ref,
        'The next update to the customer on ' || t.ref || ' ("' || t.subject || '") was due '
        || to_char(t.next_update_due at time zone 'UTC', 'FMDay DD Mon, FMHH12:MI am') || ' UTC.' || E'\n\n'
        || 'Open it in Riyeser HQ: https://riyeser.com/hq/#/support', null, t.id, null);
    end if;
    n_upd := n_upd + 1;
  end loop;
  update support_tickets set overdue_at = now()
    where status <> 'done' and first_reply_at is null and overdue_at is null and created_at < now() - make_interval(secs => od * 3600);
  get diagnostics n_over = row_count;
  for t in select * from support_tickets s where s.status in ('new', 'investigating', 'waiting_us') and s.level < 3
      and coalesce(s.last_customer_at, s.created_at) < now() - make_interval(secs => eh * 3600)
      and (s.last_staff_at is null or s.last_staff_at < coalesce(s.last_customer_at, s.created_at))
      and (s.escalated_at is null or s.escalated_at < now() - make_interval(secs => eh * 3600)) loop
    perform ticket_move_level(t, t.level + 1, 'No reply in ' || trim_scale(eh)::text || ' hours', null, null);
    n_esc := n_esc + 1;
  end loop;
  if n_over > 0 or n_esc > 0 or n_upd > 0 then
    perform hq_log('sweep.support', jsonb_build_object('overdue', n_over, 'escalated', n_esc, 'updates_overdue', n_upd)); end if;
  return json_build_object('overdue', n_over, 'escalated', n_esc, 'updates_overdue', n_upd);
end $$;

-- ---------------------------------------------------------------- fix-up tools (company panel)
-- Each needs its own permission, a reason and (optionally) the ticket it's for; each is written to the HQ history.
create or replace function public.hq_fix_start(perm text, why text, ticket_ref text) returns text
  language plpgsql security definer set search_path = public as $$
declare tr text := upper(nullif(trim(coalesce(ticket_ref, '')), ''));
begin
  perform hq_need(array[perm]);
  if length(trim(coalesce(why, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  if tr is not null then
    if tr ~ '^[0-9]+$' then tr := 'T-' || tr; end if;
    if not exists (select 1 from support_tickets where ref = tr) then raise exception 'There''s no ticket %.', tr; end if;
  end if;
  perform set_config('riyeser.by_hq', 'on', true);   -- the customer's own change history shows "Riyeser"
  return tr;
end $$;

create or replace function public.hq_edit_business(ws uuid, profile jsonb, reason text, ticket_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare tr text := hq_fix_start('customers.edit', reason, ticket_ref); pr jsonb := coalesce(profile, '{}'); f text[];
begin
  select array_agg(k order by k) into f from jsonb_object_keys(pr) k where k in ('name', 'legal_name', 'tax_number', 'address', 'phone', 'email', 'country');
  update workspaces set
    name = case when pr ? 'name' and length(trim(pr ->> 'name')) > 0 then left(trim(pr ->> 'name'), 80) else name end,
    legal_name = case when pr ? 'legal_name' then nullif(trim(pr ->> 'legal_name'), '') else legal_name end,
    tax_number = case when pr ? 'tax_number' then nullif(trim(pr ->> 'tax_number'), '') else tax_number end,
    address = case when pr ? 'address' then nullif(trim(pr ->> 'address'), '') else address end,
    phone = case when pr ? 'phone' then nullif(trim(pr ->> 'phone'), '') else phone end,
    email = case when pr ? 'email' then nullif(trim(pr ->> 'email'), '') else email end,
    country = case when pr ? 'country' then nullif(trim(pr ->> 'country'), '') else country end
  where id = ws;
  if not found then raise exception 'That business doesn''t exist.'; end if;
  -- field names only: the values are personal details, and the HQ history is kept for good
  perform hq_log('business.edited', jsonb_build_object('workspace_id', ws, 'ticket', tr, 'reason', trim(reason), 'fields', to_jsonb(coalesce(f, '{}'))));
end $$;

-- Reset someone's two-step sign-in (they lost their phone). Only after checking who they are, e.g. calling back
-- on the number on file. Their authenticator is removed; they set it up again at their next sign-in.
create or replace function public.hq_reset_2fa(ws uuid, person uuid, identity_checked text, reason text, ticket_ref text) returns int
  language plpgsql security definer set search_path = public as $$
declare tr text := hq_fix_start('people.reset_2fa', reason, ticket_ref); n int;
begin
  if length(trim(coalesce(identity_checked, ''))) < 6 then
    raise exception 'Say how you checked who they are (for example "called back on the number on file").'; end if;
  if not exists (select 1 from members where workspace_id = ws and user_id = person) then raise exception 'That person isn''t in this business.'; end if;
  delete from auth.mfa_factors where user_id = person;
  get diagnostics n = row_count;
  perform queue_email(person, null, 'mfa_reset', 'Your two-step sign-in was reset',
    'Hi,' || E'\n\n' || 'At your request, Riyeser Support has reset two-step sign-in on your Riyeser account. '
    || 'Next time you sign in at riyeser.com/link you''ll only need your password. Then open Security to set up your authenticator app again.'
    || E'\n\n' || 'If you didn''t ask for this, contact Riyeser Support straight away.', ws, null, null);
  perform hq_log('people.reset_2fa', jsonb_build_object('workspace_id', ws, 'ticket', tr, 'reason', trim(reason), 'user_id', person,
    'identity_checked', trim(identity_checked), 'factors_removed', n));
  return n;
end $$;

create or replace function public.hq_change_owner(ws uuid, new_owner uuid, reason text, ticket_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare tr text := hq_fix_start('people.change_owner', reason, ticket_ref);
begin
  if not exists (select 1 from members where workspace_id = ws and user_id = new_owner) then raise exception 'Choose someone who is in this business.'; end if;
  if exists (select 1 from members where workspace_id = ws and user_id = new_owner and role = 'owner') then raise exception 'They''re already the owner.'; end if;
  update members set role = 'admin', job_role = case when job_role = 'owner' then 'manager' else job_role end where workspace_id = ws and role = 'owner';
  update members set role = 'owner', job_role = 'owner' where workspace_id = ws and user_id = new_owner;
  perform hq_log('people.change_owner', jsonb_build_object('workspace_id', ws, 'ticket', tr, 'reason', trim(reason), 'new_owner', new_owner));
end $$;

-- Close, suspend or reopen a business. It's never deleted: closed businesses are hidden from their people and
-- their programs' online licence reads as not active.
create or replace function public.hq_set_business_status(ws uuid, new_status text, reason text, ticket_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare tr text := hq_fix_start('business.close', reason, ticket_ref); w workspaces;
begin
  select * into w from workspaces where id = ws;
  if w.id is null then raise exception 'That business doesn''t exist.'; end if;
  if new_status not in ('active', 'suspended', 'closed') then raise exception 'Choose open, suspended or closed.'; end if;
  if w.removal_state = 'removed' then raise exception 'This account''s details were removed. It can''t be reopened.'; end if;
  if new_status = w.status then raise exception 'It''s already %.', case new_status when 'active' then 'open' else new_status end; end if;
  update workspaces set status = new_status,
    closed_at = case when new_status = 'active' then null else now() end,
    closed_reason = case when new_status = 'active' then null else left(trim(reason), 300) end,
    closed_by = case when new_status = 'active' then null else auth.uid() end,
    duplicate_of = case when new_status = 'active' then null else duplicate_of end,
    removal_state = null, removal_ready_at = null,
    last_active_at = case when new_status = 'active' then now() else last_active_at end
  where id = ws;
  perform queue_email_owners(ws, case when new_status = 'active' then 'business_reopened' else 'business_closed' end,
    case when new_status = 'active' then w.name || ' is open again on Riyeser' else w.name || ' has been ' || new_status || ' on Riyeser' end,
    case when new_status = 'active' then 'Hi,' || E'\n\n' || w.name || ' is open again. Sign in at riyeser.com/link to carry on where you left off.'
         else 'Hi,' || E'\n\n' || w.name || ' has been ' || new_status || ' on Riyeser. Its online account isn''t available, and your programs '
           || 'will show their licence as not active. The books on your PCs are not touched.' || E'\n\n'
           || 'If you think this is a mistake, or you''d like it reopened, contact Riyeser Support.' end);
  perform hq_log(case when new_status = 'active' then 'business.reopened' when new_status = 'suspended' then 'business.suspended' else 'business.closed' end,
    jsonb_build_object('workspace_id', ws, 'ticket', tr, 'reason', trim(reason), 'was', w.status));
end $$;

create or replace function public.hq_close_duplicate(ws uuid, duplicate_of_ws uuid, reason text, ticket_ref text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if ws = duplicate_of_ws then raise exception 'Choose a different business.'; end if;
  if not exists (select 1 from workspaces where id = duplicate_of_ws) then raise exception 'Choose the business it duplicates.'; end if;
  perform hq_set_business_status(ws, 'closed', reason, ticket_ref);
  update workspaces set duplicate_of = duplicate_of_ws, closed_reason = left('Duplicate: ' || trim(reason), 300) where id = ws;
  perform hq_log('business.duplicate', jsonb_build_object('workspace_id', ws, 'duplicate_of', duplicate_of_ws, 'ticket', upper(nullif(trim(coalesce(ticket_ref, '')), ''))));
end $$;

-- ---------------------------------------------------------------- inactive accounts
-- The owner's rule: free accounts close after 12 months unused (warnings 30 and 7 days before); 2 years after
-- closing they're ready for removal, which an HQ owner approves (never automatic). Paid businesses are never closed
-- for this, and the books on customers' PCs are never touched.
create or replace function public.inactivity_email(w workspaces, days_left int, stage int) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform queue_email_owners(w.id, 'inactive_warning_' || stage,
    w.name || ' will close in ' || days_left || ' days',
    'Hi,' || E'\n\n' || 'Nobody has used ' || w.name || ' on Riyeser online for nearly a year. To keep things tidy, free accounts that '
    || 'haven''t been used for 12 months are closed. ' || w.name || ' will close in ' || days_left || ' days.' || E'\n\n'
    || 'To keep it open, just sign in at riyeser.com/link. That''s all you need to do.' || E'\n\n'
    || 'The books on your PCs are never touched.');
end $$;

create or replace function public.hq_inactivity_sweep() returns json
  language plpgsql security definer set search_path = public as $$
declare w workspaces; n30 int := 0; n7 int := 0; nclosed int := 0; nready int := 0; la timestamptz; due timestamptz;
begin
  for w in select * from workspaces where status = 'active' loop
    if is_paying(w.id) then continue; end if;
    la := coalesce(w.last_active_at, w.created_at); due := la + interval '12 months';
    if now() >= due then
      -- close only once a 7-day warning has had its 7 days (an overdue account gets the warning first)
      if w.warned_7_at is not null and w.warned_7_at >= la and w.warned_7_at <= now() - interval '7 days' then
        update workspaces set status = 'closed', closed_at = now(), closed_reason = 'inactive', closed_by = null where id = w.id;
        perform queue_email_owners(w.id, 'business_closed', w.name || ' has been closed on Riyeser',
          'Hi,' || E'\n\n' || 'Nobody has used ' || w.name || ' on Riyeser online for 12 months, so we''ve closed it. '
          || 'The books on your PCs are not touched.' || E'\n\n' || 'If you''d like it back, contact Riyeser Support and we''ll reopen it.');
        perform hq_log('business.closed_inactive', jsonb_build_object('workspace_id', w.id));
        nclosed := nclosed + 1;
      elsif w.warned_7_at is null or w.warned_7_at < la then
        update workspaces set warned_7_at = now() where id = w.id; perform inactivity_email(w, 7, 7); n7 := n7 + 1;
      end if;
    elsif now() >= due - interval '7 days' then
      if w.warned_7_at is null or w.warned_7_at < la then
        update workspaces set warned_7_at = now() where id = w.id; perform inactivity_email(w, greatest(1, ceil(extract(epoch from due - now()) / 86400)::int), 7); n7 := n7 + 1;
      end if;
    elsif now() >= due - interval '30 days' then
      if w.warned_30_at is null or w.warned_30_at < la then
        update workspaces set warned_30_at = now() where id = w.id; perform inactivity_email(w, ceil(extract(epoch from due - now()) / 86400)::int, 30); n30 := n30 + 1;
      end if;
    end if;
  end loop;
  update workspaces set removal_state = 'ready', removal_ready_at = now()
    where status = 'closed' and removal_state is null and closed_at < now() - interval '2 years';
  get diagnostics nready = row_count;
  perform hq_log('sweep.inactivity', jsonb_build_object('warned_30', n30, 'warned_7', n7, 'closed', nclosed, 'ready_for_removal', nready));
  return json_build_object('warned_30', n30, 'warned_7', n7, 'closed', nclosed, 'ready_for_removal', nready);
end $$;

create or replace function public.hq_inactive_accounts() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['customers.view', 'accounts.inactive']);
  return json_build_object(
    'approaching', (select coalesce(json_agg(json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'kind', w.kind,
        'last_active_at', coalesce(w.last_active_at, w.created_at), 'closes_at', coalesce(w.last_active_at, w.created_at) + interval '12 months',
        'warned_30_at', w.warned_30_at, 'warned_7_at', w.warned_7_at) order by coalesce(w.last_active_at, w.created_at)), '[]')
      from workspaces w where w.status = 'active' and coalesce(w.last_active_at, w.created_at) < now() - interval '12 months' + interval '60 days'
        and not public.is_paying(w.id)),
    'closed', (select coalesce(json_agg(json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'kind', w.kind,
        'last_active_at', coalesce(w.last_active_at, w.created_at), 'closed_at', w.closed_at, 'ready_at', w.closed_at + interval '2 years') order by w.closed_at), '[]')
      from workspaces w where w.status = 'closed' and w.closed_reason = 'inactive' and w.removal_state is null),
    'ready', (select coalesce(json_agg(json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'kind', w.kind,
        'last_active_at', coalesce(w.last_active_at, w.created_at), 'closed_at', w.closed_at, 'closed_reason', w.closed_reason,
        'removal_ready_at', w.removal_ready_at) order by w.closed_at), '[]')
      from workspaces w where w.removal_state = 'ready'),
    'removed', (select count(*) from workspaces where removal_state = 'removed'),
    'can_remove', hq_can('accounts.inactive'));
end $$;

-- Owner-approved removal of personal details from accounts that have been closed for 2 years. Rows stay; text is
-- blanked. Login accounts (auth.users) are not deleted here: that's a later step with the service key (see RUNBOOK).
create or replace function public.hq_remove_accounts(ids uuid[], reason text) returns int
  language plpgsql security definer set search_path = public as $$
declare ws uuid; n int := 0;
begin
  perform hq_need(array['accounts.inactive']);
  if hq_role() <> 'owner' then raise exception 'Only an HQ owner can approve removing accounts.'; end if;
  if length(trim(coalesce(reason, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  if exists (select 1 from unnest(ids) i where not exists (select 1 from workspaces w where w.id = i and w.removal_state = 'ready')) then
    raise exception 'Only accounts marked "ready for removal" can be removed.'; end if;
  perform set_config('riyeser.removing', 'on', true);
  foreach ws in array ids loop
    update messages set body = '[removed]' where workspace_id = ws;
    update channels set topic = null where workspace_id = ws;
    update members set display_name = 'Removed person' where workspace_id = ws;
    update join_requests set display_name = 'Removed person', email = null, note = null where workspace_id = ws;
    update devices set device_name = null where workspace_id = ws;
    update branches set name = 'Branch ' || left(id::text, 8) where workspace_id = ws;
    update audit_log set details = '{"removed": true}'::jsonb where workspace_id = ws;
    update hq_notes set body = '[removed]' where workspace_id = ws;
    update support_messages set body = '[removed]' where ticket_id in (select id from support_tickets where workspace_id = ws);
    update support_tickets set subject = '[removed]', rating_comment = null where workspace_id = ws;
    update support_diagnostics set error_text = null, log_lines = null, os = null where workspace_id = ws;
    update refund_requests set explanation = '[removed]', invoice_ref = null where workspace_id = ws;
    update email_outbox set to_address = null, subject = '[removed]', body_text = '[removed]', body_html = null,
      status = case when status = 'queued' then 'held' else status end where workspace_id = ws;
    update workspaces set name = 'Removed business', legal_name = null, tax_number = null, address = null, phone = null, email = null,
      removal_state = 'removed', removed_at = now() where id = ws;
    n := n + 1;
  end loop;
  perform set_config('riyeser.removing', 'off', true);
  -- the anonymous record: how many, when, why, by whom (no names)
  perform hq_log('accounts.removed', jsonb_build_object('count', n, 'reason', trim(reason), 'workspace_ids', to_jsonb(ids)));
  return n;
end $$;

-- ---------------------------------------------------------------- refunds and account credit
create sequence if not exists public.refund_no start 1042;
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.refund_no'),
  ref text generated always as ('R-' || number::text) stored,
  workspace_id uuid not null references public.workspaces(id),
  requested_by uuid references auth.users(id) on delete set null,
  on_behalf_by uuid references auth.users(id) on delete set null,     -- HQ staff who entered it for the customer
  ticket_id uuid references public.support_tickets(id),
  for_what text not null check (length(trim(for_what)) between 1 and 120),   -- plan / program
  period text check (length(period) <= 80),
  invoice_ref text check (length(invoice_ref) <= 80),                 -- free text until billing (phase 2)
  amount numeric(12, 2) not null check (amount > 0 and amount < 1000000),
  currency text not null default 'USD' check (currency in ('FJD', 'AUD', 'NZD', 'USD')),   -- what was actually paid; US$ by default
  reason_category text not null check (reason_category in ('mistake', 'didnt_work', 'cancelled', 'duplicate', 'other')),
  explanation text check (length(explanation) <= 2000),
  status text not null default 'submitted' check (status in ('submitted', 'reviewing', 'approved', 'partly_approved', 'declined', 'paid')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_reason text check (length(decision_reason) <= 1000),
  amount_approved numeric(12, 2) check (amount_approved >= 0),
  needs_second boolean not null default false,
  second_approver uuid references auth.users(id) on delete set null,
  second_approved_at timestamptz,
  paid_at timestamptz,
  paid_method text check (paid_method in ('card', 'bank', 'mpaisa', 'credit')),
  paid_reference text check (length(paid_reference) <= 120),
  paid_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (second_approver is null or second_approver is distinct from decided_by)   -- two different people, always
);
create index if not exists refund_requests_ws on public.refund_requests (workspace_id, created_at desc);
alter table public.refund_requests alter column currency set default 'USD';   -- prices are in US dollars now
create table if not exists public.account_credits (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id),
  amount numeric(12, 2) not null,
  currency text not null check (currency in ('FJD', 'AUD', 'NZD', 'USD')),
  refund_id uuid references public.refund_requests(id),
  note text check (length(note) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.refund_requests enable row level security;
alter table public.account_credits enable row level security;
revoke all on public.refund_requests, public.account_credits from anon, authenticated;
revoke all on sequence public.refund_no from anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['refund_requests', 'account_credits'] loop
    execute format('drop trigger if exists no_delete on public.%I', t);
    execute format('create trigger no_delete before delete on public.%I for each row execute function public.no_delete()', t);
  end loop;
end $$;
-- Customers (owners and admins, after two-step sign-in) can read their business's requests; changes go through functions.
drop policy if exists rr_read on public.refund_requests;
create policy rr_read on public.refund_requests for select to authenticated using (public.is_admin(workspace_id));
grant select (id, number, ref, workspace_id, for_what, period, invoice_ref, amount, currency, reason_category, explanation, status,
  decision_reason, amount_approved, paid_at, created_at, updated_at) on public.refund_requests to authenticated;

create or replace function public.credit_json(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(currency, total), '{}') from (
    select currency, sum(amount) as total from account_credits where workspace_id = ws group by currency having sum(amount) <> 0) c
$$;

create or replace function public.refund_reason_name(c text) returns text language sql immutable as $$
  select case c when 'mistake' then 'Charged by mistake' when 'didnt_work' then 'It didn''t work' when 'cancelled' then 'I cancelled'
    when 'duplicate' then 'Charged twice' else 'Something else' end
$$;

-- Make a refund request (shared by customers and staff entering one from a ticket).
create or replace function public.refund_insert(ws uuid, by_customer uuid, by_staff uuid, ticket uuid, for_what text, period text, invoice_ref text,
    amount numeric, currency text, reason_category text, explanation text) returns json
  language plpgsql security definer set search_path = public as $$
declare f refund_requests; tk support_tickets; cur text := upper(coalesce(nullif(currency, ''), 'USD')); who uuid;
begin
  if amount is null or amount <= 0 then raise exception 'Enter the amount you''d like back.'; end if;
  if cur not in ('FJD', 'AUD', 'NZD', 'USD') then raise exception 'Choose USD, FJD, AUD or NZD.'; end if;
  if reason_category not in ('mistake', 'didnt_work', 'cancelled', 'duplicate', 'other') then raise exception 'Choose a reason.'; end if;
  if length(trim(coalesce(for_what, ''))) = 0 then raise exception 'Say what the refund is for.'; end if;
  if ticket is not null then select * into tk from support_tickets where id = ticket; end if;
  who := coalesce(by_customer, tk.opened_by);
  -- the conversation happens on a billing ticket: link the one given, or open one
  if tk.id is null then
    insert into support_tickets (workspace_id, opened_by, topic, subject, status, last_customer_at)
      values (ws, who, 'billing', 'Refund request', 'new', now()) returning * into tk;
  end if;
  insert into refund_requests (workspace_id, requested_by, on_behalf_by, ticket_id, for_what, period, invoice_ref, amount, currency, reason_category, explanation)
    values (ws, who, by_staff, tk.id, left(trim(for_what), 120), nullif(left(trim(coalesce(period, '')), 80), ''),
            nullif(left(trim(coalesce(invoice_ref, '')), 80), ''), round(amount, 2), cur, reason_category, nullif(left(trim(coalesce(explanation, '')), 2000), ''))
    returning * into f;
  update support_tickets set subject = case when subject = 'Refund request' then 'Refund request ' || f.ref else subject end, updated_at = now() where id = tk.id;
  insert into support_messages (ticket_id, author, is_staff, body) values (tk.id, coalesce(by_staff, who), by_staff is not null,
    'Refund request ' || f.ref || ': ' || f.currency || ' ' || f.amount || ' for ' || f.for_what || coalesce(' (' || f.period || ')', '')
    || coalesce(', invoice ' || f.invoice_ref, '') || '. Reason: ' || refund_reason_name(f.reason_category) || '.' || coalesce(E'\n' || f.explanation, ''));
  if who is not null then
    perform queue_email(who, null, 'refund_received', 'We''ve got your refund request (' || f.ref || ')',
      'Hi,' || E'\n\n' || 'We''ve got your request for a refund of ' || f.currency || ' ' || f.amount || ' (' || f.ref || '). '
      || 'We''ll look at it within 2 business days and let you know by email. You can follow it on your Riyeser home page at riyeser.com/link.',
      ws, tk.id, f.id);
  end if;
  return json_build_object('id', f.id, 'ref', f.ref, 'ticket_id', tk.id, 'ticket_ref', tk.ref);
end $$;
revoke all on function public.refund_insert(uuid, uuid, uuid, uuid, text, text, text, numeric, text, text, text) from public, anon, authenticated;

-- Customers: only the business's owner or an admin (with two-step sign-in) can ask for a refund.
create or replace function public.request_refund(ws uuid, for_what text, period text, invoice_ref text, amount numeric, currency text,
    reason_category text, explanation text, ticket uuid) returns json
  language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(ws) then raise exception 'Only the business''s owner or an admin can ask for a refund.'; end if;
  if ticket is not null and not exists (select 1 from support_tickets where id = ticket and workspace_id = ws and can_see_ticket(ticket)) then
    raise exception 'We couldn''t find that help request.'; end if;
  if (select count(*) from refund_requests where workspace_id = ws and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You''ve sent several refund requests today. We''ll look at those first.'; end if;
  return refund_insert(ws, auth.uid(), null, ticket, for_what, period, invoice_ref, amount, currency, reason_category, explanation);
end $$;
create or replace function public.my_refunds(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', f.id, 'ref', f.ref, 'for_what', f.for_what, 'period', f.period, 'amount', f.amount,
      'currency', f.currency, 'amount_approved', f.amount_approved, 'created_at', f.created_at, 'paid_at', f.paid_at,
      'ticket_id', f.ticket_id,
      -- customers see "approved" only once both approvals are in; never staff names
      'status', case when f.status in ('approved', 'partly_approved') and f.needs_second and f.second_approver is null then 'reviewing' else f.status end,
      'decision_reason', case when f.status = 'declined' or (f.status in ('approved', 'partly_approved', 'paid') and (not f.needs_second or f.second_approver is not null))
                              then f.decision_reason end) order by f.created_at desc), '[]')
  from refund_requests f where public.is_admin(ws) and f.workspace_id = ws
$$;

-- Staff: enter a refund request for a customer from their ticket.
create or replace function public.hq_refund_create(ticket uuid, for_what text, period text, invoice_ref text, amount numeric, currency text,
    reason_category text, explanation text) returns json
  language plpgsql security definer set search_path = public as $$
declare tk support_tickets; r json;
begin
  perform hq_need(array['refunds.request', 'refunds.approve']);
  select * into tk from support_tickets where id = ticket;
  if tk.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if tk.workspace_id is null then raise exception 'This ticket isn''t linked to a business, so there''s nothing to refund.'; end if;
  r := refund_insert(tk.workspace_id, null, auth.uid(), ticket, for_what, period, invoice_ref, amount, currency, reason_category, explanation);
  perform hq_log('refund.created', jsonb_build_object('workspace_id', tk.workspace_id, 'ticket', tk.ref, 'refund', r ->> 'ref', 'amount', amount, 'currency', currency));
  return r;
end $$;

create or replace function public.refund_row_json(f refund_requests) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', f.id, 'ref', f.ref, 'workspace_id', f.workspace_id, 'business', (select name from workspaces where id = f.workspace_id),
    'requested_by_name', coalesce((select display_name from members m where m.workspace_id = f.workspace_id and m.user_id = f.requested_by), 'Customer'),
    'on_behalf_by', public.staff_name(f.on_behalf_by), 'ticket_id', f.ticket_id, 'ticket_ref', (select ref from support_tickets where id = f.ticket_id),
    'for_what', f.for_what, 'period', f.period, 'invoice_ref', f.invoice_ref, 'amount', f.amount, 'currency', f.currency,
    'reason_category', f.reason_category, 'explanation', f.explanation, 'status', f.status, 'decided_by', f.decided_by,
    'decided_by_name', public.staff_name(f.decided_by), 'decided_at', f.decided_at, 'decision_reason', f.decision_reason,
    'amount_approved', f.amount_approved, 'needs_second', f.needs_second, 'second_approver_name', public.staff_name(f.second_approver),
    'second_approved_at', f.second_approved_at, 'waiting_second', f.needs_second and f.second_approver is null and f.status in ('approved', 'partly_approved'),
    'paid_at', f.paid_at, 'paid_method', f.paid_method, 'paid_reference', f.paid_reference, 'created_at', f.created_at)
$$;

create or replace function public.hq_refunds(box text) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['refunds.view']);
  return json_build_object(
    'refunds', (select coalesce(json_agg(refund_row_json(f) order by f.created_at desc), '[]') from (select * from refund_requests f where
      case coalesce(box, 'open')
        when 'new' then f.status = 'submitted' when 'reviewing' then f.status = 'reviewing'
        when 'second' then f.status in ('approved', 'partly_approved') and f.needs_second and f.second_approver is null
        when 'to_pay' then f.status in ('approved', 'partly_approved') and (not f.needs_second or f.second_approver is not null)
        when 'paid' then f.status = 'paid' when 'declined' then f.status = 'declined' when 'all' then true
        else f.status not in ('paid', 'declined') end order by f.created_at desc limit 300) f),
    'counts', (select json_build_object('new', count(*) filter (where status = 'submitted'), 'reviewing', count(*) filter (where status = 'reviewing'),
        'second', count(*) filter (where status in ('approved', 'partly_approved') and needs_second and second_approver is null),
        'to_pay', count(*) filter (where status in ('approved', 'partly_approved') and (not needs_second or second_approver is not null)),
        'paid', count(*) filter (where status = 'paid'), 'declined', count(*) filter (where status = 'declined')) from refund_requests),
    'threshold', hq_setting_num('refunds.two_person_threshold', 200));
end $$;

create or replace function public.refund_decided_email(f refund_requests) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if f.requested_by is null then return; end if;
  if f.status = 'declined' then
    perform queue_email(f.requested_by, null, 'refund_declined', 'About your refund request (' || f.ref || ')',
      'Hi,' || E'\n\n' || 'We''ve looked at your refund request ' || f.ref || ' and we can''t give a refund this time.' || E'\n\n'
      || 'Why: ' || coalesce(f.decision_reason, '') || E'\n\n' || 'If you''d like to talk about it, reply on your help request at riyeser.com/link.',
      f.workspace_id, f.ticket_id, f.id);
  else
    perform queue_email(f.requested_by, null, 'refund_approved', 'Your refund is approved (' || f.ref || ')',
      'Hi,' || E'\n\n' || 'Good news: we''ve approved a refund of ' || f.currency || ' ' || f.amount_approved
      || case when f.status = 'partly_approved' then ' (part of the ' || f.currency || ' ' || f.amount || ' you asked for)' else '' end
      || ' for request ' || f.ref || '.' || E'\n\n' || coalesce(f.decision_reason || E'\n\n', '')
      || 'We''ll let you know when it''s been paid.', f.workspace_id, f.ticket_id, f.id);
  end if;
end $$;

create or replace function public.hq_refund_review(refund uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare f refund_requests;
begin
  perform hq_need(array['refunds.approve']);
  update refund_requests set status = 'reviewing', updated_at = now() where id = refund and status = 'submitted' returning * into f;
  if f.id is null then raise exception 'Only a new request can be moved to reviewing.'; end if;
  perform hq_log('refund.reviewing', jsonb_build_object('workspace_id', f.workspace_id, 'refund', f.ref));
end $$;

-- Approve, partly approve or decline (reason required). Over the threshold, a second person must also approve.
create or replace function public.hq_refund_decide(refund uuid, decision text, approved_amount numeric, reason text) returns void
  language plpgsql security definer set search_path = public as $$
declare f refund_requests; amt numeric; thr numeric := hq_setting_num('refunds.two_person_threshold', 200);
begin
  perform hq_need(array['refunds.approve']);
  select * into f from refund_requests where id = refund for update;
  if f.id is null then raise exception 'That refund request doesn''t exist.'; end if;
  if f.status not in ('submitted', 'reviewing') then raise exception 'That request has already been decided.'; end if;
  if length(trim(coalesce(reason, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  if decision = 'decline' then amt := 0;
  elsif decision = 'approve' then amt := f.amount;
  elsif decision = 'partly' then
    amt := round(approved_amount, 2);
    if amt is null or amt <= 0 or amt >= f.amount then raise exception 'For a part refund, enter an amount between 0 and %.', f.amount; end if;
  else raise exception 'Choose approve, partly approve or decline.'; end if;
  update refund_requests set status = case decision when 'decline' then 'declined' when 'approve' then 'approved' else 'partly_approved' end,
    amount_approved = amt, decided_by = auth.uid(), decided_at = now(), decision_reason = left(trim(reason), 1000),
    needs_second = decision <> 'decline' and amt > thr, updated_at = now() where id = refund returning * into f;
  if not f.needs_second then perform refund_decided_email(f); end if;
  perform hq_log('refund.' || case decision when 'decline' then 'declined' when 'approve' then 'approved' else 'partly_approved' end,
    jsonb_build_object('workspace_id', f.workspace_id, 'refund', f.ref, 'amount', amt, 'currency', f.currency, 'reason', left(trim(reason), 1000),
      'needs_second', f.needs_second, 'ticket', (select ref from support_tickets where id = f.ticket_id)));
end $$;

create or replace function public.hq_refund_second(refund uuid, reason text) returns void
  language plpgsql security definer set search_path = public as $$
declare f refund_requests;
begin
  perform hq_need(array['refunds.approve']);
  select * into f from refund_requests where id = refund for update;
  if f.id is null then raise exception 'That refund request doesn''t exist.'; end if;
  if not (f.needs_second and f.second_approver is null and f.status in ('approved', 'partly_approved')) then
    raise exception 'That request isn''t waiting for a second approval.'; end if;
  if f.decided_by = auth.uid() then raise exception 'The same person can''t give both approvals. Ask another staff member with refunds.approve.'; end if;
  update refund_requests set second_approver = auth.uid(), second_approved_at = now(), updated_at = now() where id = refund returning * into f;
  perform refund_decided_email(f);
  perform hq_log('refund.second_approved', jsonb_build_object('workspace_id', f.workspace_id, 'refund', f.ref, 'amount', f.amount_approved,
    'currency', f.currency, 'reason', nullif(trim(coalesce(reason, '')), '')));
end $$;

-- Mark as paid (refunds done by hand until the payment provider comes in phase 2). Credit on account is recorded.
create or replace function public.hq_refund_paid(refund uuid, method text, reference text) returns void
  language plpgsql security definer set search_path = public as $$
declare f refund_requests;
begin
  perform hq_need(array['refunds.pay']);
  select * into f from refund_requests where id = refund for update;
  if f.id is null then raise exception 'That refund request doesn''t exist.'; end if;
  if f.status not in ('approved', 'partly_approved') then raise exception 'Only an approved refund can be marked as paid.'; end if;
  if f.needs_second and f.second_approver is null then raise exception 'This refund needs a second approval before it''s paid.'; end if;
  if method not in ('card', 'bank', 'mpaisa', 'credit') then raise exception 'Choose how it was paid.'; end if;
  if method <> 'credit' and length(trim(coalesce(reference, ''))) = 0 then raise exception 'Add the payment reference.'; end if;
  update refund_requests set status = 'paid', paid_at = now(), paid_method = method, paid_reference = nullif(left(trim(coalesce(reference, '')), 120), ''),
    paid_by = auth.uid(), updated_at = now() where id = refund returning * into f;
  if method = 'credit' then
    insert into account_credits (workspace_id, amount, currency, refund_id, note, created_by)
      values (f.workspace_id, f.amount_approved, f.currency, f.id, 'Refund ' || f.ref, auth.uid());
  end if;
  if f.requested_by is not null then
    perform queue_email(f.requested_by, null, 'refund_paid', 'Your refund has been paid (' || f.ref || ')',
      'Hi,' || E'\n\n' || 'We''ve ' || case when method = 'credit' then 'added ' || f.currency || ' ' || f.amount_approved || ' credit to your Riyeser account'
        else 'paid your refund of ' || f.currency || ' ' || f.amount_approved || case method when 'card' then ' back to your card' when 'bank' then ' by bank transfer'
        else ' by M-PAiSA' end end || ' (' || f.ref || ').' || case when method in ('card', 'bank') then ' It can take a few business days to show.' else '' end,
      f.workspace_id, f.ticket_id, f.id);
  end if;
  perform hq_log('refund.paid', jsonb_build_object('workspace_id', f.workspace_id, 'refund', f.ref, 'amount', f.amount_approved, 'currency', f.currency, 'method', method));
end $$;

-- ---------------------------------------------------------------- free periods (offers) with supervisor approval
create sequence if not exists public.offer_no start 1001;
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.offer_no'),
  ref text generated always as ('O-' || number::text) stored,
  workspace_id uuid not null references public.workspaces(id),
  modules text[] not null,
  kind text not null check (kind in ('trial', 'paid', 'account')),   -- extend a trial / free time on a paid program / all paid programs
  length_amount int not null check (length_amount between 1 and 1000),
  length_unit text not null check (length_unit in ('days', 'months')),
  days int not null check (days > 0),
  reason_category text not null check (reason_category in ('retention', 'goodwill', 'promotion', 'other')),
  reason text not null check (length(trim(reason)) between 1 and 500),
  ticket text,
  status text not null check (status in ('applied', 'waiting', 'approved', 'declined')),   -- approved = approved and applied
  requested_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decline_reason text check (length(decline_reason) <= 500),
  applied_at timestamptz,
  ends_at date,
  applied jsonb,          -- what changed: module -> {was, now}
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by is distinct from requested_by)
);
create index if not exists offers_ws on public.offers (workspace_id, created_at desc);
alter table public.offers enable row level security;
revoke all on public.offers from anon, authenticated;
revoke all on sequence public.offer_no from anon, authenticated;
drop trigger if exists no_delete on public.offers;
create trigger no_delete before delete on public.offers for each row execute function public.no_delete();

create or replace function public.module_label(m text) returns text language sql immutable as $$
  select case m when 'basic' then 'Accounting Basics' when 'plus' then 'Accounting Plus' when 'payroll' then 'Payroll' when 'pos' then 'POS'
    when 'bookings' then 'Bookings' when 'as_built' then 'As Built' when 'calls' then 'Riyeser Link Plus' else m end
$$;

-- Apply a free period now (uses the licence functions). Returns {module: {was, now}}.
create or replace function public.offer_apply(o offers) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare m text; st json; base date; newd date; res jsonb := '{}'; last_end date;
begin
  foreach m in array o.modules loop
    st := module_state(o.workspace_id, m);
    if o.kind = 'trial' then
      if st ->> 'status' not in ('trial', 'ended') or exists (select 1 from company_modules c where c.workspace_id = o.workspace_id and c.module = m and c.status <> 'trial') then
        raise exception '% isn''t on a free trial. Add free time to its paid period instead.', module_label(m); end if;
      base := greatest(coalesce((st ->> 'trial_ends')::date, current_date), current_date);
      newd := case when o.length_unit = 'months' then (base + make_interval(months => o.length_amount))::date else base + o.length_amount end;
      perform licence_set_module(o.workspace_id, m, 'trial', newd, null);
    else
      if st ->> 'status' <> 'active' then raise exception '% isn''t paid right now, so there''s no paid period to extend.', module_label(m); end if;
      base := greatest(coalesce((st ->> 'paid_until')::date, current_date), current_date);
      newd := case when o.length_unit = 'months' then (base + make_interval(months => o.length_amount))::date else base + o.length_amount end;
      perform licence_set_module(o.workspace_id, m, 'active', null, newd);
    end if;
    res := res || jsonb_build_object(m, jsonb_build_object('was', base, 'now', newd));
    last_end := greatest(last_end, newd);
  end loop;
  update offers set applied_at = now(), ends_at = last_end, applied = res where id = o.id;
  perform queue_email_owners(o.workspace_id, 'free_period',
    'Good news: ' || o.days || ' free days added',
    'Hi,' || E'\n\n' || 'Good news: we''ve added ' || o.days || ' free days to '
    || case when o.kind = 'account' then 'your paid programs' else (select string_agg(module_label(x), ', ') from unnest(o.modules) x) end
    || ' — now free until ' || to_char(last_end, 'FMDD Mon YYYY') || '.' || E'\n\n' || 'There''s nothing you need to do: your programs pick it up by themselves.');
  return res;
end $$;
revoke all on function public.offer_apply(offers) from public, anon, authenticated;

create or replace function public.hq_grant_offer(ws uuid, kind text, modules text[], length_amount int, length_unit text, reason_category text,
    reason text, ticket_ref text) returns json
  language plpgsql security definer set search_path = public as $$
declare o offers; mods text[]; d int; lim numeric := hq_setting_num('offers.self_limit_days', 31); tr text := upper(nullif(trim(coalesce(ticket_ref, '')), ''));
begin
  perform hq_need(array['offers.grant']);
  if not exists (select 1 from workspaces where id = ws and status = 'active') then raise exception 'Free periods are only for open businesses.'; end if;
  if kind not in ('trial', 'paid', 'account') then raise exception 'Choose what to give.'; end if;
  if length_unit not in ('days', 'months') or coalesce(length_amount, 0) < 1 then raise exception 'Choose how long.'; end if;
  if reason_category not in ('retention', 'goodwill', 'promotion', 'other') then raise exception 'Choose a reason.'; end if;
  if length(trim(coalesce(reason, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  if tr ~ '^[0-9]+$' then tr := 'T-' || tr; end if;
  if tr is not null and not exists (select 1 from support_tickets where ref = tr) then raise exception 'There''s no ticket %.', tr; end if;
  if kind = 'account' then
    select array_agg(m) into mods from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) m
      where (module_state(ws, m) ->> 'status') = 'active';
    if mods is null then raise exception 'This business has no paid programs. Extend a trial instead.'; end if;
  else
    select array_agg(distinct m) into mods from unnest(coalesce(modules, '{}')) m where m in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls');
    if mods is null then raise exception 'Choose a program.'; end if;
  end if;
  d := case when length_unit = 'months' then ((current_date + make_interval(months => length_amount))::date - current_date) else length_amount end;
  insert into offers (workspace_id, modules, kind, length_amount, length_unit, days, reason_category, reason, ticket, status, requested_by)
    values (ws, mods, kind, length_amount, length_unit, d, reason_category, left(trim(reason), 500), tr, case when d <= lim then 'applied' else 'waiting' end, auth.uid())
    returning * into o;
  if o.status = 'applied' then perform offer_apply(o); end if;
  perform hq_log(case when o.status = 'applied' then 'offer.applied' else 'offer.requested' end,
    jsonb_build_object('workspace_id', ws, 'offer', o.ref, 'ticket', tr, 'kind', kind, 'modules', to_jsonb(mods), 'days', d,
      'reason_category', reason_category, 'reason', left(trim(reason), 500)));
  return json_build_object('id', o.id, 'ref', o.ref, 'status', o.status, 'days', d, 'limit', lim);
end $$;

create or replace function public.hq_decide_offer(offer uuid, approve boolean, reason text) returns void
  language plpgsql security definer set search_path = public as $$
declare o offers;
begin
  perform hq_need(array['offers.approve']);
  select * into o from offers where id = offer for update;
  if o.id is null then raise exception 'That free period doesn''t exist.'; end if;
  if o.status <> 'waiting' then raise exception 'That free period isn''t waiting for approval.'; end if;
  if o.requested_by = auth.uid() then raise exception 'The same person can''t ask for and approve a free period. Ask another supervisor.'; end if;
  if not approve and length(trim(coalesce(reason, ''))) < 4 then raise exception 'Give a reason (a few words is fine).'; end if;
  update offers set status = case when approve then 'approved' else 'declined' end, approved_by = auth.uid(), decided_at = now(),
    decline_reason = case when approve then null else left(trim(hq_decide_offer.reason), 500) end where id = offer returning * into o;
  if approve then perform offer_apply(o); end if;
  perform hq_log(case when approve then 'offer.approved' else 'offer.declined' end,
    jsonb_build_object('workspace_id', o.workspace_id, 'offer', o.ref, 'days', o.days, 'reason', nullif(trim(coalesce(reason, '')), '')));
end $$;

create or replace function public.offer_row_json(o offers) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', o.id, 'ref', o.ref, 'workspace_id', o.workspace_id, 'business', (select name from workspaces where id = o.workspace_id),
    'modules', o.modules, 'kind', o.kind, 'length_amount', o.length_amount, 'length_unit', o.length_unit, 'days', o.days,
    'reason_category', o.reason_category, 'reason', o.reason, 'ticket', o.ticket, 'status', o.status, 'requested_by', o.requested_by,
    'requested_by_name', public.staff_name(o.requested_by), 'approved_by_name', public.staff_name(o.approved_by), 'decided_at', o.decided_at,
    'decline_reason', o.decline_reason, 'applied_at', o.applied_at, 'ends_at', o.ends_at, 'created_at', o.created_at)
$$;

-- One queue for everything that needs a second person: refunds over the threshold and free periods over the limit.
create or replace function public.hq_approvals() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['refunds.approve', 'offers.approve', 'refunds.view']);
  return json_build_object(
    'refunds', (select coalesce(json_agg(refund_row_json(f) order by f.created_at), '[]') from refund_requests f
                where f.status in ('approved', 'partly_approved') and f.needs_second and f.second_approver is null),
    'offers', (select coalesce(json_agg(offer_row_json(o) order by o.created_at), '[]') from offers o where o.status = 'waiting'),
    'month', (select json_build_object('count', count(*), 'days', coalesce(sum(days), 0),
        'by_reason', (select coalesce(json_object_agg(reason_category, d), '{}') from (select reason_category, sum(days) d from offers
                       where status in ('applied', 'approved') and coalesce(applied_at, created_at) >= date_trunc('month', now()) group by 1) x))
      from offers where status in ('applied', 'approved') and coalesce(applied_at, created_at) >= date_trunc('month', now())),
    'limit_days', hq_setting_num('offers.self_limit_days', 31), 'threshold', hq_setting_num('refunds.two_person_threshold', 200),
    'me', auth.uid());
end $$;

-- ---------------------------------------------------------------- the company panel, the businesses list and the history
create or replace function public.hq_company_extra(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  return json_build_object(
    'summary', business_summary(ws),
    'tickets', case when hq_can('support.view') then (select coalesce(json_agg(json_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject,
        'status', t.status, 'level', t.level, 'updated_at', t.updated_at) order by t.updated_at desc), '[]')
        from (select * from support_tickets where workspace_id = ws order by updated_at desc limit 30) t) end,
    'refunds', case when hq_can('refunds.view') then (select coalesce(json_agg(refund_row_json(f) order by f.created_at desc), '[]')
        from refund_requests f where f.workspace_id = ws) end,
    'offers', (select coalesce(json_agg(offer_row_json(o) order by o.created_at desc), '[]') from offers o where o.workspace_id = ws),
    'credit', credit_json(ws),
    'history', case when hq_can('audit.view') then (select coalesce(json_agg(json_build_object('at', a.at, 'who', coalesce(staff_name(a.actor), 'Riyeser'),
        'action', a.action, 'ticket', a.ticket, 'details', a.details) order by a.at desc), '[]')
        from (select * from hq_audit where workspace_id = ws order by at desc limit 100) a) end);
end $$;

create or replace function public.hq_business_list(search text, status_filter text) returns json
  language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(search, '')), '');
begin
  perform hq_need(array['customers.view']);
  return (select coalesce(json_agg(x order by x.created_at desc), '[]') from (
    select w.id, w.name, w.company_code, w.country, w.created_at, w.status, w.kind, w.last_active_at, w.duplicate_of, w.removal_state,
      (select count(*) from members m where m.workspace_id = w.id) as people,
      (select count(*) from devices d where d.workspace_id = w.id) as pcs,
      (select max(d.last_seen) from devices d where d.workspace_id = w.id) as last_seen,
      w.calls_paid_until, greatest(0, 90 - extract(day from now() - w.created_at)::int) as trial_days_left,
      (select m.display_name from members m where m.workspace_id = w.id and m.role = 'owner' limit 1) as owner_name,
      (select u.email::text from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' limit 1) as owner_email
    from workspaces w
    where (coalesce(status_filter, 'all') = 'all' or w.status = status_filter)
      and (q is null or w.name ilike '%' || q || '%' or w.company_code ilike '%' || q || '%' or w.legal_name ilike '%' || q || '%'
           or w.tax_number ilike '%' || q || '%'
           or exists (select 1 from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and u.email::text ilike '%' || q || '%'))
    order by w.created_at desc limit 500) x);
end $$;

-- HQ history with filters (who, action, business, dates). Exports are written to the history too.
create or replace function public.hq_audit_search(who uuid, action_like text, ws uuid, from_day date, to_day date, for_export boolean) returns json
  language plpgsql security definer set search_path = public as $$
declare r json;
begin
  perform hq_need(array['audit.view']);
  select coalesce(json_agg(json_build_object('id', a.id, 'at', a.at, 'actor', a.actor, 'who', coalesce(staff_name(a.actor), 'Riyeser'),
      'action', a.action, 'workspace_id', a.workspace_id, 'business', (select name from workspaces w where w.id = a.workspace_id),
      'ticket', a.ticket, 'details', a.details) order by a.at desc), '[]') into r
  from (select * from hq_audit a
        where (who is null or a.actor = who) and (coalesce(action_like, '') = '' or a.action like action_like || '%')
          and (ws is null or a.workspace_id = ws) and (from_day is null or a.at >= from_day) and (to_day is null or a.at < to_day + 1)
        order by a.at desc limit case when for_export then 20000 else 500 end) a;
  if for_export then perform hq_log('audit.exported', jsonb_build_object('who', who, 'action', action_like, 'workspace_id', ws, 'from', from_day, 'to', to_day)); end if;
  return r;
end $$;

-- Staff and their permissions (the HQ team tab)
create or replace function public.hq_team() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['overview.view']);
  return json_build_object('all', hq_all_perms(),
    'roles', (select json_object_agg(r, hq_role_perms(r)) from unnest(array['owner', 'finance', 'support', 'senior', 'sales', 'developer']) r),
    'staff', (select coalesce(json_agg(json_build_object('user_id', s.user_id, 'display_name', s.display_name, 'role', s.role, 'active', s.active,
        'email', u.email::text, 'added_at', s.added_at, 'perms_add', s.perms_add, 'perms_remove', s.perms_remove,
        'perms', coalesce(hq_staff_perms(s.user_id), '{}')) order by s.added_at), '[]') from hq_staff s join auth.users u on u.id = s.user_id));
end $$;
create or replace function public.hq_set_staff_perms(staff uuid, perms_on text[], perms_off text[]) returns void
  language plpgsql security definer set search_path = public as $$
declare bad text;
begin
  perform hq_need(array['staff.manage']);
  if hq_role() <> 'owner' then raise exception 'Only an HQ owner can tick permissions on or off.'; end if;
  if staff = auth.uid() then raise exception 'You can''t change your own HQ access. Ask another owner.'; end if;
  select p into bad from unnest(coalesce(perms_on, '{}') || coalesce(perms_off, '{}')) p where not p = any(hq_all_perms()) limit 1;
  if bad is not null then raise exception 'Unknown permission: %', bad; end if;
  update hq_staff set perms_add = coalesce(perms_on, '{}'), perms_remove = coalesce(perms_off, '{}') where user_id = staff;
  if not found then raise exception 'That person isn''t on the HQ team.'; end if;
  perform hq_log('staff.permissions', jsonb_build_object('user_id', staff, 'on', to_jsonb(coalesce(perms_on, '{}')), 'off', to_jsonb(coalesce(perms_off, '{}'))));
end $$;

-- ---------------------------------------------------------------- who can call what
revoke all on function public.touch_activity(), public.activity_on_sign_in(), public.has_two_step(uuid), public.my_closed_businesses(),
  public.is_paying(uuid), public.hq_setting_num(text, numeric), public.hq_settings_json(), public.hq_get_settings(), public.hq_set_setting(text, numeric),
  public.email_esc(text), public.email_html(text, text), public.queue_email(uuid, text, text, text, text, uuid, uuid, uuid),
  public.queue_email_owners(uuid, text, text, text), public.hq_emails(), public.hq_email_resend(bigint),
  public.can_see_ticket(uuid), public.level_name(int), public.open_ticket(uuid, text, text, text), public.reply_ticket(uuid, text),
  public.my_tickets(), public.my_ticket(uuid), public.level_perm(int), public.hq_can_work(int), public.staff_can_work(uuid, int), public.staff_name(uuid),
  public.hq_tickets(text, text), public.business_summary(uuid), public.hq_ticket(uuid), public.hq_ticket_reply(uuid, text, boolean, text),
  public.hq_ticket_status(uuid, text), public.hq_ticket_priority(uuid, text), public.hq_ticket_assign(uuid, uuid),
  public.ticket_move_level(support_tickets, int, text, uuid, uuid), public.hq_ticket_escalate(uuid, int, text, uuid),
  public.hq_saved_replies(), public.hq_save_reply(bigint, text, text), public.hq_retire_reply(bigint), public.hq_support_sweep(),
  public.hq_fix_start(text, text, text), public.hq_edit_business(uuid, jsonb, text, text), public.hq_reset_2fa(uuid, uuid, text, text, text),
  public.hq_change_owner(uuid, uuid, text, text), public.hq_set_business_status(uuid, text, text, text), public.hq_close_duplicate(uuid, uuid, text, text),
  public.inactivity_email(workspaces, int, int), public.hq_inactivity_sweep(), public.hq_inactive_accounts(), public.hq_remove_accounts(uuid[], text),
  public.credit_json(uuid), public.refund_reason_name(text), public.request_refund(uuid, text, text, text, numeric, text, text, text, uuid),
  public.my_refunds(uuid), public.hq_refund_create(uuid, text, text, text, numeric, text, text, text), public.refund_row_json(refund_requests),
  public.hq_refunds(text), public.refund_decided_email(refund_requests), public.hq_refund_review(uuid), public.hq_refund_decide(uuid, text, numeric, text),
  public.hq_refund_second(uuid, text), public.hq_refund_paid(uuid, text, text), public.module_label(text),
  public.hq_grant_offer(uuid, text, text[], int, text, text, text, text), public.hq_decide_offer(uuid, boolean, text), public.offer_row_json(offers),
  public.hq_approvals(), public.hq_company_extra(uuid), public.hq_business_list(text, text),
  public.hq_audit_search(uuid, text, uuid, date, date, boolean), public.hq_team(), public.hq_set_staff_perms(uuid, text[], text[]),
  public.hq_all_perms(), public.hq_role_perms(text), public.hq_staff_perms(uuid), public.hq_perms(), public.hq_can(text), public.is_paying(uuid)
  from public, anon, authenticated;
-- customers
grant execute on function public.touch_activity(), public.my_closed_businesses(), public.open_ticket(uuid, text, text, text),
  public.reply_ticket(uuid, text), public.my_tickets(), public.my_ticket(uuid), public.can_see_ticket(uuid),
  public.request_refund(uuid, text, text, text, numeric, text, text, text, uuid), public.my_refunds(uuid) to authenticated;
-- HQ staff (each function checks its own permission)
grant execute on function public.hq_get_settings(), public.hq_set_setting(text, numeric), public.hq_emails(), public.hq_email_resend(bigint),
  public.hq_tickets(text, text), public.hq_ticket(uuid), public.hq_ticket_reply(uuid, text, boolean, text), public.hq_ticket_status(uuid, text),
  public.hq_ticket_priority(uuid, text), public.hq_ticket_assign(uuid, uuid), public.hq_ticket_escalate(uuid, int, text, uuid),
  public.hq_saved_replies(), public.hq_save_reply(bigint, text, text), public.hq_retire_reply(bigint),
  public.hq_edit_business(uuid, jsonb, text, text), public.hq_reset_2fa(uuid, uuid, text, text, text), public.hq_change_owner(uuid, uuid, text, text),
  public.hq_set_business_status(uuid, text, text, text), public.hq_close_duplicate(uuid, uuid, text, text), public.hq_inactive_accounts(),
  public.hq_remove_accounts(uuid[], text), public.hq_refund_create(uuid, text, text, text, numeric, text, text, text), public.hq_refunds(text),
  public.hq_refund_review(uuid), public.hq_refund_decide(uuid, text, numeric, text), public.hq_refund_second(uuid, text),
  public.hq_refund_paid(uuid, text, text), public.hq_grant_offer(uuid, text, text[], int, text, text, text, text), public.hq_decide_offer(uuid, boolean, text),
  public.hq_approvals(), public.hq_business_list(text, text), public.hq_audit_search(uuid, text, uuid, date, date, boolean),
  public.hq_team(), public.hq_set_staff_perms(uuid, text[], text[]) to authenticated;
-- the jobs (hq-jobs.yml connects as the database owner); Supabase's service role may run them too
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.hq_inactivity_sweep(), public.hq_support_sweep() to service_role;
  end if;
end $$;

-- ===== Riyeser Link Office: status and phones =====
-- Riyeser Link Office (the office phone system on one PC) reports how it's going every 5 minutes, and when a phone
-- connects or is given to someone: the PC's name and version, the address to type into phones, the licence, counts,
-- the desk phones and the extensions. Owners and admins see it on the Phones page of Riyeser Link, and can send it
-- changes (give a phone to someone, add one by MAC address, Do not disturb, a new password). It checks for them
-- every 30 seconds and says whether each worked. Riyeser support sees the same summary in HQ, and can make the same
-- changes only for the hour after the customer presses "Let Riyeser help".
-- PRIVACY: no calls, numbers dialled, recordings or audio ever come here: only how many calls are in progress.
-- SIP PASSWORDS NEVER LIVE HERE. They're made and kept on the office PC. "Show" on the website makes a one-off key in
-- the browser and asks the office PC for that extension's password; the PC encrypts it to that key, so this database
-- only ever holds a scrambled copy that only that browser tab can read. It can be taken once, by the person who
-- asked, within 5 minutes, and is blanked straight after (or when the 5 minutes are up). Every Show is in the history.
-- Safe to re-run: it only adds what's missing.
create table if not exists public.link_offices (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  office_id text not null check (office_id ~ '^[A-Za-z0-9-]{8,64}$'),     -- made once by each Riyeser Link Office install
  pc_name text check (length(pc_name) <= 80),
  version text check (length(version) <= 40),
  state text check (length(state) <= 40),                                  -- running, waiting-licence, stopping, error
  addresses text[] not null default '{}',                                  -- this PC's office address(es); the first is the one phones use
  sip_port int check (sip_port between 1 and 65535),
  address_stable boolean not null default true,                            -- false after 3 address changes in 30 days
  pc_mac text check (length(pc_mac) <= 20),                                -- for a DHCP reservation in the router
  licence jsonb, counts jsonb, extensions jsonb not null default '[]',
  reported_by uuid references auth.users(id) on delete set null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (workspace_id, office_id)
);
create table if not exists public.link_office_phones (
  workspace_id uuid not null,
  office_id text not null,
  mac text not null check (mac ~ '^[0-9a-f]{12}$'),
  vendor text check (length(vendor) <= 40),
  model text check (length(model) <= 60),
  extension text check (extension ~ '^[0-9]{2,4}$'),
  assigned boolean not null default false,                                 -- false: a new phone found, not given to anyone yet
  registered boolean not null default false,                               -- connected to Riyeser Link Office now
  last_registered timestamptz,
  ip text check (length(ip) <= 45),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, office_id, mac),
  foreign key (workspace_id, office_id) references public.link_offices (workspace_id, office_id) on delete cascade
);
create table if not exists public.link_office_commands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  office_id text not null,
  kind text not null check (kind in ('assign_phone', 'unassign_phone', 'add_phone', 'new_password', 'set_dnd', 'reveal_password')),
  data jsonb not null default '{}' check (length(data::text) < 4000),     -- never a password (a Show holds only the browser's public key)
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  by_riyeser boolean not null default false,                               -- Riyeser support, while the customer allowed it
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  done_at timestamptz,
  error text check (length(error) <= 300)
);
create index if not exists link_office_commands_pending on public.link_office_commands (workspace_id, office_id, status, created_at);
create table if not exists public.link_office_reveals (
  command_id uuid primary key references public.link_office_commands(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  extension text not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  sealed text check (length(sealed) <= 2000),     -- encrypted to the asking browser's one-off key; blanked once read or after 5 minutes
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  read_at timestamptz,
  check (expires_at <= created_at + interval '5 minutes')
);
create table if not exists public.link_support_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_by uuid references auth.users(id) on delete set null,
  check (expires_at <= granted_at + interval '61 minutes')
);
create index if not exists link_support_access_ws on public.link_support_access (workspace_id, expires_at desc);
-- Desk phones list (1.1.1): each phone's name ("Reception"), location (a branch), a note (e.g. its S/N) and when it
-- last fetched its settings (for "Configuring"). Kept on the office PC; this is the copy from the heartbeat.
alter table public.link_office_phones add column if not exists name text check (length(name) <= 40);
alter table public.link_office_phones add column if not exists location text check (length(location) <= 60);
alter table public.link_office_phones add column if not exists note text check (length(note) <= 60);
alter table public.link_office_phones add column if not exists provisioned_at timestamptz;
alter table public.link_office_commands drop constraint if exists link_office_commands_kind_check;
alter table public.link_office_commands add constraint link_office_commands_kind_check
  check (kind in ('assign_phone', 'unassign_phone', 'add_phone', 'new_password', 'set_dnd', 'reveal_password', 'name_phone'));

alter table public.link_offices enable row level security;
alter table public.link_office_phones enable row level security;
alter table public.link_office_commands enable row level security;
alter table public.link_office_reveals enable row level security;
alter table public.link_support_access enable row level security;
revoke all on public.link_offices, public.link_office_phones, public.link_office_commands, public.link_office_reveals,
  public.link_support_access from anon, authenticated;
drop policy if exists lo_read on public.link_offices;
create policy lo_read on public.link_offices for select to authenticated using (public.is_member(workspace_id));
drop policy if exists lop_read on public.link_office_phones;
create policy lop_read on public.link_office_phones for select to authenticated using (public.is_member(workspace_id));
drop policy if exists loc_read on public.link_office_commands;
create policy loc_read on public.link_office_commands for select to authenticated using (public.is_admin(workspace_id));
drop policy if exists lor_read on public.link_office_reveals;
create policy lor_read on public.link_office_reveals for select to authenticated using (requested_by = auth.uid() and expires_at > now());
drop policy if exists lsa_read on public.link_support_access;
create policy lsa_read on public.link_support_access for select to authenticated using (public.is_admin(workspace_id));
grant select on public.link_offices, public.link_office_phones, public.link_office_commands, public.link_support_access to authenticated;
-- the scrambled password itself is never readable directly: only once, through link_reveal_take()
grant select (command_id, workspace_id, extension, requested_by, created_at, expires_at, read_at) on public.link_office_reveals to authenticated;

-- ---------------------------------------------------------------- helpers (not callable from outside)
create or replace function public.link_int(j jsonb) returns int language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then least(greatest(round((j #>> '{}')::numeric), 0), 1000000)::int end
$$;
create or replace function public.link_bool(j jsonb) returns boolean language sql immutable as $$
  select case when jsonb_typeof(j) = 'boolean' then (j #>> '{}')::boolean end
$$;
create or replace function public.link_text(j jsonb, n int) returns text language sql immutable as $$
  select nullif(left(regexp_replace(case when jsonb_typeof(j) in ('string', 'number') then j #>> '{}' end, '[[:cntrl:]<>]', '', 'g'), n), '')
$$;
create or replace function public.link_time(j jsonb) returns timestamptz language plpgsql immutable as $$
begin
  if jsonb_typeof(j) <> 'string' or (j #>> '{}') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d' then return null; end if;
  return (j #>> '{}')::timestamptz;
exception when others then return null;
end $$;
create or replace function public.link_mac(t text) returns text language sql immutable as $$
  select case when lower(regexp_replace(coalesce(t, ''), '[\s:.-]', '', 'g')) ~ '^[0-9a-f]{12}$' then lower(regexp_replace(t, '[\s:.-]', '', 'g')) end
$$;
-- Who may report for a business from its Link Office: someone in it who is an owner or admin, or whose PC is linked.
create or replace function public.link_office_caller_ok(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m join workspaces w on w.id = m.workspace_id and w.status = 'active'
    where m.workspace_id = ws and m.user_id = auth.uid()
      and (m.role in ('owner', 'admin') or exists (select 1 from devices d where d.workspace_id = ws and d.user_id = auth.uid())))
$$;
create or replace function public.link_support_active(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from link_support_access where workspace_id = ws and ended_at is null and expires_at > now())
$$;
-- Blank any password copy that was read or is past its 5 minutes, and give up on changes nobody picked up.
create or replace function public.link_sweep() returns void
  language sql security definer set search_path = public as $$
  update link_office_reveals set sealed = null where sealed is not null and (read_at is not null or expires_at <= now());
  delete from link_office_reveals where sealed is null and created_at < now() - interval '1 day';
  update link_office_commands set status = 'failed', done_at = now(),
      error = 'Riyeser Link Office didn''t answer within 5 minutes. Is the office PC on? Press Show again to try again.'
    where status = 'pending' and kind = 'reveal_password' and created_at < now() - interval '5 minutes';
  update link_office_commands set status = 'failed', done_at = now(),
      error = 'Riyeser Link Office didn''t pick this up within a day. Is the office PC on and connected to the internet?'
    where status = 'pending' and created_at < now() - interval '1 day';
$$;
create or replace function public.link_office_json(o link_offices) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('office_id', o.office_id, 'pc_name', o.pc_name, 'version', o.version, 'state', o.state, 'addresses', o.addresses,
    'sip_port', o.sip_port, 'address_stable', o.address_stable, 'pc_mac', o.pc_mac, 'licence', o.licence, 'counts', o.counts,
    'extensions', o.extensions, 'first_seen', o.first_seen, 'last_seen', o.last_seen,
    'phones', (select coalesce(json_agg(json_build_object('mac', p.mac, 'vendor', p.vendor, 'model', p.model, 'extension', p.extension,
        'assigned', p.assigned, 'registered', p.registered, 'last_registered', p.last_registered, 'ip', p.ip,
        'name', p.name, 'location', p.location, 'note', p.note, 'provisioned_at', p.provisioned_at) order by p.assigned desc, p.extension, p.mac), '[]')
      from link_office_phones p where p.workspace_id = o.workspace_id and p.office_id = o.office_id))
$$;

-- ---------------------------------------------------------------- Riyeser Link Office calls these
-- The heartbeat. Only the listed parts of the payload are kept, each checked and cut to size. Returns how many
-- changes are waiting, so the office can fetch them straight away.
create or replace function public.link_office_report(ws uuid, office_id text, payload jsonb) returns json
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb := coalesce(payload, '{}'::jsonb); the_office text := link_office_report.office_id;
begin
  if not link_office_caller_ok(ws) then
    raise exception 'Sign in to Riyeser Link Office as the business''s owner or an admin, or link this PC to the business in Riyeser Central.';
  end if;
  if the_office is null or the_office !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'That isn''t a Riyeser Link Office id.'; end if;
  if length(p::text) > 300000 then raise exception 'That report is too big.'; end if;
  perform link_sweep();
  insert into link_offices (workspace_id, office_id, pc_name, version, state, addresses, sip_port, address_stable, pc_mac, licence, counts, extensions, reported_by, last_seen)
  values (ws, the_office, link_text(p -> 'pc_name', 80), link_text(p -> 'version', 40), link_text(p -> 'state', 40),
    array(select a from jsonb_array_elements_text(case when jsonb_typeof(p -> 'addresses') = 'array' then p -> 'addresses' else '[]' end) with ordinality x(a, i)
          where a ~ '^\d{1,3}(\.\d{1,3}){3}$' order by i limit 8),
    case when link_int(p -> 'sip_port') between 1 and 65535 then link_int(p -> 'sip_port') end,
    coalesce(link_bool(p -> 'address_stable'), true),
    case when link_text(p -> 'pc_mac', 20) ~ '^[0-9A-Fa-f:-]{12,17}$' then link_text(p -> 'pc_mac', 20) end,
    jsonb_build_object('active', coalesce(link_bool(p -> 'licence' -> 'active'), false), 'state', link_text(p -> 'licence' -> 'state', 20),
      'text', link_text(p -> 'licence' -> 'text', 200)),
    jsonb_build_object('people', link_int(p -> 'counts' -> 'people'), 'groups', link_int(p -> 'counts' -> 'groups'),
      'phones_assigned', link_int(p -> 'counts' -> 'phones_assigned'), 'phones_connected', link_int(p -> 'counts' -> 'phones_connected'),
      'new_phones', link_int(p -> 'counts' -> 'new_phones'), 'app_users', link_int(p -> 'counts' -> 'app_users'),
      'calls_in_progress', link_int(p -> 'counts' -> 'calls_in_progress'), 'calls_made', link_int(p -> 'counts' -> 'calls_made')),   -- calls_made: answered calls kept on the PC (a count only)
    coalesce((select jsonb_agg(jsonb_build_object('extension', e ->> 'extension', 'name', link_text(e -> 'name', 60),
        'type', case when e ->> 'type' = 'group' then 'group' else 'person' end,
        'registered', coalesce(link_int(e -> 'registered'), 0), 'desk_phones', coalesce(link_int(e -> 'desk_phones'), 0),
        'app_users', coalesce(link_int(e -> 'app_users'), 0), 'dnd', coalesce(link_bool(e -> 'dnd'), false),
        'members', link_int(e -> 'members')) order by e ->> 'extension')
      from (select e from jsonb_array_elements(case when jsonb_typeof(p -> 'extensions') = 'array' then p -> 'extensions' else '[]' end) e
            where jsonb_typeof(e) = 'object' and e ->> 'extension' ~ '^[0-9]{2,4}$' limit 1000) x), '[]'::jsonb),
    auth.uid(), now())
  on conflict (workspace_id, office_id) do update set pc_name = excluded.pc_name, version = excluded.version, state = excluded.state,
    addresses = excluded.addresses, sip_port = excluded.sip_port, address_stable = excluded.address_stable, pc_mac = excluded.pc_mac,
    licence = excluded.licence, counts = excluded.counts, extensions = excluded.extensions, reported_by = excluded.reported_by, last_seen = now();
  -- the phones list is a copy of what the office has now (the office keeps the real list)
  delete from link_office_phones where workspace_id = ws and office_id = the_office;
  insert into link_office_phones (workspace_id, office_id, mac, vendor, model, extension, assigned, registered, last_registered, ip, name, location, note, provisioned_at)
  select distinct on (link_mac(ph ->> 'mac')) ws, the_office, link_mac(ph ->> 'mac'), link_text(ph -> 'vendor', 40), link_text(ph -> 'model', 60),
    case when ph ->> 'extension' ~ '^[0-9]{2,4}$' then ph ->> 'extension' end,
    coalesce(link_bool(ph -> 'assigned'), false), coalesce(link_bool(ph -> 'registered'), false), link_time(ph -> 'last_registered'),
    case when link_text(ph -> 'ip', 45) ~ '^[0-9a-fA-F.:]{3,45}$' then link_text(ph -> 'ip', 45) end,
    link_text(ph -> 'name', 40), link_text(ph -> 'location', 60), link_text(ph -> 'note', 60), link_time(ph -> 'provisioned_at')
  from (select ph from jsonb_array_elements(case when jsonb_typeof(p -> 'phones') = 'array' then p -> 'phones' else '[]' end) ph
        where jsonb_typeof(ph) = 'object' limit 500) x
  where link_mac(ph ->> 'mac') is not null
  order by link_mac(ph ->> 'mac'), coalesce(link_bool(ph -> 'assigned'), false) desc;
  return json_build_object('ok', true, 'pending', (select count(*) from link_office_commands c where c.workspace_id = ws and c.office_id = the_office and c.status = 'pending'));
end $$;

-- Changes waiting for this office (it asks every 30 seconds; asking also counts as "still running").
create or replace function public.link_office_pending(ws uuid, office_id text) returns json
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare the_office text := link_office_pending.office_id;
begin
  if not link_office_caller_ok(ws) then raise exception 'Sign in to Riyeser Link Office as the business''s owner or an admin, or link this PC in Riyeser Central.'; end if;
  perform link_sweep();
  update link_offices set last_seen = now() where workspace_id = ws and office_id = the_office and last_seen < now() - interval '20 seconds';
  return (select coalesce(json_agg(json_build_object('id', c.id, 'kind', c.kind, 'data', c.data, 'created_at', c.created_at) order by c.created_at), '[]')
    from (select * from link_office_commands c where c.workspace_id = ws and c.office_id = the_office and c.status = 'pending' order by c.created_at limit 50) c);
end $$;

-- The office says how a change went. For a Show, "sealed" is the password encrypted to the asking browser's key.
create or replace function public.link_office_done(command uuid, ok boolean, error text, sealed text) returns void
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare c link_office_commands; why text := left(nullif(trim(coalesce(error, '')), ''), 300);
begin
  select * into c from link_office_commands where id = command for update;
  if c.id is null or not link_office_caller_ok(c.workspace_id) then raise exception 'That change isn''t for this business.'; end if;
  if c.status <> 'pending' then return; end if;
  if ok and c.kind = 'reveal_password' then
    if sealed is null or length(sealed) > 2000 or sealed !~ '^[A-Za-z0-9+/=_-]+$' then ok := false; why := 'Riyeser Link Office didn''t send the password back.';
    elsif c.created_at < now() - interval '5 minutes' then ok := false; why := 'That took too long. Press Show again.';
    else
      insert into link_office_reveals (command_id, workspace_id, extension, requested_by, sealed, created_at, expires_at)
      values (c.id, c.workspace_id, c.data ->> 'extension', c.created_by, sealed, now(), c.created_at + interval '5 minutes')   -- 5 minutes from pressing Show
      on conflict (command_id) do nothing;
    end if;
  end if;
  update link_office_commands set status = case when ok then 'done' else 'failed' end, done_at = now(),
    error = case when ok then null else coalesce(why, 'Riyeser Link Office couldn''t do that.') end
  where id = c.id;
end $$;

-- ---------------------------------------------------------------- the website and HQ call these
-- A change for the office to make. Owners and admins with two-step sign-in; or Riyeser support (link.support) while
-- the customer has pressed "Let Riyeser help". Every change goes in the business's history (and HQ's, for Riyeser).
create or replace function public.link_command(ws uuid, office_id text, kind text, data jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare d jsonb := coalesce(data, '{}'::jsonb); clean jsonb; mac text; ext text; by_hq boolean := false; cid uuid; k jsonb;
  the_office text := link_command.office_id;
begin
  if public.is_admin(ws) then by_hq := false;
  elsif hq_role() is not null then
    if not hq_can('link.support') then raise exception 'Your HQ role can''t do that.'; end if;
    if not link_support_active(ws) then raise exception 'Ask the customer to press ''Let Riyeser help'' on their Phones page first.'; end if;
    by_hq := true;
  else raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can change the phones.';
  end if;
  perform link_sweep();
  if not exists (select 1 from link_offices o where o.workspace_id = ws and o.office_id = the_office) then
    raise exception 'That Riyeser Link Office hasn''t been in touch yet.';
  end if;
  mac := link_mac(d ->> 'mac');
  ext := case when d ->> 'extension' ~ '^[0-9]{2,4}$' then d ->> 'extension' end;
  if kind in ('assign_phone', 'unassign_phone', 'add_phone', 'name_phone') and mac is null then
    raise exception 'That isn''t a MAC address. It''s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).';
  end if;
  if kind in ('assign_phone', 'add_phone', 'new_password', 'set_dnd', 'reveal_password') and ext is null then raise exception 'Choose an extension.'; end if;
  if kind = 'assign_phone' or kind = 'add_phone' then
    clean := jsonb_build_object('mac', mac, 'extension', ext);
    if kind = 'add_phone' and coalesce(d ->> 'vendor', '') <> '' then
      if d ->> 'vendor' not in ('yealink', 'grandstream', 'snom', 'polycom') then raise exception 'Choose the phone''s maker from the list.'; end if;
      clean := clean || jsonb_build_object('vendor', d ->> 'vendor');
    end if;
  elsif kind = 'unassign_phone' then clean := jsonb_build_object('mac', mac);
  elsif kind = 'name_phone' then
    -- a desk phone's name ("Reception"), location (one of the business's branches) and a note (e.g. its S/N)
    if coalesce(d ->> 'name', '') ~ '[[:cntrl:]<>]' or length(coalesce(d ->> 'name', '')) > 40 then raise exception 'Give the phone a short name (up to 40 letters), like Reception.'; end if;
    if coalesce(d ->> 'note', '') ~ '[[:cntrl:]<>]' or length(coalesce(d ->> 'note', '')) > 60 then raise exception 'Keep the note short (up to 60 letters).'; end if;
    if nullif(trim(coalesce(d ->> 'branch', '')), '') is not null
       and not exists (select 1 from branches b where b.workspace_id = ws and b.name = trim(d ->> 'branch')) then
      raise exception 'Choose the location from your branches.';
    end if;
    clean := jsonb_build_object('mac', mac, 'name', coalesce(nullif(trim(coalesce(d ->> 'name', '')), ''), ''),
      'branch', coalesce(nullif(trim(coalesce(d ->> 'branch', '')), ''), ''), 'note', coalesce(nullif(trim(coalesce(d ->> 'note', '')), ''), ''));
  elsif kind = 'new_password' then clean := jsonb_build_object('extension', ext);
  elsif kind = 'set_dnd' then
    if link_bool(d -> 'on') is null then raise exception 'Say whether Do not disturb is on or off.'; end if;
    clean := jsonb_build_object('extension', ext, 'on', link_bool(d -> 'on'));
  elsif kind = 'reveal_password' then
    k := d -> 'key';   -- the browser's one-off public key (RSA-OAEP, SHA-256): the password comes back encrypted to it
    if jsonb_typeof(k) <> 'object' or k ->> 'kty' <> 'RSA' or coalesce(k ->> 'n', '') !~ '^[A-Za-z0-9_-]+$' or length(k ->> 'n') not between 340 and 700 or coalesce(k ->> 'e', '') !~ '^[A-Za-z0-9_-]{1,8}$' then
      raise exception 'This browser can''t show passwords safely. Try another browser, such as Chrome, Edge or Safari.';
    end if;
    clean := jsonb_build_object('extension', ext, 'key', jsonb_build_object('kty', 'RSA', 'alg', 'RSA-OAEP-256', 'n', k ->> 'n', 'e', k ->> 'e'));
  else raise exception 'Riyeser Link Office doesn''t know how to do that.';
  end if;
  if (select count(*) from link_office_commands c where c.workspace_id = ws and c.status = 'pending') >= 50 then
    raise exception 'There are already 50 changes waiting for Riyeser Link Office. Is the office PC on?';
  end if;
  insert into link_office_commands (workspace_id, office_id, kind, data, by_riyeser) values (ws, the_office, kind, clean, by_hq) returning id into cid;
  insert into audit_log (workspace_id, action, details, actor)
  values (ws, 'link.' || kind, jsonb_strip_nulls(jsonb_build_object('extension', ext, 'mac', mac, 'on', clean -> 'on', 'name', nullif(clean ->> 'name', ''), 'office_id', the_office,
            'by', case when by_hq then 'Riyeser support' end)), case when by_hq then null else auth.uid() end);
  if by_hq then perform hq_log('link.' || kind, jsonb_strip_nulls(jsonb_build_object('workspace_id', ws, 'office_id', the_office, 'extension', ext, 'mac', mac))); end if;
  return cid;
end $$;

-- How a change is going: pending, done or failed (with a plain reason), and for a Show, whether it's ready to take.
create or replace function public.link_command_state(command uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare c link_office_commands;
begin
  perform link_sweep();
  select * into c from link_office_commands where id = command;
  if c.id is null or not (public.is_admin(c.workspace_id) or (c.by_riyeser and c.created_by = auth.uid() and hq_can('link.support'))) then
    raise exception 'That change isn''t one of yours.';
  end if;
  return json_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'error', c.error, 'created_at', c.created_at, 'done_at', c.done_at,
    'ready', exists (select 1 from link_office_reveals r where r.command_id = c.id and r.requested_by = auth.uid() and r.sealed is not null
                     and r.read_at is null and r.expires_at > now()));
end $$;

-- Take the (encrypted) password once. Only the person who asked, within 5 minutes; it's blanked straight away.
create or replace function public.link_reveal_take(command uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare r link_office_reveals; s text;
begin
  perform link_sweep();
  select * into r from link_office_reveals where command_id = command for update;
  if r.command_id is null or r.requested_by <> auth.uid() then raise exception 'There''s no password waiting for you.'; end if;
  if not (public.is_admin(r.workspace_id) or (hq_can('link.support') and link_support_active(r.workspace_id))) then
    raise exception 'You can''t see this business''s phone passwords any more.';
  end if;
  if r.sealed is null or r.read_at is not null or r.expires_at <= now() then return null; end if;
  s := r.sealed;
  update link_office_reveals set sealed = null, read_at = now() where command_id = r.command_id;
  return s;
end $$;

-- What the Phones page shows: every Link Office of the business, its phones and extensions (never a password).
create or replace function public.link_status(ws uuid) returns json
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(ws) then raise exception 'You''re not in that company'; end if;
  return json_build_object('now', now(), 'calls', public.calls_allowed(ws),
    'offices', (select coalesce(json_agg(link_office_json(o) order by o.last_seen desc), '[]') from link_offices o where o.workspace_id = ws),
    'support', (select json_build_object('until', a.expires_at, 'since', a.granted_at) from link_support_access a
                where a.workspace_id = ws and a.ended_at is null and a.expires_at > now() order by a.expires_at desc limit 1));
end $$;

-- "Let Riyeser help": Riyeser support can make the same phone changes for 1 hour (or until the customer ends it).
create or replace function public.link_support_allow(ws uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare until timestamptz := now() + interval '1 hour';
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can let Riyeser help.'; end if;
  update link_support_access set ended_at = now(), ended_by = auth.uid() where workspace_id = ws and ended_at is null and expires_at > now();
  insert into link_support_access (workspace_id, granted_by, expires_at) values (ws, auth.uid(), until);
  insert into audit_log (workspace_id, action, details) values (ws, 'link.support_allowed', jsonb_build_object('until', until));
  perform hq_log('link.support_allowed', jsonb_build_object('workspace_id', ws, 'until', until, 'by', 'customer'));
  return json_build_object('until', until);
end $$;
create or replace function public.link_support_end(ws uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can do that.'; end if;
  update link_support_access set ended_at = now(), ended_by = auth.uid() where workspace_id = ws and ended_at is null and expires_at > now();
  if found then
    insert into audit_log (workspace_id, action, details) values (ws, 'link.support_ended', '{}'::jsonb);
    perform hq_log('link.support_ended', jsonb_build_object('workspace_id', ws, 'by', 'customer'));
  end if;
end $$;

-- HQ: the business's Link Office, phones and extension counts (customers.view). No passwords: there are none here.
create or replace function public.hq_company_link(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['customers.view']);
  return json_build_object('now', now(), 'calls', public.calls_allowed(ws), 'can_help', hq_can('link.support'),
    'offices', (select coalesce(json_agg(link_office_json(o) order by o.last_seen desc), '[]') from link_offices o where o.workspace_id = ws),
    'support', (select json_build_object('until', a.expires_at, 'since', a.granted_at) from link_support_access a
                where a.workspace_id = ws and a.ended_at is null and a.expires_at > now() order by a.expires_at desc limit 1));
end $$;

revoke all on function public.link_int(jsonb), public.link_bool(jsonb), public.link_text(jsonb, int), public.link_time(jsonb), public.link_mac(text),
  public.link_office_caller_ok(uuid), public.link_support_active(uuid), public.link_sweep(), public.link_office_json(link_offices),
  public.link_office_report(uuid, text, jsonb), public.link_office_pending(uuid, text), public.link_office_done(uuid, boolean, text, text),
  public.link_command(uuid, text, text, jsonb), public.link_command_state(uuid), public.link_reveal_take(uuid), public.link_status(uuid),
  public.link_support_allow(uuid), public.link_support_end(uuid), public.hq_company_link(uuid) from public, anon, authenticated;
grant execute on function public.link_office_report(uuid, text, jsonb), public.link_office_pending(uuid, text), public.link_office_done(uuid, boolean, text, text),
  public.link_command(uuid, text, text, jsonb), public.link_command_state(uuid), public.link_reveal_take(uuid), public.link_status(uuid),
  public.link_support_allow(uuid), public.link_support_end(uuid), public.hq_company_link(uuid) to authenticated;
-- ===== Riyeser Link: My phone =====
-- Everyone in a business gets "☎ My phone" in Riyeser Link: their extension, their own desk phone(s) from the latest
-- Riyeser Link Office heartbeat, the details to type into a phone, and Do not disturb for themselves.
-- They can see their OWN extension's SIP password, the same safe way admins can: a one-off key in the browser tab,
-- the office PC encrypts the password to it, and the scrambled copy is taken once, within 5 minutes, by the person who
-- asked (and only while that is still their extension). Members don't need two-step sign-in for their own extension;
-- admins still need it for anyone else's (link_command). Every Show is in the history as link.reveal_own.
-- Nothing here lets a member see or change another extension. No passwords are kept here.
-- Safe to re-run.

-- My extension in this business, as text (null when I don't have one). Internal.
create or replace function public.link_my_ext(ws uuid) returns text
  language sql stable security definer set search_path = public as $$
  select m.extension::text from members m join workspaces w on w.id = m.workspace_id and w.status = 'active'
  where m.workspace_id = ws and m.user_id = auth.uid() and m.extension is not null
$$;

-- What "My phone" shows: my extension, my desk phones from the newest heartbeat, the office's server address and port,
-- whether Riyeser Link Office is online, the licence, and the first ring group (to test a call). Never a password.
create or replace function public.link_my_phone(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare o link_offices; ext text; grp json;
begin
  if not public.is_member(ws) then raise exception 'You''re not in that company'; end if;
  ext := link_my_ext(ws);
  select * into o from link_offices where workspace_id = ws order by last_seen desc limit 1;
  select json_build_object('extension', e ->> 'extension', 'name', e ->> 'name') into grp
    from jsonb_array_elements(coalesce(o.extensions, '[]'::jsonb)) e where e ->> 'type' = 'group' order by (e ->> 'extension')::int limit 1;
  if grp is null then
    select json_build_object('extension', b.extension::text, 'name', b.name) into grp
      from branches b where b.workspace_id = ws and b.extension is not null order by b.extension limit 1;
  end if;
  return json_build_object('now', now(), 'calls', public.calls_allowed(ws), 'extension', ext,
    'owner_name', (select display_name from members where workspace_id = ws and role = 'owner' order by joined_at limit 1),
    'first_group', grp,
    'office', case when o.office_id is null then null else json_build_object('office_id', o.office_id, 'pc_name', o.pc_name, 'state', o.state,
      'address', o.addresses[1], 'sip_port', coalesce(o.sip_port, 5060), 'last_seen', o.last_seen,
      'online', o.last_seen > now() - interval '12 minutes', 'licence', o.licence) end,
    'dnd', (select coalesce((e ->> 'dnd')::boolean, false) from jsonb_array_elements(coalesce(o.extensions, '[]'::jsonb)) e
            where e ->> 'extension' = ext and e ->> 'type' = 'person' limit 1),
    'phones', (select coalesce(json_agg(json_build_object('mac', p.mac, 'vendor', p.vendor, 'model', p.model, 'registered', p.registered,
        'last_registered', p.last_registered, 'name', p.name, 'location', p.location, 'provisioned_at', p.provisioned_at) order by p.registered desc, p.mac), '[]')
      from link_office_phones p where p.workspace_id = ws and p.office_id = o.office_id and p.assigned and ext is not null and p.extension = ext));
end $$;

-- A change for my own extension only (internal): Show my password, or my Do not disturb. Goes to the newest office.
create or replace function public.link_my_send(ws uuid, kind text, clean jsonb, audit_action text) returns uuid
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare ext text := link_my_ext(ws); the_office text; cid uuid;
begin
  if not public.is_member(ws) then raise exception 'You''re not in that company'; end if;
  if ext is null then raise exception 'You don''t have an extension yet. Ask the business''s owner to give you one in People & access.'; end if;
  perform link_sweep();
  select o.office_id into the_office from link_offices o where o.workspace_id = ws order by o.last_seen desc limit 1;
  if the_office is null then raise exception 'Your business hasn''t set up Riyeser Link Office yet.'; end if;
  if (select count(*) from link_office_commands c where c.workspace_id = ws and c.created_by = auth.uid() and c.status = 'pending') >= 5 then
    raise exception 'You''ve asked a few times already. Wait a minute for Riyeser Link Office to answer.';
  end if;
  if (select count(*) from link_office_commands c where c.workspace_id = ws and c.status = 'pending') >= 50 then
    raise exception 'There are already 50 changes waiting for Riyeser Link Office. Is the office PC on?';
  end if;
  insert into link_office_commands (workspace_id, office_id, kind, data) values (ws, the_office, kind, jsonb_build_object('extension', ext) || clean)
    returning id into cid;
  insert into audit_log (workspace_id, action, details, actor)
  values (ws, audit_action, jsonb_strip_nulls(jsonb_build_object('extension', ext, 'on', clean -> 'on', 'office_id', the_office)), auth.uid());
  return cid;
end $$;

-- Show MY password: pub_key is the browser tab's one-off public key (RSA-OAEP, SHA-256). Only my own extension.
create or replace function public.link_my_reveal(ws uuid, pub_key jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare k jsonb := pub_key;
begin
  if jsonb_typeof(k) is distinct from 'object' or k ->> 'kty' is distinct from 'RSA' or coalesce(k ->> 'n', '') !~ '^[A-Za-z0-9_-]+$'
     or length(k ->> 'n') not between 340 and 700 or coalesce(k ->> 'e', '') !~ '^[A-Za-z0-9_-]{1,8}$' then
    raise exception 'This browser can''t show passwords safely. Try another browser, such as Chrome, Edge or Safari.';
  end if;
  return link_my_send(ws, 'reveal_password',
    jsonb_build_object('key', jsonb_build_object('kty', 'RSA', 'alg', 'RSA-OAEP-256', 'n', k ->> 'n', 'e', k ->> 'e')), 'link.reveal_own');
end $$;

-- Do not disturb for MY extension only.
create or replace function public.link_my_dnd(ws uuid, dnd_on boolean) returns uuid
  language plpgsql security definer set search_path = public as $$
begin
  if dnd_on is null then raise exception 'Say whether Do not disturb is on or off.'; end if;
  return link_my_send(ws, 'set_dnd', jsonb_build_object('on', dnd_on), 'link.set_dnd_own');
end $$;

-- How a change is going (replaces the version above): admins and Riyeser support as before, and now also the person
-- who asked for a change to their OWN extension (Show my password, my Do not disturb).
create or replace function public.link_command_state(command uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare c link_office_commands;
begin
  perform link_sweep();
  select * into c from link_office_commands where id = command;
  if c.id is null or not (public.is_admin(c.workspace_id) or (c.by_riyeser and c.created_by = auth.uid() and hq_can('link.support'))
      or (not c.by_riyeser and c.created_by = auth.uid() and c.kind in ('reveal_password', 'set_dnd')
          and coalesce(c.data ->> 'extension' = link_my_ext(c.workspace_id), false))) then   -- null-safe: no extension, no access
    raise exception 'That change isn''t one of yours.';
  end if;
  return json_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'error', c.error, 'created_at', c.created_at, 'done_at', c.done_at,
    'ready', exists (select 1 from link_office_reveals r where r.command_id = c.id and r.requested_by = auth.uid() and r.sealed is not null
                     and r.read_at is null and r.expires_at > now()));
end $$;

-- Take the (encrypted) password once (replaces the version above). As before: only the person who asked, within
-- 5 minutes, blanked straight away; and they must still be an admin, or allowed to help, or it's still their own extension.
create or replace function public.link_reveal_take(command uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare r link_office_reveals; s text;
begin
  perform link_sweep();
  select * into r from link_office_reveals where command_id = command for update;
  if r.command_id is null or r.requested_by <> auth.uid() then raise exception 'There''s no password waiting for you.'; end if;
  if not (public.is_admin(r.workspace_id) or (hq_can('link.support') and link_support_active(r.workspace_id))
          or coalesce(r.extension = link_my_ext(r.workspace_id), false)) then   -- null-safe: no extension, no access
    raise exception 'You can''t see this business''s phone passwords any more.';
  end if;
  if r.sealed is null or r.read_at is not null or r.expires_at <= now() then return null; end if;
  s := r.sealed;
  update link_office_reveals set sealed = null, read_at = now() where command_id = r.command_id;
  return s;
end $$;

revoke all on function public.link_my_ext(uuid), public.link_my_phone(uuid), public.link_my_send(uuid, text, jsonb, text),
  public.link_my_reveal(uuid, jsonb), public.link_my_dnd(uuid, boolean), public.link_command_state(uuid), public.link_reveal_take(uuid)
  from public, anon, authenticated;
grant execute on function public.link_my_phone(uuid), public.link_my_reveal(uuid, jsonb), public.link_my_dnd(uuid, boolean),
  public.link_command_state(uuid), public.link_reveal_take(uuid) to authenticated;

-- ===== HQ customer page & reports =====
-- The full customer page in HQ (#/company/<id>): contact person, programs with one-click extensions, PCs and the
-- Riyeser programs installed on them, people, one conversation timeline (tickets, emails, notes, logged calls,
-- refunds, free periods), staff-started tickets ("Message customer"), follow-ups; the Companies list with filters,
-- sorting and server-side pages (for 15,000+ businesses); Reports; and the HQ home's "Needs attention".
-- Same rules as above: every hq_ function checks a permission with hq_need (two-step sign-in included), every change
-- is written to hq_audit, nothing deletes customer data, and HQ never sees customers' chat messages or books.

-- ---------------------------------------------------------------- new columns and indexes (for 15,000+ businesses)
-- Which Riyeser programs are installed on each linked PC, as Riyeser Central last reported it: [{id, version}].
alter table public.devices add column if not exists programs jsonb;
alter table public.devices add column if not exists programs_at timestamptz;
-- Notes can be logged calls (in or out, with whom), pinned, and have a follow-up date for the staff member who wrote them.
alter table public.hq_notes add column if not exists kind text not null default 'note';
do $$ begin
  alter table public.hq_notes add constraint hq_notes_kind check (kind in ('note', 'call'));
exception when duplicate_object then null; end $$;
alter table public.hq_notes add column if not exists direction text check (direction in ('in', 'out'));
alter table public.hq_notes add column if not exists contact text check (length(contact) <= 120);
alter table public.hq_notes add column if not exists follow_up date;
alter table public.hq_notes add column if not exists follow_up_done_at timestamptz;
alter table public.hq_notes add column if not exists pinned boolean not null default false;
-- Tickets Riyeser started ("Message customer"): the first message is from staff, to someone in the business.
alter table public.support_tickets add column if not exists staff_started boolean not null default false;
alter table public.support_tickets add column if not exists started_by uuid references auth.users(id) on delete set null;
-- When each program was first paid for (for the revenue estimate and trial conversion).
alter table public.company_modules add column if not exists paid_since date;
update public.company_modules set paid_since = updated_at::date where paid_since is null and status in ('active', 'cancelled') and paid_until is not null;
create or replace function public.company_modules_paid_since() returns trigger language plpgsql as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or (old.paid_until is not null and old.paid_until < current_date)) then
    new.paid_since := current_date;
  end if;
  return new;
end $$;
drop trigger if exists company_modules_paid_since on public.company_modules;
create trigger company_modules_paid_since before insert or update on public.company_modules for each row execute function public.company_modules_paid_since();
-- The owner-approved removal (hq_remove_accounts) blanks note text; this also blanks who a call was with.
create or replace function public.hq_notes_removing() returns trigger language plpgsql as $$
begin
  if current_setting('riyeser.removing', true) = 'on' then new.contact := null; end if;
  return new;
end $$;
drop trigger if exists hq_notes_removing on public.hq_notes;
create trigger hq_notes_removing before update on public.hq_notes for each row execute function public.hq_notes_removing();

create index if not exists workspaces_created on public.workspaces (created_at desc);
create index if not exists workspaces_last_active on public.workspaces (last_active_at);
create index if not exists workspaces_status on public.workspaces (status);
create index if not exists workspaces_country on public.workspaces (country);
create index if not exists company_modules_trial_ends on public.company_modules (trial_ends) where status = 'trial';
create index if not exists company_modules_paid_until on public.company_modules (paid_until);
create index if not exists company_modules_paid_since on public.company_modules (paid_since);
create index if not exists members_owner on public.members (workspace_id) where role = 'owner';
create index if not exists members_user on public.members (user_id);
create index if not exists devices_ws on public.devices (workspace_id, last_seen desc);
create index if not exists support_tickets_ws_open on public.support_tickets (workspace_id) where status <> 'done';
create index if not exists support_tickets_created on public.support_tickets (created_at);
create index if not exists email_outbox_ws on public.email_outbox (workspace_id, id desc);
create index if not exists hq_notes_ws on public.hq_notes (workspace_id, created_at desc);
create index if not exists hq_notes_follow_up on public.hq_notes (author, follow_up) where follow_up is not null and follow_up_done_at is null;
create index if not exists refund_requests_status on public.refund_requests (status);
create index if not exists offers_status on public.offers (status);

-- ---------------------------------------------------------------- Riyeser Central: the programs on each PC
-- Central sends this when it links the PC and at its daily check-in. Only for someone in the business, and only
-- for a PC they linked. programs: [{"id": "pos", "version": "1.4.0"}, ...] (or {"pos": "1.4.0", ...}).
create or replace function public.report_programs(ws uuid, device uuid, programs jsonb) returns void
  language plpgsql security definer set search_path = public as $$
declare arr jsonb; clean jsonb;
begin
  if not is_member(ws) then raise exception 'You''re not in that company'; end if;
  if not exists (select 1 from devices d where d.id = device and d.workspace_id = ws and d.user_id = auth.uid()) then
    raise exception 'Link this PC to the company first'; end if;
  arr := case jsonb_typeof(report_programs.programs)
    when 'array' then report_programs.programs
    when 'object' then (select coalesce(jsonb_agg(jsonb_build_object('id', k, 'version', v)), '[]') from jsonb_each_text(report_programs.programs) e(k, v))
    else '[]'::jsonb end;
  select coalesce(jsonb_agg(jsonb_build_object('id', y.pid, 'version', y.ver) order by y.pid), '[]') into clean from (
    select distinct on (e ->> 'id') e ->> 'id' as pid, left(nullif(trim(coalesce(e ->> 'version', '')), ''), 40) as ver
    from jsonb_array_elements(arr) e
    where jsonb_typeof(e) = 'object' and coalesce(e ->> 'id', '') ~ '^[a-z0-9-]{1,40}$'
    order by e ->> 'id' limit 60) y;
  update devices d set programs = clean, programs_at = now(), last_seen = now() where d.id = device and d.workspace_id = ws;
end $$;

-- ---------------------------------------------------------------- helpers (only called by the checked hq_ functions)
-- hq_can with two permissions (either will do)
create or replace function public.hq_can(perm text, perm2 text) returns boolean
  language sql stable security definer set search_path = public as $$ select public.hq_can(perm) or public.hq_can(perm2) $$;
-- What someone typed when they made their account on riyeser.com (only these fields: never anything else kept with it).
create or replace function public.signup_json(md jsonb) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'you', nullif(s ->> 'you', ''), 'phone', nullif(s ->> 'phone', ''), 'country', nullif(s ->> 'country', ''), 'email', nullif(s ->> 'email', ''),
    'biz', nullif(case when jsonb_typeof(s -> 'biz') = 'object' then s -> 'biz' ->> 'name' else s ->> 'biz' end, ''),
    'tax_number', nullif(coalesce(s -> 'biz' ->> 'tax_number', s ->> 'tax_number'), ''),
    'address', nullif(coalesce(s -> 'biz' ->> 'address', s ->> 'address'), '')))
  from (select case when jsonb_typeof(md -> 'riyeser_signup') = 'object' then md -> 'riyeser_signup' else '{}'::jsonb end as s) x
$$;
-- One person in a business: their contact details and sign-in (never their messages).
create or replace function public.hq_person(ws uuid, uid uuid) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('user_id', m.user_id, 'name', m.display_name, 'role', m.role, 'job_role', m.job_role, 'extension', m.extension,
    'email', u.email::text, 'phone', public.signup_json(u.raw_user_meta_data) ->> 'phone', 'country', public.signup_json(u.raw_user_meta_data) ->> 'country',
    'signed_up', u.created_at, 'last_sign_in', u.last_sign_in_at, 'email_confirmed', u.email_confirmed_at is not null,
    'two_step', public.has_two_step(m.user_id), 'joined', m.joined_at, 'signup', public.signup_json(u.raw_user_meta_data),
    'branches', (select coalesce(json_agg(b.name order by b.extension), '[]') from branch_members bm join branches b on b.id = bm.branch_id
                 where bm.user_id = m.user_id and b.workspace_id = ws))
  from members m join auth.users u on u.id = m.user_id where m.workspace_id = ws and m.user_id = uid
$$;
create or replace function public.hq_note_json(n hq_notes) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', n.id, 'kind', n.kind, 'body', n.body, 'at', n.created_at, 'by', public.staff_name(n.author), 'author', n.author,
    'direction', n.direction, 'contact', n.contact, 'follow_up', n.follow_up, 'follow_up_done_at', n.follow_up_done_at, 'pinned', n.pinned)
$$;
-- The business's conversations, newest first: tickets, emails sent (subject and status only), notes, logged calls,
-- refunds and free periods. Tickets and refunds only for staff who may see them.
create or replace function public.hq_timeline(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.at desc), '[]') from (select * from (
    select 'ticket' as kind, t.created_at as at, t.id::text as id, t.ref, t.subject as title, t.status, t.staff_started as by_staff,
      t.topic as detail, case when t.staff_started then public.staff_name(t.started_by)
        else (select m.display_name from members m where m.workspace_id = ws and m.user_id = t.opened_by) end as who, null::date as follow_up, t.level::text as extra
    from support_tickets t where t.workspace_id = ws and public.hq_can('support.view')
    union all
    select 'email', e.created_at, e.id::text, null, e.subject, e.status, true, e.template, e.to_address, null, null
    from email_outbox e where e.workspace_id = ws and public.hq_can('emails.view', 'support.view')
    union all
    select n.kind, n.created_at, n.id::text, null, n.body, case when n.follow_up is not null and n.follow_up_done_at is null then 'follow_up' end,
      true, n.direction, public.staff_name(n.author), n.follow_up, n.contact
    from hq_notes n where n.workspace_id = ws
    union all
    select 'refund', f.created_at, f.id::text, f.ref, f.for_what, f.status, f.on_behalf_by is not null, f.currency || ' ' || f.amount::text,
      coalesce(public.staff_name(f.on_behalf_by), (select m.display_name from members m where m.workspace_id = ws and m.user_id = f.requested_by)), null, null
    from refund_requests f where f.workspace_id = ws and public.hq_can('refunds.view')
    union all
    select 'offer', o.created_at, o.id::text, o.ref, o.days || ' free days · ' || array_to_string(array(select public.module_label(x) from unnest(o.modules) x), ', '),
      o.status, true, o.reason_category, public.staff_name(o.requested_by), o.ends_at, null
    from offers o where o.workspace_id = ws
  ) y order by y.at desc limit 300) x
$$;

-- ---------------------------------------------------------------- the customer page
create or replace function public.hq_company_page(ws uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare w workspaces; r json; owner_id uuid; od numeric := hq_setting_num('support.overdue_hours', 24);
begin
  perform hq_need(array['customers.view']);
  select * into w from workspaces where id = ws;
  if w.id is null then raise exception 'That business doesn''t exist.'; end if;
  select m.user_id into owner_id from members m where m.workspace_id = ws and m.role = 'owner' order by m.joined_at limit 1;
  select json_build_object(
    'profile', json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'legal_name', w.legal_name,
        'tax_number', w.tax_number, 'address', w.address, 'phone', w.phone, 'email', w.email, 'country', w.country,
        'created_at', w.created_at, 'calls_paid_until', w.calls_paid_until, 'require_approval', w.require_approval, 'kind', w.kind,
        'status', w.status, 'closed_at', w.closed_at, 'closed_reason', w.closed_reason, 'last_active_at', w.last_active_at,
        'duplicate_of', w.duplicate_of, 'duplicate_of_name', (select d.name from workspaces d where d.id = w.duplicate_of), 'removal_state', w.removal_state,
        'hq_owner', w.hq_owner, 'hq_owner_name', public.staff_name(w.hq_owner)),
    'next_follow_up', public.next_follow_up(ws),
    'staff', (select coalesce(json_agg(json_build_object('user_id', s.user_id, 'name', s.display_name) order by s.display_name), '[]') from hq_staff s where s.active),
    'owner', case when owner_id is not null then public.hq_person(ws, owner_id) end,
    'people', (select coalesce(json_agg(public.hq_person(ws, m.user_id) order by (m.role = 'owner') desc, m.joined_at), '[]') from members m where m.workspace_id = ws),
    'branches', (select coalesce(json_agg(json_build_object('name', b.name, 'extension', b.extension,
        'people', (select count(*) from branch_members bm where bm.branch_id = b.id)) order by b.extension), '[]') from branches b where b.workspace_id = ws),
    'pcs', (select coalesce(json_agg(json_build_object('id', d.id, 'name', d.device_name, 'platform', d.platform, 'version', d.app_version,
        'last_seen', d.last_seen, 'linked_at', d.linked_at, 'programs', coalesce(d.programs, '[]'::jsonb), 'programs_at', d.programs_at,
        'person', (select m.display_name from members m where m.workspace_id = ws and m.user_id = d.user_id)) order by d.last_seen desc), '[]')
        from devices d where d.workspace_id = ws),
    'licence', case when hq_can('licences.view') then licence_json(ws) end,
    'monthly', case when hq_can('licences.view') then company_monthly(ws) end,
    'storage', case when hq_can('licences.view') then public.link_storage_json(ws) end,
    'requests_waiting', (select count(*) from join_requests j where j.workspace_id = ws and j.status = 'pending'),
    'notes', (select coalesce(json_agg(public.hq_note_json(n) order by n.pinned desc, n.created_at desc), '[]')
        from (select * from hq_notes where workspace_id = ws order by created_at desc limit 200) n),
    'tickets_open', (select count(*) from support_tickets t where t.workspace_id = ws and t.status <> 'done'),
    'tickets_overdue', (select count(*) from support_tickets t where t.workspace_id = ws and t.status <> 'done'
        and (t.overdue_at is not null or (t.first_reply_at is null and t.created_at < now() - make_interval(secs => od * 3600)))),
    'timeline', public.hq_timeline(ws),
    'extra', public.hq_company_extra(ws)) into r;
  perform hq_log('customer.viewed', jsonb_build_object('workspace_id', ws));
  return r;
end $$;

-- ---------------------------------------------------------------- Message customer (a ticket Riyeser starts)
-- Opened on behalf of the business, addressed to one person in it (the owner when none is chosen). They see it on
-- their Riyeser home page (Help) as "Message from Riyeser" and can reply; it's emailed to them through the outbox.
create or replace function public.hq_message_customer(ws uuid, to_person uuid, msg_topic text, msg_subject text, msg_body text) returns json
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; who uuid := to_person; nm text; tp text := coalesce(nullif(msg_topic, ''), 'other');
begin
  perform hq_need(array['support.reply']);
  if not exists (select 1 from workspaces where id = ws) then raise exception 'That business doesn''t exist.'; end if;
  if who is null then select m.user_id into who from members m where m.workspace_id = ws and m.role = 'owner' order by m.joined_at limit 1; end if;
  if who is null or not exists (select 1 from members m where m.workspace_id = ws and m.user_id = who) then
    raise exception 'Choose someone who is in this business.'; end if;
  if length(trim(coalesce(msg_subject, ''))) = 0 or length(trim(coalesce(msg_body, ''))) = 0 then
    raise exception 'Add a subject and a message, then send it again.'; end if;
  if tp not in ('billing', 'signin', 'program', 'other') then tp := 'other'; end if;
  insert into support_tickets (workspace_id, opened_by, topic, subject, status, staff_started, started_by, assignee, first_reply_at, last_staff_at)
    values (ws, who, tp, left(trim(msg_subject), 150), 'waiting_customer', true, auth.uid(), auth.uid(), now(), now()) returning * into t;
  insert into support_messages (ticket_id, author, is_staff, body) values (t.id, auth.uid(), true, left(trim(msg_body), 5000));
  select m.display_name into nm from members m where m.workspace_id = ws and m.user_id = who;
  perform queue_email(who, null, 'staff_message', t.subject || ' (' || t.ref || ')',
    'Hi ' || coalesce(split_part(trim(nm), ' ', 1), '') || ',' || E'\n\n' || trim(msg_body) || E'\n\n'
    || 'To reply, open it under "Your help requests" on your Riyeser home page:' || E'\n' || 'https://riyeser.com/link/?help#' || t.ref, ws, t.id, null);
  perform hq_log('ticket.started', jsonb_build_object('workspace_id', ws, 'ticket', t.ref, 'to', who));
  return json_build_object('id', t.id, 'ref', t.ref);
end $$;

-- Customers' help requests now say when Riyeser started them (the rest is as before).
create or replace function public.my_tickets() returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.updated_at desc), '[]') from (
    select t.id, t.ref, t.subject, t.topic, t.status, t.workspace_id, w.name as business, t.opened_by = auth.uid() as mine,
      t.staff_started as from_riyeser, t.created_at, t.updated_at, t.product, t.who_acts, t.work_blocked, t.resolved_at, t.rating,
      case when t.status <> 'done' then t.next_update_due end as next_update_due,
      (select count(*) from support_messages m where m.ticket_id = t.id and m.is_staff and not m.internal
         and m.created_at > coalesce((select r.read_at from support_reads r where r.ticket_id = t.id and r.user_id = auth.uid()), '-infinity')) as unread
    from support_tickets t left join workspaces w on w.id = t.workspace_id
    where auth.uid() is not null and (t.opened_by = auth.uid() or (t.workspace_id is not null and public.is_admin(t.workspace_id)))
    order by t.updated_at desc limit 50) x
$$;
create or replace function public.my_ticket(ticket uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare r json;
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  select json_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject, 'topic', t.topic, 'status', t.status, 'created_at', t.created_at,
    'from_riyeser', t.staff_started, 'product', t.product, 'who_acts', t.who_acts, 'work_blocked', t.work_blocked, 'resolved_at', t.resolved_at,
    'rating', t.rating, 'rating_comment', t.rating_comment, 'next_update_due', case when t.status <> 'done' then t.next_update_due end,
    'diag_ref', (select d.ref from support_diagnostics d where d.id = t.diag_id),
    'messages', (select coalesce(json_agg(json_build_object('id', m.id, 'staff', m.is_staff, 'mine', m.author = auth.uid(),
        'from', case when m.is_staff then 'Riyeser Support'
                     else coalesce((select display_name from members mm where mm.workspace_id = t.workspace_id and mm.user_id = m.author), 'You') end,
        'body', m.body, 'at', m.created_at) order by m.id), '[]') from support_messages m where m.ticket_id = t.id and not m.internal))
    into r from support_tickets t where t.id = ticket;
  insert into support_reads (ticket_id, user_id) values (ticket, auth.uid()) on conflict (ticket_id, user_id) do update set read_at = now();
  return r;
end $$;

-- ---------------------------------------------------------------- notes, logged calls and follow-ups
create or replace function public.hq_note_add(ws uuid, note_kind text, note_body text, call_direction text, call_with text, follow_up_on date, pin boolean)
  returns bigint language plpgsql security definer set search_path = public as $$
declare i bigint; k text := coalesce(nullif(note_kind, ''), 'note');
begin
  perform hq_need(array['customers.notes']);
  if not exists (select 1 from workspaces where id = ws) then raise exception 'That business doesn''t exist.'; end if;
  if k not in ('note', 'call') then raise exception 'Choose a note or a call.'; end if;
  if length(trim(coalesce(note_body, ''))) = 0 then raise exception 'Write what it was about first.'; end if;
  if k = 'call' and coalesce(call_direction, '') not in ('in', 'out') then raise exception 'Choose whether they called us or we called them.'; end if;
  if follow_up_on is not null and follow_up_on < current_date then raise exception 'Choose a follow-up date from today on.'; end if;
  insert into hq_notes (workspace_id, author, body, kind, direction, contact, follow_up, pinned)
    values (ws, auth.uid(), left(trim(note_body), 2000), k, case when k = 'call' then call_direction end,
            nullif(left(trim(coalesce(call_with, '')), 120), ''), follow_up_on, coalesce(pin, false))
    returning id into i;
  -- (no note text here: the HQ history is kept for good)
  perform hq_log(case when k = 'call' then 'call.logged' else 'note.added' end,
    jsonb_build_object('workspace_id', ws, 'note', i, 'direction', call_direction, 'follow_up', follow_up_on, 'pinned', coalesce(pin, false)));
  return i;
end $$;
create or replace function public.hq_note_pin(note_id bigint, pin boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare n hq_notes;
begin
  perform hq_need(array['customers.notes']);
  update hq_notes set pinned = coalesce(pin, false) where id = note_id returning * into n;
  if n.id is null then raise exception 'That note doesn''t exist.'; end if;
  perform hq_log(case when n.pinned then 'note.pinned' else 'note.unpinned' end, jsonb_build_object('workspace_id', n.workspace_id, 'note', n.id));
end $$;
create or replace function public.hq_follow_up_done(note_id bigint) returns void
  language plpgsql security definer set search_path = public as $$
declare n hq_notes;
begin
  perform hq_need(array['customers.notes']);
  update hq_notes set follow_up_done_at = now() where id = note_id and follow_up is not null and follow_up_done_at is null returning * into n;
  if n.id is null then raise exception 'That follow-up is already done.'; end if;
  perform hq_log('follow_up.done', jsonb_build_object('workspace_id', n.workspace_id, 'note', n.id));
end $$;
-- My follow-ups: the ones I set and haven't ticked off, soonest first.
create or replace function public.hq_my_follow_ups() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['customers.view', 'customers.notes']);
  return (select coalesce(json_agg(json_build_object('id', n.id, 'workspace_id', n.workspace_id, 'business', w.name, 'company_code', w.company_code,
      'kind', n.kind, 'body', left(n.body, 200), 'contact', n.contact, 'direction', n.direction, 'follow_up', n.follow_up,
      'due', n.follow_up <= current_date, 'overdue', n.follow_up < current_date, 'at', n.created_at) order by n.follow_up, n.id), '[]')
    from (select * from hq_notes where author = auth.uid() and follow_up is not null and follow_up_done_at is null order by follow_up, id limit 200) n
    join workspaces w on w.id = n.workspace_id);
end $$;

-- ---------------------------------------------------------------- one-click licence actions (the Programs tab)
-- act: 'extend' (days: +7/+30/+90 free), 'unlock' (a trial to 30 days, or paid-until for a lapsed paid program),
-- 'paid_until' (a date), 'pause' (stops now) or 'cancel' (works to the end of what's paid). Free time goes through
-- the free periods (offers) above, so the self limit (31 days) and supervisor approval still apply. Paid-until,
-- pause and cancel need licences.manage. Each needs a reason (category and note) and can name a ticket.
create or replace function public.hq_quick_licence(ws uuid, mod text, act text, days int, until_day date, reason_category text, reason text, ticket_ref text)
  returns json language plpgsql security definer set search_path = public as $$
declare st json; s text; tr text; target date; base date; trialish boolean; res json; was jsonb;
begin
  perform hq_need(array['offers.grant', 'licences.manage']);
  if mod is null or mod not in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls') then raise exception 'Choose a program.'; end if;
  if act is null or act not in ('extend', 'unlock', 'paid_until', 'pause', 'cancel') then raise exception 'Choose what to do.'; end if;
  if not exists (select 1 from workspaces where id = ws) then raise exception 'That business doesn''t exist.'; end if;
  st := module_state(ws, mod); s := st ->> 'status';
  if s = 'closed' then raise exception 'This business is closed or suspended. Reopen it first.'; end if;
  trialish := s in ('trial', 'ended') and not exists (select 1 from company_modules c where c.workspace_id = ws and c.module = mod and c.status <> 'trial');
  was := jsonb_build_object('status', s, 'trial_ends', st ->> 'trial_ends', 'paid_until', st ->> 'paid_until');
  if act in ('extend', 'unlock') and reason_category not in ('retention', 'goodwill', 'promotion', 'other') then raise exception 'Choose a reason.'; end if;
  if act in ('paid_until', 'pause', 'cancel') and coalesce(reason_category, '') not in ('payment', 'correction', 'customer_asked', 'non_payment', 'other') then
    raise exception 'Choose a reason.'; end if;
  if act = 'extend' then
    if days is null or days < 1 or days > 1000 then raise exception 'Choose how many days.'; end if;
    if trialish then res := hq_grant_offer(ws, 'trial', array[mod], days, 'days', reason_category, reason, ticket_ref);
    elsif s = 'active' then res := hq_grant_offer(ws, 'paid', array[mod], days, 'days', reason_category, reason, ticket_ref);
    else raise exception '% isn''t on a trial or paid right now. Use Unlock now or Mark paid until.', module_label(mod); end if;
    return (res::jsonb || jsonb_build_object('action', act, 'module', mod))::json;
  elsif act = 'unlock' then
    if trialish then
      target := current_date + 30;
      base := greatest(coalesce((st ->> 'trial_ends')::date, current_date), current_date);
      if base >= target then raise exception '% is already on its trial until %.', module_label(mod), to_char(base, 'FMDD Mon YYYY'); end if;
      res := hq_grant_offer(ws, 'trial', array[mod], target - base, 'days', reason_category, reason, ticket_ref);
      return (res::jsonb || jsonb_build_object('action', act, 'module', mod))::json;
    elsif s = 'active' then
      raise exception '% is already paid%.', module_label(mod), coalesce(' until ' || to_char((st ->> 'paid_until')::date, 'FMDD Mon YYYY'), '');
    end if;
    -- a paid program that was cancelled or has lapsed: set it paid until a date (needs licences.manage)
    tr := hq_fix_start('licences.manage', reason, ticket_ref);
    target := coalesce(until_day, current_date + 30);
    if target < current_date then raise exception 'Choose a date from today on.'; end if;
    perform licence_set_module(ws, mod, 'active', null, target);
  elsif act = 'paid_until' then
    tr := hq_fix_start('licences.manage', reason, ticket_ref);
    if until_day is null or until_day < current_date then raise exception 'Choose a date from today on.'; end if;
    target := until_day;
    perform licence_set_module(ws, mod, 'active', null, target);
  else
    tr := hq_fix_start('licences.manage', reason, ticket_ref);
    if s = 'trial' then target := current_date - 1; perform licence_set_module(ws, mod, 'trial', target, null);
    elsif s = 'active' then
      target := case when act = 'pause' then current_date - 1 else (st ->> 'paid_until')::date end;
      perform licence_set_module(ws, mod, 'cancelled', null, target);
    elsif s = 'cancelled' and act = 'pause' and (st ->> 'active')::boolean then
      target := current_date - 1; perform licence_set_module(ws, mod, 'cancelled', null, target);
    else raise exception '% isn''t running, so there''s nothing to %.', module_label(mod), act; end if;
  end if;
  perform hq_log('licence.' || case act when 'unlock' then 'unlocked' when 'paid_until' then 'paid_until' when 'pause' then 'paused' else 'cancelled' end,
    jsonb_build_object('workspace_id', ws, 'module', mod, 'ticket', tr, 'reason_category', reason_category, 'reason', left(trim(reason), 500),
      'was', was, 'until', target));
  return json_build_object('status', 'done', 'action', act, 'module', mod, 'until', target);
end $$;

-- ---------------------------------------------------------------- the Companies list: filters, sorting, pages
-- filters: {plan: 'paid'|'trial'|'free', trial_days: 7|14|30, country, status, kind, inactive_days: 30|60|90,
--           open_tickets: true, follow_up: true}. sort_by: name, owner, phone, plan, trial, last_active, tickets,
-- status, country, created. 50 a page (up to 200; up to 5,000 a page for a CSV export, which is written to the history).
create or replace function public.hq_companies_page(search text, filters jsonb, sort_by text, sort_desc boolean, page_no int, per_page int, for_export boolean)
  returns json language plpgsql security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(search, '')), ''); fl jsonb := coalesce(filters, '{}'::jsonb); lim int; off int; r json;
  sk text := coalesce(nullif(sort_by, ''), 'created'); dsc boolean := coalesce(sort_desc, sort_by is null or sort_by = '' or sort_by = 'created');
  f_status text := nullif(fl ->> 'status', ''); f_country text := nullif(fl ->> 'country', ''); f_kind text := nullif(fl ->> 'kind', '');
  f_plan text := nullif(fl ->> 'plan', ''); f_trial int; f_inactive int;
  f_tickets boolean := coalesce((fl ->> 'open_tickets')::boolean, false); f_follow boolean := coalesce((fl ->> 'follow_up')::boolean, false);
  f_mine boolean := coalesce((fl ->> 'mine')::boolean, false);
  f_storage boolean := coalesce((fl ->> 'storage_80')::boolean, false);   -- Riyeser Link files over 80% of the limit
begin
  perform hq_need(array['customers.view']);
  f_trial := case when (fl ->> 'trial_days') ~ '^[0-9]{1,4}$' then (fl ->> 'trial_days')::int end;
  f_inactive := case when (fl ->> 'inactive_days') ~ '^[0-9]{1,4}$' then (fl ->> 'inactive_days')::int end;
  lim := least(greatest(coalesce(per_page, 50), 1), case when coalesce(for_export, false) then 5000 else 200 end);
  off := greatest(coalesce(page_no, 1) - 1, 0) * lim;
  if sk not in ('name', 'owner', 'phone', 'plan', 'trial', 'last_active', 'tickets', 'status', 'country', 'created') then sk := 'created'; end if;
  with base as (
    select w.* from workspaces w
    where (f_status is null or w.status = f_status)
      and (f_country is null or coalesce(w.country, 'Not set') = f_country)
      and (f_kind is null or w.kind = f_kind)
      and (not f_mine or w.hq_owner = auth.uid())
      and (f_inactive is null or coalesce(w.last_active_at, w.created_at) < now() - make_interval(days => f_inactive))
      and (q is null or w.name ilike '%' || q || '%' or w.company_code ilike '%' || q || '%' or w.legal_name ilike '%' || q || '%'
           or w.tax_number ilike '%' || q || '%' or w.phone ilike '%' || q || '%'
           or exists (select 1 from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id
                      and (u.email::text ilike '%' || q || '%' or m.display_name ilike '%' || q || '%')))
  ), lic as (
    select b.id, count(*) filter (where x.st = 'paid') as paid_n, count(*) filter (where x.st = 'trial') as trial_n,
      min(x.te) filter (where x.st = 'trial') as trial_end
    from base b cross join unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) mm(m)
    left join company_modules c on c.workspace_id = b.id and c.module = mm.m
    cross join lateral (select coalesce(c.trial_ends, b.created_at::date + 90) as te,
      case when b.status <> 'active' then 'closed'
           when c.module is null or c.status = 'trial' then case when coalesce(c.trial_ends, b.created_at::date + 90) >= current_date then 'trial' else 'ended' end
           when c.status = 'active' then case when c.paid_until is null or c.paid_until >= current_date then 'paid' else 'ended' end
           else case when c.paid_until >= current_date then 'cancelled' else 'ended' end end as st) x
    group by b.id
  ), rws as (
    select b.id, b.name, b.company_code, b.country, b.created_at, b.status, b.kind, b.last_active_at,
      l.paid_n, l.trial_n, l.trial_end, (l.trial_end - current_date) as trial_days,
      o.user_id as owner_id, o.display_name as owner_name,
      coalesce(nullif(ou.raw_user_meta_data -> 'riyeser_signup' ->> 'phone', ''), b.phone) as phone,
      coalesce(tk.n, 0) as tickets_open
    from base b join lic l on l.id = b.id
    left join (select t.workspace_id, count(*) as n from support_tickets t where t.status <> 'done' group by 1) tk on tk.workspace_id = b.id
    left join lateral (select m.user_id, m.display_name from members m where m.workspace_id = b.id and m.role = 'owner' order by m.joined_at limit 1) o on true
    left join auth.users ou on ou.id = o.user_id
  ), filtered as (
    select * from rws x where
      (f_plan is null or (f_plan = 'paid' and x.paid_n > 0) or (f_plan = 'trial' and x.paid_n = 0 and x.trial_n > 0)
        or (f_plan = 'free' and x.paid_n = 0 and x.trial_n = 0))
      and (f_trial is null or (x.trial_end is not null and x.trial_end <= current_date + f_trial))
      and (not f_tickets or x.tickets_open > 0)
      and (not f_storage or public.link_storage_pct(x.id) >= 80)
      and (not f_follow or exists (select 1 from hq_notes n where n.workspace_id = x.id and n.follow_up is not null and n.follow_up_done_at is null)
           or exists (select 1 from support_tickets t where t.workspace_id = x.id and t.status in ('new', 'investigating', 'waiting_us')))
  ), ordered as (
    select f.*, row_number() over (order by
      case when not dsc then case sk when 'name' then lower(f.name) when 'owner' then lower(f.owner_name) when 'phone' then f.phone
        when 'status' then f.status when 'country' then lower(f.country) end end asc nulls last,
      case when dsc then case sk when 'name' then lower(f.name) when 'owner' then lower(f.owner_name) when 'phone' then f.phone
        when 'status' then f.status when 'country' then lower(f.country) end end desc nulls last,
      case when not dsc then case sk when 'plan' then f.paid_n::numeric when 'trial' then f.trial_days::numeric when 'tickets' then f.tickets_open::numeric
        when 'last_active' then extract(epoch from f.last_active_at) when 'created' then extract(epoch from f.created_at) end end asc nulls last,
      case when dsc then case sk when 'plan' then f.paid_n::numeric when 'trial' then f.trial_days::numeric when 'tickets' then f.tickets_open::numeric
        when 'last_active' then extract(epoch from f.last_active_at) when 'created' then extract(epoch from f.created_at) end end desc nulls last,
      f.created_at desc, f.id) as rn
    from filtered f
  )
  select json_build_object('total', (select count(*) from filtered), 'page', greatest(coalesce(page_no, 1), 1), 'per_page', lim,
    'sort_by', sk, 'sort_desc', dsc,
    -- the details only shown in the list are looked up for this page's rows only
    'rows', (select coalesce(json_agg(json_build_object('id', o.id, 'name', o.name, 'company_code', o.company_code, 'country', o.country,
        'created_at', o.created_at, 'status', o.status, 'kind', o.kind, 'last_active_at', o.last_active_at, 'paid_n', o.paid_n,
        'paid', coalesce((select array_agg(c.module order by c.module) from company_modules c where c.workspace_id = o.id and o.status = 'active'
            and c.status = 'active' and (c.paid_until is null or c.paid_until >= current_date)), '{}'),
        'trial_n', o.trial_n, 'trial_end', o.trial_end, 'trial_days', o.trial_days, 'owner_name', o.owner_name,
        'owner_email', (select u.email::text from auth.users u where u.id = o.owner_id),
        'phone', o.phone, 'tickets_open', o.tickets_open, 'people', (select count(*) from members m where m.workspace_id = o.id),
        'pcs', (select count(*) from devices d where d.workspace_id = o.id),
        'storage_pct', public.link_storage_pct(o.id),
        'hq_owner_name', (select public.staff_name(w.hq_owner) from workspaces w where w.id = o.id),
        'next_follow_up', (select min(n.follow_up) from hq_notes n where n.workspace_id = o.id and n.follow_up is not null and n.follow_up_done_at is null)) order by o.rn), '[]')
      from ordered o where o.rn > off and o.rn <= off + lim),
    'countries', (select coalesce(json_agg(json_build_object('country', c.country, 'n', c.n) order by c.n desc, c.country), '[]')
      from (select coalesce(country, 'Not set') as country, count(*) as n from workspaces group by 1) c)) into r;
  if coalesce(for_export, false) and coalesce(page_no, 1) <= 1 then
    perform hq_log('customers.exported', jsonb_build_object('filters', fl, 'search', q is not null, 'rows', (r ->> 'total')::int));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- Reports (reports.view)
-- Everything for the Reports tab in one go, for a date range (from_day to to_day, at most about 2 years).
-- Money is an estimate at list prices until payments are connected.
create or replace function public.hq_reports(from_day date, to_day date) returns json
  language plpgsql stable security definer set search_path = public as $$
declare f date := coalesce(from_day, current_date - 90); t date := coalesce(to_day, current_date); r json;
  od numeric := hq_setting_num('support.overdue_hours', 24);
  mods text[] := array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls'];
begin
  perform hq_need(array['reports.view']);
  if t < f then raise exception 'Choose a start date before the end date.'; end if;
  if t - f > 800 then f := t - 800; end if;
  select json_build_object('from', f, 'to', t, 'today', current_date,
    -- sign-ups
    'signups_by_week', (select coalesce(json_agg(x order by x.week), '[]') from (
        select date_trunc('week', w.created_at)::date as week, count(*) as n from workspaces w where w.created_at >= f and w.created_at < t + 1 group by 1) x),
    'funnel', (with u as (select au.id, au.email_confirmed_at from auth.users au where au.created_at >= f and au.created_at < t + 1
                            and not exists (select 1 from hq_staff s where s.user_id = au.id)),
                    b as (select distinct u.id as uid, m.workspace_id as ws from u join members m on m.user_id = u.id and m.role = 'owner')
      select json_build_object('signed_up', (select count(*) from u), 'confirmed', (select count(*) from u where u.email_confirmed_at is not null),
        'business', (select count(distinct b.uid) from b),
        'pc_linked', (select count(distinct b.uid) from b where exists (select 1 from devices d where d.workspace_id = b.ws)),
        'program_used', (select count(distinct b.uid) from b where exists (select 1 from devices d where d.workspace_id = b.ws and d.programs_at is not null
            and exists (select 1 from jsonb_array_elements(d.programs) p where p ->> 'id' <> 'central'))))),
    -- trials
    'trials_by_week', (select coalesce(json_agg(x order by x.week), '[]') from (
        select week, count(distinct ws) as n from (
          select date_trunc('week', w.created_at)::date as week, w.id as ws from workspaces w where w.created_at >= f and w.created_at < t + 1
          union all
          select date_trunc('week', o.created_at)::date, o.workspace_id from offers o where o.kind = 'trial' and o.status in ('applied', 'approved')
            and o.created_at >= f and o.created_at < t + 1) s group by 1) x),
    'trials_ending', (select coalesce(json_agg(x order by x.days_left, x.name), '[]') from (
        select w.id, w.name, w.company_code, min(z.te) as trial_ends, min(z.te) - current_date as days_left, array_agg(mm.m order by mm.m) as modules,
          (select m.display_name from members m where m.workspace_id = w.id and m.role = 'owner' limit 1) as owner_name
        from workspaces w cross join unnest(mods) mm(m) left join company_modules c on c.workspace_id = w.id and c.module = mm.m
        cross join lateral (select coalesce(c.trial_ends, w.created_at::date + 90) as te) z
        where w.status = 'active' and (c.module is null or c.status = 'trial') and z.te between current_date and current_date + 30
        group by w.id, w.name, w.company_code limit 1000) x),
    'conversion', (select coalesce(json_agg(x order by x.module), '[]') from (
        select mm.m as module,
          count(*) filter (where c.paid_since >= current_date - 30) as paid_30,
          count(*) filter (where c.paid_since >= current_date - 30 or (coalesce(c.status, 'trial') = 'trial'
            and coalesce(c.trial_ends, w.created_at::date + 90) between current_date - 30 and current_date - 1)) as ended_30,
          count(*) filter (where c.paid_since >= current_date - 90) as paid_90,
          count(*) filter (where c.paid_since >= current_date - 90 or (coalesce(c.status, 'trial') = 'trial'
            and coalesce(c.trial_ends, w.created_at::date + 90) between current_date - 90 and current_date - 1)) as ended_90
        from workspaces w cross join unnest(mods) mm(m) left join company_modules c on c.workspace_id = w.id and c.module = mm.m
        group by mm.m) x),
    -- money (estimate)
    'revenue_by_month', (with months as (select mo::date as ms, (mo + interval '1 month' - interval '1 day')::date as me
                                           from generate_series(date_trunc('month', f), date_trunc('month', t), interval '1 month') mo),
          paid as (select c.workspace_id, c.module, c.paid_since, c.paid_until from company_modules c
                   join workspaces w on w.id = c.workspace_id
                   where c.status in ('active', 'cancelled') and c.paid_since is not null),
          per as (select mo.ms, p.workspace_id, count(*) as n, array_agg(p.module) as mods from months mo join paid p on p.paid_since <= mo.me
                    and coalesce(p.paid_until, 'infinity'::date) >= mo.ms
                    and not exists (select 1 from workspaces w where w.id = p.workspace_id and w.status <> 'active' and w.closed_at < mo.ms)
                  group by 1, 2),
          amt as (select per.ms, public.riyeser_bill(per.mods, public.riyeser_people(per.workspace_id), coalesce(pl.extra_companies, 0), 'monthly',
                       coalesce(pl.early_bird, false) and pl.early_bird_since > per.ms - 365)
                     * case when coalesce(pl.billing, 'monthly') = 'yearly' then 10.0 / 12 else 1 end as a
                  from per left join company_plans pl on pl.workspace_id = per.workspace_id)
      select coalesce(json_agg(json_build_object('month', mo.ms,
          'estimate', round(coalesce((select sum(a.a) from amt a where a.ms = mo.ms), 0), 2),
          'paying', (select count(distinct p.workspace_id) from per p where p.ms = mo.ms),
          'new_paid', (select count(*) from paid p where p.paid_since between mo.ms and mo.me),
          'lost', (select count(*) from paid p where p.paid_until between mo.ms and mo.me and p.paid_until < current_date)) order by mo.ms), '[]')
      from months mo),
    'revenue_by_program', (select coalesce(json_agg(x order by x.paying desc, x.module), '[]') from (
        -- list price for each paying business (with its extra users); Basics counts nothing where Plus is paid too
        select mm.m as module, count(c.*) as paying,
          coalesce(sum(public.riyeser_bill(array[mm.m], public.riyeser_people(c.workspace_id), 0, 'monthly', false))
            filter (where c.module is not null and not (mm.m = 'basic' and exists (select 1 from company_modules c2 where c2.workspace_id = c.workspace_id
              and c2.module = 'plus' and c2.status = 'active' and (c2.paid_until is null or c2.paid_until >= current_date)))), 0) as estimate
        from unnest(mods) mm(m) left join (company_modules c join workspaces w on w.id = c.workspace_id and w.status = 'active')
          on c.module = mm.m and c.status = 'active' and (c.paid_until is null or c.paid_until >= current_date)
        group by mm.m) x),
    'monthly_now', coalesce((select sum(public.company_monthly(c.workspace_id)) from (select distinct workspace_id from company_modules
        where status in ('active', 'cancelled') and (paid_until is null or paid_until >= current_date)) c), 0),
    -- leaving
    'leaving_by_month', (select coalesce(json_agg(x order by x.month), '[]') from (
        select mo::date as month,
          (select count(*) from workspaces w where w.status <> 'active' and w.closed_at >= mo and w.closed_at < mo + interval '1 month') as closed,
          (select count(*) from workspaces w where w.status <> 'active' and w.closed_reason = 'inactive' and w.closed_at >= mo and w.closed_at < mo + interval '1 month') as closed_inactive,
          (select count(distinct c.workspace_id) from company_modules c where c.status = 'cancelled' and c.updated_at >= mo and c.updated_at < mo + interval '1 month') as cancelled,
          (select count(*) from workspaces w where w.status = 'active' and w.last_active_at >= mo and w.last_active_at < mo + interval '1 month'
             and w.last_active_at < now() - interval '60 days') as went_quiet
        from generate_series(date_trunc('month', f), date_trunc('month', t), interval '1 month') mo) x),
    -- support
    'support', json_build_object(
      'open_by_status', (select coalesce(json_object_agg(s.status, s.n), '{}') from (select status, count(*) as n from support_tickets where status <> 'done' group by 1) s),
      'open_by_level', (select coalesce(json_object_agg(s.level, s.n), '{}') from (select level, count(*) as n from support_tickets where status <> 'done' group by 1) s),
      'overdue', (select count(*) from support_tickets s where s.status <> 'done'
          and (s.overdue_at is not null or (s.first_reply_at is null and s.created_at < now() - make_interval(secs => od * 3600)))),
      'median_first_reply_hours', (select round((percentile_cont(0.5) within group (order by extract(epoch from s.first_reply_at - s.created_at) / 3600))::numeric, 1)
          from support_tickets s where not s.staff_started and s.first_reply_at is not null and s.created_at >= f and s.created_at < t + 1),
      'opened', (select count(*) from support_tickets s where s.created_at >= f and s.created_at < t + 1),
      'by_topic', (select coalesce(json_agg(x order by x.n desc), '[]') from (select s.topic, count(*) as n from support_tickets s
          where s.created_at >= f and s.created_at < t + 1 group by 1) x),
      'satisfaction', null),
    -- staff
    'staff_week', (select coalesce(json_agg(x order by x.changes desc, x.total desc), '[]') from (
        select coalesce(public.staff_name(a.actor), 'Riyeser') as who, count(*) as total, count(*) filter (where a.action not like '%.viewed') as changes
        from hq_audit a where a.actor is not null and a.at >= date_trunc('week', now()) group by a.actor) x),
    'staff_range', (select coalesce(json_agg(x order by x.changes desc, x.total desc), '[]') from (
        select coalesce(public.staff_name(a.actor), 'Riyeser') as who, count(*) as total, count(*) filter (where a.action not like '%.viewed') as changes
        from hq_audit a where a.actor is not null and a.at >= f and a.at < t + 1 group by a.actor) x)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------- the HQ home: what needs attention, for whoever is signed in
create or replace function public.hq_attention() returns json
  language plpgsql stable security definer set search_path = public as $$
declare od numeric := hq_setting_num('support.overdue_hours', 24);
begin
  perform hq_need(array['overview.view']);
  return json_build_object(
    'unassigned', case when hq_can('support.view') then (select count(*) from support_tickets where status <> 'done' and assignee is null) end,
    'overdue', case when hq_can('support.view') then (select count(*) from support_tickets s where s.status <> 'done'
        and (s.overdue_at is not null or (s.first_reply_at is null and s.created_at < now() - make_interval(secs => od * 3600)))) end,
    'mine', case when hq_can('support.view') then (select count(*) from support_tickets where status in ('new', 'investigating', 'waiting_us') and assignee = auth.uid()) end,
    'updates_overdue', case when hq_can('support.view') then (select count(*) from support_tickets where status <> 'done' and next_update_due < now()) end,
    'approvals', case when hq_can('offers.approve') or hq_can('refunds.approve') then
        (select count(*) from offers where status = 'waiting') + (select count(*) from refund_requests
          where status in ('approved', 'partly_approved') and needs_second and second_approver is null) end,
    'refunds_waiting', case when hq_can('refunds.view') then (select count(*) from refund_requests where status in ('submitted', 'reviewing')) end,
    'emails_failed', case when hq_can('emails.view') then (select count(*) from email_outbox where status in ('failed', 'held')) end,
    'trials_3d', case when hq_can('customers.view') then (select coalesce(json_agg(x order by x.days_left, x.name), '[]') from (
        select w.id, w.name, w.company_code, min(z.te) - current_date as days_left, array_agg(mm.m order by mm.m) as modules
        from workspaces w cross join unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) mm(m)
        left join company_modules c on c.workspace_id = w.id and c.module = mm.m
        cross join lateral (select coalesce(c.trial_ends, w.created_at::date + 90) as te) z
        where w.status = 'active' and (c.module is null or c.status = 'trial') and z.te between current_date and current_date + 3
          and not exists (select 1 from company_modules p where p.workspace_id = w.id and p.status = 'active' and (p.paid_until is null or p.paid_until >= current_date))
        group by w.id, w.name, w.company_code limit 50) x) end,
    'follow_ups', case when hq_can('customers.view') or hq_can('customers.notes') then hq_my_follow_ups() end);
end $$;

-- ---------------------------------------------------------------- the Riyeser account owner, handover notes, the work queue, sign-ups
-- Each business can have one Riyeser staff member who looks after it ("Owner" on the customer page; "My customers").
alter table public.workspaces add column if not exists hq_owner uuid references auth.users(id) on delete set null;
create index if not exists workspaces_hq_owner on public.workspaces (hq_owner);
create or replace function public.hq_set_owner(ws uuid, staff uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare was uuid;
begin
  perform hq_need(array['customers.edit', 'support.assign', 'licences.manage']);
  select hq_owner into was from workspaces where id = ws;
  if not found then raise exception 'That business doesn''t exist.'; end if;
  if staff is not null and not exists (select 1 from hq_staff s where s.user_id = staff and s.active) then raise exception 'Choose someone on the HQ team.'; end if;
  update workspaces set hq_owner = staff where id = ws;
  perform hq_log('customer.owner_set', jsonb_build_object('workspace_id', ws, 'was', staff_name(was), 'now', staff_name(staff)));
end $$;

-- Team handover: notes for the next shift (who wrote it, for which day, done or not). Never deleted.
create table if not exists public.hq_handover_notes (
  id bigint generated always as identity primary key,
  author uuid references auth.users(id) on delete set null,
  note text not null check (length(trim(note)) between 1 and 1000),
  shift_date date not null default current_date,
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists hq_handover_open on public.hq_handover_notes (done, shift_date desc);
alter table public.hq_handover_notes enable row level security;
revoke all on public.hq_handover_notes from anon, authenticated;
drop trigger if exists no_delete on public.hq_handover_notes;
create trigger no_delete before delete on public.hq_handover_notes for each row execute function public.no_delete();
create or replace function public.hq_handover() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['overview.view']);
  return (select coalesce(json_agg(json_build_object('id', h.id, 'note', h.note, 'shift_date', h.shift_date, 'done', h.done, 'by', staff_name(h.author),
      'author', h.author, 'at', h.created_at, 'done_by', staff_name(h.done_by)) order by h.done, h.shift_date desc, h.id desc), '[]')
    from (select * from hq_handover_notes where not done or shift_date >= current_date - 1 order by shift_date desc, id desc limit 50) h);
end $$;
create or replace function public.hq_handover_add(note text, shift_day date) returns bigint
  language plpgsql security definer set search_path = public as $$
declare i bigint;
begin
  perform hq_need(array['overview.view']);
  if length(trim(coalesce(note, ''))) = 0 then raise exception 'Write the handover note first.'; end if;
  insert into hq_handover_notes (author, note, shift_date) values (auth.uid(), left(trim(note), 1000), coalesce(shift_day, current_date)) returning id into i;
  perform hq_log('handover.added', jsonb_build_object('handover', i, 'shift_date', coalesce(shift_day, current_date)));
  return i;
end $$;
create or replace function public.hq_handover_done(note_id bigint) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['overview.view']);
  update hq_handover_notes set done = true, done_at = now(), done_by = auth.uid() where id = note_id and not done;
  if not found then raise exception 'That handover note is already done.'; end if;
  perform hq_log('handover.done', jsonb_build_object('handover', note_id));
end $$;

-- The earliest open follow-up for a business (the "next promised follow-up").
create or replace function public.next_follow_up(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', n.id, 'date', n.follow_up, 'body', left(n.body, 200), 'by', public.staff_name(n.author), 'kind', n.kind)
  from hq_notes n where n.workspace_id = ws and n.follow_up is not null and n.follow_up_done_at is null order by n.follow_up, n.id limit 1
$$;

-- The Operations overview: counts and one work queue (customer, issue, owner, next action), for whoever is signed in.
create or replace function public.hq_work_queue() returns json
  language plpgsql stable security definer set search_path = public as $$
declare od numeric := hq_setting_num('support.overdue_hours', 24); r json;
begin
  perform hq_need(array['overview.view']);
  with ending as (
    select w.id, min(z.te) as ends, bool_or(z.paid) as paid, array_agg(distinct mm.m) as modules
    from workspaces w cross join unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) mm(m)
    left join company_modules c on c.workspace_id = w.id and c.module = mm.m
    cross join lateral (select case when c.status = 'active' then c.paid_until else coalesce(c.trial_ends, w.created_at::date + 90) end as te,
                               coalesce(c.status = 'active', false) as paid) z
    where w.status = 'active' and (c.module is null or c.status in ('trial', 'active')) and z.te between current_date and current_date + 7
    group by w.id
  ), q as (
    select * from (
      select 1 as prio, 'update' as kind, t.workspace_id as ws, 'Update overdue' as issue,
        t.ref || ' · ' || t.subject || ' · was due ' || to_char(t.next_update_due at time zone 'UTC', 'FMDD Mon FMHH12:MI am') || ' UTC' as detail,
        coalesce(public.staff_name(t.next_update_owner), public.staff_name(t.assignee), 'Unassigned') as owner, 'Update' as action, t.id::text as ref, t.next_update_due as at
      from support_tickets t where hq_can('support.view') and t.status <> 'done' and t.next_update_due < now()
      union all
      select 1 as prio, 'complaint' as kind, t.workspace_id as ws, case when t.first_reply_at is null and t.created_at < now() - make_interval(secs => od * 3600)
          then 'Overdue complaint' else 'Open complaint' end as issue, t.subject as detail, coalesce(public.staff_name(t.assignee), 'Unassigned') as owner,
        'Reply' as action, t.id::text as ref, t.created_at as at
      from support_tickets t where hq_can('support.view') and t.status in ('new', 'investigating', 'waiting_us') and (t.assignee is null or t.assignee = auth.uid()
        or (t.first_reply_at is null and t.created_at < now() - make_interval(secs => od * 3600)))
      union all
      select 2, 'approval', o.workspace_id, 'Approval needed', o.days || ' free days · ' || array_to_string(array(select public.module_label(x) from unnest(o.modules) x), ', '),
        coalesce(public.staff_name(o.requested_by), 'Riyeser'), 'Approve', o.id::text, o.created_at
      from offers o where o.status = 'waiting' and hq_can('offers.approve')
      union all
      select 3, 'refund', f.workspace_id, 'Refund waiting', f.currency || ' ' || f.amount || ' · ' || f.for_what, coalesce(public.staff_name(f.decided_by), 'Finance'), 'Review', f.id::text, f.created_at
      from refund_requests f where f.status in ('submitted', 'reviewing') and hq_can('refunds.approve')
      union all
      select 4, 'follow_up', n.workspace_id, 'Follow-up due', left(n.body, 120), coalesce(public.staff_name(n.author), 'Riyeser'), 'Follow up', n.id::text, n.follow_up::timestamptz
      from hq_notes n where n.author = auth.uid() and n.follow_up <= current_date and n.follow_up_done_at is null
      union all
      select 5, 'renewal', e.id, case when e.paid then 'Renewal due' else 'Trial ending' end,
        case when e.ends = current_date then 'Ends today' else 'Ends in ' || (e.ends - current_date) || ' day' || case when e.ends - current_date = 1 then '' else 's' end end
          || ' · ' || array_to_string(array(select public.module_label(x) from unnest(e.modules) x), ', '),
        null, 'Extend', null, e.ends::timestamptz
      from ending e where hq_can('customers.view')
      union all
      select 6, 'signup', w.id, 'Stuck signup', 'Signed up ' || (current_date - w.created_at::date) || ' days ago, no PC linked yet', null, 'Message', null, w.created_at
      from workspaces w where hq_can('customers.view') and w.status = 'active' and w.created_at between now() - interval '30 days' and now() - interval '3 days'
        and not exists (select 1 from devices d where d.workspace_id = w.id)
    ) x order by prio, at limit 60
  )
  select json_build_object(
    'counts', json_build_object(
      'new_signups', (select count(*) from workspaces where created_at >= date_trunc('week', now())),
      'failed_payments', null,
      'renewals_due', (select count(*) from ending),
      'open_complaints', case when hq_can('support.view') then (select count(*) from support_tickets where status <> 'done') end),
    'queue', (select coalesce(json_agg(json_build_object('kind', q.kind, 'workspace_id', q.ws, 'business', w.name, 'country', w.country, 'address', w.address,
        'issue', q.issue, 'detail', q.detail, 'owner', coalesce(q.owner, public.staff_name(w.hq_owner), 'Unassigned'), 'action', q.action, 'ref', q.ref, 'at', q.at) order by q.prio, q.at), '[]')
      from q left join workspaces w on w.id = q.ws)) into r;
  return r;
end $$;

-- Sign-ups and onboarding: each recent business, its stages and what's blocking go-live. Only what HQ can see:
-- anything the programs don't report yet is "unknown", never guessed.
create or replace function public.hq_signups(days int) returns json
  language plpgsql stable security definer set search_path = public as $$
declare d int := least(greatest(coalesce(days, 30), 1), 365);
begin
  perform hq_need(array['customers.view']);
  return (select coalesce(json_agg(x order by x.created_at desc), '[]') from (
    select w.id, w.name, w.company_code, w.country, w.kind, w.created_at, w.status, public.staff_name(w.hq_owner) as hq_owner_name,
      o.display_name as owner_name, u.email::text as owner_email, u.email_confirmed_at is not null as email_verified,
      exists (select 1 from unnest(array['basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls']) mm(m)
              where (public.module_state(w.id, mm.m) ->> 'status') in ('trial', 'active')) as on_trial,
      exists (select 1 from devices dv where dv.workspace_id = w.id) as pc_linked,
      exists (select 1 from devices dv where dv.workspace_id = w.id and dv.programs_at is not null
              and exists (select 1 from jsonb_array_elements(dv.programs) p where p ->> 'id' <> 'central')) as program_used,
      exists (select 1 from company_modules c where c.workspace_id = w.id and c.status = 'active') as paying,
      (select coalesce(jsonb_agg(distinct p ->> 'id'), '[]') from devices dv, jsonb_array_elements(coalesce(dv.programs, '[]')) p where dv.workspace_id = w.id) as installed,
      (select count(*) from members m where m.workspace_id = w.id) as people,
      public.next_follow_up(w.id) as next_follow_up
    from workspaces w
    left join lateral (select m.user_id, m.display_name from members m where m.workspace_id = w.id and m.role = 'owner' order by m.joined_at limit 1) o on true
    left join auth.users u on u.id = o.user_id
    where w.created_at > now() - make_interval(days => d)
    order by w.created_at desc limit 300) x);
end $$;

-- ---------------------------------------------------------------- who can call what
revoke all on function public.report_programs(uuid, uuid, jsonb), public.signup_json(jsonb), public.hq_person(uuid, uuid), public.hq_note_json(hq_notes),
  public.hq_timeline(uuid), public.hq_can(text, text), public.hq_company_page(uuid), public.hq_message_customer(uuid, uuid, text, text, text),
  public.hq_note_add(uuid, text, text, text, text, date, boolean), public.hq_note_pin(bigint, boolean), public.hq_follow_up_done(bigint),
  public.hq_my_follow_ups(), public.hq_quick_licence(uuid, text, text, int, date, text, text, text),
  public.hq_companies_page(text, jsonb, text, boolean, int, int, boolean), public.hq_reports(date, date), public.hq_attention(),
  public.company_modules_paid_since(), public.hq_notes_removing(),
  public.hq_set_owner(uuid, uuid), public.hq_handover(), public.hq_handover_add(text, date), public.hq_handover_done(bigint), public.next_follow_up(uuid),
  public.hq_work_queue(), public.hq_signups(int)
  from public, anon, authenticated;
grant execute on function public.report_programs(uuid, uuid, jsonb), public.my_tickets(), public.my_ticket(uuid) to authenticated;
grant execute on function public.hq_company_page(uuid), public.hq_message_customer(uuid, uuid, text, text, text),
  public.hq_note_add(uuid, text, text, text, text, date, boolean), public.hq_note_pin(bigint, boolean), public.hq_follow_up_done(bigint),
  public.hq_my_follow_ups(), public.hq_quick_licence(uuid, text, text, int, date, text, text, text),
  public.hq_companies_page(text, jsonb, text, boolean, int, int, boolean), public.hq_reports(date, date), public.hq_attention(),
  public.hq_set_owner(uuid, uuid), public.hq_handover(), public.hq_handover_add(text, date), public.hq_handover_done(bigint),
  public.hq_work_queue(), public.hq_signups(int) to authenticated;

-- ===== Support workspace: Report an issue, the customer's Reply / Still having an issue / Confirm fixed, the HQ workspace =====
-- (The new columns and the support_diagnostics table are with the support tables above.) Customers' functions only
-- work on their own business's tickets (can_see_ticket); HQ's check a permission with hq_need and are written to hq_audit.
-- Diagnostic reports are technical only, and HQ reads them with the support.diagnostics permission.
create or replace function public.support_diag_json(d support_diagnostics) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', d.id, 'ref', d.ref, 'source', d.source, 'product', d.product, 'product_version', d.product_version,
    'error_text', d.error_text, 'os', d.os, 'central_version', d.central_version, 'programs', d.programs, 'log_lines', d.log_lines,
    'log_source', d.log_source, 'line_count', coalesce(array_length(regexp_split_to_array(d.log_lines, E'\n'), 1), 0),
    'reported_at', d.reported_at, 'created_at', d.created_at)
$$;

-- Report an issue (Riyeser Central, or riyeser.com's Help): one diagnostic report and one ticket. payload:
-- {product, what_happened, blocked, subject?, product_version?, error_text?, os?, central_version?, programs?, log_lines?,
--  log_source?, reported_at?, source: 'central'|'web', diag_ref?: 'DG-4821' (a report already made in Central)}
create or replace function public.support_report(ws uuid, payload jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p jsonb := coalesce(payload, '{}'::jsonb); prod text; what text; blocked boolean; d support_diagnostics;
        t support_tickets; dref text; subj text; ra timestamptz;
begin
  if uid is null then raise exception 'Sign in with your Riyeser account first.'; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Something went wrong with that report. Please try again.'; end if;
  if ws is null or not exists (select 1 from members where workspace_id = ws and user_id = uid) then raise exception 'You''re not in that business'; end if;
  prod := coalesce(nullif(p ->> 'product', ''), 'other');
  if not (prod = any(support_products())) then prod := 'other'; end if;
  what := trim(coalesce(p ->> 'what_happened', ''));
  if length(what) = 0 then raise exception 'Say what happened, then send it again.'; end if;
  blocked := lower(coalesce(p ->> 'blocked', '')) in ('true', 'yes', '1');
  if (select count(*) from support_tickets where opened_by = uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You''ve sent a lot of help requests today. Reply to one of them instead and we''ll pick it up.'; end if;
  dref := upper(trim(coalesce(p ->> 'diag_ref', '')));
  if dref <> '' then
    if dref !~ '^DG-[0-9]{1,12}$' then raise exception 'That diagnostic reference doesn''t look right. It looks like DG-4821.'; end if;
    select * into d from support_diagnostics x where x.ref = dref and x.workspace_id = ws;
    if d.id is null then raise exception 'We couldn''t find diagnostic reference % for this business. Check it in Riyeser Central, or leave it empty.', dref; end if;
  else
    begin ra := (p ->> 'reported_at')::timestamptz; exception when others then ra := null; end;
    insert into support_diagnostics (workspace_id, created_by, source, product, product_version, error_text, os, central_version, programs,
        log_lines, log_source, reported_at)
      values (ws, uid, case when p ->> 'source' = 'central' then 'central' else 'web' end, prod, p ->> 'product_version', p ->> 'error_text',
        p ->> 'os', p ->> 'central_version', coalesce(p -> 'programs', '[]'::jsonb), p ->> 'log_lines', p ->> 'log_source', ra)
      returning * into d;
  end if;
  subj := left(coalesce(nullif(trim(p ->> 'subject'), ''), product_label(prod) || ': ' || split_part(what, E'\n', 1)), 150);
  insert into support_tickets (workspace_id, opened_by, topic, subject, status, last_customer_at, product, diag_id, work_blocked, priority)
    values (ws, uid, 'program', subj, 'new', now(), prod, d.id, blocked, case when blocked then 'high' else 'normal' end) returning * into t;
  insert into support_messages (ticket_id, author, body) values (t.id, uid, left(what, 4800) || E'\n\n' || 'Work blocked: '
    || case when blocked then 'Yes' else 'No' end || E'\n' || 'Diagnostic reference: ' || d.ref);
  insert into support_reads (ticket_id, user_id) values (t.id, uid) on conflict do nothing;
  perform queue_email(uid, null, 'ticket_received', 'We''ve got your report (' || t.ref || ')',
    'Hi,' || E'\n\n' || 'Thanks for reporting this. Your request number is ' || t.ref || ' (diagnostic reference ' || d.ref || ').' || E'\n\n'
    || 'We''ll reply by email and on your Riyeser home page:' || E'\n' || 'https://riyeser.com/link/?help#' || t.ref, ws, t.id, null);
  insert into audit_log (workspace_id, action, details, actor)
    values (ws, 'support.reported', jsonb_build_object('ticket', t.ref, 'diagnostic', d.ref, 'product', prod, 'blocked', blocked), uid);
  return json_build_object('id', t.id, 'ref', t.ref, 'diag_ref', d.ref, 'diag_id', d.id);
end $$;

-- The customer, on one of their business's tickets: "Still having an issue" (back to the owner's queue: Riyeser to act)
create or replace function public.ticket_still_issue(ticket uuid, message text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; m text := trim(coalesce(message, ''));
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  select * into t from support_tickets where id = ticket;
  insert into support_messages (ticket_id, author, body)
    values (ticket, auth.uid(), left('Still having an issue.' || case when m <> '' then E'\n\n' || m else '' end, 5000));
  update support_tickets set status = 'waiting_us', resolved_at = null, last_customer_at = now(), updated_at = now() where id = ticket;
  insert into support_reads (ticket_id, user_id) values (ticket, auth.uid()) on conflict (ticket_id, user_id) do update set read_at = now();
  if t.workspace_id is not null then
    insert into audit_log (workspace_id, action, details, actor) values (t.workspace_id, 'support.reopened', jsonb_build_object('ticket', t.ref), auth.uid());
  end if;
end $$;
-- "Confirm fixed": resolved.
create or replace function public.ticket_confirm_fixed(ticket uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  select * into t from support_tickets where id = ticket;
  if t.status = 'done' then return; end if;
  insert into support_messages (ticket_id, author, body) values (ticket, auth.uid(), 'Confirmed fixed. Thanks!');
  update support_tickets set status = 'done', resolved_at = now(), last_customer_at = now(), updated_at = now() where id = ticket;
  insert into support_reads (ticket_id, user_id) values (ticket, auth.uid()) on conflict (ticket_id, user_id) do update set read_at = now();
  if t.workspace_id is not null then
    insert into audit_log (workspace_id, action, details, actor) values (t.workspace_id, 'support.fixed', jsonb_build_object('ticket', t.ref), auth.uid());
  end if;
end $$;
-- "How did we do?": 1 to 5, only once it's resolved.
create or replace function public.ticket_rate(ticket uuid, stars int, comment text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  if not can_see_ticket(ticket) then raise exception 'We couldn''t find that help request.'; end if;
  select * into t from support_tickets where id = ticket;
  if t.status <> 'done' then raise exception 'You can rate this once it''s resolved.'; end if;
  if stars is null or stars not between 1 and 5 then raise exception 'Choose 1 to 5 stars.'; end if;
  update support_tickets set rating = stars, rating_comment = nullif(left(trim(coalesce(comment, '')), 1000), ''), rated_at = now() where id = ticket;
end $$;

-- ---------------------------------------------------------------- HQ: the Support workspace
-- The inbox: quick tabs (mine, waiting_customer, unassigned, overdue = first reply or promised update overdue, all) and
-- filters {product, owner ('me', 'none' or a staff id), status ('open' or a status), level, topic}. Counts follow the filters.
create or replace function public.hq_support_inbox(box text, search text, filters jsonb) returns json
  language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(search, '')), ''); od numeric := hq_setting_num('support.overdue_hours', 24); r json;
        f jsonb := coalesce(filters, '{}'::jsonb); fp text; fo text; fs text; fl int; ft text;
begin
  perform hq_need(array['support.view']);
  fp := nullif(f ->> 'product', ''); fo := nullif(f ->> 'owner', ''); fs := nullif(f ->> 'status', ''); ft := nullif(f ->> 'topic', '');
  fl := case when coalesce(f ->> 'level', '') ~ '^[123]$' then (f ->> 'level')::int end;
  with t as (
    select t.*, w.name as business, w.status as business_status,
      (t.overdue_at is not null or (t.first_reply_at is null and t.status <> 'done' and t.created_at < now() - make_interval(secs => od * 3600))) as is_overdue,
      (t.status <> 'done' and t.next_update_due is not null and t.next_update_due < now()) as is_update_overdue,
      exists (select 1 from support_escalations e where e.ticket_id = t.id) as was_escalated
    from support_tickets t left join workspaces w on w.id = t.workspace_id
    where (q is null or t.ref ilike '%' || q || '%' or t.subject ilike '%' || q || '%' or w.name ilike '%' || q || '%' or w.company_code ilike '%' || q || '%'
       or exists (select 1 from auth.users u where u.id = t.opened_by and u.email::text ilike '%' || q || '%')
       or exists (select 1 from support_diagnostics d where d.id = t.diag_id and d.ref ilike '%' || q || '%')
       or exists (select 1 from support_messages m where m.ticket_id = t.id and m.body ilike '%' || q || '%'))
  ), base as (
    select * from t where (fp is null or t.product = fp)
      and (fo is null or (fo = 'me' and t.assignee = auth.uid()) or (fo = 'none' and t.assignee is null) or t.assignee::text = fo)
      and (fs is null or (fs = 'open' and t.status <> 'done') or t.status = fs) and (fl is null or t.level = fl) and (ft is null or t.topic = ft)
  ), boxed as (
    select b.*, (case coalesce(box, 'open')
      when 'mine' then b.status <> 'done' and b.assignee = auth.uid() when 'waiting_customer' then b.status = 'waiting_customer'
      when 'unassigned' then b.status <> 'done' and b.assignee is null when 'overdue' then b.status <> 'done' and (b.is_overdue or b.is_update_overdue)
      when 'all' then true else b.status <> 'done' end) as inbox from base b)
  select json_build_object(
    'tickets', (select coalesce(json_agg(json_build_object('id', b.id, 'ref', b.ref, 'subject', b.subject, 'topic', b.topic, 'status', b.status,
        'priority', b.priority, 'level', b.level, 'assignee', b.assignee, 'assignee_name', staff_name(b.assignee),
        'workspace_id', b.workspace_id, 'business', b.business, 'business_status', b.business_status, 'staff_started', b.staff_started,
        'opened_by_name', (select display_name from members m where m.workspace_id = b.workspace_id and m.user_id = b.opened_by),
        'opened_by_email', (select email::text from auth.users u where u.id = b.opened_by),
        'created_at', b.created_at, 'first_reply_at', b.first_reply_at, 'updated_at', b.updated_at, 'last_customer_at', b.last_customer_at,
        'overdue', b.is_overdue, 'update_overdue', b.is_update_overdue, 'escalated', b.was_escalated, 'product', b.product, 'who_acts', b.who_acts,
        'work_blocked', b.work_blocked, 'next_update_due', b.next_update_due, 'next_update_owner', b.next_update_owner,
        'next_update_owner_name', staff_name(b.next_update_owner)) order by b.is_update_overdue desc, b.updated_at desc), '[]')
      from (select * from boxed where inbox order by is_update_overdue desc, updated_at desc limit 300) b),
    'counts', (select json_build_object('mine', count(*) filter (where status <> 'done' and assignee = auth.uid()),
        'waiting_customer', count(*) filter (where status = 'waiting_customer'), 'unassigned', count(*) filter (where status <> 'done' and assignee is null),
        'overdue', count(*) filter (where status <> 'done' and (is_overdue or is_update_overdue)), 'all', count(*),
        'open', count(*) filter (where status <> 'done')) from base),
    'staff', (select coalesce(json_agg(json_build_object('user_id', s.user_id, 'name', s.display_name) order by s.display_name), '[]') from hq_staff s where s.active),
    'overdue_hours', od) into r;
  return r;
end $$;

-- Product, planned release and the linked bug (free text and an optional https link, e.g. a GitHub issue).
create or replace function public.hq_ticket_set(ticket uuid, fields jsonb) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; f jsonb := coalesce(fields, '{}'::jsonb); v text; k text;
begin
  perform hq_need(array['support.reply']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if not hq_can_work(t.level) then raise exception 'This ticket is with % (level %).', level_name(t.level), t.level; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('product', 'planned_release', 'bug_ref', 'bug_url') then raise exception 'That can''t be changed here.'; end if;
  end loop;
  if f ? 'product' then
    v := nullif(trim(coalesce(f ->> 'product', '')), '');
    if v is not null and not (v = any(support_products())) then raise exception 'Choose a product.'; end if;
    update support_tickets set product = v where id = ticket;
  end if;
  if f ? 'planned_release' then update support_tickets set planned_release = nullif(left(trim(coalesce(f ->> 'planned_release', '')), 80), '') where id = ticket; end if;
  if f ? 'bug_ref' then update support_tickets set bug_ref = nullif(left(trim(coalesce(f ->> 'bug_ref', '')), 80), '') where id = ticket; end if;
  if f ? 'bug_url' then
    v := nullif(trim(coalesce(f ->> 'bug_url', '')), '');
    if v is not null and (v !~ '^https://[^[:space:]]{3,}$' or length(v) > 300) then raise exception 'The bug link must start with https://'; end if;
    update support_tickets set bug_url = v where id = ticket;
  end if;
  update support_tickets set updated_at = now() where id = ticket;
  perform hq_log('ticket.updated', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id,
    'fields', (select jsonb_agg(x) from jsonb_object_keys(f) x), 'product', f ->> 'product', 'planned_release', f ->> 'planned_release', 'bug_ref', f ->> 'bug_ref'));
end $$;
-- The next update promised to the customer: when, and who'll send it (null clears it).
create or replace function public.hq_ticket_next_update(ticket uuid, due timestamptz, owner uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; who uuid := coalesce(owner, auth.uid());
begin
  perform hq_need(array['support.reply']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if not hq_can_work(t.level) then raise exception 'This ticket is with % (level %).', level_name(t.level), t.level; end if;
  if due is null then
    update support_tickets set next_update_due = null, next_update_owner = null, update_reminded_at = null, updated_at = now() where id = ticket;
    perform hq_log('ticket.next_update', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'due', null));
    return;
  end if;
  if due < now() - interval '5 minutes' then raise exception 'Choose a time from now on.'; end if;
  if due > now() + interval '90 days' then raise exception 'Choose a time in the next 90 days.'; end if;
  if not exists (select 1 from hq_staff s where s.user_id = who and s.active) then raise exception 'Choose someone on the HQ team.'; end if;
  update support_tickets set next_update_due = due, next_update_owner = who, update_reminded_at = null, updated_at = now() where id = ticket;
  perform hq_log('ticket.next_update', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'due', due, 'owner', staff_name(who)));
end $$;
-- A phone call about this ticket, in its thread (staff only).
create or replace function public.hq_ticket_log_call(ticket uuid, direction text, call_with text, body text) returns void
  language plpgsql security definer set search_path = public as $$
declare t support_tickets;
begin
  perform hq_need(array['support.reply']);
  select * into t from support_tickets where id = ticket;
  if t.id is null then raise exception 'That ticket doesn''t exist.'; end if;
  if not hq_can_work(t.level) then raise exception 'This ticket is with % (level %).', level_name(t.level), t.level; end if;
  if coalesce(direction, '') not in ('in', 'out') then raise exception 'Choose whether they called us or we called them.'; end if;
  if length(trim(coalesce(body, ''))) = 0 then raise exception 'Write what the call was about first.'; end if;
  insert into support_messages (ticket_id, author, is_staff, internal, body, kind, call_direction, call_with)
    values (ticket, auth.uid(), true, true, left(trim(body), 5000), 'call', direction, nullif(left(trim(coalesce(call_with, '')), 120), ''));
  update support_tickets set updated_at = now() where id = ticket;
  perform hq_log('ticket.call', jsonb_build_object('ticket', t.ref, 'workspace_id', t.workspace_id, 'direction', direction));
end $$;
-- Diagnostic lookup by reference (DG-4821), for staff with support.diagnostics.
create or replace function public.hq_diagnostic(diag_ref text) returns json
  language plpgsql security definer set search_path = public as $$
declare d support_diagnostics; r json;
begin
  perform hq_need(array['support.diagnostics']);
  select * into d from support_diagnostics where ref = upper(trim(coalesce(diag_ref, '')));
  if d.id is null then raise exception 'There''s no diagnostic report %.', upper(trim(coalesce(diag_ref, ''))); end if;
  select json_build_object('diagnostic', support_diag_json(d),
    'business', (select json_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code) from workspaces w where w.id = d.workspace_id),
    'tickets', case when hq_can('support.view') then (select coalesce(json_agg(json_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject, 'status', t.status)
        order by t.created_at desc), '[]') from support_tickets t where t.diag_id = d.id) end) into r;
  perform hq_log('diagnostic.viewed', jsonb_build_object('workspace_id', d.workspace_id, 'diagnostic', d.ref));
  return r;
end $$;
-- Customer support notes are the business's pinned notes; staff can correct one.
create or replace function public.hq_note_edit(note_id bigint, note_body text) returns void
  language plpgsql security definer set search_path = public as $$
declare n hq_notes;
begin
  perform hq_need(array['customers.notes']);
  if length(trim(coalesce(note_body, ''))) = 0 then raise exception 'Write the note first.'; end if;
  update hq_notes set body = left(trim(note_body), 2000) where id = note_id returning * into n;
  if n.id is null then raise exception 'That note doesn''t exist.'; end if;
  perform hq_log('note.edited', jsonb_build_object('workspace_id', n.workspace_id, 'note', n.id));
end $$;

revoke all on function public.support_scrub(text), public.support_products(), public.product_label(text), public.support_diagnostics_clean(),
  public.support_diag_json(support_diagnostics), public.support_report(uuid, jsonb), public.ticket_still_issue(uuid, text),
  public.ticket_confirm_fixed(uuid), public.ticket_rate(uuid, int, text), public.hq_support_inbox(text, text, jsonb),
  public.hq_ticket_set(uuid, jsonb), public.hq_ticket_next_update(uuid, timestamptz, uuid), public.hq_ticket_log_call(uuid, text, text, text),
  public.hq_diagnostic(text), public.hq_note_edit(bigint, text)
  from public, anon, authenticated;
-- (support_products and support_scrub are used by the table's rules, so everyone may run those two)
grant execute on function public.support_products(), public.support_scrub(text) to anon, authenticated;
grant execute on function public.support_report(uuid, jsonb), public.ticket_still_issue(uuid, text), public.ticket_confirm_fixed(uuid),
  public.ticket_rate(uuid, int, text) to authenticated;
grant execute on function public.hq_support_inbox(text, text, jsonb), public.hq_ticket_set(uuid, jsonb), public.hq_ticket_next_update(uuid, timestamptz, uuid),
  public.hq_ticket_log_call(uuid, text, text, text), public.hq_diagnostic(text), public.hq_note_edit(bigint, text) to authenticated;

-- ===== Riyeser Link: workspace (presence, reactions, themes) =====
-- The Riyeser Link workspace (phase 1): who's available, emoji reactions, pinned chats, and files in chats.
-- Themes and accent colours are kept with each person's account (riyeser_prefs in their sign-in details), not here.
-- Everything here only ever shows to people in the same business; files and reactions only to the people in that chat.
-- Riyeser HQ has no way in to any of it. Nothing is ever deleted by this section. Safe to re-run.

-- ---------------------------------------------------------------- presence: Available, Busy, Away, Do not disturb, Offline
-- One row per person per business. The app writes it through link_presence_set (at most about once a minute, and when
-- something changes); "fresh" means a Riyeser Link window wrote it in the last 3 minutes, otherwise the person shows Offline.
create table if not exists public.presence (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'available' check (status in ('available', 'busy', 'away', 'dnd', 'offline')),
  manual text check (manual in ('available', 'busy', 'away', 'dnd', 'offline')),   -- what they chose; null = automatic
  custom_text text check (length(custom_text) <= 80),
  on_call boolean not null default false,
  away_since timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table public.presence enable row level security;
drop policy if exists pr_read on public.presence;
create policy pr_read on public.presence for select to authenticated using (public.is_member(workspace_id));
grant select on public.presence to authenticated;
revoke insert, update, delete on public.presence from authenticated;
revoke all on public.presence from anon;

-- My status in this business. Only for me, only in a business I'm in. Plain text only for the custom status.
create or replace function public.link_presence_set(ws uuid, st text, manual_choice text, custom text, on_a_call boolean)
  returns void language plpgsql security definer set search_path = public as $$
declare t text := nullif(trim(coalesce(custom, '')), '');
begin
  if auth.uid() is null or not is_member(ws) then raise exception 'You''re not in that company.'; end if;
  if st is null or st not in ('available', 'busy', 'away', 'dnd', 'offline') then raise exception 'Choose Available, Busy, Away, Do not disturb or Offline.'; end if;
  if manual_choice is not null and manual_choice not in ('available', 'busy', 'away', 'dnd', 'offline') then raise exception 'Choose Available, Busy, Away, Do not disturb or Offline.'; end if;
  if t is not null and (length(t) > 80 or t ~ '[<>]') then raise exception 'Keep your status short: up to 80 letters, no < or >.'; end if;
  insert into presence (workspace_id, user_id, status, manual, custom_text, on_call, away_since, updated_at)
    values (ws, auth.uid(), st, manual_choice, t, coalesce(on_a_call, false), case when st = 'away' then now() end, now())
  on conflict (workspace_id, user_id) do update set status = excluded.status, manual = excluded.manual, custom_text = excluded.custom_text,
    on_call = excluded.on_call, updated_at = now(),
    away_since = case when excluded.status <> 'away' then null else coalesce(presence.away_since, now()) end;
end $$;

-- Everyone's status in a business I'm in, with "fresh" worked out on the database's clock.
create or replace function public.link_presence(ws uuid) returns table (user_id uuid, status text, manual text, custom_text text, on_call boolean,
  away_since timestamptz, updated_at timestamptz, fresh boolean, now timestamptz)
  language sql stable security definer set search_path = public as $$
  select p.user_id, p.status, case when p.user_id = auth.uid() then p.manual end, p.custom_text, p.on_call, p.away_since, p.updated_at,
         p.status <> 'offline' and p.updated_at > now() - interval '3 minutes', now()
  from presence p join members m on m.workspace_id = p.workspace_id and m.user_id = p.user_id
  where p.workspace_id = ws and public.is_member(ws)
$$;
revoke all on function public.link_presence_set(uuid, text, text, text, boolean), public.link_presence(uuid) from public, anon;
grant execute on function public.link_presence_set(uuid, text, text, text, boolean), public.link_presence(uuid) to authenticated;

-- ---------------------------------------------------------------- reactions: 👍 ✅ ❤️ 😂 🎉 👀 on a message
-- Only people who can see the message can react, only as themselves, and only take back their own.
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '✅', '❤️', '😂', '🎉', '👀')),
  channel_id uuid not null references public.channels(id) on delete cascade,     -- filled in from the message
  workspace_id uuid not null references public.workspaces(id) on delete cascade, -- filled in from the message
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_channel on public.message_reactions (channel_id);
-- The chat and business always come from the message itself (as the person reacting can see it), never from the app.
create or replace function public.message_reactions_fill() returns trigger language plpgsql as $$
begin
  select m.channel_id, m.workspace_id into new.channel_id, new.workspace_id from public.messages m where m.id = new.message_id and not m.deleted;
  if new.channel_id is null then raise exception 'That message isn''t there any more.'; end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists message_reactions_fill on public.message_reactions;
create trigger message_reactions_fill before insert on public.message_reactions for each row execute function public.message_reactions_fill();
alter table public.message_reactions enable row level security;
drop policy if exists rx_read on public.message_reactions;
create policy rx_read on public.message_reactions for select to authenticated using (public.can_see_channel(channel_id));
drop policy if exists rx_add on public.message_reactions;
create policy rx_add on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_channel(channel_id));
drop policy if exists rx_remove on public.message_reactions;
create policy rx_remove on public.message_reactions for delete to authenticated using (user_id = auth.uid());
grant select, insert, delete on public.message_reactions to authenticated;
revoke update on public.message_reactions from authenticated;
revoke all on public.message_reactions from anon;

-- ---------------------------------------------------------------- pinned chats: each person's own
create table if not exists public.channel_pins (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);
alter table public.channel_pins enable row level security;
drop policy if exists pin_own on public.channel_pins;
create policy pin_own on public.channel_pins for select to authenticated using (user_id = auth.uid());
drop policy if exists pin_add on public.channel_pins;
create policy pin_add on public.channel_pins for insert to authenticated with check (user_id = auth.uid() and public.can_see_channel(channel_id));
drop policy if exists pin_remove on public.channel_pins;
create policy pin_remove on public.channel_pins for delete to authenticated using (user_id = auth.uid());
grant select, insert, delete on public.channel_pins to authenticated;
revoke update on public.channel_pins from authenticated;
revoke all on public.channel_pins from anon;

-- ---------------------------------------------------------------- calls: "on hold" is passed to the other person
alter table public.call_signals drop constraint if exists call_signals_kind_check;
alter table public.call_signals add constraint call_signals_kind_check
  check (kind in ('ring', 'accept', 'decline', 'cancel', 'taken', 'offer', 'answer', 'ice', 'hangup', 'busy', 'hold'));

-- ---------------------------------------------------------------- files in chats (Supabase Storage, private bucket link-files)
-- A file lives at <business id>/<chat id>/<random>/<file name>. Only the people who can see that chat can upload to it or
-- download from it, through short-lived links. Up to 25 MB each. Files can't be changed or removed from the app.
-- A message lists its files in messages.files; each must be in that message's own chat.
alter table public.messages add column if not exists files jsonb;
do $$ begin
  alter table public.messages add constraint messages_files_shape check (files is null or (jsonb_typeof(files) = 'array'
    and jsonb_array_length(files) between 1 and 10 and length(files::text) < 6000));
exception when duplicate_object then null; end $$;

-- The chat a file belongs to, from its path (null when the path isn't one of ours). Internal.
create or replace function public.link_file_channel(path text) returns uuid
  language sql immutable set search_path = public as $$
  select case when path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9A-Za-z-]{8,40}/[^/]{1,120}$' then split_part(path, '/', 2)::uuid end
$$;
-- Can I use this file path: a chat I can see, in the business the path names?
create or replace function public.link_file_ok(path text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select c.workspace_id::text = split_part(path, '/', 1) and public.can_see_channel(c.id)
                   from channels c where c.id = public.link_file_channel(path)), false)
$$;
revoke all on function public.link_file_ok(text) from public, anon;
grant execute on function public.link_file_ok(text), public.link_file_channel(text) to authenticated;

create or replace function public.messages_files_guard() returns trigger language plpgsql as $$
declare f jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.files is distinct from old.files then raise exception 'Files can''t be changed after they''re sent.'; end if;
    return new;
  end if;
  if new.files is null then return new; end if;
  for f in select * from jsonb_array_elements(new.files) loop
    if jsonb_typeof(f) <> 'object' or coalesce(f ->> 'path', '') not like new.workspace_id::text || '/' || new.channel_id::text || '/%'
       or public.link_file_channel(f ->> 'path') is null or length(coalesce(f ->> 'name', '')) not between 1 and 120
       or coalesce((f ->> 'size')::bigint, 0) not between 1 and 26214400 then
      raise exception 'That file isn''t in this chat.';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists messages_files_guard on public.messages;
create trigger messages_files_guard before insert or update on public.messages for each row execute function public.messages_files_guard();

-- ---------------------------------------------------------------- file storage for each business (Riyeser Link files)
-- 2 GB per business on free chat, 20 GB with Riyeser Link Plus (trial or paid), plus any extra HQ grants (extra_storage_gb).
-- An upload that would take the business over is refused (link_files_add below). Nothing is ever deleted automatically.
alter table public.workspaces add column if not exists extra_storage_gb int not null default 0;
do $$ begin
  alter table public.workspaces add constraint workspaces_extra_storage_gb check (extra_storage_gb between 0 and 10000);
exception when duplicate_object then null; end $$;

-- Bytes of Riyeser Link files the business has stored (people in it, and HQ staff).
create or replace function public.link_storage_used(ws uuid) returns bigint
  language plpgsql stable security definer set search_path = public as $$
declare n bigint := 0;
begin
  if ws is null or not (public.is_member(ws) or public.hq_can('customers.view') or public.hq_can('licences.view')) then
    raise exception 'You''re not in that company';
  end if;
  if to_regclass('storage.objects') is not null then   -- only where Supabase Storage is there
    execute 'select coalesce(sum(case when (metadata ->> ''size'') ~ ''^[0-9]{1,15}$'' then (metadata ->> ''size'')::bigint else 0 end), 0)
             from storage.objects where bucket_id = ''link-files'' and name like $1' into n using ws::text || '/%';
  end if;
  return n;
end $$;
-- The business's limit in bytes: 2 GB, or 20 GB while Riyeser Link Plus is on, plus extra granted by HQ.
create or replace function public.link_storage_limit(ws uuid) returns bigint
  language sql stable security definer set search_path = public as $$
  select ((case when public.calls_allowed(ws) then 20 else 2 end) + coalesce((select extra_storage_gb from workspaces where id = ws), 0))::bigint * 1073741824
$$;
-- Is there room for a file of this many bytes? (anyone in the business; the app asks before it uploads)
create or replace function public.link_storage_fits(ws uuid, size bigint) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.link_storage_used(ws) + greatest(coalesce(size, 0), 0) <= public.link_storage_limit(ws)
$$;
-- The same for the upload rule, from the file's path and Storage's metadata (size in bytes). Internal.
create or replace function public.link_storage_fits_path(path text, meta jsonb) returns boolean
  language plpgsql stable security definer set search_path = public as $$
begin
  if public.link_file_channel(path) is null or not public.is_member(split_part(path, '/', 1)::uuid) then return false; end if;
  return public.link_storage_fits(split_part(path, '/', 1)::uuid,
    case when (meta ->> 'size') ~ '^[0-9]{1,15}$' then (meta ->> 'size')::bigint else 0 end);
end $$;
-- What the app and HQ show: "1.2 GB of 2 GB used" (owners and admins of the business, and HQ).
create or replace function public.link_storage_json(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare u bigint; l bigint;
begin
  if not (public.is_admin(ws) or public.hq_can('customers.view') or public.hq_can('licences.view')) then
    raise exception 'Only owners and admins can see this.';
  end if;
  u := public.link_storage_used(ws); l := public.link_storage_limit(ws);
  return json_build_object('used', u, 'limit', l, 'pct', case when l > 0 then round(u * 100.0 / l, 1) else 0 end,
    'plus', public.calls_allowed(ws), 'extra_gb', (select extra_storage_gb from workspaces where id = ws));
end $$;
-- Percent of the limit used, for HQ's Companies list (HQ only).
create or replace function public.link_storage_pct(ws uuid) returns numeric
  language sql stable security definer set search_path = public as $$
  select case when public.hq_can('customers.view') and public.link_storage_limit(ws) > 0
    then round(public.link_storage_used(ws) * 100.0 / public.link_storage_limit(ws), 1) end
$$;
-- HQ: give a business extra file storage (the total extra, in GB), with a reason. In the HQ history.
create or replace function public.hq_grant_storage(ws uuid, gb int, why text) returns json
  language plpgsql security definer set search_path = public as $$
declare was int;
begin
  perform hq_need(array['licences.manage']);
  select extra_storage_gb into was from workspaces where id = ws;
  if was is null then raise exception 'That business doesn''t exist.'; end if;
  if gb is null or gb < 0 or gb > 10000 then raise exception 'Choose 0 to 10000 GB of extra storage.'; end if;
  if length(trim(coalesce(why, ''))) < 3 then raise exception 'Say why, so the team knows later.'; end if;
  update workspaces set extra_storage_gb = gb where id = ws;
  perform hq_log('licence.storage', jsonb_build_object('workspace_id', ws, 'extra_gb', jsonb_build_object('was', was, 'now', gb), 'reason', left(trim(why), 300)));
  return public.link_storage_json(ws);
end $$;
revoke all on function public.link_storage_used(uuid), public.link_storage_limit(uuid), public.link_storage_fits(uuid, bigint),
  public.link_storage_fits_path(text, jsonb), public.link_storage_json(uuid), public.link_storage_pct(uuid), public.hq_grant_storage(uuid, int, text) from public, anon;
grant execute on function public.link_storage_used(uuid), public.link_storage_limit(uuid), public.link_storage_fits(uuid, bigint),
  public.link_storage_fits_path(text, jsonb), public.link_storage_json(uuid), public.link_storage_pct(uuid), public.hq_grant_storage(uuid, int, text) to authenticated;

-- The bucket and its rules, only where Supabase Storage is there (it always is on Supabase).
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit) values ('link-files', 'link-files', false, 26214400)
      on conflict (id) do update set public = false, file_size_limit = 26214400;
    execute 'drop policy if exists link_files_read on storage.objects';
    execute 'create policy link_files_read on storage.objects for select to authenticated using (bucket_id = ''link-files'' and public.link_file_ok(name))';
    execute 'drop policy if exists link_files_add on storage.objects';
    execute 'create policy link_files_add on storage.objects for insert to authenticated with check (bucket_id = ''link-files'' and public.link_file_ok(name)
      and public.link_storage_fits_path(name, metadata))';
  end if;
end $$;

-- ---------------------------------------------------------------- live updates
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['presence', 'message_reactions'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
