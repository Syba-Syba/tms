import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Button, Card, CardBody, Input, Modal, PageHeader, Select, useToast } from '@hlonie/toolbox/ui';
import { useTwoStep } from '../components/two-step';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SettingsNav } from '../components/settings-nav';
import { listingsUrl, useLandlord, type Bank } from '../lib/landlord';
import { PAGE } from '../lib/layout';

/** Universal branch codes: picking the bank fills the code, the field people most often get wrong. */
export const BANKS: { name: string; branchCode: string }[] = [
  { name: 'Absa', branchCode: '632005' },
  { name: 'African Bank', branchCode: '430000' },
  { name: 'Bidvest Bank', branchCode: '462005' },
  { name: 'Capitec', branchCode: '470010' },
  { name: 'Discovery Bank', branchCode: '679000' },
  { name: 'FNB', branchCode: '250655' },
  { name: 'Investec', branchCode: '580105' },
  { name: 'Nedbank', branchCode: '198765' },
  { name: 'Standard Bank', branchCode: '051001' },
  { name: 'TymeBank', branchCode: '678910' },
];

const blankBank: Bank = { name: '', holder: '', accountNumber: '', branchCode: '' };

export function SettingsAccount() {
  const { data, isLoading, isError, error, refetch } = useLandlord();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [details, setDetails] = useState({ tradingName: '', email: '', phone: '', registrationNo: '', vatNo: '' });
  const [bank, setBank] = useState<Bank>(blankBank);
  const [slug, setSlug] = useState('');
  // "Another bank" picked from the list: only then is the bank's name typed in.
  const [otherBank, setOtherBank] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const twoStep = useTwoStep();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!data) return;
    setDetails({
      tradingName: data.account.tradingName,
      email: data.account.email,
      phone: data.account.phone,
      registrationNo: data.account.registrationNo ?? '',
      vatNo: data.account.vatNo ?? '',
    });
    setBank(data.account.bank ?? blankBank);
    setOtherBank(Boolean(data.account.bank && !BANKS.some((entry) => entry.name === data.account.bank!.name)));
    setSlug(data.account.slug ?? '');
  }, [data]);

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your account" />;
  }
  const owner = data.me.role === 'owner';

  const save = async (what: string, body: unknown, message: string) => {
    setBusy(what);
    try {
      await api.put('/landlord', body);
      await queryClient.invalidateQueries({ queryKey: ['landlord'] });
      toast.show({ title: message, tone: 'success' });
      setAsking(false);
      setCode('');
    } catch (failure) {
      toast.show({ title: 'Not saved', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  // Replacing an account already on file needs a current two-step code: a stolen password
  // must not be enough to send the rent somewhere else.
  const onFile = data.account.bank;
  const replacing = Boolean(onFile) && (bank.accountNumber !== onFile?.accountNumber || bank.branchCode !== onFile?.branchCode);
  const twoStepOff = twoStep.data ? !twoStep.data.enabled : false;

  const bankReady =
    bank.name.trim().length >= 2 &&
    bank.holder.trim().length >= 2 &&
    /^[0-9]{6,16}$/.test(bank.accountNumber) &&
    /^[0-9]{6}$/.test(bank.branchCode);
  const link = data.account.slug ? listingsUrl(data.account.slug) : null;
  const knownBank = BANKS.some((entry) => entry.name === bank.name);

  return (
    <main className={PAGE.narrow}>
      <PageHeader title="Settings" description="Your business, where rent is paid, and how applicants find you." />
      <SettingsNav />

      {!owner ? (
        <Alert tone="info" title="Only the account owner changes these" className="mb-4">
          You can see them, so you can answer a tenant who asks where to pay.
        </Alert>
      ) : null}

      <section className="mb-6" aria-label="Business">
        <h2 className="label mb-2">Business</h2>
        <Card>
          <CardBody className="space-y-3">
            <Field label="Business name" htmlFor="acct-business-name">
              <Input
                id="acct-business-name"
                disabled={!owner}
                value={details.tradingName}
                onChange={(event) => setDetails({ ...details, tradingName: event.target.value })}
              />
            </Field>
            <Field label="Business email" htmlFor="acct-business-email">
              <Input
                id="acct-business-email"
                type="email"
                disabled={!owner}
                value={details.email}
                onChange={(event) => setDetails({ ...details, email: event.target.value })}
              />
            </Field>
            <Field label="Business phone" htmlFor="acct-business-phone">
              <Input
                id="acct-business-phone"
                type="tel"
                disabled={!owner}
                value={details.phone}
                onChange={(event) => setDetails({ ...details, phone: event.target.value })}
              />
            </Field>
            <Field label="Company registration number" htmlFor="acct-registration-number" hint="Optional.">
              <Input
                id="acct-registration-number"
                disabled={!owner}
                value={details.registrationNo}
                onChange={(event) => setDetails({ ...details, registrationNo: event.target.value })}
              />
            </Field>
            <Field label="VAT number" htmlFor="acct-vat-number" hint="Optional. Ten digits starting with 4. It prints on your invoices from Threshold so you can claim the VAT."
              error={details.vatNo && !/^4[0-9]{9}$/.test(details.vatNo) ? 'A VAT number is ten digits and starts with 4.' : undefined}>
              <Input
                id="acct-vat-number"
                inputMode="numeric"
                maxLength={10}
                disabled={!owner}
                value={details.vatNo}
                onChange={(event) => setDetails({ ...details, vatNo: event.target.value.replace(/\D/g, '') })}
              />
            </Field>
            <p className="text-xs text-ink-muted">These print on leases, invoices and letters.</p>
            {owner ? (
              <Button
                loading={busy === 'details'}
                disabled={busy !== null || details.tradingName.trim().length < 2 || (details.vatNo !== '' && !/^4[0-9]{9}$/.test(details.vatNo))}
                onClick={() =>
                  save(
                    'details',
                    { ...details, registrationNo: details.registrationNo.trim() || null, vatNo: details.vatNo || null },
                    'Business details saved',
                  )
                }
              >
                Save business details
              </Button>
            ) : null}
          </CardBody>
        </Card>
      </section>

      <section className="mb-6" aria-label="Bank account">
        <h2 className="label mb-2">Where tenants pay rent</h2>
        <Card>
          <CardBody className="space-y-3">
            {!data.account.bank ? (
              <p className="text-[13.5px] text-ink">
                {owner
                  ? "Add the account rent goes into. It prints on every invoice and shows on each tenant's rent screen."
                  : 'The owner has not added the bank account yet. Until they do, invoices ask tenants to use the account on their lease.'}
              </p>
            ) : null}
            {owner || data.account.bank ? (
              <>
                <Field label="Bank" htmlFor="acct-bank">
                  <Select
                    id="acct-bank"
                    disabled={!owner}
                    value={otherBank ? 'other' : knownBank ? bank.name : ''}
                    onChange={(event) => {
                      const picked = BANKS.find((entry) => entry.name === event.target.value);
                      setOtherBank(event.target.value === 'other');
                      setBank(
                        picked
                          ? { ...bank, name: picked.name, branchCode: picked.branchCode }
                          : { ...bank, name: '', branchCode: '' },
                      );
                    }}
                    options={[
                      { value: '', label: 'Choose the bank' },
                      ...BANKS.map((entry) => ({ value: entry.name, label: entry.name })),
                      { value: 'other', label: 'Another bank' },
                    ]}
                  />
                </Field>
                {otherBank ? (
                  <Field label="Bank name" htmlFor="acct-bank-name">
                    <Input
                      id="acct-bank-name"
                      disabled={!owner}
                      value={bank.name}
                      onChange={(event) => setBank({ ...bank, name: event.target.value })}
                    />
                  </Field>
                ) : null}
                <Field label="Account holder" htmlFor="acct-account-holder">
                  <Input
                    id="acct-account-holder"
                    disabled={!owner}
                    value={bank.holder}
                    onChange={(event) => setBank({ ...bank, holder: event.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Account number" htmlFor="acct-account-number">
                    <Input
                      id="acct-account-number"
                      inputMode="numeric"
                      disabled={!owner}
                      value={bank.accountNumber}
                      onChange={(event) => setBank({ ...bank, accountNumber: event.target.value.replace(/\D/g, '') })}
                    />
                  </Field>
                  <Field label="Branch code" htmlFor="acct-branch-code">
                    <Input
                      id="acct-branch-code"
                      inputMode="numeric"
                      maxLength={6}
                      disabled={!owner}
                      value={bank.branchCode}
                      onChange={(event) => setBank({ ...bank, branchCode: event.target.value.replace(/\D/g, '') })}
                    />
                  </Field>
                </div>
                {owner && replacing && twoStepOff ? (
                  <Alert tone="warning" title="Turn on two-step sign-in first">
                    Changing the account rent goes into needs a code from your phone.{' '}
                    <Link to="/settings/notifications" className="font-bold text-brand-500">Turn it on under You</Link>.
                  </Alert>
                ) : null}
                {owner ? (
                  <Button loading={busy === 'bank'} disabled={busy !== null || !bankReady || (replacing && twoStepOff)}
                    onClick={() => (replacing && twoStep.data ? setAsking(true) : save('bank', { bank }, 'Bank account saved'))}>
                    Save bank account
                  </Button>
                ) : null}
                {replacing ? (
                  <p className="text-xs text-ink-muted">Every tenant is emailed that the account changed, and so are you.</p>
                ) : null}
                <p className="text-xs text-ink-muted">
                  A change is recorded in Activity with the last four digits, old and new, so a swapped account is always traceable.
                </p>
              </>
            ) : null}
          </CardBody>
        </Card>
      </section>

      <section aria-label="Listings link">
        <h2 className="label mb-2">Your listings link</h2>
        <Card>
          <CardBody className="space-y-3">
            <p className="text-[13.5px] text-ink">
              Share it on a listing site, WhatsApp or your own website. It shows your vacant units with their photos, and nobody else's. Add photos and a description from each unit on Properties.
            </p>
            {link ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-surface-muted px-3 py-2 font-mono text-[13px]">
                  {link}
                </code>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      toast.show({ title: 'Link copied', tone: 'success' });
                    } catch {
                      toast.show({ title: 'Copy it from the box', tone: 'info' });
                    }
                  }}
                >
                  Copy
                </Button>
              </div>
            ) : null}
            {owner ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Change the end of the link" htmlFor="acct-link-name" className="min-w-0 flex-1">
                  <Input id="acct-link-name" value={slug}
                    onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
                </Field>
                <Button variant="outline" loading={busy === 'slug'}
                  disabled={busy !== null || slug === data.account.slug || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)}
                  onClick={() => save('slug', { slug }, 'Link changed. The old one no longer works.')}>
                  Change link
                </Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      </section>
      <Modal open={asking} onOpenChange={setAsking} title="Confirm the new bank account"
        description={`Rent will go to ${bank.name}, account ending ${bank.accountNumber.slice(-4)}. Enter the code from your authenticator app.`}>
        <div className="space-y-3">
          <Input aria-label="Code from the app" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456"
            value={code} onChange={(event) => setCode(event.target.value)} />
          <Button block loading={busy === 'bank'} disabled={code.trim().length < 6}
            onClick={() => save('bank', { bank, code: code.trim() }, 'Bank account changed. Your tenants have been told.')}>
            Change the account
          </Button>
        </div>
      </Modal>
    </main>
  );
}
