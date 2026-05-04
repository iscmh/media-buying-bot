import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Side-effect import that loads `.env` from the repo root in dev only.
 * Production (Railway) gets env vars injected by the platform — dotenv is
 * a no-op there.
 *
 * MUST be imported FIRST in apps/bot/src/index.ts. ESM evaluates side-effect
 * imports in source order, so as long as this comes before any module that
 * reads process.env at top level (like @mbb/shared/env's parseEnv), it
 * works.
 *
 * Reads from `<repo-root>/.env`. We compute the path relative to THIS file
 * (not process.cwd()) so the loader works regardless of where you launched
 * `pnpm dev` from.
 */
if (process.env.NODE_ENV !== 'production') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ → apps/bot/ → apps/ → repo-root
  const rootEnv = path.resolve(here, '..', '..', '..', '.env');
  dotenv.config({ path: rootEnv });
}
