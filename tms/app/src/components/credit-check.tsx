import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Input, SegmentedControl, Select, Textarea, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { formatDate } from '../lib/format';
import { putFile } from '../lib/photos';
import { useOpenDocument } from '../lib/open-document';
import { localToday } from '../lib/dates';

export interface CreditCheckState {
  consent: { acceptedAt: string } | null;
  check: {
    bureau: Bureau;
    checkedOn: string;
    score: number | null;
    outcome: Outcome;
    judgements: number;
    defaults: number;
    notes: string | null;
    reportKey: string | null;
    recordedAt: string;
  } | null;
}

type Bureau = 'transunion' | 'experian' | 'xds' | 'compuscan' | 'tpn' | 'other';
type Outcome = 'clear' | 'minor' | 'adverse';

export const BUREAU_LABEL: Record<Bureau, string> = {
  transunion: 'TransUnion',
  experian: 'Experian',
  xds: 'XDS',
  compuscan: 'Compuscan',
  tpn: 'TPN',
  other: 'Another bureau',
};

export const OUTCOME: Record<Outcome, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  clear: { label: 'Clear record', tone: 'success' },
  minor: { label: 'Minor issues', tone: 'warning' },
  adverse: { label: 'Adverse listings', tone: 'danger' },
};

export const useCreditCheck = (applicationId: string | undefined) =>
  useQuery({
    queryKey: ['credit-check', applicationId],
    queryFn: () => api.get<CreditCheckState>(`/applications/${applicationId}/credit-check`),
    enabled: Boolean(applicationId),
  });

/** The recorded result, as both the landlord and the applicant see it. */
export function CreditCheckSummary({ check }: { check: NonNullable<CreditCheckState['check']> }) {
  const open = useOpenDocument();
  return (
    <div className="space-y-1.5 rounded-sm border border-line-soft p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={OUTCOME[check.outcome].tone}>{OUTCOME[check.outcome].label}</Badge>
        {check.score !== null ? <span className="font-mono text-body tabular-nums">Score {check.score}</span> : null}
      </div>
      <p className="text-meta text-ink-muted">
        {BUREAU_LABEL[check.bureau]}, {formatDate(check.checkedOn)}. {check.judgements} judgement{check.judgements === 1 ? '' : 's'},{' '}
        {check.defaults} default{check.defaults === 1 ? '' : 's'}.
      </p>
      {check.notes ? <p className="whitespace-pre-line text-meta">{check.notes}</p> : null}
      {check.reportKey ? (
        <button type="button" className="text-meta font-bold text-brand-500" onClick={() => open(check.reportKey!)}>
          Open the report
        </button>
      ) : null}
    </div>
  );
}

const blank = { bureau: 'transunion' as Bureau, checkedOn: '', score: '', outcome: 'clear' as Outcome, judgements: '0', defaults: '0', notes: '' };

/**
 * The landlord's side. Threshold does not query a bureau: the landlord runs the check with their
 * own TransUnion, Experian, XDS or TPN account and records the result and the report here.
 */
export function CreditCheckPanel({ applicationId }: { applicationId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useCreditCheck(applicationId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(blank);
  const [report, setReport] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const check = data?.check;
    setForm(
      check
        ? {
            bureau: check.bureau, checkedOn: check.checkedOn, score: check.score === null ? '' : String(check.score),
            outcome: check.outcome, judgements: String(check.judgements), defaults: String(check.defaults), notes: check.notes ?? '',
          }
        : { ...blank, checkedOn: localToday() },
    );
  }, [data?.check, applicationId]);

  if (!data) return null;

  if (!data.consent) {
    return (
      <p className="text-meta text-ink-muted">
        The applicant has not agreed to a credit check. They can agree from their application; until then, decide on the
        documents, or ask them.
      </p>
    );
  }

  const score = form.score === '' ? null : Number(form.score);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(form.checkedOn) &&
    (score === null || (Number.isInteger(score) && score >= 0 && score <= 999)) &&
    Number(form.judgements) <= 99 && Number(form.defaults) <= 99;

  const save = async () => {
    setBusy(true);
    try {
      let reportKey: string | null = null;
      if (report) {
        const contentType = report.type === 'application/pdf' ? 'application/pdf' : report.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const presigned = await api.post<{ uploadUrl: string; key: string }>(`/applications/${applicationId}/documents/presign`, {
          kind: 'credit_report', contentType, sizeBytes: report.size,
        });
        await putFile(presigned.uploadUrl, report, contentType);
        await api.post(`/applications/${applicationId}/documents/confirm`, { key: presigned.key });
        reportKey = presigned.key;
      }
      await api.post(`/applications/${applicationId}/credit-check`, {
        bureau: form.bureau, checkedOn: form.checkedOn, score, outcome: form.outcome,
        judgements: Number(form.judgements), defaults: Number(form.defaults), notes: form.notes.trim() || null, reportKey,
      });
      await queryClient.invalidateQueries({ queryKey: ['credit-check', applicationId] });
      await queryClient.invalidateQueries({ queryKey: ['application-documents', applicationId] });
      setEditing(false);
      setReport(null);
      toast.show({ title: 'Credit check recorded', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (data.check && !editing) {
    return (
      <div className="space-y-2">
        <CreditCheckSummary check={data.check} />
        <button type="button" className="text-meta font-semibold text-ink-muted" onClick={() => setEditing(true)}>
          Correct the record
        </button>
      </div>
    );
  }

  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 3);
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        The applicant agreed on {formatDate(data.consent.acceptedAt.slice(0, 10))}. Run the check with your bureau, then record it here.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="credit-bureau" className="mb-1 block text-meta font-medium">Bureau</label>
          <Select id="credit-bureau" value={form.bureau} onChange={(event) => setForm({ ...form, bureau: event.target.value as Bureau })}
            options={Object.entries(BUREAU_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        <div>
          <label htmlFor="credit-date" className="mb-1 block text-meta font-medium">Checked on</label>
          <Input id="credit-date" type="date" max={localToday()} value={form.checkedOn}
            onChange={(event) => setForm({ ...form, checkedOn: event.target.value })} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-meta font-medium">Outcome</p>
        <SegmentedControl value={form.outcome} onChange={(outcome) => setForm({ ...form, outcome })}
          options={(Object.keys(OUTCOME) as Outcome[]).map((value) => ({ value, label: OUTCOME[value].label }))} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor="credit-score" className="mb-1 block text-meta font-medium">Score</label>
          <Input id="credit-score" inputMode="numeric" placeholder="Optional" value={form.score}
            onChange={(event) => setForm({ ...form, score: digits(event.target.value) })} />
        </div>
        <div>
          <label htmlFor="credit-judgements" className="mb-1 block text-meta font-medium">Judgements</label>
          <Input id="credit-judgements" inputMode="numeric" value={form.judgements}
            onChange={(event) => setForm({ ...form, judgements: digits(event.target.value).slice(0, 2) })} />
        </div>
        <div>
          <label htmlFor="credit-defaults" className="mb-1 block text-meta font-medium">Defaults</label>
          <Input id="credit-defaults" inputMode="numeric" value={form.defaults}
            onChange={(event) => setForm({ ...form, defaults: digits(event.target.value).slice(0, 2) })} />
        </div>
      </div>
      <div>
        <label htmlFor="credit-notes" className="mb-1 block text-meta font-medium">Notes</label>
        <Textarea id="credit-notes" rows={3} maxLength={1000} value={form.notes}
          onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" aria-label="Bureau report"
          onChange={(event) => setReport(event.target.files?.[0] ?? null)} />
        <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
          {report ? 'Change the report' : 'Attach the report'}
        </Button>
        <span className="min-w-0 truncate text-xs text-ink-muted">{report ? report.name : 'PDF from the bureau. Optional.'}</span>
      </div>
      <div className="flex gap-2">
        <Button loading={busy} disabled={!valid || busy} onClick={save}>Save the credit check</Button>
        {data.check ? <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
      </div>
    </div>
  );
}

/**
 * The applicant's side: agree to a check if they did not on the form, and see what the landlord
 * recorded. Seeing it is their right under POPIA section 23, and lets them dispute an error.
 */
export function CreditCheckApplicant({ applicationId, privacyVersion }: { applicationId: string; privacyVersion: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useCreditCheck(applicationId);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const agree = async () => {
    setBusy(true);
    try {
      await api.post(`/applications/${applicationId}/credit-check`, { consent: true, version: privacyVersion });
      await queryClient.invalidateQueries({ queryKey: ['credit-check', applicationId] });
      toast.show({ title: 'Agreed', description: 'The landlord can now check your credit record.', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (data.check) return <CreditCheckSummary check={data.check} />;
  if (data.consent) {
    return <p className="text-meta text-ink-muted">You agreed to a credit check. The result shows here once the landlord records it.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-meta text-ink">
        Many landlords check your record with a credit bureau before they decide. It is up to you. If you agree, the
        result and the report are kept with your application, and you can see them here.
      </p>
      <Button size="sm" variant="outline" loading={busy} onClick={agree}>Agree to a credit check</Button>
    </div>
  );
}
