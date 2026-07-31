import { z } from 'zod';
import { signToken } from '../lib/authtoken';
import { verifyPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { json, parseBody, route, ApiError } from '../lib/http';

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

/** Only the local driver answers here. In production, Cognito's hosted UI signs people in and
    API Gateway checks the token, so this route existing would be a misconfiguration. */
const requireLocalDriver = () => {
  if (process.env.AUTH_DRIVER !== 'local' || process.env.NODE_ENV !== 'development') {
    throw new ApiError(404, 'not_found', 'Sign-in is handled by Cognito in this environment.');
  }
};

export const handler = route(async (event) => {
  requireLocalDriver();
  const input = parseBody(event, schema);

  const [credential] = await query<{
    sub: string;
    email: string;
    name: string;
    role: 'landlord' | 'tenant';
    password_hash: string;
  }>('select sub, email, name, role, password_hash from local_credential where email = $1', [
    input.email.toLowerCase(),
  ]);

  // One message for both failures, so the form never confirms which emails exist.
  if (!credential || !verifyPassword(input.password, credential.password_hash)) {
    throw new ApiError(401, 'unauthorised', 'That email and password do not match.');
  }

  const user = {
    sub: credential.sub,
    role: credential.role,
    name: credential.name,
    email: credential.email,
  };
  await audit({
    actorSub: user.sub,
    actorRole: user.role,
    action: 'auth.login',
    entity: 'credential',
    // Credentials key on sub, not a uuid, so the id column stays empty.
    entityId: null,
    detail: { email: user.email },
  });
  return json(200, { token: signToken(user), user });
});
