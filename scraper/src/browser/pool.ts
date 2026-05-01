/**
 * BrowserPool — one persistent Playwright BrowserContext per active board,
 * reused across polling cycles.
 *
 * Why pool: launching Chromium and creating a context costs 2–4s. For a 5-min
 * poll cadence, paying that on every cycle is 1% of CPU time and ~10x the
 * number of process starts a load board sees from this IP — both fingerprint
 * red flags. Reusing the context (with persisted storageState) makes the
 * scraper behave like a long-running browser session, which is what a human
 * broker's seat would look like.
 *
 * resetContext(source) is the escape hatch for sessions gone bad — closes
 * the context, deletes the Redis storageState, and forces a clean login on
 * the next poll.
 */

import type { Browser, BrowserContext } from 'playwright';
import { chromium, pickUserAgent } from './stealth.js';
import type { SessionStore } from './session-store.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

export class BrowserPool {
  private browser: Browser | null = null;
  private contexts = new Map<string, BrowserContext>();

  constructor(private sessionStore: SessionStore) {}

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });
    logger.info({ headless: config.HEADLESS }, 'BrowserPool: launched');
  }

  async getContext(source: string, proxyUrl?: string): Promise<BrowserContext> {
    if (!this.browser) throw new Error('BrowserPool: init() not called');

    const existing = this.contexts.get(source);
    if (existing) return existing;

    const storageState = await this.sessionStore.load(source);
    const ctx = await this.browser.newContext({
      userAgent: config.USER_AGENT_ROTATION ? pickUserAgent() : undefined,
      viewport: { width: 1366, height: 768 },
      // Playwright accepts the unknown shape we got back from JSON.parse.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: (storageState as any) ?? undefined,
      proxy: proxyUrl ? { server: proxyUrl } : undefined,
      locale: 'en-US',
      timezoneId: 'America/Toronto',
    });

    this.contexts.set(source, ctx);
    logger.debug({ source, sessionRestored: !!storageState }, 'BrowserPool: context created');
    return ctx;
  }

  /**
   * Tear down a context and clear the Redis session — used after auth
   * failures so the next poll starts fresh.
   */
  async resetContext(source: string): Promise<void> {
    const ctx = this.contexts.get(source);
    if (ctx) {
      try {
        await ctx.close();
      } catch (e) {
        logger.warn({ err: e, source }, 'BrowserPool: error closing context');
      }
      this.contexts.delete(source);
    }
    await this.sessionStore.clear(source);
  }

  /**
   * Save the current storageState for a context to Redis. Called by the
   * scheduler after a successful poll to extend session reuse.
   */
  async persistSession(source: string): Promise<void> {
    const ctx = this.contexts.get(source);
    if (!ctx) return;
    try {
      await this.sessionStore.save(source, ctx);
    } catch (e) {
      logger.warn({ err: e, source }, 'BrowserPool: failed to persist session');
    }
  }

  async shutdown(): Promise<void> {
    for (const [source, ctx] of this.contexts.entries()) {
      try {
        await this.sessionStore.save(source, ctx);
        await ctx.close();
      } catch (e) {
        logger.warn({ err: e, source }, 'BrowserPool: shutdown — error closing context');
      }
    }
    this.contexts.clear();
    if (this.browser) await this.browser.close();
    this.browser = null;
    logger.info('BrowserPool: shutdown complete');
  }
}
