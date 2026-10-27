import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { zar } from '../domain/money';

const INK = rgb(0.137, 0.125, 0.11);
const MUTED = rgb(0.49, 0.463, 0.424);
const PLUM = rgb(0.427, 0.208, 0.341);
const HAIR = rgb(0.847, 0.824, 0.784);

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;

/* ------------------------------------------------------------------ *
 * Text safety
 * ------------------------------------------------------------------ *
 *
 * The standard Helvetica pdf-lib embeds is WinAnsi (cp1252). Asked to draw anything outside
 * that set — a newline typed into a note, an emoji from a phone keyboard, the diacritics in a
 * Venda or Tsonga name — it throws, and every document render here did, which blocked lease
 * signing and deposit settlement outright for the tenant concerned. Nothing drawn below
 * reaches the font without passing through printable().
 */

// cp1252's additions to Latin-1, the only code points above 0xFF Helvetica can draw.
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
  0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export const canEncode = (codePoint: number) =>
  (codePoint >= 0x20 && codePoint <= 0x7e) ||
  (codePoint >= 0xa0 && codePoint <= 0xff) ||
  WINANSI_EXTRA.has(codePoint);

/**
 * A string Helvetica can draw. Line breaks and tabs become spaces (a note is one paragraph in
 * the report), runs of whitespace collapse, a letter with an unencodable mark falls back to
 * its base letter (Ṱ → T), and anything else becomes '?'. Control characters are dropped.
 */
export function printable(value: string): string {
  const flat = value.replace(/[\r\n\t\f\v]+/g, ' ').replace(/\s+/g, ' ');
  let out = '';
  for (const char of flat.normalize('NFC')) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x20) continue;
    if (canEncode(codePoint)) {
      out += char;
      continue;
    }
    const base = char.normalize('NFKD').replace(/\p{M}+/gu, '');
    const fallback = [...base];
    out += fallback.length > 0 && fallback.every((c) => canEncode(c.codePointAt(0)!)) ? base : '?';
  }
  return out;
}

/** Every string in a document's data, however deeply nested. Bytes and numbers pass through. */
function sanitize<T>(value: T): T {
  if (typeof value === 'string') return printable(value) as T;
  if (value instanceof Uint8Array || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitize(entry)]),
    ) as T;
  }
  return value;
}

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  body: PDFFont;
  bold: PDFFont;
}

type Color = ReturnType<typeof rgb>;

// The two chokepoints: nothing else measures or draws text.
const width = (font: PDFFont, value: string, size: number) =>
  font.widthOfTextAtSize(printable(value), size);

const draw = (
  ctx: Ctx,
  value: string,
  opts: { x: number; y: number; size: number; font: PDFFont; color: Color },
) => ctx.page.drawText(printable(value), opts);

async function open(title: string): Promise<Ctx> {
  const doc = await PDFDocument.create();
  doc.setTitle(printable(title));
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([A4.w, A4.h]);
  return { doc, page, y: A4.h - MARGIN, body, bold };
}

function ensureRoom(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN) {
    ctx.page = ctx.doc.addPage([A4.w, A4.h]);
    ctx.y = A4.h - MARGIN;
  }
}

/** Splits one token that is wider than a line into pieces that each fit. */
function breakToken(font: PDFFont, token: string, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const char of token) {
    if (piece && width(font, piece + char, size) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrap(font: PDFFont, value: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of printable(value).split(' ')) {
    // A token longer than the line (an unbroken reference, a URL) used to run off the page.
    const parts = width(font, word, size) > maxWidth ? breakToken(font, word, size, maxWidth) : [word];
    for (const part of parts) {
      const candidate = line ? `${line} ${part}` : part;
      if (line && width(font, candidate, size) > maxWidth) {
        lines.push(line);
        line = part;
      } else {
        line = candidate;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function text(
  ctx: Ctx,
  value: string,
  opts: { size?: number; bold?: boolean; color?: Color; gap?: number; x?: number } = {},
) {
  const { size = 10.5, bold = false, color = INK, gap = 6, x = MARGIN } = opts;
  const font = bold ? ctx.bold : ctx.body;
  for (const printed of wrap(font, value, size, A4.w - MARGIN - x)) {
    ensureRoom(ctx, size + gap);
    draw(ctx, printed, { x, y: ctx.y - size, size, font, color });
    ctx.y -= size + gap;
  }
}

function rule(ctx: Ctx, gap = 12) {
  ensureRoom(ctx, gap);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: A4.w - MARGIN, y: ctx.y },
    thickness: 0.7,
    color: HAIR,
  });
  ctx.y -= gap;
}

/**
 * A label on the left and its value on the right. A value too long to sit beside the label
 * (a full premises address, a 200 character deduction) used to be right-aligned off the left
 * edge of the page; now it wraps underneath the label instead.
 */
function pair(ctx: Ctx, label: string, value: string) {
  const labelText = label.toUpperCase();
  const labelWidth = width(ctx.bold, labelText, 7.5);
  const valueWidth = width(ctx.body, value, 10.5);
  const available = A4.w - MARGIN * 2 - labelWidth - 12;
  if (valueWidth <= available) {
    ensureRoom(ctx, 16);
    draw(ctx, labelText, { x: MARGIN, y: ctx.y - 8, size: 7.5, font: ctx.bold, color: MUTED });
    draw(ctx, value, { x: A4.w - MARGIN - valueWidth, y: ctx.y - 9, size: 10.5, font: ctx.body, color: INK });
    ctx.y -= 20;
    return;
  }
  ensureRoom(ctx, 14);
  draw(ctx, labelText, { x: MARGIN, y: ctx.y - 8, size: 7.5, font: ctx.bold, color: MUTED });
  ctx.y -= 13;
  text(ctx, value, { x: MARGIN + 12, gap: 4 });
  ctx.y -= 4;
}

/** A line drawn flush right. */
function rightAligned(ctx: Ctx, value: string, y: number, size: number, font: PDFFont, color: Color) {
  draw(ctx, value, { x: A4.w - MARGIN - width(font, value, size), y, size, font, color });
}

async function seal(ctx: Ctx): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = await ctx.doc.save();
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface LeaseData {
  ref: string;
  landlordName: string;
  tenantName: string;
  tenantIdLast4: string;
  unitLabel: string;
  address: string;
  startDate: string;
  endDate: string;
  rentCents: number;
  depositCents: number;
  escalationPct: number;
}

export async function renderLeasePdf(input: LeaseData) {
  const lease = sanitize(input);
  const ctx = await open(`Lease ${lease.ref}`);
  draw(ctx, 'RESIDENTIAL LEASE', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  rightAligned(ctx, lease.ref, ctx.y - 16, 10, ctx.body, PLUM);
  ctx.y -= 34;
  rule(ctx);
  pair(ctx, 'Landlord', lease.landlordName);
  pair(ctx, 'Tenant', `${lease.tenantName} (ID ····${lease.tenantIdLast4})`);
  pair(ctx, 'Premises', `${lease.unitLabel}, ${lease.address}`);
  pair(ctx, 'Term', `${lease.startDate} to ${lease.endDate}`);
  pair(ctx, 'Monthly rent', zar(lease.rentCents));
  pair(ctx, 'Annual escalation', `${lease.escalationPct}%`);
  pair(ctx, 'Deposit', zar(lease.depositCents));
  rule(ctx);
  text(ctx, 'Deposit', { bold: true, size: 12, gap: 8 });
  text(ctx, 'The deposit is held in an interest-bearing account. Interest accrues to the tenant and is paid out with the refund. A joint incoming inspection is held before occupation and its defects list forms part of this lease. The outgoing inspection takes place within the final three days of the lease in the presence of the tenant.');
  ctx.y -= 6;
  text(ctx, 'Signatures', { bold: true, size: 12, gap: 8 });
  text(ctx, 'This document is signed electronically. Each signature records the date, time, network address, device, and the SHA-256 fingerprint of this exact document.', { color: MUTED, size: 9 });
  return seal(ctx);
}

export interface InspectionPhoto {
  bytes: Uint8Array;
  type: 'jpg' | 'png';
}

export interface InspectionData {
  ref: string;
  kind: 'incoming' | 'outgoing';
  unitLabel: string;
  date: string;
  findings: {
    room: string;
    item: string;
    condition: string;
    note?: string | null;
    photos?: InspectionPhoto[];
  }[];
  signatures: { party: string; name: string; signedAt: string; png?: Uint8Array }[];
  /** The unsigned document both parties review. Says so, so a draft is never mistaken for the report. */
  draft?: boolean;
  /** Photos on file that did not fit the report's size budget. Named rather than silently dropped. */
  photosOmitted?: number;
}

export async function renderInspectionPdf(input: InspectionData) {
  const data = sanitize(input);
  const ctx = await open(`Inspection ${data.ref}${data.draft ? ' (draft)' : ''}`);
  const title = data.kind === 'incoming' ? 'INCOMING INSPECTION' : 'OUTGOING INSPECTION';
  draw(ctx, title, { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  if (data.draft) rightAligned(ctx, 'DRAFT FOR REVIEW', ctx.y - 16, 10, ctx.bold, PLUM);
  ctx.y -= 30;
  text(ctx, `${data.unitLabel} · ${data.date} · ${data.ref}`, { color: MUTED, size: 9.5, gap: 10 });
  if (data.draft) {
    text(ctx, 'Unsigned draft. The signed report, with both signatures embedded, replaces this document.', {
      color: MUTED,
      size: 8.5,
      gap: 10,
    });
  }
  rule(ctx);

  let currentRoom = '';
  for (const finding of data.findings) {
    if (finding.room !== currentRoom) {
      currentRoom = finding.room;
      ctx.y -= 4;
      text(ctx, currentRoom, { bold: true, size: 11.5, gap: 7 });
    }
    ensureRoom(ctx, 15);
    draw(ctx, finding.item, { x: MARGIN + 10, y: ctx.y - 9, size: 9.5, font: ctx.body, color: INK });
    const cond = finding.condition.toUpperCase();
    const flag = ['damaged', 'missing', 'poor'].includes(finding.condition);
    rightAligned(ctx, cond, ctx.y - 9, 8.5, ctx.bold, flag ? rgb(0.7, 0.28, 0.24) : MUTED);
    ctx.y -= 15;
    if (finding.note) text(ctx, finding.note, { color: MUTED, size: 8.5, gap: 5, x: MARGIN + 10 });

    if (finding.photos?.length) {
      const thumbWidth = 150;
      const gap = 8;
      // Three per row keeps the evidence next to the finding it proves.
      for (let start = 0; start < finding.photos.length; start += 3) {
        const rowPhotos = finding.photos.slice(start, start + 3);
        const embedded = [];
        for (const photo of rowPhotos) {
          embedded.push(photo.type === 'png' ? await ctx.doc.embedPng(photo.bytes) : await ctx.doc.embedJpg(photo.bytes));
        }
        const sized = embedded.map((image) => {
          const scale = Math.min(thumbWidth / image.width, 130 / image.height);
          return { image, w: image.width * scale, h: image.height * scale };
        });
        const rowHeight = Math.max(...sized.map((item) => item.h));
        ensureRoom(ctx, rowHeight + 12);
        let x = MARGIN + 10;
        for (const { image, w, h } of sized) {
          ctx.page.drawImage(image, { x, y: ctx.y - rowHeight, width: w, height: h });
          ctx.page.drawRectangle({
            x,
            y: ctx.y - rowHeight,
            width: w,
            height: h,
            borderColor: HAIR,
            borderWidth: 0.7,
          });
          x += thumbWidth + gap;
        }
        ctx.y -= rowHeight + 12;
      }
    }
  }

  if (data.photosOmitted) {
    ctx.y -= 4;
    text(
      ctx,
      `${data.photosOmitted} further photo${data.photosOmitted === 1 ? ' is' : 's are'} on file but not embedded, to keep this report a manageable size. They remain available in the app.`,
      { color: MUTED, size: 8.5 },
    );
  }

  ctx.y -= 8;
  rule(ctx);
  text(ctx, data.draft ? 'To be signed jointly' : 'Signed jointly', { bold: true, size: 12, gap: 10 });
  for (const signature of data.signatures) {
    ensureRoom(ctx, 64);
    if (signature.png) {
      const image = await ctx.doc.embedPng(signature.png);
      const dims = image.scale(42 / image.height);
      ctx.page.drawImage(image, { x: MARGIN, y: ctx.y - 42, width: dims.width, height: dims.height });
    }
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 46 }, end: { x: MARGIN + 200, y: ctx.y - 46 }, thickness: 0.7, color: INK });
    draw(ctx, `${signature.name} · ${signature.party} · ${signature.signedAt}`, { x: MARGIN, y: ctx.y - 58, size: 8.5, font: ctx.body, color: MUTED });
    ctx.y -= 70;
  }
  return seal(ctx);
}

export interface InvoiceData {
  ref: string;
  landlordName: string;
  tenantName: string;
  unitLabel: string;
  period: string;
  dueOn: string;
  lines: { description: string; amountCents: number }[];
  totalCents: number;
  paymentReference: string;
}

export async function renderInvoicePdf(input: InvoiceData) {
  const data = sanitize(input);
  const ctx = await open(`Invoice ${data.ref}`);
  draw(ctx, 'RENT INVOICE', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  rightAligned(ctx, data.ref, ctx.y - 16, 10, ctx.body, PLUM);
  ctx.y -= 34;
  rule(ctx);
  pair(ctx, 'From', data.landlordName);
  pair(ctx, 'To', data.tenantName);
  pair(ctx, 'Premises', data.unitLabel);
  pair(ctx, 'Period', data.period);
  pair(ctx, 'Due on', data.dueOn);
  rule(ctx);
  for (const line of data.lines) pair(ctx, ' ', `${line.description}  ·  ${zar(line.amountCents)}`);
  ctx.y -= 4;
  ensureRoom(ctx, 26);
  draw(ctx, 'TOTAL DUE', { x: MARGIN, y: ctx.y - 12, size: 9, font: ctx.bold, color: MUTED });
  rightAligned(ctx, zar(data.totalCents), ctx.y - 14, 15, ctx.bold, INK);
  ctx.y -= 30;
  rule(ctx);
  text(ctx, 'How to pay', { bold: true, size: 11, gap: 7 });
  text(ctx, `EFT to the account on your lease. Use the reference ${data.paymentReference} exactly, or the payment cannot be matched to your unit.`, { color: MUTED, size: 9 });
  return seal(ctx);
}

/* ------------------------------------------------------------------ *
 * Exit statement. The document that decides the deposit, so it shows
 * the evidence beside the claim rather than asking anyone to trust it.
 * ------------------------------------------------------------------ */

export interface ComparisonRow {
  room: string;
  item: string;
  incomingCondition: string;
  outgoingCondition: string;
  note?: string | null;
  incomingPhoto?: InspectionPhoto | null;
  outgoingPhoto?: InspectionPhoto | null;
}

export interface ExitStatementData {
  ref: string;
  landlordName: string;
  tenantName: string;
  unitLabel: string;
  leaseEndOn: string;
  reason: string;
  depositCents: number;
  interestCents: number;
  arrearsCents: number;
  penaltyCents: number;
  deductions: { description: string; amountCents: number; backedBy?: string | null }[];
  refundCents: number;
  tenantOwesCents: number;
  refundRule: string;
  refundDueBy: string;
  refundReference?: string | null;
  comparisons: ComparisonRow[];
}

const RULE_TEXT: Record<string, string> = {
  no_deductions:
    'No deductions were made, so the deposit and its interest are refundable within 7 days of the lease ending.',
  with_deductions:
    'Deductions were made, so the balance is refundable within 14 days of the dwelling being restored. Receipts are available for inspection on request.',
  no_inspection:
    'No outgoing inspection was held, which is deemed an acknowledgement that the dwelling is undamaged. The full deposit and its interest are refundable within 21 days of the lease ending.',
};

async function drawComparison(ctx: Ctx, row: ComparisonRow) {
  const width_ = 210;
  const height = 120;
  ensureRoom(ctx, height + 46);

  draw(ctx, `${row.room} · ${row.item}`, { x: MARGIN, y: ctx.y - 10, size: 10, font: ctx.bold, color: INK });
  ctx.y -= 22;

  const columns: [string, InspectionPhoto | null | undefined, string][] = [
    ['ON MOVE IN', row.incomingPhoto, row.incomingCondition],
    ['ON MOVE OUT', row.outgoingPhoto, row.outgoingCondition],
  ];

  let x = MARGIN;
  for (const [label, photo, condition] of columns) {
    draw(ctx, label, { x, y: ctx.y - 8, size: 7, font: ctx.bold, color: MUTED });
    const flag = ['damaged', 'missing', 'poor'].includes(condition);
    const cond = condition.toUpperCase();
    draw(ctx, cond, {
      x: x + width_ - width(ctx.bold, cond, 7.5),
      y: ctx.y - 8,
      size: 7.5,
      font: ctx.bold,
      color: flag ? rgb(0.7, 0.28, 0.24) : MUTED,
    });

    if (photo) {
      const image =
        photo.type === 'png' ? await ctx.doc.embedPng(photo.bytes) : await ctx.doc.embedJpg(photo.bytes);
      const scale = Math.min(width_ / image.width, height / image.height);
      ctx.page.drawImage(image, {
        x,
        y: ctx.y - 14 - image.height * scale,
        width: image.width * scale,
        height: image.height * scale,
      });
    } else {
      ctx.page.drawRectangle({
        x,
        y: ctx.y - 14 - height,
        width: width_,
        height,
        borderColor: HAIR,
        borderWidth: 0.7,
      });
      draw(ctx, 'no photo on file', { x: x + 8, y: ctx.y - 14 - height / 2, size: 8, font: ctx.body, color: MUTED });
    }
    x += width_ + 14;
  }

  ctx.y -= height + 22;
  if (row.note) text(ctx, row.note, { color: MUTED, size: 8.5, gap: 6 });
  ctx.y -= 6;
}

export async function renderExitStatementPdf(input: ExitStatementData) {
  const data = sanitize(input);
  const ctx = await open(`Exit statement ${data.ref}`);
  draw(ctx, 'DEPOSIT STATEMENT', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  rightAligned(ctx, data.ref, ctx.y - 16, 10, ctx.body, PLUM);
  ctx.y -= 34;
  rule(ctx);
  pair(ctx, 'Landlord', data.landlordName);
  pair(ctx, 'Tenant', data.tenantName);
  pair(ctx, 'Premises', data.unitLabel);
  pair(ctx, 'Lease ended', data.leaseEndOn);
  pair(ctx, 'Reason', data.reason.replace(/_/g, ' '));
  rule(ctx);

  text(ctx, 'What was held', { bold: true, size: 12, gap: 8 });
  pair(ctx, 'Deposit', zar(data.depositCents));
  pair(ctx, 'Interest earned', zar(data.interestCents));
  pair(ctx, 'Held in total', zar(data.depositCents + data.interestCents));
  ctx.y -= 4;

  text(ctx, 'What is claimed', { bold: true, size: 12, gap: 8 });
  if (data.deductions.length === 0 && data.arrearsCents === 0 && data.penaltyCents === 0) {
    text(ctx, 'Nothing. The dwelling came back as it went out.', { color: MUTED, size: 9.5 });
  }
  for (const deduction of data.deductions) {
    pair(ctx, deduction.backedBy ?? 'Deduction', `${deduction.description}  ·  ${zar(deduction.amountCents)}`);
  }
  if (data.arrearsCents > 0) pair(ctx, 'Rent arrears', zar(data.arrearsCents));
  if (data.penaltyCents > 0) pair(ctx, 'Cancellation penalty', zar(data.penaltyCents));

  ctx.y -= 6;
  rule(ctx);
  ensureRoom(ctx, 34);
  const isRefund = data.tenantOwesCents === 0;
  const label = isRefund ? 'REFUND TO TENANT' : 'OWED BY TENANT';
  const amount = zar(isRefund ? data.refundCents : data.tenantOwesCents);
  draw(ctx, label, { x: MARGIN, y: ctx.y - 14, size: 9, font: ctx.bold, color: MUTED });
  rightAligned(ctx, amount, ctx.y - 16, 17, ctx.bold, INK);
  ctx.y -= 34;
  rule(ctx);

  text(ctx, `Payable by ${data.refundDueBy}`, { bold: true, size: 11, gap: 7 });
  text(ctx, RULE_TEXT[data.refundRule] ?? '', { color: MUTED, size: 9 });
  if (data.refundReference) {
    text(ctx, `Paid by EFT with reference ${data.refundReference}.`, { color: MUTED, size: 9 });
  }

  if (data.comparisons.length > 0) {
    ctx.y -= 10;
    ensureRoom(ctx, 60);
    rule(ctx);
    text(ctx, 'The evidence', { bold: true, size: 12, gap: 6 });
    text(ctx, 'Each item below is shown as it was recorded on move in and again on move out.', {
      color: MUTED,
      size: 9,
      gap: 12,
    });
    for (const row of data.comparisons) await drawComparison(ctx, row);
  }

  return seal(ctx);
}
