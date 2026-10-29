-- Development seed only. Sipho's seeded application predates the consent rule, so it had no
-- record of his agreement to screening; every application made through the app has one.
-- `npm run db:check` reports an application without it as an error.
insert into consent (person_sub, kind, version, subject_id)
select 'sub-applicant', 'application_screening', '2026-10-27', a.id
  from application a
 where a.applicant_id = '44444444-4444-4444-4444-444444444445'
   and not exists (select 1 from consent k where k.kind = 'application_screening' and k.subject_id = a.id);
