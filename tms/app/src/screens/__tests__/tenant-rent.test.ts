import { describe, expect, it } from 'vitest';
import { invoicesWithPendingProof } from '../tenant-rent';

const invoices = [
  { id: 'jan', status: 'issued' },
  { id: 'feb', status: 'issued' },
  { id: 'dec', status: 'paid' },
];
const proof = (over: Partial<{ target: 'invoice' | 'deposit'; invoiceId: string | null; status: string }>) => ({
  target: 'invoice' as const, invoiceId: null, status: 'pending', ...over,
});

describe('invoicesWithPendingProof', () => {
  it('does not mark rent as "Proof sent" because a deposit slip is waiting', () => {
    expect([...invoicesWithPendingProof([proof({ target: 'deposit' })], invoices)]).toEqual([]);
  });

  it('marks the invoice a slip names, and every unpaid one for an untargeted rent slip', () => {
    expect([...invoicesWithPendingProof([proof({ invoiceId: 'feb' })], invoices)]).toEqual(['feb']);
    expect([...invoicesWithPendingProof([proof({})], invoices)]).toEqual(['jan', 'feb']);
    expect([...invoicesWithPendingProof([proof({ invoiceId: 'feb', status: 'accepted' })], invoices)]).toEqual([]);
  });
});
