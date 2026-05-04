import { z } from 'zod';

/**
 * Centralized env validation. Each app/package imports the slice it needs.
 * Fail-fast at boot — a missing prod env var should crash the process, not
 * surface as a runtime null deref.
 */

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

export const SupabaseEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  SUPABASE_VAULT_KEY_ID: z.string().min(1).default('mbb_master_key_v1'),
});

export const SafetyEnvSchema = z.object({
  BOT_DRY_RUN: boolish.default(true),
  PLATFORM_DAILY_SPEND_CEILING_USD: z.coerce.number().positive().default(500),
  META_RATE_LIMIT_INTERNAL_CAP_PCT: z.coerce.number().min(1).max(100).default(60),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
});

export const TelegramEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
});

export const InngestEnvSchema = z.object({
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),
});

export const SentryEnvSchema = z.object({
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
});

export const ResendEnvSchema = z.object({
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
});

/** Parse a slice of process.env, throwing a helpful error on failure. */
export function parseEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
