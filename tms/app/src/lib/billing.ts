import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { formatDate } from './format';

export type PlanId = 'starter' | 'standard' | 'pro';

export interface Billing {
  driver: 'payfast' | 'local' | 'off';
  standing: 'trial' | 'active' | 'past_due' | 'cancelling' | 'lapsed';
  status: 'trialing' | 'active' | 'past_due' | 'cancelled';
  plan: PlanId | null;
  trialEndsOn: string;
  paidUntil: string | null;
  graceDays: number;
  hasRecurring: boolean;
  units: number;
  allowance: number | null;
  recommended: PlanId | null;
  plans: { id: PlanId; name: string; maxUnits: number; priceCents: number }[];
  isOwner: boolean;
}

export const useBilling = (enabled = true) =>
  useQuery({ queryKey: ['billing'], queryFn: () => api.get<Billing>('/billing'), enabled, retry: false });

/** One sentence on where the account stands, used here and in the banner. */
export function standingText(billing: Billing): string {
  const plan = billing.plans.find((item) => item.id === billing.plan);
  switch (billing.standing) {
    case 'trial':
      return `Free trial until ${formatDate(billing.trialEndsOn)}.`;
    case 'active':
      return `${plan?.name ?? 'Paid'} plan, paid until ${formatDate(billing.paidUntil)}.`;
    case 'past_due':
      return `The last payment did not go through. Pay within ${billing.graceDays} days of ${formatDate(billing.paidUntil)} or the account turns read-only.`;
    case 'cancelling':
      return `Cancelled. Everything works until ${formatDate(billing.paidUntil)}.`;
    default:
      return 'Your plan has lapsed. You can see everything, but nothing can be changed until a plan is paid for.';
  }
}

