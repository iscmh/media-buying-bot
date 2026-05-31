import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function launchBrowser(headed: boolean): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  // Reduce obvious automation fingerprints.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context };
}

/** Navigate to a URL and wait for the page to settle, tolerating slow/anti-bot pages. */
export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // Give client-rendered content and any anti-bot challenge a moment.
  await page.waitForTimeout(1500);
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    // networkidle can never fire on ad-heavy pages; that's fine.
  }
}
