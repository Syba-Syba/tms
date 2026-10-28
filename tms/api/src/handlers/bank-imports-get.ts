import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { importDetail } from '../lib/bank';
import { badRequest, json, notFound, route } from '../lib/http';

export const handler = route(async (event) => {
  const importId = event.pathParameters?.id;
  if (!importId) throw badRequest('An import id is required.');
  const landlordId = await landlordIdFor(requireLandlord(event));
  // Another landlord's import is simply not found: its existence is not theirs to learn.
  const detail = await importDetail(importId, landlordId);
  if (!detail) throw notFound('Bank import');
  return json(200, detail);
});
