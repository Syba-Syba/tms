/**
 * The handlers validate their environment at import time, which is deliberate: with a single
 * Lambda serving every route, a missing variable now fails on the first request to anything
 * rather than lurking until someone happens to hit the one route that needed it.
 *
 * Tests still have to satisfy that check, so here are values that are obviously not real.
 */
process.env.AWS_REGION ??= 'af-south-1';
process.env.DB_HOST ??= 'localhost';
process.env.DB_NAME ??= 'tms_test';
process.env.DB_SECRET_ARN ??= 'arn:aws:secretsmanager:af-south-1:000000000000:secret:test';
process.env.DOCS_BUCKET ??= 'tms-test-docs';
process.env.KMS_KEY_ID ??= 'test-key';
process.env.NOTIFY_FROM ??= 'no-reply@example.invalid';
