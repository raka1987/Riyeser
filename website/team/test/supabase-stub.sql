-- A stand-in for Supabase: its roles, auth.users (with sign-in times, sign-up metadata and email confirmation), auth.mfa_factors (authenticator apps), auth.uid() and the realtime publication.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$; do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz, created_at timestamptz default now(),
  raw_user_meta_data jsonb default '{}'::jsonb, email_confirmed_at timestamptz default now());
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, factor_type text not null default 'totp', status text not null default 'verified');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
create publication supabase_realtime;
insert into auth.users values ('11111111-1111-1111-1111-111111111111','owner@a.test'),('22222222-2222-2222-2222-222222222222','staff@a.test'),
  ('33333333-3333-3333-3333-333333333333','owner@b.test'),('44444444-4444-4444-4444-444444444444','third@a.test');
-- Supabase Storage, just enough for the file rules: buckets, objects (with row rules) and who uploaded each.
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null,
  owner uuid default auth.uid(), created_at timestamptz default now(), metadata jsonb, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated; grant select, insert on storage.objects to authenticated;
