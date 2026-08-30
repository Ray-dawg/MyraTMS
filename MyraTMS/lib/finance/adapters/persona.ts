// lib/finance/adapters/persona.ts
import { db } from '@/lib/pipeline/db-adapter';

export interface KycVerificationResult {
  environment: 'sandbox';
  personaReferenceId: string;
  verificationStatus: 'pending';
}

export function verifyKycSandbox(): KycVerificationResult {
  return {
    environment: 'sandbox',
    personaReferenceId: `SANDBOX-PERSONA-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    verificationStatus: 'pending',
  };
}

export async function recordKycVerification(
  entityType: 'carrier' | 'payer',
  entityId: number,
  result: KycVerificationResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO kyc_verifications
       (entity_type, entity_id, verification_status, persona_reference_id, environment)
     VALUES ($1, $2, $3, $4, 'sandbox')
     RETURNING id`,
    [entityType, entityId, result.verificationStatus, result.personaReferenceId],
  );
  return rows[0].id;
}
