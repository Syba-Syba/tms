import { z } from 'zod';

/** Seeded per unit so the walkthrough is a checklist, not a blank page. */
export const ROOM_TEMPLATE: Record<string, string[]> = {
  Entrance: ['Door and lock', 'Walls and paint', 'Flooring', 'Light fittings'],
  Lounge: ['Walls and paint', 'Flooring', 'Windows and latches', 'Curtain rails', 'Plugs and switches'],
  Kitchen: ['Sink and taps', 'Stove and oven', 'Cupboards', 'Counter tops', 'Flooring', 'Plugs and switches'],
  Bedroom: ['Walls and paint', 'Flooring', 'Windows and latches', 'Built-in cupboards', 'Plugs and switches'],
  Bathroom: ['Toilet', 'Basin and taps', 'Bath or shower', 'Tiling and grout', 'Geyser access', 'Extractor or window'],
  Exterior: ['Front door', 'Boundary and gate', 'Garden or yard', 'Post box', 'Prepaid meter reading'],
};

export const createInspectionSchema = z.object({
  kind: z.enum(['incoming', 'outgoing']),
  scheduledFor: z.coerce.date(),
});

export const findingSchema = z.object({
  room: z.string().min(1),
  item: z.string().min(1),
  condition: z.enum(['good', 'fair', 'poor', 'damaged', 'missing']),
  note: z.string().max(1000).optional(),
});

export const upsertFindingsSchema = z.object({
  findings: z.array(findingSchema).min(1).max(120),
});

export const signInspectionSchema = z.object({
  party: z.enum(['tenant', 'landlord']),
  signatureBase64: z.string().min(100),
  pdfSha256: z.string().length(64),
});

/** The outgoing window opens 3 days before lease end. Outside it, the inspection is invalid. */
export function outgoingWindow(leaseEnd: Date) {
  const opens = new Date(leaseEnd);
  opens.setDate(opens.getDate() - 3);
  return { opens, closes: leaseEnd };
}
