import Link from 'next/link';
import { and, eq, isNull } from 'drizzle-orm';
import { listHeyGenAvatars, type HeyGenAvatar } from '@mbb/ai-providers';
import { decryptSecret, getDb, schema } from '@mbb/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AvatarPickerForm } from './heygen-avatar-picker';

/**
 * Phase 3f: Default UGC Avatar section on /settings.
 *
 * Fetches the user's avatar catalog from HeyGen on every settings load.
 * No caching by design — section is rarely visited and HeyGen's /v2/avatars
 * is cheap. Failures degrade to a "couldn't load" message instead of
 * breaking the whole settings page.
 *
 * Renders one of three states:
 *   - No HeyGen key connected → CTA to /connections/ai-provider
 *   - Key present but listAvatars failed → error with retry hint
 *   - Avatars loaded → 2x3 grid; currently-selected has a primary border
 */
export async function HeygenAvatarSection({ userId }: { userId: string }) {
  const db = getDb();

  // 1. Find the active HeyGen connection (encrypted key).
  const conn = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.provider, 'heygen'),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: { apiKeyEncrypted: true },
  });

  // 2. Currently-saved default (NULL = falls back to env / smart-match).
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { defaultHeygenAvatarId: true },
  });
  const currentDefaultId = settings?.defaultHeygenAvatarId ?? null;

  if (!conn) {
    return (
      <Card id="heygen-avatar" className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">Default UGC Avatar</CardTitle>
          <CardDescription>
            UGC variants use HeyGen Avatar Mode. Connect your HeyGen API key first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="sm">
            <Link href="/connections/ai-provider">Connect HeyGen</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 3. Decrypt + fetch live avatars. Don't surface the plaintext key
  // back to the client — only the avatar list metadata.
  let apiKey: string;
  try {
    apiKey = await decryptSecret(conn.apiKeyEncrypted);
  } catch {
    return (
      <Card id="heygen-avatar" className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">Default UGC Avatar</CardTitle>
          <CardDescription>
            Couldn&apos;t decrypt your HeyGen key. Reconnect it on the connections page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const fetchResult = await listHeyGenAvatars({ userId, apiKey });

  if (!fetchResult.ok) {
    return (
      <Card id="heygen-avatar" className="mb-8">
        <CardHeader>
          <CardTitle className="text-base">Default UGC Avatar</CardTitle>
          <CardDescription>
            HeyGen wouldn&apos;t return your avatar list ({fetchResult.errorMessage ?? 'unknown'}).
            Refresh this page in a minute, or reconnect HeyGen if the problem persists.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // HeyGen accounts get hundreds of stock avatars; only the user's own
  // custom-trained ones are useful for ads. Cap to a sane preview so the
  // grid doesn't spam the page — operators can scroll within HeyGen if
  // they want something exotic.
  const previewAvatars: HeyGenAvatar[] = fetchResult.avatars.slice(0, 24);

  return (
    <Card id="heygen-avatar" className="mb-8">
      <CardHeader>
        <CardTitle className="text-base">Default UGC Avatar</CardTitle>
        <CardDescription>
          The avatar HeyGen uses for every new UGC variant. Pick one matching your typical target
          persona; you can change it any time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AvatarPickerForm
          avatars={previewAvatars}
          currentDefaultId={currentDefaultId}
          totalAvailable={fetchResult.avatars.length}
        />
      </CardContent>
    </Card>
  );
}
