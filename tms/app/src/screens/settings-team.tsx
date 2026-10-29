import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, ConfirmDialog, Input, Modal, PageHeader, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SettingsNav } from '../components/settings-nav';
import { useLandlord } from '../lib/landlord';
import { formatDate } from '../lib/format';
import { PAGE } from '../lib/layout';

interface Team {
  members: { sub: string; role: 'owner' | 'agent'; name: string; email: string; since: string; isYou: boolean }[];
  invites: { id: string; name: string; email: string; expiresAt: string; sentAt: string }[];
}

/**
 * Who works on the account. Agents run the day to day: leases, rent, maintenance, applications.
 * The owner keeps the account, the bank details and the team to themselves.
 */
export function SettingsTeam() {
  const landlord = useLandlord();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['landlord-team'],
    queryFn: () => api.get<Team>('/landlord/team'),
  });
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '' });
  const [removing, setRemoving] = useState<Team['members'][number] | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data || !landlord.data) {
    return <QueryState isLoading={isLoading || landlord.isLoading} isError={isError || landlord.isError}
      error={error ?? landlord.error} onRetry={refetch} what="Your team" />;
  }
  const owner = landlord.data.me.role === 'owner';

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['landlord-team'] });
      await queryClient.invalidateQueries({ queryKey: ['landlord'] });
      toast.show({ title: message, tone: 'success' });
      return true;
    } catch (failure) {
      toast.show({ title: 'That did not work', description: humanError(failure), tone: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={PAGE.narrow}>
      <PageHeader title="Settings" description="The people who work on your rentals." />
      <SettingsNav />

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="label">Team</h2>
        {owner ? (
          <Button size="sm" onClick={() => { setInvite({ name: '', email: '' }); setInviting(true); }}>
            Add someone
          </Button>
        ) : null}
      </div>

      <Card className="mb-6">
        <CardBody className="space-y-1">
          {data.members.map((member) => (
            <div key={member.sub} className="flex items-center justify-between gap-3 border-b border-line-soft py-2 last:border-0">
              <div className="min-w-0">
                <p className="truncate text-body font-semibold">
                  {member.name}{member.isYou ? <span className="font-normal text-ink-muted"> (you)</span> : null}
                </p>
                <p className="truncate text-xs text-ink-muted">{member.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Badge tone={member.role === 'owner' ? 'success' : 'neutral'}>
                  {member.role === 'owner' ? 'Owner' : 'Agent'}
                </Badge>
                {owner && member.role === 'agent' ? (
                  <button type="button" className="text-meta font-bold text-danger disabled:opacity-40"
                    disabled={busy} onClick={() => setRemoving(member)}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {data.invites.length > 0 ? (
        <section className="mb-6" aria-label="Waiting to join">
          <h2 className="label mb-2">Waiting to join</h2>
          <Card>
            <CardBody className="space-y-1">
              {data.invites.map((pending) => (
                <div key={pending.id} className="flex items-center justify-between gap-3 border-b border-line-soft py-2 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-body font-semibold">{pending.name}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {pending.email}, link works until {formatDate(pending.expiresAt.slice(0, 10))}
                    </p>
                  </div>
                  {owner ? (
                    <span className="flex shrink-0 gap-3">
                      <button type="button" className="text-meta font-bold text-brand-500 disabled:opacity-40" disabled={busy}
                        onClick={() => act(() => api.post('/landlord/invites', { name: pending.name, email: pending.email }), 'Sent again')}>
                        Resend
                      </button>
                      <button type="button" className="text-meta font-bold text-danger disabled:opacity-40" disabled={busy}
                        onClick={() => act(() => api.post(`/landlord/invites/${pending.id}/revoke`, {}), 'Invitation cancelled')}>
                        Cancel
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
            </CardBody>
          </Card>
        </section>
      ) : null}

      <div className="rounded-md border border-line p-4 text-meta text-ink-muted">
        <p className="mb-1 font-semibold text-ink">What an agent can do</p>
        <p>
          Everything on the leases, rent, maintenance, inspections and applications. Their actions show under their own
          name in Activity. They cannot change the business details, the bank account or the team, delete a property, or
          answer a privacy request.
        </p>
      </div>

      <Modal open={inviting} onOpenChange={setInviting} title="Add someone to your team"
        description="They get an email with a link to choose a password. It works for 7 days.">
        <div className="space-y-3">
          <Input aria-label="Their name" placeholder="Their name" value={invite.name}
            onChange={(event) => setInvite({ ...invite, name: event.target.value })} />
          <Input aria-label="Their email" type="email" placeholder="Their email" value={invite.email}
            onChange={(event) => setInvite({ ...invite, email: event.target.value })} />
          <p className="text-xs text-ink-muted">Use an address they do not already sign in with here.</p>
          <Button block loading={busy} disabled={invite.name.trim().length < 2 || !invite.email.includes('@')}
            onClick={async () => {
              if (await act(() => api.post('/landlord/invites', invite), `Invitation sent to ${invite.email}`)) setInviting(false);
            }}>
            Send invitation
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They are signed out straight away and can no longer see any of your rentals. What they did stays in Activity."
        confirmLabel="Remove"
        loading={busy}
        onConfirm={async () => {
          if (removing && (await act(() => api.post(`/landlord/members/${encodeURIComponent(removing.sub)}/remove`, {}), `${removing.name} removed`))) {
            setRemoving(null);
          }
        }}
      />
    </main>
  );
}
