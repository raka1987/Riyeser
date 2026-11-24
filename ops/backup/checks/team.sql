-- Riyeser Team: the restored data hangs together. Each check must find nothing.
do $$ declare n bigint; begin
  select count(*) into n from public.members m left join public.workspaces w on w.id = m.workspace_id where w.id is null;
  if n > 0 then raise exception '% people belong to a company that isn''t there', n; end if;
  select count(*) into n from public.messages m left join public.channels c on c.id = m.channel_id where c.id is null;
  if n > 0 then raise exception '% messages are in a chat that isn''t there', n; end if;
  select count(*) into n from public.members m left join auth.users u on u.id = m.user_id where u.id is null;
  if n > 0 then raise exception '% people have no sign-in account', n; end if;
  select count(*) into n from public.workspaces where company_code is null;
  if n > 0 then raise exception '% companies have no Company ID', n; end if;
  -- the row rules came back on (each business stays separate)
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if n > 0 then raise exception '% tables have their row rules switched off', n; end if;
end $$;
