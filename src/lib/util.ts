import { useEffect, useRef, useState } from 'react';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Course colour palette (accent hex per named colour). */
export const COURSE_HEX: Record<string, string> = {
  indigo: '#6366f1',
  blue: '#3b82f6',
  sky: '#0ea5e9',
  teal: '#14b8a6',
  emerald: '#10b981',
  lime: '#65a30d',
  amber: '#f59e0b',
  orange: '#f97316',
  rose: '#f43f5e',
  fuchsia: '#d946ef',
  violet: '#8b5cf6',
  slate: '#64748b',
};

export function courseVars(color: string | undefined): React.CSSProperties {
  return { ['--course' as string]: COURSE_HEX[color ?? 'indigo'] ?? COURSE_HEX.indigo };
}

/** True when keyboard focus is in a text field, so global shortcuts must stay quiet. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/** Whether a modal dialog is open (global shortcuts should pause). */
export function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* disposable preference only */
    }
  };
  return [v, set];
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export function useDocumentTitle(title: string, appName = 'Recall') {
  useEffect(() => {
    document.title = title ? `${title} · ${appName}` : appName;
  }, [title, appName]);
}
