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
            className={cn(
              'pointer-events-auto rounded-md border border-line bg-surface p-3 shadow-md',
              toneStyles[toast.tone],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-body font-semibold text-ink">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-body text-ink-muted">{toast.description}</p>
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
