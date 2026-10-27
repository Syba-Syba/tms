import { createHash } from 'node:crypto';

/**
 * Reads the statement exports of South African banks into credit lines.
 *
 * Every bank exports OFX, and that is the reliable path. CSV is what people actually download,
 * and each bank lays it out differently: FNB puts account details above a header, Capitec splits
 * "Money In" and "Money Out", ABSA and Nedbank use one signed amount, some use semicolons and
 * decimal commas. So the CSV reader finds the columns by their headers, and falls back to
 * reading the values when a file has no header at all.
 *
 * Only credits come back. A landlord's statement is mostly debits, and none of them are rent.
 */

export interface StatementLine {
  postedOn: string;
  amountCents: number;
  description: string;
  /** Unique per landlord. A repeated line in an overlapping statement has the same one. */
  fingerprint: string;
}

export interface ParsedStatement {
  format: 'csv' | 'ofx';
  lines: StatementLine[];
  debitsSkipped: number;
}

export class StatementError extends Error {}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const valid = (y: string, m: string, d: string) => {
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  // Rejects 31 February and the like, which Date would roll into March.
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
};

/** Day first, as South African banks write it. A US-style month-first date is not supported. */
export function parseDate(raw: string): string | null {
  const text = raw.trim().replace(/^"|"$/g, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (m) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (m) return valid(m[3]!, m[2]!, m[1]!);
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6})?(?:\.\d+)?(?:\[.*\])?$/.exec(text);
  if (m) return valid(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? valid(m[3]!, month, m[1]!) : null;
  }
  return null;
}

/**
 * "1 500.00", "R1,500.00", "1500,00", "-250.00", "(250.00)", "250.00 Dr", "250.00Cr".
 * Returns signed cents, or null for anything that is not an amount.
 */
export function parseAmount(raw: string): number | null {
  let text = raw.trim().replace(/^"|"$/g, '').replace(/\s+/g, '');
  if (!text) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  const suffix = /(cr|dr)$/i.exec(text);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === 'dr') sign = -sign;
    text = text.slice(0, -2);
  }
  text = text.replace(/^(R|ZAR)/i, '');
  if (text.startsWith('-')) {
    sign = -sign;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  text = text.replace(/^(R|ZAR)/i, '');
  if (text.includes(',') && text.includes('.')) {
    // Whichever comes last is the decimal point.
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (/,\d{1,2}$/.test(text)) {
    text = text.replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return sign * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}

const fingerprint = (parts: string[]) =>
  createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32);

/**
 * Two identical credits on one day (two tenants paying the same rent with no reference) are
 * still two payments. The occurrence number keeps them apart, and is the same in the next
 * month's overlapping export, so neither is imported twice.
 */
function withFingerprints(
  rows: Array<{ postedOn: string; amountCents: number; description: string; fitId?: string }>,
): StatementLine[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `${row.postedOn}|${row.amountCents}|${row.description.toUpperCase()}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return {
      postedOn: row.postedOn,
      amountCents: row.amountCents,
      description: row.description,
      fingerprint: row.fitId ? fingerprint(['fitid', row.fitId]) : fingerprint([base, String(occurrence)]),
    };
  });
}

/* ------------------------------------------------------------------ *
 * OFX
 * ------------------------------------------------------------------ */

/** OFX 1.x is SGML with unclosed tags; 2.x is XML. Reading tag values by name handles both. */
function ofxField(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return match ? match[1]!.trim() : null;
}

const decodeEntities = (text: string) =>
  text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function parseOfx(text: string): ParsedStatement {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) throw new StatementError('That OFX file has no transactions in it.');
  const rows: Array<{ postedOn: string; amountCents: number; description: string; fitId?: string }> = [];
  let debitsSkipped = 0;
  for (const block of blocks) {
    const amount = parseAmount(ofxField(block, 'TRNAMT') ?? '');
    const postedOn = parseDate(ofxField(block, 'DTPOSTED') ?? '');
    if (amount === null || !postedOn) continue;
    if (amount <= 0) {
      debitsSkipped += 1;
      continue;
    }
    const description = [ofxField(block, 'NAME'), ofxField(block, 'MEMO')]
      .filter((part): part is string => Boolean(part))
      .map(decodeEntities)
      .join(' ')
      .trim();
    const fitId = ofxField(block, 'FITID') ?? undefined;
    rows.push({ postedOn, amountCents: amount, description: description || 'No description', fitId });
  }
  return { format: 'ofx', lines: withFingerprints(rows), debitsSkipped };
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 20).join('\n');
  const counts = [',', ';', '\t', '|'].map((d) => [d, sample.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

const HEADERS = {
  date: /^(transaction\s*)?date$|^posting\s*date$|^value\s*date$|^date\s*posted$|^datum$/i,
  amount: /^amount|^transaction\s*amount$|^bedrag$/i,
  credit: /^(money\s*in|credit|credits|deposits?|in|credit\s*amount)$/i,
  debit: /^(money\s*out|debit|debits|withdrawals?|out|debit\s*amount)$/i,
  description: /^(description|narrative|details|transaction\s*description|original\s*description|beskrywing)$/i,
  reference: /^(reference|ref|statement\s*reference|their\s*reference|beneficiary\s*reference)$/i,
};

interface Columns {
  date: number;
  amount: number;
  credit: number;
  debit: number;
  description: number[];
}

function columnsFromHeader(header: string[]): Columns | null {
  const find = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell.trim()));
  const date = find(HEADERS.date);
  const amount = find(HEADERS.amount);
  const credit = find(HEADERS.credit);
  if (date < 0 || (amount < 0 && credit < 0)) return null;
  const description = header
    .map((cell, index) => (HEADERS.description.test(cell.trim()) || HEADERS.reference.test(cell.trim()) ? index : -1))
    .filter((index) => index >= 0);
  return { date, amount, credit, debit: find(HEADERS.debit), description };
}

/**
 * No header: FNB's older exports, and anything pasted from a spreadsheet. The date is the
 * column that parses as dates, the amount is the first amount after it, and the description
 * is the column with the most letters in it.
 */
function columnsFromValues(rows: string[][]): Columns | null {
  const width = Math.max(...rows.map((row) => row.length));
  const share = (test: (cell: string) => boolean, column: number) =>
    rows.filter((row) => row[column] !== undefined && test(row[column]!)).length / rows.length;
  let date = -1;
  for (let c = 0; c < width; c += 1) {
    if (share((cell) => parseDate(cell) !== null, c) > 0.8) {
      date = c;
      break;
    }
  }
  if (date < 0) return null;
  let amount = -1;
  for (let c = date + 1; c < width; c += 1) {
    if (share((cell) => parseAmount(cell) !== null, c) > 0.8) {
      amount = c;
      break;
    }
  }
  if (amount < 0) return null;
  let description = -1;
  let letters = 0;
  for (let c = 0; c < width; c += 1) {
    if (c === date || c === amount) continue;
    const count = rows.reduce((sum, row) => sum + (row[c] ?? '').replace(/[^A-Za-z]/g, '').length, 0);
    if (count > letters) {
      letters = count;
      description = c;
    }
  }
  return { date, amount, credit: -1, debit: -1, description: description >= 0 ? [description] : [] };
}

function parseCsv(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new StatementError('That file is empty.');
  const delimiter = detectDelimiter(lines);
  const rows = lines.map((line) => splitRow(line, delimiter));

  // The header is the first row that names a date and an amount. FNB puts account details
  // above it, so it is not always the first row.
  let columns: Columns | null = null;
  let start = 0;
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    columns = columnsFromHeader(rows[i]!);
    if (columns) {
      start = i + 1;
      break;
    }
  }
  if (!columns) {
    const dataRows = rows.filter((row) => row.some((cell) => parseDate(cell) !== null));
    columns = dataRows.length > 0 ? columnsFromValues(dataRows) : null;
    start = 0;
  }
  if (!columns) {
    throw new StatementError(
      'Could not find the date and amount columns. Export the statement as OFX, or as CSV with a header row.',
    );
  }

  const found: Array<{ postedOn: string; amountCents: number; description: string }> = [];
  let debitsSkipped = 0;
  for (const row of rows.slice(start)) {
    const postedOn = parseDate(row[columns.date] ?? '');
    if (!postedOn) continue;
    let amount: number | null;
    if (columns.credit >= 0) {
      const credit = parseAmount(row[columns.credit] ?? '');
      amount = credit && credit > 0 ? credit : null;
      if (amount === null) {
        const debit = columns.debit >= 0 ? parseAmount(row[columns.debit] ?? '') : null;
        const signed = columns.amount >= 0 ? parseAmount(row[columns.amount] ?? '') : null;
        if (debit || (signed !== null && signed < 0)) debitsSkipped += 1;
        else if (signed !== null && signed > 0) amount = signed;
      }
    } else {
      amount = parseAmount(row[columns.amount] ?? '');
      if (amount !== null && amount <= 0) {
        debitsSkipped += 1;
        amount = null;
      }
    }
    if (amount === null) continue;
    const description = columns.description
      .map((index) => row[index] ?? '')
      .filter((cell, index, all) => cell && all.indexOf(cell) === index)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    found.push({ postedOn, amountCents: amount, description: description || 'No description' });
  }
  return { format: 'csv', lines: withFingerprints(found), debitsSkipped };
}

export function parseStatement(fileName: string, text: string): ParsedStatement {
  const content = text.replace(/^﻿/, '');
  const isOfx = /\.(ofx|qfx)$/i.test(fileName) || /<OFX>|OFXHEADER/i.test(content.slice(0, 2000));
  const parsed = isOfx ? parseOfx(content) : parseCsv(content);
  if (parsed.lines.length === 0) {
    throw new StatementError(
      parsed.debitsSkipped > 0
        ? 'That statement has no money coming in, only payments out.'
        : 'No transactions could be read from that file.',
    );
  }
  return parsed;
}
