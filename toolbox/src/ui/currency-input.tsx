import { forwardRef } from 'react';
import { cn } from '../lib/cn';

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
  const display = cents === null ? '' : (cents / 100).toFixed(2);
  return (
    <div
      className={cn(
        'flex h-10 items-center rounded-sm border border-line bg-surface focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500',
        invalid && 'border-danger',
        className,
      )}
    >
      <span className="border-r border-line px-3 text-[14px] text-ink-muted">{currency}</span>
      <input
        ref={ref}
        inputMode="decimal"
        defaultValue={display}
        onBlur={(event) => {
          const raw = event.target.value.replace(/[^\d.,]/g, '').replace(',', '.');
          if (!raw) return onCentsChange(null);
          const parsed = Math.round(Number.parseFloat(raw) * 100);
          if (Number.isFinite(parsed)) {
            onCentsChange(parsed);
            event.target.value = (parsed / 100).toFixed(2);
          }
        }}
        aria-invalid={invalid || undefined}
        className="w-full bg-transparent px-3 text-right text-[14px] tabular-nums text-ink outline-none"
        placeholder="0.00"
        {...props}
      />
    </div>
  );
});
