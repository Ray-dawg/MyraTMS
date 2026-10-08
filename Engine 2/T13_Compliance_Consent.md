# T-13: COMPLIANCE & CONSENT INFRASTRUCTURE

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

This document specifies the compliance infrastructure that must be live BEFORE any automated outbound calls are made. It covers CASL (Canada's Anti-Spam Legislation), TCPA (US Telephone Consumer Protection Act), consent tracking, do-not-call management, call recording disclosure, and calling hour restrictions. A single compliance violation can result in fines up to $10M CAD (CASL) or $1,500 USD per call (TCPA). This is not optional.

---

## 1. Regulatory Framework Summary

### CASL (Canada)

| Requirement | Detail |
|---|---|
| **Scope** | ALL commercial electronic messages and calls |
| **Consent for load board calls** | Implied consent — shipper posted on a public load board, inviting broker contact |
| **Consent for cold outreach** | Explicit written consent required before calling |
| **Identification** | Must state caller name, company name, and physical address |
| **Opt-out** | Must offer free, easy opt-out mechanism on every call |
| **Record keeping** | Must retain consent proof for 3 years |
| **Penalties** | Up to $10M CAD per violation for organizations |
| **Implied consent expiry** | 2 years from last business transaction OR 6 months from inquiry |

### TCPA (United States)

| Requirement | Detail |
|---|---|
| **Scope** | Calls to cell phones using automated dialing systems |
| **Consent for load board calls** | Implied — shipper listed phone number on load board |
| **Consent for cold outreach** | Prior express consent required for cell phones |
| **Do-not-call** | Must maintain internal DNC list and honor national DNC registry |
| **Calling hours** | 8:00 AM – 9:00 PM local time of called party |
| **Recording disclosure** | Varies by state (one-party vs. two-party consent) |
| **Penalties** | $500–$1,500 per violation |

### Key Decision: Apply CASL Standard Everywhere

CASL is stricter than TCPA. By building to CASL standard, Myra is automatically compliant with TCPA. This simplifies the implementation: one compliance framework, two countries covered.

---

## 2. Consent Types and Their Application

| Consent Type | When It Applies | Proof Required | Expiry |
|---|---|---|---|
| `implied_load_post` | Shipper posted a load on a public load board with contact info | Load board posting record (load ID, timestamp, source) | 6 months from posting date |
| `implied_business` | Existing business relationship (shipper has used Myra before) | TMS load history showing completed transaction | 2 years from last transaction |
| `explicit_written` | Cold outreach to shippers not on load boards | Signed consent form, email opt-in, or web form submission | Until revoked |
| `explicit_verbal` | Consent obtained during a live call | Call recording with timestamp of verbal consent | Until revoked, but document immediately |
| `opt_in_form` | Shipper submitted Myra's get-started form on website | Form submission record with timestamp | Until revoked |

### What This Means for Each Call Type

**Load board calls (Engine 2):** Consent is implied by the load posting. The shipper made their phone number publicly available for the specific purpose of receiving calls about that load. No additional consent needed. BUT: store the load posting as consent proof.

**Corridor outreach calls (Engine 1):** If calling a shipper who has NOT posted on a load board and has NO existing business relationship, explicit consent is required first. This means email opt-in, web form, or explicit verbal consent from a previous conversation.

**Carrier recruitment calls:** Carriers listing their services publicly (FMCSA database, Google business listing, load board truck postings) have implied consent for business contact. Same standard as load board calls.

---

## 3. The checkConsentStatus() Function

This function is called BEFORE every outbound call. It returns a clear go/no-go decision.

```typescript
interface ConsentCheckResult {
  canCall: boolean;
  consentType: string | null;
  consentSource: string | null;
  reason: string;
  requiresDisclosure: boolean;
  disclosureScript: string | null;
}

async function checkConsentStatus(
  phone: string,
  callType: 'load_booking' | 'shipper_outreach' | 'carrier_recruitment',
  loadBoardSource?: string,
  loadId?: string
): Promise<ConsentCheckResult> {
  
  // Step 1: Check DNC list (always first — overrides everything)
  const isDNC = await db.query(
    'SELECT 1 FROM dnc_list WHERE phone = $1',
    [phone]
  );
  if (isDNC.rows.length > 0) {
    return {
      canCall: false,
      consentType: null,
      consentSource: null,
      reason: 'Phone number is on do-not-call list',
      requiresDisclosure: false,
      disclosureScript: null
    };
  }
  
  // Step 2: Check for revoked consent
  const revokedConsent = await db.query(
    `SELECT 1 FROM consent_log 
     WHERE phone = $1 AND revoked_at IS NOT NULL 
     ORDER BY revoked_at DESC LIMIT 1`,
    [phone]
  );
  if (revokedConsent.rows.length > 0) {
    return {
      canCall: false,
      consentType: null,
      consentSource: null,
      reason: 'Consent previously revoked',
      requiresDisclosure: false,
      disclosureScript: null
    };
  }
  
  // Step 3: Call-type-specific consent check
  
  if (callType === 'load_booking') {
    // Implied consent from load board posting
    // Record the consent
    await db.query(
      `INSERT INTO consent_log 
       (phone, consent_type, consent_source, consent_date, consent_proof, expires_at)
       VALUES ($1, 'implied_load_post', $2, NOW(), $3, NOW() + INTERVAL '6 months')
       ON CONFLICT DO NOTHING`,
      [phone, loadBoardSource || 'unknown', `Load ID: ${loadId || 'unknown'}`]
    );
    
    return {
      canCall: true,
      consentType: 'implied_load_post',
      consentSource: loadBoardSource || 'load_board',
      reason: 'Implied consent via load board posting',
      requiresDisclosure: false,
      disclosureScript: null
    };
  }
  
  if (callType === 'shipper_outreach') {
    // Requires explicit consent OR existing business relationship
    const validConsent = await db.query(
      `SELECT consent_type, consent_source FROM consent_log 
       WHERE phone = $1 
       AND revoked_at IS NULL 
       AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY consent_date DESC LIMIT 1`,
      [phone]
    );
    
    if (validConsent.rows.length === 0) {
      return {
        canCall: false,
        consentType: null,
        consentSource: null,
        reason: 'No valid consent for cold shipper outreach. Explicit consent required.',
        requiresDisclosure: false,
        disclosureScript: null
      };
    }
    
    return {
      canCall: true,
      consentType: validConsent.rows[0].consent_type,
      consentSource: validConsent.rows[0].consent_source,
      reason: 'Valid consent found',
      requiresDisclosure: true,
      disclosureScript: 'This call is from Myra Logistics, located at [ADDRESS]. If you prefer not to receive calls from us, let me know and I will remove your number immediately.'
    };
  }
  
  if (callType === 'carrier_recruitment') {
    // Implied consent from public business listing
    return {
      canCall: true,
      consentType: 'implied_business',
      consentSource: 'public_listing',
      reason: 'Carrier has public business listing',
      requiresDisclosure: false,
      disclosureScript: null
    };
  }
  
  return {
    canCall: false,
    consentType: null,
    consentSource: null,
    reason: 'Unknown call type',
    requiresDisclosure: false,
    disclosureScript: null
  };
}
```

---

## 4. Do-Not-Call Management

### Adding to DNC List

Numbers are added to the DNC list from three sources:

**1. During a call (opt-out):** When the voice agent detects the shipper requesting removal ("don't call me again", "take me off your list", "stop calling"), the agent responds with confirmation and the number is added immediately.

```typescript
async function addToDNC(phone: string, source: string, reason?: string): Promise<void> {
  await db.query(
    `INSERT INTO dnc_list (phone, source, reason, added_by)
     VALUES ($1, $2, $3, 'system')
     ON CONFLICT (phone) DO NOTHING`,
    [phone, source, reason || 'Opt-out requested']
  );
  
  // Also revoke all active consent
  await db.query(
    `UPDATE consent_log SET revoked_at = NOW(), revoked_reason = $2
     WHERE phone = $1 AND revoked_at IS NULL`,
    [phone, `DNC added: ${source}`]
  );
}
```

**2. Manual entry:** Patrice manually adds a number (e.g., after a complaint).

**3. Regulatory import:** Periodic import from CRTC National Do Not Call List (Canada) and FTC National Do Not Call Registry (US). Frequency: monthly.

### DNC Check Performance

The DNC check must be fast — it runs before every call. Index on `phone` column ensures O(1) lookup. At scale (10,000+ numbers), consider a Redis set for sub-millisecond lookups.

---

## 5. Calling Hour Restrictions

### Rules

- **Canada:** 9:00 AM – 9:30 PM local time (CRTC Telecom Rules)
- **United States:** 8:00 AM – 9:00 PM local time (TCPA)
- **Myra standard:** 9:00 AM – 5:00 PM local time for AI calls (more conservative to avoid annoyance)
- **Patrice manual calls:** 8:00 AM – 6:00 PM local time

### Implementation

```typescript
interface CallingHoursResult {
  canCallNow: boolean;
  nextValidWindow: string | null;  // ISO timestamp of when calling becomes valid
  timezone: string;
  localTime: string;
}

function checkCallingHours(
  phone: string,
  shipperProvince?: string,
  shipperState?: string
): CallingHoursResult {
  // Determine timezone from province/state
  const timezone = resolveTimezone(shipperProvince, shipperState, phone);
  
  const now = new Date();
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).format(now);
  
  const [hours, minutes] = localTime.split(':').map(Number);
  const currentMinutes = hours * 60 + minutes;
  
  // Myra standard: 9:00 AM – 5:00 PM (540 – 1020 minutes)
  const windowStart = 540;  // 9:00 AM
  const windowEnd = 1020;   // 5:00 PM
  
  const canCallNow = currentMinutes >= windowStart && currentMinutes <= windowEnd;
  
  // Also check day of week — no calls on weekends
  const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' });
  const isWeekday = !['Saturday', 'Sunday'].includes(dayOfWeek);
  
  return {
    canCallNow: canCallNow && isWeekday,
    nextValidWindow: canCallNow && isWeekday ? null : computeNextWindow(timezone, windowStart),
    timezone,
    localTime
  };
}

function resolveTimezone(province?: string, state?: string, phone?: string): string {
  // Canadian provinces
  const canadianTimezones: Record<string, string> = {
    'BC': 'America/Vancouver',
    'AB': 'America/Edmonton',
    'SK': 'America/Regina',
    'MB': 'America/Winnipeg',
    'ON': 'America/Toronto',
    'QC': 'America/Montreal',
    'NB': 'America/Moncton',
    'NS': 'America/Halifax',
    'PE': 'America/Halifax',
    'NL': 'America/St_Johns',
    'YT': 'America/Whitehorse',
    'NT': 'America/Yellowknife',
    'NU': 'America/Iqaluit',
  };
  
  if (province && canadianTimezones[province]) return canadianTimezones[province];
  
  // US states — simplified (major zones)
  // In production, use a full state-to-timezone mapping
  if (state) {
    // Eastern: NY, NJ, PA, OH, GA, FL, etc.
    // Central: IL, TX, MN, WI, etc.
    // Mountain: CO, AZ, MT, etc.
    // Pacific: CA, WA, OR, NV
    // Use a complete mapping library
  }
  
  // Fallback: assume Eastern for Ontario-focused business
  return 'America/Toronto';
}
```

### Queue Integration

When `checkCallingHours` returns `canCallNow: false`, the call-queue job is delayed until `nextValidWindow`. BullMQ handles this natively with the `delay` option.

---

## 6. Call Recording Disclosure

### When Disclosure Is Required

| Jurisdiction | Recording Consent | Disclosure Needed? |
|---|---|---|
| **Ontario** | One-party consent | No — Myra is a party to the call |
| **Quebec** | One-party consent | No |
| **British Columbia** | One-party consent | No |
| **Most Canadian provinces** | One-party consent | No |
| **Most US states** | One-party consent | No |
| **California** | Two-party consent | YES |
| **Florida** | Two-party consent | YES |
| **Illinois** | Two-party consent | YES |
| **Maryland** | Two-party consent | YES |
| **Other two-party states** | Two-party consent | YES |

### Two-Party Consent States (US)

California, Connecticut, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana, Nevada, New Hampshire, Oregon, Pennsylvania, Washington.

### Implementation

For calls to two-party consent jurisdictions, the voice agent must include a disclosure in the opening:

> "Just so you know, this call may be recorded for quality and training purposes."

This is injected into the Retell prompt via the `compliance.disclosureScript` field in the negotiation brief.

```typescript
function requiresRecordingDisclosure(state?: string, province?: string): boolean {
  const twoPartyStates = [
    'CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 
    'NV', 'NH', 'OR', 'PA', 'WA'
  ];
  
  if (state && twoPartyStates.includes(state.toUpperCase())) return true;
  
  // All Canadian provinces are one-party consent
  return false;
}
```

---

## 7. CASL-Compliant Call Opening

For shipper outreach calls (not load board calls), CASL requires:

1. Caller identifies themselves by name
2. Caller identifies the organization and its physical address
3. Caller provides an opt-out mechanism

### Required Opening for Outreach Calls

> "Hi, this is [AGENT NAME] from Myra Logistics. Our office is at [PHYSICAL ADDRESS]. I'm calling about [PURPOSE]. If you'd prefer not to receive calls from us, just let me know and I'll remove your number immediately."

This is included in the persona prompt template for outreach calls and in the `compliance.disclosureScript` field of the negotiation brief.

### Not Required for Load Board Calls

Load board calls reference a specific load posting — the shipper initiated the contact by publishing their phone number. The standard broker introduction is sufficient:

> "Hi, this is [AGENT NAME] from Myra Logistics. I'm calling about the load you posted on [LOAD BOARD], load ID [LOAD ID]."

---

## 8. Shipper Fatigue Protection

Beyond legal compliance, Myra implements its own contact frequency limits to protect shipper relationships.

### Rules

| Rule | Threshold | Action |
|---|---|---|
| Max calls to same phone per day | 1 | Block additional calls |
| Max calls to same phone per week | 3 | Block additional calls |
| Consecutive declines without booking | 2 | Flag as "needs different approach" — wait 7 days |
| Fatigue score ≥ 3 | Automatic | Wait 7 days before any contact |
| Same load re-contact | Never | If a load was declined, never call about that same load ID again |

### Implementation

```typescript
async function checkShipperFatigue(phone: string): Promise<{
  canContact: boolean;
  reason: string;
  nextContactDate: string | null;
}> {
  // Check calls today
  const todayCalls = await db.query(
    `SELECT COUNT(*) FROM agent_calls 
     WHERE phone_number_called = $1 
     AND call_initiated_at > NOW() - INTERVAL '24 hours'`,
    [phone]
  );
  if (parseInt(todayCalls.rows[0].count) >= 1) {
    return { canContact: false, reason: 'Already called today', nextContactDate: tomorrow() };
  }
  
  // Check calls this week
  const weekCalls = await db.query(
    `SELECT COUNT(*) FROM agent_calls 
     WHERE phone_number_called = $1 
     AND call_initiated_at > NOW() - INTERVAL '7 days'`,
    [phone]
  );
  if (parseInt(weekCalls.rows[0].count) >= 3) {
    return { canContact: false, reason: 'Max weekly contacts reached', nextContactDate: nextWeek() };
  }
  
  // Check fatigue score
  const prefs = await db.query(
    'SELECT shipper_fatigue_score FROM shippers WHERE phone = $1',
    [phone]
  );
  if (prefs.rows.length > 0 && prefs.rows[0].shipper_fatigue_score >= 3) {
    return { canContact: false, reason: 'Fatigue threshold exceeded', nextContactDate: inDays(7) };
  }
  
  return { canContact: true, reason: 'Clear to contact', nextContactDate: null };
}
```

---

## 9. Audit Trail

Every compliance-relevant action is logged for regulatory defense:

| Event | What's Logged | Retention |
|---|---|---|
| Consent established | Phone, consent type, source, proof, timestamp | 3 years (CASL) |
| Consent revoked | Phone, revocation method, timestamp | 3 years |
| DNC addition | Phone, source, reason, timestamp | Indefinite |
| DNC check (per call) | Phone, result, timestamp | 1 year |
| Calling hours check | Phone, timezone, local time, result | 1 year |
| Recording disclosure | Phone, state/province, disclosed Y/N | 1 year |
| Fatigue check | Phone, fatigue score, result | 1 year |
| Opt-out detected in call | Phone, call ID, transcript excerpt | 3 years |

### All checks are logged in agent_jobs or a dedicated compliance_audit table:

```sql
CREATE TABLE compliance_audit (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(30) NOT NULL,
    check_type VARCHAR(30) NOT NULL,
    result VARCHAR(20) NOT NULL,
    details JSONB,
    pipeline_load_id INTEGER,
    call_id VARCHAR(100),
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_compliance_phone ON compliance_audit(phone);
CREATE INDEX idx_compliance_type ON compliance_audit(check_type, checked_at DESC);
```

---

## 10. Pre-Launch Legal Checklist

Before any automated calls go live, confirm:

- [ ] CASL compliance reviewed by legal counsel
- [ ] TCPA compliance reviewed by legal counsel (if calling US numbers)
- [ ] Call recording disclosure implemented for two-party consent states
- [ ] DNC list management system tested
- [ ] Consent tracking system tested
- [ ] Calling hour restrictions tested across all target timezones
- [ ] Opt-out mechanism tested (agent correctly detects and processes opt-out requests)
- [ ] CASL-compliant opening script configured for outreach calls
- [ ] Shipper fatigue limits configured and tested
- [ ] Audit trail logging confirmed operational
- [ ] Data retention policies documented and implemented
- [ ] Physical business address ready for CASL identification requirement
- [ ] Budget $5,000–$10,000 CAD for legal review

---

*End of document. Compliance is not negotiable. Build it first, test it thoroughly, get legal sign-off before the first automated call.*
