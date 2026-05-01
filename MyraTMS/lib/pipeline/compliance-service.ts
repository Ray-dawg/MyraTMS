/**
 * COMPLIANCE SERVICE
 * Myra Logistics Build 4: Legal Gate for All Outbound Calls
 *
 * This is the legal gatekeeper that MUST run before any outbound call.
 * No compliance module = no calls, period.
 *
 * Enforces:
 * - CASL (Canadian Anti-Spam Legislation)
 * - TCPA (Telephone Consumer Protection Act)
 * - Do-Not-Call lists
 * - Calling hour restrictions
 * - Consent tracking and expiry
 * - Shipper fatigue protection
 *
 * All logic is deterministic and testable. All checks are logged for regulatory defense.
 */

import {
  ConsentCheckResult,
  DNCCheckResult,
  CallingHoursResult,
  RecordingDisclosureInfo,
  ShipperFatigueResult,
  FullComplianceCheckResult,
  ConsentLogEntry,
  DNCListEntry,
  ComplianceAuditLog,
  ShipperPreference,
  CallType,
  ConsentType,
  ConsentSource,
  DNCSource,
  ComplianceConfig,
  StateTimezoneMap,
} from './compliance-types';

/**
 * Database connection interface (abstract)
 * In production, this would be your actual Supabase/Neon client
 */
interface DatabaseClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (db: DatabaseClient) => Promise<T>): Promise<T>;
}

/**
 * Compliance Service Class
 * All methods are async to support database queries
 */
export class ComplianceService {
  private db: DatabaseClient;
  private config: ComplianceConfig;
  private stateTimezoneMap: StateTimezoneMap;

  constructor(db: DatabaseClient, config: ComplianceConfig) {
    this.db = db;
    this.config = config;
    this.stateTimezoneMap = this.buildStateTimezoneMap();
  }

  /**
   * ==============================================================================
   * PRIMARY COMPLIANCE GATE
   * ==============================================================================
   *
   * runFullComplianceCheck()
   * Master function: runs ALL checks before a call, returns definitive go/no-go
   */
  public async runFullComplianceCheck(
    phoneNumber: string,
    callType: CallType,
    contactId?: number,
    loadId?: string,
    shipperProvince?: string,
    shipperState?: string
  ): Promise<FullComplianceCheckResult> {
    const checkedAt = new Date();
    const checks = {
      dncCheck: await this.checkDNC(phoneNumber),
      consentCheck: await this.checkConsentStatus(phoneNumber, callType, contactId, loadId),
      callingHoursCheck: this.checkCallingHours(phoneNumber, shipperProvince, shipperState),
      recordingDisclosureCheck: this.requiresRecordingDisclosure(shipperState, shipperProvince),
      fatigueCheck: await this.checkShipperFatigue(phoneNumber),
    };

    // Collect all blockers
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (checks.dncCheck.isBlocked) {
      blockers.push(`DNC: ${checks.dncCheck.reason}`);
    }

    if (!checks.consentCheck.canCall) {
      blockers.push(`Consent: ${checks.consentCheck.reason}`);
    }

    if (!checks.callingHoursCheck.canCallNow) {
      blockers.push(`Calling hours: ${checks.callingHoursCheck.reason}`);
    }

    if (!checks.fatigueCheck.canContact) {
      blockers.push(`Fatigue: ${checks.fatigueCheck.reason}`);
    }

    // Combine disclosure scripts if needed
    let disclosureScript: string | null = null;
    const disclosureList: string[] = [];

    if (checks.recordingDisclosureCheck.disclosureScript) {
      disclosureList.push(checks.recordingDisclosureCheck.disclosureScript);
    }

    if (checks.consentCheck.disclosureScript) {
      disclosureList.push(checks.consentCheck.disclosureScript);
    }

    if (disclosureList.length > 0) {
      disclosureScript = disclosureList.join(' ');
    }

    // Log the audit trail
    await this.logComplianceAudit(phoneNumber, 'full_compliance_check', blockers.length === 0 ? 'pass' : 'block', {
      callType,
      checks,
      blockers,
      warnings,
    });

    // Calculate next valid retry time if blocked
    let nextRetryAt: Date | null = null;
    if (blockers.length > 0) {
      // If calling hours issue, retry at next window
      if (!checks.callingHoursCheck.canCallNow && checks.callingHoursCheck.nextValidWindow) {
        nextRetryAt = checks.callingHoursCheck.nextValidWindow;
      }
      // If fatigue issue, retry at suggested contact date
      else if (checks.fatigueCheck.nextContactDate) {
        nextRetryAt = checks.fatigueCheck.nextContactDate;
      }
      // Otherwise, retry in 1 hour (operator should manually review)
      else {
        nextRetryAt = new Date(Date.now() + 3600000);
      }
    }

    return {
      canCall: blockers.length === 0,
      checks,
      blockers,
      warnings,
      disclosureScript,
      checkedAt,
      nextRetryAt,
    };
  }

  /**
   * ==============================================================================
   * CONSENT CHECKING
   * ==============================================================================
   */

  /**
   * checkConsentStatus()
   * Returns whether we have valid consent to call this person
   * Different rules for different call types
   */
  public async checkConsentStatus(
    phoneNumber: string,
    callType: CallType,
    contactId?: number,
    loadId?: string
  ): Promise<ConsentCheckResult> {
    const checkedAt = new Date();

    // Step 1: Check if consent has been revoked
    const revokedConsent = await this.db.query<{
      revoked_at: string;
      revoked_reason: string;
    }>(
      `SELECT revoked_at, revoked_reason FROM consent_log
       WHERE phone = $1 AND revoked_at IS NOT NULL
       ORDER BY revoked_at DESC LIMIT 1`,
      [phoneNumber]
    );

    if (revokedConsent.rows.length > 0) {
      return {
        canCall: false,
        consentType: null,
        consentSource: null,
        consentExpiresAt: null,
        reason: 'Consent previously revoked',
        requiresDisclosure: false,
        disclosureScript: null,
        checkedAt,
        callType,
      };
    }

    // Step 2: Call-type-specific consent logic
    // Per T-13 Section 3, different call types have different consent requirements

    if (callType === 'load_booking') {
      // Implied consent from load board posting (6-month window)
      // Shipper posted the load with their phone number, inviting broker contact
      return {
        canCall: true,
        consentType: 'implied_load_post',
        consentSource: 'dat_load_post', // Will be override by caller if different source
        consentExpiresAt: new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000), // 6 months
        reason: 'Implied consent via load board posting',
        requiresDisclosure: false,
        disclosureScript: null,
        checkedAt,
        callType,
      };
    }

    if (callType === 'shipper_outreach') {
      // Requires explicit consent OR existing business relationship
      // This is the stricter case: cold outreach to a shipper

      const validConsent = await this.db.query<{
        consent_type: ConsentType;
        consent_source: ConsentSource;
        expires_at: string | null;
      }>(
        `SELECT consent_type, consent_source, expires_at
         FROM consent_log
         WHERE phone = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY consent_date DESC LIMIT 1`,
        [phoneNumber]
      );

      if (validConsent.rows.length === 0) {
        return {
          canCall: false,
          consentType: null,
          consentSource: null,
          consentExpiresAt: null,
          reason: 'No valid consent for cold shipper outreach. Explicit consent required.',
          requiresDisclosure: false,
          disclosureScript: null,
          checkedAt,
          callType,
        };
      }

      const consent = validConsent.rows[0];
      return {
        canCall: true,
        consentType: consent.consent_type,
        consentSource: consent.consent_source,
        consentExpiresAt: consent.expires_at ? new Date(consent.expires_at) : null,
        reason: `Valid consent found (${consent.consent_type})`,
        requiresDisclosure: true,
        // CASL requirement: identify caller, company, address, and offer opt-out
        disclosureScript: `Hi, this is [AGENT_NAME] from Myra Logistics. Our office is at [COMPANY_ADDRESS]. I'm calling about [PURPOSE]. If you prefer not to receive calls from us, just let me know and I'll remove your number immediately.`,
        checkedAt,
        callType,
      };
    }

    if (callType === 'carrier_recruitment') {
      // Implied consent: carrier listed publicly (FMCSA database, Google business, load board)
      return {
        canCall: true,
        consentType: 'implied_business',
        consentSource: 'manual_entry', // Will vary
        consentExpiresAt: null, // No expiry for public business listing
        reason: 'Carrier has public business listing',
        requiresDisclosure: false,
        disclosureScript: null,
        checkedAt,
        callType,
      };
    }

    // Unknown call type
    return {
      canCall: false,
      consentType: null,
      consentSource: null,
      consentExpiresAt: null,
      reason: `Unknown call type: ${callType}`,
      requiresDisclosure: false,
      disclosureScript: null,
      checkedAt,
      callType,
    };
  }

  /**
   * ==============================================================================
   * DO-NOT-CALL CHECKING
   * ==============================================================================
   */

  /**
   * checkDNC()
   * Returns whether a phone number is on the internal DNC list
   * Always checked first — overrides all other consent
   */
  public async checkDNC(phoneNumber: string): Promise<DNCCheckResult> {
    const dncEntry = await this.db.query<{ source: DNCSource; reason: string; added_at: string }>(
      `SELECT source, reason, added_at FROM dnc_list
       WHERE phone = $1 LIMIT 1`,
      [phoneNumber]
    );

    if (dncEntry.rows.length > 0) {
      const entry = dncEntry.rows[0];
      return {
        isBlocked: true,
        reason: entry.reason || 'On do-not-call list',
        source: entry.source,
        addedAt: new Date(entry.added_at),
      };
    }

    return {
      isBlocked: false,
      reason: null,
      source: null,
      addedAt: null,
    };
  }

  /**
   * addToDNC()
   * Adds a phone number to the internal DNC list
   * Called when shipper opts out during a call or via email
   */
  public async addToDNC(phoneNumber: string, source: DNCSource, reason?: string): Promise<void> {
    // Insert into DNC list
    await this.db.query(
      `INSERT INTO dnc_list (phone, source, reason, added_by)
       VALUES ($1, $2, $3, 'system')
       ON CONFLICT (phone) DO UPDATE SET
       source = EXCLUDED.source,
       reason = EXCLUDED.reason`,
      [phoneNumber, source, reason || 'Opt-out requested']
    );

    // Revoke all active consent for this number
    await this.db.query(
      `UPDATE consent_log
       SET revoked_at = NOW(), revoked_reason = $2
       WHERE phone = $1 AND revoked_at IS NULL`,
      [phoneNumber, `DNC added: ${source}`]
    );

    // Log to audit trail
    await this.logComplianceAudit(phoneNumber, 'dnc_check', 'block', {
      action: 'added_to_dnc',
      source,
      reason,
    });
  }

  /**
   * ==============================================================================
   * CALLING HOUR RESTRICTIONS
   * ==============================================================================
   */

  /**
   * checkCallingHours()
   * Verifies we're within legal calling windows
   * CASL: 9:00 AM – 9:30 PM local time
   * TCPA: 8:00 AM – 9:00 PM local time
   * Myra standard (more conservative): 9:00 AM – 5:00 PM local time
   * Also: no weekend calls
   */
  public checkCallingHours(
    phoneNumber: string,
    shipperProvince?: string,
    shipperState?: string
  ): CallingHoursResult {
    const now = new Date();
    const timezone = this.resolveTimezone(shipperProvince, shipperState);

    // Get local time in the contact's timezone
    const localTimeString = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const [hoursStr, minutesStr] = localTimeString.split(':');
    const localHour = parseInt(hoursStr, 10);
    const localMinute = parseInt(minutesStr, 10);
    const currentMinutes = localHour * 60 + localMinute;

    // Get day of week
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });
    const dayOfWeek = dayFormatter.format(now);
    const isWeekday = !['Saturday', 'Sunday'].includes(dayOfWeek);

    // Myra standard: 9:00 AM – 5:00 PM (540 – 1020 minutes)
    const windowStart = this.config.myraAIWindowStart;
    const windowEnd = this.config.myraAIWindowEnd;

    const canCallNow = currentMinutes >= windowStart && currentMinutes <= windowEnd && isWeekday;

    // Calculate next valid window if not available now
    let nextValidWindow: Date | null = null;
    if (!canCallNow) {
      nextValidWindow = this.computeNextValidWindow(timezone, windowStart, dayOfWeek, isWeekday);
    }

    return {
      canCallNow,
      timezone,
      localTime: `${localHour}:${minutesStr}`,
      localHour,
      localMinute,
      dayOfWeek,
      isWeekday,
      nextValidWindow,
      reason: canCallNow ? 'Within calling hours' : `Outside calling hours (${localHour}:${minutesStr} in ${timezone})`,
    };
  }

  /**
   * Compute the next valid calling window
   */
  private computeNextValidWindow(timezone: string, windowStart: number, currentDay: string, isWeekday: boolean): Date {
    const now = new Date();

    // If it's currently a weekday, suggest tomorrow at 9 AM
    if (isWeekday) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow;
    }

    // If it's weekend, find next Monday at 9 AM
    const daysUntilMonday = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].indexOf('Monday') - (['Saturday', 'Sunday'].indexOf(currentDay) + 5);
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + (daysUntilMonday < 0 ? 7 + daysUntilMonday : daysUntilMonday));
    nextMonday.setHours(9, 0, 0, 0);
    return nextMonday;
  }

  /**
   * ==============================================================================
   * RECORDING DISCLOSURE
   * ==============================================================================
   */

  /**
   * requiresRecordingDisclosure()
   * Returns whether call recording disclosure is required
   * Two-party consent states require disclosure; others don't
   */
  public requiresRecordingDisclosure(state?: string, province?: string): RecordingDisclosureInfo {
    // Two-party consent US states (T-13 Section 6)
    const twoPartyStates = ['CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'OR', 'PA', 'WA'];

    if (state && twoPartyStates.includes(state.toUpperCase())) {
      return {
        requiresDisclosure: true,
        state,
        disclosureScript: 'Just so you know, this call may be recorded for quality and training purposes.',
      };
    }

    // All Canadian provinces are one-party consent
    if (province) {
      return {
        requiresDisclosure: false,
        province,
        disclosureScript: null,
      };
    }

    return {
      requiresDisclosure: false,
      disclosureScript: null,
    };
  }

  /**
   * ==============================================================================
   * SHIPPER FATIGUE PROTECTION
   * ==============================================================================
   */

  /**
   * checkShipperFatigue()
   * Prevents excessive contact: max 1 call per day, 3 per week, escalates if repeated declines
   */
  public async checkShipperFatigue(phoneNumber: string): Promise<ShipperFatigueResult> {
    // Check calls today (last 24 hours)
    const todayCallsResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM agent_calls
       WHERE phone_number_called = $1
       AND call_initiated_at > NOW() - INTERVAL '24 hours'`,
      [phoneNumber]
    );
    const callsToday = parseInt(todayCallsResult.rows[0]?.count || '0', 10);

    // Check calls this week (last 7 days)
    const weekCallsResult = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM agent_calls
       WHERE phone_number_called = $1
       AND call_initiated_at > NOW() - INTERVAL '7 days'`,
      [phoneNumber]
    );
    const callsThisWeek = parseInt(weekCallsResult.rows[0]?.count || '0', 10);

    // Get shipper fatigue score
    const prefsResult = await this.db.query<{ shipper_fatigue_score: number }>(
      `SELECT shipper_fatigue_score FROM shipper_preferences
       WHERE phone = $1`,
      [phoneNumber]
    );
    const fatigueScore = prefsResult.rows[0]?.shipper_fatigue_score || 0;

    // Apply fatigue rules
    if (callsToday >= this.config.maxCallsPerDay) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);

      return {
        canContact: false,
        fatigueScore,
        reason: `Already called today (${callsToday} call(s))`,
        nextContactDate: tomorrow,
        callsToday,
        callsThisWeek,
      };
    }

    if (callsThisWeek >= this.config.maxCallsPerWeek) {
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      nextWeek.setHours(9, 0, 0, 0);

      return {
        canContact: false,
        fatigueScore,
        reason: `Max weekly contacts reached (${callsThisWeek} call(s))`,
        nextContactDate: nextWeek,
        callsToday,
        callsThisWeek,
      };
    }

    if (fatigueScore >= this.config.fatigueScoreThreshold) {
      const sevenDaysLater = new Date();
      sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
      sevenDaysLater.setHours(9, 0, 0, 0);

      return {
        canContact: false,
        fatigueScore,
        reason: `Fatigue threshold exceeded (score: ${fatigueScore})`,
        nextContactDate: sevenDaysLater,
        callsToday,
        callsThisWeek,
      };
    }

    return {
      canContact: true,
      fatigueScore,
      reason: 'Clear to contact',
      nextContactDate: null,
      callsToday,
      callsThisWeek,
    };
  }

  /**
   * ==============================================================================
   * CONSENT LOGGING (AUDIT TRAIL)
   * ==============================================================================
   */

  /**
   * logConsent()
   * Records new consent with full audit trail
   * Mandatory for CASL 3-year retention requirement
   */
  public async logConsent(
    phoneNumber: string,
    consentType: ConsentType,
    consentSource: ConsentSource,
    consentProof: string,
    expiresAt?: Date
  ): Promise<ConsentLogEntry> {
    const now = new Date();

    // Insert new consent record
    const result = await this.db.query<{
      id: number;
      phone: string;
      consent_type: ConsentType;
      consent_source: ConsentSource;
      consent_date: string;
      consent_proof: string;
      expires_at: string | null;
      revoked_at: null;
      revoked_reason: null;
      created_at: string;
      updated_at: string;
    }>(
      `INSERT INTO consent_log (phone, consent_type, consent_source, consent_date, consent_proof, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (phone) DO UPDATE SET
         consent_type = EXCLUDED.consent_type,
         consent_source = EXCLUDED.consent_source,
         consent_date = EXCLUDED.consent_date,
         consent_proof = EXCLUDED.consent_proof,
         expires_at = EXCLUDED.expires_at,
         revoked_at = NULL
       RETURNING *`,
      [phoneNumber, consentType, consentSource, now, consentProof, expiresAt || null]
    );

    if (result.rows.length === 0) {
      throw new Error(`Failed to log consent for ${phoneNumber}`);
    }

    const entry = result.rows[0];

    // Log to audit trail
    await this.logComplianceAudit(phoneNumber, 'consent_check', 'pass', {
      action: 'consent_logged',
      consentType,
      consentSource,
      expiresAt: expiresAt?.toISOString() || null,
    });

    return {
      id: entry.id,
      phone: entry.phone,
      consentType: entry.consent_type,
      consentSource: entry.consent_source,
      consentDate: new Date(entry.consent_date),
      consentProof: entry.consent_proof,
      expiresAt: entry.expires_at ? new Date(entry.expires_at) : null,
      revokedAt: null,
      revokedReason: null,
      createdAt: new Date(entry.created_at),
      updatedAt: new Date(entry.updated_at),
    };
  }

  /**
   * revokeConsent()
   * Revokes all active consent for a phone number
   */
  public async revokeConsent(phoneNumber: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE consent_log
       SET revoked_at = NOW(), revoked_reason = $2
       WHERE phone = $1 AND revoked_at IS NULL`,
      [phoneNumber, reason]
    );

    // Log to audit trail
    await this.logComplianceAudit(phoneNumber, 'consent_check', 'block', {
      action: 'consent_revoked',
      reason,
    });
  }

  /**
   * ==============================================================================
   * AUDIT LOGGING
   * ==============================================================================
   */

  /**
   * logComplianceAudit()
   * Records every compliance check for regulatory defense
   * Required for CASL/TCPA compliance audits
   */
  private async logComplianceAudit(
    phoneNumber: string,
    checkType: ComplianceAuditLog['checkType'],
    result: 'pass' | 'block' | 'warn',
    details: Record<string, unknown>,
    callId?: string,
    pipelineLoadId?: number
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO compliance_audit (phone, check_type, result, details, pipeline_load_id, call_id, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [phoneNumber, checkType, result, JSON.stringify(details), pipelineLoadId || null, callId || null]
      );
    } catch (error) {
      // Audit logging failures should not block the compliance check
      console.error('Compliance audit log failed:', error);
    }
  }

  /**
   * ==============================================================================
   * HELPER FUNCTIONS
   * ==============================================================================
   */

  /**
   * resolveTimezone()
   * Maps Canadian province or US state to IANA timezone
   */
  private resolveTimezone(province?: string, state?: string): string {
    if (province && this.stateTimezoneMap[province.toUpperCase()]) {
      return this.stateTimezoneMap[province.toUpperCase()];
    }

    if (state && this.stateTimezoneMap[state.toUpperCase()]) {
      return this.stateTimezoneMap[state.toUpperCase()];
    }

    // Default to Ontario/Eastern Time (Myra's home timezone)
    return 'America/Toronto';
  }

  /**
   * buildStateTimezoneMap()
   * Returns complete North American state/province to timezone mapping
   */
  private buildStateTimezoneMap(): StateTimezoneMap {
    return {
      // Canadian provinces
      BC: 'America/Vancouver',
      AB: 'America/Edmonton',
      SK: 'America/Regina',
      MB: 'America/Winnipeg',
      ON: 'America/Toronto',
      QC: 'America/Montreal',
      NB: 'America/Moncton',
      NS: 'America/Halifax',
      PE: 'America/Halifax',
      NL: 'America/St_Johns',
      YT: 'America/Whitehorse',
      NT: 'America/Yellowknife',
      NU: 'America/Iqaluit',

      // US states - Eastern Time
      ME: 'America/New_York',
      NH: 'America/New_York',
      VT: 'America/New_York',
      MA: 'America/New_York',
      RI: 'America/New_York',
      CT: 'America/New_York',
      NY: 'America/New_York',
      NJ: 'America/New_York',
      PA: 'America/New_York',
      DE: 'America/New_York',
      MD: 'America/New_York',
      VA: 'America/New_York',
      WV: 'America/New_York',
      OH: 'America/New_York',
      DC: 'America/New_York',

      // US states - Central Time
      FL: 'America/Chicago',
      GA: 'America/Chicago',
      SC: 'America/Chicago',
      NC: 'America/Chicago',
      TN: 'America/Chicago',
      AL: 'America/Chicago',
      MS: 'America/Chicago',
      LA: 'America/Chicago',
      AR: 'America/Chicago',
      MO: 'America/Chicago',
      IA: 'America/Chicago',
      IL: 'America/Chicago',
      MI: 'America/Chicago',
      IN: 'America/Chicago',
      KY: 'America/Chicago',
      WI: 'America/Chicago',
      MN: 'America/Chicago',
      ND: 'America/Chicago',
      SD: 'America/Chicago',
      NE: 'America/Chicago',
      KS: 'America/Chicago',
      OK: 'America/Chicago',
      TX: 'America/Chicago',

      // US states - Mountain Time
      MT: 'America/Denver',
      WY: 'America/Denver',
      CO: 'America/Denver',
      NM: 'America/Denver',
      UT: 'America/Denver',
      ID: 'America/Denver',

      // US states - Pacific Time
      WA: 'America/Los_Angeles',
      OR: 'America/Los_Angeles',
      CA: 'America/Los_Angeles',
      NV: 'America/Los_Angeles',

      // US states - Alaska/Hawaii
      AK: 'America/Anchorage',
      HI: 'Pacific/Honolulu',
      AZ: 'America/Phoenix', // Arizona doesn't observe DST
    };
  }
}

/**
 * ==============================================================================
 * FACTORY FUNCTION
 * ==============================================================================
 * Helper to instantiate compliance service with default config
 */
export function createComplianceService(db: DatabaseClient, overrideConfig?: Partial<ComplianceConfig>): ComplianceService {
  const defaultConfig: ComplianceConfig = {
    caslWindowStart: 540,      // 9:00 AM
    caslWindowEnd: 1020,       // 5:00 PM (more conservative than regulatory 9:30 PM)
    myraAIWindowStart: 540,    // 9:00 AM
    myraAIWindowEnd: 1020,     // 5:00 PM
    maxCallsPerDay: 1,
    maxCallsPerWeek: 3,
    consecutiveDeclineThreshold: 2,
    fatigueScoreThreshold: 3,
    impliedLoadPostExpiry: 180, // days
    impliedBusinessExpiry: 730, // days (2 years per CASL)
    maxCallAttempts: 2,
    brokerage: {
      name: 'Myra Logistics',
      address: '[Requires physical address per CASL identification requirement]',
      phone: '[Requires contact phone]',
    },
  };

  const finalConfig = { ...defaultConfig, ...overrideConfig };
  return new ComplianceService(db, finalConfig);
}

/**
 * ==============================================================================
 * EXPORTS
 * ==============================================================================
 */
export type { DatabaseClient };
