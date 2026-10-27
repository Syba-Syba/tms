/** Plain words for audit actions. An action not listed here still reads sensibly. */
const LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Password changed',
  'auth.register': 'Account created',
  'file.viewed': 'Opened a document',
  'application.submitted': 'Application submitted',
  'application.approved': 'Application approved',
  'application.declined': 'Application declined',
  'lease.generated': 'Lease generated',
  'lease.signed': 'Lease signed',
  'lease.activated': 'Lease started',
  'payment.recorded': 'Payment recorded',
  'property.created': 'Property added',
  'property.updated': 'Property changed',
  'property.deleted': 'Property removed',
  'unit.created': 'Unit added',
  'unit.updated': 'Unit changed',
  'unit.deleted': 'Unit removed',
  'inspection.incoming.created': 'Move-in inspection booked',
  'inspection.outgoing.created': 'Move-out inspection booked',
  'inspection.findings_saved': 'Inspection findings saved',
  'inspection.signed': 'Inspection report signed',
  'renewal.offered': 'Renewal offered',
  'renewal.accepted': 'Renewal accepted',
  'renewal.declined': 'Renewal declined',
  'termination.notice_served': 'Notice recorded',
  'termination.deduction_added': 'Deposit deduction added',
  'termination.settled': 'Deposit settled',
  'ticket.created': 'Problem reported',
  'ticket.closed': 'Ticket closed',
};

export function describeAction(action: string): string {
  if (LABELS[action]) return LABELS[action];
  const words = action.split('.').pop()!.replace(/_/g, ' ');
  return `${action.split('.')[0]!.replace(/_/g, ' ')}: ${words}`.replace(/^./, (c) => c.toUpperCase());
}
