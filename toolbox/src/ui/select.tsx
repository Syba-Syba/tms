import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  placeholder?: string;
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, invalid, className, ...props },
  ref,
) {
  // A controlled select with no value shows its first option, while the form holds nothing:
  // "Employed" on screen, "Required" on submit. With nothing chosen, say so instead.
  const prompt =
    placeholder ?? (props.value === '' && !options.some((o) => o.value === '') ? 'Choose…' : undefined);
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-sm border border-line bg-surface px-3 text-body text-ink outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    >
      {prompt ? (
        <option value="" disabled>
          {prompt}
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
});
