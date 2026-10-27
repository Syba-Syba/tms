/** Money as a statement prints it: serif figures that line up, with a quiet R in front. */
export function Ledger({ cents, className = '' }: { cents: number; className?: string }) {
  const rands = (Math.abs(cents) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
  return (
    <span className={`font-display font-medium tabular-nums ${className}`}>
      {cents < 0 ? '-' : ''}
      <span className="mr-[0.2em] text-[0.8em] font-normal text-ink-muted">R</span>
      {rands}
    </span>
  );
}
