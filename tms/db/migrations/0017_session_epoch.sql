-- Signing out ends every session for the account, not just the one on this device.
-- Tokens carry a fingerprint of (password hash, session_epoch); bumping the epoch on logout
-- makes every token issued before it fail the check on the next request.
alter table local_credential add column session_epoch integer not null default 0;
