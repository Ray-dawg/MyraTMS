// lib/documents/rate-con-terms.ts
//
// T-26 §4.4/criteria 2-3 — new, isolated Claude-based PDF term extraction
// and pure comparison. Deliberately NOT built on lib/pipeline/claude-service.ts's
// ClaudeService: neither of its two methods (research(), parseCall()) takes
// a PDF document input, and that class already has documented reliability
// issues (T-21/T-22 trackers) unrelated to this module. This file
// instantiates its own minimal Anthropic client instead — same SDK,
// isolated blast radius. Every failure path returns null/'unparseable'
// rather than throwing, matching this codebase's exception-safe discipline
// for anything derived, not authoritative.

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

export interface ExtractedTerms {
  rate: number | null;
  origin: string | null;
  destination: string | null;
  pickupDate: string | null;
}

export interface NegotiatedTerms {
  rate: number;
  origin: string;
  destination: string;
  pickupDate: string;
}

const EXTRACTION_PROMPT = `This PDF is a freight rate confirmation issued by a shipper. Extract exactly these fields as JSON, with no other text in your response:
{"rate": <number, the all-in rate in dollars, or null if not found>, "origin": <string, pickup city, or null>, "destination": <string, delivery city, or null>, "pickupDate": <string in YYYY-MM-DD format, or null>}`;

export async function extractRateConTerms(pdfBuffer: Buffer): Promise<ExtractedTerms | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('[rate-con-terms] ANTHROPIC_API_KEY not set — cannot extract, returning null');
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
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
    return {
      rate: typeof parsed.rate === 'number' ? parsed.rate : null,
      origin: typeof parsed.origin === 'string' ? parsed.origin : null,
      destination: typeof parsed.destination === 'string' ? parsed.destination : null,
      pickupDate: typeof parsed.pickupDate === 'string' ? parsed.pickupDate : null,
    };
  } catch (err) {
    logger.error('[rate-con-terms] extraction failed', err);
    return null;
  }
}

export function compareTerms(extracted: ExtractedTerms | null, negotiated: NegotiatedTerms): 'match' | 'mismatch' | 'unparseable' {
  if (!extracted || extracted.rate === null || extracted.origin === null || extracted.destination === null || extracted.pickupDate === null) {
    return 'unparseable';
  }

  const rateMatches = Math.abs(extracted.rate - negotiated.rate) < 1.0;
  const laneMatches = extracted.origin === negotiated.origin && extracted.destination === negotiated.destination;
  const dateMatches = extracted.pickupDate === negotiated.pickupDate;

  return rateMatches && laneMatches && dateMatches ? 'match' : 'mismatch';
}
