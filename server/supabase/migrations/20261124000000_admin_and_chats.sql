-- Riyeser admin page and "Message us" chats.

-- What each price costs, so the admin page can show monthly recurring revenue (cents, before tax).
alter table public.prices add column amount bigint, add column currency text default 'AUD';

-- ---------- chats ----------
-- One conversation per question. Customers write from Riyeser Central; staff answer from the admin page.
-- Internal notes (internal = true) are staff-only and never shown to the customer.
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  subject text not null default 'Question' check (length(subject) <= 120),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unread_staff boolean not null default true,
  unread_customer boolean not null default false
);
create index on public.conversations (account_id);
create index on public.conversations (status, last_message_at desc);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  author uuid references public.accounts (id) on delete set null,
  from_staff boolean not null default false,
  internal boolean not null default false,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index on public.messages (conversation_id, id);

-- Customers can't pretend to be staff: from_staff / internal are set here from who is writing.
create or replace function public.messages_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author := auth.uid();
  if not public.is_admin() then
    new.from_staff := false; new.internal := false;
  else
    new.from_staff := true;
  end if;
  new.created_at := now();
  return new;
end $$;
create trigger messages_before_insert before insert on public.messages for each row execute function public.messages_before_insert();

create or replace function public.messages_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set
    last_message_at = new.created_at,
    status = case when new.internal then status else 'open' end,
    unread_staff = case when new.from_staff then unread_staff else true end,
    unread_customer = case when new.from_staff and not new.internal then true else unread_customer end
  where id = new.conversation_id;
  return new;
end $$;
create trigger messages_after_insert after insert on public.messages for each row execute function public.messages_after_insert();

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy "own or admin" on public.conversations for select using (account_id = auth.uid() or public.is_admin());
create policy "start own" on public.conversations for insert with check (account_id = auth.uid());
create policy "admin updates" on public.conversations for update using (public.is_admin()) with check (public.is_admin());
create policy "customer marks read" on public.conversations for update using (account_id = auth.uid()) with check (account_id = auth.uid());

create policy "own (not internal) or admin" on public.messages for select using (
  public.is_admin() or (not internal and exists (select 1 from public.conversations c where c.id = conversation_id and c.account_id = auth.uid())));
create policy "write to own or admin" on public.messages for insert with check (
  public.is_admin() or exists (select 1 from public.conversations c where c.id = conversation_id and c.account_id = auth.uid()));

-- A customer may only flip their own unread flag, nothing else on the conversation.
create or replace function public.conversations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- pg_trigger_depth() > 1: the update comes from messages_after_insert (a new message), which is allowed
  if not public.is_admin() and pg_trigger_depth() = 1 then
    if new.account_id <> old.account_id or new.subject <> old.subject or new.status <> old.status
       or new.unread_staff <> old.unread_staff or new.last_message_at <> old.last_message_at then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;
create trigger conversations_guard before update on public.conversations for each row execute function public.conversations_guard();

-- ---------- the admin page ----------
-- One call returns everything the dashboard shows. Only admins may call it.
create or replace function public.admin_dashboard(days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  caps jsonb := coalesce((select value from settings where key = 'caps'), '{}');
  warn numeric := coalesce((caps ->> 'warnAt')::numeric, 0.8);
  result jsonb;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;

  with live as (   -- subscriptions that are paying now
    select s.*, item from subscriptions s, jsonb_array_elements(s.items) item
    where s.status in ('active', 'trialing', 'past_due')
  ), mrr as (
    select coalesce(sum(case when p.interval = 'year' then p.amount * (item ->> 'quantity')::int / 12.0
                             else p.amount * (item ->> 'quantity')::int end), 0)::bigint as cents
    from live join prices p on p.paddle_price_id = item ->> 'price'
  ), paid_products as (
    select account_id, item ->> 'product' as product from live
  ), usage as (    -- each account's highest count across its PCs
    select d.account_id, a.email, k.key as what, max((k.value)::int) as used
    from devices d join accounts a on a.id = d.account_id, jsonb_each_text(d.usage) k
    group by d.account_id, a.email, k.key
  ), near as (
    select u.email, u.what, u.used, (caps ->> c.cap)::int as cap
    from usage u
    join (values ('invoices', 'basic', 'basics'), ('pos_sales', 'pos', 'pos'), ('pay_runs', 'payroll', 'payroll'), ('projects', 'asbuilt', 'asbuilt')) c(what, cap, product)
      on c.what = u.what
    where (caps ->> c.cap) is not null and u.used >= warn * (caps ->> c.cap)::int
      and not exists (select 1 from paid_products pp where pp.account_id = u.account_id
                      and (pp.product = c.product or (c.product = 'basics' and pp.product = 'plus')))
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'kpis', jsonb_build_object(
      'mrrCents', (select cents from mrr),
      'paying', (select count(distinct account_id) from live),
      'accounts', (select count(*) from accounts),
      'signups', (select count(*) from accounts where created_at > now() - make_interval(days => days)),
      'activePcs', (select count(*) from devices where last_seen > now() - interval '7 days'),
      'pastDue', (select count(*) from subscriptions where status = 'past_due'),
      'openChats', (select count(*) from conversations where status = 'open'),
      'unreadChats', (select count(*) from conversations where unread_staff)),
    'signupsByDay', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'n', (select count(*) from accounts where created_at::date = d::date)) order by d), '[]')
                     from generate_series(current_date - (days - 1), current_date, interval '1 day') d),
    'revenueByMonth', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                         'cents', (select coalesce(sum(total - tax), 0) from payments where status in ('completed', 'paid') and date_trunc('month', billed_at) = m))
                         order by m), '[]')
                       from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m),
    'renewalsDue', (select coalesce(jsonb_agg(x order by x ->> 'at'), '[]') from (
                      select jsonb_build_object('email', a.email, 'at', s.period_ends_at, 'items', s.items, 'cancelling', s.cancel_at is not null) x
                      from subscriptions s join accounts a on a.id = s.account_id
                      where s.status in ('active', 'trialing') and s.period_ends_at between now() and now() + interval '14 days') r),
    'pastDueList', (select coalesce(jsonb_agg(jsonb_build_object('email', a.email, 'since', s.updated_at, 'items', s.items)), '[]')
                    from subscriptions s join accounts a on a.id = s.account_id where s.status = 'past_due'),
    'recentPayments', (select coalesce(jsonb_agg(x), '[]') from (
                         select jsonb_build_object('email', a.email, 'total', p.total, 'currency', p.currency, 'status', p.status, 'origin', p.origin, 'at', p.billed_at) x
                         from payments p left join accounts a on a.id = p.account_id order by p.billed_at desc nulls last limit 15) r),
    'nearCap', (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'what', what, 'used', used, 'cap', cap) order by used::numeric / cap desc), '[]') from near),
    'versions', (select coalesce(jsonb_object_agg(v.key, v.n), '{}') from (
                   select k.key || ' ' || k.value as key, count(*) as n from devices d, jsonb_each_text(d.versions) k
                   where d.last_seen > now() - interval '30 days' group by 1) v)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_dashboard(int) from public, anon;
grant execute on function public.admin_dashboard(int) to authenticated;
