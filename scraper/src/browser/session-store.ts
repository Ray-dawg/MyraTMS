/**
 * Redis-backed session store for Playwright `storageState` (cookies +
 * localStorage). Keyed by source: `scraper:session:dat`, `scraper:session:truckstop`, etc.
 *
 * 24-hour TTL is defensive — DAT sessions typically last longer, but expiry
 * is silent and we'd rather re-login than rely on a stale cookie. If the
 * session is still valid the auth probe in the adapter short-circuits.
 */

import type { BrowserContext } from 'playwright';
import type IORedis from 'ioredis';

const SESSION_TTL_SECONDS = 24 * 3600;

export class SessionStore {
  constructor(private redis: IORedis) {}

  private key(source: string): string {
    return `scraper:session:${source}`;
  }

  async load(source: string): Promise<unknown | null> {
    const raw = await this.redis.get(this.key(source));
    return raw ? JSON.parse(raw) : null;
  }

  async save(source: string, context: BrowserContext): Promise<void> {
    const state = await context.storageState();
    await this.redis.set(this.key(source), JSON.stringify(state), 'EX', SESSION_TTL_SECONDS);
  }

  async clear(source: string): Promise<void> {
    await this.redis.del(this.key(source));
  }
}
