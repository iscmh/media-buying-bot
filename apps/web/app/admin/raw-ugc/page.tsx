import { isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AppShell } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/shell/page-header';
import { requireAdmin } from '@/lib/admin-gate';
import { RawUgcClient, type AvatarOption } from './raw-ugc-client';

export const metadata = { title: 'Raw UGC - Admin' };
export const dynamic = 'force-dynamic';

/**
 * Polish-25.6 Commit 35: admin-only raw MakeUGC generator.
 *
 * Personal tool for the operator to spin one-off UGC videos for
 * their own ad campaigns without going through the Polish-25
 * analysis/condenser/matcher pipeline. Pick an avatar, paste a
 * script, hit generate, download the mp4.
 *
 * Auth: `requireAdmin()` redirects non-admins to /dashboard silently
 * so the route's existence doesn't leak.
 *
 * The page is a Server Component that fetches the avatar catalog
 * from `makeugc_avatar_index` (already refreshed by the
 * refresh-makeugc-avatar-index Inngest cron — no extra API call at
 * page load). The form + polling loop lives in RawUgcClient.
 */
export default async function AdminRawUgcPage() {
  await requireAdmin();
  const db = getDb();

  const rows = await db.query.makeugcAvatarIndex.findMany({
    where: isNull(schema.makeugcAvatarIndex.deletedAt),
    columns: {
      avatarId: true,
      avatarName: true,
      thumbnailUrl: true,
      makeugcGender: true,
      ageBucket: true,
      ethnicity: true,
      hairColor: true,
      wardrobeStyle: true,
      backgroundSetting: true,
    },
    orderBy: (t, { asc: a }) => [a(t.ageBucket), a(t.ethnicity), a(t.avatarName)],
  });

  const avatars: AvatarOption[] = rows.map((r) => ({
    id: r.avatarId,
    name: r.avatarName,
    thumbnailUrl: r.thumbnailUrl,
    gender: r.makeugcGender,
    ageBucket: r.ageBucket,
    ethnicity: r.ethnicity,
    hairColor: r.hairColor,
    wardrobeStyle: r.wardrobeStyle,
    backgroundSetting: r.backgroundSetting,
  }));

  return (
    <AppShell crumbs={[{ label: 'Admin' }, { label: 'Raw UGC' }]}>
      <PageHeader
        title="Raw UGC generator"
        subtitle={`Admin-only. ${avatars.length} avatars available. Bypasses the standard Instant UGC pipeline: pick, paste, generate, download.`}
      />
      <RawUgcClient avatars={avatars} />
    </AppShell>
  );
}
