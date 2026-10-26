#!/usr/bin/env node
/**
 * Downloads the Amazon RDS global certificate bundle into certs/, which lib/db.ts reads and
 * serverless packages into every function.
 *
 * The bundle is not committed: it is a rotating public artefact, and a stale copy in git is a
 * TLS failure nobody looks for. `predeploy` runs this, so a deploy always ships a current one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../certs/rds-global-bundle.pem');

const response = await fetch(URL_);
if (!response.ok) {
  console.error(`Could not fetch the RDS CA bundle: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const body = await response.text();
// A proxy that answers with an HTML error page would otherwise be written out as a "bundle"
// and only fail later, at the point of connecting.
if (!body.includes('-----BEGIN CERTIFICATE-----')) {
  console.error(`${URL_} did not return a PEM bundle.`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body);
const count = body.split('-----BEGIN CERTIFICATE-----').length - 1;
console.log(`Wrote ${count} certificates to ${OUT}`);
