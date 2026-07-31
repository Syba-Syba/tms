import { z } from 'zod';

/** Response targets by severity. An emergency is anything that makes the home unsafe or
    unlivable: burst geyser, raw sewage, exposed wiring, broken external lock. */
export const SLA_HOURS = { emergency: 24, urgent: 72, routine: 7 * 24 } as const;

export type Severity = keyof typeof SLA_HOURS;

export const targetBy = (severity: Severity, from = new Date()) =>
  new Date(from.getTime() + SLA_HOURS[severity] * 3600000);

export const createTicketSchema = z.object({
  category: z.enum(['plumbing', 'electrical', 'appliance', 'structural', 'pest', 'security', 'other']),
  severity: z.enum(['emergency', 'urgent', 'routine']),
  title: z.string().min(3).max(120),
  description: z.string().min(10, 'Describe it well enough for a contractor to quote.').max(3000),
});

export const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign'),
    contractor: z.object({
      name: z.string().min(1),
      trade: z.string().min(1),
      phone: z.string().min(9),
      email: z.string().email().optional(),
    }),
  }),
  z.object({ action: z.literal('quote'), quoteCents: z.number().int().positive(), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('approve_quote') }),
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('complete'), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal('cancel'), note: z.string().max(500).optional() }),
]);

export const commentSchema = z.object({ note: z.string().min(1).max(2000) });

export const closeSchema = z.object({
  rating: z.number().int().min(1).max(5),
  note: z.string().max(1000).optional(),
});

/** Legal transitions. Quotes are optional: a trusted contractor can start without one. */
const FLOW: Record<string, string[]> = {
  open: ['assigned', 'cancelled'],
  assigned: ['quote_pending', 'in_progress', 'cancelled'],
  quote_pending: ['quote_approved', 'cancelled'],
  quote_approved: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: ['closed'],
};

export const canMove = (from: string, to: string) => FLOW[from]?.includes(to) ?? false;
