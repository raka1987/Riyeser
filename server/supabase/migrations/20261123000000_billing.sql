-- Riyeser accounts, subscriptions and payments.
-- Customers sign in to Riyeser Central with their email (Supabase Auth, one-time code).
-- Paddle tells us about payments through the paddle-webhook function; nobody updates these tables by hand.
-- The apps only ever send counts and version numbers (devices), never invoices, names or other business data.

create table public.accounts (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  paddle_customer_id text unique,
  country text,
  note text,                                  -- staff note, shown on the admin page only
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table public.devices (
  account_id uuid not null references public.accounts (id) on delete cascade,
  id text not null,                           -- random id Central makes once per PC
  name text,
  os text,
  versions jsonb not null default '{}',       -- { "central": "1.4.0", "accounting": "2.1.0" }
  usage jsonb not null default '{}',          -- { "invoices": 37, "pos_sales": 120 } counts only
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (account_id, id)
);

-- Which Paddle price is which program. Filled in once the products exist in Paddle.
create table public.prices (
  paddle_price_id text primary key,
  product text not null check (product in ('basics', 'plus', 'pos', 'payroll', 'asbuilt', 'extra_user', 'extra_company')),
  label text,
  interval text check (interval in ('month', 'year'))
);

create table public.subscriptions (
  id text primary key,                        -- Paddle subscription id (sub_...)
  account_id uuid references public.accounts (id) on delete set null,
  customer_id text,
  status text not null,                       -- active | trialing | past_due | paused | canceled
  items jsonb not null default '[]',          -- [{ product, price, quantity }]
  period_ends_at timestamptz,
  cancel_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.subscriptions (account_id);
create index on public.subscriptions (customer_id);

create table public.payments (
  id text primary key,                        -- Paddle transaction id (txn_...)
  account_id uuid references public.accounts (id) on delete set null,
  customer_id text,
  subscription_id text,
  status text not null,
  total bigint not null default 0,            -- cents, including tax
  tax bigint not null default 0,
  currency text,
  origin text,                                -- web (first purchase) | subscription_recurring (renewal) | ...
  billed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.payments (account_id);
create index on public.payments (billed_at);

-- Every webhook exactly as Paddle sent it, so nothing is ever lost and a repeat is ignored.
create table public.webhook_events (
  id text primary key,                        -- Paddle event id (evt_...)
  type text not null,
  occurred_at timestamptz,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create table public.settings (
  key text primary key,
  value jsonb not null
);
insert into public.settings (key, value) values
  ('caps', '{"basic": 50, "pos": 500, "payroll": 4, "asbuilt": 3, "plusTrialDays": 90, "warnAt": 0.8}');

create table public.admins (
  account_id uuid primary key references public.accounts (id) on delete cascade
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where account_id = auth.uid());
$$;

-- Row level security: a customer sees only their own rows; admins see everything.
-- The functions use the service role key, which skips these rules.
alter table public.accounts enable row level security;
alter table public.devices enable row level security;
alter table public.prices enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.settings enable row level security;
alter table public.admins enable row level security;

create policy "own or admin" on public.accounts for select using (id = auth.uid() or public.is_admin());
create policy "own or admin" on public.devices for select using (account_id = auth.uid() or public.is_admin());
create policy "own or admin" on public.subscriptions for select using (account_id = auth.uid() or public.is_admin());
create policy "own or admin" on public.payments for select using (account_id = auth.uid() or public.is_admin());
create policy "anyone" on public.prices for select using (true);
create policy "anyone" on public.settings for select using (true);
create policy "admin" on public.webhook_events for select using (public.is_admin());
create policy "admin" on public.admins for select using (public.is_admin());
create policy "admin note" on public.accounts for update using (public.is_admin()) with check (public.is_admin());
create policy "admin" on public.settings for update using (public.is_admin()) with check (public.is_admin());
create policy "admin" on public.prices for all using (public.is_admin()) with check (public.is_admin());
