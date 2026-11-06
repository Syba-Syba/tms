import { logger } from './logger';
import { mode } from './mode';

/**
 * The Cognito user pool the API Gateway authorizer trusts: COGNITO_USER_POOL_ID, or the last
 * part of the issuer URL (https://cognito-idp.<region>.amazonaws.com/<pool id>).
 */
function userPoolId(): string | null {
  if (process.env.COGNITO_USER_POOL_ID) return process.env.COGNITO_USER_POOL_ID;
  const issuer = process.env.COGNITO_ISSUER?.replace(/\/+$/, '');
  return issuer ? issuer.slice(issuer.lastIndexOf('/') + 1) || null : null;
}

/**
 * Deletes a person's Cognito sign-in once their identity is erased. In aws mode the account
 * lives in the user pool, not in local_credential, so deleting local rows left the email, name
 * and the sign-in itself in place. Elsewhere there is no pool, unless one is configured.
 *
 * Returns whether the sign-in is gone. A failure is logged for a retry by hand; the erasure in
 * the database has already happened and stands.
 */
export async function removeSignIn(sub: string): Promise<boolean> {
  const pool = userPoolId();
  if (!pool) {
    if (mode() === 'aws') logger.error('Erasure could not delete the Cognito sign-in: no user pool is configured.', { sub });
    return false;
  }
  try {
    const { AdminDeleteUserCommand, CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
    // The sub works as the username for a pool's own users.
    // Short timeouts: this runs at the end of a request with a 20s Lambda limit.
    const client = new CognitoIdentityProviderClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 4000 } });
    await client.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: sub }));
    return true;
  } catch (error) {
    if ((error as { name?: string })?.name === 'UserNotFoundException') return true;
    logger.error('Erasure could not delete the Cognito sign-in.', { sub, error });
    return false;
  }
}
