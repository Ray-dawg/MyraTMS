/**
 * playwright-extra + stealth plugin setup.
 *
 * The stealth plugin patches navigator.webdriver, the user-agent's headless
 * flag, the chrome runtime object, permissions API, plus a dozen other
 * fingerprints that load boards check for. It defeats most "I'm a bot"
 * detection but not custom enterprise WAF rules — those need a residential
 * proxy and slower polling.
 */

import { chromium as chromiumExtra } from 'playwright-extra';
// Stealth plugin is published only as `puppeteer-extra-plugin-stealth` but
// the playwright-extra runner is plugin-compatible with it.
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromiumExtra.use(StealthPlugin());

export const chromium = chromiumExtra;

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

export function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
