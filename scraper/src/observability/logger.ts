/**
 * Pino logger — structured JSON output, captured natively by Railway stdout.
 *
 * One service-wide field: `service: 'myra-scraper'`. Use child loggers per
 * board (`logger.child({ source: 'dat' })`) when you want every line in a
 * poll cycle tagged automatically.
 */

import { pino } from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'myra-scraper' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Pretty-print in dev for readability; raw JSON in prod for log shippers.
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});
