import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

const DEBUG_DIR = 'debug';

/** Dump the rendered HTML + a screenshot so selectors can be tuned offline. */
export async function dumpDebug(page: Page, label: string): Promise<void> {
  await mkdir(DEBUG_DIR, { recursive: true });
  const safe = label.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'page';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(DEBUG_DIR, `${stamp}_${safe}`);
  const html = await page.content();
  await writeFile(`${base}.html`, html, 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  console.error(`  [debug] saved ${base}.html and ${base}.png`);
}
