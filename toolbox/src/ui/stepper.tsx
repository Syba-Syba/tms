import { cn } from '../lib/cn';

export interface Step {
  title: string;
  detail?: string;
  at?: string;
}

/** Timestamps sit in a mono gutter like a logbook, because a job history is a record, not a wizard. */
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: Step[];
  current: number;
  className?: string;
}) {
  return (
    <ol className={cn('relative', className)}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step.title} className="grid grid-cols-[52px_20px_1fr] gap-x-2 pb-5 last:pb-0">
            <span className="pt-0.5 text-right font-mono text-2xs text-ink-muted">
              {step.at ?? '--:--'}
            </span>
            <span className="relative flex justify-center">
              <span
                className={cn(
                  'z-10 mt-1 h-2.5 w-2.5 rounded-full border-2',
                  done && 'border-brand-500 bg-brand-500',
                  active && 'border-brand-500 bg-surface ring-4 ring-brand-100',
                  !done && !active && 'border-line bg-surface',
                )}
              />
              {index < steps.length - 1 ? (
                <span
                  className={cn(
                    'absolute top-3 h-full w-px',
                    done ? 'bg-brand-500' : 'border-l border-dashed border-line',
                  )}
                />
              ) : null}
            </span>
            <div>
              <p className={cn('text-body font-medium', active ? 'text-ink' : done ? 'text-ink' : 'text-ink-muted')}>
                {step.title}
              </p>
              {step.detail ? <p className="text-xs text-ink-muted">{step.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
