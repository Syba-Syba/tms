/**
 * Every standalone money figure in the app, set like a bank statement: serif figures that line
 * up, with a quiet R in front. Money inside a sentence stays plain text ("You owe R 1 200,00").
 * `whole` drops ",00" on whole rands for headline figures; anything with cents stays exact.
 */
export function Money({ cents, whole = false, className = '' }: { cents: number; whole?: boolean; className?: string }) {
  const showCents = !whole || cents % 100 !== 0;
  const rands = (Math.abs(cents) / 100).toLocaleString('en-ZA', {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
  return (
    <span className={`font-display font-medium tabular-nums ${className}`}>
      {cents < 0 ? '-' : ''}
      <span className="mr-[0.2em] text-[0.8em] font-normal text-ink-muted">R</span>
      {rands}
    </span>
  );
}
