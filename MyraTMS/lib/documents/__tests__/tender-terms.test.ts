// lib/documents/__tests__/tender-terms.test.ts
import { describe, it, expect } from 'vitest';
import { extractTenderTerms } from '@/lib/documents/tender-terms';

describe('extractTenderTerms (acceptance criterion 3)', () => {
  it('returns null (never throws) when ANTHROPIC_API_KEY is missing', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractTenderTerms(Buffer.from('fake-pdf-bytes'));
    expect(result).toBeNull();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });

  it('returns null (never throws) on a real API call against a non-PDF buffer', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return; // honest skip, same as rate-con-terms's own suite when no key is configured locally
    const result = await extractTenderTerms(Buffer.from('this is plainly not a PDF'));
    expect(result).toBeNull();
  }, 30000);
});
