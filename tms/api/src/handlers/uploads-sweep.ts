import { query } from '../lib/db';
import { logger } from '../lib/logger';
import { storage } from '../lib/storage';

/** An upload link lasts five minutes; an hour is ample for the confirm to follow it. */
const STALE = `now() - interval '1 hour'`;
/** Rows per kind per run, so one run after a long outage cannot hold the database for minutes. */
const BATCH = 500;

const remove = async (key: string) => {
  // Removing a key that is already gone is not an error; a failure here is retried next hour
  // only for application documents (the pending entry stays), so it is logged, not thrown.
  await storage()
    .remove(key)
    .catch((error) => logger.warn('Upload sweep could not remove an object.', { key, error }));
};

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
  const removed = { documents: 0, ticketPhotos: 0, inspectionPhotos: 0, unitPhotos: 0, paymentSlips: 0 };

  // Documents: a pending entry no application_document took up is an abandoned upload. Each
  // entry is deleted only after its object, so a failed removal is tried again next run.
  const documents = await query<{ s3_key: string; confirmed: boolean }>(
    `select pu.s3_key, exists (select 1 from application_document d where d.s3_key = pu.s3_key) as confirmed
       from pending_upload pu
      where pu.created_at < ${STALE}
      order by pu.created_at
      limit ${BATCH}`,
  );
  for (const row of documents) {
    if (!row.confirmed) {
      await remove(row.s3_key);
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
  ];
  for (const [kind, sql] of photos) {
    const rows = await query<{ s3_key: string }>(sql);
    for (const row of rows) await remove(row.s3_key);
    removed[kind] = rows.length;
  }

  return removed;
}
