import { eq } from 'drizzle-orm';
import { encryptSecret, getDb, schema } from '@mbb/db';
import { callMeta } from './client';

/**
 * Phase 4b: fetch the user's authorized Facebook Pages and upsert them
 * into meta_pages cache. Called on settings load + via the "Refresh
 * pages" button.
 *
 * Returns the freshly-fetched list (not the cached one) so the caller
 * can show the user the latest. If the call fails (token expired,
 * permissions revoked), returns the previously cached rows so the UI
 * still has *something* to show.
 *
 * Page access tokens are long-lived and stored encrypted. Most launch
 * CRUD uses the user access token; page tokens are reserved for
 * page-scoped endpoints (Phase 5+).
 */
export interface MetaPageSummary {
  pageId: string;
  pageName: string;
  category: string | null;
}

export async function fetchUserPages(input: {
  userId: string;
  accessToken: string;
}): Promise<{ ok: boolean; pages: MetaPageSummary[]; errorMessage?: string }> {
  // GET /me/accounts?fields=id,name,category,access_token
  let result;
  try {
    result = await callMeta({
      userId: input.userId,
      endpoint: '/me/accounts?fields=id,name,category,access_token',
      method: 'GET',
      accessToken: input.accessToken,
    });
  } catch (err) {
    const pages = await cachedPages(input.userId);
    return {
      ok: false,
      pages,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.dryRun) {
    // DRY_RUN env override — return cached pages, fall back to a single
    // placeholder if cache is empty so the dropdown isn't blank in dev.
    const cached = await cachedPages(input.userId);
    if (cached.length > 0) return { ok: true, pages: cached };
    return {
      ok: true,
      pages: [{ pageId: 'dry_run_page_id', pageName: 'Dev page (BOT_DRY_RUN)', category: null }],
    };
  }

  if (result.status < 200 || result.status >= 300) {
    const cached = await cachedPages(input.userId);
    return {
      ok: false,
      pages: cached,
      errorMessage: extractMetaError(result.body) ?? `Meta returned HTTP ${result.status}`,
    };
  }

  const raw = parsePagesResponse(result.body);
  // Upsert into meta_pages.
  const db = getDb();
  for (const p of raw) {
    const encryptedToken = p.access_token ? await encryptSecret(p.access_token) : null;
    await db
      .insert(schema.metaPages)
      .values({
        userId: input.userId,
        pageId: p.id,
        pageName: p.name,
        category: p.category ?? null,
        pageAccessTokenEncrypted: encryptedToken,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.metaPages.userId, schema.metaPages.pageId],
        set: {
          pageName: p.name,
          category: p.category ?? null,
          pageAccessTokenEncrypted: encryptedToken,
          fetchedAt: new Date(),
        },
      });
  }

  return {
    ok: true,
    pages: raw.map((p) => ({ pageId: p.id, pageName: p.name, category: p.category ?? null })),
  };
}

async function cachedPages(userId: string): Promise<MetaPageSummary[]> {
  const db = getDb();
  const rows = await db.query.metaPages.findMany({
    where: eq(schema.metaPages.userId, userId),
    columns: { pageId: true, pageName: true, category: true },
  });
  return rows.map((r) => ({
    pageId: r.pageId,
    pageName: r.pageName,
    category: r.category,
  }));
}

interface RawPage {
  id: string;
  name: string;
  category?: string;
  access_token?: string;
}

function parsePagesResponse(body: unknown): RawPage[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: RawPage[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    out.push({
      id: p.id,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : undefined,
      access_token: typeof p.access_token === 'string' ? p.access_token : undefined,
    });
  }
  return out;
}

function extractMetaError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: { message?: string } }).error;
  return typeof error?.message === 'string' ? error.message : undefined;
}
