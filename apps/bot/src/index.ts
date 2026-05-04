import './load-env'; // MUST be first — populates process.env in dev
import * as Sentry from '@sentry/node';
import { parseEnv, TelegramEnvSchema } from '@mbb/shared/env';
import { createBot } from './bot';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

const env = parseEnv(TelegramEnvSchema, process.env);
const bot = createBot(env.TELEGRAM_BOT_TOKEN);

// Long-polling for local dev. Production deploys (Railway) use webhook mode
// — see Phase 2 for webhook setup.
async function main() {
  console.info(`[bot] starting as @${env.TELEGRAM_BOT_USERNAME}`);
  console.info(`[bot] BOT_DRY_RUN=${process.env.BOT_DRY_RUN ?? 'true'}`);
  await bot.start({
    onStart: (info) => console.info(`[bot] @${info.username} polling for updates`),
  });
}

main().catch((err) => {
  console.error('[bot] fatal', err);
  Sentry.captureException(err);
  process.exit(1);
});
