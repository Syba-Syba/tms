import { requireLeaseAccess } from '../lib/access';
import { badRequest, forbidden, json, route } from '../lib/http';
import { renderLeaseDocument } from '../lib/lease-document';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/recipients';

/**
 * Renders the lease PDF whose SHA-256 the signing flow verifies.
 *
 * Only before anyone has signed. pdf-lib's output is not byte-for-byte reproducible, so a
 * re-render after a signature replaced the attested document with one the signatures' hashes
 * no longer match, and the lease stores one key, so the signed copy was gone for good.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  // Membership of the landlord group used to be enough to render any lease at all.
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord renders the lease.');

  const { key, sha256, status } = await renderLeaseDocument(leaseId);

  // Once per lease: the first document is the news. A re-render before anyone signs is a
  // correction, and the tenant sees the current one when they open it.
  try {
    const parties = await leaseParties(leaseId);
    if (parties?.tenant && ['out_for_signature', 'scheduled'].includes(status)) {
      await notify({
        leaseId,
        to: parties.tenant,
        kind: 'lease_ready_to_sign',
        dedupeKey: `lease_ready_to_sign:${leaseId}`,
        data: { reference: parties.reference, unit: parties.unit, startDate: parties.startDate },
      });
    }
  } catch (error) {
    logger.error('Lease ready notification failed.', { leaseId, error });
  }

  return json(200, { key, sha256 });
});
