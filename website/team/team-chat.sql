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

-- The business's owner (with two-step sign-in): for what shows money, like refunds.
create or replace function public.is_owner(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.mfa_ok() and exists (select 1 from members m join workspaces w on w.id = m.workspace_id
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner' and w.status = 'active')
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
  using (user_id = auth.uid() and role <> 'owner' or public.is_owner(workspace_id) and role <> 'owner' or public.is_admin(workspace_id) and role = 'member');

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
grant update (name, topic) on public.channels to authenticated;   -- archiving goes through channel_archive (below)

-- ================================================================ Riyeser Link calls (was Team Calls, then Link Plus)
-- Calls between people in a team, and to a branch (rings everyone there; the first to answer takes it).
-- The call itself goes directly between the two devices (WebRTC); these rows only carry the ringing and set-up.
-- Part of the paid Riyeser Link program (module 'calls'): free for the first 90 days, then while it's paid.
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

-- S8: someone who joins without a branch (the invite link or Company ID) still gets an extension: the next free number
-- after the first branch's (101, 102… after Head office's 100). The owner or an admin can change it (set_extension).
create or replace function public.give_extension(ws uuid, person uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare base int;
begin
  if not exists (select 1 from members where workspace_id = ws and user_id = person and extension is null) then return; end if;
  select coalesce(min(extension), 100) into base from branches where workspace_id = ws and extension is not null and extension % 100 = 0;
  update members set extension = coalesce(next_extension(ws, base),
      (select min(n) from generate_series(100, 9999) n where n % 100 <> 0
         and not exists (select 1 from members x where x.workspace_id = ws and x.extension = n)
         and not exists (select 1 from branches x where x.workspace_id = ws and x.extension = n)))
    where workspace_id = ws and user_id = person and extension is null;
end $$;
revoke all on function public.give_extension(uuid, uuid) from public, anon, authenticated;

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
  perform give_extension(ws, auth.uid());   -- S8
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

-- One PC counts once. A "Fresh start" in Riyeser Central (or reinstalling it) links the same PC again under a new id.
-- When a PC links or reports in, older rows for the same computer name and the same person in that business are marked
-- replaced (retired_at, and replaced_by the row that took over): kept, never deleted, and no longer counted in HQ.
alter table public.devices add column if not exists retired_at timestamptz;
alter table public.devices add column if not exists replaced_by uuid;
do $$ begin
  alter table public.devices add constraint devices_replaced_by foreign key (replaced_by) references public.devices(id) on delete set null;
exception when duplicate_object then null; end $$;
-- A PC HQ counts: not replaced, and seen in the last 60 days.
create or replace function public.pc_active(d public.devices) returns boolean language sql stable as $$
  select d.retired_at is null and d.last_seen > now() - interval '60 days'
$$;
-- Mark the older rows for this PC (same name, same person, same business) as replaced by this one.
create or replace function public.retire_older_pcs(ws uuid, device uuid) returns void
  language sql security definer set search_path = public as $$
  update devices o set retired_at = now(), replaced_by = n.id
  from devices n
  where n.id = device and n.workspace_id = ws and nullif(trim(n.device_name), '') is not null
    and o.workspace_id = ws and o.user_id = n.user_id and o.id <> n.id and o.retired_at is null
    and lower(trim(o.device_name)) = lower(trim(n.device_name))
$$;
revoke all on function public.retire_older_pcs(uuid, uuid) from public, anon, authenticated;
-- The rows already there (from before this was added): same business, person and name, the most recently seen stays.
-- Run each time this file is run (safe to repeat: rows already marked are left as they are).
create or replace function public.retire_duplicate_pcs() returns int
  language sql security definer set search_path = public as $$
  with k as (
    select distinct on (workspace_id, user_id, lower(trim(device_name))) id, workspace_id, user_id, lower(trim(device_name)) as nm
    from devices where nullif(trim(device_name), '') is not null
    order by workspace_id, user_id, lower(trim(device_name)), (retired_at is null) desc, last_seen desc, linked_at desc, id),
  u as (
    update devices o set retired_at = now(), replaced_by = k.id from k
    where o.workspace_id = k.workspace_id and o.user_id = k.user_id and lower(trim(o.device_name)) = k.nm
      and o.id <> k.id and o.retired_at is null
    returning 1)
  select count(*)::int from u
$$;
revoke all on function public.retire_duplicate_pcs() from public, anon, authenticated;
do $$ begin perform public.retire_duplicate_pcs(); end $$;

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
declare ws uuid; b uuid; c text := upper(trim(code)); approval boolean; nm text; fresh boolean; who text; o uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(your_name), '') = '' then raise exception 'Type your name, as they''ll see it.'; end if;
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
    do update set display_name = excluded.display_name, branch_id = excluded.branch_id, note = excluded.note, created_at = now()
    returning (xmax = 0) into fresh;
  -- S7: tell the owners and admins (once per request, not again when the same person asks again)
  if fresh then
    who := trim(your_name) || coalesce(' (' || (select email from auth.users where id = auth.uid()) || ')', '');
    for o in select user_id from members where workspace_id = ws and role in ('owner', 'admin') loop
      perform queue_email(o, null, 'join_request', left(trim(your_name), 80) || ' asked to join ' || nm || ' on Riyeser',
        who || ' asked to join ' || nm || ' on Riyeser.' || coalesce(E'\nTheir note: ' || nullif(trim(coalesce(note, '')), ''), '')
        || E'\n\nApprove or decline them (sign in as an owner or admin):\nhttps://riyeser.com/link/?requests', ws, null, null);
    end loop;
  end if;
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
  -- Admin is for the owner and IT staff: only the owner can make someone an admin.
  if approve and coalesce(make_admin, false) and not is_owner(r.workspace_id) then
    raise exception 'Only the owner can make someone an admin.';
  end if;
  if approve then
    if coalesce(job_role, 'staff') not in ('manager', 'bookkeeper', 'sales', 'payroll', 'staff', 'readonly') then
      raise exception 'Choose a job role';
    end if;
    insert into members (workspace_id, user_id, display_name, role, job_role)
      values (r.workspace_id, r.user_id, r.display_name, case when make_admin then 'admin' else 'member' end, coalesce(job_role, 'staff'))
      on conflict (workspace_id, user_id) do nothing;
    perform set_person_branches(r.workspace_id, r.user_id,
      case when coalesce(array_length(branch_ids, 1), 0) > 0 then branch_ids when r.branch_id is not null then array[r.branch_id] else '{}' end);
    perform give_extension(r.workspace_id, r.user_id);   -- S8: no branch, still an extension
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
  -- Only the owner can make someone an admin or take it away (an admin can still change an admin's job role and branches).
  if not is_owner(ws) and coalesce(make_admin, false) <> exists (select 1 from members where workspace_id = ws and user_id = person and role = 'admin') then
    raise exception 'Only the owner can make someone an admin or take it away.';
  end if;
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
    platform = excluded.platform, app_version = excluded.app_version, last_seen = now(), retired_at = null, replaced_by = null;
  perform retire_older_pcs(ws, device);   -- the same PC linked before (e.g. before a Fresh start) counts once
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

-- S8: the invite page says "Join {business} on Riyeser" before anyone signs in. Only the name of an open business,
-- for a code that matches (a Company ID, invite code or branch code): nothing else.
create or replace function public.invite_info(code text) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('name', w.name) from workspaces w
  where w.status = 'active' and length(trim(coalesce($1, ''))) between 6 and 20
    and (w.company_code = upper(trim($1)) or w.invite_code = upper(trim($1))
         or exists (select 1 from branches b where b.workspace_id = w.id and b.code = upper(trim($1))))
  limit 1
$$;
revoke all on function public.invite_info(text) from public;
grant execute on function public.invite_info(text) to anon, authenticated;

-- M9: "Seen" in a direct message: when the other person last read it. Only for the people in that DM.
create or replace function public.dm_seen(ch uuid) returns timestamptz
  language sql stable security definer set search_path = public as $$
  select max(r.last_read_at) from reads r join channels c on c.id = r.channel_id
  where r.channel_id = $1 and c.kind = 'dm' and r.user_id <> auth.uid()
    and exists (select 1 from channel_members m where m.channel_id = $1 and m.user_id = auth.uid())
$$;
revoke all on function public.dm_seen(uuid) from public, anon;
grant execute on function public.dm_seen(uuid) to authenticated;

-- S7: how many people are waiting to join, for the business's owners and admins (the bell and Join requests). Only the
-- number: it's there before two-step sign-in is on, so they know to turn it on and approve them (the names need it).
create or replace function public.join_request_count(ws uuid) returns int
  language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from members m join workspaces w on w.id = m.workspace_id
      where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin') and w.status = 'active')
    then (select count(*)::int from join_requests where workspace_id = ws and status = 'pending') else 0 end
$$;
revoke all on function public.join_request_count(uuid) from public, anon;
grant execute on function public.join_request_count(uuid) to authenticated;

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

-- S59: people who were removed keep their name on what they wrote ("Sam Taylor (left)", not "Someone who left"):
-- from the business's own change history, for anyone in the business. Names only, nothing else.
create or replace function public.former_members(ws uuid) returns table (user_id uuid, display_name text)
  language sql stable security definer set search_path = public as $$
  select distinct on ((a.details ->> 'user_id')::uuid) (a.details ->> 'user_id')::uuid, a.details ->> 'display_name'
  from audit_log a
  where public.is_member(ws) and a.workspace_id = ws and a.action = 'members.delete' and a.details ? 'user_id'
    and not exists (select 1 from members m where m.workspace_id = ws and m.user_id = (a.details ->> 'user_id')::uuid)
  order by (a.details ->> 'user_id')::uuid, a.at desc
$$;
revoke all on function public.former_members(uuid) from public, anon;
grant execute on function public.former_members(uuid) to authenticated;


-- ================================================================ Riyeser HQ (for Riyeser's own staff)
-- The back office for running Riyeser: companies, linked PCs and versions, trials, Riyeser Link, downloads, notes.
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
    'pcs', (select count(*) from devices d where public.pc_active(d)),
    'pcs_active_7d', (select count(*) from devices where retired_at is null and last_seen > now() - interval '7 days'),
    'pcs_active_30d', (select count(*) from devices where retired_at is null and last_seen > now() - interval '30 days'),
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
    (select count(*) from devices d where d.workspace_id = w.id and public.pc_active(d)),
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
-- Paid programs: basic (Accounting Basics), plus (Accounting Plus), bookings, calls (Riyeser Link: chat, calls, desk phones
-- and Riyeser Link Office; the id 'calls' is kept from when it was Link Plus), payroll, pos, as_built.
-- Free programs (Central, Riyeser Documents, Invoices, PDF) aren't listed: they're always free.
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
-- Pricing v2: users per program ({module: count}) and POS tills, from the last payment (or HQ).
alter table public.company_plans add column if not exists users jsonb;
alter table public.company_plans add column if not exists tills int not null default 1;
alter table public.company_modules enable row level security;
alter table public.company_plans enable row level security;
revoke all on public.company_modules, public.company_plans from anon, authenticated;   -- read through company_licence()

-- Riyeser Link's users: everyone in the business who chats or takes calls, except one accountant or bookkeeper (job
-- role 'bookkeeper', not the owner), who is free and never counts as a user.
create or replace function public.link_people(ws uuid) returns int
  language sql stable security definer set search_path = public as $$
  select greatest(0, (select count(*) from members where workspace_id = ws)::int
    - case when exists (select 1 from members where workspace_id = ws and job_role = 'bookkeeper' and role <> 'owner') then 1 else 0 end)
$$;
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
  -- Riyeser Estimate: its 90-day trial starts on first use (company_modules_first_use below), not when the company
  -- joined. Until then it's a trial that hasn't started: the PC's own first-use trial counts.
  if m.module is null and mod = 'estimate' then
    return json_build_object('status', 'trial', 'active', true, 'trial_ends', null, 'paid_until', null, 'days_left', 90,
                             'starts_on_first_use', true);
  end if;
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
    'modules', (select json_object_agg(m, public.module_state(w.id, m)) from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m),
    'seats', json_build_object('included', 3, 'extra', coalesce(p.extra_users, 0), 'used', public.link_people(w.id),
      'users', p.users, 'tills', coalesce(p.tills, 1), 'accountant_free', true),
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
    'trial_days_left', coalesce((public.module_state(ws, 'calls') ->> 'days_left')::int, 0),
    -- Riyeser Link (pricing v2): chat, calls and phones are one paid program. Off: chat is read-only (nothing deleted).
    'link', public.calls_allowed(ws), 'link_status', public.module_state(ws, 'calls') ->> 'status',
    'link_trial_ends', public.module_state(ws, 'calls') ->> 'trial_ends')
  from workspaces w where w.id = ws and public.is_member(ws)
$$;

-- Riyeser Link off (its 90 days are over and it isn't paid): chat is read-only. Everything stays readable; nobody can
-- send, edit or react until Link is added on the Riyeser home page. (Messages Riyeser itself adds are not affected.)
drop policy if exists msg_send on public.messages;
create policy msg_send on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_channel(channel_id)
              and workspace_id = (select workspace_id from public.channels where id = channel_id)
              and public.calls_allowed(workspace_id));
drop policy if exists msg_edit on public.messages;
create policy msg_edit on public.messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_see_channel(channel_id) and public.calls_allowed(workspace_id));

-- Pricing v2, once: businesses that were using Riyeser Link chat for free get 90 days of Riyeser Link from the day this
-- file is first run with it (so nobody is locked out straight away). Re-running never resets it (riyeser_once marker).
-- Businesses already paying for it (Link Plus) keep what they have; a longer trial is never shortened.
create table if not exists public.riyeser_once (key text primary key, at timestamptz not null default now());
alter table public.riyeser_once enable row level security;
revoke all on public.riyeser_once from anon, authenticated;
create or replace function public.pricing_v2_link_trial() returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.riyeser_once where key = 'pricing_v2_link_trial') then
    insert into public.company_modules (workspace_id, module, status, trial_ends)
      select w.id, 'calls', 'trial', current_date + 90 from public.workspaces w
      where not (coalesce(w.calls_paid_until > now(), false)
                 or exists (select 1 from public.company_modules c where c.workspace_id = w.id and c.module = 'calls' and c.status = 'active'
                            and (c.paid_until is null or c.paid_until >= current_date)))
    on conflict (workspace_id, module) do update set status = 'trial',
      trial_ends = greatest(excluded.trial_ends, public.company_modules.trial_ends, public.company_modules.paid_until), updated_at = now();
    insert into public.riyeser_once (key) values ('pricing_v2_link_trial');
  end if;
end $$;
revoke all on function public.pricing_v2_link_trial() from public, anon, authenticated;
select public.pricing_v2_link_trial();

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

-- Riyeser list prices, in US dollars a month per business (pricing v2). This is the one place they're set: change a
-- number here, re-run this file, and every HQ estimate and bill follows (website/prices.mjs has the same list).
-- Free programs (Central, Riyeser Documents, Invoices, PDF) cost 0.
create or replace function public.riyeser_price(item text) returns numeric
  language sql immutable set search_path = public as $$
  select (case item
    when 'basic' then 25 when 'plus' then 39 when 'bookings' then 25 when 'calls' then 20   -- calls = Riyeser Link
    when 'payroll' then 25 when 'pos' then 29 when 'as_built' then 29
    when 'estimate' then 20          -- Riyeser Estimate (after its 90 days from first use; not in any bundle)
    when 'users_included' then 3     -- users included in each paid program (POS: unlimited cashiers instead)
    when 'extra_user' then 7         -- each user over that, for each paid program
    when 'tills_included' then 1     -- POS: checkout counters included
    when 'extra_till' then 15        -- each extra till
    when 'extra_company' then 10     -- each extra company in Accounting
    when 'bundle_shop' then 59 when 'bundle_office' then 59 when 'bundle_business' then 99
    else 0 end)::numeric
$$;

-- The bundles: [id, name, programs]. Each program in a bundle still includes 3 users (extra users US$7, tills US$15).
create or replace function public.riyeser_bundles() returns table (id text, name text, mods text[], price numeric)
  language sql immutable set search_path = public as $$
  select b.id, b.name, b.mods, public.riyeser_price('bundle_' || b.id) from (values
    ('shop', 'Shop bundle', array['basic', 'pos', 'calls']),
    ('office', 'Office bundle', array['basic', 'payroll', 'calls']),
    ('business', 'Business bundle', array['plus', 'bookings', 'calls', 'payroll', 'pos'])) b(id, name, mods)
$$;

-- One plan at list prices (US$), with its lines. Each paid program: its price, then US$7 for each user over 3 (for that
-- program; users: {module: count}, anyone missing counts as people). POS has unlimited cashiers: 1 till included, then
-- US$15 a till. Accounting Plus includes Basics (never both). When the programs contain a bundle, the bundle's price
-- replaces those programs' prices (the one that saves most). Extra companies count only with Accounting.
-- Yearly = 10 months. Early bird = half the program, bundle, user and till amounts (not extra companies).
create or replace function public.riyeser_plan(mods text[], people int, users jsonb, tills int, extra_companies int, billing text, early_bird boolean)
  returns jsonb language plpgsql immutable set search_path = public as $$
declare m text[]; b record; best record; save numeric; best_save numeric := 0; x text; n int; ex int; lines jsonb := '[]'::jsonb;
  sub numeric := 0; inc int := riyeser_price('users_included')::int; t int := greatest(coalesce(tills, 1), 1); u jsonb := '{}'::jsonb;
  rest text[]; v numeric; extras numeric; ext_users int; total numeric; best_id text;
begin
  select coalesce(array_agg(o.m order by o.ord), '{}'::text[]) into m
    from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) with ordinality o(m, ord)
    where o.m = any (coalesce(mods, '{}'::text[])) and not (o.m = 'basic' and 'plus' = any (mods));
  foreach x in array m loop
    n := case when users is not null and jsonb_typeof(users -> x) = 'number' then (users ->> x)::numeric::int else coalesce(people, inc) end;
    u := u || jsonb_build_object(x, least(greatest(n, 1), 10000));
  end loop;
  for b in select * from riyeser_bundles() loop
    if b.mods <@ m then
      save := (select sum(riyeser_price(y)) from unnest(b.mods) y) - b.price;
      if save > best_save then best_save := save; best := b; best_id := b.id; end if;
    end if;
  end loop;
  rest := m;
  if best_save > 0 then
    ext_users := 0; extras := 0;
    foreach x in array best.mods loop
      if x <> 'pos' then ext_users := ext_users + greatest(0, (u ->> x)::int - inc); end if;
    end loop;
    extras := ext_users * riyeser_price('extra_user') + case when 'pos' = any (best.mods) then (t - 1) * riyeser_price('extra_till') else 0 end;
    lines := lines || jsonb_build_array(jsonb_build_object('module', 'bundle_' || best.id, 'bundle', best.id, 'name', best.name,
      'modules', to_jsonb(best.mods), 'price', best.price, 'list_price', best.price + best_save, 'extra_users', ext_users,
      'extra_tills', case when 'pos' = any (best.mods) then t - 1 else 0 end, 'monthly', best.price + extras));
    sub := sub + best.price + extras;
    rest := array(select y from unnest(m) y where y <> all (best.mods));
  end if;
  foreach x in array rest loop
    ex := case when x = 'pos' then 0 else greatest(0, (u ->> x)::int - inc) end;
    v := riyeser_price(x) + ex * riyeser_price('extra_user') + case when x = 'pos' then (t - 1) * riyeser_price('extra_till') else 0 end;
    lines := lines || jsonb_build_array(jsonb_build_object('module', x, 'name', public.module_label(x), 'price', riyeser_price(x),
      'users', case when x <> 'pos' then (u ->> x)::int end, 'extra_users', ex, 'extra_tills', case when x = 'pos' then t - 1 else 0 end, 'monthly', v));
    sub := sub + v;
  end loop;
  total := round((sub * case when coalesce(early_bird, false) then 0.5 else 1 end
      + case when m && array['basic', 'plus'] then riyeser_price('extra_company') * greatest(0, coalesce(extra_companies, 0)) else 0 end)
    * case when billing = 'yearly' then 10 else 1 end, 2);
  return jsonb_build_object('modules', to_jsonb(m), 'users', u, 'tills', case when 'pos' = any (m) then t else 0 end,
    'bundle', best_id, 'bundle_saves', best_save, 'lines', lines, 'total', total);
end $$;

-- One bill at list prices (US$): riyeser_plan with the same number of users in each program and 1 POS till.
-- (Bundles apply here too.) The early bird flag: the caller says if it's still in its 12 months.
create or replace function public.riyeser_bill(mods text[], people int, extra_companies int, billing text, early_bird boolean) returns numeric
  language sql immutable set search_path = public as $$
  select (public.riyeser_plan(mods, people, null, 1, extra_companies, billing, early_bird) ->> 'total')::numeric
$$;

-- How many people a business pays for (each program, unless the plan says otherwise): everyone in it (the free
-- accountant left out), or its licence seats (3 + extra users set in HQ) if that's more.
create or replace function public.riyeser_people(ws uuid) returns int
  language sql stable security definer set search_path = public as $$
  select greatest(public.link_people(ws), 3 + coalesce((select extra_users from company_plans where workspace_id = ws), 0))
$$;
-- The users per program for a business's estimate: what its plan says (from its last payment or HQ), else
-- riyeser_people; Riyeser Link never fewer than the people in it (the free accountant left out).
create or replace function public.riyeser_users(ws uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce((select users from company_plans where workspace_id = ws and jsonb_typeof(users) = 'object'), '{}'::jsonb)
    || jsonb_build_object('calls', greatest(public.link_people(ws),
         coalesce((select (users ->> 'calls')::int from company_plans where workspace_id = ws and jsonb_typeof(users -> 'calls') = 'number'),
                  public.riyeser_people(ws))))
$$;

-- What each company pays per month, at list prices in US$ (an estimate: payments aren't connected yet).
-- Paid programs only (not trials). Yearly billing is shown as its monthly share (10 months over 12).
create or replace function public.company_monthly(ws uuid) returns numeric
  language sql stable security definer set search_path = public as $$
  select round((public.riyeser_plan(
      array(select m from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m
            where (public.module_state(ws, m) ->> 'status') = 'active'),
      public.riyeser_people(ws), public.riyeser_users(ws), coalesce(p.tills, 1), coalesce(p.extra_companies, 0), 'monthly',
      coalesce(p.early_bird, false) and p.early_bird_since > current_date - 365) ->> 'total')::numeric
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
        'on_trial', (select count(*) from workspaces w where (public.module_state(w.id, m) ->> 'status') = 'trial'
                     and (public.module_state(w.id, m) ->> 'starts_on_first_use') is null),   -- Estimate: only once it's been used
        'ended', (select count(*) from workspaces w where (public.module_state(w.id, m) ->> 'status') in ('ended', 'cancelled', 'closed')),
        -- businesses with it on at least one PC (Riyeser Central reports the programs on each PC)
        'installed', (select count(distinct d.workspace_id) from devices d where public.pc_active(d) and coalesce(d.programs, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id',
           case m when 'basic' then 'accounting-basics' when 'plus' then 'accounting' when 'as_built' then 'services' when 'calls' then 'team' else m end)))))
      from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m),
    -- real money: what active PayPal subscriptions charge (at their next charge) and paid bank invoices still running,
    -- as a monthly figure (a year's price / 12)
    'monthly_recurring', (select coalesce(round(sum(case when x.billing = 'yearly' then x.amt / 12 else x.amt end), 2), 0) from (
        select o.billing, case when o.method = 'paypal' and o.early_bird
            and (select count(*) from billing_payments p where p.order_id = o.id and p.status = 'completed') < o.early_cycles then o.first_amount
          when o.method = 'paypal' then o.amount else coalesce(o.first_amount, o.amount) end as amt
        from billing_orders o where (o.method = 'paypal' and o.status in ('active', 'payment_failed'))
          or (o.method = 'bank' and o.status = 'paid' and o.paid_through >= current_date)) x),
    'recurring_count', (select count(*) from billing_orders o where (o.method = 'paypal' and o.status in ('active', 'payment_failed'))
          or (o.method = 'bank' and o.status = 'paid' and o.paid_through >= current_date)),
    'ending_soon', (select coalesce(json_agg(x order by x.days_left), '[]') from (
        select w.id, w.name, w.company_code, m as module, (public.module_state(w.id, m) ->> 'status') as status,
               (public.module_state(w.id, m) ->> 'days_left')::int as days_left
        from workspaces w, unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m
        where (public.module_state(w.id, m) ->> 'days_left')::int between 0 and 14) x)
  ) into r;
  return r;
end $$;

-- HQ Licences: the businesses on one program, by status (paid, trial, ended), for the By program table. Read only.
create or replace function public.hq_licence_businesses(mod text, st text) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['licences.view']);
  if mod is null or mod <> all (array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) then raise exception 'Choose a program.'; end if;
  if st is null or st not in ('paid', 'trial', 'ended') then raise exception 'Choose paid, trial or ended.'; end if;
  return (select coalesce(json_agg(json_build_object('id', x.id, 'name', x.name, 'company_code', x.company_code, 'country', x.country,
      'status', x.s ->> 'status', 'until', coalesce(x.s ->> 'paid_until', x.s ->> 'trial_ends'), 'days_left', (x.s ->> 'days_left')::int) order by x.name), '[]')
    from (select w.id, w.name, w.company_code, w.country, public.module_state(w.id, mod) s from workspaces w) x
    where case st when 'paid' then x.s ->> 'status' = 'active' when 'trial' then x.s ->> 'status' = 'trial' and x.s ->> 'starts_on_first_use' is null
      else x.s ->> 'status' in ('ended', 'cancelled', 'closed') end);
end $$;
revoke all on function public.hq_licence_businesses(text, text) from public, anon;
grant execute on function public.hq_licence_businesses(text, text) to authenticated;

-- HQ company detail now includes the licence and the monthly estimate.
create or replace function public.hq_company_licence(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['licences.view']);
  return json_build_object('licence', licence_json(ws), 'monthly', company_monthly(ws));
end $$;

revoke all on function public.module_state(uuid, text), public.licence_json(uuid), public.company_licence(uuid),
  public.hq_set_module(uuid, text, text, date, date), public.hq_set_plan(uuid, int, int, text, boolean), public.company_monthly(uuid),
  public.hq_licences(), public.hq_company_licence(uuid), public.riyeser_people(uuid), public.link_people(uuid), public.riyeser_users(uuid) from public, anon;
grant execute on function public.company_licence(uuid), public.hq_set_module(uuid, text, text, date, date),
  public.hq_set_plan(uuid, int, int, text, boolean), public.hq_licences(), public.hq_company_licence(uuid) to authenticated;
revoke all on function public.module_state(uuid, text), public.licence_json(uuid), public.company_monthly(uuid), public.riyeser_people(uuid),
  public.link_people(uuid), public.riyeser_users(uuid) from authenticated;

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
    'offers.self_limit_days', public.hq_setting_num('offers.self_limit_days', 31),
    'billing.grace_days', public.hq_setting_num('billing.grace_days', 7))
$$;
create or replace function public.hq_get_settings() returns json
  language plpgsql stable security definer set search_path = public as $$
begin perform hq_need(array['overview.view']); return hq_settings_json(); end $$;
create or replace function public.hq_set_setting(setting text, val numeric) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform hq_need(array['settings.manage']);
  if setting not in ('support.overdue_hours', 'support.escalate_hours', 'refunds.two_person_threshold', 'offers.self_limit_days', 'billing.grace_days') then
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
-- Also (SEC-001): sign-in details in web addresses (https://user:pass@…, ?key=…), sign-in tokens (eyJ…), Riyeser and other
-- well-known keys (rk_…, whsec_…, sb_secret_…), "Bearer …", words that contain password/secret/token/api key/credential
-- (access_token=…, SIP_PASSWORD=…, client_secret: …), and the Windows (or Mac/Linux) user name in folder paths
-- (C:\Users\[user]\…), so a log line can't carry a password, a key or a person's name to Riyeser Support.
create or replace function public.support_scrub(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '([A-Za-z][A-Za-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@', '\1[removed]@', 'g'),
    'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*', '[removed]', 'g'),
    '\m(rk_(pub_)?(live|test)_|whsec_|sb_(secret|publishable)_|sk_(live|test)_|pk_(live|test)_|ghp_|gho_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]+', '[key removed]', 'g'),
    '\m(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}', '\1 [removed]', 'gi'),
    '([?&;](key|apikey|api_key|token|access_token|refresh_token|sig|signature|secret|password|pass|pwd|auth|code)=)[^&\s#"'']+', '\1[removed]', 'gi'),
    '([A-Za-z]:[\\/]+(Users|Documents and Settings)[\\/]+)[^\\/\s"'':;]+', '\1[user]', 'gi'),
    '(/(home|Users)/)[^/\s"'':;]+', '\1[user]', 'g'),
    '([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})', '\1***@\2', 'g'),
    '\m([A-Za-z0-9_-]*(password|passwd|pwd|secret|token|api[_ -]?key|apikey|credentials?|authorization)[A-Za-z0-9_-]*)\M.*', '\1 [removed]', 'gin'),
    '\m(pass|passcode|pin)\s*[=:]\s*\S+', '\1=[removed]', 'gi'),
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
    when 'pdf' then 'Riyeser PDF' when 'desk' then 'Riyeser Documents' when 'website' then 'riyeser.com' else 'Something else' end
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
-- S3: help without signing in (the sign-in page, riyeser.com/link/?contact): who to reply to, by email
alter table public.support_tickets add column if not exists guest_email text
  check (guest_email is null or (length(guest_email) <= 254 and guest_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
alter table public.support_tickets add column if not exists guest_name text check (length(guest_name) <= 80);
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

-- S3: a help request from someone who isn't signed in (or has no account): a ticket for Riyeser Support, and an
-- automatic email with its number. Replies go to that email address. Limits: 3 an hour from one address, 200 a day in all.
create or replace function public.guest_ticket(your_name text, your_email text, help_topic text, help_subject text, message text) returns json
  language plpgsql security definer set search_path = public as $$
declare t support_tickets; e text := lower(trim(coalesce(your_email, ''))); nm text := left(trim(coalesce(your_name, '')), 80);
  tp text := coalesce(nullif(help_topic, ''), 'other');
begin
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(e) > 254 then raise exception 'Type your email address, so we can reply.'; end if;
  if nm = '' then raise exception 'Type your name.'; end if;
  if length(trim(coalesce(help_subject, ''))) = 0 or length(trim(coalesce(message, ''))) = 0 then
    raise exception 'Add a subject and a message, then send it again.'; end if;
  if tp not in ('billing', 'signin', 'program', 'other') then tp := 'other'; end if;
  if (select count(*) from support_tickets where guest_email = e and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'You''ve sent a few help requests already. We''ll reply to them by email soon.'; end if;
  if (select count(*) from support_tickets where guest_email is not null and created_at > now() - interval '1 day') >= 200 then
    raise exception 'We''re getting a lot of requests right now. Please email info@riyeser.com instead.'; end if;
  insert into support_tickets (workspace_id, opened_by, topic, subject, status, last_customer_at, guest_email, guest_name)
    values (null, null, tp, left(trim(help_subject), 150), 'new', now(), e, nm) returning * into t;
  insert into support_messages (ticket_id, author, body) values (t.id, null, left(trim(message), 5000));
  perform queue_email(null, e, 'ticket_received', 'We''ve got your help request (' || t.ref || ')',
    'Hi ' || nm || ',' || E'\n\n' || 'Thanks for getting in touch. We''ve got your help request "' || t.subject || '".' || E'\n\n'
    || 'Your request number is ' || t.ref || '. We''ll reply to this email address, usually within one business day.' || E'\n'
    || 'If you write to us about it (info@riyeser.com), put ' || t.ref || ' in the subject.', null, t.id, null);
  return json_build_object('ref', t.ref);
end $$;
revoke all on function public.guest_ticket(text, text, text, text, text) from public;
grant execute on function public.guest_ticket(text, text, text, text, text) to anon, authenticated;

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
    'people', (select count(*) from members m where m.workspace_id = w.id), 'pcs', (select count(*) from devices d where d.workspace_id = w.id and public.pc_active(d)),
    'paid', (select coalesce(json_agg(m), '[]') from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m
             where (public.module_state(w.id, m) ->> 'status') = 'active'),
    'trial', (select coalesce(json_agg(m), '[]') from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m
             where (public.module_state(w.id, m) ->> 'status') = 'trial' and (public.module_state(w.id, m) ->> 'starts_on_first_use') is null),
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
      'opened_by_name', coalesce((select display_name from members m where m.workspace_id = t.workspace_id and m.user_id = t.opened_by), t.guest_name),
      'opened_by_email', coalesce((select email::text from auth.users u where u.id = t.opened_by), t.guest_email),
      'guest', t.guest_email is not null,
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
        'from', case when m.author is null and not m.is_staff and t.guest_email is not null then coalesce(t.guest_name, 'Guest') || ' <' || t.guest_email || '> (not signed in)'
                     when m.author is null then 'Riyeser (automatic)' when m.is_staff then coalesce(staff_name(m.author), 'Riyeser staff')
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
  if t.opened_by is null and t.guest_email is not null then   -- S3: not signed in: the reply goes by email only
    perform queue_email(null, t.guest_email, 'ticket_reply', 'Re: ' || t.subject || ' (' || t.ref || ')',
      'Hi ' || coalesce(t.guest_name, '') || ',' || E'\n\n' || 'Riyeser Support has replied to your help request ' || t.ref || ':' || E'\n\n' || trim(message) || E'\n\n'
      || 'To reply, write to info@riyeser.com with ' || t.ref || ' in the subject.', null, t.id, null);
  end if;
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
    jsonb_build_object('workspace_id', ws, 'ticket', tr, 'reason', trim(reason), 'was', w.status)
      || case when new_status = 'active' and w.duplicate_of is not null then jsonb_build_object('was_duplicate_of', w.duplicate_of) else '{}'::jsonb end);
end $$;

-- Close as duplicate: closes THIS business (the one HQ has open). Nothing is moved or deleted: it's an ordinary close
-- (hq_set_business_status) plus an optional link to the business being kept, and "Reopen" undoes both.
-- Safety (the owner, Nov 2026): HQ never pre-picks another account. The link is optional and chosen from likely
-- matches; the Company ID of the business being closed must be typed; and anything that suggests it's the wrong one
-- (it has payments, paid programs, recent use; the kept one has a different owner or nothing paid) must be accepted.
drop function if exists public.hq_close_duplicate(uuid, uuid, text, text);
-- matching keys: digits of a phone; letters and digits of a tax number; a name without "(2)", "Pty Ltd", numbers, spaces
create or replace function public.dup_digits(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '') $$;
create or replace function public.dup_tax(t text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '') $$;
create or replace function public.dup_name(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(t, '')), '\([^)]*\)', ' ', 'g'),
    '\m(pty|ltd|limited|inc|co|company|the|and|copy|new|test|old)\M|[0-9]+\s*$', ' ', 'g'), '[^a-z]', '', 'g'), '') $$;
-- One business, for the Close as duplicate screen: who owns it, its plan and payments, how much it's used.
create or replace function public.hq_dup_card(ws uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare w workspaces; r jsonb;
begin
  select * into w from workspaces where id = ws;
  if w.id is null then return null; end if;
  select jsonb_build_object('id', w.id, 'name', w.name, 'company_code', w.company_code, 'status', w.status, 'kind', w.kind,
    'created_at', w.created_at, 'removal_state', w.removal_state, 'duplicate_of', w.duplicate_of,
    'owner_id', o.user_id, 'owner_name', o.display_name, 'owner_email', o.email,
    'members', (select count(*) from members m where m.workspace_id = ws),
    'pcs', (select count(*) from devices d where d.workspace_id = ws and public.pc_active(d)),
    'paid_invoices', (select count(*) from billing_payments p where p.workspace_id = ws and p.status = 'completed'),
    'paid_total', (select coalesce(sum(p.amount), 0) from billing_payments p where p.workspace_id = ws and p.status = 'completed'),
    'paid_programs', (select coalesce(jsonb_agg(m.module order by m.module), '[]') from company_modules m where m.workspace_id = ws
        and ((m.status = 'active' and (m.paid_until is null or m.paid_until >= current_date)) or (m.status = 'cancelled' and m.paid_until >= current_date)))
      || case when w.calls_paid_until > now() then '["calls"]'::jsonb else '[]'::jsonb end,
    'trial_programs', (select count(*) from company_modules m where m.workspace_id = ws and m.status = 'trial' and m.trial_ends >= current_date),
    'last_activity', greatest(w.last_active_at, (select max(d.last_seen) from devices d where d.workspace_id = ws)))
  into r
  from (select null) x
  left join lateral (select m.user_id, m.display_name, u.email::text as email from members m join auth.users u on u.id = m.user_id
                     where m.workspace_id = ws and m.role = 'owner' order by m.joined_at limit 1) o on true;
  return r;
end $$;
-- What could make closing this one a mistake. Each must be accepted before it closes (the screen shows the same list).
create or replace function public.hq_dup_risks(ws uuid, keep_ws uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare a jsonb := hq_dup_card(ws); k jsonb := case when keep_ws is not null then hq_dup_card(keep_ws) end; r jsonb := '[]';
begin
  if (a ->> 'paid_invoices')::int > 0 then r := r || jsonb_build_object('code', 'paid_invoices',
    'text', 'This account has ' || (a ->> 'paid_invoices') || ' paid invoice' || case when (a ->> 'paid_invoices')::int = 1 then '' else 's' end || '.'); end if;
  if jsonb_array_length(a -> 'paid_programs') > 0 then r := r || jsonb_build_object('code', 'paid_programs',
    'text', 'This account is paying for programs right now.'); end if;
  if (a ->> 'last_activity')::timestamptz > now() - interval '14 days' then r := r || jsonb_build_object('code', 'recent',
    'text', 'Someone used this account in the last 14 days.'); end if;
  if k is not null then
    if (a ->> 'owner_id') is distinct from (k ->> 'owner_id') then r := r || jsonb_build_object('code', 'owner',
      'text', 'The account you''re keeping has a different owner.'); end if;
    if ((a ->> 'paid_invoices')::int > 0 or jsonb_array_length(a -> 'paid_programs') > 0)
       and (k ->> 'paid_invoices')::int = 0 and jsonb_array_length(k -> 'paid_programs') = 0 then
      r := r || jsonb_build_object('code', 'backwards', 'text', 'This account has payments and the one you''re keeping has none. You may be closing the wrong one.'); end if;
    if (a ->> 'members')::int > (k ->> 'members')::int or (a ->> 'pcs')::int > (k ->> 'pcs')::int then
      r := r || jsonb_build_object('code', 'bigger', 'text', 'This account has more people or PCs than the one you''re keeping.'); end if;
  end if;
  return r;
end $$;
-- Is this business one HQ may link to as "the account we're keeping"? null = yes, else why not.
create or replace function public.dup_keep_problem(ws uuid, k workspaces) returns text language sql stable as $$
  select case when k.id is null then 'That business doesn''t exist.' when k.id = ws then 'That''s this account. Choose the other one.'
    when k.removal_state is not null then 'That account''s details were removed.' when k.status = 'closed' then 'That account is closed. Keep an open one.'
    when k.duplicate_of = ws then 'That account is linked as a duplicate of this one.' end $$;
-- The screen: this account, what to watch out for, and likely matches (never a list of every business).
create or replace function public.hq_dup_check(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare w workspaces; oe text; op text; nk text;
begin
  perform hq_need(array['business.close']);
  select * into w from workspaces where id = ws;
  if w.id is null then raise exception 'That business doesn''t exist.'; end if;
  select lower(u.email::text), public.dup_digits(coalesce(nullif(u.raw_user_meta_data -> 'riyeser_signup' ->> 'phone', ''), w.phone)) into oe, op
    from members m join auth.users u on u.id = m.user_id where m.workspace_id = ws and m.role = 'owner' order by m.joined_at limit 1;
  op := coalesce(op, public.dup_digits(w.phone)); nk := public.dup_name(w.name);
  return json_build_object('this', hq_dup_card(ws), 'risks', hq_dup_risks(ws, null),
    'matches', (select coalesce(json_agg(y.c order by y.n desc, y.gap), '[]') from (
      select hq_dup_card(x.id) || jsonb_build_object('why', to_jsonb(x.why || case when x.gap < 14 * 86400
          then array['Signed up ' || case when x.gap < 86400 then 'the same day' else (ceil(x.gap / 86400))::int::text || ' days apart' end] else '{}' end)) as c,
        array_length(x.why, 1) as n, x.gap
      from (select o.id, abs(extract(epoch from o.created_at - w.created_at)) as gap,
        array_remove(array[
          case when oe is not null and exists (select 1 from members m join auth.users u on u.id = m.user_id
            where m.workspace_id = o.id and m.role = 'owner' and lower(u.email::text) = oe) then 'Same owner email' end,
          case when length(op) >= 6 and (public.dup_digits(o.phone) = op or exists (select 1 from members m join auth.users u on u.id = m.user_id
            where m.workspace_id = o.id and m.role = 'owner' and public.dup_digits(u.raw_user_meta_data -> 'riyeser_signup' ->> 'phone') = op)) then 'Same phone' end,
          case when public.dup_tax(w.tax_number) is not null and public.dup_tax(o.tax_number) = public.dup_tax(w.tax_number) then 'Same tax number' end,
          case when length(nk) >= 3 and (public.dup_name(o.name) = nk
            or (length(nk) >= 5 and length(public.dup_name(o.name)) >= 5 and (public.dup_name(o.name) like nk || '%' or nk like public.dup_name(o.name) || '%'))) then 'Similar name' end
        ], null) as why
      from workspaces o where o.id <> ws and o.status <> 'closed' and o.removal_state is null
      ) x where array_length(x.why, 1) > 0 order by array_length(x.why, 1) desc, x.gap limit 6) y));
end $$;
-- Not among the matches? Find it by name, Company ID, owner email or tax number (2+ characters; 8 at most).
create or replace function public.hq_dup_search(ws uuid, search text) returns json
  language plpgsql stable security definer set search_path = public as $$
declare q text := nullif(trim(coalesce(search, '')), '');
begin
  perform hq_need(array['business.close']);
  if q is null or length(q) < 2 then return '[]'; end if;
  return (select coalesce(json_agg(hq_dup_card(x.id) || jsonb_build_object('problem', public.dup_keep_problem(ws, x))), '[]') from (
    select w.* from workspaces w where w.id <> ws and (w.name ilike '%' || q || '%' or w.company_code ilike '%' || q || '%' or w.tax_number ilike '%' || q || '%'
      or exists (select 1 from members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' and u.email::text ilike '%' || q || '%'))
    order by (w.status = 'closed'), w.created_at desc limit 8) x);
end $$;
-- Close this business as a duplicate. duplicate_of_ws (the one being kept) is optional.
create or replace function public.hq_close_duplicate(ws uuid, duplicate_of_ws uuid, reason text, ticket_ref text, confirm_code text, accept_risks boolean)
  returns json language plpgsql security definer set search_path = public as $$
declare w workspaces; k workspaces; pr text; risks jsonb; before jsonb; tr text := upper(nullif(trim(coalesce(ticket_ref, '')), ''));
begin
  perform hq_need(array['business.close']);   -- staff, signed in with two-step sign-in, with business.close
  select * into w from workspaces where id = ws;
  if w.id is null then raise exception 'That business doesn''t exist.'; end if;
  if w.status = 'closed' then raise exception 'This account is already closed.'; end if;
  if w.removal_state is not null then raise exception 'This account''s details were removed.'; end if;
  if upper(trim(coalesce(confirm_code, ''))) is distinct from upper(w.company_code) then
    raise exception 'Type this account''s Company ID (%) to confirm.', w.company_code; end if;
  if duplicate_of_ws is not null then
    select * into k from workspaces where id = duplicate_of_ws;
    pr := public.dup_keep_problem(ws, k);
    if pr is not null then raise exception '%', pr; end if;
  end if;
  risks := hq_dup_risks(ws, duplicate_of_ws);
  if jsonb_array_length(risks) > 0 and not coalesce(accept_risks, false) then
    raise exception 'Check the warnings first: %', (select string_agg(x ->> 'text', ' ') from jsonb_array_elements(risks) x); end if;
  before := jsonb_build_object('status', w.status, 'closed_reason', w.closed_reason, 'duplicate_of', w.duplicate_of, 'closed_at', w.closed_at);
  perform hq_set_business_status(ws, 'closed', reason, ticket_ref);   -- the reason, ticket and permission checks; emails the owner
  update workspaces set duplicate_of = duplicate_of_ws, closed_reason = left('Duplicate: ' || trim(reason), 300) where id = ws returning * into w;
  if tr ~ '^[0-9]+$' then tr := 'T-' || tr; end if;
  -- the full before and after, and the facts it was decided on (counts and ids only: no names or emails)
  perform hq_log('business.duplicate', jsonb_build_object('workspace_id', ws, 'duplicate_of', duplicate_of_ws, 'ticket', tr, 'reason', trim(reason),
    'company_code', w.company_code, 'keep_company_code', k.company_code, 'before', before,
    'after', jsonb_build_object('status', w.status, 'closed_reason', w.closed_reason, 'duplicate_of', w.duplicate_of, 'closed_at', w.closed_at),
    'facts', (select jsonb_object_agg(key, value) from jsonb_each(hq_dup_card(ws)) where key in ('members', 'pcs', 'paid_invoices', 'paid_programs', 'last_activity', 'created_at')),
    'risks_accepted', (select coalesce(jsonb_agg(x ->> 'code'), '[]') from jsonb_array_elements(risks) x),
    'data_deleted', false));
  return json_build_object('closed', ws, 'duplicate_of', duplicate_of_ws);
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
    update billing_documents set doc = jsonb_set(doc, '{buyer,contact}', '{"name": "Removed person"}'::jsonb) where workspace_id = ws;
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
create policy rr_read on public.refund_requests for select to authenticated using (public.is_owner(workspace_id));
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

-- Customers: only the business's owner (with two-step sign-in) can ask for a refund or see them: they show amounts.
-- Admins run the team, not the bill.
create or replace function public.request_refund(ws uuid, for_what text, period text, invoice_ref text, amount numeric, currency text,
    reason_category text, explanation text, ticket uuid) returns json
  language plpgsql security definer set search_path = public as $$
begin
  if not is_owner(ws) then raise exception 'Only the business''s owner can ask for a refund.'; end if;
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
  from refund_requests f where public.is_owner(ws) and f.workspace_id = ws
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
    when 'bookings' then 'Bookings' when 'as_built' then 'As Built' when 'calls' then 'Riyeser Link' when 'estimate' then 'Riyeser Estimate' else m end
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
      base := greatest(coalesce((st ->> 'trial_ends')::date,
                                case when (st ->> 'starts_on_first_use')::boolean then current_date + 90 end, current_date), current_date);
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
    select array_agg(m) into mods from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) m
      where (module_state(ws, m) ->> 'status') = 'active';
    if mods is null then raise exception 'This business has no paid programs. Extend a trial instead.'; end if;
  else
    select array_agg(distinct m) into mods from unnest(coalesce(modules, '{}')) m where m in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls', 'estimate');
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
    -- invoices and payments (PayPal ids show only their last 6 characters)
    'billing', case when hq_can('licences.view') then hq_company_billing(ws) end,
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
      (select count(*) from devices d where d.workspace_id = w.id and public.pc_active(d)) as pcs,
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
  public.hq_change_owner(uuid, uuid, text, text), public.hq_set_business_status(uuid, text, text, text), public.hq_close_duplicate(uuid, uuid, text, text, text, boolean),
  public.hq_dup_card(uuid), public.hq_dup_risks(uuid, uuid), public.hq_dup_check(uuid), public.hq_dup_search(uuid, text),
  public.dup_keep_problem(uuid, workspaces),
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
  public.hq_set_business_status(uuid, text, text, text), public.hq_close_duplicate(uuid, uuid, text, text, text, boolean),
  public.hq_dup_check(uuid), public.hq_dup_search(uuid, text), public.hq_inactive_accounts(),
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
-- This PC's address (Link Office 1.2.0): the names phones and apps can use for the office PC (riyeser-office.local,
-- answered by the PC itself; the router's own name for it, when it checks out), which one desk phones are given, and
-- the last few address changes ({from, to, at}), so the Phones page can say "the PC's address changed".
alter table public.link_offices add column if not exists mdns_name text check (length(mdns_name) <= 80);
alter table public.link_offices add column if not exists router_name text check (length(router_name) <= 253);
alter table public.link_offices add column if not exists phone_server text check (length(phone_server) <= 253);
alter table public.link_offices add column if not exists address_changes jsonb not null default '[]';
alter table public.link_office_commands drop constraint if exists link_office_commands_kind_check;
alter table public.link_office_commands add constraint link_office_commands_kind_check
  check (kind in ('assign_phone', 'unassign_phone', 'add_phone', 'new_password', 'set_dnd', 'reveal_password', 'name_phone',
                  'bulk_phones', 'phone_action', 'phone_settings', 'relay_check'));
-- Many phones at once and each phone's own page (Link Office 1.2.3): a list of up to 500 phones fits in one change, so
-- "Add several phones" may be bigger than the other changes; what the office did comes back as a short summary (result:
-- { summary, added|done, skipped: [{mac, why}], failed: [{mac, why}] }). Phones also report whether they're ignored, their
-- firmware, when they connected and were last seen, whether they're a shared phone (Reception), and their own settings.
alter table public.link_office_commands drop constraint if exists link_office_commands_data_check;
alter table public.link_office_commands drop constraint if exists link_office_commands_data_size;
alter table public.link_office_commands add constraint link_office_commands_data_size
  check (length(data::text) < case when kind = 'bulk_phones' then 120000 else 4000 end);
alter table public.link_office_commands add column if not exists result jsonb check (result is null or length(result::text) < 20000);
alter table public.link_office_phones add column if not exists ignored boolean not null default false;
alter table public.link_office_phones add column if not exists firmware text check (length(firmware) <= 40);
alter table public.link_office_phones add column if not exists registered_since timestamptz;
alter table public.link_office_phones add column if not exists last_seen timestamptz;
alter table public.link_office_phones add column if not exists shared boolean not null default false;
alter table public.link_office_phones add column if not exists settings jsonb not null default '{}' check (length(settings::text) < 3000);

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
-- SEC-004: ...and for THIS office. An owner or admin may act for any of the business's offices. Someone else with a linked
-- PC only for a new office, one they reported from themselves, or one whose last reporter has left the business. So a
-- staff member can't read or answer another office's changes, overwrite its phone list or take its relay pass.
create or replace function public.link_office_acts_for(ws uuid, office text) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.link_office_caller_ok(ws) and (
    exists (select 1 from members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
    or not exists (select 1 from link_offices o where o.workspace_id = ws and o.office_id = office)
    or exists (select 1 from link_offices o where o.workspace_id = ws and o.office_id = office
               and (o.reported_by is null or o.reported_by = auth.uid()
                    or not exists (select 1 from members m where m.workspace_id = ws and m.user_id = o.reported_by))))
$$;
revoke all on function public.link_office_acts_for(uuid, text) from public, anon, authenticated;
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
    'mdns_name', o.mdns_name, 'router_name', o.router_name, 'phone_server', o.phone_server, 'address_changes', o.address_changes,
    'extensions', o.extensions, 'first_seen', o.first_seen, 'last_seen', o.last_seen,
    'phones', (select coalesce(json_agg(json_build_object('mac', p.mac, 'vendor', p.vendor, 'model', p.model, 'extension', p.extension,
        'assigned', p.assigned, 'registered', p.registered, 'last_registered', p.last_registered, 'ip', p.ip,
        'name', p.name, 'location', p.location, 'note', p.note, 'provisioned_at', p.provisioned_at,
        'ignored', p.ignored, 'firmware', p.firmware, 'registered_since', p.registered_since, 'last_seen', p.last_seen, 'shared', p.shared, 'settings', p.settings)
        order by p.assigned desc, p.ignored, p.extension, p.mac), '[]')
      from link_office_phones p where p.workspace_id = o.workspace_id and p.office_id = o.office_id))
$$;

-- A desk phone's own settings (Link Office 1.2.3), checked: only these keys, each a short plain value; up to 12
-- speed-dial keys ({type: 'speed', value: digits, label}). Anything else is left out. {} when there's nothing.
create or replace function public.link_phone_settings(j jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(j) <> 'object' then '{}'::jsonb else jsonb_strip_nulls(jsonb_build_object(
    'label', public.link_text(j -> 'label', 20), 'displayName', public.link_text(j -> 'displayName', 40),
    'timezone', case when j ->> 'timezone' ~ '^[+-]([0-9]|1[0-4])(:(00|30|45))?$' then j ->> 'timezone' end,
    'timeFormat', case when j ->> 'timeFormat' in ('12', '24') then j ->> 'timeFormat' end,
    'language', case when j ->> 'language' in ('English', 'French', 'Spanish', 'German', 'Portuguese', 'Chinese') then j ->> 'language' end,
    'ringtone', case when j ->> 'ringtone' ~ '^([1-9]|10)$' then (j ->> 'ringtone')::int end,
    'ringVolume', case when j ->> 'ringVolume' ~ '^([1-9]|1[0-5])$' then (j ->> 'ringVolume')::int end,
    'dnd', case when j ->> 'dnd' in ('person', 'off') then j ->> 'dnd' end,
    'lineKeys', (select nullif(jsonb_agg(jsonb_build_object('type', 'speed', 'value', k ->> 'value', 'label', coalesce(public.link_text(k -> 'label', 20), '')) order by i), '[]'::jsonb)
      from jsonb_array_elements(case when jsonb_typeof(j -> 'lineKeys') = 'array' then j -> 'lineKeys' else '[]' end) with ordinality x(k, i)
      where jsonb_typeof(k) = 'object' and k ->> 'value' ~ '^[0-9*#]{1,8}$' and i <= 12))) end
$$;

-- ---------------------------------------------------------------- Riyeser Link Office calls these
-- The heartbeat. Only the listed parts of the payload are kept, each checked and cut to size. Returns how many
-- changes are waiting, so the office can fetch them straight away.
create or replace function public.link_office_report(ws uuid, office_id text, payload jsonb) returns json
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare p jsonb := coalesce(payload, '{}'::jsonb); the_office text := link_office_report.office_id;
begin
  if not link_office_acts_for(ws, the_office) then
    raise exception 'Sign in to Riyeser Link Office as the business''s owner or an admin, or link this PC to the business in Riyeser Central.';
  end if;
  if the_office is null or the_office !~ '^[A-Za-z0-9-]{8,64}$' then raise exception 'That isn''t a Riyeser Link Office id.'; end if;
  if length(p::text) > 300000 then raise exception 'That report is too big.'; end if;
  perform link_sweep();
  insert into link_offices (workspace_id, office_id, pc_name, version, state, addresses, sip_port, address_stable, pc_mac, licence, counts, extensions, reported_by, last_seen,
    mdns_name, router_name, phone_server, address_changes)
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
        'in_call', coalesce(link_bool(e -> 'in_call'), false),   -- "On a call" in Riyeser Link (yes or no only: no numbers or call details)
        'members', link_int(e -> 'members')) order by e ->> 'extension')
      from (select e from jsonb_array_elements(case when jsonb_typeof(p -> 'extensions') = 'array' then p -> 'extensions' else '[]' end) e
            where jsonb_typeof(e) = 'object' and e ->> 'extension' ~ '^[0-9]{2,4}$' limit 1000) x), '[]'::jsonb),
    auth.uid(), now(),
    -- names: letters, digits, dots and dashes only; the address changes: up to 5, each an IPv4 from and to and a time
    case when link_text(p -> 'mdns_name', 80) ~ '^[A-Za-z0-9.-]+\.local$' then lower(link_text(p -> 'mdns_name', 80)) end,
    case when link_text(p -> 'router_name', 253) ~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' then lower(link_text(p -> 'router_name', 253)) end,
    case when link_text(p -> 'phone_server', 253) ~ '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' then lower(link_text(p -> 'phone_server', 253)) end,
    coalesce((select jsonb_agg(jsonb_build_object('from', c ->> 'from', 'to', c ->> 'to', 'at', link_time(c -> 'at')) order by i)
      from jsonb_array_elements(case when jsonb_typeof(p -> 'address_changes') = 'array' then p -> 'address_changes' else '[]' end) with ordinality x(c, i)
      where jsonb_typeof(c) = 'object' and c ->> 'from' ~ '^\d{1,3}(\.\d{1,3}){3}$' and c ->> 'to' ~ '^\d{1,3}(\.\d{1,3}){3}$' and i <= 5), '[]'::jsonb))
  on conflict (workspace_id, office_id) do update set pc_name = excluded.pc_name, version = excluded.version, state = excluded.state,
    addresses = excluded.addresses, sip_port = excluded.sip_port, address_stable = excluded.address_stable, pc_mac = excluded.pc_mac,
    licence = excluded.licence, counts = excluded.counts, extensions = excluded.extensions, reported_by = excluded.reported_by, last_seen = now(),
    mdns_name = excluded.mdns_name, router_name = excluded.router_name, phone_server = excluded.phone_server, address_changes = excluded.address_changes;
  -- the phones list is a copy of what the office has now (the office keeps the real list)
  delete from link_office_phones where workspace_id = ws and office_id = the_office;
  insert into link_office_phones (workspace_id, office_id, mac, vendor, model, extension, assigned, registered, last_registered, ip, name, location, note, provisioned_at,
    ignored, firmware, registered_since, last_seen, shared, settings)
  select distinct on (link_mac(ph ->> 'mac')) ws, the_office, link_mac(ph ->> 'mac'), link_text(ph -> 'vendor', 40), link_text(ph -> 'model', 60),
    case when ph ->> 'extension' ~ '^[0-9]{2,4}$' then ph ->> 'extension' end,
    coalesce(link_bool(ph -> 'assigned'), false), coalesce(link_bool(ph -> 'registered'), false), link_time(ph -> 'last_registered'),
    case when link_text(ph -> 'ip', 45) ~ '^[0-9a-fA-F.:]{3,45}$' then link_text(ph -> 'ip', 45) end,
    link_text(ph -> 'name', 40), link_text(ph -> 'location', 60), link_text(ph -> 'note', 60), link_time(ph -> 'provisioned_at'),
    coalesce(link_bool(ph -> 'ignored'), false) and not coalesce(link_bool(ph -> 'assigned'), false),
    case when link_text(ph -> 'firmware', 40) ~ '^[0-9A-Za-z._-]+$' then link_text(ph -> 'firmware', 40) end,
    link_time(ph -> 'registered_since'), link_time(ph -> 'last_seen'), coalesce(link_bool(ph -> 'shared'), false),
    public.link_phone_settings(ph -> 'settings')
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
  if not link_office_acts_for(ws, the_office) then raise exception 'Sign in to Riyeser Link Office as the business''s owner or an admin, or link this PC in Riyeser Central.'; end if;
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
  if c.id is null or not link_office_acts_for(c.workspace_id, c.office_id) then raise exception 'That change isn''t for this business.'; end if;
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

-- The same, with what the office did for "many phones at once" (1.2.3): a short summary the website shows.
create or replace function public.link_office_done(command uuid, ok boolean, error text, sealed text, result jsonb) returns void
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare c link_office_commands; r jsonb;
begin
  perform public.link_office_done(command, ok, error, sealed);
  select * into c from link_office_commands where id = command;
  if c.id is null or c.kind not in ('bulk_phones', 'phone_settings') or jsonb_typeof(result) <> 'object' then return; end if;
  r := jsonb_strip_nulls(jsonb_build_object('summary', public.link_text(result -> 'summary', 300),
    'added', public.link_int(result -> 'added'), 'done', public.link_int(result -> 'done'),
    'skipped', (select jsonb_agg(jsonb_build_object('mac', public.link_text(x -> 'mac', 40), 'why', public.link_text(x -> 'why', 120))) from (select x from jsonb_array_elements(case when jsonb_typeof(result -> 'skipped') = 'array' then result -> 'skipped' else '[]' end) x limit 100) y),
    'failed', (select jsonb_agg(jsonb_build_object('mac', public.link_text(x -> 'mac', 40), 'why', public.link_text(x -> 'why', 120))) from (select x from jsonb_array_elements(case when jsonb_typeof(result -> 'failed') = 'array' then result -> 'failed' else '[]' end) x limit 100) y),
    'applied', case when jsonb_typeof(result -> 'applied') = 'array' then (select jsonb_agg(public.link_text(a, 20)) from jsonb_array_elements(result -> 'applied') a) end));
  update link_office_commands set result = r where id = c.id;
  if public.link_text(r -> 'summary', 300) is not null then
    insert into audit_log (workspace_id, action, details) values (c.workspace_id, 'link.bulk_done', jsonb_build_object('summary', r ->> 'summary', 'office_id', c.office_id));
  end if;
end $$;

-- ---------------------------------------------------------------- the website and HQ call these
-- "Many phones at once" checked (internal): the action, the MAC addresses (or the rows to add), and its options.
create or replace function public.link_bulk_clean(ws uuid, d jsonb) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare act text := coalesce(d ->> 'action', ''); macs jsonb; rows jsonb; tomap jsonb := '{}'; k text; v jsonb; loc text;
begin
  if act not in ('add', 'give', 'shared', 'ignore', 'unignore', 'restart', 'resync', 'unassign', 'remove', 'location') then
    raise exception 'Riyeser Link Office doesn''t know how to do that.';
  end if;
  if act = 'add' then
    if jsonb_typeof(d -> 'rows') <> 'array' or jsonb_array_length(d -> 'rows') = 0 then raise exception 'Paste or import at least one MAC address.'; end if;
    if jsonb_array_length(d -> 'rows') > 500 then raise exception 'Add up to 500 phones at a time.'; end if;
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('line', i, 'macText', public.link_text(r -> 'macText', 40), 'model', public.link_text(r -> 'model', 60),
        'ext', case when r ->> 'ext' ~ '^[0-9]{3}$' then r ->> 'ext' end, 'person', public.link_text(r -> 'person', 80),
        'name', public.link_text(r -> 'name', 40), 'location', public.link_text(r -> 'location', 60))) order by i)
      into rows from jsonb_array_elements(d -> 'rows') with ordinality x(r, i) where jsonb_typeof(r) = 'object';
    return jsonb_strip_nulls(jsonb_build_object('action', act, 'rows', coalesce(rows, '[]'::jsonb), 'auto', coalesce(public.link_bool(d -> 'auto'), false),
      'shared', coalesce(public.link_bool(d -> 'shared'), false), 'start', case when d ->> 'start' ~ '^[0-9]{3}$' then d ->> 'start' end));
  end if;
  if jsonb_typeof(d -> 'macs') <> 'array' or jsonb_array_length(d -> 'macs') = 0 then raise exception 'Tick at least one phone.'; end if;
  if jsonb_array_length(d -> 'macs') > 500 then raise exception 'Change up to 500 phones at a time.'; end if;
  select jsonb_agg(distinct public.link_mac(m)) into macs from jsonb_array_elements_text(d -> 'macs') m where public.link_mac(m) is not null;
  if macs is null or jsonb_array_length(macs) <> jsonb_array_length(d -> 'macs') then
    raise exception 'That isn''t a MAC address. It''s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).';
  end if;
  if act = 'give' and jsonb_typeof(d -> 'to') = 'object' then
    for k, v in select * from jsonb_each(d -> 'to') loop
      if public.link_mac(k) is null or v #>> '{}' !~ '^[0-9]{3}$' then raise exception 'Choose who each phone is for.'; end if;
      tomap := tomap || jsonb_build_object(public.link_mac(k), v #>> '{}');
    end loop;
  end if;
  if act = 'location' then
    loc := nullif(trim(coalesce(d ->> 'location', '')), '');
    if loc is not null and not exists (select 1 from branches b where b.workspace_id = ws and b.name = loc) then raise exception 'Choose the location from your branches.'; end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('action', act, 'macs', macs, 'to', case when tomap <> '{}' then tomap end,
    'auto', case when act = 'give' then coalesce(public.link_bool(d -> 'auto'), false) end, 'start', case when d ->> 'start' ~ '^[0-9]{3}$' then d ->> 'start' end,
    'location', case when act = 'location' then coalesce(loc, '') end));
end $$;

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
  elsif kind = 'bulk_phones' then
    -- many phones at once (Link Office 1.2.3): one action for up to 500 phones, or "Add several phones" with up to 500 rows
    clean := public.link_bulk_clean(ws, d);
  elsif kind = 'phone_action' then
    if coalesce(d ->> 'action', '') not in ('restart', 'resync', 'find', 'ignore', 'unignore', 'remove', 'move') then raise exception 'Riyeser Link Office doesn''t know how to do that.'; end if;
    if mac is null then raise exception 'That isn''t a MAC address. It''s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).'; end if;
    clean := jsonb_build_object('mac', mac, 'action', d ->> 'action');
    if d ->> 'action' = 'move' then
      if ext is not null then clean := clean || jsonb_build_object('extension', ext);
      elsif public.link_text(d -> 'shared_name', 40) is not null then clean := clean || jsonb_build_object('shared_name', public.link_text(d -> 'shared_name', 40));
      else raise exception 'Choose who the phone is for, or a name for a shared phone.'; end if;
    end if;
  elsif kind = 'phone_settings' then
    if mac is null then raise exception 'That isn''t a MAC address. It''s 12 letters and numbers, on a sticker under the phone (like 00:15:65:12:34:56).'; end if;
    if jsonb_typeof(d -> 'settings') <> 'object' then raise exception 'Choose the phone''s settings.'; end if;
    clean := jsonb_build_object('mac', mac, 'settings', public.link_phone_settings(d -> 'settings'));
  elsif kind = 'relay_check' then
    -- 1.3.1: Sites & relay → Advanced checks, from the website (also on a phone): run a step of the relay checklist on this
    -- office's Link Office, a test call, or a fix. The result comes back with link_office_done (result).
    if coalesce(d ->> 'action', '') not in ('run_check', 'run_all', 'test_call', 'echo_test', 'retry_upnp', 'reregister', 'reset_pass', 'force_relay', 'details') then
      raise exception 'Riyeser Link Office doesn''t know how to do that.';
    end if;
    clean := jsonb_strip_nulls(jsonb_build_object('action', d ->> 'action',
      'step', case when d ->> 'step' ~ '^[a-z][a-z0-9-]{0,19}$' then d ->> 'step' end,
      'relay', case when d ->> 'relay' ~ '^[a-z0-9-]{2,40}$' then d ->> 'relay' end,
      'to_office', case when d ->> 'to_office' ~ '^[A-Za-z0-9_-]{4,80}$' then d ->> 'to_office' end,
      'extension', ext));
    if clean ->> 'action' = 'run_check' and clean ->> 'step' is null then raise exception 'Choose a step to check.'; end if;
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
            'action', clean ->> 'action', 'phones', case when kind = 'bulk_phones' then coalesce(jsonb_array_length(clean -> 'macs'), jsonb_array_length(clean -> 'rows')) end,
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
  return json_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'error', c.error, 'created_at', c.created_at, 'done_at', c.done_at, 'result', c.result,
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
  public.link_office_done(uuid, boolean, text, text, jsonb), public.link_phone_settings(jsonb), public.link_bulk_clean(uuid, jsonb),
  public.link_command(uuid, text, text, jsonb), public.link_command_state(uuid), public.link_reveal_take(uuid), public.link_status(uuid),
  public.link_support_allow(uuid), public.link_support_end(uuid), public.hq_company_link(uuid) from public, anon, authenticated;
grant execute on function public.link_office_report(uuid, text, jsonb), public.link_office_pending(uuid, text), public.link_office_done(uuid, boolean, text, text),
  public.link_office_done(uuid, boolean, text, text, jsonb),
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
      'phone_server', coalesce(o.phone_server, o.addresses[1]), 'mdns_name', o.mdns_name, 'router_name', o.router_name,
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
  return json_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'error', c.error, 'created_at', c.created_at, 'done_at', c.done_at, 'result', c.result,
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
-- Central sends this when it links the PC, at its daily check-in, and soon after its list of installed programs
-- changes (it installed or updated one, or one appeared on its home screen). Only for someone in the business, and only
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
  update devices d set programs = clean, programs_at = now(), last_seen = now(), retired_at = null, replaced_by = null
    where d.id = device and d.workspace_id = ws;
  perform retire_older_pcs(ws, device);
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
        'person', (select m.display_name from members m where m.workspace_id = ws and m.user_id = d.user_id),
        -- active: counted (not replaced by a newer link of the same PC, seen in 60 days); the others show as Older PCs
        'active', public.pc_active(d), 'retired_at', d.retired_at, 'replaced_by', d.replaced_by) order by public.pc_active(d) desc, d.last_seen desc), '[]')
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
  if mod is null or mod not in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls', 'estimate') then raise exception 'Choose a program.'; end if;
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
    from base b cross join unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built']) mm(m)
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
        'pcs', (select count(*) from devices d where d.workspace_id = o.id and public.pc_active(d)),
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
  mods text[] := array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built'];
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
        from unnest(mods || array['estimate']) mm(m) left join (company_modules c join workspaces w on w.id = c.workspace_id and w.status = 'active')
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
        from workspaces w cross join unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built']) mm(m)
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
    from workspaces w cross join unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built']) mm(m)
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
      -- PayPal couldn't take a payment (in its grace period), or PayPal stopped trying
      select 2, 'payment', o.workspace_id, case when o.status = 'suspended' then 'Payments stopped' else 'Payment failed' end,
        o.ref || ' · ' || public.billing_money(o.amount) || coalesce(' · works until ' || to_char(o.grace_until, 'FMDD Mon YYYY'), ''),
        'Finance', 'Review', o.ref, o.updated_at
      from billing_orders o where o.status in ('payment_failed', 'suspended') and hq_can('licences.view')
      union all
      -- a bank transfer invoice not marked paid yet
      select 3, 'invoice', o.workspace_id, case when o.due_date < current_date then 'Invoice overdue' else 'Invoice unpaid' end,
        o.ref || ' · ' || public.billing_money(coalesce(o.first_amount, o.amount)) || ' · due ' || to_char(o.due_date, 'FMDD Mon YYYY'),
        'Finance', 'Mark paid', o.ref, o.created_at
      from billing_orders o where o.method = 'bank' and o.status = 'pending' and hq_can('licences.view')
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
      'failed_payments', case when hq_can('licences.view') then (select count(*) from billing_orders where status in ('payment_failed', 'suspended')) end,
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
      exists (select 1 from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built']) mm(m)
              where (public.module_state(w.id, mm.m) ->> 'status') in ('trial', 'active')) as on_trial,
      exists (select 1 from devices dv where dv.workspace_id = w.id) as pc_linked,
      exists (select 1 from devices dv where dv.workspace_id = w.id and dv.programs_at is not null
              and exists (select 1 from jsonb_array_elements(dv.programs) p where p ->> 'id' <> 'central')) as program_used,
      exists (select 1 from company_modules c where c.workspace_id = w.id and c.status = 'active') as paying,
      (select coalesce(jsonb_agg(distinct p ->> 'id'), '[]') from devices dv, jsonb_array_elements(coalesce(dv.programs, '[]')) p where dv.workspace_id = w.id and public.pc_active(dv)) as installed,
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

-- Everyone's status in a business I'm in: link_presence, in "Riyeser Link: your status" below.
revoke all on function public.link_presence_set(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.link_presence_set(uuid, text, text, text, boolean) to authenticated;

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
  with check (user_id = auth.uid() and public.can_see_channel(channel_id)
              and public.calls_allowed((select workspace_id from public.channels where id = channel_id)));
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
-- 20 GB per business with Riyeser Link (trial or paid), plus any extra HQ grants (extra_storage_gb). While Link is off,
-- nothing new can be uploaded (files already there stay, and can still be opened).
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
-- The business's limit in bytes: 20 GB with Riyeser Link, plus extra granted by HQ.
create or replace function public.link_storage_limit(ws uuid) returns bigint
  language sql stable security definer set search_path = public as $$
  select (20 + coalesce((select extra_storage_gb from workspaces where id = ws), 0))::bigint * 1073741824
$$;
-- Is there room for a file of this many bytes? (anyone in the business; the app asks before it uploads)
create or replace function public.link_storage_fits(ws uuid, size bigint) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.calls_allowed(ws) and public.link_storage_used(ws) + greatest(coalesce(size, 0), 0) <= public.link_storage_limit(ws)
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

-- ===== Signed licences =====
-- Licences are signed with Ed25519 by the "licence" Edge Function (supabase/functions/licence in the Riyeser repo,
-- deployed by .github/workflows/deploy-licence-function.yml on main). It reads company_licence() as the signed-in
-- person, so only someone in the business gets its licence, and names the PC only when that PC is linked to the
-- business (Riyeser Central's link_device). Every Riyeser program then trusts a licence only with a good signature,
-- for its business and, when it names one, for its PC. The private key is only a function secret, never in here.
create or replace function public.licence_device_linked(ws uuid, device uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where workspace_id = ws and user_id = auth.uid())
     and exists (select 1 from devices where id = device and workspace_id = ws)
$$;
revoke all on function public.licence_device_linked(uuid, uuid) from public, anon;
grant execute on function public.licence_device_linked(uuid, uuid) to authenticated;

-- ===== Riyeser Link: the channel menu (rename, topic, members, mute, pin, leave, archive) =====
-- Whoever made a channel, or the business's owner or an admin, can rename it, change its topic and archive it.
-- Archiving hides a channel for everyone and makes it read-only; nothing is deleted and it can be brought back.
-- #general is for the whole team: it can't be archived, renamed or left. Mute and Leave are for each person.
alter table public.channels add column if not exists archived_at timestamptz;
alter table public.channels add column if not exists archived_by uuid references auth.users(id) on delete set null;

create table if not exists public.channel_prefs (      -- each person's own: muted, or left (an everyone channel)
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  muted boolean not null default false,
  left_at timestamptz,
  primary key (user_id, channel_id)
);
alter table public.channel_prefs enable row level security;
drop policy if exists cp_own on public.channel_prefs;
create policy cp_own on public.channel_prefs for select to authenticated using (user_id = auth.uid());
revoke all on public.channel_prefs from anon, authenticated;
grant select on public.channel_prefs to authenticated;          -- changed only through channel_mute / channel_leave / channel_rejoin

-- #general can't be archived or renamed, and there's only one.
create or replace function public.channels_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.kind = 'channel' and old.name = 'general' then
    if new.archived then raise exception '#general is where everyone in the team talks, so it can''t be archived.'; end if;
    if new.name is distinct from old.name then raise exception '#general keeps its name, so everyone can find it.'; end if;
  elsif new.kind = 'channel' and new.name = 'general' and (tg_op = 'INSERT' or old.name is distinct from 'general')
        and exists (select 1 from public.channels c where c.workspace_id = new.workspace_id and c.kind = 'channel' and c.name = 'general' and c.id <> new.id) then
    raise exception 'There''s already a #general. Choose another name.';
  end if;
  if tg_op = 'UPDATE' and new.archived is distinct from old.archived then
    new.archived_at := case when new.archived then now() end;
    new.archived_by := case when new.archived then auth.uid() end;
  end if;
  return new;
end $$;
drop trigger if exists channels_guard on public.channels;
create trigger channels_guard before insert or update on public.channels for each row execute function public.channels_guard();

-- An archived channel is read-only: no new messages, edits or reactions (owner-approved removal still anonymises).
create or replace function public.channel_open_guard() returns trigger language plpgsql as $$
begin
  if current_setting('riyeser.removing', true) = 'on' then return new; end if;
  if exists (select 1 from public.channels c where c.id = new.channel_id and c.archived) then
    raise exception 'This channel is archived, so it''s read-only. Whoever made it, or an owner or admin, can bring it back.';
  end if;
  return new;
end $$;
drop trigger if exists messages_open on public.messages;
create trigger messages_open before insert or update on public.messages for each row execute function public.channel_open_guard();
drop trigger if exists message_reactions_open on public.message_reactions;   -- after message_reactions_fill has found the channel
create trigger message_reactions_open before insert on public.message_reactions for each row execute function public.channel_open_guard();

-- Can the person asking rename, change the topic of, or archive this channel?
create or replace function public.channel_can_manage(ch uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from channels c where c.id = ch and c.kind in ('channel', 'private') and public.can_see_channel(ch)
                 and (c.created_by = auth.uid() or public.is_admin(c.workspace_id)))
$$;

-- Rename and/or change the topic. new_name null keeps the name; new_topic null keeps the topic ('' clears it).
create or replace function public.channel_rename(ch uuid, new_name text, new_topic text) returns void
  language plpgsql security definer set search_path = public as $$
declare c record; n text; t text;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'Direct messages don''t have a name to change.'; end if;
  if not channel_can_manage(ch) then
    raise exception 'Only whoever made this channel, or the owner or an admin, can change its name or topic.'; end if;
  if c.archived then raise exception 'This channel is archived. Bring it back first, then change it.'; end if;
  n := c.name; t := c.topic;
  if new_name is not null then
    n := regexp_replace(regexp_replace(lower(trim(new_name)), '^#+', ''), '\s+', '-', 'g');
    if n !~ '^[a-z0-9_-]{1,40}$' then
      raise exception 'Use up to 40 lowercase letters, numbers, - or _ for the name (no spaces), e.g. hill-rd-site.'; end if;
  end if;
  if new_topic is not null then
    t := nullif(trim(new_topic), '');
    if length(t) > 200 then raise exception 'Keep the topic under 200 characters.'; end if;
  end if;
  update channels set name = n, topic = t where id = ch;
  if n is distinct from c.name then
    insert into audit_log (workspace_id, action, details) values (c.workspace_id, 'channel.rename', jsonb_build_object('name', '#' || n, 'was', '#' || c.name));
  end if;
end $$;

-- Archive (hide for everyone, read-only, nothing deleted) or bring back.
create or replace function public.channel_archive(ch uuid, archive boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'Direct messages can''t be archived.'; end if;
  if not channel_can_manage(ch) then
    raise exception 'Only whoever made this channel, or the owner or an admin, can archive it or bring it back.'; end if;
  if c.archived = coalesce(archive, false) then return; end if;
  update channels set archived = coalesce(archive, false) where id = ch;
  insert into audit_log (workspace_id, action, details)
    values (c.workspace_id, case when archive then 'channel.archive' else 'channel.unarchive' end, jsonb_build_object('name', '#' || c.name));
end $$;

-- Mute: still there, but its unread messages don't add to your total or ring the bell.
create or replace function public.channel_mute(ch uuid, mute_on boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  insert into channel_prefs (user_id, channel_id, muted) values (auth.uid(), ch, coalesce(mute_on, false))
    on conflict (user_id, channel_id) do update set muted = excluded.muted;
end $$;

-- Leave: a private channel takes you out of it (someone who manages it can add you back); an everyone channel
-- goes from your list (Teams / Channels lets you join again). Not #general, and not a direct message.
create or replace function public.channel_leave(ch uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'You can''t leave a direct message. Mute it instead.'; end if;
  if c.kind = 'channel' and c.name = 'general' then raise exception '#general is for everyone in the team, so you can''t leave it. Mute it instead.'; end if;
  if c.kind = 'private' then
    if not exists (select 1 from channel_members where channel_id = ch and user_id <> auth.uid()) then
      raise exception 'You''re the only person in this channel. Add someone first, or archive it.'; end if;
    delete from channel_members where channel_id = ch and user_id = auth.uid();
  else
    insert into channel_prefs (user_id, channel_id, left_at) values (auth.uid(), ch, now())
      on conflict (user_id, channel_id) do update set left_at = now();
  end if;
end $$;

create or replace function public.channel_rejoin(ch uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from channels c where c.id = ch and c.kind = 'channel') or not can_see_channel(ch) then
    raise exception 'That channel isn''t there any more.'; end if;
  update channel_prefs set left_at = null where user_id = auth.uid() and channel_id = ch;
end $$;

revoke all on function public.channel_can_manage(uuid), public.channel_rename(uuid, text, text), public.channel_archive(uuid, boolean),
  public.channel_mute(uuid, boolean), public.channel_leave(uuid), public.channel_rejoin(uuid) from public, anon;
grant execute on function public.channel_can_manage(uuid), public.channel_rename(uuid, text, text), public.channel_archive(uuid, boolean),
  public.channel_mute(uuid, boolean), public.channel_leave(uuid), public.channel_rejoin(uuid) to authenticated;

-- ================================================================ Payments: PayPal subscriptions and bank transfer invoices
-- The business's owner pays on their Riyeser home ("Add to my plan / Pay"). The amount always comes from riyeser_bill
-- (the same price list as website/prices.mjs): each program's price, 3 users included, then the extra-user price each,
-- per program; yearly = 10 months; early bird = half for the first 12 months (the first 100 businesses to buy).
--  * PayPal (card or PayPal balance): the "paypal" Edge Function (supabase/functions/paypal on main) creates ONE PayPal
--    subscription for the whole plan, priced for this business (the plan's price is set per subscription), and PayPal's
--    webhooks come back through it to billing_paypal_event (service role only). Each event is applied once.
--  * Bank transfer: an invoice (number, US$ amount, due date, the reference to quote) with the bank details from the
--    Billing entity. HQ (licences.manage: Owner, Finance) marks it paid, which switches the programs on.
-- Paying never cuts a free trial short: paid time starts when the trial ends (or today, if it has already ended).
-- A failed PayPal payment keeps the programs working for a grace period (HQ setting billing.grace_days, 7) to a date the
-- owner is shown. Cancelling keeps everything until the end of what's paid. The licence tables (company_modules,
-- company_plans) are what Central's signed licence reads, so it picks the changes up by itself.
-- The seller's details ("Billing entity": name, address, ABN or tax number, email, bank details) are versioned: a change
-- adds a new version, and every invoice and payment keeps the version it was issued under, so old receipts keep the
-- old details. No tax is worked out here (ask an accountant about GST). Safe to re-run: it only adds what's missing.
create table if not exists public.billing_entities (
  id bigint generated always as identity primary key,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid
);
insert into public.billing_entities (details)
  select jsonb_build_object('name', 'Riyeser', 'address', '', 'tax_label', 'ABN', 'tax_number', '', 'email', 'info@riyeser.com',
    'bank', jsonb_build_object('account_name', '', 'bank_name', '', 'bsb', '', 'account_number', '', 'swift', '', 'note', ''))
  where not exists (select 1 from public.billing_entities);
create sequence if not exists public.billing_invoice_no start 10001;
create sequence if not exists public.billing_receipt_no start 10001;
create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ref text not null unique default ('RI-' || nextval('public.billing_invoice_no')),   -- the invoice number, and the reference to quote
  method text not null check (method in ('paypal', 'bank')),
  modules text[] not null,
  people int not null check (people between 1 and 10000),
  billing text not null check (billing in ('monthly', 'yearly')),
  amount numeric(12,2) not null check (amount > 0),          -- the regular price each month or year (US$)
  first_amount numeric(12,2),                                -- the early bird price, for early_cycles payments
  early_bird boolean not null default false,
  early_cycles int not null default 0,
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'pending' check (status in ('pending', 'active', 'payment_failed', 'suspended', 'cancelled', 'paid', 'void')),
  entity_id bigint references public.billing_entities(id),
  due_date date,
  paypal_subscription_id text unique,
  paypal_env text check (paypal_env in ('sandbox', 'live')),
  next_charge_at timestamptz,
  grace_until date,
  paid_through date,
  paid_at timestamptz,
  paid_reference text check (length(paid_reference) <= 200),
  marked_paid_by uuid,
  cancelled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_orders_ws on public.billing_orders (workspace_id, created_at desc);
-- Pricing v2: users per program ({module: count}), POS tills, and the bundle the price came from.
alter table public.billing_orders add column if not exists users jsonb;
alter table public.billing_orders add column if not exists tills int not null default 1;
alter table public.billing_orders add column if not exists bundle text;
-- The first charge (S10): the end of the free trial (or of what's paid), or today. PayPal starts billing then (start_time).
alter table public.billing_orders add column if not exists starts_on date;
create table if not exists public.billing_payments (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.billing_orders(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ref text unique,                                 -- the receipt number (completed payments only)
  method text not null check (method in ('paypal', 'bank')),
  status text not null check (status in ('completed', 'failed')),
  amount numeric(12,2),
  currency text not null default 'USD',
  provider_ref text unique,                        -- PayPal's sale id, or the invoice number for a bank transfer
  bank_reference text check (length(bank_reference) <= 200),
  entity_id bigint references public.billing_entities(id),
  period_to date,
  note text check (length(note) <= 500),
  at timestamptz not null default now()
);
create index if not exists billing_payments_ws on public.billing_payments (workspace_id, at desc);
-- Every PayPal webhook, once (PayPal sends some more than once): the event id is the key, so a repeat does nothing.
create table if not exists public.billing_events (
  event_id text primary key,
  event_type text not null,
  resource_id text,
  env text,
  received_at timestamptz not null default now(),
  result text
);
-- The customer's copy of every invoice and receipt, exactly as issued: the seller, the business and its contact, the
-- lines, the period, the amounts and how it was paid. Written once when it's issued, so later changes to prices or
-- details never alter it (only an owner-approved account removal blanks the contact person). The business's owner
-- sees it under Billing on Riyeser home; HQ (licences.view) opens it from the number and can send it again.
create table if not exists public.billing_documents (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('invoice', 'receipt')),
  ref text not null unique,                        -- RI-… (invoice) or RR-… (receipt)
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid references public.billing_orders(id) on delete cascade,
  payment_id bigint references public.billing_payments(id) on delete cascade,
  doc jsonb not null,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists billing_documents_ws on public.billing_documents (workspace_id, issued_at desc);
create unique index if not exists billing_documents_payment on public.billing_documents (payment_id) where payment_id is not null;
alter table public.billing_documents enable row level security;
revoke all on public.billing_documents from anon, authenticated;
create or replace function public.billing_documents_keep() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_setting('riyeser.removing', true) = 'on' then return new; end if;
  raise exception 'Invoices and receipts are kept exactly as issued.';
end $$;
drop trigger if exists billing_documents_keep on public.billing_documents;
create trigger billing_documents_keep before update or delete on public.billing_documents for each row execute function public.billing_documents_keep();
alter table public.billing_entities enable row level security;
alter table public.billing_orders enable row level security;
alter table public.billing_payments enable row level security;
alter table public.billing_events enable row level security;
revoke all on public.billing_entities, public.billing_orders, public.billing_payments, public.billing_events from anon, authenticated;
revoke all on sequence public.billing_invoice_no, public.billing_receipt_no from anon, authenticated;
-- Nothing about money is ever deleted (a business being removed cascades, as everything else does).
drop trigger if exists billing_payments_keep on public.billing_payments;
create trigger billing_payments_keep before delete on public.billing_payments for each row execute function public.no_delete();
drop trigger if exists billing_entities_keep on public.billing_entities;
create trigger billing_entities_keep before update or delete on public.billing_entities for each row execute function public.no_delete();

-- ---------------------------------------------------------------- helpers (not callable from the website)
-- The paid programs in a list, once each, in the usual order; Basics is dropped when Plus is there (Plus includes it).
create or replace function public.billing_mods(mods text[]) returns text[]
  language sql immutable set search_path = public as $$
  select coalesce(array_agg(u.m order by u.ord), '{}'::text[])
  from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built', 'estimate']) with ordinality u(m, ord)
  where u.m = any (coalesce(mods, '{}'::text[])) and not (u.m = 'basic' and 'plus' = any (mods))
$$;
-- "…AB12CD": PayPal's ids in HQ, all but the last 6 characters hidden.
create or replace function public.billing_mask(t text) returns text language sql immutable as $$
  select case when t is null then null when length(t) <= 6 then t else '…' || right(t, 6) end
$$;
create or replace function public.billing_money(n numeric) returns text language sql immutable as $$
  select 'US$' || to_char(coalesce(n, 0), 'FM999,999,990.00')
$$;
create or replace function public.billing_entity_now() returns billing_entities
  language sql stable security definer set search_path = public as $$
  select * from billing_entities order by id desc limit 1
$$;
-- What this business would pay: the regular amount, and the early bird price for its first 12 months if it has it
-- (or can still get it: fewer than 100 businesses have it and this one hasn't paid before).
-- users: {module: users} (anyone missing: people); Riyeser Link counts at least everyone in the business (the free
-- accountant left out). tills: POS checkout counters (1 included). Bundles are applied by riyeser_plan.
drop function if exists public.billing_terms(uuid, text[], int, text);
create or replace function public.billing_terms(ws uuid, mods text[], people int, billing_period text, users jsonb default null, tills int default 1) returns json
  language plpgsql stable security definer set search_path = public as $$
declare m text[] := billing_mods(mods); p int := least(greatest(coalesce(people, 3), 1), 500); regular numeric; half numeric;
  eb boolean := false; since date; months int; cycles int := 0; charge date; u jsonb := '{}'::jsonb; mx text; n int; plan jsonb;
  t int := least(greatest(coalesce(tills, 1), 1), 100);
begin
  if billing_period is null or billing_period not in ('monthly', 'yearly') then raise exception 'Choose monthly or yearly.'; end if;
  foreach mx in array m loop
    n := case when users is not null and jsonb_typeof(users) = 'object' and jsonb_typeof(users -> mx) = 'number' then (users ->> mx)::numeric::int else p end;
    n := least(greatest(n, 1), 500);
    if mx = 'calls' then n := greatest(n, link_people(ws)); end if;
    u := u || jsonb_build_object(mx, n);
  end loop;
  plan := riyeser_plan(m, p, u, t, 0, billing_period, false);
  regular := (plan ->> 'total')::numeric;
  -- When the first payment is due (S10): never during a free trial. The earliest of each program's trial end (or the end
  -- of what's already paid); today when one of them has nothing left. billing_extend counts paid time from the same dates.
  select coalesce(min(greatest(current_date, case when s ->> 'status' = 'trial' then (s ->> 'trial_ends')::date
      when s ->> 'status' in ('active', 'cancelled') and (s ->> 'active')::boolean then (s ->> 'paid_until')::date end)), current_date)
    into charge from (select module_state(ws, x) s from unnest(m) x) q;
  select early_bird_since into since from company_plans where workspace_id = ws and early_bird;
  if since is not null then eb := since > current_date - 365;
  else
    eb := (select count(*) from company_plans where early_bird) < 100
      and not exists (select 1 from billing_payments where workspace_id = ws and status = 'completed');
    since := current_date;
  end if;
  if eb and regular > 0 then
    half := (riyeser_plan(m, p, u, t, 0, billing_period, true) ->> 'total')::numeric;
    months := (extract(year from age(current_date, since)) * 12 + extract(month from age(current_date, since)))::int;
    cycles := case when billing_period = 'yearly' then 1 else greatest(1, 12 - months) end;
  else eb := false; end if;
  return json_build_object('modules', to_json(m), 'people', p, 'billing', billing_period, 'currency', 'USD', 'amount', regular,
    'early_bird', eb, 'first_amount', half, 'early_cycles', cycles, 'due_now', coalesce(half, regular),
    'charge_from', charge, 'charged_today', charge <= current_date,
    'users_included', riyeser_price('users_included'), 'extra_user', riyeser_price('extra_user'),
    'tills_included', riyeser_price('tills_included'), 'extra_till', riyeser_price('extra_till'),
    'users', u, 'tills', plan -> 'tills', 'bundle', plan ->> 'bundle', 'bundle_saves', (plan ->> 'bundle_saves')::numeric,
    'lines', plan -> 'lines');
end $$;

-- The owner of the business (signed in; two-step sign-in is only needed to cancel).
create or replace function public.billing_is_owner(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m join workspaces w on w.id = m.workspace_id
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner' and w.status = 'active')
$$;

-- One invoice / subscription for the website and HQ. masked: PayPal ids shortened (HQ).
create or replace function public.billing_order_json(o billing_orders, masked boolean) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', o.id, 'ref', o.ref, 'method', o.method, 'modules', to_json(o.modules),
    'module_names', (select json_agg(module_label(x)) from unnest(o.modules) x), 'people', o.people, 'billing', o.billing,
    'users', o.users, 'tills', o.tills, 'bundle', o.bundle,
    'amount', o.amount, 'first_amount', o.first_amount, 'early_bird', o.early_bird, 'early_cycles', o.early_cycles,
    'total', coalesce(o.first_amount, o.amount), 'currency', o.currency, 'status', o.status, 'due_date', o.due_date,
    'next_charge_at', o.next_charge_at, 'starts_on', o.starts_on,
    'next_amount', case when o.early_bird and (select count(*) from billing_payments p where p.order_id = o.id and p.status = 'completed') < o.early_cycles
                        then o.first_amount else o.amount end,
    'grace_until', o.grace_until, 'paid_through', o.paid_through, 'works_until', greatest(o.grace_until, o.paid_through), 'paid_at', o.paid_at, 'cancelled_at', o.cancelled_at, 'created_at', o.created_at,
    'paypal_env', o.paypal_env, 'paypal_id', case when masked then billing_mask(o.paypal_subscription_id) end,
    'paid_reference', case when masked then o.paid_reference end, 'marked_paid_by', case when masked then staff_name(o.marked_paid_by) end,
    'seller', (select e.details from billing_entities e where e.id = o.entity_id),
    'doc', (select d.doc from billing_documents d where d.order_id = o.id and d.kind = 'invoice' limit 1))
$$;
create or replace function public.billing_payment_json(p billing_payments, masked boolean) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', p.id, 'ref', p.ref, 'order_ref', o.ref, 'method', p.method, 'status', p.status, 'amount', p.amount,
    'currency', p.currency, 'at', p.at, 'period_to', p.period_to, 'note', p.note, 'modules', to_json(o.modules),
    'module_names', (select json_agg(module_label(x)) from unnest(o.modules) x), 'people', o.people, 'billing', o.billing,
    'provider_ref', case when masked then (case when p.method = 'paypal' then billing_mask(p.provider_ref) else p.bank_reference end) end,
    'period_from', case when p.period_to is not null then (p.period_to - case when o.billing = 'yearly' then interval '1 year' else interval '1 month' end)::date end,
    'seller', (select e.details from billing_entities e where e.id = p.entity_id),
    'doc', (select d.doc from billing_documents d where d.payment_id = p.id))
  from billing_orders o where o.id = p.order_id
$$;

-- ---------------------------------------------------------------- the customer's copy of each invoice and receipt
-- "Accounting Basics, Payroll · 1 person · monthly"
create or replace function public.billing_what(o billing_orders) returns text
  language sql stable security definer set search_path = public as $$
  select coalesce((select b.name || ': ' from riyeser_bundles() b where b.id = o.bundle), '')
    || array_to_string(array(select module_label(x) from unnest(o.modules) x), ', ') || ' · ' || o.people
    || case when o.people = 1 then ' person' else ' people' end || ' · ' || o.billing
$$;
-- The business as it is now (for a document being issued): its details and the owner as the contact person.
create or replace function public.billing_buyer(ws uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', w.name, 'legal_name', w.legal_name, 'address', w.address, 'tax_number', w.tax_number,
    'email', w.email, 'phone', w.phone, 'country', w.country, 'company_code', w.company_code,
    'contact', (select jsonb_build_object('name', m.display_name, 'email', u.email::text) from members m left join auth.users u on u.id = m.user_id
                where m.workspace_id = ws and m.role = 'owner' order by m.joined_at limit 1))
  from workspaces w where w.id = ws
$$;
-- An invoice's lines: each program at its price (people included, then extra people), and the early bird discount.
-- The same as the website's invoice; if the prices have changed since, one line with the amount on the invoice.
create or replace function public.billing_lines(o billing_orders) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare k int := case when o.billing = 'yearly' then 10 else 1 end; inc int := riyeser_price('users_included')::int;
  extra int; tills int; rows jsonb := '[]'::jsonb; tot numeric := 0; l jsonb; v numeric;
begin
  for l in select * from jsonb_array_elements(riyeser_plan(o.modules, o.people, o.users, o.tills, 0, 'monthly', false) -> 'lines') loop
    v := (l ->> 'monthly')::numeric * k; tot := tot + v; extra := (l ->> 'extra_users')::int; tills := (l ->> 'extra_tills')::int;
    rows := rows || jsonb_build_array(jsonb_build_object('text', (l ->> 'name')
      || case when l ? 'bundle' then ' (' || array_to_string(array(select module_label(y) from jsonb_array_elements_text(l -> 'modules') y), ', ') || ')' else '' end
      || case when extra > 0 then ', with ' || extra || ' extra ' || case when extra = 1 then 'user' else 'users' end || ' × ' || billing_money(riyeser_price('extra_user'))
              when l ->> 'module' = 'pos' then ', unlimited cashiers'
              else ', ' || inc || ' users included' || case when l ? 'bundle' then ' in each program' else '' end end
      || case when tills > 0 then ', ' || tills || ' extra ' || case when tills = 1 then 'till' else 'tills' end || ' × ' || billing_money(riyeser_price('extra_till')) else '' end
      || case when k = 10 then ' (a year: 10 months)' else ' (a month)' end, 'amount', v));
  end loop;
  if abs(tot - o.amount) > 0.005 then rows := jsonb_build_array(jsonb_build_object('text', 'Riyeser: ' || billing_what(o), 'amount', o.amount)); end if;
  if o.first_amount is not null and o.first_amount < o.amount then
    rows := rows || jsonb_build_array(jsonb_build_object('text', '🐣 Early bird: half price for the first 12 months', 'amount', o.first_amount - o.amount));
  end if;
  return rows;
end $$;
-- Who billing emails go to: the owner(s) and the business's own email, once each.
create or replace function public.billing_contacts(ws uuid) returns text[]
  language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct a), '{}'::text[]) from (
    select lower(u.email::text) a from members m join auth.users u on u.id = m.user_id where m.workspace_id = ws and m.role = 'owner'
    union select lower(trim(w.email)) from workspaces w where w.id = ws) x
  where a ~ '^[^@\s]+@[^@\s]+$'
$$;
-- "li…@pay.test": an address in the HQ history without keeping it whole.
create or replace function public.billing_mask_email(e text) returns text language sql immutable as $$
  select case when e is null or position('@' in e) = 0 then null else left(split_part(e, '@', 1), 2) || '…@' || split_part(e, '@', 2) end
$$;
-- The email for a document: its number, what it was for, the amount, and the link to view or print it.
create or replace function public.billing_doc_email(d jsonb, again boolean) returns text[]
  language sql stable security definer set search_path = public as $$
  select case when d ->> 'kind' = 'receipt' then array[
    case when again then 'Your Riyeser receipt ' || (d ->> 'ref') else 'Thanks, your Riyeser payment is in' end,
    case when again then 'Here is your receipt again.' else 'Thanks, we received your payment.' end
      || E'\n\nReceipt: ' || (d ->> 'ref')
      || E'\nAmount: ' || billing_money((d ->> 'total')::numeric) || ' by ' || case when d ->> 'method' = 'paypal' then 'PayPal' else 'bank transfer' end
      || E'\nFor: ' || (d ->> 'what')
      || coalesce(E'\nPeriod: ' || to_char((d ->> 'period_from')::date, 'FMDD Mon YYYY') || ' – ' || to_char((d ->> 'period_to')::date, 'FMDD Mon YYYY'), '')
      || coalesce(E'\nPaid until ' || to_char((d ->> 'period_to')::date, 'FMDD Month YYYY') || '.', '')
      || E'\n\nView or print your receipt (sign in as the business owner):\nhttps://riyeser.com/link/?receipt=' || (d ->> 'ref')]
  else array['Your Riyeser invoice ' || (d ->> 'ref'),
    'Invoice: ' || (d ->> 'ref') || E'\nAmount: ' || billing_money((d ->> 'total')::numeric)
      || coalesce(', due ' || to_char((d ->> 'due_date')::date, 'FMDD Month YYYY'), '')
      || E'\nFor: ' || (d ->> 'what')
      || E'\n\nPay by bank transfer and quote ' || (d ->> 'ref') || E' as the reference. The bank details are on the invoice:\nhttps://riyeser.com/link/?invoice=' || (d ->> 'ref')]
  end
$$;
-- Issue a bank transfer invoice's copy (once).
create or replace function public.billing_issue_invoice(oid uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o billing_orders;
begin
  select * into o from billing_orders where id = oid;
  if o.id is null or o.method <> 'bank' then return; end if;
  insert into billing_documents (kind, ref, workspace_id, order_id, doc, issued_at)
  values ('invoice', o.ref, o.workspace_id, o.id, jsonb_build_object('kind', 'invoice', 'ref', o.ref, 'issued_at', o.created_at, 'due_date', o.due_date,
    'seller', (select e.details from billing_entities e where e.id = o.entity_id), 'buyer', billing_buyer(o.workspace_id),
    'what', billing_what(o), 'modules', to_jsonb(o.modules), 'people', o.people, 'billing', o.billing,
    'lines', billing_lines(o), 'total', coalesce(o.first_amount, o.amount), 'regular_amount', o.amount, 'early_bird', o.early_bird,
    'currency', o.currency, 'method', 'bank', 'reference', o.ref), o.created_at)
  on conflict (ref) do nothing;
end $$;
-- Issue a receipt's copy (once) for a completed payment; send: email it to the owner(s) and the business's email.
create or replace function public.billing_issue_receipt(pid bigint, send boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare p billing_payments; o billing_orders; d jsonb; pf date; m text[]; a text;
begin
  select * into p from billing_payments where id = pid;
  if p.id is null or p.status <> 'completed' or p.ref is null then return; end if;
  select * into o from billing_orders where id = p.order_id;
  pf := case when p.period_to is not null then (p.period_to - case when o.billing = 'yearly' then interval '1 year' else interval '1 month' end)::date end;
  d := jsonb_build_object('kind', 'receipt', 'ref', p.ref, 'issued_at', p.at, 'order_ref', o.ref,
    'seller', (select e.details from billing_entities e where e.id = p.entity_id), 'buyer', billing_buyer(p.workspace_id),
    'what', billing_what(o), 'modules', to_jsonb(o.modules), 'people', o.people, 'billing', o.billing,
    'period_from', pf, 'period_to', p.period_to,
    'lines', jsonb_build_array(jsonb_build_object('text', 'Riyeser: ' || billing_what(o)
      || coalesce(', ' || to_char(pf, 'FMDD Mon YYYY') || ' – ' || to_char(p.period_to, 'FMDD Mon YYYY'), '')
      || case when p.amount < o.amount - 0.005 then ' (early bird)' else '' end, 'amount', p.amount)),
    'total', p.amount, 'currency', p.currency, 'method', p.method,
    'method_ref', case when p.method = 'paypal' then billing_mask(p.provider_ref) end);
  insert into billing_documents (kind, ref, workspace_id, order_id, payment_id, doc, issued_at)
  values ('receipt', p.ref, p.workspace_id, o.id, p.id, d, p.at) on conflict do nothing;
  if found and send then
    m := billing_doc_email(d, false);
    foreach a in array billing_contacts(p.workspace_id) loop perform queue_email(null, a, 'billing_paid', m[1], m[2], p.workspace_id, null, null); end loop;
  end if;
end $$;

-- Payment received: extend each program on the order by a month or a year. The first time, from the end of its free
-- trial (or today); after that, from the end of what's paid. Also the plan's people and billing period.
create or replace function public.billing_extend(oid uuid) returns date
  language plpgsql security definer set search_path = public as $$
declare o billing_orders; m text; st json; base date; upto date; latest date; step interval; cur date;
begin
  select * into o from billing_orders where id = oid for update;
  step := case when o.billing = 'yearly' then interval '1 year' else interval '1 month' end;
  foreach m in array o.modules loop
    st := module_state(o.workspace_id, m);
    if o.paid_through is not null then base := greatest(current_date, o.paid_through);
    else base := greatest(current_date,
        case when st ->> 'status' = 'trial' then (st ->> 'trial_ends')::date end,
        case when st ->> 'status' in ('active', 'cancelled') then (st ->> 'paid_until')::date end);
    end if;
    upto := (base + step)::date;
    select paid_until into cur from company_modules where workspace_id = o.workspace_id and module = m and status in ('active', 'cancelled');
    perform licence_set_module(o.workspace_id, m, 'active', null, greatest(upto, cur));
    latest := greatest(latest, upto);
  end loop;
  update billing_orders set paid_through = latest, grace_until = null, updated_at = now(),
    status = case when o.method = 'bank' then 'paid' when o.status = 'cancelled' then 'cancelled' else 'active' end,
    paid_at = coalesce(paid_at, now()) where id = oid;
  insert into company_plans (workspace_id, extra_users, billing, early_bird, early_bird_since, users, tills)
    values (o.workspace_id, greatest(0, o.people - 3), o.billing, o.early_bird, case when o.early_bird then current_date end, o.users,
            case when 'pos' = any (o.modules) then o.tills else 1 end)
  on conflict (workspace_id) do update set extra_users = greatest(company_plans.extra_users, excluded.extra_users), billing = excluded.billing,
    users = case when jsonb_typeof(excluded.users) = 'object' then coalesce(company_plans.users, '{}'::jsonb) || excluded.users else company_plans.users end,
    tills = case when 'pos' = any (o.modules) then excluded.tills else company_plans.tills end,
    early_bird = company_plans.early_bird or excluded.early_bird,
    early_bird_since = coalesce(company_plans.early_bird_since, excluded.early_bird_since), updated_at = now();
  return latest;
end $$;

-- Cancelled (by the owner, PayPal or HQ): the programs keep working until the end of what's paid, then stop.
create or replace function public.billing_apply_cancel(oid uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o billing_orders; m text; cur company_modules;
begin
  select * into o from billing_orders where id = oid for update;
  if o.id is null or o.status in ('cancelled', 'void') then return; end if;
  update billing_orders set status = case when o.status = 'pending' then 'void' else 'cancelled' end, cancelled_at = now(),
    next_charge_at = null, updated_at = now() where id = oid;
  if o.status = 'pending' then return; end if;
  foreach m in array o.modules loop
    continue when exists (select 1 from billing_orders x where x.workspace_id = o.workspace_id and x.id <> o.id
      and x.status in ('active', 'payment_failed', 'suspended') and m = any (x.modules));
    select * into cur from company_modules where workspace_id = o.workspace_id and module = m;
    if cur.status = 'active' then perform licence_set_module(o.workspace_id, m, 'cancelled', null, cur.paid_until); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- the owner (Riyeser home: Add to my plan / Pay, Billing)
-- The price for a plan, as the database works it out (the website shows the same).
drop function if exists public.billing_quote(uuid, text[], int, text);
create or replace function public.billing_quote(ws uuid, mods text[], people int, billing_period text, users jsonb default null, tills int default 1) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  if not billing_is_owner(ws) then raise exception 'Only the business owner can see prices and pay for Riyeser.'; end if;
  return billing_terms(ws, mods, people, billing_period, users, tills);
end $$;

-- Start paying: a PayPal subscription (the paypal function finishes it) or a bank transfer invoice.
drop function if exists public.billing_start(uuid, text[], int, text, text);
create or replace function public.billing_start(ws uuid, mods text[], people int, billing_period text, pay_method text, users jsonb default null, tills int default 1) returns json
  language plpgsql security definer set search_path = public as $$
declare t json; o billing_orders;
begin
  if not billing_is_owner(ws) then raise exception 'Only the business owner can pay for Riyeser.'; end if;
  if pay_method is null or pay_method not in ('paypal', 'bank') then raise exception 'Choose PayPal or bank transfer.'; end if;
  t := billing_terms(ws, mods, people, billing_period, users, tills);
  if (t ->> 'amount')::numeric <= 0 then raise exception 'Choose at least one paid program.'; end if;
  if pay_method = 'paypal' and exists (select 1 from billing_orders where workspace_id = ws and method = 'paypal'
      and status in ('active', 'payment_failed', 'suspended')) then
    raise exception 'You already pay by PayPal. To change your plan, cancel that subscription first (everything keeps working until the end of what you''ve paid), then pay for the new plan.';
  end if;
  if (select count(*) from billing_orders where workspace_id = ws and status = 'pending' and created_at > now() - interval '1 day') >= 20 then
    raise exception 'That''s a lot of tries today. Contact Riyeser and we''ll help.'; end if;
  -- a PayPal payment that was started but never approved is replaced by this one (and by a bank transfer invoice)
  update billing_orders set status = 'void', updated_at = now() where workspace_id = ws and method = 'paypal' and status = 'pending';
  insert into billing_orders (workspace_id, method, modules, people, billing, amount, first_amount, early_bird, early_cycles, entity_id, due_date, created_by, starts_on,
    users, tills, bundle)
  values (ws, pay_method, array(select json_array_elements_text(t -> 'modules')), (t ->> 'people')::int, billing_period,
    (t ->> 'amount')::numeric, (t ->> 'first_amount')::numeric, (t ->> 'early_bird')::boolean, (t ->> 'early_cycles')::int,
    (billing_entity_now()).id, case when pay_method = 'bank' then current_date + 14 end, auth.uid(), (t ->> 'charge_from')::date,
    (t -> 'users')::jsonb, coalesce(nullif((t ->> 'tills')::int, 0), 1), t ->> 'bundle')
  returning * into o;
  perform billing_issue_invoice(o.id);
  return billing_order_json(o, false);
end $$;

-- Billing on the owner's Riyeser home: the plan, the subscription or invoices, payments (receipts) and the seller.
create or replace function public.my_billing(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare cur billing_orders;
begin
  if not billing_is_owner(ws) then raise exception 'Only the business owner can see billing.'; end if;
  select * into cur from billing_orders where workspace_id = ws and method = 'paypal' and status in ('active', 'payment_failed', 'suspended', 'pending')
    order by (status = 'pending'), created_at desc limit 1;
  return json_build_object(
    'licence', licence_json(ws),
    'subscription', case when cur.id is not null then billing_order_json(cur, false) end,
    'orders', (select coalesce(json_agg(billing_order_json(o, false) order by o.created_at desc), '[]')
               from billing_orders o where o.workspace_id = ws and o.status <> 'void'),
    'payments', (select coalesce(json_agg(billing_payment_json(p, false) order by p.at desc), '[]')
                 from (select * from billing_payments where workspace_id = ws order by at desc limit 200) p),
    -- OWNER-PAYOFF: whether bank transfer can be offered (the bank numbers themselves only come with an invoice)
    'seller', (billing_entity_now()).details - 'bank',
    'bank_ready', coalesce(trim((billing_entity_now()).details #>> '{bank,account_number}'), '') <> '',
    'grace_days', hq_setting_num('billing.grace_days', 7),
    'paypal_manage_url', case when coalesce(cur.paypal_env, (select value from hq_settings where key = 'paypal.env')) = 'sandbox'
      then 'https://www.sandbox.paypal.com/myaccount/autopay/' else 'https://www.paypal.com/myaccount/autopay/' end);
end $$;

-- Cancel the PayPal subscription (the owner, with two-step sign-in). Returns what the paypal function needs to tell PayPal.
create or replace function public.billing_cancel_start(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare o billing_orders;
begin
  if not is_owner(ws) then
    if billing_is_owner(ws) then raise exception 'Turn on two-step sign-in (🔐 Security) to cancel. It keeps your business safe.'; end if;
    raise exception 'Only the business owner can cancel.';
  end if;
  select * into o from billing_orders where workspace_id = ws and method = 'paypal' and status in ('active', 'payment_failed', 'suspended')
    order by created_at desc limit 1;
  if o.id is null or o.paypal_subscription_id is null then raise exception 'There''s no PayPal subscription to cancel.'; end if;
  return json_build_object('order_id', o.id, 'subscription_id', o.paypal_subscription_id, 'env', o.paypal_env, 'paid_through', greatest(o.grace_until, o.paid_through));
end $$;

-- Cancel a bank transfer invoice that hasn't been paid (the owner).
create or replace function public.billing_cancel_invoice(ws uuid, invoice_ref text) returns void
  language plpgsql security definer set search_path = public as $$
declare o billing_orders;
begin
  if not billing_is_owner(ws) then raise exception 'Only the business owner can do that.'; end if;
  select * into o from billing_orders where workspace_id = ws and ref = invoice_ref and method = 'bank';
  if o.id is null then raise exception 'That invoice isn''t there.'; end if;
  if o.status <> 'pending' then raise exception 'That invoice is already paid or cancelled.'; end if;
  update billing_orders set status = 'void', cancelled_at = now(), updated_at = now() where id = o.id;
end $$;

-- ---------------------------------------------------------------- the paypal Edge Function (service role only)
-- The subscription PayPal made for an invoice.
create or replace function public.billing_paypal_created(order_id uuid, subscription_id text, env text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if env not in ('sandbox', 'live') or coalesce(subscription_id, '') !~ '^[A-Za-z0-9-]{6,64}$' then raise exception 'bad subscription'; end if;
  update billing_orders set paypal_subscription_id = subscription_id, paypal_env = env, updated_at = now()
    where id = order_id and method = 'paypal' and status = 'pending' and paypal_subscription_id is null;
  if not found then raise exception 'That payment isn''t waiting for PayPal.'; end if;
  insert into hq_settings (key, value) values ('paypal.env', env) on conflict (key) do update set value = excluded.value;
end $$;
-- The cancel went through at PayPal.
create or replace function public.billing_paypal_cancelled(order_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare o billing_orders;
begin
  select * into o from billing_orders where id = order_id;
  if o.id is null then return; end if;
  perform billing_apply_cancel(o.id);
  perform queue_email_owners(o.workspace_id, 'billing_cancelled', 'Your Riyeser subscription is cancelled',
    'Your PayPal subscription for ' || array_to_string(array(select module_label(x) from unnest(o.modules) x), ', ') || ' is cancelled. Nothing more will be charged.'
    || case when o.paid_through is not null then E'\n\nEverything keeps working until ' || to_char(greatest(o.grace_until, o.paid_through), 'FMDD Month YYYY') || '. Nothing is deleted.' else '' end);
end $$;
-- Its product and plan ids at PayPal (made once per sandbox/live by the function).
create or replace function public.billing_paypal_config(env text) returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(substr(key, length('paypal.' || env || '.') + 1), value), '{}')
  from hq_settings where key like 'paypal.' || env || '.%'
$$;
create or replace function public.billing_paypal_config_set(env text, k text, v text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if env not in ('sandbox', 'live') or k !~ '^(product|plan\.(monthly|yearly)(\.eb)?)$' then raise exception 'bad setting'; end if;
  insert into hq_settings (key, value) values ('paypal.' || env || '.' || k, v) on conflict (key) do update set value = excluded.value;
end $$;

-- Paying by PayPal replaces an open bank transfer invoice for the same programs (S10): once PayPal has the subscription
-- (activated or paid), those invoices are cancelled, so nobody is asked to pay twice. Returns the invoice numbers.
create or replace function public.billing_void_replaced(oid uuid) returns text[]
  language plpgsql security definer set search_path = public as $$
declare o billing_orders; refs text[];
begin
  select * into o from billing_orders where id = oid;
  if o.id is null or o.method <> 'paypal' then return '{}'; end if;
  with v as (update billing_orders set status = 'void', cancelled_at = now(), updated_at = now()
    where workspace_id = o.workspace_id and method = 'bank' and status = 'pending' and id <> o.id and modules <@ o.modules returning ref)
  select coalesce(array_agg(ref order by ref), '{}') into refs from v;
  if cardinality(refs) > 0 then
    perform queue_email_owners(o.workspace_id, 'billing_invoice_replaced', 'Your Riyeser invoice ' || array_to_string(refs, ', ') || ' is cancelled',
      'You now pay for ' || array_to_string(array(select module_label(x) from unnest(o.modules) x), ', ') || ' by PayPal, so the bank transfer invoice '
      || array_to_string(refs, ', ') || E' for the same programs is cancelled. There''s nothing to pay on it.\n\nIf you already sent the money, reply to this email and we''ll sort it out.');
  end if;
  return refs;
end $$;
revoke all on function public.billing_void_replaced(uuid) from public, anon, authenticated;

-- One PayPal webhook (its signature already checked by the function). Each event id is applied once only.
-- Returns what happened: 'duplicate', 'ignored', 'unknown subscription', 'activated', 'paid', 'amount mismatch',
-- 'payment failed', 'suspended', 'cancelled'.
create or replace function public.billing_paypal_event(event_id text, event_type text, resource jsonb, env text) returns text
  language plpgsql security definer set search_path = public as $$
declare sub text; o billing_orders; res text; amt numeric; curr text; nb timestamptz; g date; m text; upto date; cm company_modules;
begin
  if coalesce(event_id, '') = '' or coalesce(event_type, '') = '' then raise exception 'bad event'; end if;
  insert into billing_events (event_id, event_type, resource_id, env) values (event_id, event_type, left(resource ->> 'id', 80), env)
    on conflict do nothing;
  if not found then return 'duplicate'; end if;
  insert into hq_settings (key, value) values ('paypal.last_webhook_at', now()::text), ('paypal.last_webhook_type', event_type)
    on conflict (key) do update set value = excluded.value;
  if env in ('sandbox', 'live') then insert into hq_settings (key, value) values ('paypal.env', env) on conflict (key) do update set value = excluded.value; end if;

  sub := case when event_type like 'PAYMENT.SALE.%' then resource ->> 'billing_agreement_id' else resource ->> 'id' end;
  select * into o from billing_orders where paypal_subscription_id = sub;
  if o.id is null and event_type like 'BILLING.SUBSCRIPTION.%' and coalesce(resource ->> 'custom_id', '') ~ '^[0-9a-f-]{36}$' then
    update billing_orders set paypal_subscription_id = sub, paypal_env = env where id = (resource ->> 'custom_id')::uuid
      and method = 'paypal' and paypal_subscription_id is null returning * into o;
  end if;
  if event_type not in ('BILLING.SUBSCRIPTION.ACTIVATED', 'PAYMENT.SALE.COMPLETED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED') then res := 'ignored';
  elsif o.id is null then res := 'unknown subscription';
  else
    nb := nullif(resource #>> '{billing_info,next_billing_time}', '')::timestamptz;
    if event_type = 'BILLING.SUBSCRIPTION.ACTIVATED' then
      update billing_orders set status = case when status in ('pending', 'suspended') then 'active' else status end,
        next_charge_at = coalesce(nb, next_charge_at), updated_at = now() where id = o.id;
      perform billing_void_replaced(o.id);
      res := 'activated';
    elsif event_type = 'PAYMENT.SALE.COMPLETED' then
      amt := nullif(resource #>> '{amount,total}', '')::numeric; curr := resource #>> '{amount,currency}';
      if amt is null or curr is distinct from 'USD' or amt < coalesce(o.first_amount, o.amount) - 0.005 then
        insert into billing_payments (order_id, workspace_id, method, status, amount, currency, provider_ref, entity_id, note)
          values (o.id, o.workspace_id, 'paypal', 'failed', amt, coalesce(curr, '?'), resource ->> 'id', o.entity_id,
                  'The amount didn''t match the plan, so nothing was switched on. Check it in PayPal.')
          on conflict (provider_ref) do nothing;
        res := 'amount mismatch';
      else
        insert into billing_payments (order_id, workspace_id, method, status, amount, currency, provider_ref, entity_id, ref)
          values (o.id, o.workspace_id, 'paypal', 'completed', amt, curr, resource ->> 'id', o.entity_id, 'RR-' || nextval('billing_receipt_no'))
          on conflict (provider_ref) do nothing;
        if found then
          upto := billing_extend(o.id);
          update billing_payments set period_to = upto where provider_ref = resource ->> 'id';
          -- every payment: the customer's copy of the receipt, and an email with its number, what it was for and a link
          perform billing_issue_receipt((select id from billing_payments where provider_ref = resource ->> 'id'), true);
          perform billing_void_replaced(o.id);
          res := 'paid';
        else res := 'duplicate payment'; end if;
      end if;
      update billing_orders set next_charge_at = coalesce(nb, next_charge_at) where id = o.id;
    elsif event_type = 'BILLING.SUBSCRIPTION.PAYMENT.FAILED' then
      g := current_date + hq_setting_num('billing.grace_days', 7)::int;
      update billing_orders set status = case when status = 'cancelled' then status else 'payment_failed' end,
        grace_until = greatest(coalesce(grace_until, g), g), next_charge_at = coalesce(nb, next_charge_at), updated_at = now() where id = o.id;
      foreach m in array o.modules loop
        select * into cm from company_modules where workspace_id = o.workspace_id and module = m;
        if cm.status = 'active' and cm.paid_until < g then perform licence_set_module(o.workspace_id, m, 'active', null, g); end if;
      end loop;
      insert into billing_payments (order_id, workspace_id, method, status, amount, currency, provider_ref, entity_id, note)
        values (o.id, o.workspace_id, 'paypal', 'failed', nullif(resource #>> '{billing_info,last_failed_payment,amount,value}', '')::numeric, 'USD',
                'failed:' || event_id, o.entity_id, 'PayPal couldn''t take the payment.');
      perform queue_email_owners(o.workspace_id, 'billing_failed', 'Your Riyeser payment didn''t go through',
        'PayPal couldn''t take your Riyeser payment. Everything keeps working until ' || to_char(g, 'FMDD Month YYYY')
        || E'.\n\nPlease check the card or PayPal account you pay with (PayPal tries again by itself), or pay by bank transfer from your Riyeser home page, under Billing.');
      res := 'payment failed';
    elsif event_type = 'BILLING.SUBSCRIPTION.SUSPENDED' then
      update billing_orders set status = case when status = 'cancelled' then status else 'suspended' end, next_charge_at = null, updated_at = now() where id = o.id;
      res := 'suspended';
    else   -- CANCELLED or EXPIRED
      perform billing_apply_cancel(o.id); res := 'cancelled';
    end if;
  end if;
  update billing_events set result = res where billing_events.event_id = billing_paypal_event.event_id;
  return res;
end $$;

-- ---------------------------------------------------------------- HQ
-- Payments, invoices and PayPal's state: failed payments and unpaid invoices first. PayPal ids show only their last 6.
create or replace function public.hq_billing() returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['licences.view']);
  return json_build_object(
    'failed', (select coalesce(json_agg(billing_order_json(o, true)::jsonb || jsonb_build_object('business', w.name, 'workspace_id', w.id) order by o.updated_at desc), '[]')
      from billing_orders o join workspaces w on w.id = o.workspace_id where o.status in ('payment_failed', 'suspended')),
    'unpaid', (select coalesce(json_agg(billing_order_json(o, true)::jsonb || jsonb_build_object('business', w.name, 'workspace_id', w.id) order by o.due_date), '[]')
      from billing_orders o join workspaces w on w.id = o.workspace_id where o.method = 'bank' and o.status = 'pending'),
    'payments', (select coalesce(json_agg(billing_payment_json(p, true)::jsonb || jsonb_build_object('business', w.name, 'workspace_id', w.id) order by p.at desc), '[]')
      from (select * from billing_payments order by at desc limit 100) p join workspaces w on w.id = p.workspace_id),
    'paypal', json_build_object('env', (select value from hq_settings where key = 'paypal.env'),
      'last_webhook_at', (select value from hq_settings where key = 'paypal.last_webhook_at'),
      'last_webhook_type', (select value from hq_settings where key = 'paypal.last_webhook_type'),
      'events_7d', (select count(*) from billing_events where received_at > now() - interval '7 days'),
      'subscriptions', (select count(*) from billing_orders where method = 'paypal' and status in ('active', 'payment_failed', 'suspended'))),
    'entity', (billing_entity_now()).details,
    'bank_ready', coalesce(nullif(trim((billing_entity_now()).details #>> '{bank,account_number}'), ''), '') <> '',
    'grace_days', hq_setting_num('billing.grace_days', 7),
    'can_mark_paid', hq_can('licences.manage'), 'can_edit_entity', hq_can('settings.manage') or hq_can('licences.manage'));
end $$;
-- This business's invoices and payments (the customer page, Money tab).
create or replace function public.hq_company_billing(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform hq_need(array['licences.view']);
  return json_build_object(
    'orders', (select coalesce(json_agg(billing_order_json(o, true) order by o.created_at desc), '[]') from billing_orders o where o.workspace_id = ws and o.status <> 'void'),
    'payments', (select coalesce(json_agg(billing_payment_json(p, true) order by p.at desc), '[]') from billing_payments p where p.workspace_id = ws),
    'contacts', to_json(billing_contacts(ws)),   -- where invoices and receipts are emailed (the owners and the business's email)
    'can_mark_paid', hq_can('licences.manage'));
end $$;
-- A bank transfer came in: mark its invoice paid (Owner, Finance), which switches the programs on. In the HQ history.
create or replace function public.hq_billing_mark_paid(invoice_ref text, bank_reference text, paid_amount numeric) returns json
  language plpgsql security definer set search_path = public as $$
declare o billing_orders; upto date; rcpt text;
begin
  perform hq_need(array['licences.manage']);
  select * into o from billing_orders where ref = upper(trim(coalesce(invoice_ref, ''))) for update;
  if o.id is null or o.method <> 'bank' then raise exception 'There''s no bank transfer invoice with that number.'; end if;
  if o.status <> 'pending' then raise exception 'That invoice is already %.', case when o.status = 'paid' then 'paid' else 'cancelled' end; end if;
  if length(trim(coalesce(bank_reference, ''))) < 3 then raise exception 'Type the bank''s reference for the payment (from your bank statement).'; end if;
  if paid_amount is null or paid_amount < coalesce(o.first_amount, o.amount) - 0.005 then
    raise exception 'The invoice is for %. Check the amount on the bank statement.', billing_money(coalesce(o.first_amount, o.amount)); end if;
  rcpt := 'RR-' || nextval('billing_receipt_no');
  insert into billing_payments (order_id, workspace_id, method, status, amount, currency, provider_ref, bank_reference, entity_id, ref)
    values (o.id, o.workspace_id, 'bank', 'completed', paid_amount, 'USD', 'bank:' || o.ref, trim(bank_reference), o.entity_id, rcpt);
  upto := billing_extend(o.id);
  update billing_orders set paid_reference = trim(bank_reference), marked_paid_by = auth.uid() where id = o.id;
  update billing_payments set period_to = upto where ref = rcpt;
  perform hq_log('billing.bank_paid', jsonb_build_object('workspace_id', o.workspace_id, 'invoice', o.ref, 'receipt', rcpt,
    'amount', paid_amount, 'paid_until', upto));
  perform billing_issue_receipt((select id from billing_payments where ref = rcpt), true);
  return json_build_object('receipt', rcpt, 'paid_until', upto);
end $$;
-- The Billing entity: who sells Riyeser (on every invoice and receipt). Each change is a new version.
create or replace function public.hq_set_billing_entity(details jsonb) returns void
  language plpgsql security definer set search_path = public as $$
declare d jsonb; b jsonb := coalesce(details -> 'bank', '{}'::jsonb); k text; cur jsonb := (billing_entity_now()).details;
  t text := '';
begin
  if not (hq_can('settings.manage') or hq_can('licences.manage')) then perform hq_need(array['settings.manage']); end if;
  if length(trim(coalesce(details ->> 'name', ''))) < 2 then raise exception 'Type the business name that sells Riyeser.'; end if;
  d := jsonb_build_object('name', '', 'address', '', 'tax_label', 'ABN', 'tax_number', '', 'email', '');
  foreach k in array array['name', 'address', 'tax_label', 'tax_number', 'email'] loop
    t := left(trim(coalesce(details ->> k, '')), case when k = 'address' then 300 else 120 end);
    d := d || jsonb_build_object(k, case when k = 'tax_label' and t = '' then 'ABN' else t end);
  end loop;
  d := d || jsonb_build_object('bank', (select jsonb_object_agg(x, left(trim(coalesce(b ->> x, '')), case when x = 'note' then 300 else 80 end))
         from unnest(array['account_name', 'bank_name', 'bsb', 'account_number', 'swift', 'note']) x));
  if d = cur then return; end if;
  insert into billing_entities (details, created_by) values (d, auth.uid());
  perform hq_log('billing.entity_changed', jsonb_build_object('name', d ->> 'name', 'bank_set', coalesce(d #>> '{bank,account_number}', '') <> ''));
end $$;

-- HQ: send an invoice or receipt again, to the business's billing emails (licences.view), or to another address
-- (a wrong email); update_contact also makes that the business's email (customers.edit or licences.manage). In the HQ history: who,
-- which document, when, and where to (the address shortened; the full one is on the email itself, in Emails).
create or replace function public.hq_billing_resend(doc_ref text, to_email text, update_contact boolean) returns json
  language plpgsql security definer set search_path = public as $$
declare d billing_documents; addr text := lower(trim(coalesce(to_email, ''))); sent text[]; a text; m text[];
begin
  perform hq_need(array['licences.view']);
  select * into d from billing_documents where ref = upper(trim(coalesce(doc_ref, '')));
  if d.id is null then raise exception 'There''s no invoice or receipt with that number.'; end if;
  if addr <> '' then
    if addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(addr) > 120 then raise exception 'Check the email address.'; end if;
    if coalesce(update_contact, false) then
      perform hq_need(array['customers.edit', 'licences.manage']);
      update workspaces set email = addr where id = d.workspace_id;
    end if;
    sent := array[addr];
  else
    sent := billing_contacts(d.workspace_id);
    if cardinality(sent) = 0 then raise exception 'This business has no email to send it to. Use "Send to a different email".'; end if;
  end if;
  m := billing_doc_email(d.doc, true);
  foreach a in array sent loop perform queue_email(null, a, 'billing_resend', m[1], m[2], d.workspace_id, null, null); end loop;
  perform hq_log('billing.doc_resent', jsonb_build_object('workspace_id', d.workspace_id, 'ref', d.ref, 'kind', d.kind,
    'to', (select jsonb_agg(billing_mask_email(x)) from unnest(sent) x), 'other_address', addr <> '',
    'contact_updated', addr <> '' and coalesce(update_contact, false)));
  return json_build_object('ref', d.ref, 'to', to_json(sent), 'contact_updated', addr <> '' and coalesce(update_contact, false));
end $$;
-- HQ Overview: payments received in the last few days (count and US$ total). Read only.
create or replace function public.hq_payments_received(days int) returns json
  language plpgsql stable security definer set search_path = public as $$
declare n int := least(greatest(coalesce(days, 7), 1), 366);
begin
  perform hq_need(array['licences.view']);
  return (select json_build_object('days', n, 'count', count(*), 'total', coalesce(sum(amount), 0))
    from billing_payments where status = 'completed' and currency = 'USD' and at > now() - make_interval(days => n));
end $$;
-- Once: the customer's copy of invoices and receipts issued before copies were kept (from what's stored for them).
do $$ declare r record; begin
  for r in select o.id from billing_orders o where o.method = 'bank' and o.status <> 'void'
      and not exists (select 1 from billing_documents d where d.ref = o.ref) order by o.created_at loop
    perform billing_issue_invoice(r.id);
  end loop;
  for r in select p.id from billing_payments p where p.status = 'completed' and p.ref is not null
      and not exists (select 1 from billing_documents d where d.payment_id = p.id) order by p.at loop
    perform billing_issue_receipt(r.id, false);
  end loop;
end $$;

-- ---------------------------------------------------------------- who can call what
revoke all on function public.billing_mods(text[]), public.billing_mask(text), public.billing_money(numeric), public.billing_entity_now(),
  public.billing_terms(uuid, text[], int, text, jsonb, int), public.billing_is_owner(uuid), public.billing_order_json(billing_orders, boolean),
  public.billing_payment_json(billing_payments, boolean), public.billing_extend(uuid), public.billing_apply_cancel(uuid),
  public.billing_quote(uuid, text[], int, text, jsonb, int), public.billing_start(uuid, text[], int, text, text, jsonb, int), public.my_billing(uuid),
  public.billing_cancel_start(uuid), public.billing_cancel_invoice(uuid, text),
  public.billing_paypal_created(uuid, text, text), public.billing_paypal_cancelled(uuid), public.billing_paypal_config(text),
  public.billing_paypal_config_set(text, text, text), public.billing_paypal_event(text, text, jsonb, text),
  public.hq_billing(), public.hq_company_billing(uuid), public.hq_billing_mark_paid(text, text, numeric), public.hq_set_billing_entity(jsonb),
  public.billing_what(billing_orders), public.billing_buyer(uuid), public.billing_lines(billing_orders), public.billing_contacts(uuid),
  public.billing_mask_email(text), public.billing_doc_email(jsonb, boolean), public.billing_issue_invoice(uuid), public.billing_issue_receipt(bigint, boolean),
  public.hq_billing_resend(text, text, boolean), public.hq_payments_received(int)
  from public, anon, authenticated;
grant execute on function public.billing_quote(uuid, text[], int, text, jsonb, int), public.billing_start(uuid, text[], int, text, text, jsonb, int), public.my_billing(uuid),
  public.billing_cancel_start(uuid), public.billing_cancel_invoice(uuid, text),
  public.hq_billing(), public.hq_company_billing(uuid), public.hq_billing_mark_paid(text, text, numeric), public.hq_set_billing_entity(jsonb),
  public.hq_billing_resend(text, text, boolean), public.hq_payments_received(int) to authenticated;
-- Only the paypal Edge Function (Supabase's service role) records PayPal's side.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.billing_paypal_created(uuid, text, text), public.billing_paypal_cancelled(uuid), public.billing_paypal_config(text),
      public.billing_paypal_config_set(text, text, text), public.billing_paypal_event(text, text, jsonb, text) to service_role;
  end if;
end $$;

-- ================================================================ Website traffic (riyeser.com visits, for HQ Reports)
-- Riyeser's own, privacy-friendly website analytics. The website's pages send one small note per page view to
-- track_visit (with the publishable key; nothing else can write here). What's kept: when, the page, the website that
-- linked to it (its name only), utm_source/medium/campaign, phone/tablet/desktop, the browser's name, the language and a
-- rough region from the time zone. Never an IP address, the full browser details, cookies or anything that follows a
-- person between visits: the "session" is a random id kept only while that browser tab is open, so HQ counts visits
-- (sessions) and page views, not people. Browsers asking not to be tracked (Do Not Track, Global Privacy Control) send nothing.
-- Read only by HQ staff with reports.view, through hq_traffic(). Raw rows are kept 13 months, daily totals 3 years (hq_traffic_sweep, run
-- every day by .github/workflows/hq-jobs.yml).
create table if not exists public.site_visits (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  session_id text not null check (length(session_id) between 8 and 40),
  path text not null check (length(path) <= 80),
  referrer_host text check (length(referrer_host) <= 100),
  utm_source text check (length(utm_source) <= 60),
  utm_medium text check (length(utm_medium) <= 60),
  utm_campaign text check (length(utm_campaign) <= 80),
  device text check (device in ('phone', 'tablet', 'desktop')),
  browser text check (length(browser) <= 20),
  lang text check (length(lang) <= 12),
  region text check (length(region) <= 40)
);
-- Date ranges (12 months stays quick) and the per-session limit.
create index if not exists site_visits_at on public.site_visits (at);
create index if not exists site_visits_session on public.site_visits (session_id, at);
alter table public.site_visits enable row level security;
revoke all on public.site_visits from public, anon, authenticated;
-- (no policies: writing goes through track_visit, reading through hq_traffic)

-- A website page's address, tidied ('/pricing.html' -> '/pricing', '/index.html' -> '/'), or null if it isn't one of
-- the website's pages (HQ, Riyeser Link, made-up addresses). Add new kinds of page here when the website gets them.
create or replace function public.site_visit_path(p text) returns text language sql immutable as $$
  select case when x ~ '^/((downloads|help|pricing|programs|terms)|(help|industries|programs)/[a-z0-9][a-z0-9-]{0,40})?$' then x end
  from (select regexp_replace(regexp_replace(lower(split_part(split_part(left(coalesce(p, ''), 200), '?', 1), '#', 1)),
    '(^|/)index\.html$', '\1'), '\.html$|/$', '') as x0) a
  cross join lateral (select case when x0 = '' then '/' else x0 end as x) b
$$;
-- Short, printable text only.
create or replace function public.site_visit_text(v text, n int) returns text language sql immutable as $$
  select nullif(left(trim(regexp_replace(coalesce(v, ''), '[^[:print:]]|[<>"]', '', 'g')), n), '')
$$;
-- One page view from the website. Anything not right is quietly ignored (the page never waits for or shows this).
-- At most 200 page views per session a day, so one tab can't flood it.
create or replace function public.track_visit(s text, p text, r text default null, us text default null, um text default null,
  uc text default null, d text default null, b text default null, l text default null, g text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare pth text := site_visit_path(p); sid text := lower(left(coalesce(s, ''), 40));
  ref text := regexp_replace(lower(left(trim(coalesce(r, '')), 120)), '^www\.', '');
begin
  if pth is null or sid !~ '^[a-z0-9]{8,40}$' then return; end if;
  if (select count(*) from (select 1 from site_visits v where v.session_id = sid and v.at > now() - interval '1 day' limit 200) c) >= 200 then return; end if;
  if ref !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' or length(ref) > 100 or ref ~ '(^|\.)riyeser\.com$' then ref := null; end if;
  insert into site_visits (session_id, path, referrer_host, utm_source, utm_medium, utm_campaign, device, browser, lang, region)
  values (sid, pth, ref, site_visit_text(lower(us), 60), site_visit_text(lower(um), 60), site_visit_text(uc, 80),
    case when d in ('phone', 'tablet', 'desktop') then d end,
    case when b in ('Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Samsung', 'Other') then b end,
    case when lower(l) ~ '^[a-z]{2,3}(-[a-z0-9]{2,4})?$' then lower(l) end,
    case when g ~ '^[A-Za-z][A-Za-z .''-]{1,39}$' then g end);
end $$;

-- Daily totals, so a year of history stays quick: for each past UTC day, visits (sessions) and page views in total and
-- by page, referrer (the first one in each session), campaign, device, browser and region. No session ids are kept
-- here. A day is added once it's over (by hq_traffic when it's asked for, and by the daily sweep); today comes from the
-- raw rows. A tab left open over midnight counts as a visit on both days.
create table if not exists public.site_traffic_daily (
  day date not null,
  kind text not null check (kind in ('total', 'page', 'ref', 'camp', 'device', 'browser', 'region')),
  k text not null default '',
  visits int not null default 0,
  views int not null default 0,
  primary key (day, kind, k)
);
create table if not exists public.site_traffic_days (day date primary key, rolled_at timestamptz not null default now());
alter table public.site_traffic_daily enable row level security;
alter table public.site_traffic_days enable row level security;
revoke all on public.site_traffic_daily, public.site_traffic_days from public, anon, authenticated;

-- The daily numbers for days d1..d2, worked out from the raw page views.
create or replace function public.site_traffic_compute(d1 date, d2 date)
  returns table (day date, kind text, k text, visits bigint, views bigint) language sql stable set search_path = public as $$
  with v as (select (x.at at time zone 'UTC')::date as day, x.* from site_visits x
             where x.at >= (d1::timestamp at time zone 'UTC') and x.at < ((d2 + 1)::timestamp at time zone 'UTC')),
       s as (select v.day, v.session_id, (array_agg(v.referrer_host order by v.at) filter (where v.referrer_host is not null))[1] as ref from v group by 1, 2)
  select v.day, 'total', '', count(distinct v.session_id), count(*) from v group by 1
  union all select v.day, 'page', v.path, count(distinct v.session_id), count(*) from v group by 1, 3
  union all select s.day, 'ref', coalesce(s.ref, ''), count(*), 0 from s group by 1, 3
  union all select v.day, 'camp', concat_ws(chr(9), coalesce(v.utm_source, ''), coalesce(v.utm_medium, ''), coalesce(v.utm_campaign, '')), count(distinct v.session_id), count(*)
    from v where coalesce(v.utm_source, v.utm_medium, v.utm_campaign) is not null group by 1, 3
  union all select v.day, 'device', coalesce(v.device, ''), count(distinct v.session_id), count(*) from v group by 1, 3
  union all select v.day, 'browser', coalesce(v.browser, ''), count(distinct v.session_id), count(*) from v group by 1, 3
  union all select v.day, 'region', coalesce(v.region, ''), count(distinct v.session_id), count(*) from v group by 1, 3
$$;
-- Adds the daily numbers for every finished day from d1 to d2 that doesn't have them yet. Returns how many days.
create or replace function public.site_traffic_roll(d1 date, d2 date) returns int
  language plpgsql security definer set search_path = public as $$
declare todo date[]; a date; z date; utc_today date := (now() at time zone 'UTC')::date;
begin
  z := least(d2, utc_today - 1);
  select array_agg(g::date), min(g::date), max(g::date) into todo, a, z from generate_series(d1, z, interval '1 day') g
    where not exists (select 1 from site_traffic_days t where t.day = g::date);
  if todo is null then return 0; end if;
  insert into site_traffic_daily (day, kind, k, visits, views)
    select c.day, c.kind, c.k, c.visits, c.views from site_traffic_compute(a, z) c where c.day = any(todo) on conflict do nothing;
  insert into site_traffic_days (day) select unnest(todo) on conflict do nothing;
  return cardinality(todo);
end $$;

-- Website traffic for HQ Reports (reports.view): headline numbers and the period before, visits by day (by week over
-- 92 days), top pages, where visitors came from, devices, browsers, regions, and the funnel from a website visit to a
-- paying business. Dates are UTC days. At most about 2 years.
create or replace function public.hq_traffic(from_day date, to_day date) returns json
  language plpgsql volatile security definer set search_path = public as $$
declare utc_today date := (now() at time zone 'UTC')::date; f date := coalesce(from_day, utc_today - 29); t date := coalesce(to_day, utc_today);
  n int; pf date; r json; wk boolean;
begin
  perform hq_need(array['reports.view']);
  if t < f then raise exception 'Choose a start date before the end date.'; end if;
  if t - f > 800 then f := t - 800; end if;
  n := t - f + 1; pf := f - n; wk := n > 92;
  perform site_traffic_roll(pf, t);
  with d as materialized (
         select x.day, x.kind, x.k, x.visits::bigint as visits, x.views::bigint as views from site_traffic_daily x where x.day between pf and t
         union all select c.day, c.kind, c.k, c.visits, c.views from site_traffic_compute(greatest(pf, utc_today), t) c where t >= utc_today),
       v as (select * from d where d.day >= f),
       tot as (select * from v where kind = 'total'),
       buckets as (select b::date as bd from generate_series(case when wk then date_trunc('week', f) else f end, t, case when wk then interval '7 days' else interval '1 day' end) b),
       per as (select (case when wk then date_trunc('week', tot.day) else tot.day end)::date as bd, sum(tot.visits) as visits, sum(tot.views) as views from tot group by 1),
       grp as (select kind, k, sum(visits) as visits, sum(views) as views from v where kind <> 'total' group by 1, 2),
       ws as (select w.id from workspaces w where w.kind = 'business' and w.created_at >= f and w.created_at < t + 1)
  select json_build_object('from', f, 'to', t, 'today', utc_today, 'bucket', case when wk then 'week' else 'day' end,
    'visits', (select coalesce(sum(visits), 0) from tot), 'views', (select coalesce(sum(views), 0) from tot),
    'prev', (select json_build_object('from', pf, 'to', f - 1, 'visits', coalesce(sum(visits), 0), 'views', coalesce(sum(views), 0)) from d where kind = 'total' and day < f),
    'series', (select coalesce(json_agg(json_build_object('d', b.bd, 'visits', coalesce(p.visits, 0), 'views', coalesce(p.views, 0)) order by b.bd), '[]')
        from buckets b left join per p on p.bd = b.bd),
    'pages', (select coalesce(json_agg(json_build_object('path', k, 'views', views, 'visits', visits) order by views desc, k), '[]')
        from (select * from grp where kind = 'page' order by views desc, k limit 25) x),
    'referrers', (select coalesce(json_agg(json_build_object('host', k, 'visits', visits) order by visits desc, k), '[]')
        from (select * from grp where kind = 'ref' order by visits desc, k limit 25) x),
    'campaigns', (select coalesce(json_agg(json_build_object('source', nullif(split_part(k, chr(9), 1), ''), 'medium', nullif(split_part(k, chr(9), 2), ''),
          'campaign', nullif(split_part(k, chr(9), 3), ''), 'visits', visits) order by visits desc), '[]')
        from (select * from grp where kind = 'camp' order by visits desc, k limit 25) x),
    'devices', (select coalesce(json_agg(json_build_object('k', k, 'visits', visits) order by visits desc), '[]') from grp where kind = 'device'),
    'browsers', (select coalesce(json_agg(json_build_object('k', k, 'visits', visits) order by visits desc), '[]') from grp where kind = 'browser'),
    'regions', (select coalesce(json_agg(json_build_object('k', k, 'visits', visits) order by visits desc), '[]')
        from (select * from grp where kind = 'region' order by visits desc, k limit 20) x),
    'funnel', json_build_object('visits', (select coalesce(sum(visits), 0) from tot),
      'pricing', coalesce((select visits from grp where kind = 'page' and k = '/pricing'), 0),
      'pricing_views', coalesce((select views from grp where kind = 'page' and k = '/pricing'), 0),
      'signups', (select count(*) from auth.users au where au.created_at >= f and au.created_at < t + 1 and not exists (select 1 from hq_staff s where s.user_id = au.id)),
      'trials', (select count(*) from ws),
      'paid', (select count(*) from ws where exists (select 1 from company_modules c where c.workspace_id = ws.id and c.paid_since is not null)
          or exists (select 1 from billing_payments bp where bp.workspace_id = ws.id and bp.status = 'completed'))))
  into r;
  return r;
end $$;

-- Every day (hq-jobs.yml): yesterday's (and any missed day's) totals are added, page views older than 13 months are
-- deleted (their daily totals stay, with no session ids), and daily totals older than 3 years go too.
-- Also (SEC-002): call set-up messages (call_signals: who rang whom, and the devices' network addresses) left behind
-- when a browser closed mid-call are removed once they're a day old. A call never needs them for that long.
create or replace function public.hq_traffic_sweep() returns json
  language plpgsql security definer set search_path = public as $$
declare k int; rolled int; cs int;
begin
  rolled := site_traffic_roll((now() at time zone 'UTC')::date - 400, (now() at time zone 'UTC')::date - 1);
  delete from site_visits where at < now() - interval '13 months';
  get diagnostics k = row_count;
  delete from site_traffic_daily where day < current_date - interval '3 years';
  delete from site_traffic_days where day < current_date - interval '3 years';
  delete from call_signals where created_at < now() - interval '1 day';
  get diagnostics cs = row_count;
  return json_build_object('deleted', k, 'days_added', rolled, 'call_signals_removed', cs);
end $$;

revoke all on function public.site_visit_path(text), public.site_visit_text(text, int), public.hq_traffic_sweep(),
  public.site_traffic_compute(date, date), public.site_traffic_roll(date, date),
  public.track_visit(text, text, text, text, text, text, text, text, text, text), public.hq_traffic(date, date) from public, anon, authenticated;
grant execute on function public.track_visit(text, text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.hq_traffic(date, date) to authenticated;

-- ===== Riyeser Link: your status (Available, Busy / Do not disturb, At lunch, Away, Unavailable) =====
-- What people choose with one tap on their picture, optionally "until" a time (then it goes back to Available by itself).
-- "On a call" and "Offline" are never chosen: On a call shows while a call is going on, in the Riyeser Link app or on a
-- desk phone (Riyeser Link Office says yes or no for each extension, nothing more); Offline when Riyeser Link isn't open.
-- Busy / Do not disturb, At lunch and Unavailable don't ring: the database refuses to ring them, and the caller is told.
-- Safe to re-run.
alter table public.presence add column if not exists until_at timestamptz;
alter table public.presence drop constraint if exists presence_status_check;
alter table public.presence add constraint presence_status_check
  check (status in ('available', 'busy', 'away', 'dnd', 'lunch', 'unavailable', 'offline'));
alter table public.presence drop constraint if exists presence_manual_check;
alter table public.presence add constraint presence_manual_check
  check (manual in ('available', 'busy', 'away', 'dnd', 'lunch', 'unavailable', 'offline'));

-- My status in this business. manual_choice is what I picked (null = Available); until_at is when it goes back.
create or replace function public.link_status_set(ws uuid, st text, manual_choice text, custom text, on_a_call boolean, until_at timestamptz)
  returns void language plpgsql security definer set search_path = public as $$
declare t text := nullif(trim(coalesce(custom, '')), ''); m text := nullif(manual_choice, 'available'); u timestamptz := link_status_set.until_at;
begin
  if auth.uid() is null or not is_member(ws) then raise exception 'You''re not in that company.'; end if;
  if st is null or st not in ('available', 'busy', 'away', 'dnd', 'lunch', 'unavailable', 'offline') then
    raise exception 'Choose Available, Busy, At lunch, Away or Unavailable.'; end if;
  if m is not null and m not in ('busy', 'away', 'dnd', 'lunch', 'unavailable') then
    raise exception 'Choose Available, Busy, At lunch, Away or Unavailable. On a call and Offline are set by themselves.'; end if;
  if t is not null and (length(t) > 80 or t ~ '[<>]') then raise exception 'Keep your status short: up to 80 letters, no < or >.'; end if;
  if m is null then u := null; end if;
  if u is not null and (u < now() - interval '1 minute' or u > now() + interval '7 days') then
    raise exception 'Choose an "until" time in the next 7 days.'; end if;
  insert into presence (workspace_id, user_id, status, manual, custom_text, on_call, away_since, until_at, updated_at)
    values (ws, auth.uid(), st, m, t, coalesce(on_a_call, false), case when st = 'away' then now() end, u, now())
  on conflict (workspace_id, user_id) do update set status = excluded.status, manual = excluded.manual, custom_text = excluded.custom_text,
    on_call = excluded.on_call, until_at = excluded.until_at, updated_at = now(),
    away_since = case when excluded.status <> 'away' then null else coalesce(presence.away_since, now()) end;
end $$;

-- On a call on a desk phone: Riyeser Link Office reported this person's extension in a call in the last 10 minutes.
create or replace function public.link_desk_call(ws uuid, person uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from members m join link_offices o on o.workspace_id = m.workspace_id
                   cross join lateral jsonb_array_elements(case when jsonb_typeof(o.extensions) = 'array' then o.extensions else '[]' end) e
                 where m.workspace_id = ws and m.user_id = person and m.extension is not null
                   and o.last_seen > now() - interval '10 minutes'
                   and e ->> 'extension' = m.extension::text and coalesce(e ->> 'in_call', '') = 'true')
$$;

-- Does a call ring this person? Not while they've chosen Busy / Do not disturb, At lunch or Unavailable (until its time is up).
create or replace function public.link_rings(ws uuid, person uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select not exists (select 1 from presence p where p.workspace_id = ws and p.user_id = person
                     and p.manual in ('dnd', 'busy', 'lunch', 'unavailable') and (p.until_at is null or p.until_at > now()))
$$;

-- Everyone's status in a business I'm in. A chosen status whose "until" has passed reads as Available; desk_call says a
-- desk phone call is going on (shown as On a call even when their Riyeser Link isn't open).
do $$ begin
  if exists (select 1 from pg_proc where proname = 'link_presence' and pronamespace = 'public'::regnamespace
             and pg_get_function_result(oid) not like '%desk_call%') then
    drop function public.link_presence(uuid);
  end if;
end $$;
create or replace function public.link_presence(ws uuid) returns table (user_id uuid, status text, manual text, custom_text text, on_call boolean,
  away_since timestamptz, updated_at timestamptz, fresh boolean, now timestamptz, until_at timestamptz, desk_call boolean)
  language sql stable security definer set search_path = public as $$
  select m.user_id,
         coalesce(case when p.until_at <= now() and p.status in ('busy', 'dnd', 'lunch', 'away', 'unavailable') then 'available' else p.status end, 'offline'),
         case when m.user_id = auth.uid() and (p.until_at is null or p.until_at > now()) then p.manual end,
         case when p.until_at is null or p.until_at > now() then p.custom_text end,
         coalesce(p.on_call, false), p.away_since, coalesce(p.updated_at, now()),
         coalesce(p.status <> 'offline' and p.updated_at > now() - interval '3 minutes', false), now(),
         case when p.until_at > now() then p.until_at end,
         public.link_desk_call(ws, m.user_id)
  from members m left join presence p on p.workspace_id = m.workspace_id and p.user_id = m.user_id
  where m.workspace_id = ws and public.is_member(ws) and (p.user_id is not null or public.link_desk_call(ws, m.user_id))
$$;
revoke all on function public.link_status_set(uuid, text, text, text, boolean, timestamptz), public.link_presence(uuid),
  public.link_desk_call(uuid, uuid), public.link_rings(uuid, uuid) from public, anon;
grant execute on function public.link_status_set(uuid, text, text, text, boolean, timestamptz), public.link_presence(uuid),
  public.link_desk_call(uuid, uuid), public.link_rings(uuid, uuid) to authenticated;

-- A call only rings someone who takes calls right now (the app tells the caller "… is busy and can't take calls").
drop policy if exists cs_send on public.call_signals;
create policy cs_send on public.call_signals for insert to authenticated
  with check (from_user = auth.uid() and to_user <> auth.uid() and public.is_member(workspace_id)
              and exists (select 1 from public.members m where m.workspace_id = call_signals.workspace_id and m.user_id = to_user)
              and public.calls_allowed(workspace_id)
              and (kind <> 'ring' or public.link_rings(workspace_id, to_user)));

-- ================================================================ Riyeser online connections (the public API, phase 1)
-- Any business's website or online shop can send bookings, orders, enquiries, customers, quote acceptances and
-- invoice payments into Riyeser, and read back its prices, stock and free booking times. The "api" Edge Function
-- (supabase/functions/api on main, contract in docs/api/openapi.yaml) is the only door from the internet:
--   * API keys (rk_live_… / rk_test_…, and publishable widget keys rk_pub_live_… / rk_pub_test_…). Only a SHA-256 hash
--     is kept: the key itself is shown once, when it's made, and never again. Owners and admins (two-step sign-in)
--     make, rename, limit and revoke them; staff never see them, nor the request log.
--   * The post box (api_inbox): what websites send waits here until one of the business's linked PCs collects it
--     (api_inbox_claim, FOR UPDATE SKIP LOCKED) and files it in Bookings, POS, Invoices or Accounting (api_inbox_done).
--   * Published data: the PCs push the catalogue and prices, stock and open booking times (api_publish_*); the API
--     only ever reads these copies, never the books themselves.
--   * Webhooks: the business's own systems can be told when something happens (signed with HMAC-SHA256).
--   * The request log (30 days), rate limits, and the post box tidied up after 90 days (api_sweep).
-- Nothing here is readable by anyone signed out, and no table is readable directly: everything goes through the
-- functions below, each checking who's asking. Safe to run again.

-- ---------------------------------------------------------------- small helpers
create or replace function public.api_err(code text, message text) returns json language sql immutable as $$
  select json_build_object('error', json_build_object('code', code, 'message', message))
$$;
create or replace function public.api_scopes() returns text[] language sql immutable as $$
  select array['bookings:write', 'orders:write', 'customers:write', 'enquiries:write', 'quotes:write', 'payments:write',
               'stock:read', 'prices:read', 'availability:read', 'catalog:read']
$$;
-- A publishable widget key (in a booking widget on a public web page) can only do these.
create or replace function public.api_widget_scopes() returns text[] language sql immutable as $$
  select array['availability:read', 'bookings:write', 'enquiries:write']
$$;
create or replace function public.api_kind_scope(kind text) returns text language sql immutable as $$
  select case kind when 'booking' then 'bookings:write' when 'order' then 'orders:write' when 'customer' then 'customers:write'
    when 'enquiry' then 'enquiries:write' when 'quote_accept' then 'quotes:write' when 'invoice_payment' then 'payments:write' end
$$;
-- The webhook events, and which ones the business's PCs may announce.
create or replace function public.api_events() returns text[] language sql immutable as $$
  select array['booking.received', 'booking.confirmed', 'booking.cancelled', 'order.received', 'order.ready', 'order.completed',
               'enquiry.received', 'quote.accepted', 'payment.received', 'stock.changed']
$$;
create or replace function public.api_pc_events() returns text[] language sql immutable as $$
  select array['booking.confirmed', 'booking.cancelled', 'order.ready', 'order.completed']
$$;
-- 203.0.113.77 -> 203.0.113.0, 2001:db8:1:2::5 -> 2001:db8:1:: (what the request log keeps: never a whole address)
create or replace function public.api_ip_trunc(ip text) returns text language plpgsql immutable as $$
declare a inet;
begin
  if ip is null or ip = '' then return null; end if;
  a := ip::inet;
  return host(network(set_masklen(a, case when family(a) = 4 then 24 else 48 end)));
exception when others then return null;
end $$;
-- Owners and admins, signed in with two-step sign-in.
create or replace function public.api_need_admin(ws uuid) returns void
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin(ws) then
    raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can manage online connections.';
  end if;
end $$;
-- One of the business's linked PCs (Riyeser Central's link_device), as the person signed in on it.
create or replace function public.api_pc_ok(ws uuid, device uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_member(ws) and exists (select 1 from devices d where d.id = device and d.workspace_id = ws
    and d.user_id = auth.uid() and d.retired_at is null)
$$;
create or replace function public.api_need_pc(ws uuid, device uuid) returns void
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.api_pc_ok(ws, device) then raise exception 'Link this PC to the business first (Riyeser Central).'; end if;
end $$;

-- ---------------------------------------------------------------- plan gating (what the business's licence allows)
-- Any Riyeser program on trial or paid opens the API (every business starts with 90 days of each). On top of that:
-- bookings and open times need Riyeser Bookings; orders and stock need Riyeser POS or Accounting (Basics or Plus).
-- Enquiries, customers, quote acceptances, invoice payments, the catalogue and prices: any program on trial or paid.
create or replace function public.api_mod_on(ws uuid, mod text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((public.module_state(ws, mod) ->> 'active')::boolean, false)
$$;
create or replace function public.api_gate(ws uuid, scope text) returns text
  language sql stable security definer set search_path = public as $$
  select case
    when (select status from workspaces where id = ws) is distinct from 'active' then 'business_closed'
    when not exists (select 1 from unnest(array['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built']) m
                     where public.api_mod_on(ws, m)) then 'plan_required'
    when scope in ('bookings:write', 'availability:read') and not public.api_mod_on(ws, 'bookings') then 'bookings_licence_required'
    when scope in ('orders:write', 'stock:read') and not (public.api_mod_on(ws, 'pos') or public.api_mod_on(ws, 'basic')
         or public.api_mod_on(ws, 'plus')) then 'pos_or_accounting_licence_required'
  end
$$;
create or replace function public.api_gate_message(code text) returns text language sql immutable as $$
  select case code
    when 'business_closed' then 'This business''s Riyeser account is closed or paused.'
    when 'plan_required' then 'Online connections need a Riyeser program on its free trial or paid. Add one on riyeser.com.'
    when 'bookings_licence_required' then 'Online bookings and open times need Riyeser Bookings (on its free trial or paid).'
    when 'pos_or_accounting_licence_required' then 'Online orders and stock need Riyeser POS or Riyeser Accounting (on its free trial or paid).'
    else 'Not allowed.' end
$$;

-- ---------------------------------------------------------------- API keys
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  kind text not null default 'secret' check (kind in ('secret', 'widget')),
  mode text not null default 'live' check (mode in ('live', 'test')),
  scopes text[] not null default '{}',
  prefix text not null check (length(prefix) <= 40),             -- e.g. rk_live_ab12cd34 (shown as rk_live_ab12cd34…)
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the whole key, hex: never the key
  allowed_origins text[] not null default '{}',                  -- websites a browser may call from (widget keys: required)
  allowed_ips cidr[] not null default '{}',                      -- empty: any address
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);
create index if not exists api_keys_ws on public.api_keys (workspace_id, created_at desc);
alter table public.api_keys enable row level security;
revoke all on public.api_keys from public, anon, authenticated;
-- The request log (30 days): one line per request, never the key, the body or a whole internet address.
create table if not exists public.api_requests (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key_id uuid references public.api_keys(id) on delete cascade,
  method text not null check (length(method) <= 10),
  path text not null check (length(path) <= 120),        -- the route (e.g. /v1/quotes/{ref}/accept), never query strings or refs
  status int not null,
  ms int,
  ip text check (length(ip) <= 64),                      -- truncated (203.0.113.0, 2001:db8:1::)
  code text check (length(code) <= 60),                  -- the error code, if any
  at timestamptz not null default now()
);
create index if not exists api_requests_ws on public.api_requests (workspace_id, at desc);
create index if not exists api_requests_key on public.api_requests (key_id, at desc);
create index if not exists api_requests_at on public.api_requests (at);
alter table public.api_requests enable row level security;
revoke all on public.api_requests from public, anon, authenticated;

-- A new secret: 192 random bits as 48 hex characters (from the database's strong random source).
create or replace function public.api_random_hex(n int) returns text language sql volatile as $$
  select left(encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'), n)
$$;
-- https://shop.example.com, https://*.example.com (any subdomain), and for test keys http://localhost:3000 too.
create or replace function public.api_clean_origins(origins text[], key_mode text) returns text[]
  language plpgsql immutable as $$
declare o text; outv text[] := '{}';
begin
  foreach o in array coalesce(origins, '{}') loop
    o := lower(regexp_replace(trim(o), '/+$', ''));
    continue when o = '';
    if not (o ~ '^https://(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'
            or (key_mode = 'test' and o ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$')) then
      raise exception 'Website addresses look like https://shop.example.com (no page after it). "%" isn''t one.', left(o, 80);
    end if;
    if not o = any (outv) then outv := outv || o; end if;
  end loop;
  if cardinality(outv) > 10 then raise exception 'Up to 10 website addresses per key.'; end if;
  return outv;
end $$;
create or replace function public.api_clean_ips(ips text[]) returns cidr[]
  language plpgsql immutable as $$
declare i text; c cidr; outv cidr[] := '{}';
begin
  foreach i in array coalesce(ips, '{}') loop
    i := trim(i);
    continue when i = '';
    begin c := i::cidr; exception when others then
      raise exception 'Internet addresses look like 203.0.113.7 or 203.0.113.0/24. "%" isn''t one.', left(i, 60);
    end;
    if not c = any (outv) then outv := outv || c; end if;
  end loop;
  if cardinality(outv) > 20 then raise exception 'Up to 20 internet addresses per key.'; end if;
  return outv;
end $$;

create or replace function public.api_key_json(k public.api_keys) returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', k.id, 'name', k.name, 'kind', k.kind, 'mode', k.mode, 'scopes', k.scopes,
    'prefix', k.prefix || '…', 'allowed_origins', k.allowed_origins, 'allowed_ips', k.allowed_ips::text[],
    'created_at', k.created_at, 'created_by_name', (select display_name from members m where m.workspace_id = k.workspace_id and m.user_id = k.created_by),
    'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at, 'status', case when k.revoked_at is null then 'active' else 'revoked' end,
    'requests_24h', (select count(*) from api_requests r where r.key_id = k.id and r.at > now() - interval '24 hours'))
$$;

-- Make a key. Returns it ONCE (field "key"): it can't be shown again, only revoked and replaced.
create or replace function public.api_key_create(ws uuid, key_name text, key_kind text, key_mode text, key_scopes text[],
  origins text[], ips text[]) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; raw text; sc text[]; kd text := coalesce(nullif(trim(key_kind), ''), 'secret'); md text := coalesce(nullif(trim(key_mode), ''), 'live');
  og text[]; ip cidr[];
begin
  perform api_need_admin(ws);
  if coalesce(trim(key_name), '') = '' or length(trim(key_name)) > 60 then raise exception 'Give the key a name (up to 60 letters), like "Website shop".'; end if;
  if kd not in ('secret', 'widget') then raise exception 'A key is a secret key or a widget key.'; end if;
  if md not in ('live', 'test') then raise exception 'A key is live or test.'; end if;
  select coalesce(array_agg(distinct s order by s), '{}') into sc from unnest(coalesce(key_scopes, '{}')) s;
  if cardinality(sc) = 0 then raise exception 'Choose what the key may do.'; end if;
  if not sc <@ api_scopes() then raise exception 'Unknown permission: %.', (select string_agg(s, ', ') from unnest(sc) s where not s = any (api_scopes())); end if;
  og := api_clean_origins(origins, md);
  ip := api_clean_ips(ips);
  if kd = 'widget' then
    if not sc <@ api_widget_scopes() then
      raise exception 'A widget key is seen by everyone visiting the website, so it can only read open times and send bookings and enquiries.';
    end if;
    if cardinality(og) = 0 then raise exception 'Add the website address the widget is on (like https://www.example.com).'; end if;
  end if;
  if (select count(*) from api_keys where workspace_id = ws and revoked_at is null) >= 25 then
    raise exception 'A business can have up to 25 keys. Revoke one you don''t use first.';
  end if;
  raw := 'rk_' || case when kd = 'widget' then 'pub_' else '' end || md || '_' || api_random_hex(48);
  insert into api_keys (workspace_id, name, kind, mode, scopes, prefix, key_hash, allowed_origins, allowed_ips, created_by)
    values (ws, trim(key_name), kd, md, sc, left(raw, length(raw) - 40), encode(sha256(convert_to(raw, 'UTF8')), 'hex'), og, ip, auth.uid())
    returning * into k;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.create',
    jsonb_build_object('id', k.id, 'name', k.name, 'kind', k.kind, 'mode', k.mode, 'scopes', k.scopes, 'prefix', k.prefix,
      'allowed_origins', k.allowed_origins, 'allowed_ips', k.allowed_ips::text[]));
  return (api_key_json(k)::jsonb || jsonb_build_object('key', raw))::json;
end $$;

create or replace function public.api_keys_list(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(api_key_json(k) order by k.revoked_at is not null, k.created_at desc), '[]') from api_keys k where k.workspace_id = ws);
end $$;

create or replace function public.api_key_revoke(ws uuid, key_id uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys;
begin
  perform api_need_admin(ws);
  update api_keys set revoked_at = now(), revoked_by = auth.uid() where id = key_id and workspace_id = ws and revoked_at is null returning * into k;
  if k.id is null then raise exception 'That key isn''t there, or it''s already revoked.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.revoke', jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix));
  return api_key_json(k);
end $$;

create or replace function public.api_key_rename(ws uuid, key_id uuid, key_name text) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; was text;
begin
  perform api_need_admin(ws);
  if coalesce(trim(key_name), '') = '' or length(trim(key_name)) > 60 then raise exception 'Give the key a name (up to 60 letters).'; end if;
  select name into was from api_keys where id = key_id and workspace_id = ws;
  update api_keys set name = trim(key_name) where id = key_id and workspace_id = ws returning * into k;
  if k.id is null then raise exception 'That key isn''t there.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.rename', jsonb_build_object('id', k.id, 'name', jsonb_build_object('was', was, 'now', k.name)));
  return api_key_json(k);
end $$;

-- Which websites (browsers) and internet addresses may use a key. Widget keys always keep at least one website.
create or replace function public.api_key_set_access(ws uuid, key_id uuid, origins text[], ips text[]) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; og text[]; ip cidr[];
begin
  perform api_need_admin(ws);
  select * into k from api_keys where id = key_id and workspace_id = ws and revoked_at is null;
  if k.id is null then raise exception 'That key isn''t there, or it''s revoked.'; end if;
  og := api_clean_origins(origins, k.mode); ip := api_clean_ips(ips);
  if k.kind = 'widget' and cardinality(og) = 0 then raise exception 'A widget key needs the website address it''s on.'; end if;
  update api_keys set allowed_origins = og, allowed_ips = ip where id = k.id returning * into k;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.access',
    jsonb_build_object('id', k.id, 'name', k.name, 'allowed_origins', og, 'allowed_ips', ip::text[]));
  return api_key_json(k);
end $$;

-- ---------------------------------------------------------------- the request log (30 days) and rate limits

create table if not exists public.api_rate (bucket text primary key, n int not null default 0, expires_at timestamptz not null);
create index if not exists api_rate_expires on public.api_rate (expires_at);
alter table public.api_rate enable row level security;
revoke all on public.api_rate from public, anon, authenticated;

-- One more request on a counter; returns the count so far in this window.
create or replace function public.api_rate_hit(b text, ttl interval) returns int
  language sql security definer set search_path = public as $$
  insert into api_rate (bucket, n, expires_at) values (b, 1, now() + ttl)
  on conflict (bucket) do update set n = api_rate.n + 1 returning n
$$;

-- The Edge Function's first call on every request (service role only): the key from its SHA-256 hash, checks the
-- internet address against its list, and counts the request (per key per minute, per workspace per day, and for
-- widget keys per visitor address per minute). Limits: HQ settings api.key_per_minute (120), api.widget_per_minute
-- (60), api.widget_ip_per_minute (20), api.workspace_per_day (20000).
create or replace function public.api_auth(key_hash text, ip text) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; wst text; minute bigint := floor(extract(epoch from now()) / 60); lim int; n int; nd int; dl int; ni int; il int;
  addr inet;
begin
  if coalesce(key_hash, '') !~ '^[0-9a-f]{64}$' then return api_err('invalid_key', 'That API key isn''t right.'); end if;
  select * into k from api_keys a where a.key_hash = api_auth.key_hash;
  if k.id is null then return api_err('invalid_key', 'That API key isn''t right.'); end if;
  if k.revoked_at is not null then return api_err('key_revoked', 'That API key was revoked. Ask the business for a new one.'); end if;
  select status into wst from workspaces where id = k.workspace_id;
  if wst is distinct from 'active' then return api_err('business_closed', api_gate_message('business_closed')); end if;
  begin addr := nullif(ip, '')::inet; exception when others then addr := null; end;
  if cardinality(k.allowed_ips) > 0 and (addr is null or not exists (select 1 from unnest(k.allowed_ips) c where addr <<= c)) then
    return api_err('ip_not_allowed', 'This key can''t be used from this internet address.');
  end if;
  lim := hq_setting_num(case when k.kind = 'widget' then 'api.widget_per_minute' else 'api.key_per_minute' end, case when k.kind = 'widget' then 60 else 120 end)::int;
  dl := hq_setting_num('api.workspace_per_day', 20000)::int;
  n := api_rate_hit('k:' || k.id || ':' || minute, interval '2 minutes');
  nd := api_rate_hit('w:' || k.workspace_id || ':' || current_date, interval '2 days');
  if k.kind = 'widget' and addr is not null then
    il := hq_setting_num('api.widget_ip_per_minute', 20)::int;
    ni := api_rate_hit('i:' || k.id || ':' || api_ip_trunc(host(addr)) || ':' || minute, interval '2 minutes');
    if ni > il then
      return (api_err('rate_limited', 'Too many requests from here. Wait a minute and try again.')::jsonb
        || jsonb_build_object('retry_after', 60 - extract(epoch from now())::int % 60, 'key_id', k.id, 'workspace_id', k.workspace_id))::json;
    end if;
  end if;
  if n > lim then
    return (api_err('rate_limited', 'Too many requests with this key. Wait a minute and try again.')::jsonb
      || jsonb_build_object('retry_after', 60 - extract(epoch from now())::int % 60, 'key_id', k.id, 'workspace_id', k.workspace_id))::json;
  end if;
  if nd > dl then
    return (api_err('daily_limit', 'This business has reached its daily API limit. It resets at midnight UTC.')::jsonb
      || jsonb_build_object('retry_after', extract(epoch from (date_trunc('day', now()) + interval '1 day' - now()))::int, 'key_id', k.id, 'workspace_id', k.workspace_id))::json;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then update api_keys set last_used_at = now() where id = k.id; end if;
  return json_build_object('key_id', k.id, 'workspace_id', k.workspace_id, 'kind', k.kind, 'mode', k.mode, 'scopes', k.scopes,
    'allowed_origins', k.allowed_origins, 'name', k.name,
    'rate', json_build_object('limit', lim, 'remaining', greatest(lim - n, 0), 'reset', 60 - extract(epoch from now())::int % 60));
end $$;

-- The Edge Function's last call (service role): one line in the request log. The address is truncated here too.
create or replace function public.api_log_request(key_id uuid, method text, path text, status int, ms int, ip text, code text) returns void
  language sql security definer set search_path = public as $$
  insert into api_requests (workspace_id, key_id, method, path, status, ms, ip, code)
  select k.workspace_id, k.id, left(upper(api_log_request.method), 10), left(regexp_replace(coalesce(api_log_request.path, ''), '[?#].*$', ''), 120),
    api_log_request.status, greatest(api_log_request.ms, 0), api_ip_trunc(api_log_request.ip), left(api_log_request.code, 60)
  from api_keys k where k.id = api_log_request.key_id
$$;

-- Owners and admins: their own business's request log (newest first). Optional key; before = an id for the next page.
create or replace function public.api_requests_list(ws uuid, key_id uuid, max_rows int, before_id bigint) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(json_build_object('id', r.id, 'key_id', r.key_id, 'key_name', k.name, 'method', r.method, 'path', r.path,
      'status', r.status, 'ms', r.ms, 'ip', r.ip, 'code', r.code, 'at', r.at) order by r.id desc), '[]')
    from (select * from api_requests r where r.workspace_id = ws and (api_requests_list.key_id is null or r.key_id = api_requests_list.key_id)
            and (before_id is null or r.id < before_id) order by r.id desc limit least(greatest(coalesce(max_rows, 50), 1), 200)) r
    left join api_keys k on k.id = r.key_id);
end $$;

-- ---------------------------------------------------------------- the post box (what websites send, until a PC takes it)
create table if not exists public.api_inbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('booking', 'order', 'enquiry', 'customer', 'quote_accept', 'invoice_payment')),
  mode text not null default 'live' check (mode in ('live', 'test')),     -- test: sent with a test key (desktop shows it as a test)
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  key_id uuid references public.api_keys(id) on delete set null,
  source text not null default 'api' check (source ~ '^[a-z0-9_.:-]{1,40}$'),   -- api, widget (or a connector's name later)
  idempotency_key text check (length(idempotency_key) between 1 and 100),
  body_hash text check (body_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'waiting' check (status in ('waiting', 'taken', 'done', 'failed', 'rejected')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),   -- when it can next be taken (after a failed try: later)
  taken_by uuid references public.devices(id) on delete set null,
  taken_at timestamptz,
  error text check (length(error) <= 500),            -- the PC's reason (for owners and admins; never shown to the website)
  result jsonb,                                       -- {reference, state, message}: what the website may see
  created_at timestamptz not null default clock_timestamp(),   -- (in order, even several in one go)
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create unique index if not exists api_inbox_idem on public.api_inbox (workspace_id, key_id, idempotency_key) where idempotency_key is not null;
create index if not exists api_inbox_queue on public.api_inbox (workspace_id, available_at) where status in ('waiting', 'taken');
create index if not exists api_inbox_finished on public.api_inbox (updated_at) where status in ('done', 'failed', 'rejected');
create index if not exists api_inbox_ws on public.api_inbox (workspace_id, created_at desc);
alter table public.api_inbox enable row level security;
revoke all on public.api_inbox from public, anon, authenticated;

-- ---------------------------------------------------------------- published data (pushed by the PCs, read by the API)
create table if not exists public.api_catalog (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sku text not null check (sku ~ '^[A-Za-z0-9._/-]{1,64}$'),
  type text not null default 'product' check (type in ('product', 'service')),
  name text not null check (length(trim(name)) between 1 and 200),
  description text check (length(description) <= 2000),
  category text check (length(category) <= 80),
  price numeric(14, 4) check (price >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  tax_rate numeric(7, 3) check (tax_rate between 0 and 100),
  tax_included boolean not null default true,
  unit text check (length(unit) <= 20),
  duration_minutes int check (duration_minutes between 1 and 1440),   -- services: how long a booking takes
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, sku)
);
create table if not exists public.api_stock (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sku text not null check (sku ~ '^[A-Za-z0-9._/-]{1,64}$'),
  quantity numeric(14, 3) not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, sku)
);
create table if not exists public.api_booking_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  timezone text not null default 'UTC' check (length(timezone) <= 60),
  slot_minutes int not null default 15 check (slot_minutes between 5 and 240),         -- start times every … minutes
  min_notice_minutes int not null default 60 check (min_notice_minutes between 0 and 43200),
  days_ahead int not null default 30 check (days_ahead between 1 and 365),
  updated_at timestamptz not null default now()
);
create table if not exists public.api_staff (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  ref text not null check (ref ~ '^[A-Za-z0-9._/-]{1,64}$'),
  name text not null check (length(trim(name)) between 1 and 60),     -- as customers see it (e.g. a first name)
  services text[] not null default '{}',                              -- service SKUs they do (empty: all)
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, ref)
);
-- Free time that can be booked: a window per staff member (or for the business: staff_ref null, e.g. tables).
create table if not exists public.api_open_times (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  staff_ref text check (staff_ref ~ '^[A-Za-z0-9._/-]{1,64}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity int not null default 1 check (capacity between 1 and 1000),   -- e.g. seats or people at once
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours')
);
create index if not exists api_open_times_ws on public.api_open_times (workspace_id, starts_at);
create table if not exists public.api_published (       -- when each kind was last pushed
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  what text not null check (what in ('catalog', 'stock', 'availability')),
  updated_at timestamptz not null default now(),
  device_id uuid,
  primary key (workspace_id, what)
);
alter table public.api_catalog enable row level security;
alter table public.api_stock enable row level security;
alter table public.api_booking_settings enable row level security;
alter table public.api_staff enable row level security;
alter table public.api_open_times enable row level security;
alter table public.api_published enable row level security;
revoke all on public.api_catalog, public.api_stock, public.api_booking_settings, public.api_staff, public.api_open_times,
  public.api_published from public, anon, authenticated;

-- ---------------------------------------------------------------- webhooks (telling the business's own systems)
create table if not exists public.api_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  url text not null check (length(url) <= 500 and url ~ '^https://'),
  events text[] not null,
  mode text not null default 'live' check (mode in ('live', 'test')),   -- test endpoints get what test keys send
  secret text not null check (secret ~ '^whsec_[0-9a-f]{48}$'),           -- for the HMAC signature; shown once
  description text check (length(description) <= 120),
  active boolean not null default true,
  disabled_reason text check (length(disabled_reason) <= 200),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failing_since timestamptz
);
create index if not exists api_webhooks_ws on public.api_webhooks (workspace_id);
create table if not exists public.api_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.api_webhooks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event text not null,
  payload jsonb not null,                       -- the body that's sent: {id, type, created_at, test, data}
  status text not null default 'pending' check (status in ('pending', 'delivering', 'delivered', 'failed')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  locked_until timestamptz,
  last_status int,
  last_error text check (length(last_error) <= 300),
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists api_deliveries_due on public.api_webhook_deliveries (next_at) where status in ('pending', 'delivering');
create index if not exists api_deliveries_hook on public.api_webhook_deliveries (webhook_id, created_at desc);
create index if not exists api_deliveries_old on public.api_webhook_deliveries (created_at);
alter table public.api_webhooks enable row level security;
alter table public.api_webhook_deliveries enable row level security;
revoke all on public.api_webhooks, public.api_webhook_deliveries from public, anon, authenticated;

-- Only real public https addresses (no localhost, no internal names, no bare IP addresses).
create or replace function public.api_clean_url(u text) returns text language plpgsql immutable as $$
declare host text;
begin
  u := trim(coalesce(u, ''));
  if length(u) > 500 or u !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
    raise exception 'The address must start with https:// (like https://example.com/riyeser-webhook).';
  end if;
  host := lower(substring(u from '^https://([A-Za-z0-9.-]+)'));
  if host ~ '^[0-9.]+$' or host !~ '\.' or host ~ '(^|\.)(localhost|local|internal|lan|home|corp|intranet)$' or host ~ '\.$' then
    raise exception 'Use the public web address of your system (not localhost, an internal name or a bare IP address).';
  end if;
  return u;
end $$;

-- Queue an event for the business's matching webhooks (same mode). Returns how many were queued.
create or replace function public.api_queue_event(ws uuid, ev_mode text, ev text, data jsonb) returns int
  language plpgsql security definer set search_path = public as $$
declare eid uuid := gen_random_uuid(); n int;
begin
  insert into api_webhook_deliveries (webhook_id, workspace_id, event, payload)
    select h.id, ws, ev, jsonb_build_object('id', eid, 'type', ev, 'created_at', now(), 'test', ev_mode = 'test', 'data', coalesce(data, '{}'::jsonb))
    from api_webhooks h where h.workspace_id = ws and h.active and h.mode = ev_mode and ev = any (h.events);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.api_webhook_json(h public.api_webhooks) returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', h.id, 'url', h.url, 'events', h.events, 'mode', h.mode, 'description', h.description, 'active', h.active,
    'disabled_reason', h.disabled_reason, 'secret_hint', 'whsec_…' || right(h.secret, 4), 'created_at', h.created_at,
    'last_success_at', h.last_success_at, 'last_failure_at', h.last_failure_at, 'failing_since', h.failing_since,
    'pending', (select count(*) from api_webhook_deliveries d where d.webhook_id = h.id and d.status in ('pending', 'delivering')))
$$;
create or replace function public.api_clean_events(evs text[]) returns text[] language plpgsql immutable as $$
declare outv text[];
begin
  select coalesce(array_agg(distinct e order by e), '{}') into outv from unnest(coalesce(evs, '{}')) e;
  if cardinality(outv) = 0 then raise exception 'Choose at least one event.'; end if;
  if not outv <@ api_events() then raise exception 'Unknown event: %.', (select string_agg(e, ', ') from unnest(outv) e where not e = any (api_events())); end if;
  return outv;
end $$;

-- Make a webhook. Returns its signing secret ONCE (field "secret").
create or replace function public.api_webhook_create(ws uuid, url text, events text[], hook_mode text, description text) returns json
  language plpgsql security definer set search_path = public as $$
declare h api_webhooks; md text := coalesce(nullif(trim(hook_mode), ''), 'live');
begin
  perform api_need_admin(ws);
  if md not in ('live', 'test') then raise exception 'A webhook is live or test.'; end if;
  if (select count(*) from api_webhooks where workspace_id = ws) >= 10 then raise exception 'A business can have up to 10 webhooks.'; end if;
  insert into api_webhooks (workspace_id, url, events, mode, secret, description, created_by)
    values (ws, api_clean_url(url), api_clean_events(events), md, 'whsec_' || api_random_hex(48), nullif(left(trim(coalesce(description, '')), 120), ''), auth.uid())
    returning * into h;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_webhook.create', jsonb_build_object('id', h.id, 'url', h.url, 'events', h.events, 'mode', h.mode));
  return (api_webhook_json(h)::jsonb || jsonb_build_object('secret', h.secret))::json;
end $$;
create or replace function public.api_webhooks_list(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(api_webhook_json(h) order by h.created_at), '[]') from api_webhooks h where h.workspace_id = ws);
end $$;
-- Change the address, events or on/off (null leaves it as it is). Turning it back on clears "failing".
create or replace function public.api_webhook_update(ws uuid, hook_id uuid, url text, events text[], active boolean) returns json
  language plpgsql security definer set search_path = public as $$
declare h api_webhooks;
begin
  perform api_need_admin(ws);
  update api_webhooks w set url = case when nullif(trim(coalesce(api_webhook_update.url, '')), '') is null then w.url else api_clean_url(api_webhook_update.url) end,
      events = case when api_webhook_update.events is null then w.events else api_clean_events(api_webhook_update.events) end,
      active = coalesce(api_webhook_update.active, w.active),
      disabled_reason = case when api_webhook_update.active then null else w.disabled_reason end,
      failing_since = case when api_webhook_update.active then null else w.failing_since end
    where w.id = hook_id and w.workspace_id = ws returning * into h;
  if h.id is null then raise exception 'That webhook isn''t there.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_webhook.update', jsonb_build_object('id', h.id, 'url', h.url, 'events', h.events, 'active', h.active));
  return api_webhook_json(h);
end $$;
create or replace function public.api_webhook_rotate(ws uuid, hook_id uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare h api_webhooks;
begin
  perform api_need_admin(ws);
  update api_webhooks set secret = 'whsec_' || api_random_hex(48) where id = hook_id and workspace_id = ws returning * into h;
  if h.id is null then raise exception 'That webhook isn''t there.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_webhook.rotate', jsonb_build_object('id', h.id, 'url', h.url));
  return (api_webhook_json(h)::jsonb || jsonb_build_object('secret', h.secret))::json;
end $$;
create or replace function public.api_webhook_delete(ws uuid, hook_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare h api_webhooks;
begin
  perform api_need_admin(ws);
  delete from api_webhooks where id = hook_id and workspace_id = ws returning * into h;
  if h.id is null then raise exception 'That webhook isn''t there.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_webhook.delete', jsonb_build_object('id', h.id, 'url', h.url));
end $$;
-- Send a test "ping" to one webhook.
create or replace function public.api_webhook_ping(ws uuid, hook_id uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare h api_webhooks; eid uuid := gen_random_uuid();
begin
  perform api_need_admin(ws);
  select * into h from api_webhooks where id = hook_id and workspace_id = ws;
  if h.id is null then raise exception 'That webhook isn''t there.'; end if;
  insert into api_webhook_deliveries (webhook_id, workspace_id, event, payload)
    values (h.id, ws, 'ping', jsonb_build_object('id', eid, 'type', 'ping', 'created_at', now(), 'test', h.mode = 'test', 'data', jsonb_build_object('message', 'Hello from Riyeser')));
  return json_build_object('queued', true, 'event_id', eid);
end $$;
create or replace function public.api_webhook_deliveries_list(ws uuid, hook_id uuid, max_rows int) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(json_build_object('id', d.id, 'event', d.event, 'event_id', d.payload ->> 'id', 'status', d.status, 'attempts', d.attempts,
      'next_at', case when d.status in ('pending', 'delivering') then d.next_at end, 'last_status', d.last_status, 'last_error', d.last_error,
      'created_at', d.created_at, 'delivered_at', d.delivered_at) order by d.created_at desc), '[]')
    from (select * from api_webhook_deliveries d where d.workspace_id = ws and d.webhook_id = hook_id
          order by d.created_at desc limit least(greatest(coalesce(max_rows, 50), 1), 200)) d);
end $$;

-- The dispatcher (service role): take up to n deliveries that are due (FOR UPDATE SKIP LOCKED, so two runs never
-- send the same one), each locked for 2 minutes. Optionally for one business only.
create or replace function public.api_webhooks_due(max_n int, only_ws uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare r json;
begin
  with due as (
    select d.id from api_webhook_deliveries d join api_webhooks h on h.id = d.webhook_id and h.active
    where ((d.status = 'pending' and d.next_at <= now()) or (d.status = 'delivering' and d.locked_until < now()))
      and (only_ws is null or d.workspace_id = only_ws)
    order by d.next_at limit least(greatest(coalesce(max_n, 20), 1), 100)
    for update of d skip locked),
  t as (update api_webhook_deliveries d set status = 'delivering', locked_until = now() + interval '2 minutes', attempts = d.attempts + 1
        from due where d.id = due.id returning d.*)
  select coalesce(json_agg(json_build_object('id', t.id, 'url', h.url, 'secret', h.secret, 'event', t.event, 'attempt', t.attempts, 'payload', t.payload)), '[]')
    into r from t join api_webhooks h on h.id = t.webhook_id;
  return r;
end $$;
-- How it went. Retries after 1, 5, 30 minutes, 2, 6, 12 and 24 hours (8 tries), then it's failed. A webhook failing
-- for 3 days is turned off (owners and admins see why and can turn it back on).
create or replace function public.api_webhook_result(delivery_id uuid, ok boolean, http_status int, err text) returns void
  language plpgsql security definer set search_path = public as $$
declare d api_webhook_deliveries; backoff int[] := array[1, 5, 30, 120, 360, 720, 1440];
begin
  select * into d from api_webhook_deliveries where id = delivery_id and status = 'delivering' for update;
  if d.id is null then return; end if;
  if ok then
    update api_webhook_deliveries set status = 'delivered', delivered_at = now(), last_status = http_status, last_error = null, locked_until = null where id = d.id;
    update api_webhooks set last_success_at = now(), failing_since = null where id = d.webhook_id;
  else
    update api_webhook_deliveries set status = case when d.attempts >= 8 then 'failed' else 'pending' end,
        next_at = now() + make_interval(mins => backoff[least(d.attempts, 7)]), last_status = http_status,
        last_error = left(regexp_replace(coalesce(err, ''), '[[:cntrl:]]', ' ', 'g'), 300), locked_until = null
      where id = d.id;
    update api_webhooks set last_failure_at = now(), failing_since = coalesce(failing_since, now()) where id = d.webhook_id;
    update api_webhooks set active = false, disabled_reason = 'Turned off: it kept failing for 3 days.'
      where id = d.webhook_id and active and failing_since < now() - interval '3 days';
  end if;
end $$;

-- ---------------------------------------------------------------- free booking times
-- The start times customers can choose for one service: inside the open times of staff who do it (or the business's
-- own open times), every slot_minutes from the window's start, the whole service fitting, at least min_notice_minutes
-- from now and within days_ahead. Times already asked for by a booking still in the post box are left out.
create or replace function public.api_slots(ws uuid, service text, from_day date, days int, staff text, party int) returns json
  language plpgsql stable security definer set search_path = public as $$
declare st api_booking_settings; dur int; t0 timestamptz; t1 timestamptz; r json;
begin
  select * into st from api_booking_settings where workspace_id = ws;
  if st.workspace_id is null then st.timezone := 'UTC'; st.slot_minutes := 15; st.min_notice_minutes := 60; st.days_ahead := 30; end if;
  select duration_minutes into dur from api_catalog c where c.workspace_id = ws and c.sku = service and c.type = 'service' and c.active;
  if dur is null then return null; end if;
  t0 := greatest(coalesce(from_day, (now() at time zone st.timezone)::date)::timestamp at time zone st.timezone, now() + make_interval(mins => st.min_notice_minutes));
  t1 := least(coalesce(from_day, (now() at time zone st.timezone)::date)::timestamp at time zone st.timezone + make_interval(days => least(greatest(coalesce(days, 7), 1), 31)),
              now() + make_interval(days => st.days_ahead));
  with w as (
    select o.* from api_open_times o
    where o.workspace_id = ws and o.starts_at < t1 and o.ends_at > t0 and o.capacity >= greatest(coalesce(party, 1), 1)
      and (staff is null or o.staff_ref = staff)
      and (o.staff_ref is null or exists (select 1 from api_staff s where s.workspace_id = ws and s.ref = o.staff_ref and s.active
                                           and (cardinality(s.services) = 0 or service = any (s.services))))),
  s as (
    select w.staff_ref, w.capacity, g as start_at from w,
      generate_series(w.starts_at + make_interval(mins => st.slot_minutes) * ceil(greatest(0, extract(epoch from (t0 - w.starts_at))) / (st.slot_minutes * 60)),
                      w.ends_at - make_interval(mins => dur), make_interval(mins => st.slot_minutes)) g
    where g < t1),
  free as (
    select s.* from s where not exists (
      select 1 from api_inbox b where b.workspace_id = ws and b.kind = 'booking' and b.mode = 'live' and b.status in ('waiting', 'taken')
        and s.staff_ref is not null and b.payload ->> 'staff' = s.staff_ref
        and (b.payload ->> 'start')::timestamptz < s.start_at + make_interval(mins => dur)
        and coalesce((b.payload ->> 'end')::timestamptz, (b.payload ->> 'start')::timestamptz + make_interval(mins => dur)) > s.start_at))
  select coalesce(json_agg(json_build_object('start', start_at, 'end', start_at + make_interval(mins => dur),
      'local_start', to_char(start_at at time zone st.timezone, 'YYYY-MM-DD"T"HH24:MI'), 'staff', refs, 'capacity', cap) order by start_at), '[]')
    into r
    from (select start_at, array_remove(array_agg(distinct staff_ref), null) as refs, max(capacity) as cap from free group by start_at) x;
  return json_build_object('timezone', st.timezone, 'service', service, 'duration_minutes', dur, 'from', t0, 'to', t1, 'slots', r);
end $$;

-- ---------------------------------------------------------------- what the Edge Function asks (service role only)
-- Something a website sent. The function has already checked the key, its permission, the shape of the payload and
-- the rate; this checks the key, permission and licence again, the essentials of the payload, and the idempotency key:
-- the same key + Idempotency-Key with the same body returns the first answer ("replay"), with a different body an error.
create or replace function public.api_submit(key_id uuid, kind text, payload jsonb, idempotency_key text, body_hash text, source text) returns json
  language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare k api_keys; r api_inbox; g text; p jsonb := payload; dur int; ev text; idem text := nullif(trim(coalesce(idempotency_key, '')), '');
begin
  select * into k from api_keys a where a.id = api_submit.key_id and a.revoked_at is null;
  if k.id is null then return api_err('invalid_key', 'That API key isn''t right.'); end if;
  if api_kind_scope(kind) is null then return api_err('not_found', 'Unknown kind.'); end if;
  if not api_kind_scope(kind) = any (k.scopes) then
    return api_err('missing_scope', 'This key isn''t allowed to do that (it needs ' || api_kind_scope(kind) || ').');
  end if;
  g := api_gate(k.workspace_id, api_kind_scope(kind));
  if g is not null then return api_err(g, api_gate_message(g)); end if;
  if jsonb_typeof(p) is distinct from 'object' then return api_err('invalid_payload', 'Send a JSON object.'); end if;
  if octet_length(p::text) > 65536 then return api_err('payload_too_large', 'That''s too big (64 KB at most).'); end if;
  if idem is not null and (length(idem) > 100 or idem !~ '^[A-Za-z0-9._:-]+$') then
    return api_err('invalid_idempotency_key', 'Idempotency-Key: up to 100 letters, digits and . _ : -');
  end if;
  -- the essentials (the Edge Function checks the whole shape)
  if kind in ('booking', 'order', 'enquiry') and coalesce(trim(p #>> '{customer,name}'), '') = '' then return api_err('invalid_payload', 'customer.name is needed.'); end if;
  if kind = 'customer' and coalesce(trim(p ->> 'name'), '') = '' then return api_err('invalid_payload', 'name is needed.'); end if;
  if kind = 'booking' then
    if coalesce(p ->> 'service', '') = '' then return api_err('invalid_payload', 'service is needed.'); end if;
    begin perform (p ->> 'start')::timestamptz; exception when others then return api_err('invalid_payload', 'start must be a date and time.'); end;
    if p ->> 'start' is null then return api_err('invalid_payload', 'start is needed.'); end if;
    if p ? 'end' then begin perform (p ->> 'end')::timestamptz; exception when others then return api_err('invalid_payload', 'end must be a date and time.'); end; end if;
  end if;
  if kind = 'order' and (jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0) then return api_err('invalid_payload', 'items is needed.'); end if;
  if kind = 'enquiry' and coalesce(trim(p ->> 'message'), '') = '' then return api_err('invalid_payload', 'message is needed.'); end if;
  if kind = 'quote_accept' and (coalesce(p ->> 'quote_ref', '') = '' or coalesce(trim(p #>> '{accepted_by,name}'), '') = '') then
    return api_err('invalid_payload', 'The quote''s reference and accepted_by.name are needed.'); end if;
  if kind = 'invoice_payment' and (coalesce(p ->> 'invoice_ref', '') = '' or jsonb_typeof(p -> 'amount') is distinct from 'number' or (p ->> 'amount')::numeric <= 0) then
    return api_err('invalid_payload', 'The invoice''s reference and an amount above 0 are needed.'); end if;
  -- a replay?
  if idem is not null then
    select * into r from api_inbox i where i.workspace_id = k.workspace_id and i.key_id = k.id and i.idempotency_key = idem;
    if r.id is not null then
      if r.body_hash is distinct from api_submit.body_hash then
        return api_err('idempotency_conflict', 'This Idempotency-Key was already used with a different request.');
      end if;
      return json_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'test', r.mode = 'test', 'created_at', r.created_at, 'replay', true);
    end if;
  end if;
  if kind = 'booking' then
    select duration_minutes into dur from api_catalog c where c.workspace_id = k.workspace_id and c.sku = p ->> 'service' and c.type = 'service';
    if not p ? 'end' and dur is not null then
      p := p || jsonb_build_object('end', (p ->> 'start')::timestamptz + make_interval(mins => dur));
    end if;
    -- a widget (anyone on the web) can only ask for a time that's open
    if k.kind = 'widget' and not exists (
        select 1 from json_array_elements(api_slots(k.workspace_id, p ->> 'service', ((p ->> 'start')::timestamptz at time zone
          coalesce((select timezone from api_booking_settings where workspace_id = k.workspace_id), 'UTC'))::date, 1, p ->> 'staff',
          coalesce((p ->> 'party_size')::int, 1)) -> 'slots') s
        where (s ->> 'start')::timestamptz = (p ->> 'start')::timestamptz) then
      return api_err('slot_not_available', 'That time isn''t free any more. Choose another time.');
    end if;
  end if;
  insert into api_inbox (workspace_id, kind, mode, payload, key_id, source, idempotency_key, body_hash)
    values (k.workspace_id, api_submit.kind, k.mode, p, k.id, case when k.kind = 'widget' then 'widget' else coalesce(nullif(api_submit.source, ''), 'api') end, idem, api_submit.body_hash)
    on conflict (workspace_id, key_id, idempotency_key) where idempotency_key is not null do nothing
    returning * into r;
  if r.id is null then   -- the same Idempotency-Key at the same moment: the other one won
    select * into r from api_inbox i where i.workspace_id = k.workspace_id and i.key_id = k.id and i.idempotency_key = idem;
    if r.body_hash is distinct from api_submit.body_hash then return api_err('idempotency_conflict', 'This Idempotency-Key was already used with a different request.'); end if;
    return json_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'test', r.mode = 'test', 'created_at', r.created_at, 'replay', true);
  end if;
  ev := case kind when 'booking' then 'booking.received' when 'order' then 'order.received' when 'enquiry' then 'enquiry.received'
    when 'quote_accept' then 'quote.accepted' when 'invoice_payment' then 'payment.received' end;
  if ev is not null then
    perform api_queue_event(k.workspace_id, k.mode, ev, jsonb_build_object('event_id', r.id, 'kind', r.kind, 'source', r.source, 'payload', r.payload));
  end if;
  return json_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'test', r.mode = 'test', 'created_at', r.created_at, 'replay', false);
end $$;

-- What a website reads: catalog, prices, stock, availability, slots or one event. params is a JSON object.
create or replace function public.api_read(key_id uuid, what text, params jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; sc text; g text; ws uuid; lim int; aft text; skus text[]; r json; nxt text; e api_inbox; typ text; since timestamptz;
  q jsonb := coalesce(params, '{}'::jsonb);
begin
  select * into k from api_keys a where a.id = api_read.key_id and a.revoked_at is null;
  if k.id is null then return api_err('invalid_key', 'That API key isn''t right.'); end if;
  ws := k.workspace_id;
  sc := case what when 'catalog' then 'catalog:read' when 'prices' then 'prices:read' when 'stock' then 'stock:read'
    when 'availability' then 'availability:read' when 'slots' then 'availability:read' when 'event' then null else 'unknown' end;
  if sc = 'unknown' then return api_err('not_found', 'There''s nothing here.'); end if;
  if sc is not null and not sc = any (k.scopes) then return api_err('missing_scope', 'This key isn''t allowed to do that (it needs ' || sc || ').'); end if;
  g := api_gate(ws, coalesce(sc, 'events:read'));
  if g is not null then return api_err(g, api_gate_message(g)); end if;
  lim := least(greatest(coalesce((q ->> 'limit')::int, 100), 1), 500);
  aft := nullif(q ->> 'after', '');
  if jsonb_typeof(q -> 'skus') = 'array' then
    select array_agg(x) into skus from (select jsonb_array_elements_text(q -> 'skus') x limit 200) y;
  end if;
  if what = 'event' then
    begin select * into e from api_inbox i where i.id = (q ->> 'id')::uuid and i.workspace_id = ws; exception when others then e := null; end;
    -- a widget key only sees what it sent itself
    if e.id is null or (k.kind = 'widget' and e.key_id is distinct from k.id) then return api_err('not_found', 'There''s no event with that id.'); end if;
    return json_build_object('id', e.id, 'kind', e.kind, 'status', e.status, 'test', e.mode = 'test', 'created_at', e.created_at,
      'updated_at', e.updated_at, 'result', coalesce(e.result, '{}'::jsonb));
  elsif what in ('catalog', 'prices') then
    typ := nullif(q ->> 'type', '');
    begin since := (q ->> 'updated_since')::timestamptz; exception when others then return api_err('invalid_request', 'updated_since must be a date and time.'); end;
    select json_agg(case when what = 'catalog' then json_build_object('sku', c.sku, 'type', c.type, 'name', c.name, 'description', c.description,
        'category', c.category, 'price', c.price, 'currency', c.currency, 'tax_rate', c.tax_rate, 'tax_included', c.tax_included, 'unit', c.unit,
        'duration_minutes', c.duration_minutes, 'active', c.active, 'updated_at', c.updated_at)
      else json_build_object('sku', c.sku, 'name', c.name, 'price', c.price, 'currency', c.currency, 'tax_rate', c.tax_rate, 'tax_included', c.tax_included) end
      order by c.sku), max(c.sku) into r, nxt
    from (select * from api_catalog c where c.workspace_id = ws and (aft is null or c.sku > aft) and (skus is null or c.sku = any (skus))
            and (typ is null or c.type = typ) and (since is null or c.updated_at > since) and (what = 'catalog' or c.active)
          order by c.sku limit lim + 1) c;
  elsif what = 'stock' then
    select json_agg(json_build_object('sku', s.sku, 'quantity', s.quantity, 'in_stock', s.quantity > 0, 'updated_at', s.updated_at) order by s.sku), max(s.sku) into r, nxt
    from (select * from api_stock s where s.workspace_id = ws and (aft is null or s.sku > aft) and (skus is null or s.sku = any (skus)) order by s.sku limit lim + 1) s;
  elsif what = 'availability' then
    return (select json_build_object('timezone', coalesce(b.timezone, 'UTC'), 'slot_minutes', coalesce(b.slot_minutes, 15),
        'min_notice_minutes', coalesce(b.min_notice_minutes, 60), 'days_ahead', coalesce(b.days_ahead, 30),
        'updated_at', (select updated_at from api_published p where p.workspace_id = ws and p.what = 'availability'),
        'services', (select coalesce(json_agg(json_build_object('sku', c.sku, 'name', c.name, 'description', c.description, 'category', c.category,
            'duration_minutes', c.duration_minutes, 'price', c.price, 'currency', c.currency) order by c.name), '[]')
          from api_catalog c where c.workspace_id = ws and c.type = 'service' and c.active and c.duration_minutes is not null),
        'staff', (select coalesce(json_agg(json_build_object('ref', s.ref, 'name', s.name, 'services', s.services) order by s.name), '[]')
          from api_staff s where s.workspace_id = ws and s.active))
      from (select 1) one left join api_booking_settings b on b.workspace_id = ws);
  elsif what = 'slots' then
    if coalesce(q ->> 'service', '') = '' then return api_err('invalid_request', 'Say which service (service=SKU).'); end if;
    begin
      r := api_slots(ws, q ->> 'service', (q ->> 'from')::date, (q ->> 'days')::int, nullif(q ->> 'staff', ''), (q ->> 'party_size')::int);
    exception when others then return api_err('invalid_request', 'from is a date (YYYY-MM-DD), days and party_size are numbers.'); end;
    if r is null then return api_err('not_found', 'There''s no bookable service with that SKU.'); end if;
    return r;
  end if;
  -- one page: if there's one more than the limit, there's a next page starting after the last one shown
  if r is not null and json_array_length(r) > lim then
    r := (select json_agg(x order by i) from (select x, i from json_array_elements(r) with ordinality t(x, i) where i <= lim) y);
    nxt := r -> (lim - 1) ->> 'sku';
  else nxt := null; end if;
  return json_build_object('items', coalesce(r, '[]'), 'next', nxt,
    'updated_at', (select updated_at from api_published p where p.workspace_id = ws and p.what = case when api_read.what = 'stock' then 'stock' else 'catalog' end));
end $$;

-- ---------------------------------------------------------------- for the business's linked PCs (Riyeser desktop)
-- Take up to max_items from the post box (oldest first; optionally only some kinds). Each is "taken" by this PC for
-- 10 minutes: a PC that doesn't finish in time (it closed, lost the internet) lets another PC take it again.
-- FOR UPDATE SKIP LOCKED: two PCs asking at once never get the same one.
create or replace function public.api_inbox_claim(ws uuid, device uuid, kinds text[], max_items int) returns json
  language plpgsql security definer set search_path = public as $$
declare r json;
begin
  perform api_need_pc(ws, device);
  with c as (
    select i.id from api_inbox i
    where i.workspace_id = ws and ((i.status = 'waiting' and i.available_at <= now()) or (i.status = 'taken' and i.taken_at < now() - interval '10 minutes'))
      and (kinds is null or cardinality(kinds) = 0 or i.kind = any (kinds))
    order by i.created_at, i.id limit least(greatest(coalesce(max_items, 20), 1), 100)
    for update skip locked),
  t as (update api_inbox i set status = 'taken', taken_by = device, taken_at = now(), attempts = i.attempts + 1, updated_at = now()
        from c where i.id = c.id returning i.*)
  select coalesce(json_agg(json_build_object('id', t.id, 'kind', t.kind, 'test', t.mode = 'test', 'source', t.source,
      'key_name', (select name from api_keys k where k.id = t.key_id), 'attempts', t.attempts, 'created_at', t.created_at, 'payload', t.payload)
      order by t.created_at), '[]') into r from t;
  return r;
end $$;

-- Clean what the website may see: {reference, state, message}.
create or replace function public.api_clean_result(res jsonb) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'reference', left(regexp_replace(res ->> 'reference', '[[:cntrl:]<>]', '', 'g'), 60),
    'state', case when res ->> 'state' ~ '^[a-z_]{1,30}$' then res ->> 'state' end,
    'message', left(regexp_replace(res ->> 'message', '[[:cntrl:]<>]', '', 'g'), 300)))
$$;
-- Filed (in Bookings, POS, Invoices, Accounting): result = {reference: "BK-1042", state: "pending"|"confirmed"|…, message}.
create or replace function public.api_inbox_done(ws uuid, device uuid, event_id uuid, result jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare e api_inbox;
begin
  perform api_need_pc(ws, device);
  update api_inbox set status = 'done', done_at = now(), updated_at = now(), error = null,
      result = api_clean_result(coalesce(api_inbox_done.result, '{}'::jsonb))
    where id = event_id and workspace_id = ws and status = 'taken' and taken_by = device returning * into e;
  if e.id is null then raise exception 'This PC hasn''t taken that one (or it was finished already).'; end if;
  return json_build_object('id', e.id, 'status', e.status);
end $$;
-- Couldn't file it. retry = true: it goes back in the post box (after 1, 2, 4, 8 minutes; after 5 tries it's
-- "failed"). retry = false: "rejected" (e.g. the time was taken, the quote has expired) with result for the website.
create or replace function public.api_inbox_fail(ws uuid, device uuid, event_id uuid, reason text, retry boolean, result jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare e api_inbox;
begin
  perform api_need_pc(ws, device);
  update api_inbox i set
      status = case when not coalesce(retry, true) then 'rejected' when i.attempts >= 5 then 'failed' else 'waiting' end,
      available_at = now() + make_interval(mins => power(2, greatest(i.attempts - 1, 0))::int),
      error = left(regexp_replace(coalesce(reason, ''), '[[:cntrl:]]', ' ', 'g'), 500), updated_at = now(),
      done_at = case when not coalesce(retry, true) or i.attempts >= 5 then now() end,
      taken_by = case when coalesce(retry, true) and i.attempts < 5 then null else i.taken_by end,
      result = case when api_inbox_fail.result is not null then api_clean_result(api_inbox_fail.result) else i.result end
    where i.id = event_id and i.workspace_id = ws and i.status = 'taken' and i.taken_by = device returning * into e;
  if e.id is null then raise exception 'This PC hasn''t taken that one (or it was finished already).'; end if;
  return json_build_object('id', e.id, 'status', e.status, 'attempts', e.attempts);
end $$;
create or replace function public.api_inbox_counts(ws uuid, device uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_pc(ws, device);
  return (select json_build_object('waiting', count(*) filter (where status = 'waiting'), 'taken', count(*) filter (where status = 'taken'),
      'failed', count(*) filter (where status = 'failed'), 'test_waiting', count(*) filter (where status = 'waiting' and mode = 'test'))
    from api_inbox where workspace_id = ws);
end $$;
-- Later news about something that came in (or not from the post box at all, without event_id): booking.confirmed,
-- booking.cancelled, order.ready, order.completed. data: {reference, state, message, ...}; with event_id, the event's
-- result is updated too, so the website sees it (GET /v1/events/{id}).
create or replace function public.api_notify(ws uuid, device uuid, event text, event_id uuid, data jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare e api_inbox; md text := 'live'; d jsonb := coalesce(data, '{}'::jsonb); n int;
begin
  perform api_need_pc(ws, device);
  if not event = any (api_pc_events()) then raise exception 'Unknown event: %.', left(event, 40); end if;
  if jsonb_typeof(d) <> 'object' or octet_length(d::text) > 16384 then raise exception 'data must be a JSON object (16 KB at most).'; end if;
  if event_id is not null then
    select * into e from api_inbox where id = event_id and workspace_id = ws;
    if e.id is null then raise exception 'There''s no event with that id.'; end if;
    if split_part(event, '.', 1) <> e.kind then raise exception 'That event is a %, not a %.', e.kind, split_part(event, '.', 1); end if;
    md := e.mode;
    update api_inbox set result = coalesce(result, '{}'::jsonb) || api_clean_result(d || jsonb_build_object('state', coalesce(d ->> 'state', split_part(event, '.', 2)))),
        updated_at = now() where id = e.id;
    d := d || jsonb_build_object('event_id', e.id, 'external_reference', e.payload ->> 'reference');
  end if;
  n := api_queue_event(ws, md, event, d);
  return json_build_object('queued', n);
end $$;

-- Publishing. Each item is checked; ones that don't fit are skipped and listed (sku and why), the rest are saved.
-- full_sync = true: what isn't in the list is removed (send everything); false: only these are added or changed.
create or replace function public.api_publish_catalog(ws uuid, device uuid, items jsonb, full_sync boolean) returns json
  language plpgsql security definer set search_path = public as $$
declare it jsonb; n int := 0; removed int := 0; skipped jsonb := '[]'; seen text[] := '{}';
begin
  perform api_need_pc(ws, device);
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 5000 then raise exception 'Send a list of up to 5000 items.'; end if;
  for it in select * from jsonb_array_elements(items) loop
    begin
      insert into api_catalog (workspace_id, sku, type, name, description, category, price, currency, tax_rate, tax_included, unit, duration_minutes, active, updated_at)
        values (ws, it ->> 'sku', coalesce(it ->> 'type', 'product'), trim(it ->> 'name'), nullif(it ->> 'description', ''), nullif(it ->> 'category', ''),
          (it ->> 'price')::numeric, upper(nullif(it ->> 'currency', '')), (it ->> 'tax_rate')::numeric, coalesce((it ->> 'tax_included')::boolean, true),
          nullif(it ->> 'unit', ''), (it ->> 'duration_minutes')::int, coalesce((it ->> 'active')::boolean, true), now())
      on conflict (workspace_id, sku) do update set type = excluded.type, name = excluded.name, description = excluded.description,
        category = excluded.category, price = excluded.price, currency = excluded.currency, tax_rate = excluded.tax_rate,
        tax_included = excluded.tax_included, unit = excluded.unit, duration_minutes = excluded.duration_minutes, active = excluded.active, updated_at = now();
      n := n + 1; seen := seen || (it ->> 'sku');
    exception when others then
      skipped := skipped || jsonb_build_object('sku', left(it ->> 'sku', 64), 'reason', left(sqlerrm, 200));
    end;
  end loop;
  if full_sync then
    delete from api_catalog where workspace_id = ws and not sku = any (seen);
    get diagnostics removed = row_count;
  end if;
  insert into api_published (workspace_id, what, updated_at, device_id) values (ws, 'catalog', now(), device)
    on conflict (workspace_id, what) do update set updated_at = now(), device_id = device;
  return json_build_object('saved', n, 'removed', removed, 'skipped', skipped);
end $$;

-- Stock: [{sku, quantity}]. What changed is announced as one stock.changed webhook (up to 500 items).
create or replace function public.api_publish_stock(ws uuid, device uuid, levels jsonb, full_sync boolean) returns json
  language plpgsql security definer set search_path = public as $$
declare it jsonb; n int := 0; removed int := 0; skipped jsonb := '[]'; seen text[] := '{}'; changed jsonb := '[]'; was numeric; q numeric;
begin
  perform api_need_pc(ws, device);
  if jsonb_typeof(levels) <> 'array' or jsonb_array_length(levels) > 10000 then raise exception 'Send a list of up to 10000 stock levels.'; end if;
  for it in select * from jsonb_array_elements(levels) loop
    begin
      q := (it ->> 'quantity')::numeric;
      if q is null then raise exception 'quantity is needed'; end if;
      select quantity into was from api_stock where workspace_id = ws and sku = it ->> 'sku';
      insert into api_stock (workspace_id, sku, quantity, updated_at) values (ws, it ->> 'sku', q, now())
        on conflict (workspace_id, sku) do update set quantity = excluded.quantity, updated_at = now();
      if was is distinct from q and jsonb_array_length(changed) < 500 then
        changed := changed || jsonb_build_object('sku', it ->> 'sku', 'quantity', q, 'previous', was);
      end if;
      n := n + 1; seen := seen || (it ->> 'sku');
    exception when others then
      skipped := skipped || jsonb_build_object('sku', left(it ->> 'sku', 64), 'reason', left(sqlerrm, 200));
    end;
  end loop;
  if full_sync then
    delete from api_stock where workspace_id = ws and not sku = any (seen);
    get diagnostics removed = row_count;
  end if;
  insert into api_published (workspace_id, what, updated_at, device_id) values (ws, 'stock', now(), device)
    on conflict (workspace_id, what) do update set updated_at = now(), device_id = device;
  if jsonb_array_length(changed) > 0 then perform api_queue_event(ws, 'live', 'stock.changed', jsonb_build_object('items', changed)); end if;
  return json_build_object('saved', n, 'removed', removed, 'skipped', skipped, 'changed', jsonb_array_length(changed));
end $$;

-- Booking times. settings {timezone, slot_minutes, min_notice_minutes, days_ahead} (null: unchanged);
-- staff [{ref, name, services, active}] (null: unchanged; a list replaces them all);
-- open_times [{staff_ref, start, end, capacity}] replace every open time starting in [from_at, to_at).
create or replace function public.api_publish_availability(ws uuid, device uuid, settings jsonb, staff jsonb, open_times jsonb,
  from_at timestamptz, to_at timestamptz) returns json
  language plpgsql security definer set search_path = public as $$
declare it jsonb; n int := 0; ns int := 0; removed int := 0; skipped jsonb := '[]'; tz text;
begin
  perform api_need_pc(ws, device);
  if settings is not null then
    if jsonb_typeof(settings) <> 'object' then raise exception 'settings must be an object.'; end if;
    tz := coalesce(nullif(settings ->> 'timezone', ''), (select timezone from api_booking_settings where workspace_id = ws), 'UTC');
    if not exists (select 1 from pg_timezone_names where name = tz) then raise exception 'Unknown time zone: %.', left(tz, 60); end if;
    insert into api_booking_settings (workspace_id, timezone, slot_minutes, min_notice_minutes, days_ahead, updated_at)
      values (ws, tz, coalesce((settings ->> 'slot_minutes')::int, 15), coalesce((settings ->> 'min_notice_minutes')::int, 60),
              coalesce((settings ->> 'days_ahead')::int, 30), now())
      on conflict (workspace_id) do update set timezone = excluded.timezone,
        slot_minutes = coalesce((settings ->> 'slot_minutes')::int, api_booking_settings.slot_minutes),
        min_notice_minutes = coalesce((settings ->> 'min_notice_minutes')::int, api_booking_settings.min_notice_minutes),
        days_ahead = coalesce((settings ->> 'days_ahead')::int, api_booking_settings.days_ahead), updated_at = now();
  end if;
  if staff is not null then
    if jsonb_typeof(staff) <> 'array' or jsonb_array_length(staff) > 500 then raise exception 'staff must be a list (up to 500).'; end if;
    delete from api_staff where workspace_id = ws;
    for it in select * from jsonb_array_elements(staff) loop
      begin
        insert into api_staff (workspace_id, ref, name, services, active, updated_at)
          values (ws, it ->> 'ref', trim(it ->> 'name'),
            coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(it -> 'services') = 'array' then it -> 'services' else '[]' end) x), '{}'),
            coalesce((it ->> 'active')::boolean, true), now());
        ns := ns + 1;
      exception when others then skipped := skipped || jsonb_build_object('staff', left(it ->> 'ref', 64), 'reason', left(sqlerrm, 200));
      end;
    end loop;
  end if;
  if open_times is not null then
    if from_at is null or to_at is null or to_at <= from_at or to_at - from_at > interval '400 days' then
      raise exception 'Say which time open_times covers (from_at before to_at, up to 400 days).';
    end if;
    if jsonb_typeof(open_times) <> 'array' or jsonb_array_length(open_times) > 20000 then raise exception 'open_times must be a list (up to 20000).'; end if;
    delete from api_open_times where workspace_id = ws and starts_at >= from_at and starts_at < to_at;
    get diagnostics removed = row_count;
    for it in select * from jsonb_array_elements(open_times) loop
      begin
        if (it ->> 'start')::timestamptz < from_at or (it ->> 'start')::timestamptz >= to_at then raise exception 'outside from_at..to_at'; end if;
        insert into api_open_times (workspace_id, staff_ref, starts_at, ends_at, capacity)
          values (ws, nullif(it ->> 'staff_ref', ''), (it ->> 'start')::timestamptz, (it ->> 'end')::timestamptz, coalesce((it ->> 'capacity')::int, 1));
        n := n + 1;
      exception when others then skipped := skipped || jsonb_build_object('open_time', it ->> 'start', 'reason', left(sqlerrm, 200));
      end;
    end loop;
  end if;
  -- old open times aren't needed
  delete from api_open_times where workspace_id = ws and ends_at < now() - interval '1 day';
  insert into api_published (workspace_id, what, updated_at, device_id) values (ws, 'availability', now(), device)
    on conflict (workspace_id, what) do update set updated_at = now(), device_id = device;
  return json_build_object('open_times_saved', n, 'open_times_removed', removed, 'staff_saved', ns, 'skipped', skipped);
end $$;

-- ---------------------------------------------------------------- for owners and admins (Management -> Connections)
create or replace function public.api_overview(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return json_build_object(
    'keys', (select json_build_object('active', count(*) filter (where revoked_at is null), 'revoked', count(*) filter (where revoked_at is not null)) from api_keys where workspace_id = ws),
    'inbox', (select json_build_object('waiting', count(*) filter (where status = 'waiting'), 'taken', count(*) filter (where status = 'taken'),
        'failed', count(*) filter (where status = 'failed'), 'rejected_7d', count(*) filter (where status = 'rejected' and updated_at > now() - interval '7 days'),
        'done_7d', count(*) filter (where status = 'done' and done_at > now() - interval '7 days')) from api_inbox where workspace_id = ws),
    'published', json_build_object(
        'catalog_items', (select count(*) from api_catalog where workspace_id = ws),
        'stock_items', (select count(*) from api_stock where workspace_id = ws),
        'open_times', (select count(*) from api_open_times where workspace_id = ws and ends_at > now()),
        'staff', (select count(*) from api_staff where workspace_id = ws and active),
        'catalog_at', (select updated_at from api_published where workspace_id = ws and what = 'catalog'),
        'stock_at', (select updated_at from api_published where workspace_id = ws and what = 'stock'),
        'availability_at', (select updated_at from api_published where workspace_id = ws and what = 'availability')),
    'webhooks', (select json_build_object('active', count(*) filter (where active), 'failing', count(*) filter (where failing_since is not null)) from api_webhooks where workspace_id = ws),
    'requests_24h', (select count(*) from api_requests where workspace_id = ws and at > now() - interval '24 hours'),
    'errors_24h', (select count(*) from api_requests where workspace_id = ws and at > now() - interval '24 hours' and status >= 400),
    'allowed', json_build_object('any', api_gate(ws, 'prices:read') is null, 'bookings', api_gate(ws, 'bookings:write') is null,
        'orders', api_gate(ws, 'orders:write') is null));
end $$;
-- The post box, newest first (status: null for all). Only the customer's name from what was sent.
create or replace function public.api_inbox_recent(ws uuid, status text, max_rows int) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(json_build_object('id', i.id, 'kind', i.kind, 'test', i.mode = 'test', 'status', i.status, 'source', i.source,
      'key_name', (select name from api_keys k where k.id = i.key_id), 'attempts', i.attempts, 'error', i.error, 'result', i.result,
      'customer_name', coalesce(i.payload #>> '{customer,name}', i.payload ->> 'name', i.payload #>> '{accepted_by,name}', i.payload #>> '{payer,name}'),
      'taken_by_pc', (select device_name from devices d where d.id = i.taken_by), 'created_at', i.created_at, 'updated_at', i.updated_at) order by i.created_at desc), '[]')
    from (select * from api_inbox i where i.workspace_id = ws and (api_inbox_recent.status is null or i.status = api_inbox_recent.status)
          order by i.created_at desc limit least(greatest(coalesce(max_rows, 50), 1), 200)) i);
end $$;
-- Try a failed or rejected one again (it goes back in the post box).
create or replace function public.api_inbox_retry(ws uuid, event_id uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare e api_inbox;
begin
  perform api_need_admin(ws);
  update api_inbox set status = 'waiting', attempts = 0, available_at = now(), taken_by = null, taken_at = null, done_at = null, updated_at = now()
    where id = event_id and workspace_id = ws and status in ('failed', 'rejected') returning * into e;
  if e.id is null then raise exception 'Only a failed or rejected one can be tried again.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_inbox.retry', jsonb_build_object('id', e.id, 'kind', e.kind));
  return json_build_object('id', e.id, 'status', e.status);
end $$;

-- ---------------------------------------------------------------- tidying up (the dispatcher runs it; safe any time)
-- Finished post box items: 90 days. Never collected by a PC in 90 days: marked failed (then kept 90 more days).
-- Request log and webhook deliveries: 30 days. Rate counters: when their window has passed.
create or replace function public.api_sweep() returns json
  language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int;
begin
  update api_inbox set status = 'failed', error = 'Not collected by a linked PC within 90 days.', updated_at = now(), done_at = now()
    where status in ('waiting', 'taken') and created_at < now() - interval '90 days';
  get diagnostics e = row_count;
  delete from api_inbox where status in ('done', 'failed', 'rejected') and updated_at < now() - interval '90 days';
  get diagnostics a = row_count;
  delete from api_requests where at < now() - interval '30 days';
  get diagnostics b = row_count;
  delete from api_webhook_deliveries where created_at < now() - interval '30 days' and status in ('delivered', 'failed');
  get diagnostics c = row_count;
  delete from api_rate where expires_at < now();
  get diagnostics d = row_count;
  return json_build_object('inbox_expired', e, 'inbox_removed', a, 'requests_removed', b, 'deliveries_removed', c, 'rate_removed', d);
end $$;

-- ---------------------------------------------------------------- who may call what
revoke all on function public.api_err(text, text), public.api_scopes(), public.api_widget_scopes(), public.api_kind_scope(text), public.api_events(),
  public.api_pc_events(), public.api_ip_trunc(text), public.api_need_admin(uuid), public.api_pc_ok(uuid, uuid), public.api_need_pc(uuid, uuid),
  public.api_mod_on(uuid, text), public.api_gate(uuid, text), public.api_gate_message(text), public.api_random_hex(int),
  public.api_clean_origins(text[], text), public.api_clean_ips(text[]), public.api_key_json(public.api_keys),
  public.api_key_create(uuid, text, text, text, text[], text[], text[]), public.api_keys_list(uuid), public.api_key_revoke(uuid, uuid),
  public.api_key_rename(uuid, uuid, text), public.api_key_set_access(uuid, uuid, text[], text[]), public.api_rate_hit(text, interval),
  public.api_auth(text, text), public.api_log_request(uuid, text, text, int, int, text, text), public.api_requests_list(uuid, uuid, int, bigint),
  public.api_clean_url(text), public.api_queue_event(uuid, text, text, jsonb), public.api_webhook_json(public.api_webhooks), public.api_clean_events(text[]),
  public.api_webhook_create(uuid, text, text[], text, text), public.api_webhooks_list(uuid), public.api_webhook_update(uuid, uuid, text, text[], boolean),
  public.api_webhook_rotate(uuid, uuid), public.api_webhook_delete(uuid, uuid), public.api_webhook_ping(uuid, uuid),
  public.api_webhook_deliveries_list(uuid, uuid, int), public.api_webhooks_due(int, uuid), public.api_webhook_result(uuid, boolean, int, text),
  public.api_slots(uuid, text, date, int, text, int), public.api_submit(uuid, text, jsonb, text, text, text), public.api_read(uuid, text, jsonb),
  public.api_inbox_claim(uuid, uuid, text[], int), public.api_clean_result(jsonb), public.api_inbox_done(uuid, uuid, uuid, jsonb),
  public.api_inbox_fail(uuid, uuid, uuid, text, boolean, jsonb), public.api_inbox_counts(uuid, uuid), public.api_notify(uuid, uuid, text, uuid, jsonb),
  public.api_publish_catalog(uuid, uuid, jsonb, boolean), public.api_publish_stock(uuid, uuid, jsonb, boolean),
  public.api_publish_availability(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, timestamptz), public.api_overview(uuid),
  public.api_inbox_recent(uuid, text, int), public.api_inbox_retry(uuid, uuid), public.api_sweep()
  from public, anon, authenticated;
-- owners and admins (each checks two-step sign-in), and the business's linked PCs (each checks the PC)
grant execute on function public.api_key_create(uuid, text, text, text, text[], text[], text[]), public.api_keys_list(uuid),
  public.api_key_revoke(uuid, uuid), public.api_key_rename(uuid, uuid, text), public.api_key_set_access(uuid, uuid, text[], text[]),
  public.api_requests_list(uuid, uuid, int, bigint), public.api_webhook_create(uuid, text, text[], text, text), public.api_webhooks_list(uuid),
  public.api_webhook_update(uuid, uuid, text, text[], boolean), public.api_webhook_rotate(uuid, uuid), public.api_webhook_delete(uuid, uuid),
  public.api_webhook_ping(uuid, uuid), public.api_webhook_deliveries_list(uuid, uuid, int), public.api_overview(uuid),
  public.api_inbox_recent(uuid, text, int), public.api_inbox_retry(uuid, uuid), public.api_scopes(), public.api_widget_scopes(), public.api_events(),
  public.api_pc_ok(uuid, uuid), public.api_inbox_claim(uuid, uuid, text[], int), public.api_inbox_done(uuid, uuid, uuid, jsonb),
  public.api_inbox_fail(uuid, uuid, uuid, text, boolean, jsonb), public.api_inbox_counts(uuid, uuid), public.api_notify(uuid, uuid, text, uuid, jsonb),
  public.api_publish_catalog(uuid, uuid, jsonb, boolean), public.api_publish_stock(uuid, uuid, jsonb, boolean),
  public.api_publish_availability(uuid, uuid, jsonb, jsonb, jsonb, timestamptz, timestamptz) to authenticated;
-- only the "api" Edge Function (Supabase's service role)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.api_auth(text, text), public.api_submit(uuid, text, jsonb, text, text, text), public.api_read(uuid, text, jsonb),
      public.api_log_request(uuid, text, text, int, int, text, text), public.api_webhooks_due(int, uuid), public.api_webhook_result(uuid, boolean, int, text),
      public.api_sweep() to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------- Riyeser Estimate (licence module 'estimate')
-- Measure jobs on a plan, a photo or the map, and turn them into quotes. Free for 90 days from FIRST USE: the trial
-- starts the first time Riyeser Central reports the program on one of the business's PCs (report_programs), and the
-- program itself keeps its own first-use date on the PC until then. After the trial it's US$20 a month with 3 users
-- included (riyeser_price('estimate'); extra users US$7), billed like the other paid programs; not in any bundle.
-- Safe to run again: only adds 'estimate' to the allowed programs and starts trials that haven't started.
alter table public.company_modules drop constraint if exists company_modules_module_check;
alter table public.company_modules add constraint company_modules_module_check
  check (module in ('basic', 'plus', 'payroll', 'pos', 'bookings', 'as_built', 'calls', 'estimate'));

create or replace function public.company_modules_first_use() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.programs, '[]'::jsonb) @> '[{"id": "estimate"}]'::jsonb then
    insert into company_modules (workspace_id, module, status, trial_ends)
      values (new.workspace_id, 'estimate', 'trial', current_date + 90)
      on conflict (workspace_id, module) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.company_modules_first_use() from public, anon, authenticated;
drop trigger if exists company_modules_first_use on public.devices;
create trigger company_modules_first_use after insert or update of programs on public.devices
  for each row execute function public.company_modules_first_use();
-- PCs that already have Riyeser Estimate: start their business's trial today (never shortens one already running)
insert into public.company_modules (workspace_id, module, status, trial_ends)
  select distinct d.workspace_id, 'estimate', 'trial', current_date + 90 from public.devices d
  where coalesce(d.programs, '[]'::jsonb) @> '[{"id": "estimate"}]'::jsonb
  on conflict (workspace_id, module) do nothing;

-- ================================================================ Online connections: where it stands, and "Send a test"
-- For Riyeser Central on a linked PC (and owners/admins): one cheap call that says whether online connections are set
-- up at all (keys, webhooks, anything ever received), what's waiting, what's published and which PC brings items in.
-- Central uses it to show "Not set up" (and not run its claim loop) until something exists, and to tick the
-- "Connect your website" checklist from what really happened. Safe to run again.
create or replace function public.api_status(ws uuid, device uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare k record; h record; i record; dev uuid;
begin
  if not (public.api_pc_ok(ws, device) or public.is_admin(ws)) then
    raise exception 'Link this PC to the business first (Riyeser Central).';
  end if;
  select count(*) filter (where revoked_at is null) as active, count(*) filter (where revoked_at is null and kind = 'widget') as widget,
         count(*) filter (where revoked_at is null and mode = 'test') as test, max(created_at) filter (where revoked_at is null) as first_at
    into k from api_keys where workspace_id = ws;
  select count(*) filter (where active) as active, count(*) filter (where failing_since is not null) as failing
    into h from api_webhooks where workspace_id = ws;
  select count(*) filter (where status = 'waiting') as waiting, count(*) filter (where status = 'taken') as taken,
         count(*) filter (where status = 'failed') as failed, count(*) filter (where status = 'waiting' and mode = 'test') as test_waiting,
         count(*) filter (where status = 'done' and mode = 'live') as done_total, count(*) filter (where mode = 'live') as live_total,
         max(created_at) as last_in_at
    into i from api_inbox where workspace_id = ws;
  -- the PC that brings items in: whichever took one or published most recently
  select x.d into dev from (
      select taken_by as d, coalesce(taken_at, updated_at) as t from api_inbox where workspace_id = ws and taken_by is not null
      union all select device_id, updated_at from api_published where workspace_id = ws and device_id is not null) x
    order by x.t desc limit 1;
  return json_build_object(
    'set_up', k.active > 0 or h.active > 0 or i.live_total > 0,
    'keys', json_build_object('active', k.active, 'widget', k.widget, 'test', k.test),
    'webhooks', json_build_object('active', h.active, 'failing', h.failing),
    'requests_24h', (select count(*) from api_requests where workspace_id = ws and at > now() - interval '24 hours'),
    'last_request_at', (select max(at) from api_requests where workspace_id = ws),
    'inbox', json_build_object('waiting', i.waiting, 'taken', i.taken, 'failed', i.failed, 'test_waiting', i.test_waiting,
        'done_total', i.done_total, 'last_in_at', i.last_in_at),
    'published', json_build_object(
        'catalog_items', (select count(*) from api_catalog where workspace_id = ws),
        'catalog_at', (select updated_at from api_published where workspace_id = ws and what = 'catalog'),
        'stock_at', (select updated_at from api_published where workspace_id = ws and what = 'stock'),
        'availability_at', (select updated_at from api_published where workspace_id = ws and what = 'availability')),
    'sync_pc', case when dev is null then null else json_build_object('name', (select device_name from devices where id = dev),
        'this_pc', dev is not distinct from device) end,
    'allowed', json_build_object('any', api_gate(ws, 'prices:read') is null, 'bookings', api_gate(ws, 'bookings:write') is null,
        'orders', api_gate(ws, 'orders:write') is null),
    'checked_at', now());
end $$;

-- "Send a test": a test booking, enquiry or order request put in the post box exactly as a test key would send it
-- (mode test, source "test"), with the same licence checks and test webhooks. A linked PC brings it in within a
-- minute and files it as a test (every check runs, nothing is kept in the books). Up to 20 an hour per business.
create or replace function public.api_send_test(ws uuid, device uuid, kind text) returns json
  language plpgsql security definer set search_path = public as $$
declare g text; p jsonb; svc api_catalog; slot timestamptz; r api_inbox; item api_catalog;
  who jsonb := jsonb_build_object('name', 'Test Customer (from Riyeser)', 'email', 'test@example.com');
begin
  if not (public.api_pc_ok(ws, device) or public.is_admin(ws)) then
    raise exception 'Link this PC to the business first (Riyeser Central).';
  end if;
  if kind is null or kind not in ('booking', 'enquiry', 'order') then raise exception 'Choose a test booking, enquiry or order request.'; end if;
  g := api_gate(ws, case kind when 'booking' then 'bookings:write' else 'enquiries:write' end);
  if g is not null then raise exception '%', api_gate_message(g); end if;
  if api_rate_hit('test:' || ws || ':' || to_char(now(), 'YYYYMMDDHH24'), interval '2 hours') > 20 then
    raise exception 'That''s a lot of tests this hour. Wait a little and try again.';
  end if;
  if kind = 'booking' then
    select * into svc from api_catalog c where c.workspace_id = ws and c.type = 'service' and c.active and c.duration_minutes is not null
      order by c.sku limit 1;
    if svc.sku is null then
      raise exception 'There''s no service published yet. Add a service in Riyeser Bookings (Riyeser Central publishes it within a minute), or send a test enquiry.';
    end if;
    select starts_at into slot from api_open_times o where o.workspace_id = ws and o.starts_at > now() + interval '1 hour'
      order by o.starts_at limit 1;
    slot := coalesce(slot, date_trunc('hour', now()) + interval '1 day');
    p := jsonb_build_object('service', svc.sku, 'start', to_char(slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"'),
      'end', to_char((slot + make_interval(mins => svc.duration_minutes)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"'),
      'party_size', 1, 'customer', who, 'notes', 'A test booking from Send a test. It is never added to your calendar.');
  elsif kind = 'order' then
    select * into item from api_catalog c where c.workspace_id = ws and c.type = 'product' and c.active order by c.sku limit 1;
    p := jsonb_build_object('customer', who, 'subject', 'Test order request',
      'message', 'A test order request from Send a test. Nothing is added to your books.',
      'metadata', jsonb_build_object('order_sku', coalesce(item.sku, 'TEST-ITEM'), 'order_quantity', 1));
    kind := 'enquiry';
  else
    p := jsonb_build_object('customer', who, 'subject', 'Test enquiry',
      'message', 'A test enquiry from Send a test. Nothing is added to your books.');
  end if;
  insert into api_inbox (workspace_id, kind, mode, payload, key_id, source)
    values (ws, api_send_test.kind, 'test', p, null, 'test') returning * into r;
  perform api_queue_event(ws, 'test', case r.kind when 'booking' then 'booking.received' else 'enquiry.received' end,
    jsonb_build_object('event_id', r.id, 'kind', r.kind, 'source', r.source, 'payload', r.payload));
  return json_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'test', true, 'created_at', r.created_at);
end $$;

-- Where one post-box item is (for "Send a test": waiting → taken by a PC → done). Test items, or any for admins.
create or replace function public.api_event_status(ws uuid, device uuid, event_id uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare e api_inbox;
begin
  if not (public.api_pc_ok(ws, device) or public.is_admin(ws)) then
    raise exception 'Link this PC to the business first (Riyeser Central).';
  end if;
  select * into e from api_inbox i where i.id = event_id and i.workspace_id = ws and (i.mode = 'test' or public.is_admin(ws));
  if e.id is null then raise exception 'That test isn''t in the post box (it may be more than 90 days old).'; end if;
  return json_build_object('id', e.id, 'kind', e.kind, 'status', e.status, 'test', e.mode = 'test', 'result', e.result,
    'error', case when public.is_admin(ws) then e.error end, 'taken_by_pc', (select device_name from devices d where d.id = e.taken_by),
    'created_at', e.created_at, 'updated_at', e.updated_at);
end $$;

revoke all on function public.api_status(uuid, uuid), public.api_send_test(uuid, uuid, text), public.api_event_status(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.api_status(uuid, uuid), public.api_send_test(uuid, uuid, text), public.api_event_status(uuid, uuid, uuid)
  to authenticated;

-- ===== Riyeser Link: the channel menu, part 2 (mute for a while, a line in the chat for each change, members in the history) =====
-- Safe to re-run. Members see a line in the chat when a channel changes ("Ana renamed #jobs to #site-jobs"); the change
-- history (owners and admins) has each one too. Mute can be for 1 hour, 8 hours, until tomorrow, a week, or until turned back on.
alter table public.channel_prefs add column if not exists muted_until timestamptz;   -- null: muted until turned back on

-- A line Riyeser Link adds to a chat (not a message anyone typed): kind + details; body is the same words for older apps.
alter table public.messages add column if not exists system jsonb;
do $$ begin
  alter table public.messages add constraint messages_system_shape check (system is null or (jsonb_typeof(system) = 'object'
    and system ->> 'kind' in ('rename', 'topic', 'archive', 'unarchive', 'add', 'remove', 'left', 'removed')));
exception when duplicate_object then null; end $$;

-- Only the database adds these lines, and nobody can change them afterwards (owner-approved removal blanks them).
create or replace function public.messages_system_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.system is not null and coalesce(current_setting('riyeser.system_line', true), '') <> 'on' then
      raise exception 'Only Riyeser Link adds these lines to a chat.'; end if;
    return new;
  end if;
  if current_setting('riyeser.removing', true) = 'on' then
    if old.system is not null then new.system := '{"kind": "removed"}'::jsonb; end if;
    return new;
  end if;
  if old.system is not null or new.system is distinct from old.system then
    raise exception 'This line can''t be changed.'; end if;
  return new;
end $$;
drop trigger if exists messages_system_guard on public.messages;
create trigger messages_system_guard before insert or update on public.messages for each row execute function public.messages_system_guard();

-- An archived channel stays read-only, but its own "archived" line still goes in.
create or replace function public.channel_open_guard() returns trigger language plpgsql as $$
begin
  if current_setting('riyeser.removing', true) = 'on' then return new; end if;
  if tg_table_name = 'messages' and tg_op = 'INSERT' and to_jsonb(new) ->> 'system' is not null
     and coalesce(current_setting('riyeser.system_line', true), '') = 'on' then return new; end if;
  if exists (select 1 from public.channels c where c.id = new.channel_id and c.archived) then
    raise exception 'This channel is archived, so it''s read-only. Whoever made it, or an owner or admin, can bring it back.';
  end if;
  return new;
end $$;

-- Add a line to a chat, as the person who made the change (no line when there's no one signed in, e.g. a fix by Riyeser).
create or replace function public.channel_note(ch uuid, ws uuid, kind text, details jsonb, words text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('riyeser.removing', true) = 'on' then return; end if;
  perform set_config('riyeser.system_line', 'on', true);
  insert into messages (channel_id, workspace_id, user_id, body, system)
    values (ch, ws, auth.uid(), left(words, 4000), coalesce(details, '{}'::jsonb) || jsonb_build_object('kind', kind));
  perform set_config('riyeser.system_line', 'off', true);
end $$;
revoke all on function public.channel_note(uuid, uuid, text, jsonb, text) from public, anon, authenticated;

-- Every rename, topic change and archiving (through the menu or not) goes in the history and in the chat.
create or replace function public.channel_changed() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if current_setting('riyeser.removing', true) = 'on' or new.kind = 'dm' then return null; end if;
  if new.name is distinct from old.name then
    insert into audit_log (workspace_id, action, details) values (new.workspace_id, 'channel.rename', jsonb_build_object('name', '#' || new.name, 'was', '#' || old.name));
    perform channel_note(new.id, new.workspace_id, 'rename', jsonb_build_object('was', old.name, 'now', new.name), 'renamed #' || old.name || ' to #' || new.name);
  end if;
  if new.topic is distinct from old.topic then
    insert into audit_log (workspace_id, action, details) values (new.workspace_id, 'channel.topic', jsonb_build_object('name', '#' || new.name, 'topic', new.topic));
    perform channel_note(new.id, new.workspace_id, 'topic', jsonb_build_object('topic', new.topic),
      case when new.topic is null then 'cleared the topic' else 'changed the topic to: ' || new.topic end);
  end if;
  if new.archived is distinct from old.archived then
    insert into audit_log (workspace_id, action, details)
      values (new.workspace_id, case when new.archived then 'channel.archive' else 'channel.unarchive' end, jsonb_build_object('name', '#' || new.name));
    perform channel_note(new.id, new.workspace_id, case when new.archived then 'archive' else 'unarchive' end, '{}'::jsonb,
      case when new.archived then 'archived this channel' else 'brought this channel back' end);
  end if;
  return null;
end $$;
revoke all on function public.channel_changed() from public, anon, authenticated;
drop trigger if exists channel_changed on public.channels;
create trigger channel_changed after update on public.channels for each row execute function public.channel_changed();

-- channel_rename and channel_archive: the same checks as before; the history and the chat line now come from channel_changed.
create or replace function public.channel_rename(ch uuid, new_name text, new_topic text) returns void
  language plpgsql security definer set search_path = public as $$
declare c record; n text; t text;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'Direct messages don''t have a name to change.'; end if;
  if not channel_can_manage(ch) then
    raise exception 'Only whoever made this channel, or the owner or an admin, can change its name or topic.'; end if;
  if c.archived then raise exception 'This channel is archived. Bring it back first, then change it.'; end if;
  n := c.name; t := c.topic;
  if new_name is not null then
    n := regexp_replace(regexp_replace(lower(trim(new_name)), '^#+', ''), '\s+', '-', 'g');
    if n !~ '^[a-z0-9_-]{1,40}$' then
      raise exception 'Use up to 40 lowercase letters, numbers, - or _ for the name (no spaces), e.g. hill-rd-site.'; end if;
  end if;
  if new_topic is not null then
    t := nullif(trim(new_topic), '');
    if length(t) > 200 then raise exception 'Keep the topic under 200 characters.'; end if;
  end if;
  if n is not distinct from c.name and t is not distinct from c.topic then return; end if;
  update channels set name = n, topic = t where id = ch;
end $$;

create or replace function public.channel_archive(ch uuid, archive boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'Direct messages can''t be archived.'; end if;
  if not channel_can_manage(ch) then
    raise exception 'Only whoever made this channel, or the owner or an admin, can archive it or bring it back.'; end if;
  if c.archived = coalesce(archive, false) then return; end if;
  update channels set archived = coalesce(archive, false) where id = ch;
end $$;

-- Mute: until turned back on (channel_mute), or until a time (channel_mute_until: within a year).
create or replace function public.channel_mute(ch uuid, mute_on boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  insert into channel_prefs (user_id, channel_id, muted, muted_until) values (auth.uid(), ch, coalesce(mute_on, false), null)
    on conflict (user_id, channel_id) do update set muted = excluded.muted, muted_until = null;
end $$;
create or replace function public.channel_mute_until(ch uuid, until_at timestamptz) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if until_at is not null and (until_at <= now() or until_at > now() + interval '366 days') then
    raise exception 'Choose a time in the next year to mute it until.'; end if;
  insert into channel_prefs (user_id, channel_id, muted, muted_until) values (auth.uid(), ch, true, until_at)
    on conflict (user_id, channel_id) do update set muted = true, muted_until = excluded.muted_until;
end $$;

-- Add or remove people in a private channel (its creator, or an owner/admin): in the history and in the chat.
create or replace function public.set_channel_people(ch uuid, add_people uuid[], remove_people uuid[])
  returns void language plpgsql security definer set search_path = public as $$
declare c record; added uuid[]; removed uuid[]; nm text;
begin
  select * into c from channels where id = ch;
  if c.id is null or c.kind <> 'private' then raise exception 'That isn''t a private channel'; end if;
  if not (is_admin(c.workspace_id) or (c.created_by = auth.uid() and can_see_channel(ch))) then
    raise exception 'Only whoever made this channel, or a team owner or admin, can change who''s in it';
  end if;
  if c.archived then raise exception 'This channel is archived. Bring it back first, then change it.'; end if;
  with i as (insert into channel_members (channel_id, user_id)
    select ch, m.user_id from members m where m.workspace_id = c.workspace_id and m.user_id = any(coalesce(add_people, '{}'))
    on conflict do nothing returning user_id) select coalesce(array_agg(user_id), '{}') into added from i;
  with d as (delete from channel_members where channel_id = ch and user_id = any(coalesce(remove_people, '{}')) returning user_id)
    select coalesce(array_agg(user_id), '{}') into removed from d;
  if not exists (select 1 from channel_members where channel_id = ch) then
    raise exception 'A private channel needs at least one person in it';
  end if;
  if cardinality(added) + cardinality(removed) = 0 then return; end if;
  insert into audit_log (workspace_id, action, details) values (c.workspace_id, 'channel.members', jsonb_build_object('name', c.name,
    'added', (select coalesce(jsonb_agg(display_name order by display_name), '[]') from members where workspace_id = c.workspace_id and user_id = any(added)),
    'removed', (select coalesce(jsonb_agg(display_name order by display_name), '[]') from members where workspace_id = c.workspace_id and user_id = any(removed))));
  if cardinality(added) > 0 then
    select string_agg(display_name, ', ' order by display_name) into nm from members where workspace_id = c.workspace_id and user_id = any(added);
    perform channel_note(ch, c.workspace_id, 'add', jsonb_build_object('people', to_jsonb(added)), 'added ' || nm);
  end if;
  if cardinality(removed) > 0 then
    select string_agg(display_name, ', ' order by display_name) into nm from members where workspace_id = c.workspace_id and user_id = any(removed);
    perform channel_note(ch, c.workspace_id, 'remove', jsonb_build_object('people', to_jsonb(removed)), 'removed ' || nm);
  end if;
end $$;

-- Leaving a private channel: the others see "… left".
create or replace function public.channel_leave(ch uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from channels where id = ch;
  if c.id is null or not can_see_channel(ch) then raise exception 'That channel isn''t there any more.'; end if;
  if c.kind = 'dm' then raise exception 'You can''t leave a direct message. Mute it instead.'; end if;
  if c.kind = 'channel' and c.name = 'general' then raise exception '#general is for everyone in the team, so you can''t leave it. Mute it instead.'; end if;
  if c.kind = 'private' then
    if not exists (select 1 from channel_members where channel_id = ch and user_id <> auth.uid()) then
      raise exception 'You''re the only person in this channel. Add someone first, or archive it.'; end if;
    if not c.archived then perform channel_note(ch, c.workspace_id, 'left', '{}'::jsonb, 'left'); end if;
    delete from channel_members where channel_id = ch and user_id = auth.uid();
  else
    insert into channel_prefs (user_id, channel_id, left_at) values (auth.uid(), ch, now())
      on conflict (user_id, channel_id) do update set left_at = now();
  end if;
end $$;

revoke all on function public.channel_mute_until(uuid, timestamptz), public.set_channel_people(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.channel_mute_until(uuid, timestamptz), public.set_channel_people(uuid, uuid[], uuid[]),
  public.channel_rename(uuid, text, text), public.channel_archive(uuid, boolean), public.channel_mute(uuid, boolean),
  public.channel_leave(uuid) to authenticated;

-- The lines Riyeser Link adds ("Ana renamed #jobs") don't count as unread messages.
create or replace function public.unread_counts(ws uuid) returns table (channel_id uuid, unread bigint)
  language sql stable security definer set search_path = public as $$
  select c.id, count(m.id)
  from channels c
  left join reads r on r.channel_id = c.id and r.user_id = auth.uid()
  left join messages m on m.channel_id = c.id and not m.deleted and m.user_id <> auth.uid() and m.system is null
       and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
  where c.workspace_id = ws and public.is_member(ws) and public.can_see_channel(c.id)
  group by c.id
$$;

-- ================================================================ Riyeser Link: ring groups with chosen members
-- Calling a branch's number (or a group's own number, e.g. Sales 300) rings only the people and shared desk phones
-- the owner or an admin chose for it, never everyone in the branch by itself. Each group has:
--   * its members, in order: people (their Riyeser Link apps and desk phones ring together) and shared desk phones
--     (an extension on Riyeser Link Office that isn't a person in Riyeser Link, such as Reception 150)
--   * how it rings: everyone chosen at once ('all'), one after another ('order', ring_seconds each), or one after
--     another starting with the next person each time ('rotate')
--   * if nobody answers within timeout_seconds: end as a missed call, try another group, or ring one person
--     (voicemail is coming with Riyeser Link Office voicemail)
-- People on Busy / Do not disturb, At lunch, Unavailable or On a call are skipped (not rung). Riyeser Link has no
-- business hours yet, so groups ring at any time.
-- Upgrading: every branch that was there before gets a group with the people who were in the branch (so nothing
-- changes on the day), marked needs_review so Management asks "Choose who answers each branch number" once.
-- Branches made afterwards start with nobody chosen: their number goes to missed calls until someone is chosen.
-- Riyeser Link Office reads the same groups (ring_groups_list) for the desk phones. Safe to run again.
create table if not exists public.ring_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  branch_id uuid unique references public.branches(id) on delete cascade,   -- a branch's own number; null for extra groups
  name text not null check (length(trim(name)) between 1 and 60),
  extension int check (extension between 10 and 9999),
  strategy text not null default 'all' check (strategy in ('all', 'order', 'rotate')),
  ring_seconds int not null default 15 check (ring_seconds between 5 and 120),
  timeout_seconds int not null default 30 check (timeout_seconds between 5 and 300),
  fallback text not null default 'missed' check (fallback in ('missed', 'group', 'person')),
  fallback_group uuid references public.ring_groups(id) on delete set null,
  fallback_user uuid references auth.users(id) on delete set null,
  needs_review boolean not null default false,
  next_pos int not null default 0,          -- 'rotate': who goes first next time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fallback_group is null or fallback_group <> id)
);
create unique index if not exists ring_groups_extension on public.ring_groups (workspace_id, extension) where extension is not null;
create index if not exists ring_groups_ws on public.ring_groups (workspace_id);
create table if not exists public.ring_group_members (
  id bigint generated always as identity primary key,
  group_id uuid not null references public.ring_groups(id) on delete cascade,
  position int not null default 0,
  user_id uuid references auth.users(id) on delete cascade,
  phone_ext text check (phone_ext ~ '^[0-9]{2,4}$'),
  phone_name text check (length(phone_name) <= 60),
  check ((user_id is null) <> (phone_ext is null))
);
create unique index if not exists ring_group_members_user on public.ring_group_members (group_id, user_id) where user_id is not null;
create unique index if not exists ring_group_members_phone on public.ring_group_members (group_id, phone_ext) where phone_ext is not null;
alter table public.ring_groups enable row level security;
alter table public.ring_group_members enable row level security;
drop policy if exists rg_read on public.ring_groups;
create policy rg_read on public.ring_groups for select to authenticated using (public.is_member(workspace_id));
drop policy if exists rgm_read on public.ring_group_members;
create policy rgm_read on public.ring_group_members for select to authenticated
  using (public.is_member((select workspace_id from public.ring_groups g where g.id = group_id)));
-- read only: every change goes through ring_group_save / ring_group_delete / ring_groups_confirm (owners and admins)
revoke all on public.ring_groups, public.ring_group_members from anon, authenticated;
grant select on public.ring_groups, public.ring_group_members to authenticated;

-- The upgrade (above): branches without a group get one with the people who are in the branch now.
create or replace function public.ring_groups_upgrade() returns int
  language plpgsql security definer set search_path = public as $$
declare k int;
begin
  with g as (
    insert into ring_groups (workspace_id, branch_id, name, extension, needs_review)
      select b.workspace_id, b.id, b.name, b.extension, true from branches b
      where not exists (select 1 from ring_groups x where x.branch_id = b.id)
        and (b.extension is null or not exists (select 1 from ring_groups x where x.workspace_id = b.workspace_id and x.extension = b.extension))
      returning id, branch_id, workspace_id)
  insert into ring_group_members (group_id, user_id, position)
    select g.id, bm.user_id, (row_number() over (partition by g.id order by m.extension nulls last, m.display_name) - 1)::int
    from g join branch_members bm on bm.branch_id = g.branch_id
           join members m on m.workspace_id = g.workspace_id and m.user_id = bm.user_id;
  get diagnostics k = row_count;
  return k;
end $$;
revoke all on function public.ring_groups_upgrade() from public, anon, authenticated;
select public.ring_groups_upgrade();

-- From now on a new branch gets its own group with nobody chosen; a branch's new name or number follows to its group.
create or replace function public.ring_group_for_branch() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into ring_groups (workspace_id, branch_id, name, extension) values (new.workspace_id, new.id, new.name, new.extension)
      on conflict (branch_id) do nothing;
  elsif new.name is distinct from old.name or new.extension is distinct from old.extension then
    update ring_groups set name = new.name, extension = new.extension, updated_at = now() where branch_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists ring_group_for_branch on public.branches;
create trigger ring_group_for_branch after insert or update on public.branches for each row execute function public.ring_group_for_branch();

-- Someone who leaves the business leaves its groups too.
create or replace function public.ring_group_member_left() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  delete from ring_group_members rm using ring_groups g where rm.group_id = g.id and g.workspace_id = old.workspace_id and rm.user_id = old.user_id;
  update ring_groups set fallback = 'missed', fallback_user = null where workspace_id = old.workspace_id and fallback_user = old.user_id;
  return null;
end $$;
drop trigger if exists ring_group_member_left on public.members;
create trigger ring_group_member_left after delete on public.members for each row execute function public.ring_group_member_left();

-- Is this number free in the business? (people, branches and groups share one set of numbers)
create or replace function public.number_free(ws uuid, n int, except_user uuid default null, except_group uuid default null) returns boolean
  language sql stable security definer set search_path = public as $$
  select not exists (select 1 from members where workspace_id = ws and extension = n and user_id is distinct from except_user)
     and not exists (select 1 from branches b where b.workspace_id = ws and b.extension = n
                     and not exists (select 1 from ring_groups g where g.id = except_group and g.branch_id = b.id))
     and not exists (select 1 from ring_groups where workspace_id = ws and extension = n and id is distinct from except_group)
$$;
revoke all on function public.number_free(uuid, int, uuid, uuid) from public, anon, authenticated;

-- Extensions and new branches keep clear of the groups' numbers too.
create or replace function public.next_extension(ws uuid, base int) returns int
  language sql stable security definer set search_path = public as $$
  select min(n) from generate_series(base + 1, base + 99) n where public.number_free(ws, n)
$$;
create or replace function public.give_extension(ws uuid, person uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare base int;
begin
  if not exists (select 1 from members where workspace_id = ws and user_id = person and extension is null) then return; end if;
  select coalesce(min(extension), 100) into base from branches where workspace_id = ws and extension is not null and extension % 100 = 0;
  update members set extension = coalesce(next_extension(ws, base),
      (select min(n) from generate_series(100, 9999) n where n % 100 <> 0 and public.number_free(ws, n)))
    where workspace_id = ws and user_id = person and extension is null;
end $$;
revoke all on function public.give_extension(uuid, uuid) from public, anon, authenticated;
create or replace function public.set_extension(ws uuid, person uuid, ext int) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can change extensions'; end if;
  if ext is not null and not number_free(ws, ext, person) then
    raise exception 'Extension % is already used', ext;
  end if;
  update members set extension = ext where workspace_id = ws and user_id = person;
end $$;
create or replace function public.create_branch(ws uuid, branch_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare b uuid; ext int;
begin
  if not is_admin(ws) then raise exception 'Only the team''s owner or an admin can add a branch'; end if;
  select coalesce(max(extension), 0) + 100 into ext from branches where workspace_id = ws and extension % 100 = 0;
  while ext <= 9900 and not number_free(ws, ext) loop ext := ext + 100; end loop;
  if ext > 9900 then ext := null; end if;
  insert into branches (workspace_id, name, code, extension) values (ws, trim(branch_name), make_branch_code(branch_name), ext)
    returning id into b;
  return b;
end $$;

-- Every group in a business, with its members in order (for Management, the Calls page and Riyeser Link Office).
create or replace function public.ring_group_json(g ring_groups) returns json
  language sql stable security definer set search_path = public as $$
  select json_build_object('id', g.id, 'branch_id', g.branch_id, 'name', g.name, 'extension', g.extension, 'strategy', g.strategy,
    'ring_seconds', g.ring_seconds, 'timeout_seconds', g.timeout_seconds, 'fallback', g.fallback,
    'fallback_group', g.fallback_group, 'fallback_user', g.fallback_user, 'needs_review', g.needs_review, 'updated_at', g.updated_at,
    'members', (select coalesce(json_agg(json_build_object('user_id', rm.user_id, 'phone_ext', rm.phone_ext,
                  'name', coalesce(m.display_name, rm.phone_name, 'Desk phone ' || rm.phone_ext),
                  'extension', coalesce(m.extension::text, rm.phone_ext)) order by rm.position, rm.id), '[]')
                from ring_group_members rm left join members m on m.workspace_id = g.workspace_id and m.user_id = rm.user_id
                where rm.group_id = g.id and (rm.user_id is null or m.user_id is not null)))
$$;
create or replace function public.ring_groups_list(ws uuid) returns json
  language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(public.ring_group_json(g) order by g.extension nulls last, g.name), '[]')
  from ring_groups g where g.workspace_id = ws and public.is_member(ws)
$$;

-- Owners and admins (two-step sign-in): make or change a group. grp null = a new group with its own number.
-- info: { name, extension, strategy, ring_seconds, timeout_seconds, fallback, fallback_group, fallback_user }
-- people: in ring order, [{ "user_id": … } | { "phone_ext": "150", "phone_name": "Reception" }]
create or replace function public.ring_group_save(ws uuid, grp uuid, info jsonb, people jsonb) returns uuid
  language plpgsql security definer set search_path = public as $$
declare g ring_groups; nm text; ext int; st text; rs int; ts int; fb text; fg uuid; fu uuid; x jsonb; pos int := 0; u uuid; pe text;
begin
  if not is_admin(ws) then raise exception 'Only the owner or an admin (with two-step sign-in) can change ring groups.'; end if;
  info := coalesce(info, '{}'::jsonb); people := coalesce(people, '[]'::jsonb);
  if jsonb_typeof(people) <> 'array' then raise exception 'Choose who answers as a list.'; end if;
  if jsonb_array_length(people) > 50 then raise exception 'A group can have up to 50 people and phones.'; end if;
  if grp is not null then
    select * into g from ring_groups where id = grp and workspace_id = ws;
    if g.id is null then raise exception 'That ring group isn''t there any more.'; end if;
  end if;
  st := coalesce(nullif(info ->> 'strategy', ''), g.strategy, 'all');
  if st not in ('all', 'order', 'rotate') then raise exception 'Choose Ring all at once, Ring in order or Rotate.'; end if;
  rs := coalesce((info ->> 'ring_seconds')::int, g.ring_seconds, 15);
  ts := coalesce((info ->> 'timeout_seconds')::int, g.timeout_seconds, 30);
  if rs not between 5 and 120 then raise exception 'Ring each person for 5 to 120 seconds.'; end if;
  if ts not between 5 and 300 then raise exception 'Choose 5 to 300 seconds before "If nobody answers".'; end if;
  fb := coalesce(nullif(info ->> 'fallback', ''), 'missed');
  if fb = 'voicemail' then raise exception 'Voicemail is coming with Riyeser Link Office voicemail. Choose another way for now.'; end if;
  if fb not in ('missed', 'group', 'person') then raise exception 'Choose what happens if nobody answers.'; end if;
  fg := case when fb = 'group' then nullif(info ->> 'fallback_group', '')::uuid end;
  fu := case when fb = 'person' then nullif(info ->> 'fallback_user', '')::uuid end;
  if fb = 'group' and (fg is null or fg = grp or not exists (select 1 from ring_groups where id = fg and workspace_id = ws)) then
    raise exception 'Choose another group to try.'; end if;
  if fb = 'person' and (fu is null or not exists (select 1 from members where workspace_id = ws and user_id = fu)) then
    raise exception 'Choose the person to ring.'; end if;
  if g.branch_id is null then   -- a group with its own number (a branch's group follows the branch)
    nm := trim(coalesce(info ->> 'name', g.name, ''));
    if length(nm) not between 1 and 60 or nm ~ '[<>]' then raise exception 'Give the group a name (up to 60 letters), e.g. Sales.'; end if;
    if coalesce(info ->> 'extension', '') !~ '^[0-9]{3}$' or (info ->> 'extension')::int not between 100 and 899 then
      raise exception 'Group numbers are 3 digits, 100 to 899, so desk phones can dial them too.'; end if;
    ext := (info ->> 'extension')::int;
    if not number_free(ws, ext, null, grp) then
      raise exception '% is already used by a person, a branch or another group. Choose another number.', ext; end if;
  end if;
  if grp is null then
    insert into ring_groups (workspace_id, name, extension, strategy, ring_seconds, timeout_seconds, fallback, fallback_group, fallback_user)
      values (ws, nm, ext, st, rs, ts, fb, fg, fu) returning * into g;
  else
    update ring_groups set name = case when branch_id is null then nm else name end, extension = case when branch_id is null then ext else extension end,
      strategy = st, ring_seconds = rs, timeout_seconds = ts, fallback = fb, fallback_group = fg, fallback_user = fu,
      needs_review = false, updated_at = now() where id = grp returning * into g;
  end if;
  delete from ring_group_members where group_id = g.id;
  for x in select * from jsonb_array_elements(people) loop
    u := nullif(x ->> 'user_id', '')::uuid; pe := nullif(trim(coalesce(x ->> 'phone_ext', '')), '');
    if u is not null then
      if not exists (select 1 from members where workspace_id = ws and user_id = u) then raise exception 'Choose people from your business.'; end if;
      insert into ring_group_members (group_id, user_id, position) values (g.id, u, pos) on conflict do nothing;
    elsif pe is not null then
      if pe !~ '^[0-9]{2,4}$' then raise exception 'A desk phone''s extension is 2 to 4 digits.'; end if;
      if exists (select 1 from members where workspace_id = ws and extension = pe::int) then
        raise exception 'Extension % belongs to a person: choose the person instead.', pe; end if;
      if exists (select 1 from ring_groups where workspace_id = ws and extension = pe::int) then
        raise exception '% is a group''s number, not a desk phone.', pe; end if;
      insert into ring_group_members (group_id, phone_ext, phone_name, position)
        values (g.id, pe, nullif(left(regexp_replace(trim(coalesce(x ->> 'phone_name', '')), '[<>]', '', 'g'), 60), ''), pos) on conflict do nothing;
    else raise exception 'Choose people or desk phones.'; end if;
    pos := pos + 1;
  end loop;
  insert into audit_log (workspace_id, action, details) values (ws, case when grp is null then 'ring_group.insert' else 'ring_group.update' end,
    jsonb_build_object('name', g.name, 'extension', g.extension, 'strategy', st, 'members', pos, 'fallback', fb));
  return g.id;
end $$;

-- Take away a group with its own number (a branch's group goes with the branch).
create or replace function public.ring_group_delete(ws uuid, grp uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare g ring_groups;
begin
  if not is_admin(ws) then raise exception 'Only the owner or an admin (with two-step sign-in) can change ring groups.'; end if;
  select * into g from ring_groups where id = grp and workspace_id = ws;
  if g.id is null then raise exception 'That ring group isn''t there any more.'; end if;
  if g.branch_id is not null then raise exception 'This is a branch''s number. It goes when the branch goes; choose who answers it instead.'; end if;
  update ring_groups set fallback = 'missed', fallback_group = null where workspace_id = ws and fallback_group = grp;
  delete from ring_groups where id = grp;
  insert into audit_log (workspace_id, action, details) values (ws, 'ring_group.delete', jsonb_build_object('name', g.name, 'extension', g.extension));
end $$;

-- "These are right": the upgrade's groups are confirmed as they are (the one-time notice goes away).
create or replace function public.ring_groups_confirm(ws uuid) returns int
  language plpgsql security definer set search_path = public as $$
declare k int;
begin
  if not is_admin(ws) then raise exception 'Only the owner or an admin (with two-step sign-in) can change ring groups.'; end if;
  update ring_groups set needs_review = false where workspace_id = ws and needs_review;
  get diagnostics k = row_count;
  if k > 0 then insert into audit_log (workspace_id, action, details) values (ws, 'ring_group.confirm', jsonb_build_object('groups', k)); end if;
  return k;
end $$;

-- Why a person isn't rung right now: their chosen status, or a call they're on (null = ring them).
create or replace function public.link_skip_reason(ws uuid, person uuid) returns text
  language sql stable security definer set search_path = public as $$
  select case
    when not public.link_rings(ws, person) then (select p.manual from presence p where p.workspace_id = ws and p.user_id = person)
    when exists (select 1 from presence p where p.workspace_id = ws and p.user_id = person and p.on_call and p.updated_at > now() - interval '3 minutes')
      or public.link_desk_call(ws, person) then 'on_call'
  end
$$;

-- Calling a group: who to ring, in what order, and what happens if nobody answers. Anyone in the business can ask
-- (it's what their app needs to place the call); 'rotate' moves on by one each time it's asked.
-- -> { id, name, extension, strategy, ring_seconds, timeout_seconds, fallback, fallback_group, fallback_user,
--      ring: [user_id, …] (in order, without the caller), skipped: [{ user_id, why }], phones: [{ extension, name }] }
create or replace function public.ring_group_plan(ws uuid, grp uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare g ring_groups; ids uuid[]; ring uuid[] := '{}'; skipped jsonb := '[]'; u uuid; why text; n int; start int := 0;
begin
  if not is_member(ws) then raise exception 'You''re not in that company.'; end if;
  if not calls_allowed(ws) then raise exception 'Riyeser Link is paused, so calls are paused too.'; end if;
  select * into g from ring_groups where id = grp and workspace_id = ws;
  if g.id is null then raise exception 'That ring group isn''t there any more.'; end if;
  select array_agg(rm.user_id order by rm.position, rm.id) into ids from ring_group_members rm
    join members m on m.workspace_id = ws and m.user_id = rm.user_id where rm.group_id = g.id and rm.user_id <> auth.uid();
  ids := coalesce(ids, '{}'); n := coalesce(array_length(ids, 1), 0);
  if g.strategy = 'rotate' and n > 0 then
    start := g.next_pos % n;
    ids := ids[start + 1 : n] || ids[1 : start];
    update ring_groups set next_pos = (start + 1) % n where id = g.id;
  end if;
  foreach u in array ids loop
    why := link_skip_reason(ws, u);
    if why is null then ring := ring || u; else skipped := skipped || jsonb_build_object('user_id', u, 'why', why); end if;
  end loop;
  return json_build_object('id', g.id, 'name', g.name, 'extension', g.extension, 'strategy', g.strategy, 'ring_seconds', g.ring_seconds,
    'timeout_seconds', g.timeout_seconds, 'fallback', g.fallback, 'fallback_group', g.fallback_group, 'fallback_user', g.fallback_user,
    'ring', to_json(ring), 'skipped', skipped,
    'phones', (select coalesce(json_agg(json_build_object('extension', rm.phone_ext, 'name', rm.phone_name) order by rm.position), '[]')
               from ring_group_members rm where rm.group_id = g.id and rm.phone_ext is not null));
end $$;

-- A group call only rings someone chosen for that group (or the person it falls back to).
create or replace function public.link_group_rings(ws uuid, grp text, person uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select case when grp is null then true
    when grp !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else exists (select 1 from ring_groups g where g.id = grp::uuid and g.workspace_id = ws
                 and (exists (select 1 from ring_group_members rm where rm.group_id = g.id and rm.user_id = person)
                      or (g.fallback = 'person' and g.fallback_user = person))) end
$$;

revoke all on function public.ring_group_json(ring_groups), public.ring_groups_list(uuid), public.ring_group_save(uuid, uuid, jsonb, jsonb),
  public.ring_group_delete(uuid, uuid), public.ring_groups_confirm(uuid), public.link_skip_reason(uuid, uuid),
  public.ring_group_plan(uuid, uuid), public.link_group_rings(uuid, text, uuid) from public, anon;
grant execute on function public.ring_groups_list(uuid), public.ring_group_save(uuid, uuid, jsonb, jsonb), public.ring_group_delete(uuid, uuid),
  public.ring_groups_confirm(uuid), public.ring_group_plan(uuid, uuid), public.link_group_rings(uuid, text, uuid),
  public.link_skip_reason(uuid, uuid) to authenticated;

drop policy if exists cs_send on public.call_signals;
create policy cs_send on public.call_signals for insert to authenticated
  with check (from_user = auth.uid() and to_user <> auth.uid() and public.is_member(workspace_id)
              and exists (select 1 from public.members m where m.workspace_id = call_signals.workspace_id and m.user_id = to_user)
              and public.calls_allowed(workspace_id)
              and (kind <> 'ring' or (public.link_rings(workspace_id, to_user)
                                      and public.link_group_rings(workspace_id, payload ->> 'group', to_user))));
-- ===== The Riyeser relay (Link Office 1.3.0): sites on different internet connections, phones at home, TURN =====
-- The relay (relay/ on the main branch; design in desktop/RELAY.md) joins a business's Link Offices, wherever they are,
-- and phones that aren't in any office. It runs on a machine Riyeser controls (the head office's own PC or mini PC,
-- and a rented server as a backup). This section holds:
--   relay_cluster      the one relay secret, shared by the relays and this database (never readable by apps)
--   relay_servers      the relays: where they are, which one is first, their current public IP and certificate
--   link_relay_settings  per business: the relay switched on or off, and its own order of relays (optional)
--   link_relay_devices remote phones (at home, at a site with no Link Office): username and HA1 only, never a password
-- and the functions that give out short-lived passes: Link Office passes (signed for each relay, 6 hours), TURN
-- passwords for browser and app calls (12 hours) and one-time phone set-up links (15 minutes).
-- PRIVACY: the relay reports counts and which offices are connected, never calls, numbers dialled or audio.
-- Safe to re-run.
create table if not exists public.relay_cluster (
  id int primary key default 1 check (id = 1),
  secret text not null check (length(secret) >= 32),
  created_at timestamptz not null default now()
);
create table if not exists public.relay_servers (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  host text not null check (host ~ '^[A-Za-z0-9.-]{3,253}$'),
  port int not null default 443 check (port between 1 and 65535),           -- where Link Office connects (wss)
  region text not null default '' check (length(region) <= 60),
  priority int not null default 1 check (priority between 1 and 99),        -- 1 is the main relay, then the backups
  workspace_id uuid references public.workspaces(id) on delete cascade,     -- null: for every business; else only this one's
  public_ip text check (public_ip ~ '^\d{1,3}(\.\d{1,3}){3}$'),
  ip_how text check (length(ip_how) <= 40),
  cert_sha256 text check (cert_sha256 ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$'),
  self_signed boolean not null default false,                               -- then apps check exactly cert_sha256
  ports jsonb not null default '{}', version text check (length(version) <= 40), counts jsonb,
  last_seen timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.link_relay_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default false,
  relays text[] not null default '{}',                                       -- the business's own order (empty: Riyeser's)
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.link_relay_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  extension text not null check (extension ~ '^[1-8][0-9]{2}$'),
  label text not null default '' check (length(label) <= 40),
  username text not null unique check (username ~ '^r[a-z0-9]{10}$'),
  ha1 text not null check (ha1 ~ '^[0-9a-f]{32}$'),                          -- MD5(username:riyeser-relay:password), what SIP needs
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  removed_at timestamptz
);
create index if not exists link_relay_devices_ws on public.link_relay_devices (workspace_id) where removed_at is null;
alter table public.link_offices add column if not exists relay_gen int not null default 1;          -- bumped on revoke / allow
alter table public.link_offices add column if not exists relay_revoked_at timestamptz;
alter table public.link_offices add column if not exists relay jsonb;            -- from Link Office: { state, relay, region, rtt_ms, backup, udp, error, at }
alter table public.link_offices add column if not exists relay_seen jsonb;       -- from the relay itself: { relay, since, at }
-- 1.3.1: changing or removing the relay PC. Each relay has its own key (sync_key: it signs relay_sync and relay_leave
-- with it, and gets the keys it needs back from relay_sync), so no secret is ever copied from one PC to another and a
-- lost PC is cut off by removing it (relay_drop: its key goes, and the cluster secret is changed, so the keys it held
-- stop working on the other relays within one sync, 30 seconds). managed_by: the business whose owners and admins may
-- remove it or move it to another PC (null: only Riyeser, in the SQL editor). dns: false for a relay with no web name
-- (the default for a PC in an office): sites connect to the address it reports, checked by its certificate.
alter table public.relay_servers add column if not exists sync_key text check (sync_key is null or length(sync_key) >= 32);
alter table public.relay_servers add column if not exists managed_by uuid references public.workspaces(id) on delete set null;
alter table public.relay_servers add column if not exists dns boolean not null default true;
alter table public.relay_servers add column if not exists replaces text;      -- takes over from this relay when it first checks in
alter table public.relay_cluster add column if not exists epoch int not null default 1;   -- bumped each time the secret is changed
-- the business's own order of relays (relays: order only, since 1.3.1) and the relays it has switched off (off)
alter table public.link_relay_settings add column if not exists off text[] not null default '{}';
alter table public.link_relay_settings add column if not exists order_only boolean not null default false;
alter table public.link_relay_settings alter column order_only set default true;
-- before 1.3.1 a non-empty relays list also meant "only these": keep that as the relays switched off (once)
update public.link_relay_settings s set off = coalesce((select array_agg(r.id order by r.id) from public.relay_servers r
    where (r.workspace_id is null or r.workspace_id = s.workspace_id) and not r.id = any (s.relays)), '{}'), order_only = true
  where not s.order_only and cardinality(s.relays) > 0;
update public.link_relay_settings set order_only = true where not order_only;
-- one-time set-up codes for a new relay PC (made on the website by an owner or admin, typed into Link Office on the PC)
create table if not exists public.relay_enrollments (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  relay_id text not null check (relay_id ~ '^[a-z0-9-]{2,40}$'),
  host text not null check (host ~ '^[A-Za-z0-9.-]{3,253}$'),
  region text not null default '' check (length(region) <= 60),
  priority int not null default 1 check (priority between 1 and 99),
  dns boolean not null default false,
  replaces text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz
);
alter table public.relay_enrollments enable row level security;
revoke all on public.relay_enrollments from anon, authenticated;

alter table public.relay_cluster enable row level security;
alter table public.relay_servers enable row level security;
alter table public.link_relay_settings enable row level security;
alter table public.link_relay_devices enable row level security;
-- no policies and no grants: only the functions below (security definer) read or change these
revoke all on public.relay_cluster, public.relay_servers, public.link_relay_settings, public.link_relay_devices from anon, authenticated;

-- ---------------------------------------------------------------- helpers (not callable from outside)
create or replace function public.relay_b64u(b bytea) returns text language sql immutable as $$
  select rtrim(translate(replace(encode(b, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;
-- A pass: base64url(JSON) "." base64url(HMAC-SHA256(key, that)). The relay checks it the same way (relay/lib/tokens.js).
create or replace function public.relay_sign(k bytea, payload jsonb) returns text
  language sql immutable set search_path = public, extensions as $$
  select b || '.' || relay_b64u(hmac(convert_to(b, 'utf8'), k, 'sha256'))
  from (select relay_b64u(convert_to(payload::text, 'utf8')) as b) x
$$;
-- The keys made from the relay secret (the same derivation as relay/lib/tokens.js keys()).
create or replace function public.relay_key(purpose text) returns bytea
  language sql stable security definer set search_path = public, extensions as $$
  select hmac(convert_to(purpose, 'utf8'), convert_to(secret, 'utf8'), 'sha256') from relay_cluster where id = 1
$$;
create or replace function public.relay_turn_secret() returns text
  language sql stable security definer set search_path = public, extensions as $$ select encode(relay_key('turn'), 'hex') $$;
-- The relays a business uses, in order: its own order if it set one, else main relay first. Only relays for every
-- business, or its own. online: checked in during the last 2 minutes.
-- addr: where to connect (its web name, or for a relay with no web name the address it last reported).
create or replace function public.relay_addr(r public.relay_servers) returns text
  language sql stable as $$ select case when r.dns then r.host else coalesce(r.public_ip, r.host) end $$;
create or replace function public.relay_list(ws uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'host', r.host, 'port', r.port, 'region', r.region, 'priority', r.priority,
      'url', 'wss://' || relay_addr(r) || case when r.port = 443 then '' else ':' || r.port end || '/link/v1', 'ip', r.public_ip, 'addr', relay_addr(r), 'dns', r.dns,
      'pin', case when r.self_signed then r.cert_sha256 end, 'cert_sha256', r.cert_sha256,
      'online', coalesce(r.last_seen > now() - interval '2 minutes', false), 'last_seen', r.last_seen,
      'sip_tls_port', coalesce((r.ports ->> 'sip_tls')::int, 5061), 'turn_port', (r.ports ->> 'turn')::int, 'turns_port', (r.ports ->> 'turns')::int,
      'own', r.workspace_id is not null, 'managed', r.managed_by is not distinct from ws)
    order by coalesce(array_position(s.relays, r.id), 1000), r.priority, r.id), '[]'::jsonb)
  from relay_servers r left join link_relay_settings s on s.workspace_id = ws
  where (r.workspace_id is null or r.workspace_id = ws) and not (r.id = any (coalesce(s.off, '{}')))
$$;
-- Owners and admins: every relay the business could use, also the ones it switched off, for Sites & relay.
create or replace function public.relay_admin_list(ws uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'host', r.host, 'addr', relay_addr(r), 'dns', r.dns, 'region', r.region, 'priority', r.priority,
      'online', coalesce(r.last_seen > now() - interval '2 minutes', false), 'last_seen', r.last_seen, 'version', r.version,
      'off', r.id = any (coalesce(s.off, '{}')), 'managed', r.managed_by is not distinct from ws and r.managed_by is not null,
      'shared', r.workspace_id is null, 'pending', r.last_seen is null, 'replaces', r.replaces)
    order by r.id = any (coalesce(s.off, '{}')), coalesce(array_position(s.relays, r.id), 1000), r.priority, r.id), '[]'::jsonb)
  from relay_servers r left join link_relay_settings s on s.workspace_id = ws
  where r.workspace_id is null or r.workspace_id = ws
$$;
create or replace function public.relay_enabled(ws uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from link_relay_settings where workspace_id = ws), false)
    and exists (select 1 from workspaces w where w.id = ws and w.status = 'active')
$$;
revoke all on function public.relay_b64u(bytea), public.relay_sign(bytea, jsonb), public.relay_key(text), public.relay_turn_secret(),
  public.relay_list(uuid), public.relay_admin_list(uuid), public.relay_enabled(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- set up by Riyeser, in the Supabase SQL editor only
-- After setup.sh on the relay machine:  select relay_register('syd1', 'relay.riyeser.com', 'Sydney', '<the secret it printed>');
-- A backup relay (setup.sh --backup copies the secret from the main relay):  select relay_register('mel1', 'relay2.riyeser.com', 'Melbourne', '<same secret>', 2);
-- A relay only for one business (its own machine):  ..., 1, '<workspace id>'.  Port: where Link Office connects (443 by default).
create or replace function public.relay_register(p_id text, p_host text, p_region text, p_secret text, p_priority int default 1,
    p_workspace uuid default null, p_port int default 443) returns text
  language plpgsql security definer set search_path = public as $$
declare have text;
begin
  select secret into have from relay_cluster where id = 1;
  if have is null then insert into relay_cluster (id, secret) values (1, p_secret);
  elsif have <> p_secret then
    raise exception 'This relay''s secret is different from the other relays''. Install it with setup.sh --backup (it copies the secret from the main relay), or remove the old relays first (relay_remove).';
  end if;
  insert into relay_servers (id, host, region, priority, workspace_id, port) values (p_id, lower(p_host), coalesce(p_region, ''), coalesce(p_priority, 1), p_workspace, coalesce(p_port, 443))
  on conflict (id) do update set host = excluded.host, region = excluded.region, priority = excluded.priority, workspace_id = excluded.workspace_id, port = excluded.port;
  return format('Relay %s (%s, %s) registered. It shows as online within a minute of starting.', p_id, p_host, coalesce(p_region, ''));
end $$;
create or replace function public.relay_remove(p_id text) returns void
  language sql security definer set search_path = public as $$ delete from relay_servers where id = p_id $$;
revoke all on function public.relay_register(text, text, text, text, int, uuid, int), public.relay_remove(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- the relay calls this every 30 seconds
-- sig = hex(HMAC-SHA256(secret, '<relay>|<ts>')), within 5 minutes. info: { version, public_ip, ip_how, ports, counts,
-- cert: { sha256, self_signed }, offices: [{ ws, office, since }], phones: [username] }. Returns the plan.
-- ---------------------------------------------------------------- 1.3.1: one key per relay, removing and moving relays
-- Is this a relay of ours, signing with its own key (or, for a relay from before 1.3.1, the cluster secret)?
create or replace function public.relay_check_sig(p_relay text, ts bigint, sig text) returns public.relay_servers
  language plpgsql stable security definer set search_path = public, extensions as $$
declare r relay_servers; k text;
begin
  select * into r from relay_servers where id = p_relay;
  if r.id is null then raise exception 'This relay has been removed from Riyeser (RELAY_REMOVED). Its key no longer works.'; end if;
  k := coalesce(r.sync_key, (select secret from relay_cluster where id = 1));
  if k is null or abs(extract(epoch from now()) - ts) > 300
     or coalesce(sig, '') <> encode(hmac(convert_to(p_relay || '|' || ts, 'utf8'), convert_to(k, 'utf8'), 'sha256'), 'hex') then
    raise exception 'Not a relay of Riyeser''s (check RELAY_ID and the secret, and that the clock is right).';
  end if;
  return r;
end $$;
create or replace function public.relay_version_ok(v text, want int[] default array[1, 1, 0]) returns boolean
  language sql immutable as $$
  select coalesce(nullif(regexp_replace(coalesce(v, ''), '[^0-9.].*$', ''), '') is not null
    and (select array_agg(coalesce(nullif(x, ''), '0')::int) from unnest(string_to_array(regexp_replace(v, '[^0-9.].*$', ''), '.')) x) >= want, false)
$$;
-- Change the cluster secret, so keys copied from a removed relay stop working. The relays that stay keep checking in
-- (one from before 1.3.1 signs with the old secret: that becomes its own key) and get the new keys from relay_sync.
-- Not done while a relay that has checked in is older than 1.1.0 (it couldn't take the new keys): -> false then.
create or replace function public.relay_rotate() returns boolean
  language plpgsql security definer set search_path = public, extensions as $$
declare old text;
begin
  select secret into old from relay_cluster where id = 1 for update;
  if old is null then return false; end if;
  if exists (select 1 from relay_servers where last_seen is not null and not relay_version_ok(version)) then return false; end if;
  update relay_servers set sync_key = old where sync_key is null;
  update relay_cluster set secret = encode(gen_random_bytes(32), 'hex'), epoch = epoch + 1 where id = 1;
  return true;
end $$;
-- Remove a relay: its row (so its key stops working at once), its place in each business's order, and the cluster
-- secret is changed. A business left with no relay has it switched off (and that is in its history).
-- -> { removed, rotated, switched_off: [workspace ids] }
create or replace function public.relay_drop(p_id text, why text, by_relay text default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare r relay_servers; offs uuid[]; rotated boolean := false;
begin
  select * into r from relay_servers where id = p_id for update;
  if r.id is null then return jsonb_build_object('removed', false); end if;
  delete from relay_servers where id = p_id;
  -- a relay PC taking over keeps the old one's place in every business's order
  update link_relay_settings set relays = case when by_relay is not null then array_replace(relays, p_id, by_relay) else array_remove(relays, p_id) end,
    off = array_remove(off, p_id) where p_id = any (relays) or p_id = any (off);
  delete from relay_enrollments where replaces = p_id and used_at is null;
  rotated := relay_rotate();
  select coalesce(array_agg(s.workspace_id), '{}') into offs from link_relay_settings s where s.enabled and jsonb_array_length(relay_list(s.workspace_id)) = 0;
  update link_relay_settings set enabled = false, updated_at = now() where workspace_id = any (offs);
  insert into audit_log (workspace_id, action, details) select x, 'link.relay_off', jsonb_build_object('reason', 'the last relay was removed', 'relay', p_id) from unnest(offs) x;
  return jsonb_build_object('removed', true, 'why', why, 'rotated', rotated, 'switched_off', to_jsonb(offs));
end $$;
revoke all on function public.relay_check_sig(text, bigint, text), public.relay_rotate(), public.relay_drop(text, text, text) from public, anon, authenticated;

-- The relay PC itself, when it is uninstalled (install-relay.ps1 -Uninstall; Link Office: Stop using this PC as the
-- relay): signed with its own key. Removes it, as relay_drop.
create or replace function public.relay_leave(relay text, ts bigint, sig text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare r relay_servers; out jsonb;
begin
  r := relay_check_sig(relay_leave.relay, ts, sig);
  out := relay_drop(r.id, 'left');
  if r.managed_by is not null then insert into audit_log (workspace_id, action, details) values (r.managed_by, 'link.relay_removed', jsonb_build_object('relay', r.id, 'by', 'the relay PC (uninstalled)')); end if;
  return out;
end $$;
revoke all on function public.relay_leave(text, bigint, text) from public;
grant execute on function public.relay_leave(text, bigint, text) to anon, authenticated;

create or replace function public.relay_sync(relay text, ts bigint, sig text, info jsonb) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare r relay_servers; seen text; ip text; plan jsonb; moved jsonb;
begin
  r := relay_check_sig(relay_sync.relay, ts, sig);
  -- a new relay PC that takes over from an old one: the old one is removed once the new one has checked in
  if r.replaces is not null then
    moved := relay_drop(r.replaces, 'moved', r.id);
    update relay_servers set replaces = null where id = r.id;
    if r.managed_by is not null then insert into audit_log (workspace_id, action, details) values (r.managed_by, 'link.relay_moved', jsonb_build_object('from', r.replaces, 'to', r.id)); end if;
  end if;
  -- the address this call came from, as our own "what is my IP" (no outside service needed)
  begin seen := trim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1)); exception when others then seen := null; end;
  if seen !~ '^\d{1,3}(\.\d{1,3}){3}$' then seen := null; end if;
  ip := case when coalesce(info ->> 'public_ip', '') ~ '^\d{1,3}(\.\d{1,3}){3}$' then info ->> 'public_ip' else seen end;
  update relay_servers set last_seen = now(), public_ip = coalesce(ip, public_ip), ip_how = left(coalesce(info ->> 'ip_how', ip_how), 40),
      version = left(info ->> 'version', 40), ports = coalesce(case when jsonb_typeof(info -> 'ports') = 'object' and length((info -> 'ports')::text) < 1000 then info -> 'ports' end, ports),
      counts = case when jsonb_typeof(info -> 'counts') = 'object' and length((info -> 'counts')::text) < 2000 then info -> 'counts' end,
      cert_sha256 = case when coalesce(info #>> '{cert,sha256}', '') ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$' then info #>> '{cert,sha256}' else cert_sha256 end,
      self_signed = coalesce((info #>> '{cert,self_signed}')::boolean, self_signed)
    where id = relay_sync.relay;
  -- which offices are connected to this relay now (for the Phones page): only businesses this relay may serve
  update link_offices o set relay_seen = jsonb_build_object('relay', relay_sync.relay, 'since', x ->> 'since', 'at', now())
    from jsonb_array_elements(case when jsonb_typeof(info -> 'offices') = 'array' then info -> 'offices' else '[]' end) x
    where o.workspace_id::text = x ->> 'ws' and o.office_id = x ->> 'office' and (r.workspace_id is null or r.workspace_id = o.workspace_id);
  update link_relay_devices d set last_seen = now()
    from jsonb_array_elements_text(case when jsonb_typeof(info -> 'phones') = 'array' then info -> 'phones' else '[]' end) u
    where d.username = u and d.removed_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('ws', w.id, 'enabled', true,
      'offices', (select coalesce(jsonb_agg(jsonb_build_object('office_id', o.office_id, 'gen', o.relay_gen, 'revoked', o.relay_revoked_at is not null, 'name', coalesce(o.pc_name, ''))), '[]')
                  from link_offices o where o.workspace_id = w.id),
      'devices', (select coalesce(jsonb_agg(jsonb_build_object('user', d.username, 'ext', d.extension, 'ha1', d.ha1, 'label', d.label)), '[]')
                  from link_relay_devices d where d.workspace_id = w.id and d.removed_at is null),
      -- ring groups with their chosen members only (people's extensions and shared desk phones), as ring_group_plan
      'groups', (select coalesce(jsonb_agg(jsonb_build_object('ext', g.extension::text, 'members',
                    (select coalesce(jsonb_agg(coalesce(m.extension::text, rm.phone_ext) order by rm.position, rm.id), '[]') from ring_group_members rm
                     left join members m on m.user_id = rm.user_id and m.workspace_id = w.id
                     where rm.group_id = g.id and coalesce(m.extension::text, rm.phone_ext) is not null))), '[]')
                 from ring_groups g where g.workspace_id = w.id and g.extension is not null))), '[]')
    into plan
    from workspaces w join link_relay_settings s on s.workspace_id = w.id and s.enabled
    where w.status = 'active' and (r.workspace_id is null or r.workspace_id = w.id)
      and not relay_sync.relay = any (s.off);
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'now', now(), 'your_ip', seen, 'businesses', plan,
    'relays', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'host', x.host, 'region', x.region, 'priority', x.priority, 'ip', x.public_ip,
        'url', 'wss://' || relay_addr(x) || case when x.port = 443 then '' else ':' || x.port end || '/relay/v1', 'pin', case when x.self_signed then x.cert_sha256 end)), '[]')
      from relay_servers x where x.id <> relay_sync.relay),
    -- a relay with its own key gets the cluster's keys from here (never the secret itself); they change when a relay is removed
    'keys', case when r.sync_key is not null then jsonb_build_object('epoch', (select epoch from relay_cluster where id = 1),
        'office', encode(relay_key('office-token'), 'hex'), 'device', encode(relay_key('device-prov'), 'hex'), 'peer', encode(relay_key('peer'), 'hex'), 'turn', relay_turn_secret()) end));
end $$;
revoke all on function public.relay_sync(text, bigint, text, jsonb) from public;
grant execute on function public.relay_sync(text, bigint, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- Link Office and Riyeser Link call these
-- Everyone in the business: is the relay on, and which relays (in order) with their addresses and certificates.
create or replace function public.link_relay_config(ws uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(ws) then raise exception 'You''re not in this business.'; end if;
  return jsonb_build_object('enabled', relay_enabled(ws), 'relays', relay_list(ws),
    'available', exists (select 1 from jsonb_array_elements(relay_list(ws)) x where (x ->> 'online')::boolean));
end $$;
-- Owners and admins (two-step sign-in): switch the relay on or off for the business, and optionally its own order.
create or replace function public.link_relay_set(ws uuid, enabled boolean, relays text[] default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare want text[] := link_relay_set.relays; turn_on boolean := link_relay_set.enabled;
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can switch the relay on or off.'; end if;
  if want is not null and exists (select 1 from unnest(want) x where not exists (select 1 from relay_servers r where r.id = x and (r.workspace_id is null or r.workspace_id = ws))) then
    raise exception 'Choose relays from the list.';
  end if;
  -- relays given: these, in this order; the business's other relays are switched off for it
  insert into link_relay_settings as s (workspace_id, enabled, relays, off, updated_by, updated_at) values (ws, turn_on, coalesce(want, '{}'),
      case when want is null then '{}' else coalesce((select array_agg(r.id) from relay_servers r where (r.workspace_id is null or r.workspace_id = ws) and not r.id = any (want)), '{}') end, auth.uid(), now())
  on conflict (workspace_id) do update set enabled = turn_on, relays = coalesce(want, s.relays), off = case when want is null then s.off else excluded.off end, updated_by = auth.uid(), updated_at = now();
  insert into audit_log (workspace_id, action, details) values (ws, case when turn_on then 'link.relay_on' else 'link.relay_off' end,
    jsonb_strip_nulls(jsonb_build_object('relays', want)));
  return link_relay_config(ws);
end $$;
-- Link Office (signed in as someone who may report for it): a pass for each relay, valid 6 hours.
create or replace function public.link_relay_token(ws uuid, office_id text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare o link_offices; exp bigint := floor(extract(epoch from now()))::bigint + 6 * 3600; k bytea;
begin
  if not public.link_office_acts_for(ws, link_relay_token.office_id) then raise exception 'Sign in as the business''s owner or an admin, or link this PC to the business, to connect to the relay.'; end if;
  select * into o from link_offices x where x.workspace_id = ws and x.office_id = link_relay_token.office_id;
  if o.office_id is null then raise exception 'This Riyeser Link Office hasn''t been in touch with Riyeser Link yet. It will be within a few minutes.'; end if;
  if not relay_enabled(ws) then raise exception 'The Riyeser relay is switched off for this business. Switch it on in Riyeser Link: Phones → Sites and the relay.'; end if;
  if o.relay_revoked_at is not null then raise exception 'This office has been disconnected from the relay. An owner or admin can allow it again in Riyeser Link: Phones → Sites and the relay.'; end if;
  k := relay_key('office-token');
  if k is null then raise exception 'The Riyeser relay isn''t set up yet.'; end if;
  return jsonb_build_object('office', o.office_id, 'gen', o.relay_gen, 'exp', exp, 'relays', relay_list(ws),
    'tokens', (select coalesce(jsonb_object_agg(x ->> 'id', relay_sign(k, jsonb_build_object('v', 1, 'r', x ->> 'id', 'ws', ws, 'o', o.office_id, 'g', o.relay_gen, 'exp', exp))), '{}')
               from jsonb_array_elements(relay_list(ws)) x));
end $$;
-- Link Office tells Riyeser Link how its relay connection is (for the Phones page): every heartbeat and on change.
create or replace function public.link_relay_report(ws uuid, office_id text, state jsonb) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.link_office_acts_for(ws, link_relay_report.office_id) then raise exception 'Not allowed.'; end if;
  update link_offices o set relay = jsonb_strip_nulls(jsonb_build_object(
      'state', link_text(link_relay_report.state -> 'state', 20), 'relay', link_text(link_relay_report.state -> 'relay', 40), 'region', link_text(link_relay_report.state -> 'region', 60),
      'rtt_ms', link_int(link_relay_report.state -> 'rtt_ms'), 'backup', link_bool(link_relay_report.state -> 'backup'), 'udp', link_text(link_relay_report.state -> 'udp', 20),
      'error', link_text(link_relay_report.state -> 'error', 200), 'sites', link_int(link_relay_report.state -> 'sites'), 'since', link_time(link_relay_report.state -> 'since'),
      -- 1.3.1: the guided checklist (each step: key, ok / warn / fail / todo, a short note), the last test call, and
      -- whether this PC is the relay. Only these shapes are kept.
      'checks', (select jsonb_agg(jsonb_build_object('k', left(c ->> 'k', 20), 's', c ->> 's', 't', left(coalesce(c ->> 't', ''), 160)))
                 from (select c from jsonb_array_elements(case when jsonb_typeof(link_relay_report.state -> 'checks') = 'array' then link_relay_report.state -> 'checks' else '[]' end) c limit 20) q
                 where jsonb_typeof(c) = 'object' and coalesce(c ->> 'k', '') ~ '^[a-z][a-z0-9-]{0,19}$' and c ->> 's' in ('ok', 'warn', 'fail', 'todo')),
      'test', case when jsonb_typeof(link_relay_report.state -> 'test') = 'object' then jsonb_strip_nulls(jsonb_build_object('rtt_ms', link_int(link_relay_report.state #> '{test,rtt_ms}'),
                 'loss', link_int(link_relay_report.state #> '{test,loss}'), 'ok', link_bool(link_relay_report.state #> '{test,ok}'), 'at', link_time(link_relay_report.state #> '{test,at}'))) end,
      'host', link_bool(link_relay_report.state -> 'host'), 'at', now()))
    where o.workspace_id = ws and o.office_id = link_relay_report.office_id;
end $$;
-- Owners and admins: disconnect an office from the relay (its passes stop working within 30 seconds), or allow it again.
create or replace function public.link_relay_revoke(ws uuid, office_id text, allow boolean default false) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can do that.'; end if;
  update link_offices o set relay_gen = o.relay_gen + 1, relay_revoked_at = case when allow then null else now() end
    where o.workspace_id = ws and o.office_id = link_relay_revoke.office_id;
  if not found then raise exception 'That Riyeser Link Office isn''t one of this business''s.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, case when allow then 'link.relay_office_allowed' else 'link.relay_office_revoked' end, jsonb_build_object('office_id', office_id));
end $$;
-- Everyone in the business: TURN details for browser and app calls (12 hours), from the business's relays only.
create or replace function public.link_relay_turn(ws uuid) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare sec text := relay_turn_secret(); exp bigint := floor(extract(epoch from now()))::bigint + 12 * 3600; u text; pw text; servers jsonb;
begin
  if not public.is_member(ws) then raise exception 'You''re not in this business.'; end if;
  if sec is null then return jsonb_build_object('ice_servers', '[]'::jsonb, 'ttl', 0); end if;
  u := exp || ':' || replace(auth.uid()::text, '-', '');
  pw := encode(hmac(convert_to(u, 'utf8'), convert_to(sec, 'utf8'), 'sha1'), 'base64');
  select coalesce(jsonb_agg(s), '[]') into servers from (
    select jsonb_build_object('urls', to_jsonb(array_remove(array[
        'stun:' || coalesce(x ->> 'addr', x ->> 'host') || ':' || coalesce(x ->> 'turn_port', '3478'),
        'turn:' || coalesce(x ->> 'addr', x ->> 'host') || ':' || coalesce(x ->> 'turn_port', '3478') || '?transport=udp',
        'turn:' || coalesce(x ->> 'addr', x ->> 'host') || ':' || coalesce(x ->> 'turn_port', '3478') || '?transport=tcp',
        case when x ->> 'ip' is not null and x ->> 'ip' is distinct from x ->> 'addr' then 'turn:' || (x ->> 'ip') || ':' || coalesce(x ->> 'turn_port', '3478') || '?transport=udp' end,
        case when x ->> 'turns_port' is not null and x ->> 'pin' is null and coalesce((x ->> 'dns')::boolean, true) then 'turns:' || coalesce(x ->> 'addr', x ->> 'host') || ':' || (x ->> 'turns_port') || '?transport=tcp' end], null)),
      'username', u, 'credential', pw) s
    from jsonb_array_elements(relay_list(ws)) x where (x ->> 'turn_port') is not null) q;
  return jsonb_build_object('ice_servers', servers, 'ttl', 12 * 3600, 'expires_at', to_timestamp(exp));
end $$;

-- ---------------------------------------------------------------- phones at home (or at a site with no Link Office)
-- Owners and admins for anyone; everyone for their own extension. The password is made here, shown once, and only
-- its HA1 is kept. Returns the details to type in, and a one-time set-up link (15 minutes) for Linphone's QR code.
create or replace function public.link_relay_device_add(ws uuid, extension text, label text default '') returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare u text; pw text; did uuid; first jsonb := relay_list(ws) -> 0; code text;
begin
  if not (public.is_admin(ws) or (public.is_member(ws) and exists (select 1 from members m where m.workspace_id = ws and m.user_id = auth.uid() and m.extension::text = link_relay_device_add.extension))) then
    raise exception 'Only an owner or admin (with two-step sign-in) can set up a phone for someone else. You can set up your own.';
  end if;
  if coalesce(extension, '') !~ '^[1-8][0-9]{2}$' or not exists (select 1 from members m where m.workspace_id = ws and m.extension::text = link_relay_device_add.extension) then
    raise exception 'Choose the extension of someone in the business.';
  end if;
  if coalesce(label, '') ~ '[[:cntrl:]<>]' or length(coalesce(label, '')) > 40 then raise exception 'Give the phone a short name (up to 40 letters), like Kitchen or Mobile.'; end if;
  if not relay_enabled(ws) then raise exception 'Switch the Riyeser relay on first (Phones → Sites and the relay).'; end if;
  if first is null then raise exception 'The Riyeser relay isn''t set up yet.'; end if;
  if (select count(*) from link_relay_devices d where d.workspace_id = ws and d.removed_at is null) >= 20 then raise exception 'A business can have up to 20 phones on the relay. Remove one first.'; end if;
  u := 'r' || substr(translate(encode(gen_random_bytes(12), 'hex'), 'abcdef', 'abcdef'), 1, 10);
  pw := substr(translate(encode(gen_random_bytes(24), 'base64'), '+/=lIO0', 'xyzkLQ8'), 1, 20);
  insert into link_relay_devices (workspace_id, extension, label, username, ha1, created_by)
    values (ws, extension, coalesce(nullif(trim(label), ''), 'Phone at home'), u, md5(u || ':riyeser-relay:' || pw), auth.uid()) returning id into did;
  code := relay_sign(relay_key('device-prov'), jsonb_build_object('v', 1, 'u', u, 'n', encode(gen_random_bytes(8), 'hex'), 'exp', floor(extract(epoch from now() + interval '15 minutes'))::bigint));
  insert into audit_log (workspace_id, action, details) values (ws, 'link.relay_phone_added', jsonb_build_object('extension', extension, 'label', coalesce(nullif(trim(label), ''), 'Phone at home')));
  return jsonb_build_object('id', did, 'extension', extension, 'username', u, 'password', pw, 'domain', coalesce(first ->> 'addr', first ->> 'host'), 'server', coalesce(first ->> 'addr', first ->> 'host'),
    'port', coalesce((first ->> 'sip_tls_port')::int, 5061), 'transport', 'TLS', 'realm', 'riyeser-relay', 'backup', relay_list(ws) -> 1 ->> 'host',
    'self_signed', first ->> 'pin' is not null, 'prov_url', 'https://' || coalesce(first ->> 'addr', first ->> 'host') || case when (first ->> 'port') = '443' then '' else ':' || (first ->> 'port') end || '/prov/' || code,
    'prov_expires', now() + interval '15 minutes');
end $$;
create or replace function public.link_relay_device_remove(ws uuid, device uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare d link_relay_devices;
begin
  select * into d from link_relay_devices x where x.id = device and x.workspace_id = ws and x.removed_at is null;
  if d.id is null then raise exception 'That phone isn''t on the relay.'; end if;
  if not (public.is_admin(ws) or exists (select 1 from members m where m.workspace_id = ws and m.user_id = auth.uid() and m.extension::text = d.extension)) then
    raise exception 'Only an owner or admin can remove someone else''s phone.';
  end if;
  update link_relay_devices set removed_at = now() where id = d.id;
  insert into audit_log (workspace_id, action, details) values (ws, 'link.relay_phone_removed', jsonb_build_object('extension', d.extension, 'label', d.label));
end $$;
-- The Phones page: the relays, each office (site) and how it's connected, and the phones on the relay (admins see all,
-- members their own). Never a password or HA1.
create or replace function public.link_relay_status(ws uuid) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare mine text;
begin
  if not public.is_member(ws) then raise exception 'You''re not in this business.'; end if;
  select m.extension::text into mine from members m where m.workspace_id = ws and m.user_id = auth.uid();
  return jsonb_build_object('enabled', relay_enabled(ws), 'relays', relay_list(ws), 'admin', public.is_admin(ws),
    'manage', case when public.is_admin(ws) then relay_admin_list(ws) end, 'api', 2,
    'offices', (select coalesce(jsonb_agg(jsonb_build_object('office_id', o.office_id, 'pc_name', o.pc_name, 'version', o.version, 'last_seen', o.last_seen,
        'relay', o.relay, 'relay_seen', o.relay_seen, 'revoked', o.relay_revoked_at is not null) order by o.pc_name), '[]') from link_offices o where o.workspace_id = ws),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'extension', d.extension, 'label', d.label, 'username', d.username, 'created_at', d.created_at,
        'last_seen', d.last_seen, 'online', coalesce(d.last_seen > now() - interval '2 minutes', false)) order by d.extension, d.created_at), '[]')
      from link_relay_devices d where d.workspace_id = ws and d.removed_at is null and (public.is_admin(ws) or d.extension = mine)));
end $$;
revoke all on function public.link_relay_config(uuid), public.link_relay_set(uuid, boolean, text[]), public.link_relay_token(uuid, text),
  public.link_relay_report(uuid, text, jsonb), public.link_relay_revoke(uuid, text, boolean), public.link_relay_turn(uuid),
  public.link_relay_device_add(uuid, text, text), public.link_relay_device_remove(uuid, uuid), public.link_relay_status(uuid) from public, anon;
grant execute on function public.link_relay_config(uuid), public.link_relay_set(uuid, boolean, text[]), public.link_relay_token(uuid, text),
  public.link_relay_report(uuid, text, jsonb), public.link_relay_revoke(uuid, text, boolean), public.link_relay_turn(uuid),
  public.link_relay_device_add(uuid, text, text), public.link_relay_device_remove(uuid, uuid), public.link_relay_status(uuid) to authenticated;


-- ================================================================ Real downloads and installs (HQ → Downloads)
-- GitHub's own download counts include our CI runs fetching every installer, our own PCs, Central's update checks and
-- robots. These count what's real:
--  * download_events: one row per click on a riyeser.com Download button. The website's buttons go to
--    riyeser.com/download/<program>.html, which hands off to the "download" Edge Function (supabase/functions/download on
--    main); it calls record_download (service role only) and sends the browser on to the GitHub file. Kept: when, the
--    program, the release, a country (from the network or the browser's time zone), the page the button was on, and a
--    salted hash of the internet address and browser that changes every day (so one person downloading twice in a day
--    counts once, and nothing follows anyone from one day to the next). Never the address or browser details themselves.
--    Flags: bot (robot browsers, no JavaScript and no browser), test (CI, our test header), staff (HQ's "Don't count
--    downloads from this browser").
--  * install_events: Riyeser Central sends one anonymous note when it first runs on a PC ("new"; "existing" for a PC that
--    already had Central before counting began), when a program is added ("add") and when one updates ("update").
--    A random install id made on the PC, the programs, Central's and Windows' versions and the business's country if the
--    PC is linked. Demo mode, CI and developer copies are marked test. Central's Settings → "Send anonymous usage
--    counts" turns it off. When the PC links to a business later, install_link ties the id to it (counted once already).
-- Read only by HQ staff with downloads.view through hq_real_downloads().
create table if not exists public.download_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  program text not null check (program ~ '^[a-z0-9-]{1,40}$'),
  release_tag text check (length(release_tag) <= 80),
  country text check (country ~ '^[A-Z]{2}$'),
  referrer text check (length(referrer) <= 100),
  visitor text not null check (visitor ~ '^[0-9a-f]{16,64}$'),
  browser text check (length(browser) <= 20),
  js boolean not null default false,
  bot boolean not null default false,
  test boolean not null default false,
  staff boolean not null default false
);
create index if not exists download_events_at on public.download_events (at);
create index if not exists download_events_visitor on public.download_events (visitor, at);
create table if not exists public.install_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  install_id uuid not null,
  kind text not null check (kind in ('new', 'existing', 'add', 'update')),
  detail text not null default '' check (length(detail) <= 80),      -- 'pos' (add) or 'pos@1.4.2' (update)
  programs text[] not null default '{}',
  central_version text check (length(central_version) <= 40),
  os_version text check (length(os_version) <= 60),
  country text check (length(country) <= 40),
  test boolean not null default false,
  workspace_id uuid,                                                -- no foreign key: the count outlives the business
  linked_at timestamptz
);
create unique index if not exists install_events_once on public.install_events (install_id, kind, detail);
create index if not exists install_events_at on public.install_events (at);
alter table public.download_events enable row level security;
alter table public.install_events enable row level security;
revoke all on public.download_events, public.install_events from public, anon, authenticated;
-- (no policies: writing goes through record_download / track_install / install_link, reading through hq_real_downloads)

-- One download, from the "download" Edge Function (the service role). Values are tidied; anything odd is dropped.
-- At most 30 a visitor an hour are kept (the download itself still happens). Returns 'ok', 'limited' or 'ignored'.
create or replace function public.record_download(program text, release_tag text, country text, referrer text, visitor text,
  browser text, js boolean, bot boolean, test boolean, staff boolean) returns text
  language plpgsql security definer set search_path = public as $$
declare p text := lower(left(coalesce(program, ''), 40)); v text := lower(left(coalesce(visitor, ''), 64));
  ref text := lower(left(trim(coalesce(referrer, '')), 100));
begin
  if p !~ '^[a-z0-9-]{1,40}$' or v !~ '^[0-9a-f]{16,64}$' then return 'ignored'; end if;
  if (select count(*) from (select 1 from download_events d where d.visitor = v and d.at > now() - interval '1 hour' limit 30) c) >= 30 then return 'limited'; end if;
  -- a website page ('/programs/pos') or another website's name ('google.com'); nothing else
  ref := case when ref ~ '^/' then site_visit_path(ref)
              when ref ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and ref !~ '(^|\.)riyeser\.com$' then regexp_replace(ref, '^www\.', '') end;
  insert into download_events (program, release_tag, country, referrer, visitor, browser, js, bot, test, staff)
  values (p, case when release_tag ~ '^[A-Za-z0-9._-]{1,80}$' then release_tag end, case when upper(country) ~ '^[A-Z]{2}$' and upper(country) not in ('XX', 'T1') then upper(country) end,
    ref, v, case when browser in ('Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Samsung', 'Other') then browser end,
    coalesce(js, false), coalesce(bot, false), coalesce(test, false), coalesce(staff, false));
  return 'ok';
end $$;

-- One note from Riyeser Central (anonymous: the publishable key, no sign-in). The same note twice counts once.
-- At most 50 notes an install id a day. Returns 'ok', 'already' or 'ignored'.
create or replace function public.track_install(install_id uuid, kind text, detail text default '', programs text[] default '{}',
  central_version text default null, os_version text default null, country text default null, test boolean default false) returns text
  language plpgsql security definer set search_path = public as $$
declare d text := lower(left(coalesce(detail, ''), 80)); n int;
begin
  if install_id is null or kind not in ('new', 'existing', 'add', 'update') then return 'ignored'; end if;
  if kind in ('new', 'existing') then d := '';
  elsif kind = 'add' and d !~ '^[a-z0-9-]{1,40}$' then return 'ignored';
  elsif kind = 'update' and d !~ '^[a-z0-9-]{1,40}@[0-9][0-9a-z.+-]{0,30}$' then return 'ignored'; end if;
  -- a PC is new once: a later "existing" from the same PC (or the other way round) isn't counted again
  if kind in ('new', 'existing') and exists (select 1 from install_events e where e.install_id = track_install.install_id and e.kind in ('new', 'existing')) then return 'already'; end if;
  if (select count(*) from (select 1 from install_events e where e.install_id = track_install.install_id and e.at > now() - interval '1 day' limit 50) c) >= 50 then return 'ignored'; end if;
  insert into install_events (install_id, kind, detail, programs, central_version, os_version, country, test)
  values (install_id, kind, d,
    (coalesce((select array_agg(distinct lower(x) order by lower(x)) from unnest(coalesce(programs, '{}')) x where lower(x) ~ '^[a-z0-9-]{1,40}$'), '{}'::text[]))[1:40],
    site_visit_text(central_version, 40), site_visit_text(os_version, 60), site_visit_text(country, 40), coalesce(test, false))
  on conflict do nothing;
  get diagnostics n = row_count;
  return case when n = 1 then 'ok' else 'already' end;
end $$;

-- Central, signed in, once the PC is linked to a business: ties this install id's notes to it (not counted again).
create or replace function public.install_link(install_id uuid, ws uuid) returns int
  language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_member(ws) then raise exception 'You''re not in this business.'; end if;
  update install_events e set workspace_id = ws, linked_at = now() where e.install_id = install_link.install_id and e.workspace_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- HQ → Downloads (downloads.view): the last 7 to 365 days (UTC). "Real" downloads leave out bots, tests and staff, and
-- count one person (the daily hash) once a day per program.
create or replace function public.hq_real_downloads(days int) returns json
  language plpgsql stable security definer set search_path = public as $$
declare n int := least(greatest(coalesce(days, 30), 7), 365); utc_today date := (now() at time zone 'UTC')::date; f date; r json;
begin
  perform hq_need(array['downloads.view']);
  f := utc_today - (n - 1);
  with ev as (select e.*, (e.at at time zone 'UTC')::date as d from download_events e where e.at >= f::timestamp at time zone 'UTC'),
    real as (select distinct on (d, visitor, program) d, visitor, program, country, referrer, release_tag from ev
             where not bot and not test and not staff order by d, visitor, program, at),
    ins as (select i.*, (i.at at time zone 'UTC')::date as d from install_events i where i.at >= f::timestamp at time zone 'UTC'),
    days as (select g::date as d from generate_series(f, utc_today, interval '1 day') g)
  select json_build_object('from', f, 'to', utc_today, 'days', n,
    'real', (select count(*) from real),
    'raw', (select count(*) from ev),
    'hidden', json_build_object('tests', (select count(*) from ev where test), 'staff', (select count(*) from ev where staff and not test),
      'bots', (select count(*) from ev where bot and not test and not staff),
      'repeats', (select count(*) from ev where not bot and not test and not staff) - (select count(*) from real),
      'install_tests', (select count(*) from ins where test)),
    'installs', json_build_object('new', (select count(*) from ins where kind = 'new' and not test), 'existing', (select count(*) from ins where kind = 'existing' and not test),
      'updates', (select count(*) from ins where kind = 'update' and not test), 'added', (select count(*) from ins where kind = 'add' and not test),
      'linked', (select count(distinct install_id) from install_events where workspace_id is not null and not test and kind in ('new', 'existing') and at >= f::timestamp at time zone 'UTC')),
    'series', (select coalesce(json_agg(json_build_object('d', x.d, 'real', (select count(*) from real r where r.d = x.d),
        'installs', (select count(*) from ins i where i.d = x.d and i.kind = 'new' and not i.test),
        'updates', (select count(*) from ins i where i.d = x.d and i.kind = 'update' and not i.test)) order by x.d), '[]') from days x),
    'programs', (select coalesce(json_agg(p order by p.real desc, p.program), '[]') from (
        select k.program, (select count(*) from real r where r.program = k.program) as real, (select count(*) from ev where ev.program = k.program) as raw,
          (select count(*) from ins where not test and ((kind = 'new' and k.program = any(programs)) or (kind = 'add' and detail = k.program))) as installs,
          (select count(*) from ins where not test and kind = 'update' and split_part(detail, '@', 1) = k.program) as updates
        from (select program from ev union select unnest(programs) from ins where kind = 'new' union select split_part(detail, '@', 1) from ins where kind in ('add', 'update')) k
        where k.program <> '') p),
    'program_series', (select coalesce(json_agg(json_build_object('program', program, 'd', d, 'real', c) order by program, d), '[]')
        from (select program, d, count(*) as c from real group by 1, 2) s),
    'countries', (select coalesce(json_agg(c order by c.real desc), '[]') from (select coalesce(country, '') as country, count(*) as real from real group by 1) c),
    'referrers', (select coalesce(json_agg(c order by c.real desc), '[]') from (select coalesce(referrer, '') as referrer, count(*) as real from real group by 1 order by 2 desc limit 20) c),
    'releases', (select coalesce(json_agg(c order by c.real desc), '[]') from (select coalesce(release_tag, '') as tag, count(*) as real from real group by 1 order by 2 desc limit 10) c),
    'install_countries', (select coalesce(json_agg(c order by c.n desc), '[]') from (select coalesce(country, '') as country, count(*) as n from ins where kind = 'new' and not test group by 1) c),
    'central_versions', (select coalesce(json_agg(c order by c.n desc), '[]') from (select coalesce(central_version, '') as version, count(distinct install_id) as n from ins where not test group by 1 order by 2 desc limit 8) c)
  ) into r;
  return r;
end $$;

-- The daily "HQ download counts" job (.github/workflows/hq-downloads.yml) saves GitHub's raw totals with the database
-- connection (TEAM_DB_URL), so it needs no token. Only the database owner can run this.
create or replace function public.hq_save_download_totals(totals jsonb) returns int
  language plpgsql security definer set search_path = public as $$
declare n int := 0; k text;
begin
  for k in select jsonb_object_keys(totals) loop
    if coalesce(totals ->> k, '') !~ '^\d{1,15}$' then continue; end if;
    insert into downloads_daily (day, asset, total) values (current_date, left(k, 120), (totals ->> k)::bigint)
      on conflict (day, asset) do update set total = excluded.total;
    n := n + 1;
  end loop;
  -- raw rows are kept 3 years
  delete from download_events where at < now() - interval '3 years';
  delete from install_events where at < now() - interval '3 years' and kind in ('add', 'update');
  return n;
end $$;

revoke all on function public.record_download(text, text, text, text, text, text, boolean, boolean, boolean, boolean),
  public.track_install(uuid, text, text, text[], text, text, text, boolean), public.install_link(uuid, uuid),
  public.hq_real_downloads(int), public.hq_save_download_totals(jsonb) from public, anon, authenticated;
grant execute on function public.record_download(text, text, text, text, text, text, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.track_install(uuid, text, text, text[], text, text, text, boolean) to anon, authenticated;
grant execute on function public.install_link(uuid, uuid), public.hq_real_downloads(int) to authenticated;
-- ================================================================ Your booking page (riyeser.com/book/<address>)
-- Every business with Riyeser Bookings can have its own booking page on riyeser.com, switched on with one tick in
-- Management → Connections → Booking page. Nothing to paste into a website: the page shows the business's name, logo,
-- colour, address, opening hours (from the open times its PCs publish), services with duration and price, staff
-- (optional) and free times, and sends booking requests to the post box like the booking widget does.
--   * Off until an owner or admin (two-step sign-in) switches it on. Personal accounts have none.
--   * Switching it on makes a page key behind the scenes (api_keys.internal = 'booking_page'): a widget key with only
--     availability:read and bookings:write. Nobody ever sees it (only a hash of random bits that were never kept),
--     it isn't in the API keys list, and owners can't rename or revoke it there: switching the page off stops it.
--   * The "api" Edge Function serves /v1/pages/{address} (the public profile) and /slots, /bookings, /events/{id}
--     under it, with no key in the browser: api_page_auth finds the page key from the address, only for the booking
--     page's own web addresses (HQ setting booking_page.origins, default riyeser.com and www.riyeser.com), with rate
--     limits per visitor address (api.page_ip_per_minute, 40) and per page (api.page_per_minute, 300).
--   * The public profile (api_page_profile) has only what a customer needs. Never staff surnames, the books, keys or
--     anything about the people in the business.
-- Safe to run again.
alter table public.api_keys add column if not exists internal text;
do $$ begin
  alter table public.api_keys add constraint api_keys_internal check (internal is null or internal in ('booking_page'));
exception when duplicate_object then null; end $$;

create table if not exists public.booking_pages (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$' and slug !~ '--'),
  enabled boolean not null default false,
  key_id uuid references public.api_keys(id) on delete set null,
  intro text check (length(intro) <= 300),
  colour text not null default '#0e7c86' check (colour ~ '^#[0-9a-f]{6}$'),
  logo text check (length(logo) <= 150000 and logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$'),
  show_prices boolean not null default true,
  show_staff boolean not null default true,
  show_contact boolean not null default true,     -- the business's address and phone
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index if not exists booking_pages_slug on public.booking_pages (slug);
alter table public.booking_pages enable row level security;
revoke all on public.booking_pages from public, anon, authenticated;

-- Addresses nobody can have (Riyeser's own words, and ones that would look official).
create or replace function public.booking_page_reserved() returns text[] language sql immutable as $$
  select array['admin', 'administrator', 'api', 'app', 'apps', 'assets', 'book', 'booking', 'bookings', 'help', 'hq', 'link', 'login',
    'logout', 'new', 'official', 'page', 'pages', 'riyeser', 'riyeser-hq', 'root', 'security', 'settings', 'signin', 'signup',
    'software', 'staff', 'support', 'system', 'team', 'test', 'www', 'widget', 'developers', 'demo', 'example', 'sample']
$$;
-- "Harbour Hair Studio!" -> harbour-hair-studio. Raises with a plain message when it can't be an address.
create or replace function public.booking_page_clean_slug(s text) returns text language plpgsql immutable as $$
declare v text := lower(trim(coalesce(s, '')));
begin
  v := regexp_replace(v, '[^a-z0-9]+', '-', 'g');
  v := regexp_replace(v, '(^-+|-+$)', '', 'g');
  if length(v) < 3 then raise exception 'The address needs at least 3 letters or numbers.'; end if;
  if length(v) > 40 then raise exception 'The address can be up to 40 letters, numbers and dashes.'; end if;
  if v = any (booking_page_reserved()) then raise exception '"%" is kept for Riyeser. Try your business''s name.', v; end if;
  return v;
end $$;
-- A free address made from the business's name (harbour-hair-studio, then harbour-hair-studio-2 …).
create or replace function public.booking_page_suggest(ws uuid) returns text
  language plpgsql stable security definer set search_path = public as $$
declare base text; v text; n int := 1;
begin
  begin base := booking_page_clean_slug(left(regexp_replace(lower(coalesce((select name from workspaces where id = ws), '')), '[^a-z0-9]+', '-', 'g'), 36));
  exception when others then base := 'my-business'; end;
  base := left(regexp_replace(base, '-+$', ''), 36);
  v := base;
  while exists (select 1 from booking_pages p where p.slug = v and p.workspace_id <> ws) loop n := n + 1; v := base || '-' || n; end loop;
  return v;
end $$;
-- The web addresses the booking page is served from (the Edge Function only answers those browsers).
create or replace function public.booking_page_origins() returns text[]
  language sql stable security definer set search_path = public as $$
  select coalesce((select array_agg(trim(o)) from hq_settings s, unnest(string_to_array(s.value, ',')) o
                   where s.key = 'booking_page.origins' and trim(o) ~ '^https?://[a-z0-9.:-]+$'),
                  array['https://riyeser.com', 'https://www.riyeser.com'])
$$;

-- For owners and admins: where the page stands (null until it's first saved), a free address to suggest, and what
-- the page would show.
create or replace function public.booking_page_get(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare p booking_pages; w workspaces;
begin
  perform api_need_admin(ws);
  select * into w from workspaces where id = ws;
  if w.kind = 'personal' then raise exception 'Booking pages are for businesses.'; end if;
  select * into p from booking_pages where workspace_id = ws;
  return json_build_object(
    'page', case when p.workspace_id is null then null else json_build_object('slug', p.slug, 'enabled', p.enabled, 'intro', p.intro, 'colour', p.colour,
        'logo', p.logo, 'show_prices', p.show_prices, 'show_staff', p.show_staff, 'show_contact', p.show_contact, 'updated_at', p.updated_at,
        'working', p.enabled and exists (select 1 from api_keys k where k.id = p.key_id and k.revoked_at is null)) end,
    'suggested_slug', coalesce(p.slug, booking_page_suggest(ws)),
    'business', json_build_object('name', w.name, 'address', w.address, 'phone', w.phone),
    'allowed', api_gate(ws, 'availability:read') is null,
    'published', json_build_object('services', (select count(*) from api_catalog c where c.workspace_id = ws and c.type = 'service' and c.active and c.duration_minutes is not null),
        'open_times', (select count(*) from api_open_times o where o.workspace_id = ws and o.ends_at > now()),
        'availability_at', (select updated_at from api_published where workspace_id = ws and what = 'availability')),
    'bookings_7d', (select count(*) from api_inbox i join booking_pages bp on bp.workspace_id = i.workspace_id and bp.key_id = i.key_id
        where i.workspace_id = ws and i.kind = 'booking' and i.created_at > now() - interval '7 days'));
end $$;

-- Is this address free? {ok, slug (tidied), message}. Never raises for a bad address: says why instead.
create or replace function public.booking_page_slug_check(ws uuid, slug text) returns json
  language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  perform api_need_admin(ws);
  begin v := booking_page_clean_slug(slug); exception when others then return json_build_object('ok', false, 'slug', null, 'message', sqlerrm); end;
  if exists (select 1 from booking_pages p where p.slug = v and p.workspace_id <> ws) then
    return json_build_object('ok', false, 'slug', v, 'message', 'riyeser.com/book/' || v || ' is taken. Try adding your town, like ' || left(v, 33) || '-suva.');
  end if;
  return json_build_object('ok', true, 'slug', v, 'message', null);
end $$;

-- Save the page. settings: {slug, enabled, intro, colour, logo ('' removes it), show_prices, show_staff, show_contact};
-- anything left out stays as it is. Switching it on makes the page key if it has none (or it was revoked).
create or replace function public.booking_page_save(ws uuid, settings jsonb) returns json
  language plpgsql security definer set search_path = public as $$
declare p booking_pages; s jsonb := coalesce(settings, '{}'::jsonb); v text; was boolean; kid uuid; lg text; col text; w workspaces;
begin
  perform api_need_admin(ws);
  select * into w from workspaces where id = ws;
  if w.kind = 'personal' then raise exception 'Booking pages are for businesses.'; end if;
  if jsonb_typeof(s) <> 'object' then raise exception 'settings must be an object.'; end if;
  select * into p from booking_pages where workspace_id = ws for update;
  was := coalesce(p.enabled, false);
  v := case when s ? 'slug' then booking_page_clean_slug(s ->> 'slug') else coalesce(p.slug, booking_page_suggest(ws)) end;
  if exists (select 1 from booking_pages x where x.slug = v and x.workspace_id <> ws) then
    raise exception 'riyeser.com/book/% is taken. Try another address.', v;
  end if;
  col := lower(coalesce(nullif(trim(s ->> 'colour'), ''), p.colour, '#0e7c86'));
  if col ~ '^#[0-9a-f]{3}$' then col := '#' || substr(col, 2, 1) || substr(col, 2, 1) || substr(col, 3, 1) || substr(col, 3, 1) || substr(col, 4, 1) || substr(col, 4, 1); end if;
  if col !~ '^#[0-9a-f]{6}$' then raise exception 'The colour looks like #0e7c86.'; end if;
  lg := case when s ? 'logo' then nullif(s ->> 'logo', '') else p.logo end;
  if lg is not null and (length(lg) > 150000 or lg !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$') then
    raise exception 'The logo must be a PNG, JPEG or WebP picture, up to about 100 KB.';
  end if;
  if s ? 'intro' and length(coalesce(s ->> 'intro', '')) > 300 then raise exception 'The welcome text can be up to 300 letters.'; end if;
  insert into booking_pages as b (workspace_id, slug, enabled, intro, colour, logo, show_prices, show_staff, show_contact, updated_by)
    values (ws, v, coalesce((s ->> 'enabled')::boolean, false), nullif(trim(regexp_replace(coalesce(s ->> 'intro', ''), '[[:cntrl:]]', ' ', 'g')), ''), col, lg,
            coalesce((s ->> 'show_prices')::boolean, true), coalesce((s ->> 'show_staff')::boolean, true), coalesce((s ->> 'show_contact')::boolean, true), auth.uid())
    on conflict (workspace_id) do update set slug = v,
      enabled = coalesce((s ->> 'enabled')::boolean, b.enabled),
      intro = case when s ? 'intro' then nullif(trim(regexp_replace(coalesce(s ->> 'intro', ''), '[[:cntrl:]]', ' ', 'g')), '') else b.intro end,
      colour = col, logo = lg,
      show_prices = coalesce((s ->> 'show_prices')::boolean, b.show_prices), show_staff = coalesce((s ->> 'show_staff')::boolean, b.show_staff),
      show_contact = coalesce((s ->> 'show_contact')::boolean, b.show_contact), updated_at = now(), updated_by = auth.uid()
    returning * into p;
  if p.enabled and not exists (select 1 from api_keys k where k.id = p.key_id and k.revoked_at is null) then
    -- the page key: a hash of random bits nobody keeps, so it can't be used as a Bearer key anywhere
    insert into api_keys (workspace_id, name, kind, mode, scopes, prefix, key_hash, allowed_origins, created_by, internal)
      values (ws, 'Booking page', 'widget', 'live', array['availability:read', 'bookings:write'], 'rk_pub_live_page',
              encode(sha256(convert_to(api_random_hex(64) || gen_random_uuid()::text, 'UTF8')), 'hex'), booking_page_origins(), auth.uid(), 'booking_page')
      returning id into kid;
    update booking_pages set key_id = kid where workspace_id = ws returning * into p;
  end if;
  insert into audit_log (workspace_id, action, details) values (ws,
    case when p.enabled and not was then 'booking_page.on' when was and not p.enabled then 'booking_page.off' else 'booking_page.update' end,
    jsonb_build_object('slug', p.slug, 'enabled', p.enabled));
  return booking_page_get(ws);
end $$;

-- The Edge Function's first call for /v1/pages/{address}… (service role only): like api_auth, but from the page's
-- address instead of a key. Every call counts against the visitor's address first (so trying addresses is limited too).
create or replace function public.api_page_auth(slug text, ip text) returns json
  language plpgsql security definer set search_path = public as $$
declare p booking_pages; k api_keys; w workspaces; minute bigint := floor(extract(epoch from now()) / 60); addr inet; n int; lim int; nd int;
  og jsonb := jsonb_build_object('origins', booking_page_origins());   -- with every refusal, so the page can read it (CORS)
  gone json := (api_err('page_not_found', 'This business isn''t taking online bookings here.')::jsonb || og)::json;
begin
  begin addr := nullif(ip, '')::inet; exception when others then addr := null; end;
  if addr is not null and api_rate_hit('pi:' || api_ip_trunc(host(addr)) || ':' || minute, interval '2 minutes') > hq_setting_num('api.page_ip_per_minute', 40) then
    return (api_err('rate_limited', 'Too many requests from here. Wait a minute and try again.')::jsonb
      || jsonb_build_object('retry_after', 60 - extract(epoch from now())::int % 60) || og)::json;
  end if;
  if coalesce(slug, '') !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then return gone; end if;
  select * into p from booking_pages b where b.slug = api_page_auth.slug;
  if p.workspace_id is null or not p.enabled then return gone; end if;
  select * into k from api_keys a where a.id = p.key_id and a.revoked_at is null;
  select * into w from workspaces where id = p.workspace_id;
  if k.id is null or w.kind = 'personal' then return gone; end if;
  if w.status is distinct from 'active' then return (api_err('business_closed', api_gate_message('business_closed'))::jsonb || og)::json; end if;
  lim := hq_setting_num('api.page_per_minute', 300)::int;
  n := api_rate_hit('k:' || k.id || ':' || minute, interval '2 minutes');
  nd := api_rate_hit('w:' || k.workspace_id || ':' || current_date, interval '2 days');
  if n > lim then
    return (api_err('rate_limited', 'This booking page is very busy. Wait a minute and try again.')::jsonb
      || jsonb_build_object('retry_after', 60 - extract(epoch from now())::int % 60, 'key_id', k.id, 'workspace_id', k.workspace_id) || og)::json;
  end if;
  if nd > hq_setting_num('api.workspace_per_day', 20000) then
    return (api_err('daily_limit', 'This business has reached its daily limit for online bookings. Try again tomorrow.')::jsonb
      || jsonb_build_object('retry_after', extract(epoch from (date_trunc('day', now()) + interval '1 day' - now()))::int, 'key_id', k.id, 'workspace_id', k.workspace_id) || og)::json;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then update api_keys set last_used_at = now() where id = k.id; end if;
  return json_build_object('key_id', k.id, 'workspace_id', k.workspace_id, 'kind', 'widget', 'mode', 'live', 'scopes', k.scopes,
    'allowed_origins', booking_page_origins(), 'name', 'Booking page', 'slug', p.slug,
    'rate', json_build_object('limit', lim, 'remaining', greatest(lim - n, 0), 'reset', 60 - extract(epoch from now())::int % 60));
end $$;

-- What the booking page shows (service role only, after api_page_auth). Only what a customer needs.
create or replace function public.api_page_profile(key_id uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
declare p booking_pages; w workspaces; st api_booking_settings; tz text; g text;
begin
  select b.* into p from booking_pages b join api_keys k on k.id = b.key_id and k.revoked_at is null where b.key_id = api_page_profile.key_id and b.enabled;
  if p.workspace_id is null then return api_err('page_not_found', 'This business isn''t taking online bookings here.'); end if;
  select * into w from workspaces where id = p.workspace_id;
  select * into st from api_booking_settings where workspace_id = p.workspace_id;
  tz := coalesce(st.timezone, 'UTC');
  g := api_gate(p.workspace_id, 'availability:read');
  return json_build_object('slug', p.slug, 'name', w.name, 'intro', p.intro, 'colour', p.colour, 'logo', p.logo,
    'address', case when p.show_contact then w.address end, 'phone', case when p.show_contact then w.phone end,
    'timezone', tz, 'slot_minutes', coalesce(st.slot_minutes, 15), 'days_ahead', coalesce(st.days_ahead, 30),
    'accepting', g is null and exists (select 1 from api_catalog c where c.workspace_id = p.workspace_id and c.type = 'service' and c.active and c.duration_minutes is not null),
    'reason', g,
    'services', case when g is null then (select coalesce(json_agg(json_build_object('sku', c.sku, 'name', c.name, 'description', c.description, 'category', c.category,
        'duration_minutes', c.duration_minutes, 'price', case when p.show_prices then c.price end, 'currency', case when p.show_prices then c.currency end)
        order by c.category nulls first, c.name), '[]') from api_catalog c where c.workspace_id = p.workspace_id and c.type = 'service' and c.active and c.duration_minutes is not null)
      else '[]'::json end,
    'staff', case when g is null and p.show_staff then (select coalesce(json_agg(json_build_object('ref', s.ref, 'name', s.name, 'services', s.services) order by s.name), '[]')
        from api_staff s where s.workspace_id = p.workspace_id and s.active) else '[]'::json end,
    -- opening hours for the next 7 days, from the open times the PCs publish (earliest start, latest end each day)
    'hours', (select coalesce(json_agg(json_build_object('day', d, 'open', to_char(o1, 'HH24:MI'), 'close', to_char(c1, 'HH24:MI')) order by d), '[]')
      from (select (o.starts_at at time zone tz)::date d, min((o.starts_at at time zone tz)::time) o1,
                   max(case when (o.ends_at at time zone tz)::date > (o.starts_at at time zone tz)::date then time '23:59' else (o.ends_at at time zone tz)::time end) c1
            from api_open_times o where o.workspace_id = p.workspace_id and o.ends_at > now() and o.starts_at < now() + interval '7 days'
              and (o.staff_ref is null or exists (select 1 from api_staff s where s.workspace_id = p.workspace_id and s.ref = o.staff_ref and s.active))
            group by 1) h),
    'updated_at', (select updated_at from api_published where workspace_id = p.workspace_id and what = 'availability'));
end $$;

-- The page key isn't one of the owner's keys: not in the list or the counts, and it can't be renamed, limited or
-- revoked there (switching the page off is how it stops). The same functions as above, leaving internal keys out.
create or replace function public.api_keys_list(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return (select coalesce(json_agg(api_key_json(k) order by k.revoked_at is not null, k.created_at desc), '[]') from api_keys k where k.workspace_id = ws and k.internal is null);
end $$;
create or replace function public.api_key_revoke(ws uuid, key_id uuid) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys;
begin
  perform api_need_admin(ws);
  update api_keys set revoked_at = now(), revoked_by = auth.uid() where id = key_id and workspace_id = ws and revoked_at is null and internal is null returning * into k;
  if k.id is null then raise exception 'That key isn''t there, or it''s already revoked.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.revoke', jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix));
  return api_key_json(k);
end $$;
create or replace function public.api_key_rename(ws uuid, key_id uuid, key_name text) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; was text;
begin
  perform api_need_admin(ws);
  if coalesce(trim(key_name), '') = '' or length(trim(key_name)) > 60 then raise exception 'Give the key a name (up to 60 letters).'; end if;
  select name into was from api_keys where id = key_id and workspace_id = ws and internal is null;
  update api_keys set name = trim(key_name) where id = key_id and workspace_id = ws and internal is null returning * into k;
  if k.id is null then raise exception 'That key isn''t there.'; end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.rename', jsonb_build_object('id', k.id, 'name', jsonb_build_object('was', was, 'now', k.name)));
  return api_key_json(k);
end $$;
create or replace function public.api_key_set_access(ws uuid, key_id uuid, origins text[], ips text[]) returns json
  language plpgsql security definer set search_path = public as $$
declare k api_keys; og text[]; ip cidr[];
begin
  perform api_need_admin(ws);
  select * into k from api_keys where id = key_id and workspace_id = ws and revoked_at is null and internal is null;
  if k.id is null then raise exception 'That key isn''t there, or it''s revoked.'; end if;
  og := api_clean_origins(origins, k.mode); ip := api_clean_ips(ips);
  if k.kind = 'widget' and cardinality(og) = 0 then raise exception 'A widget key needs the website address it''s on.'; end if;
  update api_keys set allowed_origins = og, allowed_ips = ip where id = k.id returning * into k;
  insert into audit_log (workspace_id, action, details) values (ws, 'api_key.access',
    jsonb_build_object('id', k.id, 'name', k.name, 'allowed_origins', og, 'allowed_ips', ip::text[]));
  return api_key_json(k);
end $$;
-- api_overview: the same, with the booking page's key left out of "API keys in use" and the page's state added.
create or replace function public.api_overview(ws uuid) returns json
  language plpgsql stable security definer set search_path = public as $$
begin
  perform api_need_admin(ws);
  return json_build_object(
    'keys', (select json_build_object('active', count(*) filter (where revoked_at is null), 'revoked', count(*) filter (where revoked_at is not null)) from api_keys where workspace_id = ws and internal is null),
    'inbox', (select json_build_object('waiting', count(*) filter (where status = 'waiting'), 'taken', count(*) filter (where status = 'taken'),
        'failed', count(*) filter (where status = 'failed'), 'rejected_7d', count(*) filter (where status = 'rejected' and updated_at > now() - interval '7 days'),
        'done_7d', count(*) filter (where status = 'done' and done_at > now() - interval '7 days')) from api_inbox where workspace_id = ws),
    'published', json_build_object(
        'catalog_items', (select count(*) from api_catalog where workspace_id = ws),
        'stock_items', (select count(*) from api_stock where workspace_id = ws),
        'open_times', (select count(*) from api_open_times where workspace_id = ws and ends_at > now()),
        'staff', (select count(*) from api_staff where workspace_id = ws and active),
        'catalog_at', (select updated_at from api_published where workspace_id = ws and what = 'catalog'),
        'stock_at', (select updated_at from api_published where workspace_id = ws and what = 'stock'),
        'availability_at', (select updated_at from api_published where workspace_id = ws and what = 'availability')),
    'webhooks', (select json_build_object('active', count(*) filter (where active), 'failing', count(*) filter (where failing_since is not null)) from api_webhooks where workspace_id = ws),
    'requests_24h', (select count(*) from api_requests where workspace_id = ws and at > now() - interval '24 hours'),
    'errors_24h', (select count(*) from api_requests where workspace_id = ws and at > now() - interval '24 hours' and status >= 400),
    'allowed', json_build_object('any', api_gate(ws, 'prices:read') is null, 'bookings', api_gate(ws, 'bookings:write') is null,
        'orders', api_gate(ws, 'orders:write') is null),
    'booking_page', (select json_build_object('enabled', p.enabled, 'slug', p.slug) from booking_pages p where p.workspace_id = ws));
end $$;

revoke all on function public.booking_page_reserved(), public.booking_page_clean_slug(text), public.booking_page_suggest(uuid),
  public.booking_page_origins(), public.booking_page_get(uuid), public.booking_page_slug_check(uuid, text), public.booking_page_save(uuid, jsonb),
  public.api_page_auth(text, text), public.api_page_profile(uuid) from public, anon, authenticated;
-- owners and admins (each checks two-step sign-in)
grant execute on function public.booking_page_get(uuid), public.booking_page_slug_check(uuid, text), public.booking_page_save(uuid, jsonb) to authenticated;
-- only the "api" Edge Function (Supabase's service role)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.api_page_auth(text, text), public.api_page_profile(uuid) to service_role;
  end if;
end $$;
-- ---------------------------------------------------------------- 1.3.1: Sites & relay — change or remove the relay PC
-- Owners and admins (two-step sign-in), for their own business only:
--   main    make this relay the first one the business's sites use (and, for one the business looks after, priority 1)
--   off/on  stop or start using this relay for the business (sites move to the next one by themselves)
--   remove  remove a relay the business looks after (managed_by): its key stops working at once, and keys copied from
--           it stop working on the other relays within 30 seconds (relay_drop). For a dead or lost PC too.
-- Switching off or removing the business's last relay needs confirm = true, and switches the relay off for it.
create or replace function public.link_relay_manage(ws uuid, relay_id text, action text, confirm boolean default false) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare r relay_servers; left_after int; ord text[]; out jsonb;
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can change the relays.'; end if;
  select * into r from relay_servers x where x.id = link_relay_manage.relay_id and (x.workspace_id is null or x.workspace_id = ws);
  if r.id is null then raise exception 'That relay isn''t one your business uses.'; end if;
  if action not in ('main', 'off', 'on', 'remove') then raise exception 'Choose main, off, on or remove.'; end if;
  insert into link_relay_settings (workspace_id, updated_by) values (ws, auth.uid()) on conflict (workspace_id) do nothing;
  if action in ('off', 'remove') then
    select count(*) into left_after from jsonb_array_elements(relay_list(ws)) x where x ->> 'id' <> r.id;
    if left_after = 0 and relay_enabled(ws) and not coalesce(confirm, false) then
      raise exception 'LAST_RELAY: This is your business''s last relay. Without it your sites can''t call each other and phones at home stop working, so the relay will be switched off for your business. Add another relay first, or confirm.';
    end if;
  end if;
  if action = 'remove' and r.managed_by is distinct from ws and r.workspace_id is distinct from ws then
    raise exception 'This relay is Riyeser''s, so it can''t be removed from here. Switch it off for your business instead.';
  end if;
  if action = 'main' then
    select array_agg(x ->> 'id' order by n) into ord from jsonb_array_elements(relay_admin_list(ws)) with ordinality t(x, n) where x ->> 'id' <> r.id;
    update link_relay_settings set relays = array[r.id] || coalesce(ord, '{}'), off = array_remove(off, r.id), updated_by = auth.uid(), updated_at = now() where workspace_id = ws;
    if r.managed_by = ws then
      update relay_servers set priority = greatest(priority, 2) where managed_by = ws and id <> r.id and priority = 1;
      update relay_servers set priority = 1 where id = r.id;
    end if;
  elsif action = 'off' then
    update link_relay_settings set off = array_append(array_remove(off, r.id), r.id), updated_by = auth.uid(), updated_at = now() where workspace_id = ws;
  elsif action = 'on' then
    update link_relay_settings set off = array_remove(off, r.id), updated_by = auth.uid(), updated_at = now() where workspace_id = ws;
  else
    out := relay_drop(r.id, 'removed');
  end if;
  if action = 'off' and jsonb_array_length(relay_list(ws)) = 0 and relay_enabled(ws) then
    update link_relay_settings set enabled = false where workspace_id = ws;
    insert into audit_log (workspace_id, action, details) values (ws, 'link.relay_off', jsonb_build_object('reason', 'the last relay was switched off', 'relay', r.id));
  end if;
  insert into audit_log (workspace_id, action, details) values (ws, 'link.relay_' || case action when 'main' then 'made_main' when 'off' then 'switched_off' when 'on' then 'switched_on' else 'removed' end,
    jsonb_strip_nulls(jsonb_build_object('relay', r.id, 'region', r.region, 'rotated', out -> 'rotated')));
  return link_relay_status(ws) || jsonb_build_object('result', coalesce(out, '{}'::jsonb));
end $$;

-- Owners and admins: a one-time set-up code (30 minutes) for a new relay PC, typed into Riyeser Link Office on that
-- PC ("This PC as the relay"). With replaces: the new PC takes over that relay's place, priority and web name once it
-- first checks in, and the old one is removed then. dns false (the default): no web name, sites use its address.
-- -> { code, expires_at, relay_id }
create or replace function public.link_relay_enroll_code(ws uuid, region text default '', replaces text default null, host text default null, priority int default null) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare old relay_servers; code text; rid text; h text; pr int; use_dns boolean;
begin
  if not public.is_admin(ws) then raise exception 'Only the business''s owner or an admin, signed in with two-step sign-in, can set up a relay PC.'; end if;
  if coalesce(region, '') ~ '[[:cntrl:]<>"`$]' or length(coalesce(region, '')) > 60 then raise exception 'Give the relay PC a short place name, like Suva head office.'; end if;
  if replaces is not null then
    select * into old from relay_servers x where x.id = link_relay_enroll_code.replaces and (x.managed_by = ws or x.workspace_id = ws);
    if old.id is null then raise exception 'Choose one of your business''s own relays to move.'; end if;
  end if;
  if host is not null and host !~ '^[A-Za-z0-9]([A-Za-z0-9-]*\.)+[A-Za-z]{2,}$' then raise exception 'That web name doesn''t look right (like relay.example.com).'; end if;
  if (select count(*) from relay_enrollments e where e.workspace_id = ws and e.created_at > now() - interval '1 hour') >= 10 then raise exception 'Too many set-up codes in the last hour. Use one of them, or wait a little.'; end if;
  rid := 'r' || encode(gen_random_bytes(4), 'hex');
  use_dns := coalesce(host, case when old.dns then old.host end) is not null;
  h := lower(coalesce(host, case when old.dns then old.host end, rid || '.relay.invalid'));
  pr := coalesce(priority, old.priority, case when exists (select 1 from relay_servers x where x.workspace_id is null or x.workspace_id = ws) then 2 else 1 end);
  code := upper(substr(translate(encode(gen_random_bytes(10), 'base64'), '+/=01OIl', 'XYZ23456'), 1, 12));
  code := 'RLY-' || substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4);
  insert into relay_enrollments (code_hash, workspace_id, relay_id, host, region, priority, dns, replaces, created_by)
    values (encode(digest(code, 'sha256'), 'hex'), ws, rid, h, coalesce(nullif(trim(region), ''), old.region, 'Head office'), least(greatest(pr, 1), 99), use_dns, old.id, auth.uid());
  insert into audit_log (workspace_id, action, details) values (ws, 'link.relay_code_made', jsonb_strip_nulls(jsonb_build_object('relay', rid, 'replaces', old.id)));
  return jsonb_build_object('code', code, 'expires_at', now() + interval '30 minutes', 'relay_id', rid, 'replaces', old.id, 'host', case when use_dns then h end);
end $$;

-- Riyeser Link Office on the new relay PC: the set-up code -> this relay's own new key (once; never the cluster secret).
-- The relay isn't used by any site until it has checked in (relay_sync) with that key.
create or replace function public.relay_enroll_claim(code text) returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare e relay_enrollments; old relay_servers; k text := encode(gen_random_bytes(32), 'hex');
begin
  select * into e from relay_enrollments x where x.code_hash = encode(digest(upper(trim(coalesce(code, ''))), 'sha256'), 'hex') for update;
  if e.code_hash is null or e.used_at is not null or e.expires_at < now() then
    raise exception 'That set-up code isn''t right, or it has been used or is more than 30 minutes old. Make a new one on the website: Management → Desk phones → Sites & relay.';
  end if;
  update relay_enrollments set used_at = now() where code_hash = e.code_hash;
  if not exists (select 1 from relay_cluster where id = 1) then insert into relay_cluster (id, secret) values (1, encode(gen_random_bytes(32), 'hex')); end if;
  if e.replaces is not null then select * into old from relay_servers where id = e.replaces; end if;
  insert into relay_servers (id, host, region, priority, workspace_id, managed_by, sync_key, dns, replaces, port)
    values (e.relay_id, e.host, e.region, e.priority, case when old.id is not null then old.workspace_id else e.workspace_id end, e.workspace_id, k, e.dns, old.id, coalesce(old.port, 443));
  insert into audit_log (workspace_id, action, details) values (e.workspace_id, 'link.relay_code_used', jsonb_strip_nulls(jsonb_build_object('relay', e.relay_id, 'replaces', old.id)));
  return jsonb_strip_nulls(jsonb_build_object('relay_id', e.relay_id, 'host', e.host, 'dns', e.dns, 'region', e.region, 'priority', e.priority, 'replaces', old.id, 'key', k));
end $$;
revoke all on function public.link_relay_manage(uuid, text, text, boolean), public.link_relay_enroll_code(uuid, text, text, text, int), public.relay_enroll_claim(text) from public, anon;
grant execute on function public.link_relay_manage(uuid, text, text, boolean), public.link_relay_enroll_code(uuid, text, text, text, int) to authenticated;
grant execute on function public.relay_enroll_claim(text) to anon, authenticated;
