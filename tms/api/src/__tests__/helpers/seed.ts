import type { PGlite } from '@electric-sql/pglite';

export interface Seeded {
  landlordId: string;
  unitId: string;
  applicantId: string;
  leaseId: string;
  leaseRef: number;
}

const row = async <T>(db: PGlite, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

/** One landlord, one occupied unit, one active lease. Enough to exercise every later phase. */
export async function seedLease(db: PGlite, overrides: { endDate?: string } = {}): Promise<Seeded> {
  const landlord = await row<{ id: string }>(
    db,
    `insert into landlord (trading_name, email, phone, cognito_sub)
     values ('Mokoena Properties', 'landlord@example.co.za', '0821112222', 'sub-landlord') returning id`,
  );
  const property = await row<{ id: string }>(
    db,
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Kruis Court', '14 Kruis Avenue', 'Ferndale', 'Randburg', 'Gauteng', '2194') returning id`,
    [landlord.id],
  );
  const unit = await row<{ id: string }>(
    db,
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, 'A1', 2, 1, 850000, 850000, 'occupied') returning id`,
    [property.id],
  );
  const applicant = await row<{ id: string }>(
    db,
    `insert into applicant (cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                            email, phone, employment_status, monthly_income_cents)
     values ('sub-tenant', 'Naledi', 'Phiri', '\\x00', '0086', 'tenant@example.co.za',
             '0823419922', 'employed', 3100000) returning id`,
  );
  const application = await row<{ id: string }>(
    db,
    `insert into application (unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, 'approved', '2026-09-01') returning id`,
    [unit.id, applicant.id],
  );
  const lease = await row<{ id: string; ref_no: number }>(
    db,
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, pdf_sha256)
     values ($1, $2, $3, '2026-09-01', $4, 850000, 8, 850000, 'active', 'deadbeef')
     returning id, ref_no`,
    [application.id, unit.id, applicant.id, overrides.endDate ?? '2027-08-31'],
  );
  return {
    landlordId: landlord.id,
    unitId: unit.id,
    applicantId: applicant.id,
    leaseId: lease.id,
    leaseRef: lease.ref_no,
  };
}
