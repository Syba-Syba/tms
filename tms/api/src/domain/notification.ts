import { z } from 'zod';

export const CATEGORIES = ['money', 'maintenance', 'inspection', 'lease', 'deadline'] as const;
export const CHANNELS = ['email', 'whatsapp', 'push'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Channel = (typeof CHANNELS)[number];

/** Templates read fields through this, so a missing one throws instead of emailing a tenant
    the word "undefined". A rent notice with a blank amount is worse than no notice. */
export type Field = (key: string) => string;

export interface Template {
  category: Category;
  urgent: boolean;
  subject: (d: Field) => string;
  body: (d: Field) => string;
}

function fieldReader(kind: string, data: Record<string, string>): Field {
  return (key) => {
    const value = data[key];
    if (value === undefined) throw new Error(`Notification "${kind}" is missing "${key}".`);
    return value;
  };
}

/* Wording rules for everything below: say what happened, say the number, say the date, say what
   the reader does next. No "Dear valued tenant". A rent reminder that buries the amount is
   worse than no reminder. */
export const TEMPLATES: Record<string, Template> = {
  invoice_issued: {
    category: 'money',
    urgent: false,
    subject: (d) => `Rent for ${d('period')}: ${d('amount')}`,
    body: (d) =>
      `Your rent for ${d('period')} is ${d('amount')}, due ${d('dueOn')}.\n\n` +
      `Pay by EFT using the reference ${d('reference')} exactly, or the payment cannot be matched to your unit.\n\n` +
      `${d('unit')}`,
  },
  charge_added: {
    category: 'money',
    urgent: false,
    subject: (d) => `${d('description')}: ${d('amount')} added to your ${d('period')} invoice`,
    body: (d) =>
      `Your landlord added ${d('description')} of ${d('amount')} to your ${d('period')} invoice for ${d('unit')}. ` +
      `It now comes to ${d('total')}.\n\nPay by EFT using the reference ${d('reference')}. ` +
      `If you think it is wrong, ask your landlord for the meter reading or the account it comes from.`,
  },
  payment_received: {
    category: 'money',
    urgent: false,
    subject: (d) => `Payment received: ${d('amount')}`,
    body: (d) =>
      `We received ${d('amount')} on ${d('receivedOn')}. ${d('balanceLine')}\n\n${d('unit')}`,
  },
  rent_overdue: {
    category: 'money',
    urgent: false,
    subject: (d) => `Rent for ${d('period')} is ${d('daysLate')} days late`,
    body: (d) =>
      `${d('amount')} for ${d('period')} was due on ${d('dueOn')} and is still outstanding.\n\n` +
      `Pay by EFT using the reference ${d('reference')}. If something has gone wrong, tell your landlord before it grows.\n\n` +
      `${d('unit')}`,
  },
  proof_submitted: {
    category: 'money',
    urgent: false,
    subject: (d) => `Proof of payment from ${d('tenant')}: ${d('amount')}`,
    body: (d) =>
      `${d('tenant')} says they paid ${d('amount')} on ${d('paidOn')} for ${d('unit')}, reference ${d('reference')}.\n\n` +
      `Check your bank account, then accept or reject the slip in the app. Their rent shows as "proof sent" until you do.`,
  },
  proof_rejected: {
    category: 'money',
    urgent: false,
    subject: (d) => `Your proof of payment for ${d('amount')} was not accepted`,
    body: (d) =>
      `The slip you sent for ${d('amount')} on ${d('paidOn')} was not accepted.\n\nReason: ${d('reason')}\n\n` +
      `Reply in the app or send a new slip. ${d('unit')}`,
  },
  arrears_reminder_1: {
    category: 'money',
    urgent: false,
    subject: (d) => `Rent not received yet: ${d('amount')}`,
    body: (d) =>
      `We have not received ${d('amount')} for ${d('unit')}, which was due on ${d('dueOn')}.\n\n` +
      `If you have already paid, send your proof of payment in the app and ignore this. If not, pay by EFT ` +
      `with the reference ${d('reference')}.`,
  },
  arrears_reminder_3: {
    category: 'money',
    urgent: false,
    subject: (d) => `Rent is ${d('daysLate')} days late: ${d('amount')}`,
    body: (d) =>
      `${d('amount')} for ${d('unit')} is still outstanding. It was due on ${d('dueOn')}.\n\n` +
      `Pay by EFT with the reference ${d('reference')}. If you cannot pay in full, reply now and agree a plan ` +
      `with your landlord; it stops these reminders.`,
  },
  arrears_reminder_7: {
    category: 'money',
    urgent: true,
    subject: (d) => `Final reminder: ${d('amount')} overdue`,
    body: (d) =>
      `${d('amount')} for ${d('unit')} is ${d('daysLate')} days overdue.\n\n` +
      `This is the last reminder. If it stays unpaid, your landlord may send a formal letter of demand, which ` +
      `is the first step towards cancelling the lease. Pay with the reference ${d('reference')}, or contact ` +
      `your landlord today to agree a payment plan.`,
  },
  arrears_letter_ready: {
    category: 'money',
    urgent: false,
    subject: (d) => `${d('tenant')} owes ${d('amount')}: letter of demand ready`,
    body: (d) =>
      `${d('tenant')} at ${d('unit')} owes ${d('amount')}, ${d('daysLate')} days late, and has had three reminders.\n\n` +
      `Open the lease in the app to review and send the letter of demand, or pause reminders if you have agreed a plan.`,
  },
  // Deadline, so it cannot be switched off: changed bank details are how rent gets stolen.
  landlord_bank_changed: {
    category: 'deadline',
    urgent: true,
    subject: (d) => `${d('landlord')} changed the account for your rent`,
    body: (d) =>
      `From now on, rent for ${d('unit')} goes to ${d('bank')}, account ending ${d('last4')}. Keep using the reference ${d('reference')}.\n\n` +
      `If ${d('landlord')} did not tell you about this themselves, phone them on ${d('phone')} before you pay. ` +
      `Changing bank details is a common way to steal rent, and the rent screen in the app always shows the account on file.`,
  },
  letter_of_demand: {
    category: 'deadline',
    urgent: true,
    subject: (d) => `Letter of demand: pay ${d('amount')} by ${d('remedyBy')}`,
    body: (d) =>
      `Your landlord has issued a letter of demand for ${d('amount')} in rent arrears on ${d('unit')}.\n\n` +
      `You have until ${d('remedyBy')} to pay in full, using the reference ${d('reference')}. If it is not paid ` +
      `by then, your landlord may cancel the lease and recover the arrears.\n\n` +
      `The letter is in the app under your lease. If you have paid already, send your proof of payment there.`,
  },
  ticket_raised: {
    category: 'maintenance',
    urgent: true,
    subject: (d) => `${d('severityLabel')}: ${d('title')}`,
    body: (d) =>
      `${d('tenant')} reported a problem at ${d('unit')}.\n\n${d('title')}\n${d('description')}\n\n` +
      `This is ${d('severityLabel').toLowerCase()}, so the response target is ${d('targetBy')}.`,
  },
  ticket_assigned: {
    category: 'maintenance',
    urgent: false,
    subject: (d) => `${d('contractor')} is coming about ${d('title')}`,
    body: (d) =>
      `${d('contractor')} (${d('trade')}) has been assigned to ${d('title')} at ${d('unit')}.\n\n` +
      `You can reach them on ${d('phone')}. Message in the app if the timing does not suit you.`,
  },
  ticket_done: {
    category: 'maintenance',
    urgent: false,
    subject: (d) => `Work finished: ${d('title')}`,
    body: (d) =>
      `${d('contractor')} marked ${d('title')} complete.\n\n` +
      `Check it, then close the ticket and rate the work. Your rating decides who gets called next time.`,
  },
  sla_breach_soon: {
    category: 'deadline',
    urgent: true,
    subject: (d) => `${d('title')} is due in ${d('hoursLeft')} hours`,
    body: (d) =>
      `The ${d('severityLabel').toLowerCase()} ticket "${d('title')}" at ${d('unit')} has a response target of ${d('targetBy')}.\n\n` +
      `It is still ${d('status')}.`,
  },
  sla_breached: {
    category: 'deadline',
    urgent: true,
    subject: (d) => `Overdue: ${d('title')}`,
    body: (d) =>
      `The response target for "${d('title')}" at ${d('unit')} passed on ${d('targetBy')} and it is still ${d('status')}.`,
  },
  inspection_scheduled: {
    category: 'inspection',
    urgent: false,
    subject: (d) => `${d('kindLabel')} inspection on ${d('date')}`,
    body: (d) =>
      `The ${d('kindLabel').toLowerCase()} inspection for ${d('unit')} is set for ${d('date')}.\n\n` +
      `Both of you need to be there and both of you sign it. ${d('consequence')}`,
  },
  inspection_tomorrow: {
    category: 'inspection',
    urgent: false,
    // Dated rather than "tomorrow": a sweep that missed a morning sends it on the day itself.
    subject: (d) => `${d('kindLabel')} inspection on ${d('date')} at ${d('unit')}`,
    body: (d) => `A reminder that the ${d('kindLabel').toLowerCase()} inspection for ${d('unit')} is on ${d('date')}.`,
  },
  lease_signed: {
    category: 'lease',
    urgent: false,
    subject: () => 'Your lease is signed',
    body: (d) =>
      `Both signatures are on ${d('reference')} for ${d('unit')}.\n\n` +
      `Your copy is attached to the lease in the app. It records the date, time, device and a fingerprint of the exact document.`,
  },
  application_approved: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Your application for ${d('unit')} is approved`,
    body: (d) =>
      `The landlord approved your application for ${d('unit')}.\n\n` +
      `The lease comes next: you will get a message when it is ready to read and sign in the app.`,
  },
  application_declined: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Your application for ${d('unit')} was not approved`,
    body: (d) => `The landlord declined your application for ${d('unit')}.\n\nThe reason given: ${d('reason')}`,
  },
  application_withdrawn: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Your application for ${d('unit')} was withdrawn`,
    body: (d) =>
      `The landlord withdrew your application for ${d('unit')}, and the lease that went with it is cancelled. ` +
      `Nothing you signed on it binds you, and no inspection on it will go ahead.\n\n` +
      `If you think this is a mistake, contact the landlord directly.`,
  },
  lease_ready_to_sign: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Your lease for ${d('unit')} is ready to sign`,
    body: (d) =>
      `Lease ${d('reference')} for ${d('unit')} is ready. Read it and sign it in the app.\n\n` +
      `It starts on ${d('startDate')}.`,
  },
  lease_activated: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Your lease for ${d('unit')} starts today`,
    body: (d) =>
      `Lease ${d('reference')} for ${d('unit')} is now active. Rent invoices for it will appear in the app.`,
  },
  notice_served: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Notice served, lease ends ${d('effectiveOn')}`,
    body: (d) =>
      `Notice was served on ${d('noticeGivenOn')} and the lease for ${d('unit')} ends ${d('effectiveOn')}.\n\n` +
      `The exit inspection must happen in the last three days of the lease, with both of you there. ` +
      `Skip it and the law treats the place as undamaged, so nothing can be deducted.`,
  },
  deposit_settled: {
    category: 'money',
    urgent: false,
    subject: (d) => `Deposit statement: ${d('headline')}`,
    body: (d) =>
      `The deposit for ${d('unit')} has been reconciled.\n\n${d('breakdown')}\n\n` +
      `Payable by ${d('dueBy')}. The full statement, with move-in and move-out photos for anything charged, is in the app.`,
  },
  refund_due_soon: {
    category: 'deadline',
    urgent: true,
    subject: (d) => `Deposit refund due ${d('dueBy')}`,
    body: (d) =>
      `${d('amount')} is owed to ${d('tenant')} for ${d('unit')} and the statutory deadline is ${d('dueBy')}, ` +
      `${d('daysLeft')} days away.\n\nMissing it is a Rental Housing Tribunal matter.`,
  },
  renewal_offered: {
    category: 'lease',
    urgent: false,
    subject: (d) => `Renewal offer for ${d('unit')}: ${d('newRent')} a month`,
    body: (d) =>
      `Your lease can carry on from ${d('startDate')} to ${d('endDate')} at ${d('newRent')} a month.\n\n` +
      `${d('topUpLine')}\n\n` +
      `Accept or decline in the app by ${d('respondBy')}. If you do nothing the offer lapses and the lease ends on its date.`,
  },
  renewal_accepted: {
    category: 'lease',
    urgent: false,
    subject: (d) => `${d('tenant')} is staying at ${d('unit')}`,
    body: (d) =>
      `${d('tenant')} accepted the renewal. The new lease starts ${d('startDate')} once you have both ` +
      `signed it: open it in the app to sign.\n\nDeposit top-up owed: ${d('topUp')}.`,
  },
  renewal_declined: {
    category: 'lease',
    urgent: false,
    subject: (d) => `${d('tenant')} is not renewing ${d('unit')}`,
    body: (d) =>
      `${d('tenant')} declined the renewal, so the lease ends on its date.\n\n${d('note')}\n\n` +
      `Book the exit inspection for the last three days of the lease.`,
  },
  renewal_expiring: {
    category: 'deadline',
    urgent: false,
    subject: (d) => `Renewal offer expires ${d('respondBy')}`,
    body: (d) =>
      `The renewal for ${d('unit')} at ${d('newRent')} a month has not been answered and the offer ` +
      `expires on ${d('respondBy')}, ${d('daysLeft')} days away.`,
  },
  lease_ending_soon: {
    category: 'lease',
    urgent: false,
    subject: (d) => `${d('unit')} lease ends ${d('endDate')}`,
    body: (d) =>
      `The lease for ${d('unit')} ends on ${d('endDate')}, ${d('daysLeft')} days away.\n\n` +
      `Decide on renewal, or book the exit inspection for the last three days of the lease.`,
  },
};

/** A subject is one line. A ticket title is typed by a tenant, and it is most of the subject
    of an urgent email to the landlord, so a newline or an essay in it is cut down here. */
export const subjectLine = (value: string) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? `${flat.slice(0, 109).trimEnd()}…` : flat;
};

export const render = (kind: string, data: Record<string, string>) => {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`No notification template for "${kind}".`);
  const field = fieldReader(kind, data);
  return {
    category: template.category,
    urgent: template.urgent,
    subject: subjectLine(template.subject(field)),
    body: template.body(field),
  };
};

/* ------------------------------------------------------------------ *
 * Quiet hours
 * ------------------------------------------------------------------ */

/** South Africa sits on UTC+2 all year, with no daylight saving to complicate this. */
const SAST_OFFSET_HOURS = 2;
export const QUIET_FROM_HOUR = 20;
export const QUIET_UNTIL_HOUR = 7;

export const sastHour = (at: Date) => (at.getUTCHours() + SAST_OFFSET_HOURS) % 24;

export const inQuietHours = (at: Date) => {
  const hour = sastHour(at);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
};

/**
 * Urgent messages go out immediately, because a burst geyser at 23:00 is worth waking up for.
 * Everything else waits until 07:00 so the app does not become something people mute.
 */
export function sendAfter(at: Date, urgent: boolean): Date {
  if (urgent || !inQuietHours(at)) return at;
  // The release is 07:00 on the South African calendar day. Taking the UTC date put it on the
  // previous day between 00:00 and 02:00 SAST, a time already passed, so it went out at once.
  const sast = new Date(at.getTime() + SAST_OFFSET_HOURS * 3600000);
  const dayOffset = sastHour(at) >= QUIET_FROM_HOUR ? 1 : 0;
  return new Date(
    Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate() + dayOffset, QUIET_UNTIL_HOUR - SAST_OFFSET_HOURS),
  );
}

export const preferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        channel: z.enum(CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(CATEGORIES.length * CHANNELS.length),
});

/** Deadline notifications are the point of the feature, so they cannot be switched off. */
export const isMandatory = (category: Category) => category === 'deadline';
