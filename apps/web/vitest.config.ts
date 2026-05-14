import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for apps/web.
 *
 * Two aliases:
 *   server-only → empty stub. The directive's purpose is to block
 *     server-only modules from sneaking into client bundles at build
 *     time; in tests we run the modules directly, so we no-op the
 *     import.
 *   @/* → repo root so the tests can use the same paths Next.js does.
 */
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
    exclude: ['node_modules', '.next'],
  },
});
