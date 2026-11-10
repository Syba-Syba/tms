import { Button, Spinner } from '@hlonie/toolbox/ui';
import { humanError } from '../api/client';

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;

/**
 * What a screen shows while its query has no data. Every detail screen used to render a
 * spinner for `!data`, which on a 403, a 404 or a dropped connection spun forever; list
 * screens showed "nothing here" for the same failures, which reads as a fact about the
 * tenancy rather than about the network.
 */
export function QueryState({
  isLoading,
  isError,
  error,
  onRetry,
  what = 'This page',
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry?: () => void;
  what?: string;
}) {
  if (isLoading) {
    return (
      <main className="flex min-h-[40vh] items-center justify-center p-16" aria-busy="true">
        <Spinner />
      </main>
    );
  }
  if (isError) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-16">
        <QueryError error={error} onRetry={onRetry} what={what} />
      </main>
    );
  }
  return null;
}

/** The same message inline, for a list that failed to load under a header that is fine. */
export function QueryError({
  error,
  onRetry,
  what = 'This list',
}: {
  error: unknown;
  onRetry?: () => void;
  what?: string;
}) {
  const status = statusOf(error);
  const title =
    status === 404
      ? 'Not found'
      : status === 403
        ? 'Not yours to see'
        : `${what} could not be loaded`;
  const detail =
    status === 404
      ? 'It may have been removed, or the link is wrong.'
      : status === 403
        ? 'Your sign-in is not a party to this record.'
        : humanError(error);
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface px-5 py-5 shadow-sm">
      <p className="text-lead font-bold text-ink">{title}</p>
      <p className="text-body text-ink-muted">{detail}</p>
      {onRetry && status !== 404 && status !== 403 ? (
        <Button size="sm" variant="secondary" className="!mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
