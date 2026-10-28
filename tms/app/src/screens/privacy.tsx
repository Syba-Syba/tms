import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Card, CardBody } from '@hlonie/toolbox/ui';
import { formatDate } from '../lib/format';
import { PRIVACY_VERSION } from '../lib/privacy';

/**
 * The privacy notice POPIA section 18 requires before personal information is collected. Public,
 * so it can be read before signing up. Plain language on purpose: a notice nobody can read
 * informs nobody.
 */
export function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-1 font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">Privacy notice</h1>
      <p className="mb-6 text-[13px] text-ink-muted">Version of {formatDate(PRIVACY_VERSION)}</p>

      <Card>
        <CardBody className="space-y-5 text-[14.5px] leading-relaxed text-ink">
          <Section title="Who is responsible for your information">
            Your landlord is the responsible party under the Protection of Personal Information Act
            (POPIA). They decide what happens to your information. This app is the system they use
            to manage rentals, and it processes your information only on their instructions. Your
            landlord's contact details are on your lease and in your emails from this app.
          </Section>

          <Section title="What we collect">
            <List
              items={[
                'Your name, email address and mobile number.',
                'Your ID number. It is encrypted when you submit it, and only its last four digits are ever shown.',
                'Your employment, employer and income, and the documents you upload with an application: ID copy, payslips, bank statements and proof of address.',
                'Your lease, rent invoices, payments, proofs of payment and deposit.',
                'Maintenance requests, inspection notes and photos of the unit.',
                'Records of what you agreed to, when you signed, and the device you used.',
              ]}
            />
          </Section>

          <Section title="Why, and on what basis">
            <List
              items={[
                'To decide your application. You agree to this when you apply.',
                'To run your lease: rent, deposit, maintenance, inspections and notices. This is needed to perform the lease.',
                'To meet legal duties, such as keeping tax records and paying interest on your deposit under the Rental Housing Act.',
                'To send you messages about your rent, maintenance and lease. You choose the channels in Settings, except for statutory deadlines.',
              ]}
            />
            We do not sell your information or use it for marketing. We do not run credit checks.
          </Section>

          <Section title="Who sees it">
            Your landlord. A contractor your landlord books for a repair may be given your unit and
            contact number to arrange access. Email and file storage providers hold it on our
            behalf under contract. Nobody else, unless the law requires it.
          </Section>

          <Section title="How long we keep it">
            <List
              items={[
                'Lease records, rent and deposit records: five years after the lease ends. Tax law requires this, and they settle disputes at the Rental Housing Tribunal.',
                'Documents from an application that was declined or withdrawn: twelve months after the decision, then deleted automatically.',
                'If you never applied for anything, your account goes as soon as you ask.',
              ]}
            />
          </Section>

          <Section title="How we protect it">
            Your ID number is encrypted. Documents are stored encrypted and open only through links
            that expire after five minutes, to people involved in your lease. Every change to your
            records is logged.
          </Section>

          <Section title="Your rights">
            <List
              items={[
                'See what is held about you: Settings, then Your data, then Download my data.',
                'Have it corrected: ask your landlord, or change it when you next apply.',
                'Have it erased: Settings, then Your data. Records the law requires us to keep are kept until that time runs out, and you are told when.',
                'Object to how it is used, by writing to your landlord.',
              ]}
            />
            If you are unhappy with the answer, you can complain to the Information Regulator at{' '}
            <a href="https://inforegulator.org.za" className="font-semibold text-brand-500 underline" target="_blank" rel="noreferrer">
              inforegulator.org.za
            </a>
            .
          </Section>
        </CardBody>
      </Card>

      <p className="mt-6 text-center text-[13px] text-ink-muted">
        <Link to="/" className="font-bold text-brand-500">Back to the app</Link>
      </p>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-[16px] font-bold">{title}</h2>
      <div className="space-y-2 text-ink-muted">{children}</div>
    </section>
  );
}

export function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
