// lib/risk/banking-change-detection.ts
//
// T-25 §4.5 — detection + recording only, per this module's explicit scope:
// zero wiring into dispatcher-worker.ts. Reuses T-24's exported
// bridgeToExceptions() rather than re-implementing dedup/classification —
// this is the module's entire integration surface with T-24, no changes to
// T-24's own pollers.

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

export interface BankingDetails {
  bankName: string;
  routingNumber: string;
  accountNumberLast4: string;
}

function bankingDetailsMatch(a: BankingDetails, b: BankingDetails): boolean {
  return a.bankName === b.bankName && a.routingNumber === b.routingNumber && a.accountNumberLast4 === b.accountNumberLast4;
}

export async function checkBankingChange(
  carrierRegistryId: number,
  incoming: BankingDetails,
): Promise<{ halted: boolean; loadsHalted: number[] }> {
  const onFileRes = await db.query<{ bank_name: string; routing_number: string; account_number_last4: string }>(
    `SELECT bank_name, routing_number, account_number_last4 FROM carrier_banking_details WHERE carrier_registry_id = $1`,
    [carrierRegistryId],
  );
  if (onFileRes.rows.length === 0) {
    return { halted: false, loadsHalted: [] }; // nothing on file yet — first recording, not a change
  }

  const onFile: BankingDetails = {
    bankName: onFileRes.rows[0].bank_name,
    routingNumber: onFileRes.rows[0].routing_number,
    accountNumberLast4: onFileRes.rows[0].account_number_last4,
  };
  if (bankingDetailsMatch(onFile, incoming)) {
    return { halted: false, loadsHalted: [] };
  }

  const activeRes = await db.query<{ id: number }>(
    `SELECT pl.id FROM pipeline_loads pl
       JOIN loads l ON l.pipeline_load_id = pl.id
       JOIN carriers c ON c.id = l.carrier_id
      WHERE c.carrier_registry_id = $1 AND l.status NOT IN ('Delivered', 'Invoiced', 'Closed')`,
    [carrierRegistryId],
  );
  if (activeRes.rows.length === 0) {
    return { halted: false, loadsHalted: [] };
  }

  const tenantId = await getMyraTenantId();
  const loadsHalted: number[] = [];
  for (const row of activeRes.rows) {
    try {
      await db.query(
        `INSERT INTO transaction_halts (pipeline_load_id, halt_reason, halt_detail, halted_by)
         VALUES ($1, 'banking_change_detected', $2, 'system_auto')`,
        [row.id, JSON.stringify({ onFile, incoming })],
      );
      await bridgeToExceptions({
        tenantId,
        sourceModule: 'transaction_halt',
        exceptionType: 'banking_change_detected',
        title: `Banking change detected — carrier_registry_id=${carrierRegistryId}, pipeline load ${row.id}`,
        description: 'Incoming carrier banking details differ from what is on file while this load is active. Transaction halted pending human review.',
        context: {},
        pipelineLoadId: row.id,
        loadId: null,
        carrierId: null,
      });
      loadsHalted.push(row.id);
    } catch (err) {
      logger.error('[risk/banking-change-detection] failed to record halt', err);
    }
  }
  return { halted: loadsHalted.length > 0, loadsHalted };
}
