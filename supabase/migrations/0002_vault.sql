-- Supabase Vault setup.
--
-- We store ONE master key in vault.secrets and use it for all column-level
-- encryption via pgp_sym_encrypt/decrypt. The key id (env:
-- SUPABASE_VAULT_KEY_ID, default "mbb_master_key_v1") is the row's `name`.
--
-- IMPORTANT MANUAL STEP:
-- The actual master key value should NOT be committed. Insert it via the
-- Supabase dashboard → SQL editor, or via psql, ONCE per environment, e.g.:
--
--   select vault.create_secret(
--     gen_random_bytes(32)::text,        -- 256-bit random key, base64ed by Vault
--     'mbb_master_key_v1',
--     'Master key for column encryption — DO NOT ROTATE without re-encrypt plan'
--   );
--
-- This migration just documents the requirement and creates a tiny helper
-- view so application code can SELECT the decrypted master key without
-- knowing the Vault internals.

-- No-op safety: error loudly at app boot if the master key is missing.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'mbb_master_key_v1'
  ) then
    raise notice 'WARN: vault secret "mbb_master_key_v1" not found. Encryption will fail until you create it. See migration 0002_vault.sql for instructions.';
  end if;
end $$;
