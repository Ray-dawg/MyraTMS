/**
 * Manual MFA escape hatch.
 *
 * When DAT throws an MFA challenge, the scheduler halts that board and
 * Slacks the operator. Run this script locally with HEADLESS=false; it
 * opens a real browser, lets the human complete login + MFA, then writes
 * the storageState to Redis under `scraper:session:dat`. The next
 * scheduled poll picks up the fresh session and resumes.
 *
 * Usage:
 *   HEADLESS=false npx tsx --env-file=.env scripts/dat-manual-login.ts
 */

import IORedis from 'ioredis';
import { chromium } from '../src/browser/stealth.js';
import { SessionStore } from '../src/browser/session-store.js';

async function main(): Promise<void> {
  const REDIS_URL = process.env.REDIS_URL;
  const DAT_LOGIN_URL = process.env.DAT_LOGIN_URL || 'https://power.dat.com/login';
  if (!REDIS_URL) {
    console.error('REDIS_URL is required');
    process.exit(1);
  }

  const redis = new IORedis(REDIS_URL);
  const store = new SessionStore(redis);

  console.log('Launching DAT login browser (HEADFUL)...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/Toronto',
  });
  const page = await ctx.newPage();

  await page.goto(DAT_LOGIN_URL);

  console.log('\n────────────────────────────────────────────────────────');
  console.log('  Browser is open at the DAT login page.');
  console.log('  Complete login + MFA in the browser window.');
  console.log('  When you are signed in, press ENTER in this terminal.');
  console.log('────────────────────────────────────────────────────────\n');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await store.save('dat', ctx);
  console.log('\n✓ Session saved to Redis under scraper:session:dat');

  await browser.close();
  await redis.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error('manual-login failed:', err);
  process.exit(1);
});
