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
  kind text not null default 'channel' check (kind in ('channel', 'dm')),
  name text check (kind = 'dm' or length(trim(name)) between 1 and 40),
  topic text check (length(topic) <= 200),
  dm_key text,                       -- for direct messages: the two people's ids, sorted, so there's only one per pair
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  archived boolean not null default false,
  unique (workspace_id, dm_key)
);

create table if not exists public.channel_members (   -- who is in a direct message
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
  using (kind = 'channel' and (created_by = auth.uid() or public.is_admin(workspace_id)))
  with check (kind = 'channel' and public.is_member(workspace_id));

drop policy if exists cm_read on public.channel_members;
create policy cm_read on public.channel_members for select to authenticated using (public.can_see_channel(channel_id));

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
create or replace function public.create_team(team_name text, your_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into workspaces (name, created_by) values (trim(team_name), auth.uid()) returning id into ws;
  insert into members (workspace_id, user_id, display_name, role) values (ws, auth.uid(), trim(your_name), 'owner');
  insert into channels (workspace_id, kind, name, topic, created_by)
    values (ws, 'channel', 'general', 'Everyone in the team', auth.uid()),
           (ws, 'channel', 'jobs', 'Jobs, bookings and what''s on today', auth.uid());
  return ws;
end $$;

create or replace function public.join_team(code text, your_name text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into ws from workspaces where invite_code = upper(trim(code));
  if ws is null then raise exception 'That invite code isn''t right. Ask the person who invited you for the link again.'; end if;
  insert into members (workspace_id, user_id, display_name) values (ws, auth.uid(), trim(your_name))
    on conflict (workspace_id, user_id) do nothing;
  return ws;
end $$;

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

revoke all on function public.create_team(text, text), public.join_team(text, text), public.new_invite_code(uuid),
  public.set_role(uuid, uuid, text), public.open_dm(uuid, uuid), public.unread_counts(uuid) from public, anon;
grant execute on function public.create_team(text, text), public.join_team(text, text), public.new_invite_code(uuid),
  public.set_role(uuid, uuid, text), public.open_dm(uuid, uuid), public.unread_counts(uuid) to authenticated;
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
