import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardBody } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api } from '../api/client';
import { formatDate } from '../lib/format';
import { TERMS_VERSION } from '../lib/terms';
import { List, Section } from './privacy';

interface Company {
  name: string;
  legalName: string;
  registrationNo: string | null;
  vatNo: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The terms landlords agree to when they open an account. Public, so they can be read first.
 * The operator's details come from the server's settings, so the same build serves any company.
 * Written plainly on purpose; the Consumer Protection Act asks for that too (section 22).
 */
export function Terms() {
  const { data } = useQuery({ queryKey: ['company'], queryFn: () => api.get<Company>('/company'), retry: false });
  const name = data?.name ?? 'Threshold';
  const legal = data?.legalName ?? name;
  const contact = [data?.email, data?.phone].filter(Boolean).join(', ');

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-1 font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">Terms of service</h1>
      <p className="mb-6 text-[13px] text-ink-muted">Version of {formatDate(TERMS_VERSION)}</p>

      <Card>
        <CardBody className="space-y-5 text-[14.5px] leading-relaxed text-ink">
          <Section title="Who we are">
            <p>
              {name} is provided by {legal}
              {data?.registrationNo ? `, registration number ${data.registrationNo}` : ''}
              {data?.vatNo ? `, VAT number ${data.vatNo}` : ''}
              {data?.address ? `, of ${data.address}` : ''}. {contact ? `You can reach us at ${contact}.` : ''}
            </p>
            <p>
              These terms apply between us and the landlord who opens an account, called "you" below. Your agents work
              under them on your behalf. Tenants use the service through your account and do not sign these terms; the{' '}
              <Link to="/privacy" className="font-bold text-brand-500">privacy notice</Link> tells them how their
              information is handled.
            </p>
          </Section>

          <Section title="What the service does">
            <p>
              Software to run rentals: applications, leases and signing, rent invoices and payments, deposits and their
              interest, inspections, maintenance, notices, arrears reminders and letters of demand, and reports. It is a
              tool. It does not give legal, tax or financial advice, and it does not collect or hold rent: tenants pay you
              directly. You decide what to send, when, and to whom, and you remain responsible for complying with the Rental
              Housing Act, the Consumer Protection Act and your leases. The templates and deadlines it works out follow
              those laws as we understand them, but check anything that matters with an attorney.
            </p>
          </Section>

          <Section title="Your account">
            <List
              items={[
                'Give true details for your business and bank account. Invoices and letters print them.',
                'Keep sign-ins to yourself. Each person on your team has their own; you are responsible for what they do in your account, and you remove anyone who should no longer have access.',
                'Turn on two-step sign-in. It is required to change the bank account rent is paid into.',
                'Tell us straight away if you think someone else has got into your account.',
              ]}
            />
          </Section>

          <Section title="Plans, trial and payment">
            <List
              items={[
                'Every account starts with a 30-day free trial. No card is needed for it.',
                `After that you pay monthly, in advance, by card or instant EFT through PayFast. Plans are priced by how many units you run; the current prices are on the Plan screen${data?.vatNo ? ' and include VAT' : ''}.`,
                'Each payment gets an invoice you can download from the Plan screen.',
                'We give you at least 30 days’ notice by email before a price changes. If you do not agree, cancel before it takes effect.',
                'You can cancel at any time on the Plan screen. You keep the service until the end of the month you have paid for; we do not refund part months.',
                `If a payment fails we tell you, and your account keeps working for 7 more days. After that it becomes read-only for you and your team until a plan is paid: nothing is deleted, and your tenants can still see their lease, pay, send proof of payment and report repairs.`,
              ]}
            />
            <p>Example: on a {formatZar(449)} plan, cancelling halfway through a month means no further payment, and the account works until that month ends.</p>
          </Section>

          <Section title="Your data, and POPIA">
            <p>
              For your tenants' and applicants' personal information, you are the responsible party under the Protection of
              Personal Information Act and we are your operator (sections 20 and 21). That means:
            </p>
            <List
              items={[
                'We process it only to provide the service to you, on your instructions, and never sell it or use it for anything else.',
                'We keep it confidential and secure: encrypted connections, ID numbers and two-step secrets encrypted at rest, access limited to your team, and nightly backups kept off the server.',
                'We tell you without delay if we believe it has been accessed without authority, so that you can notify the Information Regulator and the people affected (section 22).',
                'We use other providers to run the service: hosting, email delivery, PayFast for your subscription, and Meta for WhatsApp messages where switched on. Each processes only what it needs for that task.',
                'You can download your data, and a tenant can download theirs, at any time. If you close your account we keep your records for 90 days so you can take them, then delete them, except what the law requires to be kept longer.',
              ]}
            />
            <p>You must have a lawful reason for the information you put into the service, and give your tenants the privacy notice, which the app shows them.</p>
          </Section>

          <Section title="Using the service fairly">
            <List
              items={[
                'Use it only for lawful letting of property you own or manage with the owner’s authority.',
                'Do not try to reach other landlords’ data, test our security without written permission, or overload the service.',
                'We may suspend an account that does any of this, or that sends notices meant to mislead or harass tenants, after telling you why where the law allows.',
              ]}
            />
          </Section>

          <Section title="Availability">
            <p>
              We work to keep the service available and your data safe, and back it up every night. It may still be
              unavailable at times, for maintenance or for reasons outside our control. Keep your own copies of anything you
              cannot do without; the reports and exports exist for that.
            </p>
          </Section>

          <Section title="Liability">
            <p>
              Nothing here limits rights you have under the Consumer Protection Act that cannot be limited. Beyond those, we
              are not liable for indirect or consequential loss, such as lost rent or profit, and our total liability to you
              in any 12 months is limited to what you paid us in that period. We are liable for loss caused by our gross
              negligence or wilful misconduct.
            </p>
          </Section>

          <Section title="Changes, ending and law">
            <List
              items={[
                'If we change these terms in a way that matters, we tell you by email and in the app at least 30 days ahead, and ask you to agree again. If you do not, you may cancel.',
                'You may close your account at any time. We may end the service with 60 days’ notice, and at once if you seriously breach these terms.',
                'South African law applies, and South African courts have jurisdiction.',
                'Notices to us go to the email address above; notices to you go to your account’s email address.',
              ]}
            />
          </Section>
        </CardBody>
      </Card>
    </main>
  );
}
