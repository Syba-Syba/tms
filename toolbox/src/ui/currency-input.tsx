import { forwardRef, useEffect, useState } from 'react';
import { cn } from '../lib/cn';

/**
 * Reads an amount the way a South African types it. Both "8 500,50" and "8,500.50" are
 * common, and the old parser turned every comma into a decimal point, so '8,500' was
 * recorded as R8,50: the rent on a unit, the deposit, a deduction, a payment.
 *
 * - With both separators present, the last one is the decimal point.
 * - A lone comma followed by one or two digits at the end is a decimal comma.
 * - Any other comma groups thousands. Several points ('1.234.567') group thousands too.
 */
export function parseCurrencyInput(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const negative = cleaned.trim().startsWith('-');
  const digits = cleaned.replace(/-/g, '');
  const lastComma = digits.lastIndexOf(',');
  const lastPoint = digits.lastIndexOf('.');

  let integer: string;
  let fraction: string;
  const splitAt = (index: number) => {
    integer = digits.slice(0, index).replace(/[.,]/g, '');
    fraction = digits.slice(index + 1).replace(/[.,]/g, '');
  };

  if (lastComma >= 0 && lastPoint >= 0) {
    splitAt(Math.max(lastComma, lastPoint));
  } else if (lastPoint >= 0) {
    if ((digits.match(/\./g) ?? []).length === 1) splitAt(lastPoint);
    else [integer, fraction] = [digits.replace(/\./g, ''), ''];
  } else if (lastComma >= 0) {
    const after = digits.length - lastComma - 1;
    const commas = (digits.match(/,/g) ?? []).length;
    if (commas === 1 && after >= 1 && after <= 2) splitAt(lastComma);
    else [integer, fraction] = [digits.replace(/,/g, ''), ''];
  } else {
    [integer, fraction] = [digits, ''];
  }

  const whole = Number(integer! || '0');
  const cents = Math.round(Number(`0.${fraction! || '0'}`) * 100);
  const total = whole * 100 + cents;
  if (!Number.isFinite(total)) return null;
  return negative ? -total : total;
}

const display = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

/** Stores cents as an integer so floating point never invents half a cent on an invoice. */
export const CurrencyInput = forwardRef<
  HTMLInputElement,
  {
    cents: number | null;
    onCentsChange: (cents: number | null) => void;
    currency?: string;
    invalid?: boolean;
    className?: string;
  } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>
>(function CurrencyInput({ cents, onCentsChange, currency = 'R', invalid, className, ...props }, ref) {
  const [text, setText] = useState(display(cents));

  // Controlled from the outside: a reset to 0, or a drawer reopened for a different unit,
  // used to leave the previous figure in the box because the input only read its default once.
  useEffect(() => {
    setText(display(cents));
  }, [cents]);

  return (
    <div
      className={cn(
        'flex h-10 items-center rounded-sm border border-line bg-surface focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500',
        invalid && 'border-danger',
        className,
      )}
    >
      <span className="border-r border-line px-3 text-body text-ink-muted">{currency}</span>
      <input
        ref={ref}
        inputMode="decimal"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = parseCurrencyInput(text);
          setText(display(parsed));
          onCentsChange(parsed);
        }}
        aria-invalid={invalid || undefined}
        className="w-full bg-transparent px-3 text-right text-body tabular-nums text-ink outline-none"
        placeholder="0.00"
        {...props}
      />
    </div>
  );
});
