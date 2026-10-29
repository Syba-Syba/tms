import { createHttpClient } from '@hlonie/toolbox/data';
import { Preferences } from '@capacitor/preferences';

/** Capacitor Preferences works on Android and falls back to localStorage on the web build. */
const getToken = async () => (await Preferences.get({ key: 'id_token' })).value;

// An empty value in .env would defeat a nullish fallback, so blank counts as absent.
const configured = (import.meta.env.VITE_API_URL ?? '').trim();

/**
 * "/" means the API answers on the same origin that served this page, which is how the
 * self-hosted server runs: one process, one port, no CORS. The Android build cannot use it —
 * its origin is the WebView's — so that one sets an absolute URL.
 *
 * A production build with neither is refused by vite.config.ts rather than quietly baking in
 * localhost, which is what used to happen and failed on every call once deployed.
 */
export const baseUrl =
  configured === '/'
    ? (typeof window === 'undefined' ? 'http://localhost:3001' : window.location.origin)
    : configured || 'http://localhost:3001';

export const api = createHttpClient({
  baseUrl,
  getToken,
  onUnauthorised: async () => {
    // A dead token means every answer would be someone else's; sign in again.
    await Preferences.remove({ key: 'id_token' });
    localStorage.removeItem('tms.user');
    // A full page load cannot carry router state, so the page they were on travels as ?from=
    // and login.tsx sends them back there (through safeReturnPath) once they sign in again.
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(
      window.location.pathname.startsWith('/login') ? '/login' : `/login?from=${encodeURIComponent(here)}`,
    );
  },
});

export interface ApplicationSummary {
  id: string;
  status: string;
  applicant: string;
  unit: string;
  submittedAt: string;
  preferredMoveIn: string;
  occupants: number;
  monthlyRentCents: number;
  monthlyIncomeCents: number;
  affordability: { ratio: number; band: 'comfortable' | 'tight' | 'over' };
  documentCount: number;
  leaseId: string | null;
  leaseStatus: string | null;
}

/**
 * Fetches a short-lived signed link for a stored document and opens it in a new tab.
 *
 * The tab is opened before anything is awaited: browsers only allow window.open inside the
 * click itself, and the signed-link round trip used to push it past that, so on phones the
 * popup was blocked and the document never appeared. The key may be a function (render the
 * invoice, then open it) and still gets the tab, for the same reason.
 */
export async function openDocument(key: string | (() => Promise<string>)) {
  const tab = window.open('', '_blank');
  try {
    const resolved = typeof key === 'string' ? key : await key();
    const { viewUrl } = await api.post<{ viewUrl: string }>('/files/view', { key: resolved });
    if (tab) {
      // The document page must not be able to reach back into the app.
      tab.opener = null;
      tab.location.replace(viewUrl);
    } else if (!window.open(viewUrl, '_blank', 'noopener')) {
      // Blocked outright: show it here. Back returns to the app.
      window.location.assign(viewUrl);
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Fetches a short-lived signed link without opening it, for inline images. */
export async function signedUrl(key: string) {
  const { viewUrl } = await api.post<{ viewUrl: string }>('/files/view', { key });
  return viewUrl;
}

/** The server explains refusals precisely ("suburb: at least 2 characters"); this unwraps
    that explanation so a toast never says less than the API did. */
/** The API's machine-readable reason, e.g. 'code_required', or null. */
export const errorCode = (error: unknown): string | null =>
  (error as { body?: { error?: { code?: string } } })?.body?.error?.code ?? null;

export function humanError(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  const body = (error as { body?: { error?: { message?: string; details?: Record<string, string> } } })?.body;
  if (!body?.error) {
    // No response body at all means the request never reached the API.
    if (error instanceof TypeError || !(error as { status?: number }).status) {
      // A tenant on a phone cannot act on "run npm run dev"; only a developer sees that hint.
      return import.meta.env.DEV
        ? `Could not reach the API at ${baseUrl}. Make sure \`npm run dev\` shows both api and app running, then try again.`
        : 'Could not reach the server. Check your connection and try again.';
    }
    return fallback;
  }
  const lines = [body.error.message ?? fallback];
  for (const [field, problem] of Object.entries(body.error.details ?? {})) {
    lines.push(`${field}: ${problem}`);
  }
  return lines.join(' ');
}
