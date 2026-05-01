/**
 * LoadBoardAPIClient — the contract every official-API ingest source
 * implements. This is the third injection pathway into Engine 2 (after
 * CSV import and the Railway headless scraper).
 *
 * Adding a new source = implementing this 3-method interface, plus
 * registering the client in lib/loadboards/registry.ts.
 *
 * Scrapper symmetry: this interface intentionally mirrors the scraper's
 * LoadBoardAdapter (M1/scraper/src/adapters/base.ts). Different transport
 * (HTTP vs browser), same mental model. When the scraper retires, an
 * implementation can be lifted across by replacing only the transport.
 */

import type { RawLoad } from '@/lib/workers/scanner-worker';

export type LoadBoardSource = 'dat' | 'truckstop' | '123lb' | 'loadlink';

export interface SearchQuery {
  equipmentTypes: Array<'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck'>;
  /** Two-letter province / state codes. */
  originProvinces: string[];
  pickupDateFrom: Date;
  pickupDateTo: Date;
  /** Maximum rows to return per call. Boards have their own caps; this is a client-side bound. */
  maxResults?: number;
}

/**
 * Anything an authenticate() call needs to hand back. OAuth-flow boards
 * carry the access token + expiry; api-key boards carry the key. Treat as
 * opaque from the orchestrator's perspective.
 */
export interface AuthHandle {
  /** Authorization header value (e.g. "Bearer eyJ..." or "ApiKey foo"). */
  authorization: string;
  /** Optional secondary headers (DAT requires X-Customer-Id, etc.). */
  extraHeaders?: Record<string, string>;
  /** Unix epoch (ms) when this handle expires; null = no expiry. */
  expiresAt: number | null;
}

/**
 * Why typed errors instead of throwing strings: the cron orchestrator
 * needs to distinguish "rate limited, retry later" from "credentials
 * invalid, page operator" from "transport error, will retry". Each is a
 * different operational response.
 */
export type LoadBoardErrorReason =
  | 'invalid_credentials'    // creds rejected — operator must update integration row
  | 'rate_limited'           // 429 from board; back off
  | 'transport'              // network / 5xx — retry
  | 'parse'                  // response shape changed; selectors-equivalent issue
  | 'not_implemented'        // stub adapter — still waiting on credentials
  | 'unknown';

export class LoadBoardAPIError extends Error {
  constructor(
    public readonly source: LoadBoardSource,
    public readonly reason: LoadBoardErrorReason,
    message: string,
    public readonly retryable: boolean = false,
    public readonly underlying?: unknown,
  ) {
    super(`[${source}] ${reason}: ${message}`);
    this.name = 'LoadBoardAPIError';
  }
}

export interface LoadBoardAPIClient {
  readonly source: LoadBoardSource;

  /**
   * Establish an authenticated session. OAuth clients hit the token
   * endpoint and cache the result in Redis. API-key clients build the
   * handle synchronously. Either way, returns immediately if the cached
   * handle is still valid.
   */
  authenticate(): Promise<AuthHandle>;

  /**
   * Hit the board's official search endpoint. Throws LoadBoardAPIError
   * with a typed reason on failure — the orchestrator branches on reason.
   * Implementations MUST respect the rate-limiter (lib/loadboards/rate-limiter.ts).
   */
  searchLoads(query: SearchQuery, auth: AuthHandle): Promise<unknown[]>;

  /**
   * Map one API response row to RawLoad. Returns null if the row is
   * unparseable (logged + counted as skipped, never throws). The RawLoad
   * shape MUST match lib/workers/scanner-worker.ts so the existing
   * Qualifier consumes API-sourced loads identically to CSV/scrape ones.
   */
  mapToRawLoad(apiRow: unknown): RawLoad | null;
}
