-- What an applicant gave with each application, kept on the application.
--
-- The applicant row is one per sign-in and shared by every landlord the person applies to.
-- Applying to a second landlord rewrote its income, so the first landlord saw the figure given
-- to the second, and their past affordability rating changed under them. The figures a
-- decision was made on now stay with that application. The applicant row keeps the latest.
alter table application
  add column monthly_income_cents bigint check (monthly_income_cents >= 0),
  add column employment_status    text,
  add column employer             text;

-- Existing applications keep what the row says today: the best record there is, and it stops
-- them changing again.
update application a
   set monthly_income_cents = p.monthly_income_cents,
       employment_status = p.employment_status,
       employer = p.employer
  from applicant p
 where p.id = a.applicant_id and p.erased_at is null;
