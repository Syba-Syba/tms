import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';
interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastApi {
  show: (toast: Omit<Toast, 'id'> & { tone?: Tone; duration?: number }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const toneStyles: Record<Tone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

let sequence = 0;

/**
 * crypto.randomUUID only exists in a secure context. A phone opening the app over plain HTTP
 * on a home network has none, so every toast there threw, and with it the navigation or
 * refetch that followed the call. The id only has to be unique on this page.
 */
const nextId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  sequence += 1;
  return `toast-${Date.now().toString(36)}-${sequence}`;
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback<ToastApi['show']>(
    ({ tone = 'info', duration = 5000, ...rest }) => {
      const id = nextId();
      setToasts((current) => [...current, { id, tone, ...rest }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-live="polite"
        // On a phone the app has a bottom tab bar (about 4.5rem), so toasts sit above it across the
        // width; from md up there is no bar and they sit in the corner.
        className="pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 md:inset-x-auto md:bottom-4 md:right-4 md:w-80"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto rounded-md border border-line bg-surface px-4 py-3 shadow-md"
          >
            <div className="flex items-start gap-3">
              {/* The dot carries the tone; the title carries the meaning in words. */}
              <span aria-hidden className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', toneStyles[toast.tone])} />
              <div className="min-w-0 flex-1">
                <p className="text-body font-bold text-ink">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-meta text-ink-muted">{toast.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="-mr-1.5 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lead text-ink-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]"
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider.');
  return context;
}
