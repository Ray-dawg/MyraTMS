// lib/documents/tender-terms.ts
//
// T-30 §3.1/§9 — sibling to rate-con-terms.ts, not a shared function: a
// freight tender needs equipment type and commodity that quotePricing()
// requires as inputs, which a rate confirmation doesn't. Same isolated
// Anthropic client (not ClaudeService), same exception-safe discipline —
// every failure path returns null, never throws.
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

export interface ExtractedTenderTerms {
  rate: number | null;
  rateCurrency: 'CAD' | 'USD' | null;
  originCity: string | null;
  originState: string | null;
  originCountry: 'US' | 'CA' | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationCountry: 'US' | 'CA' | null;
  equipmentType: string | null;
  commodity: string | null;
  weightLbs: number | null;
  pickupDate: string | null;
}

const EXTRACTION_PROMPT = `This PDF is a freight tender/rate offer sent by a shipper directly to a freight broker, not a reply to any prior negotiation. Extract exactly these fields as JSON, with no other text in your response:
{"rate": <number, the all-in rate offered in dollars, or null if not found>,
 "rateCurrency": <"CAD" or "USD", or null if not indicated (assume USD if the document is silent and all addresses are US)>,
 "originCity": <string, pickup city, or null>, "originState": <string, 2-letter state/province code, or null>, "originCountry": <"US" or "CA", or null>,
 "destinationCity": <string, delivery city, or null>, "destinationState": <string, 2-letter state/province code, or null>, "destinationCountry": <"US" or "CA", or null>,
 "equipmentType": <string, e.g. "Dry Van"/"Reefer"/"Flatbed", or null if not specified>,
 "commodity": <string, what's being shipped, or null>,
 "weightLbs": <number, total weight in pounds, or null>,
 "pickupDate": <string in YYYY-MM-DD format, or null>}`;

export async function extractTenderTerms(pdfBuffer: Buffer): Promise<ExtractedTenderTerms | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('[tender-terms] ANTHROPIC_API_KEY not set — cannot extract, returning null');
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) return null;

    const parsed = JSON.parse(textBlock.text.trim());
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const country = (v: unknown): 'US' | 'CA' | null => (v === 'US' || v === 'CA' ? v : null);
    const currency = (v: unknown): 'CAD' | 'USD' | null => (v === 'CAD' || v === 'USD' ? v : null);

    return {
      rate: typeof parsed.rate === 'number' ? parsed.rate : null,
      rateCurrency: currency(parsed.rateCurrency),
      originCity: str(parsed.originCity),
      originState: str(parsed.originState),
      originCountry: country(parsed.originCountry),
      destinationCity: str(parsed.destinationCity),
      destinationState: str(parsed.destinationState),
      destinationCountry: country(parsed.destinationCountry),
      equipmentType: str(parsed.equipmentType),
      commodity: str(parsed.commodity),
      weightLbs: typeof parsed.weightLbs === 'number' ? parsed.weightLbs : null,
      pickupDate: str(parsed.pickupDate),
    };
  } catch (err) {
    logger.error('[tender-terms] extraction failed', err);
    return null;
  }
}
