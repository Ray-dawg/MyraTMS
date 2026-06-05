/**
 * TEMP shadow-drain helper (NOT committed): a pure-Node HTTP stand-in for
 * POST /api/pipeline/import. Lets 02-generate-shadow-loads.ts ingest via
 * localhost:3000 without booting Next.js (which is unreliable here because
 * node_modules lives under OneDrive Files-On-Demand and `next dev` trips a
 * UNKNOWN read error). Calls the exact same ScannerService.ingestRawLoads
 * the real route uses, so the ingest path is identical.
 *
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/_ingest-receiver.ts
 */
import http from 'node:http';
import { Queue } from 'bullmq';
import { redisConnection } from '../../lib/pipeline/redis-bullmq';
import { ScannerService } from '../../lib/workers/scanner-worker';

const PORT = Number(process.env.SHADOW_INGEST_PORT ?? 3000);
const TOKEN = process.env.PIPELINE_IMPORT_TOKEN || process.env.CRON_SECRET || '';

const queue = new Queue('qualify-queue', { connection: redisConnection });
const svc = new ScannerService(redisConnection, queue);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"route":"shadow-ingest-receiver"}');
    return;
  }
  if (req.method === 'POST' && req.url === '/api/pipeline/import') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as { loads?: unknown[]; source?: string };
        if (!Array.isArray(parsed.loads)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"invalid_body"}');
          return;
        }
        const result = await svc.ingestRawLoads(
          parsed.loads as never,
          (parsed.source ?? 'manual') as never,
        );
        console.log('[receiver] ingested', JSON.stringify(result));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[receiver] error', err);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[receiver] listening on http://localhost:${PORT} (token ${TOKEN ? 'set' : 'MISSING'})`);
});
