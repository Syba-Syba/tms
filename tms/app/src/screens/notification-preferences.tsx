import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, CardBody, PageHeader, Spinner, Switch, useToast } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { ChangePassword } from '../components/change-password';
import { PrivacyRequests } from '../components/privacy-requests';
import { YourData } from '../components/your-data';
import { isLandlord } from '../lib/session';

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

export function NotificationPreferences() {
  const toast = useToast();
  const [rows, setRows] = useState<Preference[]>([]);
  const { data, isLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<{ preferences: Preference[] }>('/notifications/preferences'),
  });

  useEffect(() => {
    if (data) setRows(data.preferences);
  }, [data]);

  const categories = [...new Set(rows.map((row) => row.category))];

  const toggle = (category: string, channel: string, enabled: boolean) =>
    setRows((current) =>
      current.map((row) =>
        row.category === category && row.channel === channel ? { ...row, enabled } : row,
      ),
    );

  const save = async () => {
    await api.put('/notifications/preferences', {
      preferences: rows
        .filter((row) => !row.locked)
        .map(({ category, channel, enabled }) => ({ category, channel, enabled })),
    });
    toast.show({ title: 'Saved', tone: 'success' });
  };

  if (isLoading) return <main className="p-16 text-center"><Spinner /></main>;

  return (
    <main className="mx-auto max-w-2xl px-5 py-6">
      <PageHeader title="Settings" description="Your password, what reaches you, and your data." />

      <div className="mb-6">
        <ChangePassword />
      </div>

      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Notifications</h2>

      <div className="space-y-3">
        {categories.map((category) => {
          const channels = rows.filter((row) => row.category === category);
          const locked = channels.some((row) => row.locked);
          return (
            <Card key={category}>
              <CardBody className="space-y-3">
                <div>
                  <p className="text-[15px] font-semibold capitalize">{category}</p>
                  <p className="text-xs text-ink-muted">{CATEGORY_COPY[category]}</p>
                </div>
                {locked ? (
                  <p className="text-xs font-semibold text-brand-500">
                    Always on. These are the ones that cost money at a tribunal.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-5">
                    {channels.map((row) => (
                      <label key={row.channel} className="flex items-center gap-2 text-[13.5px]">
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(next: boolean) => toggle(row.category, row.channel, next)}
                        />
                        <span className="capitalize">{row.channel}</span>
                      </label>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>

      {import.meta.env.DEV ? (
        <Alert tone="info" title="Email is switched off in development" className="mt-4">
          The dispatcher writes what it would have sent to the log instead of sending it, so you
          can develop without a verified sending domain.
        </Alert>
      ) : null}

      <Button className="mt-4" onClick={save}>
        Save preferences
      </Button>

      <div className="mt-8 space-y-8">
        {isLandlord() ? <PrivacyRequests /> : null}
        <YourData />
      </div>
    </main>
  );
}
