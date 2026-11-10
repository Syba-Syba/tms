import { query } from '../lib/db';
import { logger } from '../lib/logger';
import { storage } from '../lib/storage';
import { keptKeySql } from './documents-presign';

/** An upload link lasts five minutes; an hour is ample for the confirm to follow it. */
const STALE = `now() - interval '1 hour'`;
/** Rows per kind per run, so one run after a long outage cannot hold the database for minutes. */
const BATCH = 500;

/** True once the object is gone. Removing a key that is already gone is not an error. */
const remove = (key: string) =>
  storage()
    .remove(key)
    .then(() => true)
    .catch((error) => (logger.warn('Upload sweep could not remove an object.', { key, error }), false));

/**
 * Hourly: deletes uploads that were started and never confirmed, and the rows that pointed at
 * them. Upload links write up to 15 MB each, and before this nothing ever cleaned up after a
 * link that was used but not confirmed, so storage only grew.
 *
 * Covers application documents (recorded in pending_upload, since they have no row until
 * confirmed), ticket, inspection and listing photos (uploaded = false), and payment slips
 * still 'uploading'. Confirmed uploads are never touched.
 */
export async function handler() {
  const removed = { documents: 0, ticketPhotos: 0, inspectionPhotos: 0, unitPhotos: 0, paymentSlips: 0, expenseSlips: 0, noticeEvidence: 0 };

  // Documents: a pending entry no application_document took up is an abandoned upload. Each
  // entry is deleted only after its object, so a failed removal is tried again next run.
  const documents = await query<{ s3_key: string; confirmed: boolean; kept: boolean }>(
    `select pu.s3_key,
            exists (select 1 from application_document d where d.s3_key = pu.s3_key) as confirmed,
            exists (select 1 from application_document d where d.s3_key in (${keptKeySql('pu.s3_key')})) as kept
       from pending_upload pu
      where pu.created_at < ${STALE}
      order by pu.created_at
      limit ${BATCH}`,
  );
  for (const row of documents) {
    if (row.kept) {
      // Confirm keeps a checked copy and removes the upload; this catches one it missed.
      // A document filed before copies were kept is stored under the upload key itself.
      // On a failed remove the entry stays, so the next run retries it.
      if (!row.confirmed && !(await remove(row.s3_key))) continue;
    } else if (!row.confirmed) {
      // The pending entry is the only record of this object: kept until the object is gone.
      if (!(await remove(row.s3_key))) continue;
      removed.documents += 1;
    }
    await query('delete from pending_upload where s3_key = $1', [row.s3_key]);
  }

  // Photos: the row goes first (returning its key), so a confirm racing the sweep either wins
  // and keeps the photo, or finds no row and is told the upload is gone.
  const photos: Array<[keyof typeof removed, string]> = [
    ['ticketPhotos', `delete from ticket_photo where id in (
        select id from ticket_photo where not uploaded and uploaded_at < ${STALE} limit ${BATCH})
      returning s3_key`],
    ['inspectionPhotos', `delete from inspection_photo where id in (
        select id from inspection_photo where not uploaded and uploaded_at < ${STALE} limit ${BATCH})
      returning s3_key`],
    ['unitPhotos', `delete from unit_photo where id in (
        select id from unit_photo where not uploaded and created_at < ${STALE} limit ${BATCH})
      returning s3_key`],
    // A slip never sent was never seen by the landlord, and nothing else refers to it.
    ['paymentSlips', `delete from payment_proof where id in (
        select id from payment_proof where status = 'uploading' and created_at < ${STALE} limit ${BATCH})
      returning s3_key`],
    // A written notice uploaded and never attached. Attaching deletes the entry, so any left is unused.
    ['noticeEvidence', `delete from notice_evidence where s3_key in (
        select s3_key from notice_evidence where created_at < ${STALE} limit ${BATCH})
      returning s3_key`],
  ];
  // Expense slips: a slip never confirmed still has its upload key. The expense stays; only
  // the unchecked file and the pointer to it go. Only the last two days are looked at: slips
  // from before the confirm step existed also have raw keys, and those are real receipts.
  // File first, then the row, so a failed removal is tried again next hour.
  const slips = await query<{ id: string; slip_s3_key: string }>(
    `select id, slip_s3_key from expense
      where slip_s3_key is not null and slip_s3_key !~ '\\.kept\\.[a-z]+$'
        and created_at < ${STALE} and created_at > now() - interval '2 days'
      limit ${BATCH}`,
  );
  for (const row of slips) {
    const gone = await storage()
      .remove(row.slip_s3_key)
      .then(() => true)
      .catch((error) => (logger.warn('Upload sweep could not remove an object.', { key: row.slip_s3_key, error }), false));
    if (!gone) continue;
    // The key check skips a slip confirmed while the sweep ran.
    await query('update expense set slip_s3_key = null where id = $1 and slip_s3_key = $2', [row.id, row.slip_s3_key]);
    removed.expenseSlips += 1;
  }

  for (const [kind, sql] of photos) {
    const rows = await query<{ s3_key: string }>(sql);
    for (const row of rows) await remove(row.s3_key);
    removed[kind] = rows.length;
  }

  return removed;
}
