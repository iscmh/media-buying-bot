import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // Multi-tenant isolation tests need a real Postgres. CI sets these.
    // Local: use a Supabase local instance (`supabase start`) and copy the
    // connection string from the output into TEST_DATABASE_URL.
  },
});
