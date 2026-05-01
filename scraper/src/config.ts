/**
 * Boot-time configuration for the headless scraper.
 *
 * Reads process.env, validates via zod, fails fast on missing credentials when
 * a board is *_ENABLED. Anything that survives parse() is safe to use at
 * runtime — no further null checks needed.
 *
 * Per T-04A §4.2: "All env vars validated at boot via zod. Missing/invalid
 * values → fail fast with a clear error, not a runtime crash 30 minutes in."
 */

import { z } from 'zod';

/**
 * z.coerce.boolean() is permissive in a surprising way: it treats *any*
 * non-empty string as true, so `"false"` becomes `true`. For env-var
 * parsing we want `"false" | "0" | ""` to mean false. This explicit parser
 * prevents that footgun.
 */
const envBool = (defaultValue = false) =>
  z
    .union([z.string(), z.boolean()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
      return true;
    })
    .default(defaultValue);

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    SCRAPER_ENABLED: envBool(true),
    TENANT_ID: z.coerce.number().int().positive().default(1),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    QUALIFY_QUEUE_NAME: z.string().default('qualify-queue'),

    // ── DAT
    DAT_ENABLED: envBool(false),
    DAT_USERNAME: z.string().optional(),
    DAT_PASSWORD: z.string().optional(),
    DAT_LOGIN_URL: z.string().url().default('https://power.dat.com/login'),
    DAT_SEARCH_URL: z.string().url().default('https://power.dat.com/search'),
    DAT_AUTH_PROBE_URL: z.string().url().default('https://power.dat.com/account/profile'),
    DAT_POLL_INTERVAL_MS: z.coerce.number().int().min(180_000).default(300_000), // min 3 min
    DAT_POLL_JITTER_MS: z.coerce.number().int().min(0).default(60_000),
    DAT_PROXY_URL: z.string().optional(),
    DAT_EQUIPMENT: z.string().default('dry_van,flatbed,reefer'),
    DAT_ORIGIN_PROVINCES: z.string().default('ON,AB'),
    DAT_DAYS_FORWARD: z.coerce.number().int().min(1).max(14).default(7),

    // ── Truckstop (stub)
    TRUCKSTOP_ENABLED: envBool(false),
    TRUCKSTOP_USERNAME: z.string().optional(),
    TRUCKSTOP_PASSWORD: z.string().optional(),
    TRUCKSTOP_LOGIN_URL: z.string().url().default('https://truckstop.com/login'),

    // ── 123Loadboard (stub)
    LOADBOARD123_ENABLED: envBool(false),
    LOADBOARD123_USERNAME: z.string().optional(),
    LOADBOARD123_PASSWORD: z.string().optional(),
    LOADBOARD123_LOGIN_URL: z.string().url().default('https://www.123loadboard.com/login'),

    // ── Loadlink (stub)
    LOADLINK_ENABLED: envBool(false),
    LOADLINK_USERNAME: z.string().optional(),
    LOADLINK_PASSWORD: z.string().optional(),
    LOADLINK_LOGIN_URL: z.string().url().default('https://www.loadlink.ca/login'),

    // ── Observability
    SLACK_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
    SLACK_ALERT_CHANNEL: z.string().default('#myra-scraper'),

    // ── Browser
    HEADLESS: envBool(true),
    USER_AGENT_ROTATION: envBool(true),
    SCREENSHOT_ON_ERROR: envBool(true),
  })
  .superRefine((cfg, ctx) => {
    const checkEnabled = (
      flag: boolean,
      user: string | undefined,
      pass: string | undefined,
      board: string,
    ) => {
      if (flag && (!user || !pass)) {
        ctx.addIssue({
          code: 'custom',
          message: `${board}_ENABLED is true but ${board}_USERNAME or ${board}_PASSWORD is missing`,
        });
      }
    };
    checkEnabled(cfg.DAT_ENABLED, cfg.DAT_USERNAME, cfg.DAT_PASSWORD, 'DAT');
    checkEnabled(cfg.TRUCKSTOP_ENABLED, cfg.TRUCKSTOP_USERNAME, cfg.TRUCKSTOP_PASSWORD, 'TRUCKSTOP');
    checkEnabled(cfg.LOADBOARD123_ENABLED, cfg.LOADBOARD123_USERNAME, cfg.LOADBOARD123_PASSWORD, 'LOADBOARD123');
    checkEnabled(cfg.LOADLINK_ENABLED, cfg.LOADLINK_USERNAME, cfg.LOADLINK_PASSWORD, 'LOADLINK');
  });

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid scraper configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Singleton config — fully validated at module load time. */
export const config: Config = loadConfig();

/** Helper: parse a comma-separated list once. */
export function csvList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
