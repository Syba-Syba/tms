import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  canEncode,
  printable,
  renderExitStatementPdf,
  renderInspectionPdf,
  renderInvoicePdf,
  renderLeasePdf,
} from '../lib/pdf';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** The characters that used to make every render throw, in one string. */
const HOSTILE = 'Ṱhavhanyedza 😀\nline two\tTab ṋ Ẹ “quotes” — R 1 234,56 ​ zero-width';
const LONG_TOKEN = 'X'.repeat(260);
const LONG_DESCRIPTION =
  'Replacement of the kitchen cupboard doors, hinges and handles damaged beyond fair wear and tear, including the repainting of the surrounding wall and the removal of the old units from the premises.';

const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.slice(0, 5)).toString() === '%PDF-';

describe('printable', () => {
  it('matches what Helvetica can actually encode, code point by code point', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let codePoint = 0x20; codePoint < 0x3000; codePoint += 1) {
      let encodable = true;
      try {
        font.encodeText(String.fromCodePoint(codePoint));
      } catch {
        encodable = false;
      }
      expect(canEncode(codePoint), `U+${codePoint.toString(16)}`).toBe(encodable);
    }
  });

  it('keeps Latin letters with accents, falls back to the base letter, then to ?', () => {
    expect(printable('Mokoena Propriétés')).toBe('Mokoena Propriétés');
    expect(printable('Ṱhavhanyedza')).toBe('Thavhanyedza');
    expect(printable('Ẹ ṋ')).toBe('E n');
    expect(printable('😀')).toBe('?');
    expect(printable('“smart” — quotes')).toBe('“smart” — quotes');
  });

  it('flattens line breaks and tabs into single spaces and drops control characters', () => {
    expect(printable('line one\r\nline two\tTab')).toBe('line one line two Tab');
    expect(printable('a\u0000b\u0007c')).toBe('abc');
    // U+202F is whitespace, so it collapses to a plain space rather than falling back to ?.
    expect(printable('narrow space')).toBe('narrow space');
  });
});

describe('every document survives hostile text', () => {
  it('lease', async () => {
    const { bytes, sha256 } = await renderLeasePdf({
      ref: 'LSE-00001',
      landlordName: HOSTILE,
      tenantName: HOSTILE,
      tenantIdLast4: '0086',
      unitLabel: 'Kruis Court A1',
      address: `${LONG_TOKEN}, Ferndale, Randburg`,
      startDate: '2026-09-01',
      endDate: '2027-08-31',
      rentCents: 850000,
      depositCents: 850000,
      escalationPct: 8,
    });
    expect(isPdf(bytes)).toBe(true);
    expect(sha256).toHaveLength(64);
  });

  it('inspection, with notes, photos, an omitted count and a draft flag', async () => {
    const render = (draft: boolean) =>
      renderInspectionPdf({
        ref: 'INS-ABCDEF12',
        kind: 'outgoing',
        unitLabel: HOSTILE,
        date: '2027-08-29',
        findings: [
          { room: 'Kitchen', item: 'Stove and oven', condition: 'damaged', note: HOSTILE, photos: [{ bytes: ONE_PX_PNG, type: 'png' }] },
          { room: 'Kitchen', item: LONG_TOKEN, condition: 'good', note: null },
          { room: 'Lounge', item: 'Flooring', condition: 'fair', note: LONG_DESCRIPTION },
        ],
        photosOmitted: 7,
        signatures: draft ? [] : [{ party: 'tenant', name: HOSTILE, signedAt: '2027-08-29 10:00', png: ONE_PX_PNG }],
        draft,
      });
    expect(isPdf((await render(true)).bytes)).toBe(true);
    expect(isPdf((await render(false)).bytes)).toBe(true);
  });

  it('invoice', async () => {
    const { bytes } = await renderInvoicePdf({
      ref: 'INV-00001',
      landlordName: HOSTILE,
      tenantName: HOSTILE,
      unitLabel: 'Kruis Court A1',
      period: '2026-10',
      dueOn: '2026-10-01',
      lines: [{ description: `Rent · A1 · 2026-10 ${HOSTILE}`, amountCents: 850000 }],
      totalCents: 850000,
      paymentReference: 'LSE-00001',
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it('exit statement, with a 200 character deduction and comparison notes', async () => {
    const { bytes } = await renderExitStatementPdf({
      ref: 'EXIT-LSE-00001',
      landlordName: HOSTILE,
      tenantName: HOSTILE,
      unitLabel: 'Kruis Court A1',
      leaseEndOn: '2027-08-31',
      reason: 'early_tenant',
      depositCents: 850000,
      interestCents: 23000,
      arrearsCents: 120000,
      penaltyCents: 50000,
      deductions: [
        { description: LONG_DESCRIPTION, amountCents: 420000, backedBy: 'Inspection' },
        { description: HOSTILE, amountCents: 1000 },
      ],
      refundCents: 0,
      tenantOwesCents: 12345,
      refundRule: 'with_deductions',
      refundDueBy: '2027-09-14',
      refundReference: HOSTILE,
      comparisons: [
        {
          room: 'Kitchen',
          item: 'Stove and oven',
          incomingCondition: 'good',
          outgoingCondition: 'damaged',
          note: HOSTILE,
          incomingPhoto: { bytes: ONE_PX_PNG, type: 'png' },
          outgoingPhoto: null,
        },
      ],
    });
    expect(isPdf(bytes)).toBe(true);
  });
});
