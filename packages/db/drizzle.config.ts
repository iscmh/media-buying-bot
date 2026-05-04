import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error(
    'DATABASE_URL is required to run drizzle-kit. Copy .env.example → .env at repo root.',
  );
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: dbUrl },
  // RLS policies, Vault setup, and triggers live in supabase/migrations/.
  // Drizzle handles tables/columns/indexes; Supabase CLI handles Postgres-native features.
  verbose: true,
  strict: true,
});
