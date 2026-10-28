import { json, route } from '../lib/http';
import { company, TERMS_VERSION } from '../domain/company';

/** Who runs the service, for the terms page and the footer. Public: it is on every invoice. */
export const handler = route(async () => json(200, { ...company(), termsVersion: TERMS_VERSION }));
