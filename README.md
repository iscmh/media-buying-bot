# Media Buying Bot

Multi-tenant media buying automation SaaS. Auto-generates, launches, kills, and scales Meta ad creative on behalf of paying customers.

**Status:** Phase 1 scaffold (no business logic yet, no billing). MVP is free for founding members; Stripe lands in Phase 8.

---

## Architecture

```
+--------------------+        +--------------------+
|  apps/web          |        |  apps/bot          |
|  Next.js 14 (App)  |        |  grammY Telegram   |
|  Tailwind, shadcn  |        |  long-poll / webhook
|  Supabase Auth     |        +---------+----------+
+---------+----------+                  |
          |                             |
          | (RLS-scoped via JWT)        | (server-side, service-role)
          v                             v
       +-----------------------------------------+
       | Supabase Postgres (single multi-tenant) |
       |  - RLS on every table                   |
       |  - pgcrypto + Vault for column encrypt  |
       |  - Drizzle owns app schema              |
       |  - Supabase CLI owns RLS/Vault/triggers |
       +-----------------------------------------+
                         ^
                         |
       +-----------------+------------------+
       | packages/jobs (Inngest functions)  |
       |  - meta-ad-launcher                |
       |  - performance-poller              |
       |  - kill-scale-evaluator            |
       |  - generation-job-processor        |
       |  - daily-summary-generator         |
       |  - telegram-notifier               |
       |  - token-expiry-checker            |
       |  - suspicious-activity-monitor     |
       +------------------------------------+

Every Meta API mutation flows through:
  packages/meta-api/callMeta()
    → checkSpendSafety (kill-switches + ceiling)
    → reserveRateLimitSlot
    → if BOT_DRY_RUN: log intent, return early
    → fetch (Phase 4 only)
    → logMetaApiCall (always)
```

### Repo layout

```
media-buying-bot/
├─ apps/
│  ├─ web/                Next.js 14 web app (Vercel)
│  └─ bot/                grammY Telegram bot (Railway)
├─ packages/
│  ├─ shared/             zod schemas, env validation, shared types
│  ├─ db/                 Drizzle schema, queries, safety layer, encryption
│  ├─ ai-providers/       AI-provider clients + kie.ai video pipeline (Polish-20)
│  ├─ meta-api/           Meta Graph API wrapper (rate limit + audit + safety)
│  └─ jobs/               Inngest function definitions
├─ supabase/
│  ├─ migrations/         RLS policies, Vault, triggers, indexes
│  ├─ config.toml
│  └─ seed.sql
└─ .github/workflows/ci.yml
```

---

## UGC video generation (Polish-20)

UGC ads run through a single unified worker
(`packages/jobs/src/functions/generate-video-variant.ts`) driven by
the descriptor layer in `packages/shared/src/video-models.ts`. The
form's mandatory model picker is the only routing signal — the
worker reads `job.metadata.model_id + provider_id` and looks up the
`ModelProviderConfig` (endpoint, per-field wire format, per-second
cost). No pipeline enum, no format switch, no per-model client.

### Launch model set

| Model              | Tier        | Per-sec (kie.ai) | Per-call cap | Notes                                                                             |
| ------------------ | ----------- | ---------------- | ------------ | --------------------------------------------------------------------------------- |
| Seedance 1.5 Pro   | Budget      | $0.035           | 12s (step 2) | `bytedance/seedance-1.5-pro`, `fixed_lens: true`                                  |
| Kling 3.0 Standard | Recommended | $0.10            | 15s          | `kling-3.0/video`, `mode: 'std'`, `multi_shots: false`, duration is a STRING enum |
| Seedance 2 (Pro)   | Premium     | $0.33            | 15s          | `bytedance/seedance-2`, `resolution: '720p'`                                      |

Duration presets on the simplified form: 8s / 15s / 30s / 60s.
Sources above each model's per-call cap chunk into segments and
stitch via the Polish-19.3 Replicate ffmpeg-concat helper.

### BYOK requirements

- **Tool connections** (`tool_connections` table) — three keys required:
  - `claude` — Claude ad-spec script writer
  - `gemini` — Gemini Vision one-shot source analysis (Polish-12)
  - `kie_ai` — kie.ai video generation (all three launch models)
- **AI provider connections** (`ai_provider_connections` table) —
  optional cards for the legacy survivors (HeyGen avatar / Sora 2 /
  Nano Banana image), unrelated to the UGC video path.

Set all three tool keys at `/connections/tools`. The form's Generate
button stays disabled with a "connect kie.ai" nudge until the
`kie_ai` slot is populated.

### Multi-provider expansion (Polish-21+)

`packages/shared/src/video-models.ts` ships four provider entries
(kie_ai / fal_ai / wavespeed / atlas_cloud) with only `kie_ai` flipped
`liveAtLaunch: true`. Adding a new provider is a new client file +
new `ModelProviderConfig` entry + flip the flag — no architectural
change to the worker or form.

---

## Anti-ban guardrails (non-negotiable)

| #   | Layer                                 | Where it lives                                               |
| --- | ------------------------------------- | ------------------------------------------------------------ |
| 1   | Rate limiter (60% of 200/hr per user) | `packages/db/src/safety/rate-limiter.ts`                     |
| 2   | Pattern-of-use staggering             | `packages/meta-api` (Phase 4)                                |
| 3   | Suspicious-activity auto-pause        | `packages/jobs/src/functions/suspicious-activity-monitor.ts` |
| 4   | Platform spend ceiling above user cap | `packages/db/src/safety/spend-safety.ts`                     |
| 5   | Pre-launch compliance checks          | `packages/meta-api` (Phase 4)                                |
| 6   | Audit log on every Meta call          | `packages/db/src/meta-api-log.ts`                            |
| 7   | Per-user + global kill switches       | `packages/db/src/safety/kill-switches.ts`                    |
| 8   | Dry-run mode                          | `BOT_DRY_RUN` env, enforced in `callMeta`                    |
| 9   | Liability ToS                         | `apps/web/app/legal/tos/page.tsx` (placeholder)              |
| 10  | Onboarding risk education             | Phase 2 onboarding wizard                                    |

`callMeta()` is the only allowed entry point for Meta Graph calls. Any direct `fetch('https://graph.facebook.com/...')` is a code review block.

---

## Local setup

### Prerequisites

- Node 20 LTS (use `nvm use`)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- Docker (for `supabase start`)
- Supabase CLI (`brew install supabase/tap/supabase`)

### First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env template
cp .env.example .env
cp .env.example apps/web/.env.local
cp .env.example apps/bot/.env

# 3. Start local Supabase (Postgres + Auth + Storage)
supabase start
# Copy the connection string and anon key into your .env files.

# 4. Push Drizzle schema (creates tables)
pnpm db:push

# 5. Apply Supabase migrations (RLS, Vault, triggers, indexes)
supabase db push

# 6. Seed local-dev rows
psql "$DATABASE_URL" -f supabase/seed.sql
```

### Daily commands

```bash
pnpm dev               # runs web + bot in parallel
pnpm --filter @mbb/web dev   # web only
pnpm --filter @mbb/bot dev   # bot only

pnpm typecheck         # all packages
pnpm lint              # all packages
pnpm test              # all packages
pnpm format            # prettier write

pnpm db:generate       # generate Drizzle migration from schema diff
pnpm db:push           # push schema to local DB
pnpm db:studio         # Drizzle Studio
```

---

## Manual setup checklist (Phase 1 → Phase 2)

You need to provision these external services before Phase 2 can ship onboarding flows. Each is a placeholder in `.env.example` today.

1. **GitHub repo** ✓ (`iscmh/media-buying-bot` already exists; this branch is `claude/setup-multitenant-saas-mvp-OssDw`).
2. **Supabase project** — Create at <https://supabase.com/dashboard>. Then:
   - Settings → API → copy `URL`, `anon key`, `service_role key`
   - Settings → Database → copy "Session pooler" connection string into `DATABASE_URL`
   - Authentication → Providers → enable Google (paste Google OAuth credentials, see #8)
   - SQL editor → run `select vault.create_secret(gen_random_bytes(32)::text, 'mbb_master_key_v1', 'master key for column encryption');` once
   - Run `supabase db push` from your local machine to apply our migrations
3. **Telegram bot** — Open @BotFather in Telegram → `/newbot` → save the token + username.
4. **Inngest** — Sign up at <https://app.inngest.com>. Create app "media-buying-bot". Copy event key + signing key.
5. **Sentry** — Sign up at <https://sentry.io>. Create projects: `media-buying-bot-web`, `media-buying-bot-bot`. Copy DSN + auth token.
6. **Resend** — Sign up at <https://resend.com>. Verify your sending domain. Copy API key.
7. **Vercel** — Import this GitHub repo. Configure env vars (paste from `.env.example` filled in). Add the domain.
8. **Google OAuth** — In Google Cloud Console → APIs & Services → Credentials → "OAuth client ID" → Web application. Add `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback` as authorized redirect. Paste the client id + secret into Supabase Auth → Providers → Google.
9. **Railway** (for the bot service) — Create a new service from the GitHub repo. Set root directory to `apps/bot`. Configure env vars. Add `pnpm start` as the start command.

After every value is filled in, the smoke test for Phase 1 is:

```bash
curl https://YOUR-VERCEL-DOMAIN/api/health
# → { ok: true, service: 'web', dryRun: true, timestamp: '...' }
```

`BOT_DRY_RUN=true` should remain set everywhere until Phase 4 — there is intentionally no live Meta API path yet.

---

## Roadmap (full)

| Phase | Scope                                                                                         | Status |
| ----- | --------------------------------------------------------------------------------------------- | ------ |
| 1     | Monorepo scaffold, schema, safety layer, empty pages, kill switches                           | ✓      |
| 2     | BYO Meta token onboarding, TG link flow, AI provider connect, settings UI, ToS signing        | next   |
| 3     | Concept upload, unified video-variant pipeline (Seedance / Kling 3.0 / Seedance 2 via kie.ai) |        |
| 4     | Auto-launch to Meta, retry logic, pre-launch compliance, pattern-of-use staggering            |        |
| 5     | Performance polling, kill/scale logic, TG approval flows, suspicious-activity monitor         |        |
| 6     | Dashboard, daily P&L summaries (per-user TZ), TG daily digest                                 |        |
| 7     | Beta polish, support tooling, agency BM partner deal                                          |        |
| 8     | Stripe billing, founding member migration, paid tiers                                         |        |

---

## Critical rules (never violate)

1. Multi-tenant data isolation — every query scopes to `user_id`, RLS enforces it, `tests/multi-tenant-isolation.test.ts` verifies.
2. Encrypt sensitive credentials at rest — Supabase Vault + pgcrypto. Plaintext only inside `decryptSecret()`.
3. Never simulate logic. Stubs throw `'Not implemented'`.
4. Comment external integrations with API version + integration date.
5. Feature flags from day 1 (`packages/db/src/safety/feature-flags.ts`).
6. Sentry from day 1.
7. Rate limit API endpoints + centralized Meta scheduler.
8. Spend safety on every Meta mutation. No exceptions.
9. Dry-run mode works end to end.
10. Audit log every Meta API call.
11. TypeScript strict mode. `any` requires an explanatory comment.
12. Tests for: auth, multi-tenant isolation, spend safety, rate limit logic.

---

## License

UNLICENSED — proprietary. Do not redistribute.
