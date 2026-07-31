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
  info: 'border-l-info',
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
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
      const id = crypto.randomUUID();
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
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto rounded-md border border-line border-l-4 bg-surface p-3 shadow-md',
              toneStyles[toast.tone],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-sm text-ink-muted">{toast.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="text-ink-muted hover:text-ink"
              >
                x
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
