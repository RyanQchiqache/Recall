import { AlertTriangle, Info, CheckCircle2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/util.ts';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-3 text-muted" role="status">
      <Spinner />
      <span>{label}…</span>
    </div>
  );
}

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'bad' | 'good' | 'verygood' | 'perfect';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-text-2 border-border',
  primary: 'bg-primary-soft text-primary-text border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  bad: 'bg-[color-mix(in_srgb,var(--rating-bad)_12%,transparent)] text-bad border-transparent',
  good: 'bg-[color-mix(in_srgb,var(--rating-good)_14%,transparent)] text-good border-transparent',
  verygood: 'bg-[color-mix(in_srgb,var(--rating-verygood)_12%,transparent)] text-verygood border-transparent',
  perfect: 'bg-[color-mix(in_srgb,var(--rating-perfect)_13%,transparent)] text-perfect border-transparent',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex min-w-[1.4rem] items-center justify-center rounded-md border border-border-strong border-b-2 bg-surface px-1.5 font-mono text-[11px] leading-5 text-text-2', className)}>
      {children}
    </kbd>
  );
}

export function Panel({ children, className, as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'aside' } & React.HTMLAttributes<HTMLElement>) {
  return (
    <As className={cn('rounded-2xl border border-border bg-surface shadow-card', className)} {...rest}>
      {children}
    </As>
  );
}

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-strong px-6 py-12 text-center', className)}>
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary-soft text-primary-text">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-muted">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, action, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const map = {
    info: { cls: 'bg-primary-soft text-primary-text', Icon: Info },
    warning: { cls: 'bg-warning-soft text-warning', Icon: AlertTriangle },
    danger: { cls: 'bg-danger-soft text-danger', Icon: XCircle },
    success: { cls: 'bg-success-soft text-success', Icon: CheckCircle2 },
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex flex-wrap items-start gap-3 rounded-xl px-4 py-3 text-sm', map.cls, className)}>
      <map.Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-52">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-text-2 [&_strong]:text-text">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <Alert
      tone="danger"
      title="Couldn’t load this"
      action={
        onRetry && (
          <button className="rounded-lg px-2 py-1 font-medium underline underline-offset-2" onClick={onRetry}>
            Try again
          </button>
        )
      }
    >
      {msg}
    </Alert>
  );
}

export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-soft', className)}>
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}
