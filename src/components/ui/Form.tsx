import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/util.ts';

export const fieldClass =
  'w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-soft placeholder:text-muted transition-colors duration-150 hover:border-border-strong focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15 disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-text-2">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldClass, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldClass, 'min-h-24 py-2.5 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className="relative min-w-0">
      <select ref={ref} className={cn(fieldClass, 'h-9 appearance-none pr-9', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
});

export function Checkbox({ label, description, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input id={rest.id ?? id} type="checkbox" className="mt-0.5 size-[18px] shrink-0 cursor-pointer rounded accent-[var(--primary)]" {...rest} />
      {label && (
        <label htmlFor={rest.id ?? id} className="cursor-pointer text-[15px] leading-snug">
          {label}
          {description && <span className="block text-[13px] text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[15px] font-medium">{label}</span>
        {description && <span className="block text-[13px] text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-3',
        )}
      >
        <span className={cn('inline-block size-[18px] rounded-full bg-white shadow transition-transform duration-150', checked ? 'translate-x-[22px]' : 'translate-x-[3px]')} />
      </button>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}

/** Accessible single-choice group rendered as cards or a compact segmented bar. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  name,
  layout = 'bar',
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  name?: string;
  layout?: 'bar' | 'cards';
  className?: string;
  ariaLabel: string;
}) {
  const auto = useId();
  const groupName = name ?? auto;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn(layout === 'bar' ? 'inline-flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1' : 'grid gap-2 sm:grid-cols-3', className)}>
      {options.map((o) => {
        const id = `${groupName}-${o.value}`;
        const active = o.value === value;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className={cn(
              'relative cursor-pointer transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]',
              layout === 'bar'
                ? cn('rounded-lg px-3 py-1.5 text-sm font-medium', active ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text')
                : cn('flex flex-col gap-1 rounded-xl border p-3.5', active ? 'border-primary bg-primary-soft' : 'border-border bg-surface hover:border-border-strong'),
            )}
          >
            <input id={id} type="radio" name={groupName} value={o.value} checked={active} onChange={() => onChange(o.value)} className="sr-only" />
            <span className={cn('flex items-center gap-2', layout === 'cards' && 'font-semibold')}>
              {o.icon}
              {o.label}
            </span>
            {o.description && <span className="text-[13px] leading-snug text-muted">{o.description}</span>}
          </label>
        );
      })}
    </div>
  );
}
