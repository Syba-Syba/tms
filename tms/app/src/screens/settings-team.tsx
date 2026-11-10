import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Badge, Button, Card, ConfirmDialog, Input, Modal, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SettingsLayout } from '../components/settings-nav';
import { useLandlord } from '../lib/landlord';
import { formatInstant } from '../lib/format';

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
    <SettingsLayout description="The people who work on your rentals.">
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          <section aria-label="Team">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <h2 className="text-lead font-bold text-ink">Team</h2>
                  <p className="text-meta text-ink-muted">
                    {data.members.length === 1 ? 'Just you so far.' : `${data.members.length} people can sign in.`}
                  </p>
                </div>
                {owner ? (
                  <Button onClick={() => { setInvite({ name: '', email: '' }); setInviting(true); }}>
                    Add someone
                  </Button>
                ) : null}
              </div>
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {data.members.map((member) => (
                  <li key={member.sub} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                    <Avatar name={member.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-semibold text-ink">
                        {member.name}{member.isYou ? <span className="font-normal text-ink-muted"> (you)</span> : null}
                      </p>
                      <p className="truncate text-meta text-ink-muted">{member.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge tone={member.role === 'owner' ? 'brand' : 'neutral'}>
                        {member.role === 'owner' ? 'Owner' : 'Agent'}
                      </Badge>
                      {owner && member.role === 'agent' ? (
                        <Button size="sm" variant="outline" className="text-danger" disabled={busy} onClick={() => setRemoving(member)}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          {data.invites.length > 0 ? (
            <section aria-label="Waiting to join">
              <Card>
                <div className="px-5 py-4">
                  <h2 className="text-lead font-bold text-ink">Waiting to join</h2>
                  <p className="text-meta text-ink-muted">Invited, but they have not chosen a password yet.</p>
                </div>
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {data.invites.map((pending) => (
                    <li key={pending.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                      <Avatar name={pending.name} tone="info" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-body font-semibold text-ink">
                          <span className="truncate">{pending.name}</span>
                          <Badge tone="info">Invited</Badge>
                        </p>
                        <p className="text-meta text-ink-muted">
                          {pending.email}, link works until {formatInstant(pending.expiresAt)}
                        </p>
                      </div>
                      {owner ? (
                        <span className="flex shrink-0 gap-2">
                          <Button size="sm" variant="secondary" disabled={busy}
                            onClick={() => act(() => api.post('/landlord/invites', { name: pending.name, email: pending.email }), 'Sent again')}>
                            Resend
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy}
                            onClick={() => act(() => api.post(`/landlord/invites/${pending.id}/revoke`, {}), 'Invitation cancelled')}>
                            Cancel
                          </Button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}
        </div>

        <aside className="space-y-5">
          <div className="rounded-md border border-[color-mix(in_srgb,var(--tb-info)_25%,transparent)] bg-tint-info px-5 py-4">
            <h2 className="text-lead font-bold text-ink">What an agent can do</h2>
            <p className="mt-1.5 text-meta text-ink">
              Everything on the leases, rent, maintenance, inspections and applications. Their actions show under their own
              name in Activity. They cannot change the business details, the bank account or the team, delete a property, or
              answer a privacy request.
            </p>
          </div>
          {!owner ? <p className="text-meta text-ink-muted">Only the account owner adds or removes people.</p> : null}
        </aside>
      </div>

      <Modal open={inviting} onOpenChange={setInviting} title="Add someone to your team"
        description="They get an email with a link to choose a password. It works for 7 days.">
        <div className="space-y-4">
          <Field label="Their name" htmlFor="invite-name">
            <Input id="invite-name" placeholder="Name and surname" value={invite.name}
              onChange={(event) => setInvite({ ...invite, name: event.target.value })} />
          </Field>
          <Field label="Their email" htmlFor="invite-email" hint="Use an address they do not already sign in with here.">
            <Input id="invite-email" type="email" placeholder="name@example.co.za" value={invite.email}
              onChange={(event) => setInvite({ ...invite, email: event.target.value })} />
          </Field>
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
    </SettingsLayout>
  );
}
