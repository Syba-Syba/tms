-- Recording a payment was not idempotent: a double tap, a retried request after a timeout, or
-- a 500 thrown after the commit (the notification step ran outside the transaction) all led
-- to the same payment being recorded twice. The app now sends a key it generates when the
-- form opens; the key is written in the same transaction as the money, and the same key a
-- second time is answered with the stored result and changes nothing.

create table request_key (
  key         text        primary key,
  lease_id    uuid        not null references lease (id),
  action      text        not null,
  result      jsonb       not null,
  created_at  timestamptz not null default now()
);
