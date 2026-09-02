-- Polish-29.0.0 Commit 109: credit-system schema.
--
-- Four tables:
--   credits_balance      — hot cache of live spendable balance
--   credit_transactions  — append-only audit log
--   credit_reservations  — holds credits during in-flight jobs
--   fraud_signals        — velocity + anomaly tracking
--
-- RLS: every table is user-scoped. Users read only their own rows.
-- All writes go through service-role via server actions / workers
-- (auto-topup, spend on generation success, refund on failure,
-- fraud dashboard), so no INSERT / UPDATE / DELETE policies for
-- the anon client — the service role bypasses RLS anyway.

-- ============================================================
-- credits_balance
-- ============================================================
create table if not exists credits_balance (
  user_id uuid primary key references public.users (id) on delete cascade,
  balance integer not null default 0,
  lifetime_purchased integer not null default 0,
  lifetime_spent integer not null default 0,
  auto_topup_enabled text not null default 'false',
  auto_topup_pack_sku text,
  updated_at timestamptz not null default now(),
  constraint credits_balance_nonneg check (balance >= 0)
);

alter table credits_balance enable row level security;

create policy credits_balance_select_own on credits_balance for
select
  using (
    user_id = auth.uid ()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid () and u.role = 'admin'
    )
  );

comment on table credits_balance is
  'Polish-29.0.0 Commit 109: live spendable credit balance per user. Sum(credit_transactions.delta) is authoritative; this is a hot cache.';
comment on constraint credits_balance_nonneg on credits_balance is
  'Balance can never go negative. Worker rejects a reservation that would drop it below 0.';

-- ============================================================
-- credit_transactions
-- ============================================================
create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.users (id) on delete cascade,
  delta integer not null,
  type text not null,
  ref_id text,
  description text,
  balance_after integer not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint credit_tx_type_valid check (
    type in (
      'signup_trial',
      'purchase',
      'sub_monthly_topup',
      'sub_bonus',
      'spend',
      'refund_on_fail',
      'admin_adjust',
      'chargeback_reverse'
    )
  )
);

create index if not exists credit_tx_user_created_idx
  on credit_transactions (user_id, created_at desc);
create index if not exists credit_tx_type_idx
  on credit_transactions (type);

alter table credit_transactions enable row level security;

create policy credit_tx_select_own on credit_transactions for
select
  using (
    user_id = auth.uid ()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid () and u.role = 'admin'
    )
  );

comment on table credit_transactions is
  'Polish-29.0.0 Commit 109: append-only credit ledger. Sum(delta) per user = credits_balance.balance.';

-- ============================================================
-- credit_reservations
-- ============================================================
create table if not exists credit_reservations (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.users (id) on delete cascade,
  generation_job_id uuid,
  credits integer not null,
  model_id text not null,
  expires_at timestamptz not null,
  released_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  constraint credit_res_credits_positive check (credits > 0),
  constraint credit_res_resolution_valid check (
    resolution is null
    or resolution in ('consumed', 'released', 'expired')
  ),
  constraint credit_res_release_shape check (
    (released_at is null and resolution is null)
    or (released_at is not null and resolution is not null)
  )
);

create index if not exists credit_res_user_active_idx
  on credit_reservations (user_id, released_at);
create index if not exists credit_res_expires_idx
  on credit_reservations (expires_at)
  where released_at is null;

alter table credit_reservations enable row level security;

create policy credit_res_select_own on credit_reservations for
select
  using (
    user_id = auth.uid ()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid () and u.role = 'admin'
    )
  );

comment on table credit_reservations is
  'Polish-29.0.0 Commit 109: credit holds during in-flight generation jobs. Auto-expires at 30min so a crashed worker never traps credits.';
comment on constraint credit_res_release_shape on credit_reservations is
  'released_at and resolution must be set together — either both null (still active) or both non-null (resolved).';

-- ============================================================
-- fraud_signals
-- ============================================================
create table if not exists fraud_signals (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.users (id) on delete cascade,
  event_type text not null,
  amount_usd_cents integer,
  credits integer,
  ip text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint fraud_event_type_valid check (
    event_type in (
      'credit_purchase',
      'credit_spend',
      'chargeback',
      'signup',
      'ip_anomaly',
      'admin_freeze'
    )
  )
);

create index if not exists fraud_user_event_created_idx
  on fraud_signals (user_id, event_type, created_at desc);

alter table fraud_signals enable row level security;

-- Users don't see their own fraud signals — admin-only. Prevents a
-- shady user from checking whether they've been flagged before
-- refunding + rotating.
create policy fraud_admin_only on fraud_signals for
select
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid () and u.role = 'admin'
    )
  );

comment on table fraud_signals is
  'Polish-29.0.0 Commit 109: velocity + anomaly signals for the fraud dashboard. Admin-only reads — flagged users must not see their own signals.';
