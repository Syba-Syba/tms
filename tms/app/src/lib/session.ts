import { Preferences } from '@capacitor/preferences';

/**
 * Who the app thinks you are: the person the token was issued to.
 *
 * Locally the token comes from the login screen via the API's local auth driver. In a
 * production build the same storage would hold the Cognito ID token, so nothing here is
 * development-only except the seeded hint on the login screen itself.
 */
export type Role = 'landlord' | 'tenant';

export interface SessionUser {
  sub: string;
  role: Role;
  name: string;
  email: string;
}

const USER_KEY = 'tms.user';

/** Synchronous, because the router guard and the shell render before any await could land. */
export function currentUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export async function startSession(token: string, user: SessionUser) {
  await Preferences.set({ key: 'id_token', value: token });
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export async function endSession() {
  await Preferences.remove({ key: 'id_token' });
  localStorage.removeItem(USER_KEY);
  // A full reload is the honest way to drop identity: every cached query belonged to the
  // person you just stopped being.
  window.location.assign('/login');
}

export const isLandlord = () => currentUser()?.role === 'landlord';
