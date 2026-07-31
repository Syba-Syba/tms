-- The signing flow attests the SHA-256 of a report both parties reviewed, which only works if
-- an unsigned draft exists before the first signature. These columns hold that draft.

alter table inspection add column draft_s3_key text;
alter table inspection add column draft_sha256 text;
