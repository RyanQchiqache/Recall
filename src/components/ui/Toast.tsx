import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/util.ts';

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: ReactNode;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (message: ReactNode, action?: Toast['action']) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode, action?: Toast['action']) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: ReactNode, action?: Toast['action']) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, tone, message, action }]);
      setTimeout(() => remove(id), action ? 8000 : tone === 'error' ? 7000 : 4000);
    },
    [remove],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push('success', m, a),
      error: (m) => push('error', m),
      info: (m, a) => push('info', m, a),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 sm:right-5 sm:left-auto sm:items-end" aria-live="polite" role="region" aria-label="Notifications">
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'error' ? XCircle : Info;
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="anim-pop pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-pop">
              <Icon className={cn('mt-0.5 size-5 shrink-0', t.tone === 'success' ? 'text-success' : t.tone === 'error' ? 'text-danger' : 'text-primary-text')} aria-hidden />
              <div className="min-w-0 flex-1 text-sm">{t.message}</div>
              {t.action && (
                <button
                  className="shrink-0 rounded-md px-2 py-0.5 text-sm font-semibold text-primary-text hover:bg-primary-soft"
                  onClick={() => {
                    t.action!.onClick();
                    remove(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="shrink-0 rounded-md p-0.5 text-muted hover:text-text" aria-label="Dismiss" onClick={() => remove(t.id)}>
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
