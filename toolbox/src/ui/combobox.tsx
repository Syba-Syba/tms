import { useMemo, useRef, useState } from 'react';
import { useClickOutside } from '../hooks/use-click-outside';
import { cn } from '../lib/cn';

export interface ComboOption {
  label: string;
  value: string;
  meta?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Search...',
  emptyText = 'No matches.',
  className,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false));

  const selected = options.find((option) => option.value === value);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.meta ?? ''}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const pick = (option: ComboOption) => {
    onChange(option.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <input
        role="combobox"
        aria-expanded={open}
        value={open ? query : (selected?.label ?? '')}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') setActive((i) => Math.min(i + 1, matches.length - 1));
          if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
          if (event.key === 'Enter' && matches[active]) pick(matches[active]);
          if (event.key === 'Escape') setOpen(false);
        }}
        className="h-10 w-full rounded-md border border-line bg-surface px-3 text-body text-ink outline-none placeholder:text-ink-muted focus:ring-2 focus:ring-[var(--tb-ring)]"
      />
      {open ? (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-line bg-surface py-1 shadow-md">
          {matches.length === 0 ? (
            <li className="px-3 py-3 text-center text-body text-ink-muted">{emptyText}</li>
          ) : (
            matches.map((option, index) => (
              <li key={option.value}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(option)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-left text-body',
                    index === active ? 'bg-brand-50 text-brand-700' : 'text-ink',
                  )}
                >
                  {option.label}
                  {option.meta ? (
                    <span className="font-mono text-2xs text-ink-muted">{option.meta}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
