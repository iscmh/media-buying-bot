import { sql } from 'drizzle-orm';
import { getDb } from '../client';

/**
 * Column-level encryption helpers backed by pgcrypto + Supabase Vault.
 *
 * Supabase Vault holds the master key (`vault.secrets`); we look it up by
 * id (env: SUPABASE_VAULT_KEY_ID) and pass it to pgp_sym_encrypt /
 * pgp_sym_decrypt. Plaintext NEVER leaves these two functions.
 *
 * Migration: see supabase/migrations/0002_vault.sql for vault.secrets seed
 * + helper view `vault_master_key_v` that surfaces the decoded master key.
 */

function vaultKeyId(): string {
  return process.env.SUPABASE_VAULT_KEY_ID ?? 'mbb_master_key_v1';
}

/** Encrypt a UTF-8 string. Returns ASCII-armored ciphertext safe for `text` cols. */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (plaintext === '') {
    throw new Error('encryptSecret: refusing to encrypt empty string');
  }
  const db = getDb();
  const keyId = vaultKeyId();
  const rows = await db.execute<{ ciphertext: string }>(sql`
    SELECT armor(
      pgp_sym_encrypt(
        ${plaintext}::text,
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ${keyId})
      )
    ) AS ciphertext
  `);
  const row = rows[0];
  if (!row?.ciphertext) {
    throw new Error(`encryptSecret: vault key "${keyId}" not found or returned no ciphertext`);
  }
  return row.ciphertext;
}

/** Decrypt ASCII-armored ciphertext. Throws if key missing or ciphertext invalid. */
export async function decryptSecret(ciphertext: string): Promise<string> {
  const db = getDb();
  const keyId = vaultKeyId();
  const rows = await db.execute<{ plaintext: string }>(sql`
    SELECT pgp_sym_decrypt(
      dearmor(${ciphertext}),
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ${keyId})
    ) AS plaintext
  `);
  const row = rows[0];
  if (!row?.plaintext) {
    throw new Error(`decryptSecret: failed (key "${keyId}" missing or ciphertext malformed)`);
  }
  return row.plaintext;
}
