/** Big tight figures with a small raised R, the way the design treats money. */
export function Ledger({ cents, className = '' }: { cents: number; className?: string }) {
  const rands = (cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      <sup className="mr-0.5 text-[0.5em] font-bold opacity-75">R</sup>
      {rands}
    </span>
  );
}
