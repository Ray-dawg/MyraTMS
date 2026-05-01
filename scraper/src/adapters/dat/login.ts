/**
 * DAT login flow.
 *
 * Strategy (T-04A §8.2):
 *   1. Probe — open the protected URL. If we redirect to dashboard not
 *      login, the existing session is valid; return immediately.
 *   2. Detect Cloudflare/captcha. If present → halt + Slack alert. Never
 *      retry past a captcha; that is the fastest way to get banned.
 *   3. Type credentials with human-like per-character delays.
 *   4. Submit, wait for navigation.
 *   5. Detect MFA. If present → halt + Slack alert. We don't auto-MFA.
 *   6. Detect explicit login error. Return invalid_credentials.
 *   7. Verify post-login marker. Return success.
 *
 * Returns AuthResult — never throws for known failure modes. The caller
 * decides what to do with mfa_required / captcha (typically: halt that
 * board, surface to operator).
 */

import type { BrowserContext, Page } from 'playwright';
import { config } from '../../config.js';
import { logger } from '../../observability/logger.js';
import { slackAlert } from '../../observability/slack.js';
import { DAT_SELECTORS } from './selectors.js';
import type { AuthResult } from '../base.js';

const LOGIN_TIMEOUT_MS = 30_000;
const MFA_DETECTION_TIMEOUT_MS = 5_000;
const AUTH_MARKER_TIMEOUT_MS = 5_000;

async function isAuthenticated(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(DAT_SELECTORS.authenticatedMarker, {
      timeout: AUTH_MARKER_TIMEOUT_MS,
      state: 'visible',
    });
    return true;
  } catch {
    return false;
  }
}

async function captchaPresent(page: Page): Promise<boolean> {
  const count = await page
    .locator('iframe[src*="cloudflare"], iframe[src*="captcha"], #cf-challenge')
    .count();
  return count > 0;
}

export async function authenticateDAT(context: BrowserContext): Promise<AuthResult> {
  const page = await context.newPage();
  page.setDefaultTimeout(LOGIN_TIMEOUT_MS);

  try {
    // ── Step 1: probe existing session
    logger.debug({ url: config.DAT_AUTH_PROBE_URL }, 'DAT: probing existing session');
    await page.goto(config.DAT_AUTH_PROBE_URL, { waitUntil: 'domcontentloaded' });

    if (await isAuthenticated(page)) {
      logger.info('DAT: session reused (no login needed)');
      await page.close();
      return { success: true, sessionReused: true };
    }

    // ── Step 2: navigate to login
    logger.info('DAT: session missing/expired, performing login');
    await page.goto(config.DAT_LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // ── Step 3: captcha detection
    if (await captchaPresent(page)) {
      logger.warn('DAT: captcha challenge detected on login page');
      await slackAlert({
        level: 'warn',
        title: 'DAT login blocked by captcha',
        body: 'Manual intervention required. Consider rotating proxy or warming session via real browser.',
      });
      await page.close();
      return { success: false, reason: 'captcha', detail: 'Cloudflare/captcha challenge' };
    }

    // ── Step 4: fill credentials with human-like delays
    await page.waitForSelector(DAT_SELECTORS.username, { state: 'visible' });
    await humanType(page, DAT_SELECTORS.username, config.DAT_USERNAME!);
    await randomDelay(300, 800);
    await humanType(page, DAT_SELECTORS.password, config.DAT_PASSWORD!);
    await randomDelay(400, 900);

    // ── Step 5: submit
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: LOGIN_TIMEOUT_MS }).catch(() => {}),
      page.click(DAT_SELECTORS.loginButton),
    ]);

    // ── Step 6: MFA detection
    const mfaInput = page.locator(DAT_SELECTORS.mfaInput);
    try {
      await mfaInput.waitFor({ state: 'visible', timeout: MFA_DETECTION_TIMEOUT_MS });
      logger.warn('DAT: MFA challenge detected');
      await slackAlert({
        level: 'warn',
        title: 'DAT MFA required',
        body: 'Polling paused for DAT until manual MFA completion. Run `npm run dat:manual-login` to refresh session.',
      });
      await page.close();
      return { success: false, reason: 'mfa_required', detail: 'MFA prompt visible' };
    } catch {
      // No MFA — continue.
    }

    // ── Step 7: explicit login error
    const errorEl = page.locator(DAT_SELECTORS.loginError);
    if ((await errorEl.count()) > 0 && (await errorEl.first().isVisible())) {
      const errText = (await errorEl.first().textContent())?.trim() || 'unknown error';
      logger.error({ err: errText }, 'DAT: login rejected');
      await page.close();
      return { success: false, reason: 'invalid_credentials', detail: errText };
    }

    // ── Step 8: verify authenticated marker
    if (!(await isAuthenticated(page))) {
      logger.error('DAT: post-login verification failed (no auth marker)');
      await page.close();
      return { success: false, reason: 'unknown', detail: 'No authenticated marker after login' };
    }

    logger.info('DAT: login successful');
    await page.close();
    return { success: true, sessionReused: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'DAT: authentication threw');
    await page.close();
    return { success: false, reason: 'unknown', detail: message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 50 + Math.random() * 80 });
  }
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}
