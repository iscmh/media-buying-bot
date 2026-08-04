-- Polish-25.10 Commit 59: public API surface for the Scale tier.
--
-- api_keys stores hashed secrets — the plaintext is shown to the
-- operator exactly ONCE at create time (the "You won't see this
-- again" flow). We store SHA-256(key) so a DB dump can't be used to
-- impersonate a user, and store the first 8 chars in `key_prefix` so
-- the /settings/api list can identify a row without decrypting.
--
-- Auth model: Authorization: Bearer sk_live_XXXXXXXX. The route
-- helper (apps/web/lib/api-auth.ts) hashes the presented token,
-- looks up the row by hash, and rejects if revoked_at is non-null.
-- last_used_at is stamped best-effort on every authenticated request.

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists api_keys_user_id_idx on api_keys (user_id);
create index if not exists api_keys_key_hash_idx on api_keys (key_hash);
create index if not exists api_keys_active_idx
  on api_keys (user_id, created_at desc)
  where revoked_at is null;

alter table api_keys enable row level security;

-- Users see their own keys; admins see all. Insert / update / delete
-- all go through server-side actions with service-role, so no
-- corresponding INSERT/UPDATE/DELETE policies for the anon client.
create policy api_keys_select_own on api_keys for
select
  using (
    user_id = auth.uid ()
    or exists (
      select
        1
      from
        public.users u
      where
        u.id = auth.uid ()
        and u.role = 'admin'
    )
  );

comment on table api_keys is
  'Polish-25.10 Commit 59: public API bearer tokens. key_hash is SHA-256(plaintext); plaintext returned to operator ONCE at create.';
comment on column api_keys.key_prefix is
  'First 8 chars of the plaintext key (post-sk_live_ prefix) for identification in the list UI without decrypting.';
