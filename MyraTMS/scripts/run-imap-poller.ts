/**
 * E2-04 M4 — inbound email poller entry-point.
 *
 * Separate long-running process from scripts/run-workers.ts on purpose:
 * an IMAP IDLE/poll loop has a different failure mode (a stuck IMAP
 * connection) than the BullMQ worker pool, and this codebase's convention
 * is one host per distinct external-integration surface (see the headless
 * scraper's own separate Railway service, documented in the root CLAUDE.md).
 *
 * Kill switch: INBOUND_EMAIL_POLLING_ENABLED=false (default) skips every
 * poll cycle — same exact-match .trim().toLowerCase() pattern as every
 * other kill switch in this codebase, after the documented prior incident
 * where a trailing newline on a Vercel/Railway env value silently defeated
 * one.
 *
 * Requires IONOS IMAP credentials: IMAP_HOST, IMAP_PORT, IMAP_USER,
 * IMAP_PASS. Not set anywhere yet — this script is code-complete and
 * tested (via lib/email/imap-poller.ts's injected-client design) but has
 * never run against a real mailbox, per this PRD's own explicit flag that
 * M4 needs real operator-provisioned credentials before it can go live.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/run-imap-poller.ts
 */

import { ImapFlow } from 'imapflow';
import { logger } from '../lib/logger';
import { pollInbox } from '../lib/email/imap-poller';

const POLL_INTERVAL_MS = Number(process.env.IMAP_POLL_INTERVAL_MS ?? '60000');

function pollingEnabled(): boolean {
  return process.env.INBOUND_EMAIL_POLLING_ENABLED?.trim().toLowerCase() === 'true';
}

function buildClient(): ImapFlow {
  const host = process.env.IMAP_HOST;
  const port = Number(process.env.IMAP_PORT ?? '993');
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    throw new Error('IMAP_HOST, IMAP_USER, and IMAP_PASS must all be set to run the inbound email poller');
  }

  return new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

async function runOnce(): Promise<void> {
  if (!pollingEnabled()) {
    logger.debug('[imap-poller] INBOUND_EMAIL_POLLING_ENABLED=false — skipping poll cycle');
    return;
  }

  const client = buildClient();
  try {
    const result = await pollInbox(client as any);
    logger.info(`[imap-poller] Poll cycle complete: processed=${result.processed} matched=${result.matched} quarantined=${result.quarantined}`);
  } catch (err) {
    logger.error('[imap-poller] Poll cycle failed', err);
  }
}

async function main() {
  logger.info(`[imap-poller] Starting. INBOUND_EMAIL_POLLING_ENABLED=${process.env.INBOUND_EMAIL_POLLING_ENABLED ?? '(unset, defaults false)'}, interval=${POLL_INTERVAL_MS}ms`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[imap-poller] ${signal} received, exiting after current cycle`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // eslint-disable-next-line no-constant-condition
  while (!shuttingDown) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  logger.error('[imap-poller] startup failure', err);
  process.exit(1);
});
