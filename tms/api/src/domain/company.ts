/**
 * The business that runs Threshold: on the terms of service, on invoices to landlords, and in
 * the footer. Set in the environment, so the same build serves any operator.
 */
export interface Company {
  name: string;
  legalName: string;
  registrationNo: string | null;
  vatNo: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export function company(): Company {
  const value = (name: string) => process.env[name]?.trim() || null;
  return {
    name: value('COMPANY_NAME') ?? 'Threshold',
    legalName: value('COMPANY_LEGAL_NAME') ?? value('COMPANY_NAME') ?? 'Threshold',
    registrationNo: value('COMPANY_REG_NO'),
    vatNo: value('COMPANY_VAT_NO'),
    address: value('COMPANY_ADDRESS'),
    email: value('COMPANY_EMAIL'),
    phone: value('COMPANY_PHONE'),
  };
}

export const VAT_RATE = 0.15;

/** VAT inside a VAT-inclusive amount: 15/115 of it, to the cent. Nothing when not registered. */
export const vatIn = (inclusiveCents: number, registered: boolean) =>
  registered ? Math.round((inclusiveCents * VAT_RATE) / (1 + VAT_RATE)) : 0;

/** Bump when the terms' substance changes: every landlord is asked to accept them again. */
export const TERMS_VERSION = '2026-10-28';
