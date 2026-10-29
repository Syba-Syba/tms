import { useRef } from 'react';
import { cn } from '../lib/cn';

/** Six boxes, paste-aware. Pasting a full code fills every box in one go. */
export function OtpInput({
  length = 6,
  value,
  onChange,
  className,
}: {
  length?: number;
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const setDigit = (index: number, digit: string) => {
    const chars = value.padEnd(length, ' ').split('');
    chars[index] = digit;
    onChange(chars.join('').trimEnd());
    if (digit && index < length - 1) refs.current[index + 1]?.focus();
  };

  return (
    <div className={cn('flex gap-2', className)} role="group" aria-label="One time PIN">
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          inputMode="numeric"
          name={`otp-${index + 1}`}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={value[index] ?? ''}
          aria-label={`Digit ${index + 1}`}
          onChange={(event) => setDigit(index, event.target.value.replace(/\D/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !value[index] && index > 0) refs.current[index - 1]?.focus();
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
            if (pasted) onChange(pasted);
          }}
          className="h-12 w-10 rounded-md border border-line bg-surface text-center font-mono text-title text-ink outline-none focus:ring-2 focus:ring-[var(--tb-ring)]"
        />
      ))}
    </div>
  );
}
