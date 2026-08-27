//
// Verbatim ports of compiler-worker.ts's private FORMATTING HELPERS section
// (lines 707-802) — copied, not imported, per this plan's constraint that
// compiler-worker.ts is off-limits. isWithinCallingHours is NOT duplicated
// here: it's already a shared export (lib/pipeline/time.ts) that
// compiler-worker.ts itself imports rather than reimplementing — see Task 9.

export function normalizeEquipment(raw: string): string {
  const lower = (raw || '').toLowerCase();
  if (lower.includes('flat')) return 'flatbed';
  if (lower.includes('reefer') || lower.includes('refrigerated')) return 'reefer';
  if (lower.includes('step')) return 'step_deck';
  if (lower.includes('tanker')) return 'tanker';
  if (lower.includes('lowboy')) return 'lowboy';
  if (lower.includes('container')) return 'container';
  return 'dry_van';
}

export function equipmentDisplayName(raw: string): string {
  const norm = normalizeEquipment(raw);
  const map: Record<string, string> = {
    dry_van: 'dry van', flatbed: 'flatbed', reefer: 'reefer', step_deck: 'step deck',
    tanker: 'tanker', lowboy: 'lowboy', container: 'container', van: 'van',
  };
  return map[norm] ?? 'dry van';
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export function formatDateLong(d: Date): string {
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  const date = d.getDate();
  return `${day} ${month} ${date}${ordinalSuffix(date)}`;
}

export function formatPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function formatCurrencyDisplay(amount: number, currency: 'CAD' | 'USD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(amount);
}

export function timezoneForState(_phone: string, state: string): string {
  const easternStates = new Set(['ON', 'QC', 'NY', 'NJ', 'PA', 'CT', 'MA', 'NH', 'VT', 'ME', 'RI', 'NB', 'NS', 'PE']);
  const centralStates = new Set(['MB', 'TX', 'IL', 'MN', 'WI', 'MO', 'IA', 'AR', 'OK', 'KS', 'NE']);
  const mountainStates = new Set(['AB', 'SK', 'CO', 'AZ', 'UT', 'NM', 'WY', 'MT', 'ID']);
  const pacificStates = new Set(['BC', 'CA', 'OR', 'WA', 'NV']);
  if (easternStates.has(state)) return 'America/Toronto';
  if (centralStates.has(state)) return 'America/Chicago';
  if (mountainStates.has(state)) return 'America/Denver';
  if (pacificStates.has(state)) return 'America/Los_Angeles';
  return 'America/Toronto';
}
