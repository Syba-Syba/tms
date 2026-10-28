import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { isLandlord } from './session';

export interface Bank {
  name: string;
  holder: string;
  accountNumber: string;
  branchCode: string;
}

export interface LandlordAccount {
  account: {
    id: string;
    tradingName: string;
    email: string;
    phone: string;
    registrationNo: string | null;
    vatNo: string | null;
    slug: string | null;
    bank: Bank | null;
  };
  me: { role: 'owner' | 'agent' };
  teamSize: number;
  onboarding: { bank: boolean; property: boolean; unit: boolean; tenant: boolean; done: boolean };
}

/** The landlord account behind this sign-in. One query key, so a save anywhere refreshes all. */
export function useLandlord() {
  return useQuery({
    queryKey: ['landlord'],
    queryFn: () => api.get<LandlordAccount>('/landlord'),
    enabled: isLandlord(),
  });
}

/** The link a landlord shares so applicants see only their units. */
export const listingsUrl = (slug: string) => `${window.location.origin}/apply?landlord=${slug}`;
