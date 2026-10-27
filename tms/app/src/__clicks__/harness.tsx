import { PRIVACY_VERSION } from '../lib/privacy';
import type { ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@hlonie/toolbox/ui';

/** The suite's own API, started by global-setup.ts on a throwaway database. */
export const API = 'http://localhost:3101';

/** Signs in through the real /auth/login and primes the same storage the app uses, so every
    click carries the same Bearer token the browser would send. */
/**
 * A date this many days ahead, as YYYY-MM-DD. The suites used to say '2026-09-01', which was
 * the future when it was written; the API refuses a move-in date in the past, so from that
 * day on every suite that applied for a unit failed for a reason unrelated to the code.
 */
export function daysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export async function signInAs(email: string) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'dev' }),
  });
  if (!response.ok) throw new Error(`login failed for ${email}`);
  const { token, user } = await response.json();
  // @capacitor/preferences on the web keeps values in localStorage under this prefix.
  localStorage.setItem('CapacitorStorage.id_token', token);
  localStorage.setItem('tms.user', JSON.stringify(user));
  return user as { sub: string; role: string; name: string };
}

/** A raw API call with the current session's token, for arranging state between clicks. */
export async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem('CapacitorStorage.id_token');
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Renders a screen at a path exactly as the app would mount it, minus the auth guard the
    session above already satisfies. */
export function mount(path: string, routes: ReactElement) {
  // One screen at a time: the previous mount comes down first, as a navigation would.
  cleanup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>{routes}</Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

export { Route };

const SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Vitest orders test files by its own heuristics, so no suite may assume another ran first.
 * This arranges the shared fixture through the API: the fixed applicant approved on a unit
 * with a rendered lease — created from scratch when absent, reused when present.
 */
export async function ensureLease(options: { signed?: boolean } = {}): Promise<string> {
  await signInAs('landlord@example.co.za');

  const pick = async (): Promise<string | null> => {
    const approved = await call<any>('GET', '/applications?status=approved');
    const mine = approved.items.filter(
      (item: any) => item.applicant === 'Queue Applicant' && item.leaseId,
    );
    for (const item of mine) {
      const lease = await call<any>('GET', `/leases/${item.leaseId}`);
      if (lease.status !== 'terminated' && (!lease.termination || lease.termination.status !== 'settled')) {
        return item.leaseId;
      }
    }
    return null;
  };

  let leaseId = await pick();
  if (!leaseId) {
    const property = await call<{ id: string }>('POST', '/properties', {
      name: 'Queue Court',
      addressLine1: '2 Queue Lane',
      suburb: 'Linden',
      city: 'Johannesburg',
      province: 'Gauteng',
      postalCode: '2195',
    });
    const unit = await call<{ id: string }>('POST', `/properties/${property.id}/units`, {
      code: `Q${Date.now() % 1000}`,
      bedrooms: 2,
      bathrooms: 1,
      monthlyRentCents: 900000,
      depositCents: 900000,
    });

    // The fixed applicant: register once, sign in ever after.
    const register = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Queue Applicant',
        email: 'queue-applicant@example.co.za',
        password: 'a-long-password',
      }),
    });
    const applicant = register.ok
      ? await register.json()
      : await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'queue-applicant@example.co.za', password: 'a-long-password' }),
        }).then((r) => r.json());

    const landlordToken = localStorage.getItem('CapacitorStorage.id_token')!;
    localStorage.setItem('CapacitorStorage.id_token', applicant.token);
    const application = await call<{ id: string }>('POST', '/applications', {
      unitId: unit.id,
      firstName: 'Queue',
      lastName: 'Applicant',
      idNumber: '9001015009086',
      email: 'queue-applicant@example.co.za',
      phone: '0825550000',
      employmentStatus: 'employed',
      monthlyIncomeCents: 4000000,
      occupants: 1,
      preferredMoveIn: daysFromNow(30),
      consentVersion: PRIVACY_VERSION,
      pets: false,
    });
    localStorage.setItem('CapacitorStorage.id_token', landlordToken);

    await call('POST', `/applications/${application.id}/decision`, { outcome: 'approved' });
    const lease = await call<{ id: string }>('POST', `/applications/${application.id}/lease`, {
      startDate: daysFromNow(30),
      months: 12,
      escalationPct: 8,
    });
    await call('POST', `/leases/${lease.id}/render`, {});
    leaseId = lease.id;
  }

  if (options.signed) {
    const lease = await call<any>('GET', `/leases/${leaseId}`);
    if (lease.status === 'out_for_signature') {
      const signedParties = lease.signatures.map((signature: any) => signature.party);
      if (!signedParties.includes('landlord')) {
        await call('POST', `/leases/${leaseId}/signature`, {
          party: 'landlord',
          signatureBase64: SIG,
          otpVerified: true,
          pdfSha256: lease.pdfSha256,
        });
      }
      if (!signedParties.includes('tenant')) {
        const landlordToken = localStorage.getItem('CapacitorStorage.id_token')!;
        const tenant = await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'queue-applicant@example.co.za', password: 'a-long-password' }),
        }).then((r) => r.json());
        localStorage.setItem('CapacitorStorage.id_token', tenant.token);
        await call('POST', `/leases/${leaseId}/signature`, {
          party: 'tenant',
          signatureBase64: SIG,
          otpVerified: true,
          pdfSha256: lease.pdfSha256,
        });
        localStorage.setItem('CapacitorStorage.id_token', landlordToken);
      }
    }
  }
  return leaseId;
}
