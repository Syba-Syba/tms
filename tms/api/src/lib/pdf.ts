import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { zar } from '../domain/money';

const INK = rgb(0.137, 0.125, 0.11);
const MUTED = rgb(0.49, 0.463, 0.424);
const PLUM = rgb(0.427, 0.208, 0.341);
const HAIR = rgb(0.847, 0.824, 0.784);

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  body: PDFFont;
  bold: PDFFont;
}

async function open(title: string): Promise<Ctx> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
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

function text(ctx: Ctx, value: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {}) {
  const { size = 10.5, bold = false, color = INK, gap = 6 } = opts;
  const font = bold ? ctx.bold : ctx.body;
  const maxWidth = A4.w - MARGIN * 2;
  const words = value.split(' ');
  let line = '';
  const lines: string[] = [];
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  for (const printed of lines) {
    ensureRoom(ctx, size + gap);
    ctx.page.drawText(printed, { x: MARGIN, y: ctx.y - size, size, font, color });
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

function pair(ctx: Ctx, label: string, value: string) {
  ensureRoom(ctx, 16);
  ctx.page.drawText(label.toUpperCase(), { x: MARGIN, y: ctx.y - 8, size: 7.5, font: ctx.bold, color: MUTED });
  const width = ctx.body.widthOfTextAtSize(value, 10.5);
  ctx.page.drawText(value, { x: A4.w - MARGIN - width, y: ctx.y - 9, size: 10.5, font: ctx.body, color: INK });
  ctx.y -= 20;
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

export async function renderLeasePdf(lease: LeaseData) {
  const ctx = await open(`Lease ${lease.ref}`);
  ctx.page.drawText('RESIDENTIAL LEASE', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  ctx.page.drawText(lease.ref, { x: A4.w - MARGIN - ctx.body.widthOfTextAtSize(lease.ref, 10), y: ctx.y - 16, size: 10, font: ctx.body, color: PLUM });
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
}

export async function renderInspectionPdf(data: InspectionData) {
  const ctx = await open(`Inspection ${data.ref}`);
  const title = data.kind === 'incoming' ? 'INCOMING INSPECTION' : 'OUTGOING INSPECTION';
  ctx.page.drawText(title, { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  ctx.y -= 30;
  text(ctx, `${data.unitLabel} · ${data.date} · ${data.ref}`, { color: MUTED, size: 9.5, gap: 10 });
  rule(ctx);

  let currentRoom = '';
  for (const finding of data.findings) {
    if (finding.room !== currentRoom) {
      currentRoom = finding.room;
      ctx.y -= 4;
      text(ctx, currentRoom, { bold: true, size: 11.5, gap: 7 });
    }
    ensureRoom(ctx, 15);
    ctx.page.drawText(finding.item, { x: MARGIN + 10, y: ctx.y - 9, size: 9.5, font: ctx.body, color: INK });
    const cond = finding.condition.toUpperCase();
    const flag = ['damaged', 'missing', 'poor'].includes(finding.condition);
    ctx.page.drawText(cond, {
      x: A4.w - MARGIN - ctx.bold.widthOfTextAtSize(cond, 8.5),
      y: ctx.y - 9,
      size: 8.5,
      font: ctx.bold,
      color: flag ? rgb(0.7, 0.28, 0.24) : MUTED,
    });
    ctx.y -= 15;
    if (finding.note) text(ctx, `   ${finding.note}`, { color: MUTED, size: 8.5, gap: 5 });

    if (finding.photos?.length) {
      const thumbWidth = 150;
      const gap = 8;
      // Three per row keeps the evidence next to the finding it proves.
      for (let start = 0; start < finding.photos.length; start += 3) {
        const rowPhotos = finding.photos.slice(start, start + 3);
        const embedded = await Promise.all(
          rowPhotos.map((photo) =>
            photo.type === 'png' ? ctx.doc.embedPng(photo.bytes) : ctx.doc.embedJpg(photo.bytes),
          ),
        );
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

  ctx.y -= 8;
  rule(ctx);
  text(ctx, 'Signed jointly', { bold: true, size: 12, gap: 10 });
  for (const signature of data.signatures) {
    ensureRoom(ctx, 64);
    if (signature.png) {
      const image = await ctx.doc.embedPng(signature.png);
      const dims = image.scale(42 / image.height);
      ctx.page.drawImage(image, { x: MARGIN, y: ctx.y - 42, width: dims.width, height: dims.height });
    }
    ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 46 }, end: { x: MARGIN + 200, y: ctx.y - 46 }, thickness: 0.7, color: INK });
    ctx.page.drawText(`${signature.name} · ${signature.party} · ${signature.signedAt}`, { x: MARGIN, y: ctx.y - 58, size: 8.5, font: ctx.body, color: MUTED });
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

export async function renderInvoicePdf(data: InvoiceData) {
  const ctx = await open(`Invoice ${data.ref}`);
  ctx.page.drawText('RENT INVOICE', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  ctx.page.drawText(data.ref, { x: A4.w - MARGIN - ctx.body.widthOfTextAtSize(data.ref, 10), y: ctx.y - 16, size: 10, font: ctx.body, color: PLUM });
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
  ctx.page.drawText('TOTAL DUE', { x: MARGIN, y: ctx.y - 12, size: 9, font: ctx.bold, color: MUTED });
  const total = zar(data.totalCents);
  ctx.page.drawText(total, { x: A4.w - MARGIN - ctx.bold.widthOfTextAtSize(total, 15), y: ctx.y - 14, size: 15, font: ctx.bold, color: INK });
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
  const width = 210;
  const height = 120;
  ensureRoom(ctx, height + 46);

  ctx.page.drawText(`${row.room} · ${row.item}`, {
    x: MARGIN,
    y: ctx.y - 10,
    size: 10,
    font: ctx.bold,
    color: INK,
  });
  ctx.y -= 22;

  const columns: [string, InspectionPhoto | null | undefined, string][] = [
    ['ON MOVE IN', row.incomingPhoto, row.incomingCondition],
    ['ON MOVE OUT', row.outgoingPhoto, row.outgoingCondition],
  ];

  let x = MARGIN;
  for (const [label, photo, condition] of columns) {
    ctx.page.drawText(label, { x, y: ctx.y - 8, size: 7, font: ctx.bold, color: MUTED });
    const flag = ['damaged', 'missing', 'poor'].includes(condition);
    ctx.page.drawText(condition.toUpperCase(), {
      x: x + width - ctx.bold.widthOfTextAtSize(condition.toUpperCase(), 7.5),
      y: ctx.y - 8,
      size: 7.5,
      font: ctx.bold,
      color: flag ? rgb(0.7, 0.28, 0.24) : MUTED,
    });

    if (photo) {
      const image =
        photo.type === 'png' ? await ctx.doc.embedPng(photo.bytes) : await ctx.doc.embedJpg(photo.bytes);
      const scale = Math.min(width / image.width, height / image.height);
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
        width,
        height,
        borderColor: HAIR,
        borderWidth: 0.7,
      });
      ctx.page.drawText('no photo on file', {
        x: x + 8,
        y: ctx.y - 14 - height / 2,
        size: 8,
        font: ctx.body,
        color: MUTED,
      });
    }
    x += width + 14;
  }

  ctx.y -= height + 22;
  if (row.note) text(ctx, row.note, { color: MUTED, size: 8.5, gap: 6 });
  ctx.y -= 6;
}

export async function renderExitStatementPdf(data: ExitStatementData) {
  const ctx = await open(`Exit statement ${data.ref}`);
  ctx.page.drawText('DEPOSIT STATEMENT', { x: MARGIN, y: ctx.y - 18, size: 19, font: ctx.bold, color: INK });
  ctx.page.drawText(data.ref, {
    x: A4.w - MARGIN - ctx.body.widthOfTextAtSize(data.ref, 10),
    y: ctx.y - 16,
    size: 10,
    font: ctx.body,
    color: PLUM,
  });
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
  ctx.page.drawText(label, { x: MARGIN, y: ctx.y - 14, size: 9, font: ctx.bold, color: MUTED });
  ctx.page.drawText(amount, {
    x: A4.w - MARGIN - ctx.bold.widthOfTextAtSize(amount, 17),
    y: ctx.y - 16,
    size: 17,
    font: ctx.bold,
    color: INK,
  });
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
