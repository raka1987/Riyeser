-- A stand-in for Supabase: its roles, auth.users, auth.uid() and the realtime publication.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$; do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
create publication supabase_realtime;
insert into auth.users values ('11111111-1111-1111-1111-111111111111','owner@a.test'),('22222222-2222-2222-2222-222222222222','staff@a.test'),
  ('33333333-3333-3333-3333-333333333333','owner@b.test'),('44444444-4444-4444-4444-444444444444','third@a.test');
