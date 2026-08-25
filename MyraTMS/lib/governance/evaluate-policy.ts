import type {
  CoBrokerAgreementRow,
  PolicyEvaluationLoad,
  PolicyEvaluationResult,
  TenantPolicyRow,
} from './policy-types';

/**
 * Pure decision core (T-19 §5, steps 2-3). No I/O — mirrors T-18's
 * applyEnvelope()/evaluate.ts split: this function is what the ≥15 required
 * test scenarios target directly; the DB wrapper (evaluate-policy-db.ts)
 * loads the policy row and co-broker agreements, calls this, and logs the
 * result.
 */
export function applyPolicy(
  policy: TenantPolicyRow,
  load: PolicyEvaluationLoad,
  activeCoBrokerAgreements: CoBrokerAgreementRow[],
): PolicyEvaluationResult {
  // Step 2: geographic scope.
  if (policy.geographic_scope?.domestic_only) {
    const countries = policy.geographic_scope.countries ?? [];
    if (!countries.includes(load.originCountry) || !countries.includes(load.destinationCountry)) {
      return {
        decision: 'reject',
        reason: `geographic scope: domestic-only policy restricts to [${countries.join(', ')}], load spans ${load.originCountry}->${load.destinationCountry}`,
        policyId: policy.id,
      };
    }
  }

  // Step 3: load-source policy.
  switch (policy.load_source_policy) {
    case 'any':
      return { decision: 'accept', reason: 'load_source_policy=any: all sources accepted', policyId: policy.id };

    case 'broker_or_shipper_direct':
      return {
        decision: 'accept',
        reason: 'load_source_policy=broker_or_shipper_direct: all sources accepted',
        policyId: policy.id,
      };

    case 'shipper_direct_or_coBroker': {
      if (load.isDirect) {
        return { decision: 'accept', reason: 'shipper-direct load', policyId: policy.id };
      }
      const hasAgreement = activeCoBrokerAgreements.some(
        (a) => a.status === 'active' && a.counterparty_mc_number === load.postingCompanyMcNumber,
      );
      if (hasAgreement) {
        return {
          decision: 'accept',
          reason: `broker-posted load accepted: active co-broker agreement with MC ${load.postingCompanyMcNumber}`,
          policyId: policy.id,
        };
      }
      return {
        decision: 'reject',
        reason: `broker-posted load with no active co-broker agreement (posting source: ${load.postingSource})`,
        policyId: policy.id,
      };
    }

    case 'inherit':
      // acquired_opco tenants should already be resolved to a concrete
      // policy at tenant_policies creation time (E3-00 §4.2) — 'inherit'
      // reaching here means the tenant was never migrated off the template
      // default. Fail closed rather than silently accepting.
      return {
        decision: 'reject',
        reason: `tenant policy is 'inherit' — not resolved to a concrete load_source_policy`,
        policyId: policy.id,
      };

    default:
      return {
        decision: 'reject',
        reason: `unrecognized load_source_policy '${policy.load_source_policy}'`,
        policyId: policy.id,
      };
  }
}
