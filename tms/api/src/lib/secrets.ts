import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { env } from './env';

/**
 * The database password lives in Secrets Manager rather than in the function's environment,
 * because anyone who can describe a Lambda can read its environment. serverless.yml grants
 * secretsmanager:GetSecretValue on exactly this one ARN.
 *
 * DB_SECRET_ARN was required by lib/env.ts and granted in IAM from the first deploy config,
 * but nothing ever read it, so pg connected with an undefined password.
 */
let cached: Promise<string> | undefined;

export function databasePassword(): Promise<string> {
  // The promise is cached rather than the value, so concurrent first calls share one request.
  cached ??= fetchPassword().catch((error: unknown) => {
    // A rejection must not stay cached, or one throttled call poisons the whole container.
    cached = undefined;
    throw error;
  });
  return cached;
}

async function fetchPassword(): Promise<string> {
  const client = new SecretsManagerClient({ region: env.AWS_REGION });
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: env.DB_SECRET_ARN }),
  );
  if (!SecretString) {
    throw new Error(`Secret ${env.DB_SECRET_ARN} holds no SecretString.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(SecretString);
  } catch {
    // A secret created by hand is usually the bare password. One created by RDS is the JSON
    // shape below, so both are accepted rather than only the one this happened to be built on.
    return SecretString;
  }

  const password = (parsed as { password?: unknown }).password;
  if (typeof password !== 'string') {
    throw new Error(`Secret ${env.DB_SECRET_ARN} has no string "password" field.`);
  }
  return password;
}
