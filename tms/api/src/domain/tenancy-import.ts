import { z } from 'zod';
import { saIdNumber, saPhone } from './application';
import { detectDelimiter, parseAmount, parseDate, splitRow } from './bank-statement';
import { addDaysIso } from './dates';

/**
 * A tenancy that began before the landlord used Threshold: who, where, on what terms, and
 * where the money stands today. The unit is named by id from the form, or by property name and
 * unit code from a spreadsheet.
 */
export const importRowSchema = z
  .object({
    unitId: z.guid().optional(),
    property: z.string().trim().min(1).max(120).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    // Only used to add a unit that does not exist yet.
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().int().min(0).max(20).optional(),
    firstName: z.string().trim().min(1, 'First name is required.').max(80),
    lastName: z.string().trim().min(1, 'Last name is required.').max(80),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
    phone: saPhone,
    idNumber: saIdNumber.optional(),
    startDate: z.iso.date('Lease start must be a date.'),
    endDate: z.iso.date('Lease end must be a date.'),
    monthlyRentCents: z.number().int().positive('Rent must be more than zero.'),
    escalationPct: z.number().min(0).max(30).default(0),
    depositHeldCents: z.number().int().min(0).default(0),
    currentMonthPaid: z.boolean(),
    arrearsCents: z.number().int().min(0).default(0),
    arrearsSince: z.iso.date().optional(),
  })
  .refine((row) => Boolean(row.unitId) || (Boolean(row.property) && Boolean(row.unit)), {
    message: 'Name the property and the unit.',
  });

export type ImportRow = z.infer<typeof importRowSchema>;

export const MAX_ROWS = 500;

/** Rules that need today's date or two fields together. Empty when the row is fine. */
export function rowProblems(row: ImportRow, today: string): string[] {
  const problems: string[] = [];
  const monthStart = `${today.slice(0, 7)}-01`;
  if (row.endDate <= row.startDate) problems.push('The lease must end after it starts.');
  if (row.startDate > today) {
    problems.push('This lease has not started yet. Add it through an application instead.');
  }
  if (row.arrearsCents > 0) {
    if (!row.arrearsSince) problems.push('Say since when the arrears are owed.');
    else {
      if (row.arrearsSince < row.startDate) problems.push('Arrears cannot be owed from before the lease started.');
      if (row.arrearsSince >= monthStart) {
        problems.push('Arrears are what was owed before this month. Put this month under "paid this month".');
      }
    }
  }
  return problems;
}

/**
 * The anniversary of the lease start on or before today: the date the current rent took
 * effect, if the lease escalates once a year as most do. Escalation counts from here.
 */
export function lastAnniversary(startDate: string, today: string): string {
  const [year, month, day] = [Number(startDate.slice(0, 4)), startDate.slice(5, 7), startDate.slice(8, 10)];
  for (let y = Number(today.slice(0, 4)); y >= year; y -= 1) {
    // 29 February falls back to the 28th in a year without one.
    let candidate = `${y}-${month}-${day}`;
    if (Number.isNaN(Date.parse(`${candidate}T00:00:00Z`)) || new Date(`${candidate}T00:00:00Z`).toISOString().slice(0, 10) !== candidate) {
      candidate = addDaysIso(`${y}-${month}-01`, 27);
    }
    if (candidate <= today) return candidate < startDate ? startDate : candidate;
  }
  return startDate;
}

/* ------------------------------------------------------------------ *
 * The spreadsheet
 * ------------------------------------------------------------------ */

/** Header names a landlord is likely to type, mapped to fields. Matched without case or spaces. */
const HEADERS: Record<string, keyof CsvFields> = {
  property: 'property', building: 'property', complex: 'property',
  unit: 'unit', unitcode: 'unit', flat: 'unit', door: 'unit',
  bedrooms: 'bedrooms', beds: 'bedrooms',
  bathrooms: 'bathrooms', baths: 'bathrooms',
  firstname: 'firstName', name: 'firstName', tenantfirstname: 'firstName',
  lastname: 'lastName', surname: 'lastName', tenantsurname: 'lastName', tenantlastname: 'lastName',
  email: 'email', emailaddress: 'email', tenantemail: 'email',
  phone: 'phone', mobile: 'phone', cell: 'phone', cellphone: 'phone', tenantphone: 'phone',
  idnumber: 'idNumber', id: 'idNumber', idno: 'idNumber',
  leasestart: 'startDate', start: 'startDate', startdate: 'startDate',
  leaseend: 'endDate', end: 'endDate', enddate: 'endDate',
  rent: 'rent', monthlyrent: 'rent', currentrent: 'rent',
  escalation: 'escalation', escalationpct: 'escalation', increase: 'escalation',
  deposit: 'deposit', depositheld: 'deposit',
  paidthismonth: 'paid', thismonthpaid: 'paid', currentmonthpaid: 'paid', paid: 'paid',
  arrears: 'arrears', owing: 'arrears', outstanding: 'arrears',
  arrearssince: 'arrearsSince', owingsince: 'arrearsSince', oldestunpaid: 'arrearsSince',
};

interface CsvFields {
  property: string; unit: string; bedrooms: string; bathrooms: string; firstName: string; lastName: string;
  email: string; phone: string; idNumber: string; startDate: string; endDate: string; rent: string;
  escalation: string; deposit: string; paid: string; arrears: string; arrearsSince: string;
}

export const CSV_TEMPLATE = [
  'Property,Unit,Bedrooms,Bathrooms,First name,Last name,Email,Phone,ID number,Lease start,Lease end,Rent,Escalation,Deposit held,Paid this month,Arrears,Arrears since',
  'Melville Gardens,G3,2,1,Thandi,Dlamini,thandi@example.co.za,082 123 4567,,2025-03-01,2027-02-28,7800,8,7800,yes,0,',
].join('\n');

export interface CsvRow {
  line: number;
  input: Record<string, unknown> | null;
  problems: string[];
}

const yes = (text: string) => /^(y|yes|true|1|paid|ja)$/i.test(text.trim());
const no = (text: string) => /^(n|no|false|0|unpaid|nee)?$/i.test(text.trim());

/** Turns the landlord's spreadsheet into rows for importRowSchema, saying what is wrong per line. */
export function parseTenancyCsv(text: string): { rows: CsvRow[]; missingColumns: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return { rows: [], missingColumns: [] };
  const delimiter = detectDelimiter(lines);
  const header = splitRow(lines[0]!, delimiter).map((cell) => HEADERS[cell.toLowerCase().replace(/[^a-z]/g, '')]);
  const required: (keyof CsvFields)[] = ['property', 'unit', 'firstName', 'lastName', 'email', 'phone', 'startDate', 'endDate', 'rent'];
  const missingColumns = required.filter((field) => !header.includes(field));
  if (missingColumns.length > 0) return { rows: [], missingColumns };

  const rows = lines.slice(1).map((raw, index): CsvRow => {
    const cells = splitRow(raw, delimiter);
    const get = (field: keyof CsvFields) => {
      const at = header.indexOf(field);
      return at >= 0 ? (cells[at] ?? '').trim() : '';
    };
    const problems: string[] = [];
    const money = (field: keyof CsvFields, label: string, fallback = 0) => {
      const value = get(field);
      if (!value) return fallback;
      const cents = parseAmount(value);
      if (cents === null || cents < 0) {
        problems.push(`${label} "${value}" is not an amount.`);
        return fallback;
      }
      return cents;
    };
    const date = (field: keyof CsvFields, label: string) => {
      const value = get(field);
      if (!value) return undefined;
      const parsed = parseDate(value);
      if (!parsed) problems.push(`${label} "${value}" is not a date. Use 2025-03-01 or 01/03/2025.`);
      return parsed ?? undefined;
    };
    const count = (field: keyof CsvFields) => {
      const value = get(field);
      return value && /^\d+$/.test(value) ? Number(value) : undefined;
    };
    const paidText = get('paid');
    if (!yes(paidText) && !no(paidText)) problems.push(`Paid this month "${paidText}" should be yes or no.`);
    const escalationText = get('escalation').replace('%', '').replace(',', '.');
    const escalation = escalationText ? Number(escalationText) : 0;
    if (Number.isNaN(escalation)) problems.push(`Escalation "${get('escalation')}" is not a percentage.`);

    const input = {
      property: get('property'),
      unit: get('unit'),
      bedrooms: count('bedrooms'),
      bathrooms: count('bathrooms'),
      firstName: get('firstName'),
      lastName: get('lastName'),
      email: get('email'),
      phone: get('phone'),
      idNumber: get('idNumber') || undefined,
      startDate: date('startDate', 'Lease start'),
      endDate: date('endDate', 'Lease end'),
      monthlyRentCents: money('rent', 'Rent'),
      escalationPct: Number.isNaN(escalation) ? 0 : escalation,
      depositHeldCents: money('deposit', 'Deposit'),
      currentMonthPaid: yes(paidText),
      arrearsCents: money('arrears', 'Arrears'),
      arrearsSince: date('arrearsSince', 'Arrears since'),
    };
    return { line: index + 2, input, problems };
  });
  return { rows, missingColumns };
}
