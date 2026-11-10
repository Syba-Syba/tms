/**
 * Every standalone money figure in the app: bold figures with the R in front, in the colour
 * of whatever it sits in. Money inside a sentence stays plain text ("You owe R 1 200,00").
 * `whole` drops ",00" on whole rands for headline figures; anything with cents stays exact.
 */
export function Money({ cents, whole = false, className = '' }: { cents: number; whole?: boolean; className?: string }) {
  const showCents = !whole || cents % 100 !== 0;
  const rands = (Math.abs(cents) / 100).toLocaleString('en-ZA', {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
  return (
    <span className={`whitespace-nowrap font-bold ${className}`}>
      {cents < 0 ? '-' : ''}
      <span className="mr-[0.18em]">R</span>
      {rands}
    </span>
  );
}
