import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { compileEnvelope } from '@/lib/negotiation';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/pricing/pricing-engine', () => ({
  quotePricing: vi.fn().mockResolvedValue({
    rates: { floorRate: 1800, midRate: 2200, bestRate: 2600, confidence: 0.7, sources: ['benchmark'], currency: 'CAD' },
    cost: { baseCost: 1500, deadheadCost: 100, fuelSurcharge: 100, accessorials: 50, adminOverhead: 35, crossBorderFees: 0, factoringFee: 30, total: 1815 },
    negotiation: { direction: 'sell', openingOffer: 2470, concessionStep1: 2313, concessionStep2: 2156, finalOffer: 2085, walkAwayRate: 2085, marginEnvelope: { floor: 270, target: 470, stretch: 675 }, currency: 'CAD' },
    marginSourceUsed: 'myra_default',
  }),
}));

describe('compileEnvelope', () => {
  it('produces direction=sell brief with counterpartyType=shipper', async () => {
    (db.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM pipeline_loads')) {
        return Promise.resolve({ rows: [{
          id: 99, load_id: 'DAT-1', origin_city: 'Toronto', origin_state: 'ON', origin_country: 'CA',
          destination_city: 'Montreal', destination_state: 'QC', destination_country: 'CA',
          pickup_date: new Date(Date.now() + 72 * 3600_000), delivery_date: null,
          equipment_type: 'Dry Van', commodity: null, weight_lbs: null,
          distance_miles: 340, distance_km: 547,
          shipper_phone: '+17055551234', shipper_company: 'Acme', shipper_contact_name: 'Jo', shipper_email: null,
          posted_rate: null,
        }] });
      }
      if (sql.includes('FROM personas')) {
        return Promise.resolve({ rows: [{ id: 1, persona_name: 'friendly', alpha: '1', beta: '1', total_calls: 0, retell_agent_id_en: 'agent_1', retell_agent_id_fr: null }] });
      }
      if (sql.includes('FROM objection_playbook')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM shipper_preferences')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM agent_calls')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM dnc_list')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const brief = await compileEnvelope({ tenantId: 2, direction: 'sell', pipelineLoadId: 99, counterpartyId: 0 });
    expect(brief.meta.direction).toBe('sell');
    expect(brief.counterparty.counterpartyType).toBe('shipper');
    expect(brief.pricing.openingOffer).toBe(2470);
  });
});
