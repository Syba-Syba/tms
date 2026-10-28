import { query } from './db';
import { slugify } from '../domain/landlord';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface AccountRow {
  id: string;
  trading_name: string;
  email: string;
  phone: string;
  registration_no: string | null;
  vat_no: string | null;
  slug: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
}

export const ACCOUNT_COLUMNS = `id, trading_name, email, phone, registration_no, vat_no, slug, bank_name, bank_account_holder,
  bank_account_number, bank_branch_code`;

export async function accountById(landlordId: string): Promise<AccountRow | null> {
  const [row] = await query<AccountRow>(`select ${ACCOUNT_COLUMNS} from landlord where id = $1`, [landlordId]);
  return row ?? null;
}

/** A free listings link from a business name: the name itself, else the name and a number. */
export async function freeSlug(run: Run, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [taken] = await run<{ id: string }>('select id from landlord where slug = $1', [candidate]);
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Bank details as payers see them: on invoices, the letter of demand and the rent screen. */
export const bankOf = (row: Pick<AccountRow, 'bank_name' | 'bank_account_holder' | 'bank_account_number' | 'bank_branch_code'>) =>
  row.bank_name && row.bank_account_holder && row.bank_account_number && row.bank_branch_code
    ? {
        name: row.bank_name,
        holder: row.bank_account_holder,
        accountNumber: row.bank_account_number,
        branchCode: row.bank_branch_code,
      }
    : null;
