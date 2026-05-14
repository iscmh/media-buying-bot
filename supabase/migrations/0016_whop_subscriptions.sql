-- Phase 8: Whop-backed subscriptions + application-gated access.
--
-- Adds:
--   * applications — richer-than-Phase-7-waitlist intake. /apply form
--     posts here. Admin approves to generate an invite code + Whop
--     checkout link.
--   * subscriptions — synced from Whop webhook events. user_id is
--     NULLABLE because a Whop membership_went_valid event can arrive
--     before the user has signed up (Whop checkout doesn't require
--     our auth). Reconciliation: the auth.users INSERT trigger now
--     also links any subscription row whose pending_email matches
--     the new user's email.
--   * entitlements — ad_account_slots quota. Phase 8 Meta-connect
--     server action checks this before allowing a 2nd+ ad account.
--   * whop_events — every incoming webhook lands here (signature
--     verified or not). Unique on whop_event_id for idempotency.
--
-- Idempotent.

-- =========================================================================
-- 1. applications
-- =========================================================================
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  agency_name text,
  -- Free-form so we can change the ranges later without a migration.
  monthly_ad_spend_usd text,
  -- Comma-separated chip selection.
  verticals text,
  why_apply text,
  heard_from text,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'paid')),
  approved_at timestamptz,
  approved_by uuid references public.users(id) on delete set null,
  invite_code_id uuid references public.invite_codes(id) on delete set null,
  whop_checkout_url text,
  whop_product_id text,
  paid_at timestamptz,
  rejected_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_applications_status_created
  on public.applications(status, created_at desc);
-- Per-email lookups (paid? approved? pending?) in the webhook + admin.
create index if not exists idx_applications_email on public.applications(lower(email));

drop trigger if exists set_updated_at on public.applications;
create trigger set_updated_at
  before update on public.applications
  for each row execute function public.tg_set_updated_at();

alter table public.applications enable row level security;

drop policy if exists applications_admin_all on public.applications;
create policy applications_admin_all on public.applications
  for all using (public.is_admin()) with check (public.is_admin());

-- Public can insert (anyone can apply, no auth required).
drop policy if exists applications_insert_public on public.applications;
create policy applications_insert_public on public.applications
  for insert with check (true);

-- =========================================================================
-- 2. subscriptions (synced from Whop)
-- =========================================================================
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- NULLABLE: can be created from a webhook before the user has signed
  -- up. Reconciled in the auth.users INSERT trigger when the new
  -- user's email matches pending_email.
  user_id uuid references public.users(id) on delete cascade,
  pending_email text,

  whop_membership_id text not null unique,
  whop_user_id text,
  whop_product_id text not null,

  plan_tier text not null check (plan_tier in ('monthly', 'annual', 'lifetime')),
  status text not null check (status in ('active', 'past_due', 'canceled', 'expired')),

  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,

  -- invite_code_id (if any) the user redeemed when paying. Lets the
  -- audit trail tie a payment back to an admin-issued invite.
  invite_code_id uuid references public.invite_codes(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user_status
  on public.subscriptions(user_id, status);
create index if not exists idx_subscriptions_pending_email
  on public.subscriptions(lower(pending_email))
  where pending_email is not null and user_id is null;

drop trigger if exists set_updated_at on public.subscriptions;
create trigger set_updated_at
  before update on public.subscriptions
  for each row execute function public.tg_set_updated_at();

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- 3. entitlements — ad account slots (+ future addons)
-- =========================================================================
create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  ad_account_slots integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

drop trigger if exists set_updated_at on public.entitlements;
create trigger set_updated_at
  before update on public.entitlements
  for each row execute function public.tg_set_updated_at();

alter table public.entitlements enable row level security;

drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- 4. whop_events audit log
-- =========================================================================
create table if not exists public.whop_events (
  id uuid primary key default gen_random_uuid(),
  whop_event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  signature_valid boolean not null,
  processed_at timestamptz,
  error_message text,
  received_at timestamptz not null default now()
);

create index if not exists idx_whop_events_received
  on public.whop_events(received_at desc);
create index if not exists idx_whop_events_unprocessed
  on public.whop_events(received_at) where processed_at is null;

-- =========================================================================
-- 5. Extend auth.users INSERT trigger to also reconcile pending
--    subscriptions (rows where user_id IS NULL and pending_email
--    matches the new user). Phase 7's trigger already redeems invite
--    codes + flips founding-member; we keep that body and append the
--    sub-link block.
-- =========================================================================
create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_id_str text;
  invite_id uuid;
  code_row record;
  is_eligible boolean;
  new_email_lc text;
begin
  invite_id_str := new.raw_user_meta_data->>'invite_code_id';

  if invite_id_str is not null and length(invite_id_str) > 0 then
    invite_id := invite_id_str::uuid;
    select * into code_row from public.invite_codes where id = invite_id for update;
    if code_row.id is null then
      raise exception 'invite_code_not_found';
    end if;
    if code_row.revoked_at is not null then
      raise exception 'invite_code_revoked';
    end if;
    if code_row.expires_at <= now() then
      raise exception 'invite_code_expired';
    end if;
    if code_row.use_count >= code_row.max_uses then
      raise exception 'invite_code_fully_used';
    end if;

    update public.invite_codes
       set use_count = use_count + 1
     where id = invite_id;
  end if;

  insert into public.users (id, email, full_name, signed_up_via_invite_code_id)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    invite_id
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;

  select public.check_founding_member_eligibility() into is_eligible;
  if is_eligible then
    update public.user_settings
       set is_founding_member = true
     where user_id = new.id;
  end if;

  -- Phase 8: reconcile any pending subscriptions whose webhook arrived
  -- before this user signed up (paid first, signed up second).
  new_email_lc := lower(coalesce(new.email, ''));
  if length(new_email_lc) > 0 then
    update public.subscriptions
       set user_id = new.id,
           pending_email = null
     where user_id is null
       and lower(pending_email) = new_email_lc;
  end if;

  return new;
end;
$$;

drop trigger if exists handle_new_auth_user on auth.users;
create trigger handle_new_auth_user
after insert on auth.users
for each row execute function public.tg_handle_new_auth_user();
