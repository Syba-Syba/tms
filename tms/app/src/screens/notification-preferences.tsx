import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Switch, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { ChangePassword } from '../components/change-password';
import { SettingsCard, SettingsLayout } from '../components/settings-nav';
import { TwoStep } from '../components/two-step';
import { PrivacyRequests } from '../components/privacy-requests';
import { YourData } from '../components/your-data';
import { isLandlord } from '../lib/session';
import { QueryState } from '../components/query-state';
import { Appearance } from '../components/appearance';

interface Preference {
  category: string;
  channel: string;
  enabled: boolean;
  locked: boolean;
}

const CATEGORY_COPY: Record<string, string> = {
  money: 'Invoices, receipts and arrears',
  maintenance: 'Tickets, contractors and completed work',
  inspection: 'Booked inspections and reminders',
  lease: 'Signing, notice and renewal',
  deadline: 'Statutory dates and response targets',
};

/** Email is the only channel with a sender behind it. WhatsApp and push are modelled in the
    database but nothing delivers them, so a toggle for either promised something that never
    arrived. */
const DELIVERABLE = new Set(['email']);

export function NotificationPreferences() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Preference[]>([]);
  const [saving, setSaving] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<{ preferences: Preference[] }>('/notifications/preferences'),
  });

  useEffect(() => {
    if (data) setRows(data.preferences.filter((row) => DELIVERABLE.has(row.channel)));
  }, [data]);

  const categories = [...new Set(rows.map((row) => row.category))];

  const toggle = (category: string, channel: string, enabled: boolean) =>
    setRows((current) =>
      current.map((row) =>
        row.category === category && row.channel === channel ? { ...row, enabled } : row,
      ),
    );

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/notifications/preferences', {
        preferences: rows
          .filter((row) => !row.locked)
          .map(({ category, channel, enabled }) => ({ category, channel, enabled })),
      });
      // Otherwise the cached copy still holds the old values, and leaving and returning
      // to Settings showed them as if the save had not happened.
      await queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      toast.show({ title: 'Saved', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Settings" />;
  }

  const landlord = isLandlord();

  return (
    <SettingsLayout description="Your password, what reaches you, and your data.">
      <div className={`grid grid-cols-1 items-start gap-5 ${landlord ? 'xl:grid-cols-2' : 'lg:grid-cols-2'}`}>
        <div className="min-w-0 space-y-5">
          <SettingsCard title="Notifications" description="Sent by email to the address on your account.">
            <ul className="-mx-5 divide-y divide-line-soft border-y border-line-soft">
              {categories.map((category) => {
                const channels = rows.filter((row) => row.category === category);
                const locked = channels.some((row) => row.locked);
                return (
                  <li key={category} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="text-body font-semibold capitalize text-ink">{category}</p>
                      <p className="text-meta text-ink-muted">{CATEGORY_COPY[category]}</p>
                      {locked ? (
                        <p className="mt-0.5 text-meta text-ink-muted">
                          You cannot switch these off: they are the ones that cost money at a tribunal.
                        </p>
                      ) : null}
                    </div>
                    {locked ? (
                      <Badge tone="brand">Always on</Badge>
                    ) : (
                      <div className="flex shrink-0 flex-wrap justify-end gap-4">
                        {channels.map((row) => (
                          <label key={row.channel} className="flex items-center gap-2 text-meta text-ink">
                            <span className="capitalize">{row.channel}</span>
                            <Switch
                              label={`${category} by ${row.channel}`}
                              checked={row.enabled}
                              onCheckedChange={(next: boolean) => toggle(row.category, row.channel, next)}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {import.meta.env.DEV ? (
              <Alert tone="info" title="Email is switched off in development">
                The dispatcher writes what it would have sent to the log instead of sending it, so you
                can develop without a verified sending domain.
              </Alert>
            ) : null}
            <Button loading={saving} onClick={save}>
              Save preferences
            </Button>
          </SettingsCard>
          <Appearance />
        </div>

        <div className="min-w-0 space-y-5">
          <ChangePassword />
          <TwoStep />
          {landlord ? <PrivacyRequests /> : null}
          <YourData />
        </div>
      </div>
    </SettingsLayout>
  );
}
